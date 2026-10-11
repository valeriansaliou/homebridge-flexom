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

type CharacteristicGetter<T> = () => T | Promise<T>;
type CharacteristicSetter<T> = (
  value: T,
) => Promise<void | { aborted: boolean }>;
type CharacteristicListener<T> = (value: T) => Promise<void>;

type CharacteristicService<T extends HomeKitValue = HomeKitValue> = {
  getValue: () => T;
  setValue: (newValue: T) => Promise<void>;
  setInternalValue: (newValue: T) => void;
  refreshValue: () => Promise<void>;
  onValue: (listener: CharacteristicListener<T>) => void;
};

export async function bindService<T extends HomeKitValue>({
  hap,
  service,
  characteristic,
  getState,
  initialValue,
  setState,
  logger,
  dependencies = [],
}: {
  hap: HAP;
  service: Service;
  characteristic: WithUUID<new () => Characteristic>;
  initialValue: T;
  getState?: CharacteristicGetter<T>;
  setState?: CharacteristicSetter<T>;
  logger: Logger;
  dependencies?: Array<Pick<CharacteristicService, 'onValue'>>;
}): Promise<CharacteristicService<T>> {
  const listeners: Array<CharacteristicListener<T>> = [];

  let internalValue: T = initialValue;

  const setInternalValue = (newValue: T) => {
    service.updateCharacteristic(characteristic, newValue);
    if (internalValue === newValue) {
      logger.debug(`state unchanged (current: ${internalValue})`);
    } else {
      logger.info(`changed from ${internalValue} to ${newValue}`);
    }
    internalValue = newValue;
  };

  const refreshValue = async () => {
    if (!getState) return;
    logger.debug(`refresh state (current: ${internalValue})`);
    const newValue = await getState();
    setInternalValue(newValue);
  };

  const setValue = async (newValue: T) => {
    const result = await setState?.(newValue);
    if (result?.aborted) {
      logger.info('update aborted');
      await refreshValue();
      return;
    }
    setInternalValue(newValue);
    await Promise.all(listeners.map((listener) => listener(newValue)));
  };

  await refreshValue();

  service.getCharacteristic(characteristic).onGet(() => {
    logger.debug(`homekit get state ${internalValue}`);
    refreshValue().catch((err: unknown) => {
      logger.error(`failed to refresh state: ${toLogJson(err)}`);
    });
    return internalValue;
  });

  service
    .getCharacteristic(characteristic)
    .onSet(async (newValue: CharacteristicValue) => {
      logger.debug(`homekit set state ${JSON.stringify(newValue)}`);
      try {
        await setValue(newValue as T);
      } catch (err: unknown) {
        logger.error(`failed to reach target state: ${toLogJson(err)}`);
        throw new hap.HapStatusError(
          hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        );
      }
    });

  dependencies.forEach((dependency) =>
    dependency.onValue(() => refreshValue()),
  );

  return {
    getValue: () => internalValue,
    setValue,
    setInternalValue,
    refreshValue,
    onValue: (listener: CharacteristicListener<T>) => {
      listeners.push(listener);
    },
  };
}
