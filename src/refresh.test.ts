import type { Logger } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPeriodicRefresh } from './refresh';

const logger = { debug: vi.fn() } as unknown as Logger;

describe('startPeriodicRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const makeTasks = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      name: `zone ${i}`,
      refresh: vi.fn(() => Promise.resolve()),
    }));

  it('refreshes each task once per interval, evenly spread', async () => {
    const tasks = makeTasks(4);
    startPeriodicRefresh({ tasks, interval: 60_000, logger });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(tasks.map((t) => t.refresh.mock.calls.length)).toEqual([1, 0, 0, 0]);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(tasks.map((t) => t.refresh.mock.calls.length)).toEqual([1, 1, 1, 1]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tasks.map((t) => t.refresh.mock.calls.length)).toEqual([2, 2, 2, 2]);
  });

  it('keeps going when a refresh fails', async () => {
    const tasks = makeTasks(2);
    tasks[0].refresh.mockRejectedValue(new Error('HTTP 503'));
    startPeriodicRefresh({ tasks, interval: 10_000, logger });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(tasks.map((t) => t.refresh.mock.calls.length)).toEqual([2, 2]);
  });

  it('stops when asked', async () => {
    const tasks = makeTasks(1);
    const stop = startPeriodicRefresh({ tasks, interval: 10_000, logger });

    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tasks[0].refresh).not.toHaveBeenCalled();
  });

  it('is disabled with an interval of 0', async () => {
    const tasks = makeTasks(1);
    startPeriodicRefresh({ tasks, interval: 0, logger });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(tasks[0].refresh).not.toHaveBeenCalled();
  });
});
