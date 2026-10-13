import type { PlatformAccessory, Logger, API } from 'homebridge';
import type * as Flexom from '../flexom';
import {
  createSensorServices,
  type SensorServices,
  type SensorValues,
} from '../services/sensor';
import { createChildLogger, toLogJson } from '../utils';
import type { GetAccessory, ZoneAccessoryContext } from './flexomZone';
import { getSensorRole } from './roles';

/** What a reading is, with the sensor channel it comes from */
export type SensorReading = { sensorId: string; value: number };

/**
 * A device with environment sensors, e.g. a smoke detector that also
 * measures temperature and humidity. Readings it does not have are left out.
 */
export type SensorDevice = {
  itId: string;
  /** Health tracked by Flexom, e.g. KO when the device stopped reporting */
  state?: Flexom.ThingState;
  /** °C */
  temperature?: SensorReading;
  /** % */
  humidity?: SensorReading;
  /** 0 clear, 1 smoke detected */
  smoke?: SensorReading;
  /** 0-1 */
  battery?: SensorReading;
};

type ReadingKey = keyof Omit<SensorDevice, 'itId' | 'state'>;

const FACTOR_READINGS: Partial<Record<Flexom.SensorFactor, ReadingKey>> = {
  TMP: 'temperature',
  HUM: 'humidity',
  SMOKE: 'smoke',
  BATTERY_LEVEL: 'battery',
};

/** Device states meaning Flexom lost contact with the device */
const FAULTY_STATES: Flexom.ThingState[] = ['KO', 'UNREACHABLE', 'MUTE'];

export function isFaultyState(state: Flexom.ThingState | undefined) {
  return state !== undefined && FAULTY_STATES.includes(state);
}

/** Flexom reports readings as strings ("23.0", "0"), sometimes as numbers */
export function parseReading(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * Groups a zone's sensors by device, keeping those HomeKit can show. A
 * device with only a battery level is left out. Sorted by device id, so
 * devices keep their number across restarts.
 */
export function toSensorDevices(sensors: Flexom.Sensor[]): SensorDevice[] {
  const devices = new Map<string, SensorDevice>();
  for (const sensor of sensors) {
    if (sensor.activated === false || !sensor.state) continue;
    const key = FACTOR_READINGS[sensor.state.id];
    const value = parseReading(sensor.state.value);
    if (!key || value === undefined) continue;
    const device = devices.get(sensor.itId) ?? { itId: sensor.itId };
    device[key] = { sensorId: sensor.id, value };
    devices.set(sensor.itId, device);
  }
  return [...devices.values()]
    .filter(
      ({ temperature, humidity, smoke }) => temperature || humidity || smoke,
    )
    .sort((a, b) => a.itId.localeCompare(b.itId));
}

/** Adds the health Flexom tracks for each device (one request per device) */
export async function loadDeviceStates({
  flexom,
  devices,
}: {
  flexom: Flexom.FlexomClient;
  devices: SensorDevice[];
}): Promise<SensorDevice[]> {
  return Promise.all(
    devices.map(async (device) => {
      const { state } = await flexom.getThing({ itId: device.itId });
      return { ...device, state: state ?? undefined };
    }),
  );
}

function toValues(device: SensorDevice): SensorValues {
  return {
    temperature: device.temperature?.value,
    humidity: device.humidity?.value,
    smoke: device.smoke ? device.smoke.value > 0 : undefined,
    battery: device.battery?.value,
  };
}

export type ZoneSensors = {
  accessories: PlatformAccessory[];
  /** Fetches the readings from the API and fixes HomeKit if it drifted */
  refresh: () => Promise<void>;
};

export function getSensorAccessoryUuid(
  api: API,
  zone: Flexom.Zone,
  device: Pick<SensorDevice, 'itId'>,
) {
  return api.hap.uuid.generate(`${zone.id}:sensor:${device.itId}`);
}

/**
 * One HomeKit accessory per sensor device of a zone, with a temperature,
 * humidity and/or smoke sensor, and its battery level when it has one.
 * A device Flexom lost contact with is shown as faulty ("No response").
 */
export async function createZoneSensors({
  api,
  getAccessory,
  devices,
  flexom,
  zone,
  liveUpdates = true,
  logger: parentLogger,
}: {
  api: API;
  getAccessory: GetAccessory;
  /** From loadZoneData */
  devices: SensorDevice[];
  flexom: Flexom.FlexomClient;
  zone: Flexom.Zone;
  logger: Logger;
  /** Whether WebSocket events report changes, or only refreshes do */
  liveUpdates?: boolean;
}): Promise<ZoneSensors | undefined> {
  if (devices.length === 0) return undefined;
  const logger = createChildLogger({ parentLogger, prefix: zone.name });

  const label = (device: SensorDevice) =>
    device.smoke ? 'Smoke Detector' : 'Sensor';
  const count = (device: SensorDevice) =>
    devices.filter((other) => label(other) === label(device)).length;

  const setups = devices.map((device) => {
    const index = devices
      .filter((other) => label(other) === label(device))
      .indexOf(device);
    const name =
      count(device) > 1
        ? `${zone.name} ${label(device)} ${index + 1}`
        : `${zone.name} ${label(device)}`;
    const accessory = getAccessory({
      uuid: getSensorAccessoryUuid(api, zone, device),
      name,
      category: api.hap.Categories.SENSOR,
    });
    const context = accessory.context as ZoneAccessoryContext;
    context.zoneId = zone.id;
    context.roles = [getSensorRole(device)];
    accessory
      .getService(api.hap.Service.AccessoryInformation)
      ?.setCharacteristic(api.hap.Characteristic.Manufacturer, 'Flexom')
      .setCharacteristic(api.hap.Characteristic.Model, 'Sensor')
      .setCharacteristic(api.hap.Characteristic.SerialNumber, device.itId);

    logger.info(`Create sensors: ${name}`);
    if (isFaultyState(device.state)) {
      logger.warn(
        `${name} is not reporting to Flexom (state ${device.state}): shown as faulty`,
      );
    }
    const services: SensorServices = createSensorServices({
      api,
      logger,
      accessory,
      name,
      initialValues: toValues(device),
      initialFault: isFaultyState(device.state),
    });
    return { device, name, accessory, services };
  });

  type Setup = (typeof setups)[number];

  const applyState = (setup: Setup, state: Flexom.ThingState | undefined) => {
    const faulty = isFaultyState(state);
    const wasFaulty = setup.services.isFaulty();
    setup.device = { ...setup.device, state };
    setup.services.setFault(faulty);
    if (faulty && !wasFaulty) {
      logger.warn(
        `${setup.name} stopped reporting to Flexom (state ${state}): shown as faulty`,
      );
    } else if (!faulty && wasFaulty) {
      logger.info(`${setup.name} is reporting to Flexom again`);
    }
  };

  const applyDevice = (
    setup: Setup,
    latest: SensorDevice,
    { isRefresh = false } = {},
  ) => {
    const before = setup.services.getValues();
    setup.services.setValues(toValues(latest));
    // Later events build on these readings
    setup.device = { ...latest, state: setup.device.state };
    if (!isRefresh) return;
    const after = setup.services.getValues();
    const corrected = (Object.keys(after) as (keyof SensorValues)[]).filter(
      (key) => before[key] !== after[key],
    );
    if (corrected.length) {
      const changes = corrected
        .map((key) => `${key} ${String(before[key])} -> ${String(after[key])}`)
        .join(', ');
      // Without live updates, refreshes are how changes get reported
      if (liveUpdates) {
        logger.info(`${setup.name} corrected: ${changes} (missed event)`);
      } else {
        logger.debug(
          `${setup.name} changed: ${changes} (state synchronization)`,
        );
      }
    }
  };

  const refresh = async () => {
    logger.debug('Refreshing sensors from API');
    const latest = await loadDeviceStates({
      flexom,
      devices: toSensorDevices(await flexom.getSensors({ zoneId: zone.id })),
    });
    for (const setup of setups) {
      const device = latest.find(({ itId }) => itId === setup.device.itId);
      if (!device) continue;
      applyDevice(setup, device, { isRefresh: true });
      applyState(setup, device.state);
    }
  };

  const refreshState = async (setup: Setup) => {
    const { state } = await flexom.getThing({ itId: setup.device.itId });
    applyState(setup, state ?? undefined);
  };

  const applyEvent = (event: Flexom.SensorStateEvent) => {
    const setup = setups.find(({ device }) => device.itId === event.itId);
    const key = event.factorId && FACTOR_READINGS[event.factorId];
    const value = parseReading(event.value);
    if (!setup || !key || value === undefined) return;
    const latest = { ...setup.device, [key]: { sensorId: '', value } };
    if (key === 'smoke' && value > 0 && !setup.services.getValues().smoke) {
      logger.warn(`Smoke detected by ${setup.name}`);
    }
    applyDevice(setup, latest);
    // A reading proves the device is alive, whatever Flexom last said
    if (setup.services.isFaulty()) applyState(setup, 'OK');
  };

  await flexom.subscribe({
    id: `homebridge-flexom-sensors-${zone.id}`,
    events: ['SENSOR_STATE', 'IT_STATE'],
    zoneId: zone.id,
    listener: (event) => {
      if (event.type === 'SENSOR_STATE') {
        applyEvent(event);
      } else if (event.type === 'IT_STATE') {
        // Device health changed: ask Flexom, as the event shape is unknown
        const setup = setups.find(({ device }) => device.itId === event.itId);
        if (!setup) return;
        refreshState(setup).catch((err: unknown) => {
          logger.debug(
            `Failed to read the state of ${setup.name}: ${toLogJson(err)}`,
          );
        });
      }
    },
    onReconnect: () => {
      refresh().catch((err: unknown) => {
        logger.warn(
          `Failed to refresh sensors after reconnect: ${toLogJson(err)}`,
        );
      });
    },
  });

  return { accessories: setups.map(({ accessory }) => accessory), refresh };
}
