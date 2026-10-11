import type {
  API,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import { createFlexomZone } from './accessories/flexomZone';
import { markUnavailable } from './accessories/unavailable';
import * as Flexom from './flexom';
import { startPeriodicRefresh, type RefreshTask } from './refresh';
import { retryUntilSuccess } from './retry';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { toLogJson } from './utils';

export type FlexomPlatformConfig = PlatformConfig & {
  email: string;
  password: string;
  zones: boolean;
  tolerance: number;
  /** Minutes between state refreshes from the API, 0 to disable */
  refreshInterval?: number;
  excludeZones?: boolean;
  excludedZones?: {
    id: string;
    light: boolean;
    window: boolean;
  }[];
};

const DEFAULT_REFRESH_INTERVAL = 5; /* min */

export function createFlexomPlatform({
  logger,
  config,
  api,
}: {
  logger: Logger;
  config: FlexomPlatformConfig;
  api: API;
}) {
  const accessories = new Map<string, PlatformAccessory>();
  const shutdown = new AbortController();
  let flexom: Flexom.FlexomClient | undefined;
  let stopRefresh = () => {};

  const unregister = (accessory: PlatformAccessory) => {
    logger.info(
      `Unregister accessory: ${accessory.displayName} (UUID: ${accessory.UUID})`,
    );
    api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    accessories.delete(accessory.UUID);
  };

  const setupZone = async ({
    zone,
    client,
  }: {
    zone: Flexom.Zone;
    client: Flexom.FlexomClient;
  }) => {
    const uuid = api.hap.uuid.generate(zone.id);
    const existingAccessory = accessories.get(uuid);
    const accessory =
      existingAccessory ?? new api.platformAccessory(zone.name, uuid);

    const exclusion = config.excludeZones
      ? config.excludedZones?.find(({ id }) => id === zone.id)
      : undefined;
    const flexomZone = await createFlexomZone({
      api,
      accessory,
      logger,
      zone,
      flexom: client,
      tolerance: config.tolerance,
      exclusions: { light: exclusion?.light, window: exclusion?.window },
    });

    if (!flexomZone) {
      if (existingAccessory) unregister(existingAccessory);
      return undefined;
    }
    if (existingAccessory) {
      logger.info(`Update accessory: ${zone.name}`);
      api.updatePlatformAccessories([accessory]);
    } else {
      logger.info(`Register accessory: ${zone.name}`);
      api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      accessories.set(uuid, accessory);
    }
    return { name: zone.name, refresh: flexomZone.refresh };
  };

  const discoverZones = async (client: Flexom.FlexomClient) => {
    const retryOptions = { logger, signal: shutdown.signal };
    const zones = await retryUntilSuccess(() => client.getZones(), {
      ...retryOptions,
      description: 'list Flexom zones',
    });
    logger.info(`Found ${zones.length} zones`);

    const zoneUuids = new Set(
      zones.map((zone) => api.hap.uuid.generate(zone.id)),
    );
    [...accessories.values()]
      .filter((accessory) => !zoneUuids.has(accessory.UUID))
      .forEach(unregister);

    // Zones are retried independently, so one failing zone does not block others
    const results = await Promise.all(
      zones.map((zone) =>
        retryUntilSuccess(() => setupZone({ zone, client }), {
          ...retryOptions,
          description: `set up zone ${zone.name}`,
        }),
      ),
    );
    const tasks = results.filter((task): task is RefreshTask => !!task);
    logger.info(`Setup ${tasks.length} zones`);
    return tasks;
  };

  const init = async () => {
    if (!config.zones) {
      logger.warn('"Show Flexom Zones" is disabled in config, nothing to do');
      [...accessories.values()].forEach(unregister);
      return;
    }

    if (!config.email || !config.password) {
      logger.warn('Flexom email and password are required');
      return;
    }

    flexom = Flexom.createClient({
      email: config.email,
      password: config.password,
      logger,
    });
    const tasks = await discoverZones(flexom);

    const refreshInterval = config.refreshInterval ?? DEFAULT_REFRESH_INTERVAL;
    if (shutdown.signal.aborted) return;
    stopRefresh = startPeriodicRefresh({
      tasks,
      interval: refreshInterval * 60_000,
      logger,
    });
    if (refreshInterval > 0) {
      logger.info(`Refreshing zone states every ${refreshInterval} min`);
    }
  };

  logger.debug(`Finished initializing platform: ${config.name}`);

  api.on('didFinishLaunching', () => {
    init().catch((err: unknown) => {
      if (shutdown.signal.aborted) return;
      logger.error(`Flexom initialization error: ${toLogJson(err)}`);
    });
  });

  api.on('shutdown', () => {
    shutdown.abort();
    stopRefresh();
    void flexom?.disconnect();
  });

  return {
    configureAccessory: ({ accessory }: { accessory: PlatformAccessory }) => {
      logger.info(`Loading accessory from cache: ${accessory.displayName}`);
      markUnavailable({ api, accessory });
      accessories.set(accessory.UUID, accessory);
    },
  };
}
