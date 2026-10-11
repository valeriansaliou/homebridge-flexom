import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventListener } from '../flexom/types';
import type { FlexomClient, ZoneSettings } from '../flexom';
import {
  createTestAccessory,
  createTestApi,
  createTestLogger,
  hap,
} from '../test/homebridge';
import { createFlexomZone } from './flexomZone';

const zone = { id: 'zone-1', name: 'Kitchen' };

function createFakeFlexom(initialSettings: ZoneSettings) {
  let settings = initialSettings;
  const listeners: EventListener[] = [];
  const client = {
    getZoneSettings: vi.fn(() => Promise.resolve(settings)),
    setZoneFactor: vi.fn(() => Promise.resolve()),
    subscribe: vi.fn((listener: EventListener) => {
      listeners.push(listener);
      return Promise.resolve();
    }),
  };
  return {
    client,
    flexom: client as unknown as FlexomClient,
    /** Changes the state the API reports, without sending an event */
    setApiState: (newSettings: ZoneSettings) => {
      settings = newSettings;
    },
    reconnect: () => listeners.forEach((l) => l.onReconnect?.()),
    sendEvent: (factorId: 'BRI' | 'BRIEXT', value: number) =>
      listeners.forEach((l) =>
        l.listener({
          type: 'ACTUATOR_HARDWARE_STATE',
          timestamp: Date.now(),
          zoneId: zone.id,
          factorId,
          value: { value },
        }),
      ),
  };
}

async function setup(settings: ZoneSettings) {
  const fake = createFakeFlexom(settings);
  const accessory = createTestAccessory(zone.name);
  const logger = createTestLogger();
  const flexomZone = await createFlexomZone({
    api: createTestApi(),
    accessory,
    logger,
    zone,
    flexom: fake.flexom,
    tolerance: 0.05,
    exclusions: {},
  });
  // Let the initial (debounced) state fetch settle
  await vi.advanceTimersByTimeAsync(2000);
  const characteristic = (
    service: typeof hap.Service.Lightbulb | typeof hap.Service.WindowCovering,
    type: Parameters<hap.Service['getCharacteristic']>[0],
  ) => accessory.getService(service)!.getCharacteristic(type)!;
  const infoLines = () => logger.info.mock.calls.map(([line]) => line);
  const hapWarnings = vi.fn();
  accessory.on('characteristic-warning' as never, hapWarnings);
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
        accessory: createTestAccessory(zone.name),
        logger: createTestLogger(),
        zone,
        flexom: fake.flexom,
        tolerance: 0.05,
        exclusions: {},
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

    it('logs nothing when the state is already correct', async () => {
      const { flexomZone, infoLines } = await setup({
        BRI: { value: 1 },
        BRIEXT: { value: 0.5 },
      });
      const before = infoLines().length;

      await flexomZone.refresh();
      expect(infoLines()).toHaveLength(before);
    });

    it('does not revert a command that was just sent', async () => {
      const { flexomZone, client, characteristic } = await setup({
        BRI: { value: 0 },
      });
      const on = characteristic(hap.Service.Lightbulb, hap.Characteristic.On);
      client.getZoneSettings.mockClear();

      // HomeKit switches the light on; the API does not reflect it yet
      on.setValue(true);
      await vi.advanceTimersByTimeAsync(1000);
      await flexomZone.refresh();
      expect(on.value).toBe(true);
      expect(client.getZoneSettings).not.toHaveBeenCalled();

      // Once the command has settled, the API is trusted again
      await vi.advanceTimersByTimeAsync(15_000);
      await flexomZone.refresh();
      expect(client.getZoneSettings).toHaveBeenCalled();
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
      await vi.advanceTimersByTimeAsync(1000);

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
});
