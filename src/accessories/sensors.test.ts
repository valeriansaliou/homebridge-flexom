import { describe, expect, it, vi } from 'vitest';
import type { PlatformAccessory } from 'homebridge';
import type { FlexomClient, Sensor } from '../flexom';
import type { EventListener } from '../flexom/types';
import {
  createTestAccessory,
  createTestApi,
  createTestLogger,
  hap,
} from '../test/homebridge';
import {
  createZoneSensors,
  getSensorAccessoryUuid,
  loadDeviceStates,
  parseReading,
  toSensorDevices,
} from './sensors';
import type { ZoneAccessoryContext } from './flexomZone';

const zone = { id: 'zone-1', name: 'Corridor' };
const DETECTOR = '0410A5CA995880';

/** Like a Nexelec smoke detector: readings are strings, in one batch */
function detectorSensors({
  temperature = '23.0',
  humidity = '58.0',
  smoke = '0',
  battery = '1.0',
}: Partial<
  Record<'temperature' | 'humidity' | 'smoke' | 'battery', string>
> = {}): Sensor[] {
  return [
    {
      id: '81000e9d#6_C6',
      itId: DETECTOR,
      state: { id: 'HYGROTHERMAL_COMFORT_INDEX_NEXELEC', value: 'GOOD' },
      activated: true,
    },
    {
      id: '81000e9d#5_C5',
      itId: DETECTOR,
      state: { id: 'HUM', value: humidity },
      activated: true,
    },
    {
      id: '81000e9d#2_C2',
      itId: DETECTOR,
      state: { id: 'BATTERY_LEVEL', value: battery },
      activated: true,
    },
    {
      id: '81000e9d#0_C0',
      itId: DETECTOR,
      state: { id: 'SMOKE', value: smoke },
      activated: true,
    },
    {
      id: '81000e9d#4_C4',
      itId: DETECTOR,
      state: { id: 'TMP', value: temperature },
      activated: true,
    },
    // A wall switch of the same zone
    {
      id: '00374244#0_C0',
      itId: '04293A9AAD5981',
      state: { id: 'SWS', value: '2' },
      activated: true,
    },
  ];
}

describe('parseReading', () => {
  it('reads numbers and numeric strings', () => {
    expect(parseReading('23.0')).toBe(23);
    expect(parseReading(23.2)).toBe(23.2);
    expect(parseReading('0')).toBe(0);
  });

  it('ignores missing or non-numeric values', () => {
    expect(parseReading(null)).toBeUndefined();
    expect(parseReading(undefined)).toBeUndefined();
    expect(parseReading('')).toBeUndefined();
    expect(parseReading('GOOD')).toBeUndefined();
  });
});

describe('toSensorDevices', () => {
  it('groups the supported readings of each device', () => {
    expect(toSensorDevices(detectorSensors())).toEqual([
      {
        itId: DETECTOR,
        temperature: { sensorId: '81000e9d#4_C4', value: 23 },
        humidity: { sensorId: '81000e9d#5_C5', value: 58 },
        smoke: { sensorId: '81000e9d#0_C0', value: 0 },
        battery: { sensorId: '81000e9d#2_C2', value: 1 },
      },
    ]);
  });

  it('leaves out devices without environment readings', () => {
    expect(
      toSensorDevices([
        { id: 'a#0', itId: 'meter', state: { id: 'CPOW', value: null } },
        {
          id: 'b#0',
          itId: 'remote',
          state: { id: 'BATTERY_LEVEL', value: '0.5' },
        },
      ]),
    ).toEqual([]);
  });

  it('leaves out deactivated sensors', () => {
    expect(
      toSensorDevices([
        {
          id: 'a#0',
          itId: 'probe',
          state: { id: 'TMP', value: '20' },
          activated: false,
        },
      ]),
    ).toEqual([]);
  });

  it('sorts devices by id', () => {
    const devices = toSensorDevices([
      { id: 'b#0', itId: 'probe-b', state: { id: 'TMP', value: '20' } },
      { id: 'a#0', itId: 'probe-a', state: { id: 'HUM', value: '40' } },
    ]);
    expect(devices.map(({ itId }) => itId)).toEqual(['probe-a', 'probe-b']);
  });
});

function createFakeFlexom(initialSensors: Sensor[], initialState = 'OK') {
  let sensors = initialSensors;
  let state = initialState;
  const listeners: EventListener[] = [];
  const client = {
    getSensors: vi.fn(() => Promise.resolve(sensors)),
    getThing: vi.fn(({ itId }: { itId: string }) =>
      Promise.resolve({ id: itId, state }),
    ),
    subscribe: vi.fn((listener: EventListener) => {
      listeners.push(listener);
      return Promise.resolve();
    }),
  };
  return {
    client,
    flexom: client as unknown as FlexomClient,
    setApiSensors: (latest: Sensor[]) => {
      sensors = latest;
    },
    /** Changes the device health Flexom reports */
    setApiState: (latest: string) => {
      state = latest;
    },
    sendDeviceStateEvent: (itId = DETECTOR) =>
      listeners.forEach((l) =>
        l.listener({
          type: 'IT_STATE',
          timestamp: Date.now(),
          zoneId: zone.id,
          itId,
        }),
      ),
    reconnect: () => listeners.forEach((l) => l.onReconnect?.()),
    sendEvent: (factorId: string, value: unknown, itId = DETECTOR) =>
      listeners.forEach((l) =>
        l.listener({
          type: 'SENSOR_STATE',
          timestamp: Date.now(),
          zoneId: zone.id,
          itId,
          factorId,
          value,
        }),
      ),
  };
}

async function setup(
  sensors: Sensor[],
  {
    cached = [],
    state = 'OK',
  }: { cached?: PlatformAccessory[]; state?: string } = {},
) {
  const fake = createFakeFlexom(sensors, state);
  const logger = createTestLogger();
  const hapWarnings = vi.fn();
  const known = new Map(cached.map((a) => [a.UUID, a]));
  const zoneSensors = await createZoneSensors({
    api: createTestApi(),
    getAccessory: ({ uuid, name }) => {
      const accessory = known.get(uuid) ?? createTestAccessory(name, uuid);
      accessory.on('characteristic-warning' as never, hapWarnings);
      return accessory;
    },
    logger,
    zone,
    flexom: fake.flexom,
    devices: await loadDeviceStates({
      flexom: fake.flexom,
      devices: toSensorDevices(sensors),
    }),
  });
  const service = (type: typeof hap.Service.TemperatureSensor) =>
    zoneSensors!.accessories[0].getService(type);
  const value = (
    type: typeof hap.Service.TemperatureSensor,
    characteristic: Parameters<hap.Service['getCharacteristic']>[0],
  ) => service(type)?.getCharacteristic(characteristic)?.value;
  /** What HomeKit gets when reading the characteristic */
  const read = (
    type: typeof hap.Service.TemperatureSensor,
    characteristic: Parameters<hap.Service['getCharacteristic']>[0],
  ) => service(type)!.getCharacteristic(characteristic)!.handleGetRequest();
  return { ...fake, zoneSensors, service, value, read, logger, hapWarnings };
}

describe('createZoneSensors', () => {
  const { Service, Characteristic } = hap;

  it('is skipped for zones without sensor devices', async () => {
    const { zoneSensors } = await setup([]);
    expect(zoneSensors).toBeUndefined();
  });

  it('exposes temperature, humidity, smoke and battery of a detector', async () => {
    const { zoneSensors, value, hapWarnings, client } =
      await setup(detectorSensors());
    expect(zoneSensors?.accessories.map((a) => a.displayName)).toEqual([
      'Corridor Smoke Detector',
    ]);
    expect(
      value(Service.TemperatureSensor, Characteristic.CurrentTemperature),
    ).toBe(23);
    expect(
      value(Service.HumiditySensor, Characteristic.CurrentRelativeHumidity),
    ).toBe(58);
    expect(value(Service.SmokeSensor, Characteristic.SmokeDetected)).toBe(
      Characteristic.SmokeDetected.SMOKE_NOT_DETECTED,
    );
    expect(value(Service.Battery, Characteristic.BatteryLevel)).toBe(100);
    expect(value(Service.Battery, Characteristic.StatusLowBattery)).toBe(
      Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
    expect(value(Service.SmokeSensor, Characteristic.StatusLowBattery)).toBe(
      Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
    expect(hapWarnings).not.toHaveBeenCalled();
    // Reads are answered from memory
    expect(client.getSensors).not.toHaveBeenCalled();
  });

  it('records the zone and device in the accessory context', async () => {
    const { zoneSensors } = await setup(detectorSensors());
    const [accessory] = zoneSensors!.accessories;
    expect(accessory.context as ZoneAccessoryContext).toEqual({
      zoneId: zone.id,
      roles: [`sensor:${DETECTOR}`],
    });
    expect(accessory.UUID).toBe(
      getSensorAccessoryUuid(createTestApi(), zone, { itId: DETECTOR }),
    );
    expect(
      accessory
        .getService(Service.AccessoryInformation)
        ?.getCharacteristic(Characteristic.SerialNumber).value,
    ).toBe(DETECTOR);
  });

  it('names a device without smoke sensor "Sensor", numbered when several', async () => {
    const { zoneSensors } = await setup([
      { id: 'a#0', itId: 'probe-a', state: { id: 'TMP', value: '20' } },
      { id: 'b#0', itId: 'probe-b', state: { id: 'TMP', value: '21' } },
      ...detectorSensors(),
    ]);
    expect(zoneSensors?.accessories.map((a) => a.displayName)).toEqual([
      'Corridor Smoke Detector',
      'Corridor Sensor 1',
      'Corridor Sensor 2',
    ]);
  });

  it('only creates services for the readings a device has', async () => {
    const { service } = await setup([
      { id: 'a#0', itId: 'probe', state: { id: 'TMP', value: '20' } },
    ]);
    expect(service(Service.TemperatureSensor)).toBeDefined();
    expect(service(Service.HumiditySensor)).toBeUndefined();
    expect(service(Service.SmokeSensor)).toBeUndefined();
    expect(service(Service.Battery)).toBeUndefined();
    expect(
      service(Service.TemperatureSensor)?.testCharacteristic(
        Characteristic.StatusLowBattery,
      ),
    ).toBe(false);
  });

  it('removes the services of readings a cached accessory lost', async () => {
    const cached = createTestAccessory(
      'Corridor Smoke Detector',
      getSensorAccessoryUuid(createTestApi(), zone, { itId: DETECTOR }),
    );
    cached.addService(Service.HumiditySensor);
    cached.addService(Service.Battery);
    const { zoneSensors, service } = await setup(
      detectorSensors().filter(({ state }) => state?.id !== 'HUM'),
      { cached: [cached] },
    );
    expect(zoneSensors?.accessories).toEqual([cached]);
    expect(service(Service.HumiditySensor)).toBeUndefined();
    expect(service(Service.Battery)).toBeDefined();
  });

  it('follows readings pushed by Flexom', async () => {
    const { sendEvent, value, logger } = await setup(detectorSensors());

    sendEvent('TMP', 23.2);
    sendEvent('HUM', 61);
    sendEvent('BATTERY_LEVEL', 0.1);
    // HAP rounds to the 0.1 step, with floating point noise
    expect(
      value(Service.TemperatureSensor, Characteristic.CurrentTemperature),
    ).toBeCloseTo(23.2);
    expect(
      value(Service.HumiditySensor, Characteristic.CurrentRelativeHumidity),
    ).toBe(61);
    expect(value(Service.Battery, Characteristic.BatteryLevel)).toBe(10);
    expect(value(Service.Battery, Characteristic.StatusLowBattery)).toBe(
      Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
    );
    expect(
      value(Service.TemperatureSensor, Characteristic.StatusLowBattery),
    ).toBe(Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining('corrected'),
    );
  });

  it('raises the smoke alarm from an event, and clears it', async () => {
    const { sendEvent, value, logger } = await setup(detectorSensors());
    const smoke = () =>
      value(Service.SmokeSensor, Characteristic.SmokeDetected);

    sendEvent('SMOKE', '1');
    expect(smoke()).toBe(Characteristic.SmokeDetected.SMOKE_DETECTED);
    expect(logger.warn).toHaveBeenCalledWith(
      'Smoke detected by Corridor Smoke Detector',
    );

    sendEvent('SMOKE', '0');
    expect(smoke()).toBe(Characteristic.SmokeDetected.SMOKE_NOT_DETECTED);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('ignores events of other devices and unknown factors', async () => {
    const { sendEvent, value } = await setup(detectorSensors());

    sendEvent('TMP', 30, 'other-device');
    sendEvent('AIR_QUALITY_INDEX_NEXELEC', 'BAD_AIR');
    sendEvent('TMP', 'n/a');
    expect(
      value(Service.TemperatureSensor, Characteristic.CurrentTemperature),
    ).toBe(23);
  });

  it('fixes readings whose events were missed on refresh', async () => {
    const { zoneSensors, setApiSensors, value, logger } =
      await setup(detectorSensors());

    setApiSensors(detectorSensors({ temperature: '24.5', smoke: '1' }));
    await zoneSensors!.refresh();

    expect(
      value(Service.TemperatureSensor, Characteristic.CurrentTemperature),
    ).toBe(24.5);
    expect(value(Service.SmokeSensor, Characteristic.SmokeDetected)).toBe(
      Characteristic.SmokeDetected.SMOKE_DETECTED,
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Corridor Smoke Detector corrected: temperature 23 -> 24.5, smoke false -> true (missed event)',
    );
  });

  it('refreshes after the WebSocket reconnects', async () => {
    const { reconnect, setApiSensors, value, client } =
      await setup(detectorSensors());
    setApiSensors(detectorSensors({ humidity: '40' }));
    reconnect();
    await vi.waitFor(() => expect(client.getSensors).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(
        value(Service.HumiditySensor, Characteristic.CurrentRelativeHumidity),
      ).toBe(40),
    );
  });

  it('keeps readings within HomeKit ranges', async () => {
    const { sendEvent, value } = await setup(detectorSensors());
    sendEvent('TMP', -300);
    sendEvent('HUM', 120);
    sendEvent('BATTERY_LEVEL', 2);
    expect(
      value(Service.TemperatureSensor, Characteristic.CurrentTemperature),
    ).toBe(-270);
    expect(
      value(Service.HumiditySensor, Characteristic.CurrentRelativeHumidity),
    ).toBe(100);
    expect(value(Service.Battery, Characteristic.BatteryLevel)).toBe(100);
  });

  describe('device health', () => {
    const { StatusActive, StatusFault } = Characteristic;
    type Value = Awaited<ReturnType<typeof setup>>['value'];
    const faultOf = (value: Value, type: typeof Service.TemperatureSensor) => ({
      fault: value(type, StatusFault),
      active: value(type, StatusActive),
    });

    it('shows a healthy device as active without fault', async () => {
      const { value, service } = await setup(detectorSensors());
      expect(faultOf(value, Service.SmokeSensor)).toEqual({
        fault: StatusFault.NO_FAULT,
        active: true,
      });
      expect(service(Service.Battery)?.testCharacteristic(StatusFault)).toBe(
        false,
      );
    });

    it('shows a device Flexom lost contact with as faulty, "No response"', async () => {
      const { value, read, logger } = await setup(detectorSensors(), {
        state: 'KO',
      });
      for (const type of [
        Service.TemperatureSensor,
        Service.HumiditySensor,
        Service.SmokeSensor,
      ]) {
        expect(faultOf(value, type)).toEqual({
          fault: StatusFault.GENERAL_FAULT,
          active: false,
        });
      }
      await expect(
        read(Service.SmokeSensor, Characteristic.SmokeDetected),
      ).rejects.toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      await expect(
        read(Service.TemperatureSensor, Characteristic.CurrentTemperature),
      ).rejects.toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      expect(logger.warn).toHaveBeenCalledWith(
        'Corridor Smoke Detector is not reporting to Flexom (state KO): shown as faulty',
      );
    });

    it('answers reads of a healthy device from memory', async () => {
      const { read } = await setup(detectorSensors());
      await expect(
        read(Service.SmokeSensor, Characteristic.SmokeDetected),
      ).resolves.toBe(Characteristic.SmokeDetected.SMOKE_NOT_DETECTED);
    });

    it('detects a device going silent on refresh, and its return', async () => {
      const { zoneSensors, setApiState, value, read, logger } =
        await setup(detectorSensors());

      setApiState('UNREACHABLE');
      await zoneSensors!.refresh();
      expect(faultOf(value, Service.TemperatureSensor)).toEqual({
        fault: StatusFault.GENERAL_FAULT,
        active: false,
      });
      await expect(
        read(Service.TemperatureSensor, Characteristic.CurrentTemperature),
      ).rejects.toBeDefined();
      expect(logger.warn).toHaveBeenCalledWith(
        'Corridor Smoke Detector stopped reporting to Flexom (state UNREACHABLE): shown as faulty',
      );

      setApiState('OK');
      await zoneSensors!.refresh();
      expect(faultOf(value, Service.TemperatureSensor)).toEqual({
        fault: StatusFault.NO_FAULT,
        active: true,
      });
      await expect(
        read(Service.TemperatureSensor, Characteristic.CurrentTemperature),
      ).resolves.toBe(23);
      expect(logger.info).toHaveBeenCalledWith(
        'Corridor Smoke Detector is reporting to Flexom again',
      );
      // Logged once per transition
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('asks Flexom for the device health on a device state event', async () => {
      const { sendDeviceStateEvent, setApiState, client, value } =
        await setup(detectorSensors());
      client.getThing.mockClear();

      setApiState('KO');
      sendDeviceStateEvent();
      await vi.waitFor(() =>
        expect(faultOf(value, Service.SmokeSensor).fault).toBe(
          StatusFault.GENERAL_FAULT,
        ),
      );
      expect(client.getThing).toHaveBeenCalledWith({ itId: DETECTOR });

      sendDeviceStateEvent('other-device');
      expect(client.getThing).toHaveBeenCalledTimes(1);
    });

    it('clears the fault when the device reports a reading', async () => {
      const { sendEvent, value, logger } = await setup(detectorSensors(), {
        state: 'KO',
      });

      sendEvent('TMP', 22);
      expect(faultOf(value, Service.TemperatureSensor)).toEqual({
        fault: StatusFault.NO_FAULT,
        active: true,
      });
      expect(logger.info).toHaveBeenCalledWith(
        'Corridor Smoke Detector is reporting to Flexom again',
      );
    });
  });
});
