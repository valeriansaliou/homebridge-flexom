import { describe, expect, it } from 'vitest';
import {
  canRemoveAccessory,
  findMissingRoles,
  getBlindRole,
  getLightRole,
  getSensorRole,
  LIGHT_ROLE,
} from './roles';

const blind1 = getBlindRole({ itId: 'io:1' });
const blind2 = getBlindRole({ itId: 'io:2' });
const light1 = getLightRole({ itId: 'light-1' });
const light2 = getLightRole({ itId: 'light-2' });
const sensor1 = getSensorRole({ itId: 'detector-1' });

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

  it('treats lights told apart as reporting the zone light', () => {
    expect(
      findMissingRoles({
        knownRoles: [LIGHT_ROLE],
        reportedRoles: [light1, light2],
        exclusions: {},
      }),
    ).toEqual([]);
  });

  it('treats a fallback to the zone light as missing lights', () => {
    expect(
      findMissingRoles({
        knownRoles: [light1, light2],
        reportedRoles: [LIGHT_ROLE],
        exclusions: {},
      }),
    ).toEqual([light1, light2]);
  });

  it('ignores roles excluded by the configuration', () => {
    expect(
      findMissingRoles({
        knownRoles: [LIGHT_ROLE, light1, blind1],
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

  it('removes a zone light accessory now split into several lights', () => {
    expect(
      canRemoveAccessory({
        roles: [LIGHT_ROLE],
        reportedRoles: [light1, light2],
        exclusions: {},
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

describe('sensor roles', () => {
  it('reports a sensor device Flexom stopped listing as missing', () => {
    expect(
      findMissingRoles({
        knownRoles: [light1, sensor1],
        reportedRoles: [light1],
        exclusions: {},
      }),
    ).toEqual([sensor1]);
  });

  it('ignores sensors when they are excluded', () => {
    expect(
      findMissingRoles({
        knownRoles: [sensor1],
        reportedRoles: [],
        exclusions: { sensors: true },
      }),
    ).toEqual([]);
    expect(
      canRemoveAccessory({
        roles: [sensor1],
        reportedRoles: [],
        exclusions: { sensors: true },
      }),
    ).toBe(true);
  });

  it('keeps a sensor accessory Flexom stopped listing', () => {
    expect(
      canRemoveAccessory({
        roles: [sensor1],
        reportedRoles: [light1],
        exclusions: { light: true, window: true },
      }),
    ).toBe(false);
  });
});
