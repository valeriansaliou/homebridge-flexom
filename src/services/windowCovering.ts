import type {
  API,
  CharacteristicValue,
  Logger,
  PlatformAccessory,
} from 'homebridge';
import { createChildLogger } from '../utils';
import {
  createWindowCoveringController,
  type Movement,
} from './windowCoveringController';

export type WindowCovering = ReturnType<typeof createWindowCovering>;

export function createWindowCovering({
  api,
  accessory,
  subtype,
  name,
  tolerance,
  initialPosition,
  hasPositionEvents,
  sendTarget,
  logger: parentLogger,
}: {
  api: API;
  accessory: PlatformAccessory;
  /** Tells apart several window coverings of a single accessory */
  subtype?: string;
  name: string;
  /** Positions this close (0-100 scale) are considered equal */
  tolerance: number;
  initialPosition: number;
  /** Whether Flexom reports positions while moving (WebSocket events) */
  hasPositionEvents?: boolean;
  sendTarget: (target: number) => void;
  logger: Logger;
}) {
  const logger = createChildLogger({ parentLogger, prefix: 'WindowCovering' });
  const { Characteristic } = api.hap;
  const service = subtype
    ? (accessory.getServiceById(api.hap.Service.WindowCovering, subtype) ??
      accessory.addService(api.hap.Service.WindowCovering, name, subtype))
    : (accessory.getService(api.hap.Service.WindowCovering) ??
      accessory.addService(api.hap.Service.WindowCovering));
  service.setCharacteristic(Characteristic.Name, name);

  const toPositionState: Record<Movement, number> = {
    increasing: Characteristic.PositionState.INCREASING,
    decreasing: Characteristic.PositionState.DECREASING,
    stopped: Characteristic.PositionState.STOPPED,
  };

  const controller = createWindowCoveringController({
    initialPosition,
    tolerance,
    hasPositionEvents,
    sendTarget,
    onChange: ({ current, target, movement }) => {
      logger.debug(`current ${current}, target ${target}, ${movement}`);
      service
        .updateCharacteristic(Characteristic.CurrentPosition, current)
        .updateCharacteristic(Characteristic.TargetPosition, target)
        .updateCharacteristic(
          Characteristic.PositionState,
          toPositionState[movement],
        );
    },
  });

  const { current, target, movement } = controller.getState();
  service
    .updateCharacteristic(Characteristic.CurrentPosition, current)
    .updateCharacteristic(Characteristic.TargetPosition, target)
    .updateCharacteristic(
      Characteristic.PositionState,
      toPositionState[movement],
    );

  service
    .getCharacteristic(Characteristic.CurrentPosition)
    .onGet(() => controller.getState().current);
  service
    .getCharacteristic(Characteristic.PositionState)
    .onGet(() => toPositionState[controller.getState().movement]);
  service
    .getCharacteristic(Characteristic.TargetPosition)
    .onGet(() => controller.getState().target)
    .onSet((value: CharacteristicValue) => {
      logger.debug(`homekit set target ${JSON.stringify(value)}`);
      controller.setTarget(value as number);
    });

  return {
    getPosition: () => controller.getState().current,
    isMoving: controller.isMoving,
    reportPosition: controller.reportPosition,
  };
}
