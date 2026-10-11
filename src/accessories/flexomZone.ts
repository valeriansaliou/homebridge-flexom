import _ from 'lodash';
import type * as Flexom from '../flexom';
import type { PlatformAccessory, Logger, API } from 'homebridge';
import { createLightBulb, LightBulb } from '../services/lightBulb';
import {
  createWindowCovering,
  WindowCovering,
} from '../services/windowCovering';
import { createChildLogger, toLogJson } from '../utils';

const DEBOUNCE_DELAY = 1000; /* ms */
// Refreshing right after a command could revert HomeKit to the previous state
const COMMAND_SETTLE_DELAY = 15_000; /* ms */

/** Flexom factor (0-1, sometimes slightly off) to a HomeKit position (0-100) */
function toPosition(factorValue: number) {
  return _.clamp(Math.round(factorValue * 100), 0, 100);
}

export type FlexomZone = {
  /** Fetches the zone state from the API and fixes HomeKit if it drifted */
  refresh: () => Promise<void>;
};

export async function createFlexomZone({
  api,
  accessory,
  exclusions = {},
  flexom,
  zone,
  tolerance,
  logger: parentLogger,
}: {
  api: API;
  accessory: PlatformAccessory;
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

  accessory
    .getService(api.hap.Service.AccessoryInformation)
    ?.setCharacteristic(api.hap.Characteristic.Manufacturer, 'Flexom');

  accessory
    .getService(api.hap.Service.AccessoryInformation)
    ?.setCharacteristic(api.hap.Characteristic.Model, 'Zone')
    .setCharacteristic(api.hap.Characteristic.SerialNumber, zone.id);

  let settings: Flexom.ZoneSettings = await flexom.getZoneSettings(zone);

  const createZoneFactorUpdater = (factor: Flexom.Factor) =>
    _.debounce(async (value: number) => {
      logger.debug(`flexom request setZoneFactor ${factor} ${value}`);
      try {
        await flexom.setZoneFactor({ id: zone.id, factor, value });
      } catch (err: unknown) {
        logger.error(`Failed to set ${factor} to ${value}: ${toLogJson(err)}`);
      }
    }, DEBOUNCE_DELAY);
  const updateZoneBRI = createZoneFactorUpdater('BRI');
  const updateZoneBRIEXT = createZoneFactorUpdater('BRIEXT');

  const isLightEnabled = settings.BRI && !exclusions.light;
  const isWindowEnabled = settings.BRIEXT && !exclusions.window;

  if (!isLightEnabled && !isWindowEnabled) {
    return undefined;
  }

  let lastCommandAt = 0;
  const isCommandSettling = () =>
    Date.now() - lastCommandAt < COMMAND_SETTLE_DELAY;

  let lightBulb: LightBulb;
  if (isLightEnabled) {
    logger.info('Create light bulb');
    lightBulb = createLightBulb({
      api,
      logger,
      accessory,
      name: zone.name,
      initialState: (settings.BRI?.value ?? 0) > 0,
      setState: async (isOn: boolean) => {
        lastCommandAt = Date.now();
        await updateZoneBRI(isOn ? 1 : 0);
      },
    });
  } else {
    const service = accessory.getService(api.hap.Service.Lightbulb);
    if (service) {
      accessory.removeService(service);
    }
  }

  let windowCovering: WindowCovering;
  if (isWindowEnabled) {
    logger.info('Create window covering');
    windowCovering = createWindowCovering({
      api,
      logger,
      accessory,
      name: zone.name,
      tolerance: tolerance * 100,
      initialPosition: toPosition(settings.BRIEXT?.value ?? 0),
      setState: async (value: number) => {
        lastCommandAt = Date.now();
        await updateZoneBRIEXT(value / 100);
      },
    });
  } else {
    const service = accessory.getService(api.hap.Service.WindowCovering);
    if (service) {
      accessory.removeService(service);
    }
  }

  const { STOPPED } = api.hap.Characteristic.PositionState;
  const applyFactor = (
    factor: Flexom.Factor,
    factorValue: number,
    { isRefresh = false } = {},
  ) => {
    switch (factor) {
      case 'BRI': {
        if (!lightBulb) return;
        const wasOn = lightBulb.lightOnService.getValue();
        const isOn = factorValue > 0;
        if (isRefresh && wasOn !== isOn) {
          logger.info(
            `Light corrected from ${wasOn ? 'on' : 'off'} to ${isOn ? 'on' : 'off'} (missed event)`,
          );
        }
        lightBulb.lightOnService.setInternalValue(isOn);
        break;
      }
      case 'BRIEXT': {
        if (!windowCovering) return;
        const positionState = windowCovering.positionStateService.getValue();
        const previous = windowCovering.currentPositionService.getValue();
        const value = toPosition(factorValue);
        if (isRefresh && Math.abs(previous - value) > tolerance * 100) {
          logger.info(
            `Window covering corrected from ${previous}% to ${value}% (missed event)`,
          );
        }
        windowCovering.currentPositionService.setInternalValue(value);
        if (positionState === STOPPED) {
          windowCovering.targetPositionService.setInternalValue(value);
        }
        break;
      }
      default:
    }
  };

  const refresh = async () => {
    if (isCommandSettling()) {
      logger.debug('Skipping refresh: command in progress');
      return;
    }
    logger.debug('Refreshing state from API');
    const latestSettings = await flexom.getZoneSettings(zone);
    // A command may have been sent while the request was in flight
    if (isCommandSettling()) return;
    settings = latestSettings;
    for (const factor of ['BRI', 'BRIEXT'] as const) {
      const factorSettings = settings[factor];
      if (factorSettings) {
        applyFactor(factor, factorSettings.value, { isRefresh: true });
      }
    }
  };

  await flexom.subscribe({
    id: `homebridge-flexom-${zone.id}`,
    events: ['ACTUATOR_HARDWARE_STATE'],
    zoneId: zone.id,
    listener: (data) => {
      if (data.type !== 'ACTUATOR_HARDWARE_STATE') return;
      applyFactor(data.factorId, data.value.value);
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

  return { refresh };
}
