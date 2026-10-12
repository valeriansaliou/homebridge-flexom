import type {
  API,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import {
  belongsToZone,
  createFlexomZone,
  loadZoneData,
  type ZoneAccessoryContext,
} from './accessories/flexomZone';
import { canRemoveAccessory, findMissingRoles } from './accessories/roles';
import { createZoneSensors } from './accessories/sensors';
import { markUnavailable } from './accessories/unavailable';
import * as Flexom from './flexom';
import { startPeriodicRefresh, type RefreshTask } from './refresh';
import { retryUntilSuccess } from './retry';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { formatDuration, toLogJson } from './utils';

export type FlexomPlatformConfig = PlatformConfig & {
  email: string;
  password: string;
  zones: boolean;
  /** Expose temperature, humidity and smoke sensors (default true) */
  sensors?: boolean;
  tolerance: number;
  /** One accessory for the light and one for the window covering */
  separateAccessories?: boolean;
  /** Seconds between state refreshes from the API, 0 to disable */
  refreshInterval?: number;
  excludeZones?: boolean;
  excludedZones?: {
    id: string;
    light: boolean;
    window: boolean;
    sensors?: boolean;
  }[];
};

const DEFAULT_REFRESH_INTERVAL = 15 * 60; /* s */
const DEFAULT_TOLERANCE = 0.05;
// Setup attempts (about 10 min with the retry backoff) before accepting that
// Flexom no longer reports something HomeKit knows about
const MAX_INCOMPLETE_ATTEMPTS = 6;

function getTolerance(tolerance: unknown) {
  return typeof tolerance === 'number' && tolerance >= 0 && tolerance <= 1
    ? tolerance
    : DEFAULT_TOLERANCE;
}

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

  const getRoles = (accessory: PlatformAccessory) =>
    (accessory.context as ZoneAccessoryContext).roles;

  const setupZone = async ({
    zone,
    client,
    attempt,
  }: {
    zone: Flexom.Zone;
    client: Flexom.FlexomClient;
    attempt: number;
  }) => {
    const exclusion = config.excludeZones
      ? config.excludedZones?.find(({ id }) => id === zone.id)
      : undefined;
    const exclusions = {
      light: exclusion?.light,
      window: exclusion?.window,
      sensors: config.sensors === false || exclusion?.sensors,
    };
    const data = await loadZoneData({ flexom: client, zone, exclusions });

    // Flexom sometimes answers with partial data: wait for it to report
    // everything HomeKit knows about, before changing any accessory
    const zoneAccessories = [...accessories.values()].filter((accessory) =>
      belongsToZone(api, accessory, zone),
    );
    const missingRoles = findMissingRoles({
      knownRoles: zoneAccessories.flatMap((a) => getRoles(a) ?? []),
      reportedRoles: data.roles,
      exclusions,
    });
    if (missingRoles.length && attempt < MAX_INCOMPLETE_ATTEMPTS) {
      const missingAccessories = zoneAccessories.filter((accessory) =>
        getRoles(accessory)?.some((role) => missingRoles.includes(role)),
      );
      throw new Error(
        `Flexom did not report ${missingAccessories.map((a) => a.displayName).join(', ')}`,
      );
    }

    const getAccessory = ({
      uuid,
      name,
      category,
    }: {
      uuid: string;
      name: string;
      category?: number;
    }) =>
      accessories.get(uuid) ?? new api.platformAccessory(name, uuid, category);
    const flexomZone = await createFlexomZone({
      api,
      getAccessory,
      separateAccessories: config.separateAccessories ?? true,
      logger,
      zone,
      flexom: client,
      tolerance: getTolerance(config.tolerance),
      data,
    });
    const zoneSensors = await createZoneSensors({
      api,
      getAccessory,
      logger,
      zone,
      flexom: client,
      devices: data.sensorDevices,
    });

    const used = new Set([
      ...(flexomZone?.accessories ?? []),
      ...(zoneSensors?.accessories ?? []),
    ]);
    for (const accessory of zoneAccessories.filter((a) => !used.has(a))) {
      if (
        canRemoveAccessory({
          roles: getRoles(accessory),
          reportedRoles: data.roles,
          exclusions,
        })
      ) {
        unregister(accessory);
      } else {
        logger.warn(
          `${accessory.displayName} is no longer reported by Flexom: kept in ` +
            'HomeKit, showing "No response". If the device was removed, ' +
            'remove this accessory from the Homebridge UI (Settings > ' +
            'Remove Single Cached Accessory).',
        );
      }
    }

    for (const accessory of used) {
      if (accessories.has(accessory.UUID)) {
        logger.info(`Update accessory: ${accessory.displayName}`);
        api.updatePlatformAccessories([accessory]);
      } else {
        logger.info(`Register accessory: ${accessory.displayName}`);
        api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          accessory,
        ]);
        accessories.set(accessory.UUID, accessory);
      }
    }
    const refreshes = [flexomZone?.refresh, zoneSensors?.refresh].filter(
      (refresh): refresh is () => Promise<void> => !!refresh,
    );
    if (refreshes.length === 0) return undefined;
    return {
      name: zone.name,
      refresh: async () => {
        await Promise.all(refreshes.map((refresh) => refresh()));
      },
    };
  };

  const discoverZones = async (client: Flexom.FlexomClient) => {
    const retryOptions = { logger, signal: shutdown.signal };
    let attempt = 0;
    const zones = await retryUntilSuccess(
      async () => {
        const result = await client.getZones();
        attempt += 1;
        if (
          result.length === 0 &&
          accessories.size > 0 &&
          attempt < MAX_INCOMPLETE_ATTEMPTS
        ) {
          throw new Error('Flexom reported no zones');
        }
        return result;
      },
      {
        ...retryOptions,
        description: 'list Flexom zones',
      },
    );
    logger.info(`Found ${zones.length} zones`);

    // Accessories of zones Flexom no longer reports are kept: removing them
    // would lose their rooms, scenes and automations on a mere API glitch
    [...accessories.values()]
      .filter(
        (accessory) =>
          !zones.some((zone) => belongsToZone(api, accessory, zone)),
      )
      .forEach((accessory) => {
        logger.warn(
          `${accessory.displayName} belongs to a zone no longer reported by ` +
            'Flexom: kept in HomeKit, showing "No response". If the zone was ' +
            'removed, remove this accessory from the Homebridge UI (Settings ' +
            '> Remove Single Cached Accessory).',
        );
      });

    // Zones are retried independently, so one failing zone does not block others
    const results = await Promise.all(
      zones.map((zone) => {
        let zoneAttempt = 0;
        return retryUntilSuccess(
          () => setupZone({ zone, client, attempt: (zoneAttempt += 1) }),
          { ...retryOptions, description: `set up zone ${zone.name}` },
        );
      }),
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
      interval: refreshInterval * 1000,
      logger,
    });
    if (refreshInterval > 0) {
      logger.info(
        `Refreshing zone states every ${formatDuration(refreshInterval * 1000)}`,
      );
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
