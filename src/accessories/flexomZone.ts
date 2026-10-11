import type * as Flexom from '../flexom';
import type { PlatformAccessory, Logger, API } from 'homebridge';
import { createLightBulb, LightBulb } from '../services/lightBulb';
import {
  createWindowCovering,
  WindowCovering,
} from '../services/windowCovering';
import { createChildLogger, debounce, toLogJson } from '../utils';
import {
  getBlindPosition,
  getSlatsFor,
  toBlinds,
  ZONE_BLIND,
  type Blind,
} from './blinds';

// Delays before sending a command, so only the last value is sent. Lights
// only merge quick toggles. The Home app sends window covering positions
// whenever a slider drag pauses, before it is released: wait them out.
const LIGHT_COMMAND_DELAY = 300; /* ms */
const WINDOW_COMMAND_DELAY = 3000; /* ms */
// Refreshing right after a light command could revert HomeKit to the
// previous state (window coverings track their pending target instead)
const COMMAND_SETTLE_DELAY = 15_000; /* ms */

/** Flexom value (0-1, sometimes slightly off) to a HomeKit position (0-100) */
function toPosition(factorValue: number) {
  return Math.min(Math.max(Math.round(factorValue * 100), 0), 100);
}

export type FlexomZone = {
  /** Accessories exposing this zone's controls */
  accessories: PlatformAccessory[];
  /** Fetches the zone state from the API and fixes HomeKit if it drifted */
  refresh: () => Promise<void>;
};

export type GetAccessory = (params: {
  uuid: string;
  name: string;
}) => PlatformAccessory;

/** Accessory context, persisted by Homebridge in its accessory cache */
export type ZoneAccessoryContext = { zoneId?: string };

/** UUIDs a zone's accessories had before window coverings were per blind */
export function getZoneAccessoryUuids(api: API, zone: Flexom.Zone) {
  return {
    // Kept for lights when splitting accessories, to preserve their setup
    zone: api.hap.uuid.generate(zone.id),
    // Kept for zones with a single window covering
    window: api.hap.uuid.generate(`${zone.id}:window`),
  };
}

/** Whether a (possibly cached) accessory was created for this zone */
export function belongsToZone(
  api: API,
  accessory: PlatformAccessory,
  zone: Flexom.Zone,
) {
  const context = accessory.context as ZoneAccessoryContext;
  if (context.zoneId) return context.zoneId === zone.id;
  return Object.values(getZoneAccessoryUuids(api, zone)).includes(
    accessory.UUID,
  );
}

export async function createFlexomZone({
  api,
  getAccessory,
  separateAccessories,
  exclusions = {},
  flexom,
  zone,
  tolerance,
  logger: parentLogger,
}: {
  api: API;
  /** Returns the cached accessory with this UUID, or a new one */
  getAccessory: GetAccessory;
  /** One accessory for the light and one per window covering */
  separateAccessories: boolean;
  exclusions: Partial<{
    light: boolean;
    window: boolean;
  }>;
  flexom: Flexom.FlexomClient;
  zone: Flexom.Zone;
  logger: Logger;
  tolerance: number;
}): Promise<FlexomZone | undefined> {
  const logger = createChildLogger({ parentLogger, prefix: zone.name });

  let settings: Flexom.ZoneSettings = await flexom.getZoneSettings(zone);
  const isLightEnabled = !!settings.BRI && !exclusions.light;

  // The zone window covering value mixes positions and slat orientations:
  // use each blind's own actuators when Flexom lists them
  let blinds: Blind[] = [];
  let blindActuators: Flexom.Actuator[] = [];
  if (settings.BRIEXT && !exclusions.window) {
    blindActuators = await flexom.getFactorActuators({
      zoneId: zone.id,
      factor: 'BRIEXT',
    });
    blinds = toBlinds(blindActuators);
    if (blinds.length === 0) blinds = [ZONE_BLIND];
  }

  if (!isLightEnabled && blinds.length === 0) {
    return undefined;
  }

  // Accessories
  const uuids = getZoneAccessoryUuids(api, zone);
  const isSingleBlind = blinds.length === 1;
  const blindLabel = (index: number) =>
    isSingleBlind ? 'Shutter' : `Shutter ${index + 1}`;
  const used = new Map<string, PlatformAccessory>();
  // Grouped controls share one accessory: only get it once
  const useAccessory = (uuid: string, name: string) => {
    let accessory = used.get(uuid);
    if (!accessory) {
      accessory = getAccessory({ uuid, name });
      (accessory.context as ZoneAccessoryContext).zoneId = zone.id;
      used.set(uuid, accessory);
    }
    return accessory;
  };

  const lightName = separateAccessories ? `${zone.name} Light` : zone.name;
  const lightAccessory = isLightEnabled
    ? useAccessory(uuids.zone, lightName)
    : undefined;
  const blindSetups = blinds.map((blind, index) => {
    const name = `${zone.name} ${blindLabel(index)}`;
    if (!separateAccessories) {
      return {
        blind,
        name,
        accessory: useAccessory(uuids.zone, zone.name),
        // A single window covering keeps the service it always had
        subtype: isSingleBlind ? undefined : blind.itId,
      };
    }
    const uuid = isSingleBlind
      ? uuids.window
      : api.hap.uuid.generate(`${zone.id}:window:${blind.itId}`);
    return {
      blind,
      name,
      accessory: useAccessory(uuid, name),
      subtype: undefined,
    };
  });

  for (const accessory of used.values()) {
    accessory
      .getService(api.hap.Service.AccessoryInformation)
      ?.setCharacteristic(api.hap.Characteristic.Manufacturer, 'Flexom')
      .setCharacteristic(api.hap.Characteristic.Model, 'Zone')
      .setCharacteristic(api.hap.Characteristic.SerialNumber, zone.id);
    // Drop services left over from another configuration
    const lightService = accessory.getService(api.hap.Service.Lightbulb);
    if (lightService && accessory !== lightAccessory) {
      accessory.removeService(lightService);
    }
    const subtypes = new Set(
      blindSetups
        .filter((setup) => setup.accessory === accessory)
        .map(({ subtype }) => subtype),
    );
    accessory.services
      .filter(
        (service) =>
          service.UUID === api.hap.Service.WindowCovering.UUID &&
          !subtypes.has(service.subtype),
      )
      .forEach((service) => accessory.removeService(service));
  }

  // Lights
  const updateZoneBRI = debounce((value: number) => {
    logger.debug(`flexom request setZoneFactor BRI ${value}`);
    flexom
      .setZoneFactor({ id: zone.id, factor: 'BRI', value })
      .catch((err: unknown) => {
        logger.error(`Failed to set BRI to ${value}: ${toLogJson(err)}`);
      });
  }, LIGHT_COMMAND_DELAY);

  let lastLightCommandAt = 0;
  const isLightCommandSettling = () =>
    Date.now() - lastLightCommandAt < COMMAND_SETTLE_DELAY;

  let lightBulb: LightBulb | undefined;
  if (lightAccessory) {
    logger.info('Create light bulb');
    lightBulb = createLightBulb({
      api,
      logger,
      accessory: lightAccessory,
      name: lightName,
      initialState: (settings.BRI?.value ?? 0) > 0,
      setState: (isOn: boolean) => {
        lastLightCommandAt = Date.now();
        updateZoneBRI(isOn ? 1 : 0);
      },
    });
  }

  // Window coverings
  const sendBlindTarget = async (blind: Blind, target: number) => {
    const value = target / 100;
    if (!blind.itId || !blind.positionActuatorId) {
      logger.debug(`flexom request setZoneFactor BRIEXT ${value}`);
      await flexom.setZoneFactor({ id: zone.id, factor: 'BRIEXT', value });
      return;
    }
    logger.debug(
      `flexom request setActuatorState ${blind.positionActuatorId} ${value}`,
    );
    await flexom.setActuatorState({
      itId: blind.itId,
      actuatorId: blind.positionActuatorId,
      value,
    });
    if (blind.slatsActuatorId) {
      const slats = getSlatsFor(value);
      logger.debug(
        `flexom request setActuatorState ${blind.slatsActuatorId} ${slats}`,
      );
      await flexom.setActuatorState({
        itId: blind.itId,
        actuatorId: blind.slatsActuatorId,
        value: slats,
      });
    }
  };

  const getRemotePosition = (blind: Blind) => {
    const value =
      blind === ZONE_BLIND
        ? settings.BRIEXT?.value
        : getBlindPosition(blind, blindActuators);
    return value === undefined ? undefined : toPosition(value);
  };

  const windowCoverings = blindSetups.map(
    ({ blind, name, accessory, subtype }) => {
      logger.info(`Create window covering: ${name}`);
      const send = debounce((target: number) => {
        sendBlindTarget(blind, target).catch((err: unknown) => {
          logger.error(
            `Failed to move ${name} to ${target}%: ${toLogJson(err)}`,
          );
        });
      }, WINDOW_COMMAND_DELAY);
      const windowCovering: WindowCovering = createWindowCovering({
        api,
        logger,
        accessory,
        subtype,
        name,
        tolerance: tolerance * 100,
        initialPosition: getRemotePosition(blind) ?? 0,
        sendTarget: send,
      });
      const label = isSingleBlind
        ? 'window covering'
        : `window covering ${blindSetups.findIndex((s) => s.blind === blind) + 1}`;
      return { blind, label, windowCovering };
    },
  );

  // Reported state
  const onOff = (isOn: boolean) => (isOn ? 'on' : 'off');
  type Comparison = { comparison: string; corrected: boolean };

  const applyLight = (
    factorValue: number,
    { isRefresh = false } = {},
  ): Comparison | undefined => {
    if (!lightBulb) return undefined;
    const wasOn = lightBulb.lightOnService.getValue();
    const isOn = factorValue > 0;
    const comparison = `light local=${onOff(wasOn)} remote=${onOff(isOn)}`;
    if (isRefresh && isLightCommandSettling()) {
      return {
        comparison: `${comparison} (command pending)`,
        corrected: false,
      };
    }
    const corrected = isRefresh && wasOn !== isOn;
    if (corrected) {
      logger.info(
        `Light corrected from ${onOff(wasOn)} to ${onOff(isOn)} (missed event)`,
      );
    }
    lightBulb.lightOnService.setInternalValue(isOn);
    return { comparison, corrected };
  };

  const applyBlindPosition = (
    { label, windowCovering }: (typeof windowCoverings)[number],
    position: number,
    source: 'event' | 'refresh',
  ): Comparison => {
    const previous = windowCovering.getPosition();
    const wasMoving = windowCovering.isMoving();
    windowCovering.reportPosition(position, source);
    const current = windowCovering.getPosition();
    const comparison =
      `${label} local=${previous}% remote=${position}%` +
      (wasMoving ? ' (moving)' : '');
    const corrected =
      source === 'refresh' && !wasMoving && current !== previous;
    if (corrected) {
      const capitalized = label.charAt(0).toUpperCase() + label.slice(1);
      logger.info(
        `${capitalized} corrected from ${previous}% to ${current}% (missed event)`,
      );
    }
    return { comparison, corrected };
  };

  const refresh = async () => {
    logger.debug('Refreshing state from API');
    const needsSettings =
      !!lightBulb || windowCoverings.some(({ blind }) => blind === ZONE_BLIND);
    const needsActuators = windowCoverings.some(
      ({ blind }) => blind !== ZONE_BLIND,
    );
    const [latestSettings, latestActuators] = await Promise.all([
      needsSettings ? flexom.getZoneSettings(zone) : undefined,
      needsActuators
        ? flexom.getFactorActuators({ zoneId: zone.id, factor: 'BRIEXT' })
        : undefined,
    ]);
    if (latestSettings) settings = latestSettings;
    if (latestActuators) blindActuators = latestActuators;

    const results: Comparison[] = [];
    const lightValue = settings.BRI?.value;
    if (lightValue !== undefined) {
      const result = applyLight(lightValue, { isRefresh: true });
      if (result) results.push(result);
    }
    for (const windowCovering of windowCoverings) {
      const position = getRemotePosition(windowCovering.blind);
      if (position !== undefined) {
        results.push(applyBlindPosition(windowCovering, position, 'refresh'));
      }
    }
    if (results.length && !results.some(({ corrected }) => corrected)) {
      logger.debug(
        `State in sync with API: ${results.map(({ comparison }) => comparison).join(', ')}`,
      );
    }
  };

  const findWindowCovering = (event: Flexom.ActuatorHardwareStateEvent) =>
    windowCoverings.find(({ blind }) =>
      blind === ZONE_BLIND
        ? true
        : blind.positionActuatorId === event.value.actuatorId &&
          (!event.itId || blind.itId === event.itId),
    );

  await flexom.subscribe({
    id: `homebridge-flexom-${zone.id}`,
    events: ['ACTUATOR_HARDWARE_STATE'],
    zoneId: zone.id,
    listener: (event) => {
      if (event.type !== 'ACTUATOR_HARDWARE_STATE') return;
      if (event.factorId === 'BRI') {
        applyLight(event.value.value);
      } else if (event.factorId === 'BRIEXT') {
        // Slats events are ignored: HomeKit only shows the position
        const windowCovering = findWindowCovering(event);
        if (windowCovering) {
          applyBlindPosition(
            windowCovering,
            toPosition(event.value.value),
            'event',
          );
        }
      }
    },
    // Events may have been missed while the WebSocket was down
    onReconnect: () => {
      refresh().catch((err: unknown) => {
        logger.warn(
          `Failed to refresh state after reconnect: ${toLogJson(err)}`,
        );
      });
    },
  });

  return { accessories: [...used.values()], refresh };
}
