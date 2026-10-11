import { describe, expect, it } from 'vitest';
import type { Actuator } from '../flexom';
import { getLightValue, toLights, ZONE_LIGHT } from './lights';

// Actuators as listed by Flexom for a bathroom with two lights
const twoLights: Actuator[] = [
  {
    itId: '04E687EA366080_C0',
    actuatorId: '0586ccc3#0_C0',
    factors: ['BRI'],
    hardwareState: { value: 1 },
  },
  {
    itId: '04B753EA366080_C1',
    actuatorId: '05857c9b#0_C1',
    factors: ['BRI'],
    hardwareState: { value: 0 },
  },
];

describe('toLights', () => {
  it('lists each light of a zone, in a stable order', () => {
    expect(toLights(twoLights)).toEqual([
      { itId: '04B753EA366080_C1', actuatorId: '05857c9b#0_C1' },
      { itId: '04E687EA366080_C0', actuatorId: '0586ccc3#0_C0' },
    ]);
  });

  it('drives a single light through the zone', () => {
    expect(toLights([twoLights[0]])).toEqual([ZONE_LIGHT]);
    expect(toLights([])).toEqual([ZONE_LIGHT]);
  });
});

describe('getLightValue', () => {
  it('reads the light actuator', () => {
    const [first, second] = toLights(twoLights);
    expect(getLightValue(first, twoLights)).toBe(0);
    expect(getLightValue(second, twoLights)).toBe(1);
  });

  it('is undefined when unknown', () => {
    const [light] = toLights(twoLights);
    expect(getLightValue(light, [])).toBeUndefined();
    expect(
      getLightValue(light, [{ ...twoLights[1], hardwareState: null }]),
    ).toBeUndefined();
  });
});
