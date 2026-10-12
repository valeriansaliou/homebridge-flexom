import type { PlatformAccessory, Logger, API, Service } from 'homebridge';
import { createChildLogger } from '../utils';
import { bindReadOnly } from './helpers';

/** Readings a device has; undefined when it does not measure that */
export type SensorValues = {
  /** °C */
  temperature?: number;
  /** % */
  humidity?: number;
  smoke?: boolean;
  /** 0-1 */
  battery?: number;
};

export type SensorServices = ReturnType<typeof createSensorServices>;

// Below this level, HomeKit shows a low battery warning
const LOW_BATTERY_LEVEL = 20; /* % */

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

// HomeKit ranges
const toTemperature = (celsius: number) =>
  Math.round(clamp(celsius, -270, 100) * 10) / 10;
const toHumidity = (percent: number) => Math.round(clamp(percent, 0, 100));
const toBatteryLevel = (ratio: number) => Math.round(clamp(ratio, 0, 1) * 100);

/**
 * Temperature, humidity, smoke and battery services of a sensor device,
 * created for the readings it has and removed for those it lost.
 */
export function createSensorServices({
  api,
  accessory,
  name,
  initialValues,
  initialFault = false,
  logger: parentLogger,
}: {
  api: API;
  accessory: PlatformAccessory;
  name: string;
  initialValues: SensorValues;
  /** Whether the device stopped reporting */
  initialFault?: boolean;
  logger: Logger;
}) {
  const { Characteristic, Service: Services } = api.hap;
  const logger = createChildLogger({ parentLogger, prefix: 'Sensor' });
  const values: SensorValues = { ...initialValues };
  let isFaulty = initialFault;

  const useService = (
    type: typeof Services.TemperatureSensor,
    used: boolean,
  ): Service | undefined => {
    const existing = accessory.getService(type);
    if (!used) {
      if (existing) accessory.removeService(existing);
      return undefined;
    }
    const service = existing ?? accessory.addService(type);
    service.setCharacteristic(Characteristic.Name, name);
    return service;
  };

  const temperatureService = useService(
    Services.TemperatureSensor,
    values.temperature !== undefined,
  );
  const humidityService = useService(
    Services.HumiditySensor,
    values.humidity !== undefined,
  );
  const smokeService = useService(
    Services.SmokeSensor,
    values.smoke !== undefined,
  );
  const batteryService = useService(
    Services.Battery,
    values.battery !== undefined,
  );
  const services = [
    temperatureService,
    humidityService,
    smokeService,
    batteryService,
  ].filter((service): service is Service => !!service);

  const bind = (
    service: Service | undefined,
    characteristic: Parameters<typeof bindReadOnly>[0]['characteristic'],
    initialValue: number,
    prefix: string,
  ) =>
    service &&
    bindReadOnly({
      hap: api.hap,
      service,
      characteristic,
      initialValue,
      // A device that stopped reporting shows "No response"
      isAvailable: () => !isFaulty,
      logger: createChildLogger({ parentLogger: logger, prefix }),
    });

  const temperature = bind(
    temperatureService,
    Characteristic.CurrentTemperature,
    toTemperature(values.temperature ?? 0),
    'temperature',
  );
  const humidity = bind(
    humidityService,
    Characteristic.CurrentRelativeHumidity,
    toHumidity(values.humidity ?? 0),
    'humidity',
  );
  const smoke = bind(
    smokeService,
    Characteristic.SmokeDetected,
    values.smoke
      ? Characteristic.SmokeDetected.SMOKE_DETECTED
      : Characteristic.SmokeDetected.SMOKE_NOT_DETECTED,
    'smoke',
  );
  const batteryLevel = bind(
    batteryService,
    Characteristic.BatteryLevel,
    toBatteryLevel(values.battery ?? 0),
    'battery',
  );
  batteryService?.updateCharacteristic(
    Characteristic.ChargingState,
    Characteristic.ChargingState.NOT_CHARGEABLE,
  );

  // The low battery warning is shown on each sensor as well as on the battery
  const updateLowBattery = () => {
    const { StatusLowBattery } = Characteristic;
    const isLow =
      values.battery !== undefined &&
      toBatteryLevel(values.battery) < LOW_BATTERY_LEVEL;
    for (const service of services) {
      if (values.battery === undefined) {
        if (service.testCharacteristic(StatusLowBattery)) {
          service.removeCharacteristic(
            service.getCharacteristic(StatusLowBattery),
          );
        }
      } else {
        service.updateCharacteristic(
          StatusLowBattery,
          isLow
            ? StatusLowBattery.BATTERY_LEVEL_LOW
            : StatusLowBattery.BATTERY_LEVEL_NORMAL,
        );
      }
    }
  };
  updateLowBattery();

  // A device that stopped reporting is faulty and inactive on every sensor
  // (the battery service has no such characteristics)
  const updateFault = () => {
    const { StatusActive, StatusFault } = Characteristic;
    for (const service of services) {
      if (service.UUID === Services.Battery.UUID) continue;
      service.updateCharacteristic(
        StatusFault,
        isFaulty ? StatusFault.GENERAL_FAULT : StatusFault.NO_FAULT,
      );
      service.updateCharacteristic(StatusActive, !isFaulty);
    }
  };
  updateFault();

  const setValues = (latest: SensorValues) => {
    if (latest.temperature !== undefined && temperature) {
      values.temperature = latest.temperature;
      temperature.setInternalValue(toTemperature(latest.temperature));
    }
    if (latest.humidity !== undefined && humidity) {
      values.humidity = latest.humidity;
      humidity.setInternalValue(toHumidity(latest.humidity));
    }
    if (latest.smoke !== undefined && smoke) {
      values.smoke = latest.smoke;
      smoke.setInternalValue(
        latest.smoke
          ? Characteristic.SmokeDetected.SMOKE_DETECTED
          : Characteristic.SmokeDetected.SMOKE_NOT_DETECTED,
      );
    }
    if (latest.battery !== undefined && batteryLevel) {
      values.battery = latest.battery;
      batteryLevel.setInternalValue(toBatteryLevel(latest.battery));
      updateLowBattery();
    }
  };

  const setFault = (faulty: boolean) => {
    if (faulty !== isFaulty) {
      logger.debug(faulty ? 'device is faulty' : 'device is back');
    }
    isFaulty = faulty;
    updateFault();
  };

  return {
    getValues: (): SensorValues => ({ ...values }),
    setValues,
    isFaulty: () => isFaulty,
    setFault,
  };
}
