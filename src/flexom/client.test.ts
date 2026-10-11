import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HemisEvent } from './types';

type StompConfig = {
  brokerURL: string;
  connectHeaders: Record<string, string>;
  onConnect: () => void;
};

const stomp = vi.hoisted(() => ({
  instances: [] as Array<{
    config: StompConfig;
    connectHeaders: Record<string, string>;
    active: boolean;
    deliver: (event: unknown) => void;
  }>,
}));

vi.mock('@stomp/stompjs', () => ({
  Client: class {
    config: StompConfig;

    connectHeaders: Record<string, string>;

    active = false;

    handlers: Array<(message: { body: string }) => void> = [];

    constructor(config: StompConfig) {
      this.config = config;
      this.connectHeaders = config.connectHeaders;
      stomp.instances.push(this);
    }

    activate() {
      this.active = true;
      this.config.onConnect();
    }

    deactivate() {
      this.active = false;
      return Promise.resolve();
    }

    subscribe(_topic: string, handler: (message: { body: string }) => void) {
      this.handlers.push(handler);
    }

    deliver(event: unknown) {
      this.handlers.forEach((handler) =>
        handler({ body: JSON.stringify(event) }),
      );
    }
  },
}));

import { createClient, FlexomHttpError } from '.';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeJwt(expiresInMs: number) {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor((Date.now() + expiresInMs) / 1000) }),
  ).toString('base64url');
  return `header.${payload}.signature`;
}

const building = {
  buildingId: 'building-1',
  authorizationToken: 'building-auth-token',
  hemis_base_url: 'https://hemis.example/api/',
  hemis_stomp_url: 'wss://hemis.example/stomp',
  kernel_slot: 'kernel-1',
};

type Call = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
};

function mockFlexomApi({
  ubiantTokenTtl = 60 * 60 * 1000,
  overrides = {},
}: {
  ubiantTokenTtl?: number;
  overrides?: Record<string, () => Response | undefined>;
} = {}) {
  const calls: Call[] = [];
  let hemisLogins = 0;
  const json = (data: unknown) => new Response(JSON.stringify(data));

  vi.stubGlobal(
    'fetch',
    vi.fn((url: URL, init: RequestInit) => {
      const method = init.method ?? 'GET';
      calls.push({
        method,
        url: url.toString(),
        headers: init.headers as Record<string, string>,
        body: init.body as string | undefined,
      });
      const key = `${method} ${url.pathname}`;
      const override = overrides[key]?.();
      if (override) return Promise.resolve(override);
      switch (key) {
        case 'POST /users/signin':
          return Promise.resolve(
            json({
              id: 'user-1',
              email: 'me@example.com',
              token: makeJwt(ubiantTokenTtl),
            }),
          );
        case 'GET /buildings/mine/infos':
          return Promise.resolve(json([building]));
        case 'POST /api/WS_UserManagement/login':
          hemisLogins += 1;
          return Promise.resolve(json({ token: `hemis-token-${hemisLogins}` }));
        case 'GET /api/WS_ZoneManagement/list':
          return Promise.resolve(
            json([
              { id: 'MyHemis', name: 'MyHemis' },
              { id: 'zone-1', name: 'Kitchen' },
            ]),
          );
        case 'PUT /api/WS_ReactiveEnvironmentDataManagement/zone-1/settings/BRIEXT/value':
          return Promise.resolve(new Response(''));
        default:
          return Promise.resolve(new Response('not found', { status: 404 }));
      }
    }),
  );
  return calls;
}

const credentials = { email: 'me@example.com', password: 'secret', logger };

describe('Flexom client', () => {
  beforeEach(() => {
    stomp.instances.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('logs in to Ubiant then Hemis', async () => {
    const calls = mockFlexomApi();
    await createClient(credentials);

    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'POST https://hemisphere.ubiant.com/users/signin',
      'GET https://hemisphere.ubiant.com/buildings/mine/infos',
      'POST https://hemis.example/api/WS_UserManagement/login',
    ]);
    expect(JSON.parse(calls[0].body!)).toEqual({
      email: 'me@example.com',
      password: 'secret',
    });
    expect(calls[1].headers.Authorization).toMatch(/^Bearer header\./);
    expect(calls[2].headers).toMatchObject({
      'X-Logged-User': 'user-1',
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(calls[2].body).toBe(
      'email=me%40example.com&password=building-auth-token&kernelId=kernel-1',
    );
  });

  it('connects the WebSocket with the building id and Hemis token', async () => {
    mockFlexomApi();
    await createClient(credentials);

    expect(stomp.instances).toHaveLength(1);
    expect(stomp.instances[0].config.brokerURL).toBe(
      'wss://hemis.example/stomp',
    );
    expect(stomp.instances[0].connectHeaders).toEqual({
      login: 'building-1',
      passcode: 'hemis-token-1',
    });
  });

  it('lists zones with the Hemis token and renames the master zone', async () => {
    const calls = mockFlexomApi();
    const flexom = await createClient(credentials);

    await expect(flexom.getZones()).resolves.toEqual([
      { id: 'MyHemis', name: 'Ma Maison' },
      { id: 'zone-1', name: 'Kitchen' },
    ]);
    expect(calls.at(-1)?.headers.Authorization).toBe('Bearer hemis-token-1');
  });

  it('sets a zone factor with a form-encoded PUT', async () => {
    const calls = mockFlexomApi();
    const flexom = await createClient(credentials);

    await flexom.setZoneFactor({ id: 'zone-1', factor: 'BRIEXT', value: 0.5 });
    expect(calls.at(-1)).toMatchObject({
      method: 'PUT',
      url: 'https://hemis.example/api/WS_ReactiveEnvironmentDataManagement/zone-1/settings/BRIEXT/value',
      body: 'value=0.5',
    });
  });

  it('rejects with the HTTP status on API errors', async () => {
    mockFlexomApi({
      overrides: {
        'POST /users/signin': () => new Response('', { status: 401 }),
      },
    });

    const error = await createClient(credentials).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(FlexomHttpError);
    expect(error).toMatchObject({ status: 401 });
  });

  it('retries logins that are rate limited', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    mockFlexomApi({
      overrides: {
        'POST /users/signin': () => {
          attempts += 1;
          return attempts <= 2 ? new Response('', { status: 429 }) : undefined;
        },
      },
    });

    const client = createClient(credentials);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(client).resolves.toBeDefined();
    expect(attempts).toBe(3);
  });

  it('logs in again when the Ubiant token is about to expire', async () => {
    const calls = mockFlexomApi({ ubiantTokenTtl: 10 * 60 * 1000 });
    const flexom = await createClient(credentials);
    calls.length = 0;

    await flexom.getZones();
    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'POST https://hemisphere.ubiant.com/users/signin',
      'POST https://hemis.example/api/WS_UserManagement/login',
      'GET https://hemis.example/api/WS_ZoneManagement/list',
    ]);
    expect(calls.at(-1)?.headers.Authorization).toBe('Bearer hemis-token-2');
    expect(stomp.instances[0].connectHeaders.passcode).toBe('hemis-token-2');
  });

  it('delivers matching events to subscribers', async () => {
    mockFlexomApi();
    const flexom = await createClient(credentials);
    const received: HemisEvent[] = [];
    await flexom.subscribe({
      id: 'test',
      events: ['ACTUATOR_HARDWARE_STATE'],
      zoneId: 'zone-1',
      listener: (event) => received.push(event),
    });

    const event = {
      type: 'ACTUATOR_HARDWARE_STATE',
      zoneId: 'zone-1',
      factorId: 'BRIEXT',
      value: { value: 0.4 },
    };
    stomp.instances[0].deliver(event);
    stomp.instances[0].deliver({ ...event, zoneId: 'zone-2' });
    stomp.instances[0].deliver({ ...event, type: 'SENSOR_STATE' });

    expect(received).toEqual([event]);
  });
});
