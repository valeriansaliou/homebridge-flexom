import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlexomHttpError } from './flexom';
import { debounce, formatDuration, toLogJson } from './utils';

describe('toLogJson', () => {
  it('serializes errors, including nested ones', () => {
    const err = Object.assign(new Error('boom'), { code: 'ECONNRESET' });
    expect(toLogJson(err)).toBe(
      '{"name":"Error","message":"boom","code":"ECONNRESET"}',
    );
    expect(toLogJson({ err })).toBe(
      '{"err":{"name":"Error","message":"boom","code":"ECONNRESET"}}',
    );
  });

  it('includes the HTTP status of request errors', () => {
    const err = new FlexomHttpError({
      method: 'GET',
      path: '/zones',
      status: 503,
    });
    expect(toLogJson(err)).toBe(
      '{"name":"FlexomHttpError","message":"GET /zones failed with HTTP 503","status":503}',
    );
  });
});

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls once with the last arguments after calls stop', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced(1);
    vi.advanceTimersByTime(200);
    debounced(2);
    vi.advanceTimersByTime(299);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledExactlyOnceWith(2);
  });
});

describe('formatDuration', () => {
  it('formats seconds and minutes', () => {
    expect(formatDuration(10_000)).toBe('10s');
    expect(formatDuration(15 * 60_000)).toBe('15 min');
    expect(formatDuration(80_000)).toBe('1 min 20s');
  });
});
