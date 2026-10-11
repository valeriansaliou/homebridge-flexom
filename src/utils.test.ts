import { describe, expect, it } from 'vitest';
import { FlexomHttpError } from './flexom';
import { toLogJson } from './utils';

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
