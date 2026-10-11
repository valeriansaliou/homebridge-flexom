import type { Actuator } from '../flexom';

/**
 * A window covering device of a zone: a roller shutter, or a venetian blind
 * which also has slats. Without `itId`, the blind stands for the whole zone,
 * driven through the zone factor (when Flexom lists no actuators for it).
 */
export type Blind = {
  itId?: string;
  positionActuatorId?: string;
  slatsActuatorId?: string;
};

/** Stands for all window coverings of a zone, driven together */
export const ZONE_BLIND: Blind = {};

/**
 * Groups a zone's window covering actuators by device. Sorted by device id,
 * so blinds keep their number across restarts.
 */
export function toBlinds(actuators: Actuator[]): Blind[] {
  const byDevice = new Map<string, Actuator[]>();
  for (const actuator of actuators) {
    byDevice.set(actuator.itId, [
      ...(byDevice.get(actuator.itId) ?? []),
      actuator,
    ]);
  }
  return [...byDevice.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([itId, deviceActuators]) => {
      const slats = deviceActuators.find(
        (a) => a.actionningRepresentation === 'HORIZONTAL_SLATS',
      );
      const position =
        deviceActuators.find(
          (a) => a.actionningRepresentation === 'VERTICAL_ROLLER',
        ) ?? deviceActuators.find((a) => a !== slats);
      if (!position) return [];
      return [
        {
          itId,
          positionActuatorId: position.actuatorId,
          slatsActuatorId: slats?.actuatorId,
        },
      ];
    });
}

/** Actual position (0-1) of a blind, from its position actuator */
export function getBlindPosition(
  blind: Blind,
  actuators: Actuator[],
): number | undefined {
  const actuator = actuators.find(
    (a) => a.itId === blind.itId && a.actuatorId === blind.positionActuatorId,
  );
  return actuator?.hardwareState?.value ?? undefined;
}

/**
 * Slats state (0 open, 1 closed) to go with a position (0 closed, 1 open):
 * closed when fully closed, to make the room dark; open otherwise, to see
 * through a partially open blind.
 */
export function getSlatsFor(position: number) {
  return position === 0 ? 1 : 0;
}
