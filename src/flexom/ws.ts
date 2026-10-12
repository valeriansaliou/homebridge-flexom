import type { EventType, HemisEvent, Logger } from './types';

const RECONNECT_DELAY = 1000; /* ms */
const MAX_RECONNECT_DELAY = 60_000; /* ms */
const CONNECTION_TIMEOUT = 15_000; /* ms */
const HEARTBEAT_INTERVAL = 20_000; /* ms */

/** Event type of a raw event, read cheaply without parsing the JSON */
export function getEventType(body: string): EventType | undefined {
  return /"type"\s*:\s*"([A-Z_]+)"/.exec(body)?.[1] as EventType | undefined;
}

export async function createWsClient({
  wsUrl,
  buildingId,
  getToken,
  isWanted,
  onEvent,
  onConnect,
  onStompError,
  logger,
}: {
  wsUrl: string;
  buildingId: string;
  getToken: () => Promise<string>;
  /** Whether anyone listens to this event type; others are dropped unparsed */
  isWanted: (type: EventType) => boolean;
  onEvent: (event: HemisEvent) => void;
  onConnect: (event: { isReconnect: boolean }) => void;
  onStompError: () => void;
  logger: Logger;
}) {
  // stompjs is ESM-only: it cannot be require()d from this CommonJS build
  const { Client, ReconnectionTimeMode } = await import('@stomp/stompjs');

  let hasConnected = false;
  let isConnected = false;
  let isStopping = false;

  const client = new Client({
    brokerURL: wsUrl,
    connectHeaders: { login: buildingId, passcode: '' },
    reconnectDelay: RECONNECT_DELAY,
    reconnectTimeMode: ReconnectionTimeMode.EXPONENTIAL,
    maxReconnectDelay: MAX_RECONNECT_DELAY,
    connectionTimeout: CONNECTION_TIMEOUT,
    heartbeatIncoming: HEARTBEAT_INTERVAL,
    heartbeatOutgoing: HEARTBEAT_INTERVAL,
    // Do not wait for a closing handshake on a dead connection
    discardWebsocketOnCommFailure: true,
    // Must never throw: stompjs would silently stop reconnecting
    beforeConnect: async (stomp) => {
      try {
        stomp.connectHeaders = {
          login: buildingId,
          passcode: await getToken(),
        };
      } catch (err: unknown) {
        logger.debug(
          `WebSocket: could not refresh token, connecting anyway: ${String(err)}`,
        );
      }
    },
    onConnect: (frame) => {
      logger.debug(
        `WebSocket heart-beat negotiated: ${frame.headers['heart-beat'] ?? 'none'}`,
      );
      client.subscribe(`jms.topic.${buildingId}.data`, (message) => {
        // Hemis floods the topic (e.g. every zone target several times a
        // second): drop what nobody listens to, without parsing or logging
        const type = getEventType(message.body);
        if (type && !isWanted(type)) return;
        let event: HemisEvent;
        try {
          event = JSON.parse(message.body) as HemisEvent;
        } catch {
          logger.warn(`Ignoring malformed event: ${message.body}`);
          return;
        }
        logger.debug(`Event received: ${message.body}`);
        onEvent(event);
      });
      logger.info(
        hasConnected ? 'WebSocket reconnected' : 'WebSocket connected',
      );
      isConnected = true;
      onConnect({ isReconnect: hasConnected });
      hasConnected = true;
    },
    onWebSocketClose: (event: { code?: number }) => {
      if (isStopping) return;
      if (isConnected) {
        logger.warn(
          `WebSocket disconnected (code ${event.code}), reconnecting`,
        );
      } else {
        logger.debug(`WebSocket connection failed (code ${event.code})`);
      }
      isConnected = false;
    },
    onStompError: (frame) => {
      logger.error(
        `WebSocket broker error: ${frame.headers.message ?? ''} ${frame.body}`,
      );
      onStompError();
    },
  });
  client.activate();

  return {
    disconnect: async () => {
      isStopping = true;
      await client.deactivate();
    },
  };
}
