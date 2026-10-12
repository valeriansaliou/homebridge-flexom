// A moving shutter reports its position every 10-20s (observed on Somfy IO
// blinds): this long without a report means it stopped (reached its end, or
// stopped by hand)
const SETTLE_DELAY = 30_000; /* ms */
// A command that moved nothing (already there, or ignored) within this delay
// is given up on, so HomeKit does not wait for a target that will never come.
// Includes the 3s the command waits for a slider drag to end before it is sent.
const START_TIMEOUT = 13_000; /* ms */
// Without position events, how long a commanded shutter may still be moving:
// a refresh in the meantime would show it halfway. Includes the 3s the
// command waits for a slider drag to end before it is sent.
const UNTRACKED_MOVE_DELAY = 90_000; /* ms */

export type Movement = 'increasing' | 'decreasing' | 'stopped';

export type WindowCoveringState = {
  /** Position shown in HomeKit (0 closed - 100 open) */
  current: number;
  /** Position HomeKit asked for, or the current one once stopped */
  target: number;
  movement: Movement;
};

/**
 * Tracks a window covering's HomeKit state from commands and position
 * reports, which Flexom sends repeatedly while a shutter moves. Without
 * position events, a command is shown as reached right away, and the
 * periodic refresh corrects it if the shutter stopped elsewhere.
 */
export function createWindowCoveringController({
  initialPosition,
  tolerance,
  hasPositionEvents = true,
  sendTarget,
  onChange,
}: {
  initialPosition: number;
  /** Positions this close (0-100 scale) are considered equal */
  tolerance: number;
  /** Whether Flexom reports positions while moving (WebSocket events) */
  hasPositionEvents?: boolean;
  sendTarget: (target: number) => void;
  onChange: (state: WindowCoveringState) => void;
}) {
  let state: WindowCoveringState = {
    current: initialPosition,
    target: initialPosition,
    movement: 'stopped',
  };
  // Set while moving towards a target requested from HomeKit
  let pendingTarget: number | undefined;
  let settleTimer: NodeJS.Timeout | undefined;
  // When the last command was sent, without position events
  let untrackedCommandAt = 0;

  const update = (patch: Partial<WindowCoveringState>) => {
    const next = { ...state, ...patch };
    if (
      next.current === state.current &&
      next.target === state.target &&
      next.movement === state.movement
    ) {
      return;
    }
    state = next;
    onChange(state);
  };

  const isClose = (a: number, b: number) => Math.abs(a - b) <= tolerance;
  const direction = (from: number, to: number): Movement =>
    to > from ? 'increasing' : 'decreasing';

  const settle = () => {
    clearTimeout(settleTimer);
    pendingTarget = undefined;
    update({ target: state.current, movement: 'stopped' });
  };

  const settleAfter = (delay: number) => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, delay);
  };

  const arrive = (target: number) => {
    clearTimeout(settleTimer);
    pendingTarget = undefined;
    // Flexom often stops slightly off target (e.g. 1% when closed)
    update({ current: target, target, movement: 'stopped' });
  };

  /** HomeKit asks for a new position; Flexom changes course right away */
  const setTarget = (target: number) => {
    sendTarget(target);
    if (!hasPositionEvents) {
      untrackedCommandAt = Date.now();
      arrive(target);
      return;
    }
    if (isClose(state.current, target)) {
      arrive(target);
      return;
    }
    pendingTarget = target;
    update({ target, movement: direction(state.current, target) });
    settleAfter(START_TIMEOUT);
  };

  /**
   * Flexom reports a position: `event` while the shutter moves (WebSocket),
   * `refresh` when periodically polled from the API.
   */
  const reportPosition = (position: number, source: 'event' | 'refresh') => {
    if (Date.now() - untrackedCommandAt < UNTRACKED_MOVE_DELAY) {
      return; // possibly still on its way to the commanded target
    }
    if (pendingTarget !== undefined) {
      if (isClose(position, pendingTarget)) {
        arrive(pendingTarget);
        return;
      }
      update({
        current: position,
        movement: direction(position, pendingTarget),
      });
      if (source === 'event') settleAfter(SETTLE_DELAY);
      return;
    }

    // Not moving towards a HomeKit target: wall switch, Flexom app, refresh
    if (state.movement === 'stopped' && isClose(position, state.current)) {
      return; // jitter, or the small offset hidden by arrive()
    }
    if (source === 'event') {
      update({
        current: position,
        target: position,
        movement: direction(state.current, position),
      });
      settleAfter(SETTLE_DELAY);
    } else {
      update({ current: position, target: position });
    }
  };

  return {
    getState: () => state,
    isMoving: () => state.movement !== 'stopped',
    setTarget,
    reportPosition,
  };
}
