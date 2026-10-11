import type { Actuator } from '../flexom';

/**
 * A light of a zone, with its own switch. Without `itId`, the light stands
 * for the whole zone, driven through the zone factor (when the zone has a
 * single light, or Flexom lists no actuators for it).
 */
export type Light = {
  itId?: string;
  actuatorId?: string;
};

/** Stands for all lights of a zone, driven together */
export const ZONE_LIGHT: Light = {};

/**
 * A zone's lights, one per actuator. Sorted by device id, so lights keep
 * their number across restarts. A single light is driven through the zone,
 * as it always was.
 */
export function toLights(actuators: Actuator[]): Light[] {
  if (actuators.length < 2) return [ZONE_LIGHT];
  return actuators
    .map(({ itId, actuatorId }) => ({ itId, actuatorId }))
    .sort(
      (a, b) =>
        a.itId.localeCompare(b.itId) ||
        a.actuatorId.localeCompare(b.actuatorId),
    );
}

/** Actual state (0 off, above on) of a light, from its actuator */
export function getLightValue(
  light: Light,
  actuators: Actuator[],
): number | undefined {
  const actuator = actuators.find(
    (a) => a.itId === light.itId && a.actuatorId === light.actuatorId,
  );
  return actuator?.hardwareState?.value ?? undefined;
}
