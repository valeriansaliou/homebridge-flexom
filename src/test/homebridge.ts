import * as hap from '@homebridge/hap-nodejs';
import type { API, Logger, PlatformAccessory } from 'homebridge';
import { vi } from 'vitest';

export { hap };

export function createTestApi() {
  return { hap } as unknown as API;
}

/** HAP's Accessory has the same service API as Homebridge's PlatformAccessory */
export function createTestAccessory(
  name: string,
  uuid = hap.uuid.generate(name),
) {
  // PlatformAccessory adds a persisted context to HAP accessories
  return Object.assign(new hap.Accessory(name, uuid), {
    context: {},
  }) as unknown as PlatformAccessory;
}

export function createTestLogger() {
  const logger = {
    prefix: 'Test',
    debug: vi.fn<(message: string) => void>(),
    info: vi.fn<(message: string) => void>(),
    warn: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
  };
  return logger as typeof logger & Logger;
}
