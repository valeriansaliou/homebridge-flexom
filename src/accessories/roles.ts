/**
 * What an accessory controls: `light` and `window` (all lights or window
 * coverings of a zone, driven together), `light:<device id>` and
 * `window:<device id>` (one light or window covering), or
 * `sensor:<device id>` (the sensors of one device).
 * Stored in the accessory context, so a later startup can tell whether
 * Flexom stopped reporting something HomeKit knows about.
 */
export type Role = string;

export const LIGHT_ROLE: Role = 'light';

export function getLightRole({ itId }: { itId?: string }): Role {
  return itId ? `${LIGHT_ROLE}:${itId}` : LIGHT_ROLE;
}

export function getBlindRole({ itId }: { itId?: string }): Role {
  return itId ? `window:${itId}` : 'window';
}

export const SENSOR_ROLE: Role = 'sensor';

export function getSensorRole({ itId }: { itId: string }): Role {
  return `${SENSOR_ROLE}:${itId}`;
}

/** `light`, `window` or `sensor`, whether zone-wide or for one device */
function getKind(role: Role) {
  return role.split(':')[0];
}

export type Exclusions = Partial<{
  light: boolean;
  window: boolean;
  sensors: boolean;
}>;

function isExcluded(role: Role, exclusions: Exclusions) {
  switch (getKind(role)) {
    case LIGHT_ROLE:
      return !!exclusions.light;
    case SENSOR_ROLE:
      return !!exclusions.sensors;
    default:
      return !!exclusions.window;
  }
}

/**
 * Whether Flexom reports a role. A zone-wide role (from before devices were
 * told apart) is reported by any device of its kind: the zone now has
 * several, not none.
 */
function isReported(role: Role, reportedRoles: Role[]) {
  if (reportedRoles.includes(role)) return true;
  return (
    getKind(role) === role &&
    reportedRoles.some((reported) => getKind(reported) === role)
  );
}

/**
 * Roles known to HomeKit that Flexom no longer reports, and that the
 * configuration does not exclude: likely an incomplete API response.
 */
export function findMissingRoles({
  knownRoles,
  reportedRoles,
  exclusions,
}: {
  knownRoles: Role[];
  reportedRoles: Role[];
  exclusions: Exclusions;
}): Role[] {
  return [...new Set(knownRoles)].filter(
    (role) => !isReported(role, reportedRoles) && !isExcluded(role, exclusions),
  );
}

/**
 * Whether an accessory no longer used can be removed from HomeKit: only when
 * the configuration made it obsolete (its controls are excluded, or now live
 * in another accessory). Removing an accessory loses its rooms, scenes and
 * automations, so one whose controls Flexom stopped reporting is kept.
 */
export function canRemoveAccessory({
  roles,
  reportedRoles,
  exclusions,
}: {
  /** Undefined for accessories created before roles were recorded */
  roles: Role[] | undefined;
  reportedRoles: Role[];
  exclusions: Exclusions;
}) {
  if (!roles) return true;
  return roles.every(
    (role) => isReported(role, reportedRoles) || isExcluded(role, exclusions),
  );
}
