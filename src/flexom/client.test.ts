import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HemisEvent } from './types';

type StompConfig = {
  brokerURL: string;
  connectHeaders: Record<string, string>;
  beforeConnect: (client: unknown) => Promise<void>;
  onConnect: (frame: { headers: Record<string, string> }) => void;
  onWebSocketClose: (event: { code: number }) => void;
  onStompError: (frame: {
    headers: Record<string, string>;
    body: string;
  }) => void;
};

type FakeStompClient = {
  config: StompConfig;
  connections: Array<Record<string, string>>;
  deliver: (event: unknown) => void;
  reconnect: () => Promise<void>;
  stompError: () => void;
};

const stomp = vi.hoisted(() => ({ instances: [] as FakeStompClient[] }));

vi.mock('@stomp/stompjs', () => ({
  ReconnectionTimeMode: { LINEAR: 0, EXPONENTIAL: 1 },
  Client: class {
    config: StompConfig;

    connectHeaders: Record<string, string>;

    connections: Array<Record<string, string>> = [];

    handlers: Array<(message: { body: string }) => void> = [];

    constructor(config: StompConfig) {
      this.config = config;
      this.connectHeaders = config.connectHeaders;
      stomp.instances.push(this);
    }

    async connect() {
      await this.config.beforeConnect(this);
      this.connections.push({ ...this.connectHeaders });
      this.config.onConnect({ headers: {} });
    }

    activate() {
      void this.connect();
    }

    async reconnect() {
      this.config.onWebSocketClose({ code: 1006 });
      await this.connect();
    }

    stompError() {
      this.config.onStompError({ headers: {}, body: '' });
    }

    deactivate() {
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

// Imported after the mock is declared (vi.mock is hoisted anyway)
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

const ROUTES = {
  signin: 'POST /users/signin',
  buildings: 'GET /buildings/mine/infos',
  hemisLogin: 'POST /api/WS_UserManagement/login',
  zones: 'GET /api/WS_ZoneManagement/list',
};

type Call = {
  route: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
};

/** Fake Flexom API; set `failures[route]` to a status code to fail a route */
function mockFlexomApi({
  ubiantTokenTtl = 60 * 60 * 1000,
}: { ubiantTokenTtl?: number } = {}) {
  const calls: Call[] = [];
  const failures: Partial<Record<string, number>> = {};
  let hemisLogins = 0;
  const json = (data: unknown) => new Response(JSON.stringify(data));

  const respond = (route: string) => {
    const failure = failures[route];
    if (failure) return new Response('', { status: failure });
    switch (route) {
      case ROUTES.signin:
        return json({
          id: 'user-1',
          email: 'me@example.com',
          token: makeJwt(ubiantTokenTtl),
        });
      case ROUTES.buildings:
        return json([building]);
      case ROUTES.hemisLogin:
        hemisLogins += 1;
        return json({ token: `hemis-token-${hemisLogins}` });
      case ROUTES.zones:
        return json([
          { id: 'MyHemis', name: 'MyHemis' },
          { id: 'zone-1', name: 'Kitchen' },
        ]);
      case 'PUT /api/WS_ReactiveEnvironmentDataManagement/zone-1/settings/BRIEXT/value':
        return new Response('');
      default:
        return new Response('not found', { status: 404 });
    }
  };

  vi.stubGlobal(
    'fetch',
    vi.fn((url: URL, init: RequestInit) => {
      const route = `${init.method ?? 'GET'} ${url.pathname}`;
      calls.push({
        route,
        url: url.toString(),
        headers: init.headers as Record<string, string>,
        body: init.body as string | undefined,
      });
      return Promise.resolve(respond(route));
    }),
  );
  return {
    calls,
    failures,
    routes: () => calls.map(({ route }) => route),
  };
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

  it('logs in to Ubiant then Hemis on first use', async () => {
    const api = mockFlexomApi();
    const flexom = createClient(credentials);
    expect(api.calls).toEqual([]);

    await flexom.getZones();
    expect(api.calls.map(({ url }) => url)).toEqual([
      'https://hemisphere.ubiant.com/users/signin',
      'https://hemisphere.ubiant.com/buildings/mine/infos',
      'https://hemis.example/api/WS_UserManagement/login',
      'https://hemis.example/api/WS_ZoneManagement/list',
    ]);
    expect(JSON.parse(api.calls[0].body!)).toEqual({
      email: 'me@example.com',
      password: 'secret',
    });
    expect(api.calls[1].headers.Authorization).toMatch(/^Bearer header\./);
    expect(api.calls[2].headers).toMatchObject({
      'X-Logged-User': 'user-1',
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(api.calls[2].body).toBe(
      'email=me%40example.com&password=building-auth-token&kernelId=kernel-1',
    );
  });

  it('lists zones with the Hemis token and renames the master zone', async () => {
    const api = mockFlexomApi();
    const flexom = createClient(credentials);

    await expect(flexom.getZones()).resolves.toEqual([
      { id: 'MyHemis', name: 'Ma Maison' },
      { id: 'zone-1', name: 'Kitchen' },
    ]);
    expect(api.calls.at(-1)?.headers.Authorization).toBe(
      'Bearer hemis-token-1',
    );
  });

  it('sets a zone factor with a form-encoded PUT', async () => {
    const api = mockFlexomApi();
    const flexom = createClient(credentials);

    await flexom.setZoneFactor({ id: 'zone-1', factor: 'BRIEXT', value: 0.5 });
    expect(api.calls.at(-1)).toMatchObject({
      route:
        'PUT /api/WS_ReactiveEnvironmentDataManagement/zone-1/settings/BRIEXT/value',
      body: 'value=0.5',
    });
  });

  it('rejects with the HTTP status on API errors', async () => {
    const api = mockFlexomApi();
    api.failures[ROUTES.signin] = 401;

    const error = await createClient(credentials)
      .getZones()
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(FlexomHttpError);
    expect(error).toMatchObject({ status: 401, path: '/users/signin' });
  });

  it('shares a single login between concurrent calls', async () => {
    const api = mockFlexomApi();
    const flexom = createClient(credentials);

    await Promise.all([
      flexom.getZones(),
      flexom.getZones(),
      flexom.setZoneFactor({ id: 'zone-1', factor: 'BRIEXT', value: 1 }),
    ]);
    expect(api.routes().filter((r) => r === ROUTES.signin)).toHaveLength(1);
    expect(api.routes().filter((r) => r === ROUTES.hemisLogin)).toHaveLength(1);
  });

  it('recovers when the Hemis login fails after the Ubiant login succeeded', async () => {
    vi.useFakeTimers();
    const api = mockFlexomApi();
    const flexom = createClient(credentials);
    api.failures[ROUTES.hemisLogin] = 503;

    await expect(flexom.getZones()).rejects.toMatchObject({ status: 503 });

    delete api.failures[ROUTES.hemisLogin];
    api.calls.length = 0;
    await vi.advanceTimersByTimeAsync(5000);
    await expect(flexom.getZones()).resolves.toHaveLength(2);
    expect(api.routes()).toEqual([
      ROUTES.signin,
      ROUTES.hemisLogin,
      ROUTES.zones,
    ]);
  });

  it('backs off between login attempts while the auth API is down', async () => {
    vi.useFakeTimers();
    const api = mockFlexomApi();
    const flexom = createClient(credentials);
    api.failures[ROUTES.signin] = 502;

    await expect(flexom.getZones()).rejects.toMatchObject({ status: 502 });
    // Within the backoff delay: fail fast without calling the API
    api.calls.length = 0;
    await expect(flexom.getZones()).rejects.toMatchObject({ status: 502 });
    expect(api.calls).toEqual([]);

    // After the delay: try again, and back off longer (5s, then 10s)
    await vi.advanceTimersByTimeAsync(5000);
    await expect(flexom.getZones()).rejects.toMatchObject({ status: 502 });
    expect(api.routes()).toEqual([ROUTES.signin]);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(flexom.getZones()).rejects.toMatchObject({ status: 502 });
    expect(api.routes()).toEqual([ROUTES.signin]);

    delete api.failures[ROUTES.signin];
    await vi.advanceTimersByTimeAsync(5000);
    await expect(flexom.getZones()).resolves.toHaveLength(2);
  });

  it('logs in again when the Ubiant token is about to expire', async () => {
    const api = mockFlexomApi({ ubiantTokenTtl: 10 * 60 * 1000 });
    const flexom = createClient(credentials);
    await flexom.getZones();
    api.calls.length = 0;

    await flexom.getZones();
    expect(api.routes()).toEqual([
      ROUTES.signin,
      ROUTES.hemisLogin,
      ROUTES.zones,
    ]);
    expect(api.calls.at(-1)?.headers.Authorization).toBe(
      'Bearer hemis-token-2',
    );
  });

  it('logs in to Hemis again and retries when Hemis rejects the token', async () => {
    const api = mockFlexomApi();
    const flexom = createClient(credentials);
    await flexom.getZones();
    api.calls.length = 0;

    let rejected = false;
    vi.mocked(fetch).mockImplementationOnce(() => {
      rejected = true;
      return Promise.resolve(new Response('', { status: 401 }));
    });

    await expect(flexom.getZones()).resolves.toHaveLength(2);
    expect(rejected).toBe(true);
    expect(api.routes()).toEqual([ROUTES.hemisLogin, ROUTES.zones]);
    expect(api.calls.at(-1)?.headers.Authorization).toBe(
      'Bearer hemis-token-2',
    );
  });

  describe('WebSocket', () => {
    const subscribe = async (flexom: ReturnType<typeof createClient>) => {
      const received: HemisEvent[] = [];
      const onReconnect = vi.fn();
      await flexom.subscribe({
        id: 'test',
        events: ['ACTUATOR_HARDWARE_STATE'],
        zoneId: 'zone-1',
        listener: (event) => received.push(event),
        onReconnect,
      });
      await vi.waitFor(() =>
        expect(stomp.instances[0]?.connections).toHaveLength(1),
      );
      return { received, onReconnect, ws: stomp.instances[0] };
    };

    it('connects with the building id and Hemis token', async () => {
      mockFlexomApi();
      const { ws } = await subscribe(createClient(credentials));

      expect(ws.config.brokerURL).toBe('wss://hemis.example/stomp');
      expect(ws.connections).toEqual([
        { login: 'building-1', passcode: 'hemis-token-1' },
      ]);
    });

    it('delivers matching events to subscribers', async () => {
      mockFlexomApi();
      const { ws, received } = await subscribe(createClient(credentials));

      const event = {
        type: 'ACTUATOR_HARDWARE_STATE',
        zoneId: 'zone-1',
        factorId: 'BRIEXT',
        value: { value: 0.4 },
      };
      ws.deliver(event);
      ws.deliver({ ...event, zoneId: 'zone-2' });
      ws.deliver({ ...event, type: 'SENSOR_STATE' });

      expect(received).toEqual([event]);
    });

    it('notifies subscribers on reconnect, not on first connect', async () => {
      mockFlexomApi();
      const { ws, onReconnect } = await subscribe(createClient(credentials));
      expect(onReconnect).not.toHaveBeenCalled();

      await ws.reconnect();
      expect(onReconnect).toHaveBeenCalledTimes(1);
    });

    it('logs in again before reconnecting after a broker error', async () => {
      mockFlexomApi();
      const { ws } = await subscribe(createClient(credentials));

      ws.stompError();
      await ws.reconnect();
      expect(ws.connections.map(({ passcode }) => passcode)).toEqual([
        'hemis-token-1',
        'hemis-token-2',
      ]);
    });

    it('keeps reconnecting when the token cannot be refreshed', async () => {
      const api = mockFlexomApi();
      const { ws } = await subscribe(createClient(credentials));

      ws.stompError();
      api.failures[ROUTES.hemisLogin] = 503;
      await expect(ws.reconnect()).resolves.toBeUndefined();
      expect(ws.connections).toHaveLength(2);
    });
  });
});
