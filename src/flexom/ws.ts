import type { EventListener, HemisEvent, Logger } from './types';

export async function createWsClient({
  wsUrl,
  buildingId,
  token,
  logger,
}: {
  wsUrl: string;
  buildingId: string;
  token: string;
  logger: Logger;
}) {
  // stompjs is ESM-only: it cannot be require()d from this CommonJS build
  const { Client } = await import('@stomp/stompjs');
  const listeners = new Map<string, EventListener>();

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

  const client = new Client({
    brokerURL: wsUrl,
    connectHeaders: {
      login: buildingId,
      passcode: token,
    },
    reconnectDelay: 1000,
    heartbeatIncoming: 20000,
    heartbeatOutgoing: 20000,
    onConnect: () => {
      logger.debug('WebSocket connected');
      client.subscribe(`jms.topic.${buildingId}.data`, (message) => {
        let event: HemisEvent;
        try {
          event = JSON.parse(message.body) as HemisEvent;
        } catch {
          logger.warn(`Ignoring malformed event: ${message.body}`);
          return;
        }
        logger.debug(`Event received: ${message.body}`);
        dispatch(event);
      });
    },
    onWebSocketClose: () => {
      logger.debug('WebSocket closed');
    },
    onStompError: (frame) => {
      logger.error(
        `Broker reported error: ${frame.headers.message ?? ''} ${frame.body}`,
      );
    },
  });
  client.activate();

  return {
    addListener: (listener: EventListener) => {
      listeners.set(listener.id, listener);
    },
    removeListener: ({ id }: Pick<EventListener, 'id'>) => {
      listeners.delete(id);
    },
    updateToken: (newToken: string) => {
      client.connectHeaders.passcode = newToken;
    },
    disconnect: () => client.deactivate(),
  };
}
