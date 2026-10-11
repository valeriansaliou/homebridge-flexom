import type {
  Characteristic,
  CharacteristicValue,
  HAP,
  Logger,
  Service,
  WithUUID,
} from 'homebridge';
import { toLogJson } from '../utils';

type HomeKitValue = boolean | number;

/**
 * Binds a HomeKit characteristic to an in-memory value. HomeKit reads are
 * answered from memory, which WebSocket events and periodic refreshes keep
 * up to date: they never hit the API, and nothing is logged above debug.
 */
export function bindService<T extends HomeKitValue>({
  hap,
  service,
  characteristic,
  initialValue,
  setState,
  logger,
}: {
  hap: HAP;
  service: Service;
  characteristic: WithUUID<new () => Characteristic>;
  initialValue: T;
  setState: (value: T) => Promise<void>;
  logger: Logger;
}) {
  let internalValue: T = initialValue;
  service.updateCharacteristic(characteristic, internalValue);

  const setInternalValue = (newValue: T) => {
    if (internalValue !== newValue) {
      logger.debug(`changed from ${internalValue} to ${newValue}`);
    }
    internalValue = newValue;
    service.updateCharacteristic(characteristic, newValue);
  };

  service
    .getCharacteristic(characteristic)
    .onGet(() => internalValue)
    .onSet(async (newValue: CharacteristicValue) => {
      logger.debug(`homekit set state ${JSON.stringify(newValue)}`);
      try {
        await setState(newValue as T);
      } catch (err: unknown) {
        logger.error(`failed to reach target state: ${toLogJson(err)}`);
        throw new hap.HapStatusError(
          hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        );
      }
      setInternalValue(newValue as T);
    });

  return {
    getValue: () => internalValue,
    setInternalValue,
  };
}
