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

type CharacteristicListener<T> = (value: T) => void;

export type CharacteristicService<T extends HomeKitValue = HomeKitValue> = {
  getValue: () => T;
  setInternalValue: (newValue: T) => void;
  refreshValue: () => void;
  onValue: (listener: CharacteristicListener<T>) => void;
};

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
  getState,
  setState,
  logger,
  dependencies = [],
}: {
  hap: HAP;
  service: Service;
  characteristic: WithUUID<new () => Characteristic>;
  initialValue: T;
  /** Derives the value from other characteristics (see `dependencies`) */
  getState?: () => T;
  setState?: (value: T) => Promise<void>;
  logger: Logger;
  /** Characteristics whose HomeKit updates trigger `refreshValue` */
  dependencies?: Array<Pick<CharacteristicService, 'onValue'>>;
}): CharacteristicService<T> {
  const listeners: Array<CharacteristicListener<T>> = [];

  let internalValue: T = initialValue;
  service.updateCharacteristic(characteristic, internalValue);

  const setInternalValue = (newValue: T) => {
    if (internalValue !== newValue) {
      logger.debug(`changed from ${internalValue} to ${newValue}`);
    }
    internalValue = newValue;
    service.updateCharacteristic(characteristic, newValue);
  };

  const refreshValue = () => {
    if (getState) setInternalValue(getState());
  };

  service.getCharacteristic(characteristic).onGet(() => internalValue);

  if (setState) {
    service
      .getCharacteristic(characteristic)
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
        listeners.forEach((listener) => listener(newValue as T));
      });
  }

  dependencies.forEach((dependency) => dependency.onValue(refreshValue));

  return {
    getValue: () => internalValue,
    setInternalValue,
    refreshValue,
    onValue: (listener: CharacteristicListener<T>) => {
      listeners.push(listener);
    },
  };
}
