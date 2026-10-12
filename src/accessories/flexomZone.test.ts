import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventListener } from '../flexom/types';
import type { Actuator, Factor, FlexomClient, ZoneSettings } from '../flexom';
import {
  createTestAccessory,
  createTestApi,
  createTestLogger,
  hap,
} from '../test/homebridge';
import type { PlatformAccessory } from 'homebridge';
import {
  createFlexomZone,
  loadZoneData,
  type GetAccessory,
} from './flexomZone';

const zone = { id: 'zone-1', name: 'Kitchen' };

function createFakeFlexom(
  initialSettings: ZoneSettings,
  initialActuators: Actuator[] = [],
) {
  let settings = initialSettings;
  let actuators = initialActuators;
  const listeners: EventListener[] = [];
  const client = {
    getZoneSettings: vi.fn(() => Promise.resolve(settings)),
    setZoneFactor: vi.fn(() => Promise.resolve()),
    // Like Flexom: each factor lists its own actuators (blinds by default)
    getFactorActuators: vi.fn(({ factor }: { factor: Factor }) =>
      Promise.resolve(
        actuators.filter((a) => (a.factors ?? ['BRIEXT']).includes(factor)),
      ),
    ),
    setActuatorState: vi.fn<
      (params: {
        itId: string;
        actuatorId: string;
        value: number;
      }) => Promise<void>
    >(() => Promise.resolve()),
    subscribe: vi.fn((listener: EventListener) => {
      listeners.push(listener);
      return Promise.resolve();
    }),
    getSensors: vi.fn(() => Promise.resolve([])),
    getThing: vi.fn(({ itId }: { itId: string }) =>
      Promise.resolve({ id: itId, state: 'OK' }),
    ),
  };
  return {
    client,
    flexom: client as unknown as FlexomClient,
    /** Changes the state the API reports, without sending an event */
    setApiState: (newSettings: ZoneSettings) => {
      settings = newSettings;
    },
    setApiActuators: (newActuators: Actuator[]) => {
      actuators = newActuators;
    },
    reconnect: () => listeners.forEach((l) => l.onReconnect?.()),
    sendEvent: (
      factorId: 'BRI' | 'BRIEXT',
      value: number,
      actuator?: { itId?: string; actuatorId: string },
    ) =>
      listeners.forEach((l) =>
        l.listener({
          type: 'ACTUATOR_HARDWARE_STATE',
          timestamp: Date.now(),
          zoneId: zone.id,
          itId: actuator?.itId,
          factorId,
          value: { value, actuatorId: actuator?.actuatorId },
        }),
      ),
  };
}

async function setup(
  settings: ZoneSettings,
  {
    separateAccessories = true,
    cached = [],
    actuators = [],
  }: {
    separateAccessories?: boolean;
    cached?: PlatformAccessory[];
    actuators?: Actuator[];
  } = {},
) {
  const fake = createFakeFlexom(settings, actuators);
  const logger = createTestLogger();
  const hapWarnings = vi.fn();
  // Like the platform: cached accessories, or a new one on every call
  const known = new Map(cached.map((a) => [a.UUID, a]));
  const getAccessory: GetAccessory = ({ uuid, name }) => {
    const accessory = known.get(uuid) ?? createTestAccessory(name, uuid);
    accessory.on('characteristic-warning' as never, hapWarnings);
    return accessory;
  };
  const flexomZone = await createFlexomZone({
    api: createTestApi(),
    getAccessory,
    separateAccessories,
    logger,
    zone,
    flexom: fake.flexom,
    tolerance: 0.05,
    data: await loadZoneData({ flexom: fake.flexom, zone }),
  });
  // Let the initial (debounced) state fetch settle
  await vi.advanceTimersByTimeAsync(2000);
  const characteristic = (
    service: typeof hap.Service.Lightbulb | typeof hap.Service.WindowCovering,
    type: Parameters<hap.Service['getCharacteristic']>[0],
  ) =>
    flexomZone!.accessories
      .map((accessory) => accessory.getService(service))
      .find(Boolean)!
      .getCharacteristic(type)!;
  const infoLines = () => logger.info.mock.calls.map(([line]) => line);
  return {
    ...fake,
    flexomZone: flexomZone!,
    characteristic,
    infoLines,
    logger,
    hapWarnings,
  };
}

describe('createFlexomZone', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is skipped for zones without light or window controls', async () => {
    const fake = createFakeFlexom({ TMP: { value: 20 } });
    await expect(
      createFlexomZone({
        api: createTestApi(),
        getAccessory: ({ uuid, name }) => createTestAccessory(name, uuid),
        separateAccessories: true,
        logger: createTestLogger(),
        zone,
        flexom: fake.flexom,
        tolerance: 0.05,
        data: await loadZoneData({ flexom: fake.flexom, zone }),
      }),
    ).resolves.toBeUndefined();
  });

  describe('refresh', () => {
    it('fixes a light whose change was missed', async () => {
      const { flexomZone, setApiState, characteristic, infoLines } =
        await setup({ BRI: { value: 0 } });
      const on = characteristic(hap.Service.Lightbulb, hap.Characteristic.On);
      expect(on.value).toBe(false);

      setApiState({ BRI: { value: 1 } });
      await flexomZone.refresh();

      expect(on.value).toBe(true);
      expect(infoLines()).toContain(
        'Light corrected from off to on (missed event)',
      );
    });

    it('fixes a window covering whose movement was missed', async () => {
      const { flexomZone, setApiState, characteristic, infoLines } =
        await setup({ BRIEXT: { value: 0.2 } });
      const { CurrentPosition, TargetPosition } = hap.Characteristic;

      setApiState({ BRIEXT: { value: 0.8 } });
      await flexomZone.refresh();

      const service = hap.Service.WindowCovering;
      expect(characteristic(service, CurrentPosition).value).toBe(80);
      expect(characteristic(service, TargetPosition).value).toBe(80);
      expect(infoLines()).toContain(
        'Window covering corrected from 20% to 80% (missed event)',
      );
    });

    it('logs local and remote values at debug when in sync', async () => {
      const { flexomZone, setApiState, infoLines, logger } = await setup({
        BRI: { value: 1 },
        BRIEXT: { value: 0.5 },
      });
      const before = infoLines().length;

      setApiState({ BRI: { value: 1 }, BRIEXT: { value: 0.52 } });
      await flexomZone.refresh();
      expect(infoLines()).toHaveLength(before);
      expect(logger.debug).toHaveBeenCalledWith(
        'State in sync with API: light local=on remote=on, window covering local=50% remote=52%',
      );
    });

    it('does not log in sync when correcting', async () => {
      const { flexomZone, setApiState, logger } = await setup({
        BRI: { value: 0 },
      });

      setApiState({ BRI: { value: 1 } });
      await flexomZone.refresh();
      expect(logger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('State in sync'),
      );
    });

    it('marks values not compared in the in sync log', async () => {
      const { flexomZone, characteristic, logger } = await setup({
        BRI: { value: 0 },
        BRIEXT: { value: 0 },
      });
      characteristic(hap.Service.Lightbulb, hap.Characteristic.On).setValue(
        true,
      );
      characteristic(
        hap.Service.WindowCovering,
        hap.Characteristic.TargetPosition,
      ).setValue(80);
      await vi.advanceTimersByTimeAsync(500);

      await flexomZone.refresh();
      expect(logger.debug).toHaveBeenCalledWith(
        'State in sync with API: light local=on remote=off (command pending), window covering local=0% remote=0% (moving)',
      );
    });

    it('does not revert a light command that was just sent', async () => {
      const { flexomZone, characteristic } = await setup({
        BRI: { value: 0 },
      });
      const on = characteristic(hap.Service.Lightbulb, hap.Characteristic.On);

      // HomeKit switches the light on; the API does not reflect it yet
      on.setValue(true);
      await vi.advanceTimersByTimeAsync(1000);
      await flexomZone.refresh();
      expect(on.value).toBe(true);

      // Once the command has settled, the API is trusted again
      await vi.advanceTimersByTimeAsync(15_000);
      await flexomZone.refresh();
      expect(on.value).toBe(false);
    });

    it('runs after the WebSocket reconnects', async () => {
      const { setApiState, reconnect, characteristic } = await setup({
        BRI: { value: 0 },
      });

      setApiState({ BRI: { value: 1 } });
      reconnect();
      await vi.advanceTimersByTimeAsync(0);

      const on = characteristic(hap.Service.Lightbulb, hap.Characteristic.On);
      expect(on.value).toBe(true);
    });
  });

  // Homebridge writes every info/warn/error line and HAP warning to its log
  // file: these paths must stay silent to spare the Raspberry Pi SD card.
  describe('disk writes', () => {
    const expectNoLogWrites = ({
      logger,
      hapWarnings,
    }: Awaited<ReturnType<typeof setup>>) => {
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(hapWarnings).not.toHaveBeenCalled();
    };

    const setupSilently = async () => {
      const zoneSetup = await setup({
        BRI: { value: 0 },
        BRIEXT: { value: 0 },
      });
      zoneSetup.logger.info.mockClear(); // startup lines are fine
      return zoneSetup;
    };

    it('logs nothing when receiving WebSocket events', async () => {
      const zoneSetup = await setupSilently();
      const { CurrentPosition } = hap.Characteristic;

      zoneSetup.sendEvent('BRI', 1);
      zoneSetup.sendEvent('BRIEXT', 0.07);
      zoneSetup.sendEvent('BRIEXT', 0.07);
      const service = hap.Service.WindowCovering;
      expect(zoneSetup.characteristic(service, CurrentPosition).value).toBe(7);

      // Flexom values can be slightly out of range, which HAP would warn about
      zoneSetup.sendEvent('BRIEXT', 1.02);
      expect(zoneSetup.characteristic(service, CurrentPosition).value).toBe(
        100,
      );
      expectNoLogWrites(zoneSetup);
    });

    it('logs nothing when sending HomeKit commands', async () => {
      const zoneSetup = await setupSilently();
      const { client, characteristic } = zoneSetup;

      characteristic(hap.Service.Lightbulb, hap.Characteristic.On).setValue(
        true,
      );
      characteristic(
        hap.Service.WindowCovering,
        hap.Characteristic.TargetPosition,
      ).setValue(37);
      await vi.advanceTimersByTimeAsync(3000);

      expect(client.setZoneFactor).toHaveBeenCalledWith({
        id: zone.id,
        factor: 'BRI',
        value: 1,
      });
      expect(client.setZoneFactor).toHaveBeenCalledWith({
        id: zone.id,
        factor: 'BRIEXT',
        value: 0.37,
      });
      expectNoLogWrites(zoneSetup);
    });

    it('answers HomeKit reads from memory, without API calls or logs', async () => {
      const zoneSetup = await setupSilently();
      zoneSetup.client.getZoneSettings.mockClear();

      await zoneSetup
        .characteristic(hap.Service.Lightbulb, hap.Characteristic.On)
        .handleGetRequest();
      await zoneSetup
        .characteristic(
          hap.Service.WindowCovering,
          hap.Characteristic.CurrentPosition,
        )
        .handleGetRequest();
      await vi.advanceTimersByTimeAsync(5000);

      expect(zoneSetup.client.getZoneSettings).not.toHaveBeenCalled();
      expectNoLogWrites(zoneSetup);
    });

    it('logs a single error when a command fails', async () => {
      const zoneSetup = await setupSilently();
      zoneSetup.client.setZoneFactor.mockRejectedValue(new Error('HTTP 503'));

      zoneSetup
        .characteristic(hap.Service.Lightbulb, hap.Characteristic.On)
        .setValue(true);
      await vi.advanceTimersByTimeAsync(1000);

      expect(zoneSetup.logger.error).toHaveBeenCalledTimes(1);
    });
  });

  describe('window covering', () => {
    const { CurrentPosition, TargetPosition, PositionState } =
      hap.Characteristic;

    const setupShutter = async (position: number) => {
      const zoneSetup = await setup({ BRIEXT: { value: position } });
      const read = () => {
        const get = (type: typeof CurrentPosition) =>
          zoneSetup.characteristic(hap.Service.WindowCovering, type).value;
        return {
          current: get(CurrentPosition),
          target: get(TargetPosition),
          state: get(PositionState),
        };
      };
      const setTarget = (target: number) =>
        zoneSetup
          .characteristic(hap.Service.WindowCovering, TargetPosition)
          .setValue(target);
      return { ...zoneSetup, read, setTarget };
    };

    it('sends only the final value of a slider drag, even with pauses', async () => {
      const { client, setTarget, read } = await setupShutter(1);

      // The Home app sends values whenever the drag pauses, not only on release
      for (const target of [80, 60, 40]) {
        setTarget(target);
        await vi.advanceTimersByTimeAsync(2000);
      }
      // HomeKit shows the new target right away
      expect(read()).toEqual({
        current: 100,
        target: 40,
        state: PositionState.DECREASING,
      });
      expect(client.setZoneFactor).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);

      expect(client.setZoneFactor).toHaveBeenCalledTimes(1);
      expect(client.setZoneFactor).toHaveBeenCalledWith({
        id: zone.id,
        factor: 'BRIEXT',
        value: 0.4,
      });
    });

    it('stays in sync while moving to the target', async () => {
      const { sendEvent, setTarget, read, flexomZone, setApiState, logger } =
        await setupShutter(1);
      setTarget(40);
      await vi.advanceTimersByTimeAsync(500);

      sendEvent('BRIEXT', 0.85);
      await vi.advanceTimersByTimeAsync(2000);
      sendEvent('BRIEXT', 0.62);
      expect(read()).toEqual({
        current: 62,
        target: 40,
        state: PositionState.DECREASING,
      });

      // A periodic refresh mid-way neither interferes nor logs a correction
      setApiState({ BRIEXT: { value: 0.55 } });
      await flexomZone.refresh();
      expect(read().target).toBe(40);
      expect(logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('corrected'),
      );

      sendEvent('BRIEXT', 0.41);
      expect(read()).toEqual({
        current: 40,
        target: 40,
        state: PositionState.STOPPED,
      });
    });

    it('follows a shutter moved with a wall switch', async () => {
      const { sendEvent, read } = await setupShutter(0);

      sendEvent('BRIEXT', 0.3);
      expect(read()).toEqual({
        current: 30,
        target: 30,
        state: PositionState.INCREASING,
      });
      sendEvent('BRIEXT', 0.7);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(read()).toEqual({
        current: 70,
        target: 70,
        state: PositionState.STOPPED,
      });
    });
  });

  describe('accessories', () => {
    const zoneUuid = hap.uuid.generate(zone.id);
    const windowUuid = hap.uuid.generate(`${zone.id}:window`);
    const describeAccessories = (accessories: PlatformAccessory[]) =>
      accessories.map((accessory) => ({
        uuid: accessory.UUID,
        name: accessory.displayName,
        light: !!accessory.getService(hap.Service.Lightbulb),
        window: !!accessory.getService(hap.Service.WindowCovering),
        serial: accessory
          .getService(hap.Service.AccessoryInformation)!
          .getCharacteristic(hap.Characteristic.SerialNumber).value,
      }));

    it('exposes the light and window covering separately by default', async () => {
      const { flexomZone } = await setup({
        BRI: { value: 0 },
        BRIEXT: { value: 0 },
      });

      expect(describeAccessories(flexomZone.accessories)).toEqual([
        {
          uuid: zoneUuid,
          name: 'Kitchen Light',
          light: true,
          window: false,
          serial: zone.id,
        },
        {
          uuid: windowUuid,
          name: 'Kitchen Shutter',
          light: false,
          window: true,
          serial: zone.id,
        },
      ]);
    });

    it('can group them in a single accessory', async () => {
      const { flexomZone } = await setup(
        { BRI: { value: 0 }, BRIEXT: { value: 0 } },
        { separateAccessories: false },
      );

      expect(describeAccessories(flexomZone.accessories)).toEqual([
        {
          uuid: zoneUuid,
          name: 'Kitchen',
          light: true,
          window: true,
          serial: zone.id,
        },
      ]);
    });

    it('keeps the cached accessory for the light when splitting', async () => {
      const cached = createTestAccessory('Kitchen', zoneUuid);
      cached.addService(hap.Service.Lightbulb);
      cached.addService(hap.Service.WindowCovering);

      const { flexomZone } = await setup(
        { BRI: { value: 0 }, BRIEXT: { value: 0 } },
        { cached: [cached] },
      );

      expect(flexomZone.accessories[0]).toBe(cached);
      expect(describeAccessories(flexomZone.accessories)).toMatchObject([
        { uuid: zoneUuid, light: true, window: false },
        { uuid: windowUuid, light: false, window: true },
      ]);
    });

    it('only uses the accessories a zone needs', async () => {
      const { flexomZone } = await setup({ BRIEXT: { value: 0 } });

      expect(describeAccessories(flexomZone.accessories)).toMatchObject([
        { uuid: windowUuid, name: 'Kitchen Shutter' },
      ]);
    });
  });

  describe('blinds', () => {
    // Two venetian blinds, as listed by Flexom: position (roller) and slats
    const blind = (id: string, position: number, slats: number) => [
      {
        itId: `io:${id}`,
        actuatorId: `${id}_C0`,
        actionningRepresentation: 'VERTICAL_ROLLER',
        hardwareState: { value: position },
      },
      {
        itId: `io:${id}`,
        actuatorId: `${id}_C1`,
        actionningRepresentation: 'HORIZONTAL_SLATS',
        hardwareState: { value: slats },
      },
    ];
    const { CurrentPosition, TargetPosition } = hap.Characteristic;
    // The zone value averages positions and slats: never a position
    const zoneSettings = { BRIEXT: { value: 0.5 } };

    const setupBlinds = (
      actuators: Actuator[],
      options: { separateAccessories?: boolean } = {},
    ) => setup(zoneSettings, { actuators, ...options });

    const windowServices = (accessories: PlatformAccessory[]) =>
      accessories.flatMap((accessory) =>
        accessory.services.filter(
          (service) => service.UUID === hap.Service.WindowCovering.UUID,
        ),
      );
    const positions = (accessories: PlatformAccessory[]) =>
      windowServices(accessories).map((service) => ({
        current: service.getCharacteristic(CurrentPosition).value,
        target: service.getCharacteristic(TargetPosition).value,
      }));

    it('exposes one accessory per blind, at its actual position', async () => {
      const { flexomZone } = await setupBlinds([
        ...blind('42', 1, 0),
        ...blind('17', 0.25, 1),
      ]);

      expect(
        flexomZone.accessories.map((a) => [a.displayName, a.UUID]),
      ).toEqual([
        ['Kitchen Shutter 1', hap.uuid.generate(`${zone.id}:window:io:17`)],
        ['Kitchen Shutter 2', hap.uuid.generate(`${zone.id}:window:io:42`)],
      ]);
      expect(positions(flexomZone.accessories)).toEqual([
        { current: 25, target: 25 },
        { current: 100, target: 100 },
      ]);
    });

    it('keeps the existing accessory for a single blind', async () => {
      const { flexomZone } = await setupBlinds(blind('42', 1, 0));

      expect(
        flexomZone.accessories.map((a) => [a.displayName, a.UUID]),
      ).toEqual([['Kitchen Shutter', hap.uuid.generate(`${zone.id}:window`)]]);
    });

    it('groups blinds as separate services when grouping accessories', async () => {
      const cached = createTestAccessory('Kitchen', hap.uuid.generate(zone.id));
      cached.addService(hap.Service.WindowCovering); // from a single blind

      const { flexomZone } = await setup(zoneSettings, {
        actuators: [...blind('42', 1, 0), ...blind('17', 0.25, 1)],
        separateAccessories: false,
        cached: [cached],
      });

      expect(flexomZone.accessories).toEqual([cached]);
      expect(
        windowServices(flexomZone.accessories).map((s) => s.subtype),
      ).toEqual(['io:17', 'io:42']);
    });

    it('closes the slats only when fully closing', async () => {
      const { flexomZone, client } = await setupBlinds([
        ...blind('42', 1, 0),
        ...blind('17', 1, 0),
      ]);
      const [first, second] = windowServices(flexomZone.accessories);

      first.getCharacteristic(TargetPosition).setValue(0);
      second.getCharacteristic(TargetPosition).setValue(50);
      await vi.advanceTimersByTimeAsync(3000);

      // Each blind: position first, then slats
      const callsOf = (itId: string) =>
        client.setActuatorState.mock.calls
          .map(([call]) => call)
          .filter((call) => call.itId === itId);
      expect(callsOf('io:17')).toEqual([
        { itId: 'io:17', actuatorId: '17_C0', value: 0 },
        { itId: 'io:17', actuatorId: '17_C1', value: 1 },
      ]);
      expect(callsOf('io:42')).toEqual([
        { itId: 'io:42', actuatorId: '42_C0', value: 0.5 },
        { itId: 'io:42', actuatorId: '42_C1', value: 0 },
      ]);
      expect(client.setZoneFactor).not.toHaveBeenCalled();
    });

    it('only moves the position of roller shutters', async () => {
      const { flexomZone, client } = await setupBlinds([
        {
          itId: 'io:9',
          actuatorId: '9_C0',
          actionningRepresentation: 'VERTICAL_ROLLER',
          hardwareState: { value: 1 },
        },
      ]);

      windowServices(flexomZone.accessories)[0]
        .getCharacteristic(TargetPosition)
        .setValue(0);
      await vi.advanceTimersByTimeAsync(3000);

      expect(client.setActuatorState.mock.calls).toEqual([
        [{ itId: 'io:9', actuatorId: '9_C0', value: 0 }],
      ]);
    });

    it('follows position events of each blind, ignoring slats', async () => {
      const { flexomZone, sendEvent } = await setupBlinds([
        ...blind('42', 1, 0),
        ...blind('17', 1, 0),
      ]);

      sendEvent('BRIEXT', 0.4, { itId: 'io:42', actuatorId: '42_C0' });
      sendEvent('BRIEXT', 1, { itId: 'io:42', actuatorId: '42_C1' });
      sendEvent('BRIEXT', 0, { itId: 'io:17', actuatorId: '17_C1' });

      expect(positions(flexomZone.accessories)).toEqual([
        { current: 100, target: 100 },
        { current: 40, target: 40 },
      ]);
    });

    it('refreshes actual positions, not the zone value', async () => {
      const { flexomZone, setApiActuators, logger } = await setupBlinds([
        ...blind('42', 1, 0),
      ]);

      setApiActuators(blind('42', 0, 1));
      await flexomZone.refresh();

      expect(positions(flexomZone.accessories)).toEqual([
        { current: 0, target: 0 },
      ]);
      expect(logger.info).toHaveBeenCalledWith(
        'Window covering corrected from 100% to 0% (missed event)',
      );
    });

    it('logs blinds by number when in sync', async () => {
      const { flexomZone, logger } = await setupBlinds([
        ...blind('42', 1, 0),
        ...blind('17', 0.5, 0),
      ]);

      await flexomZone.refresh();
      expect(logger.debug).toHaveBeenCalledWith(
        'State in sync with API: window covering 1 local=50% remote=50%, window covering 2 local=100% remote=100%',
      );
    });
  });

  describe('lights', () => {
    // A zone with two lights, each with its own wall switch
    const light = (id: string, value: number): Actuator => ({
      itId: `it:${id}`,
      actuatorId: `${id}_C0`,
      factors: ['BRI'],
      hardwareState: { value },
    });
    const { On } = hap.Characteristic;
    // The zone value covers every light of the zone
    const zoneSettings = { BRI: { value: 1, actuatorCount: 2 } };

    const setupLights = (
      actuators: Actuator[],
      options: {
        separateAccessories?: boolean;
        cached?: PlatformAccessory[];
      } = {},
    ) => setup(zoneSettings, { actuators, ...options });

    const lightServices = (accessories: PlatformAccessory[]) =>
      accessories.flatMap((accessory) =>
        accessory.services.filter(
          (service) => service.UUID === hap.Service.Lightbulb.UUID,
        ),
      );
    const states = (accessories: PlatformAccessory[]) =>
      lightServices(accessories).map((s) => s.getCharacteristic(On).value);

    it('exposes one accessory per light, in its actual state', async () => {
      const { flexomZone } = await setupLights([
        light('42', 0),
        light('17', 1),
      ]);

      expect(
        flexomZone.accessories.map((a) => [a.displayName, a.UUID]),
      ).toEqual([
        // The first light keeps the zone light accessory, and its setup
        ['Kitchen Light 1', hap.uuid.generate(zone.id)],
        ['Kitchen Light 2', hap.uuid.generate(`${zone.id}:light:it:42`)],
      ]);
      expect(states(flexomZone.accessories)).toEqual([true, false]);
    });

    it('keeps the zone light for a single light, without listing it', async () => {
      const { flexomZone, client } = await setup({
        BRI: { value: 1, actuatorCount: 1 },
      });

      expect(
        flexomZone.accessories.map((a) => [a.displayName, a.UUID]),
      ).toEqual([['Kitchen Light', hap.uuid.generate(zone.id)]]);
      expect(client.getFactorActuators).not.toHaveBeenCalled();

      const [service] = lightServices(flexomZone.accessories);
      service.getCharacteristic(On).setValue(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(client.setZoneFactor).toHaveBeenCalledWith({
        id: zone.id,
        factor: 'BRI',
        value: 0,
      });
    });

    it('groups lights as separate services when grouping accessories', async () => {
      const cached = createTestAccessory('Kitchen', hap.uuid.generate(zone.id));
      cached.addService(hap.Service.Lightbulb); // from the zone light

      const { flexomZone } = await setupLights(
        [light('42', 0), light('17', 1)],
        {
          separateAccessories: false,
          cached: [cached],
        },
      );

      expect(flexomZone.accessories).toEqual([cached]);
      const services = lightServices(flexomZone.accessories);
      expect(services.map((s) => s.subtype)).toEqual([undefined, 'it:42']);
      expect(
        services.map((s) => s.getCharacteristic(hap.Characteristic.Name).value),
      ).toEqual(['Kitchen Light 1', 'Kitchen Light 2']);
    });

    it('switches each light on its own', async () => {
      const { flexomZone, client } = await setupLights([
        light('42', 0),
        light('17', 0),
      ]);
      const [, second] = lightServices(flexomZone.accessories);

      second.getCharacteristic(On).setValue(true);
      await vi.advanceTimersByTimeAsync(1000);

      expect(client.setActuatorState.mock.calls).toEqual([
        [{ itId: 'it:42', actuatorId: '42_C0', value: 1 }],
      ]);
      expect(client.setZoneFactor).not.toHaveBeenCalled();
    });

    it('follows events of each light', async () => {
      const { flexomZone, sendEvent } = await setupLights([
        light('42', 0),
        light('17', 0),
      ]);

      sendEvent('BRI', 1, { itId: 'it:42', actuatorId: '42_C0' });
      expect(states(flexomZone.accessories)).toEqual([false, true]);

      // Events without a device id are matched by actuator
      sendEvent('BRI', 1, { actuatorId: '17_C0' });
      sendEvent('BRI', 0, { itId: 'it:42', actuatorId: '42_C0' });
      expect(states(flexomZone.accessories)).toEqual([true, false]);
    });

    it('refreshes actual states, not the zone value', async () => {
      const { flexomZone, setApiActuators, logger } = await setupLights([
        light('42', 0),
        light('17', 1),
      ]);

      setApiActuators([light('42', 1), light('17', 1)]);
      await flexomZone.refresh();

      expect(states(flexomZone.accessories)).toEqual([true, true]);
      expect(logger.info).toHaveBeenCalledWith(
        'Light 2 corrected from off to on (missed event)',
      );
    });

    it('records a role per light', async () => {
      const { flexomZone } = await setupLights([
        light('42', 0),
        light('17', 1),
      ]);

      expect(flexomZone.accessories.map((a) => a.context)).toEqual([
        { zoneId: zone.id, roles: ['light:it:17'] },
        { zoneId: zone.id, roles: ['light:it:42'] },
      ]);
    });
  });

  describe('roles', () => {
    it('records what each accessory controls', async () => {
      const { flexomZone } = await setup(
        { BRI: { value: 0 }, BRIEXT: { value: 0.5 } },
        {
          actuators: [
            { itId: 'io:1', actuatorId: '1_C0', hardwareState: { value: 1 } },
            { itId: 'io:2', actuatorId: '2_C0', hardwareState: { value: 1 } },
          ],
        },
      );

      expect(flexomZone.accessories.map((a) => a.context)).toEqual([
        { zoneId: zone.id, roles: ['light'] },
        { zoneId: zone.id, roles: ['window:io:1'] },
        { zoneId: zone.id, roles: ['window:io:2'] },
      ]);
    });

    it('records all roles of a grouped accessory', async () => {
      const { flexomZone } = await setup(
        { BRI: { value: 0 }, BRIEXT: { value: 0.5 } },
        { separateAccessories: false },
      );

      expect(flexomZone.accessories.map((a) => a.context)).toEqual([
        { zoneId: zone.id, roles: ['light', 'window'] },
      ]);
    });
  });
});
