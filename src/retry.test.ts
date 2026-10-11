import type { Logger } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlexomHttpError } from './flexom';
import { retryUntilSuccess } from './retry';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const httpError = (status: number, path = '/zones') =>
  new FlexomHttpError({ method: 'GET', path, status });

describe('retryUntilSuccess', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries with an increasing delay until success', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValue('ok');
    const result = retryUntilSuccess(fn, {
      description: 'test',
      logger,
      signal: new AbortController().signal,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('ok');
  });

  it('waits 30 minutes when the credentials are rejected', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(401, '/users/signin'))
      .mockResolvedValue('ok');
    const result = retryUntilSuccess(fn, {
      description: 'test',
      logger,
      signal: new AbortController().signal,
    });

    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toBe('ok');
  });

  it('stops retrying on shutdown', async () => {
    const shutdown = new AbortController();
    const fn = vi.fn(() => Promise.reject(httpError(503)));
    const result = retryUntilSuccess(fn, {
      description: 'test',
      logger,
      signal: shutdown.signal,
    });
    const rejection = expect(result).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(1);
    shutdown.abort();
    await rejection;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
