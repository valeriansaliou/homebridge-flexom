import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWindowCoveringController } from './windowCoveringController';

function setup(initialPosition = 0, { hasPositionEvents = true } = {}) {
  const sendTarget = vi.fn();
  const onChange = vi.fn();
  const controller = createWindowCoveringController({
    initialPosition,
    tolerance: 5,
    hasPositionEvents,
    sendTarget,
    onChange,
  });
  return { controller, sendTarget, onChange, state: controller.getState };
}

describe('createWindowCoveringController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts stopped at the initial position', () => {
    const { state } = setup(40);
    expect(state()).toEqual({ current: 40, target: 40, movement: 'stopped' });
  });

  describe('moving to a HomeKit target', () => {
    it('sends the target and shows the movement', () => {
      const { controller, sendTarget, state } = setup(0);

      controller.setTarget(80);
      expect(sendTarget).toHaveBeenCalledWith(80);
      expect(state()).toEqual({
        current: 0,
        target: 80,
        movement: 'increasing',
      });
    });

    it('keeps the target while moving, then stops on arrival', () => {
      const { controller, state } = setup(0);
      controller.setTarget(80);

      for (const position of [10, 30, 50, 70]) {
        vi.advanceTimersByTime(2000);
        controller.reportPosition(position, 'event');
        expect(state()).toEqual({
          current: position,
          target: 80,
          movement: 'increasing',
        });
      }
      controller.reportPosition(80, 'event');
      expect(state()).toEqual({ current: 80, target: 80, movement: 'stopped' });
    });

    it('shows exactly the target when stopping within tolerance', () => {
      const { controller, state } = setup(100);
      controller.setTarget(0);

      controller.reportPosition(50, 'event');
      controller.reportPosition(1, 'event');
      expect(state()).toEqual({ current: 0, target: 0, movement: 'stopped' });

      // Later refreshes still reading 1% do not undo it
      controller.reportPosition(1, 'refresh');
      expect(state()).toEqual({ current: 0, target: 0, movement: 'stopped' });
    });

    it('changes course when the target changes mid-way', () => {
      const { controller, sendTarget, state } = setup(0);
      controller.setTarget(100);
      controller.reportPosition(40, 'event');

      controller.setTarget(20);
      expect(sendTarget).toHaveBeenLastCalledWith(20);
      expect(state()).toEqual({
        current: 40,
        target: 20,
        movement: 'decreasing',
      });
      controller.reportPosition(30, 'event');
      controller.reportPosition(20, 'event');
      expect(state()).toEqual({ current: 20, target: 20, movement: 'stopped' });
    });

    it('settles where it stopped when reports stop before the target', () => {
      const { controller, state } = setup(0);
      controller.setTarget(80);
      controller.reportPosition(30, 'event');

      vi.advanceTimersByTime(29_999);
      expect(state().movement).toBe('increasing');
      vi.advanceTimersByTime(1);
      expect(state()).toEqual({ current: 30, target: 30, movement: 'stopped' });
    });

    it('gives up when the command moves nothing', () => {
      const { controller, state } = setup(50);
      controller.setTarget(90);

      vi.advanceTimersByTime(12_999);
      expect(state().movement).toBe('increasing');
      vi.advanceTimersByTime(1);
      expect(state()).toEqual({ current: 50, target: 50, movement: 'stopped' });
    });

    it('does not let a refresh end a movement early', () => {
      const { controller, state } = setup(0);
      controller.setTarget(100);
      controller.reportPosition(20, 'event');

      vi.advanceTimersByTime(29_000);
      controller.reportPosition(40, 'refresh');
      expect(state()).toEqual({
        current: 40,
        target: 100,
        movement: 'increasing',
      });
      // ...nor extend it: only movement reports do
      vi.advanceTimersByTime(1000);
      expect(state().movement).toBe('stopped');
    });

    it('stops right away for a target it is already at', () => {
      const { controller, sendTarget, state } = setup(48);
      controller.setTarget(50);

      expect(sendTarget).toHaveBeenCalledWith(50);
      expect(state()).toEqual({ current: 50, target: 50, movement: 'stopped' });
    });
  });

  describe('moving on its own (wall switch, Flexom app)', () => {
    it('follows the position and shows the direction, then stops', () => {
      const { controller, state } = setup(0);

      controller.reportPosition(20, 'event');
      expect(state()).toEqual({
        current: 20,
        target: 20,
        movement: 'increasing',
      });
      controller.reportPosition(60, 'event');
      expect(state().current).toBe(60);

      vi.advanceTimersByTime(30_000);
      expect(state()).toEqual({ current: 60, target: 60, movement: 'stopped' });
    });

    it('ignores jitter while stopped', () => {
      const { controller, onChange } = setup(50);

      controller.reportPosition(52, 'event');
      controller.reportPosition(48, 'refresh');
      expect(onChange).not.toHaveBeenCalled();
    });

    it('applies refreshed positions without showing a movement', () => {
      const { controller, state } = setup(20);

      controller.reportPosition(80, 'refresh');
      expect(state()).toEqual({ current: 80, target: 80, movement: 'stopped' });
    });
  });

  describe('without position events (refreshes only)', () => {
    const untracked = (initialPosition: number) =>
      setup(initialPosition, { hasPositionEvents: false });

    it('shows the target as reached right away', () => {
      const { controller, sendTarget, state } = untracked(0);

      controller.setTarget(80);
      expect(sendTarget).toHaveBeenCalledWith(80);
      expect(state()).toEqual({ current: 80, target: 80, movement: 'stopped' });
      // Unlike with events, it does not give up on the target
      vi.advanceTimersByTime(60_000);
      expect(state()).toEqual({ current: 80, target: 80, movement: 'stopped' });
    });

    it('ignores refreshes while the shutter may still be moving', () => {
      const { controller, state } = untracked(0);
      controller.setTarget(80);

      vi.advanceTimersByTime(20_000);
      controller.reportPosition(30, 'refresh');
      expect(state()).toEqual({ current: 80, target: 80, movement: 'stopped' });
    });

    it('corrects the position on a later refresh if it stopped elsewhere', () => {
      const { controller, state } = untracked(0);
      controller.setTarget(80);

      vi.advanceTimersByTime(120_000);
      controller.reportPosition(60, 'refresh');
      expect(state()).toEqual({ current: 60, target: 60, movement: 'stopped' });
    });
  });

  it('only notifies actual changes', () => {
    const { controller, onChange } = setup(0);
    controller.setTarget(80);
    controller.reportPosition(40, 'event');
    controller.reportPosition(40, 'event');

    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
