import type { Logger } from 'homebridge';
import { describe, expect, it } from 'vitest';
import { loggerAdapter, toLogJson } from './utils';

describe('utils', () => {
  describe('loggerAdapter', () => {
    const makeLogger = () => {
      const calls: unknown[][] = [];
      const log = (...args: unknown[]) => {
        calls.push(args);
      };
      return { logger: { info: log } as unknown as Logger, calls };
    };

    it('only message', () => {
      const { logger, calls } = makeLogger();
      loggerAdapter({ logger }).info('test');
      expect(calls).toEqual([['test']]);
    });

    it('args and message', () => {
      const { logger, calls } = makeLogger();
      loggerAdapter({ logger }).info({ a: 1 }, 'test');
      expect(calls).toEqual([['test {"a":1}']]);
    });

    it('empty args and message', () => {
      const { logger, calls } = makeLogger();
      loggerAdapter({ logger }).info({}, 'test');
      expect(calls).toEqual([['test {}']]);
    });

    it('args and no message', () => {
      const { logger, calls } = makeLogger();
      loggerAdapter({ logger }).info({ a: 1 });
      expect(calls).toEqual([['{"a":1}']]);
    });
  });
});

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
    const err = Object.assign(new Error('nope'), {
      response: { status: 503 },
    });
    expect(toLogJson(err)).toBe(
      '{"name":"Error","message":"nope","status":503}',
    );
  });
});
