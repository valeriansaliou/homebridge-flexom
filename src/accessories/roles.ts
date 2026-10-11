/**
 * What an accessory controls: `light`, `window` (all window coverings of a
 * zone, driven together) or `window:<device id>` (one window covering).
 * Stored in the accessory context, so a later startup can tell whether
 * Flexom stopped reporting something HomeKit knows about.
 */
export type Role = string;

export const LIGHT_ROLE: Role = 'light';

export function getBlindRole({ itId }: { itId?: string }): Role {
  return itId ? `window:${itId}` : 'window';
}

export type Exclusions = Partial<{ light: boolean; window: boolean }>;

function isExcluded(role: Role, exclusions: Exclusions) {
  return role === LIGHT_ROLE ? !!exclusions.light : !!exclusions.window;
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
    (role) => !reportedRoles.includes(role) && !isExcluded(role, exclusions),
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
    (role) => reportedRoles.includes(role) || isExcluded(role, exclusions),
  );
}
