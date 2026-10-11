import { describe, expect, it } from 'vitest';
import {
  canRemoveAccessory,
  findMissingRoles,
  getBlindRole,
  LIGHT_ROLE,
} from './roles';

const blind1 = getBlindRole({ itId: 'io:1' });
const blind2 = getBlindRole({ itId: 'io:2' });

describe('findMissingRoles', () => {
  it('finds roles Flexom stopped reporting', () => {
    expect(
      findMissingRoles({
        knownRoles: [LIGHT_ROLE, blind1, blind2],
        reportedRoles: [LIGHT_ROLE, blind1],
        exclusions: {},
      }),
    ).toEqual([blind2]);
  });

  it('treats a fallback to zone-wide control as missing blinds', () => {
    expect(
      findMissingRoles({
        knownRoles: [blind1, blind2],
        reportedRoles: [getBlindRole({})],
        exclusions: {},
      }),
    ).toEqual([blind1, blind2]);
  });

  it('ignores roles excluded by the configuration', () => {
    expect(
      findMissingRoles({
        knownRoles: [LIGHT_ROLE, blind1],
        reportedRoles: [],
        exclusions: { light: true, window: true },
      }),
    ).toEqual([]);
  });
});

describe('canRemoveAccessory', () => {
  it('removes accessories whose controls moved to another accessory', () => {
    expect(
      canRemoveAccessory({
        roles: [LIGHT_ROLE, blind1],
        reportedRoles: [LIGHT_ROLE, blind1],
        exclusions: {},
      }),
    ).toBe(true);
  });

  it('removes accessories whose controls are excluded', () => {
    expect(
      canRemoveAccessory({
        roles: [blind1],
        reportedRoles: [LIGHT_ROLE],
        exclusions: { window: true },
      }),
    ).toBe(true);
  });

  it('keeps accessories whose controls Flexom stopped reporting', () => {
    expect(
      canRemoveAccessory({
        roles: [blind2],
        reportedRoles: [blind1],
        exclusions: {},
      }),
    ).toBe(false);
  });

  it('removes accessories from before roles were recorded', () => {
    expect(
      canRemoveAccessory({
        roles: undefined,
        reportedRoles: [],
        exclusions: {},
      }),
    ).toBe(true);
  });
});
