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
}) {
  const logger = createChildLogger({ parentLogger, prefix: zone.name });

  accessory
    .getService(api.hap.Service.AccessoryInformation)
    ?.setCharacteristic(api.hap.Characteristic.Manufacturer, 'Flexom');

  accessory
    .getService(api.hap.Service.AccessoryInformation)
    ?.setCharacteristic(api.hap.Characteristic.Model, 'Zone')
    .setCharacteristic(api.hap.Characteristic.SerialNumber, zone.id);

  let settings: Flexom.ZoneSettings = await flexom.getZoneSettings(zone);

  const refreshZone = _.debounce(async () => {
    logger.debug('flexom request getZone');
    settings = await flexom.getZoneSettings(zone);
  }, DEBOUNCE_DELAY);

  const updateZoneBRI = _.debounce(async (value: number) => {
    logger.debug(`flexom request setZoneFactor BRI ${value}`);
    return flexom.setZoneFactor({
      id: zone.id,
      factor: 'BRI',
      value,
    });
  }, DEBOUNCE_DELAY);

  const updateZoneBRIEXT = _.debounce(async (value: number) => {
    logger.debug(`flexom request setZoneFactor BRIEXT ${value}`);
    return flexom.setZoneFactor({
      id: zone.id,
      factor: 'BRIEXT',
      value,
    });
  }, DEBOUNCE_DELAY);

  const isLightEnabled = settings.BRI && !exclusions.light;
  const isWindowEnabled = settings.BRIEXT && !exclusions.window;

  if (!isLightEnabled && !isWindowEnabled) {
    return false;
  }

  let lightBulb: LightBulb;
  if (isLightEnabled) {
    logger.info('Create light bulb');
    lightBulb = await createLightBulb({
      api,
      logger,
      accessory,
      name: zone.name,
      getState: async () => {
        await refreshZone();
        return (settings.BRI?.value ?? 0) > 0;
      },
      setState: async (isOn: boolean) => updateZoneBRI(isOn ? 1 : 0),
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
    windowCovering = await createWindowCovering({
      api,
      logger,
      accessory,
      name: zone.name,
      tolerance: tolerance * 100,
      getState: async () => {
        await refreshZone();
        return (settings.BRIEXT?.value ?? 0) * 100;
      },
      setState: async (value: number) => updateZoneBRIEXT(value / 100),
    });
  } else {
    const service = accessory.getService(api.hap.Service.WindowCovering);
    if (service) {
      accessory.removeService(service);
    }
  }

  const { STOPPED } = api.hap.Characteristic.PositionState;
  const applyFactor = (factor: Flexom.Factor, factorValue: number) => {
    switch (factor) {
      case 'BRI': {
        if (!lightBulb) return;
        lightBulb.lightOnService.setInternalValue(factorValue > 0);
        break;
      }
      case 'BRIEXT': {
        if (!windowCovering) return;
        const positionState = windowCovering.positionStateService.getValue();
        const value = factorValue * 100;
        windowCovering.currentPositionService.setInternalValue(value);
        if (positionState === STOPPED) {
          windowCovering.targetPositionService.setInternalValue(value);
        }
        break;
      }
      default:
    }
  };

  // Events may have been missed while the WebSocket was down
  const resync = async () => {
    settings = await flexom.getZoneSettings(zone);
    for (const factor of ['BRI', 'BRIEXT'] as const) {
      const factorSettings = settings[factor];
      if (factorSettings) applyFactor(factor, factorSettings.value);
    }
  };

  await flexom.subscribe({
    id: `homebridge-flexom-${zone.id}`,
    events: ['ACTUATOR_HARDWARE_STATE'],
    zoneId: zone.id,
    listener: (data) => {
      if (data.type !== 'ACTUATOR_HARDWARE_STATE') return;
      logger.info(`Received event: ${toLogJson(data)}`);
      applyFactor(data.factorId, data.value.value);
    },
    onReconnect: () => {
      resync().catch((err: unknown) => {
        logger.warn(
          `Failed to refresh state after reconnect: ${toLogJson(err)}`,
        );
      });
    },
  });

  return true;
}
