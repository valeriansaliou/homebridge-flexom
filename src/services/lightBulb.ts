import type { PlatformAccessory, Logger, API } from 'homebridge';
import { createChildLogger } from '../utils';
import { bindService } from './helpers';

export type LightBulb = ReturnType<typeof createLightBulb>;

export function createLightBulb({
  api,
  accessory,
  name,
  initialState,
  setState,
  logger: parentLogger,
}: {
  api: API;
  accessory: PlatformAccessory;
  name: string;
  initialState: boolean;
  setState: (isOn: boolean) => Promise<void>;
  logger: Logger;
}) {
  const logger = createChildLogger({ parentLogger, prefix: 'LightBulb' });
  const service =
    accessory.getService(api.hap.Service.Lightbulb) ||
    accessory.addService(api.hap.Service.Lightbulb);
  service.setCharacteristic(api.hap.Characteristic.Name, name);

  const lightOnService = bindService<boolean>({
    hap: api.hap,
    service,
    characteristic: api.hap.Characteristic.On,
    initialValue: initialState,
    setState,
    logger,
  });

  return { lightOnService };
}
