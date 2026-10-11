import type {
  Characteristic,
  PlatformAccessory,
  Logger,
  API,
} from 'homebridge';
import { createChildLogger } from '../utils';
import { bindService } from './helpers';

type PositionState =
  | typeof Characteristic.PositionState.INCREASING
  | typeof Characteristic.PositionState.DECREASING
  | typeof Characteristic.PositionState.STOPPED;

export type WindowCovering = ReturnType<typeof createWindowCovering>;

export function createWindowCovering({
  api,
  accessory,
  name,
  tolerance,
  initialPosition,
  setState,
  logger: parentLogger,
}: {
  api: API;
  accessory: PlatformAccessory;
  name: string;
  tolerance: number;
  initialPosition: number;
  setState: (targetPosition: number) => Promise<void>;
  logger: Logger;
}) {
  const logger = createChildLogger({ parentLogger, prefix: 'WindowCovering' });
  const service =
    accessory.getService(api.hap.Service.WindowCovering) ||
    accessory.addService(api.hap.Service.WindowCovering);
  service.setCharacteristic(api.hap.Characteristic.Name, name);

  const currentPositionService = bindService<number>({
    hap: api.hap,
    service,
    characteristic: api.hap.Characteristic.CurrentPosition,
    initialValue: initialPosition,
    logger,
  });

  const targetPositionService = bindService<number>({
    hap: api.hap,
    service,
    characteristic: api.hap.Characteristic.TargetPosition,
    initialValue: initialPosition,
    setState,
    logger,
  });

  const { STOPPED, INCREASING, DECREASING } =
    api.hap.Characteristic.PositionState;

  const getPositionState = (): PositionState => {
    const currentPosition = currentPositionService.getValue();
    const targetPosition = targetPositionService.getValue();
    logger.debug(
      'homekit get position state ' +
        `(current: ${currentPosition} / target: ${targetPosition})`,
    );
    if (Math.abs(currentPosition - targetPosition) < tolerance) {
      return STOPPED;
    }
    if (currentPosition < targetPosition) {
      return INCREASING;
    }
    return DECREASING;
  };

  const positionStateService = bindService<PositionState>({
    hap: api.hap,
    service,
    characteristic: api.hap.Characteristic.PositionState,
    initialValue: STOPPED,
    getState: getPositionState,
    logger,
    dependencies: [currentPositionService, targetPositionService],
  });

  return {
    currentPositionService,
    targetPositionService,
    positionStateService,
  };
}
