import { describe, expect, it } from 'vitest';
import type { Actuator } from '../flexom';
import { getBlindPosition, getSlatsFor, toBlinds } from './blinds';

// Actuators as listed by Flexom for a zone with two venetian blinds
const venetianBlinds: Actuator[] = [
  {
    itId: 'io:%%1002%4059123',
    actuatorId: '4059123_C1',
    actionningRepresentation: 'HORIZONTAL_SLATS',
    hardwareState: { value: 0 },
  },
  {
    itId: 'io:%%1002%4059123',
    actuatorId: '4059123_C0',
    actionningRepresentation: 'VERTICAL_ROLLER',
    hardwareState: { value: 1 },
  },
  {
    itId: 'io:%%1002%3455484',
    actuatorId: '3455484_C1',
    actionningRepresentation: 'HORIZONTAL_SLATS',
    hardwareState: { value: 1 },
  },
  {
    itId: 'io:%%1002%3455484',
    actuatorId: '3455484_C0',
    actionningRepresentation: 'VERTICAL_ROLLER',
    hardwareState: { value: 0.25 },
  },
];

describe('toBlinds', () => {
  it('groups position and slats actuators by device, in a stable order', () => {
    expect(toBlinds(venetianBlinds)).toEqual([
      {
        itId: 'io:%%1002%3455484',
        positionActuatorId: '3455484_C0',
        slatsActuatorId: '3455484_C1',
      },
      {
        itId: 'io:%%1002%4059123',
        positionActuatorId: '4059123_C0',
        slatsActuatorId: '4059123_C1',
      },
    ]);
  });

  it('handles roller shutters, without slats', () => {
    expect(
      toBlinds([
        {
          itId: 'io:%%1002%6712155',
          actuatorId: '6712155_C0',
          actionningRepresentation: 'VERTICAL_ROLLER',
        },
      ]),
    ).toEqual([
      {
        itId: 'io:%%1002%6712155',
        positionActuatorId: '6712155_C0',
        slatsActuatorId: undefined,
      },
    ]);
  });

  it('uses an actuator of unknown kind as the position', () => {
    expect(
      toBlinds([{ itId: 'awning', actuatorId: 'awning_C0' }]),
    ).toMatchObject([{ itId: 'awning', positionActuatorId: 'awning_C0' }]);
  });
});

describe('getBlindPosition', () => {
  it('reads the position actuator, not the slats', () => {
    const [first, second] = toBlinds(venetianBlinds);
    expect(getBlindPosition(first, venetianBlinds)).toBe(0.25);
    expect(getBlindPosition(second, venetianBlinds)).toBe(1);
  });

  it('is undefined when unknown', () => {
    const [blind] = toBlinds(venetianBlinds);
    expect(getBlindPosition(blind, [])).toBeUndefined();
    expect(
      getBlindPosition(blind, [
        { ...venetianBlinds[3], hardwareState: { value: null } },
      ]),
    ).toBeUndefined();
  });
});

describe('getSlatsFor', () => {
  it('closes the slats only when fully closed', () => {
    expect(getSlatsFor(0)).toBe(1);
    expect(getSlatsFor(0.5)).toBe(0);
    expect(getSlatsFor(1)).toBe(0);
  });
});
