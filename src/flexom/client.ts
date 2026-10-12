import { createBackoff } from './backoff';
import { createHemisService, type HemisService } from './hemis';
import { FlexomHttpError } from './http';
import type {
  Building,
  EventListener,
  EventType,
  HemisEvent,
  Logger,
  UbiantUser,
} from './types';
import { createUbiantService } from './ubiant';
import { createWsClient } from './ws';

const LOGIN_RETRY_DELAY = 5_000; /* ms */
const MAX_LOGIN_RETRY_DELAY = 5 * 60_000; /* ms */

type Session = {
  building: Building;
  hemis: HemisService;
  hemisToken: string;
};

function isAuthError(err: unknown) {
  return (
    err instanceof FlexomHttpError && (err.status === 401 || err.status === 403)
  );
}

export function isInvalidCredentialsError(err: unknown) {
  return (
    err instanceof FlexomHttpError &&
    err.status === 401 &&
    err.path === '/users/signin'
  );
}

export type FlexomClient = ReturnType<typeof createClient>;

export function createClient({
  email,
  password,
  webSocket = true,
  logger,
}: {
  email: string;
  password: string;
  /** Whether to receive events; when false, subscribing does nothing */
  webSocket?: boolean;
  logger: Logger;
}) {
  const ubiant = createUbiantService();
  const loginBackoff = createBackoff({
    initialDelay: LOGIN_RETRY_DELAY,
    maxDelay: MAX_LOGIN_RETRY_DELAY,
  });
  const listeners = new Map<string, EventListener>();

  let ubiantUser: UbiantUser | undefined;
  let building: Building | undefined;
  let hemis: HemisService | undefined;
  let session: Session | undefined;
  let pendingLogin: Promise<Session> | undefined;
  let loginBlockedUntil = 0;
  let lastLoginError: unknown;
  let wsClient: ReturnType<typeof createWsClient> | undefined;

  const login = async (): Promise<Session> => {
    if (!ubiantUser || !ubiant.isTokenValid()) {
      ubiantUser = await ubiant.login({ email, password });
    }
    if (!building) {
      // TODO: handle multiple buildings
      [building] = await ubiant.getBuildings();
      if (!building) throw new Error('No Flexom building found');
    }
    hemis ??= createHemisService({
      baseUrl: building.hemis_base_url,
      userId: ubiantUser.id,
    });
    const hemisToken = await hemis.login({
      email: ubiantUser.email,
      token: building.authorizationToken,
      kernelId: building.kernel_slot,
    });
    return { building, hemis, hemisToken };
  };

  /** Logs in to Ubiant and Hemis as needed, one attempt at a time */
  const getSession = (): Promise<Session> => {
    if (session && ubiant.isTokenValid()) return Promise.resolve(session);
    pendingLogin ??= (async () => {
      if (Date.now() < loginBlockedUntil) throw lastLoginError;
      session = undefined;
      try {
        session = await login();
        loginBackoff.reset();
        return session;
      } catch (err: unknown) {
        // Start from scratch next time, whichever step failed
        ubiant.reset();
        lastLoginError = err;
        const delay = loginBackoff.next();
        loginBlockedUntil = Date.now() + delay;
        logger.debug(
          `Flexom login failed, next attempt in ${delay / 1000}s: ${String(err)}`,
        );
        throw err;
      }
    })().finally(() => {
      pendingLogin = undefined;
    });
    return pendingLogin;
  };

  const invalidateSession = (expired: Session) => {
    if (session === expired) session = undefined;
  };

  function withSession<Args extends unknown[], R>(
    fn: (hemis: HemisService, ...args: Args) => Promise<R>,
  ): (...args: Args) => Promise<R> {
    return async (...args) => {
      const current = await getSession();
      try {
        return await fn(current.hemis, ...args);
      } catch (err: unknown) {
        if (!isAuthError(err)) throw err;
        logger.debug('Hemis session rejected, logging in again');
        invalidateSession(current);
        return fn((await getSession()).hemis, ...args);
      }
    };
  }

  /** Whether a listener wants this event type (all of them, if unfiltered) */
  const isWanted = (type: EventType) =>
    [...listeners.values()].some(
      ({ events }) => !events?.length || events.includes(type),
    );

  const dispatch = (event: HemisEvent) => {
    for (const { id, events, zoneId, listener } of listeners.values()) {
      if (events?.length && !events.includes(event.type)) continue;
      if (zoneId && zoneId !== event.zoneId) continue;
      try {
        listener(event);
      } catch (err: unknown) {
        logger.error(`Event listener ${id} failed: ${String(err)}`);
      }
    }
  };

  const notifyReconnect = () => {
    for (const { id, onReconnect } of listeners.values()) {
      try {
        onReconnect?.();
      } catch (err: unknown) {
        logger.error(`Reconnect listener ${id} failed: ${String(err)}`);
      }
    }
  };

  const connectWebSocket = async () => {
    const { building: connectedBuilding } = await getSession();
    return createWsClient({
      wsUrl: connectedBuilding.hemis_stomp_url,
      buildingId: connectedBuilding.buildingId,
      getToken: async () => (await getSession()).hemisToken,
      isWanted,
      onEvent: dispatch,
      onConnect: ({ isReconnect }) => {
        if (isReconnect) notifyReconnect();
      },
      onStompError: () => {
        if (session) invalidateSession(session);
      },
      logger,
    });
  };

  const subscribe = async (listener: EventListener) => {
    if (!webSocket) return;
    listeners.set(listener.id, listener);
    wsClient ??= connectWebSocket().catch((err: unknown) => {
      wsClient = undefined;
      throw err;
    });
    await wsClient;
  };

  const unsubscribe = ({ id }: Pick<EventListener, 'id'>) => {
    listeners.delete(id);
  };

  const disconnect = async () => {
    const client = wsClient;
    wsClient = undefined;
    listeners.clear();
    await (await client?.catch(() => undefined))?.disconnect();
  };

  return {
    getZones: withSession((h) => h.getZones()),
    getZoneSettings: withSession(
      (h, zone: Parameters<HemisService['getZoneSettings']>[0]) =>
        h.getZoneSettings(zone),
    ),
    setZoneFactor: withSession(
      (h, params: Parameters<HemisService['setZoneFactor']>[0]) =>
        h.setZoneFactor(params),
    ),
    getFactorActuators: withSession(
      (h, params: Parameters<HemisService['getFactorActuators']>[0]) =>
        h.getFactorActuators(params),
    ),
    setActuatorState: withSession(
      (h, params: Parameters<HemisService['setActuatorState']>[0]) =>
        h.setActuatorState(params),
    ),
    getSensors: withSession(
      (h, params?: Parameters<HemisService['getSensors']>[0]) =>
        h.getSensors(params),
    ),
    getThing: withSession(
      (h, params: Parameters<HemisService['getThing']>[0]) =>
        h.getThing(params),
    ),
    subscribe,
    unsubscribe,
    disconnect,
  };
}
