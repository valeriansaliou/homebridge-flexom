import { createHttpClient } from './http';
import {
  MASTER_ZONE_ID,
  type EventListener,
  type Factor,
  type HemisUser,
  type Logger,
  type Zone,
  type ZoneSettings,
} from './types';
import { createWsClient } from './ws';

export function createHemisService({
  baseUrl,
  wsUrl,
  userId,
  buildingId,
  logger,
}: {
  baseUrl: string;
  wsUrl: string;
  userId: string;
  buildingId: string;
  logger: Logger;
}) {
  let token: string | undefined;
  let wsClient: ReturnType<typeof createWsClient> | undefined;

  const request = createHttpClient({
    baseUrl,
    encoding: 'form',
    getHeaders: () => ({
      'X-Logged-User': userId,
      ...(token && { Authorization: `Bearer ${token}` }),
    }),
  });

  const getWsClient = () => {
    if (!token) throw new Error('Not logged in to Hemis');
    wsClient ??= createWsClient({ wsUrl, buildingId, token, logger });
    return wsClient;
  };

  const login = async ({
    email,
    token: password,
    kernelId,
  }: {
    email: string;
    token: string;
    kernelId: string;
  }) => {
    const user = await request<HemisUser>({
      method: 'POST',
      path: '/WS_UserManagement/login',
      body: { email, password, kernelId },
    });
    token = user.token;
    (await getWsClient()).updateToken(token);
    return user;
  };

  const logout = async () => {
    token = undefined;
    const client = wsClient;
    wsClient = undefined;
    await (await client)?.disconnect();
  };

  const getZones = async () => {
    const zones = await request<Zone[]>({ path: '/WS_ZoneManagement/list' });
    return zones.map((zone) =>
      zone.id === MASTER_ZONE_ID ? { ...zone, name: 'Ma Maison' } : zone,
    );
  };

  const getZoneSettings = ({ id }: Pick<Zone, 'id'>) =>
    request<ZoneSettings>({
      path: `/WS_ReactiveEnvironmentDataManagement/${id}/settings`,
    });

  const setZoneFactor = async ({
    id,
    factor,
    value,
  }: {
    id: string;
    factor: Factor;
    value: number;
  }) => {
    await request<unknown>({
      method: 'PUT',
      path: `/WS_ReactiveEnvironmentDataManagement/${id}/settings/${factor}/value`,
      body: { value },
    });
  };

  const subscribe = async (listener: EventListener) => {
    (await getWsClient()).addListener(listener);
  };

  const unsubscribe = async (listener: Pick<EventListener, 'id'>) => {
    (await wsClient)?.removeListener(listener);
  };

  return {
    login,
    logout,
    getZones,
    getZoneSettings,
    setZoneFactor,
    subscribe,
    unsubscribe,
  };
}
