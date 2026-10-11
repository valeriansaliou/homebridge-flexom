import { createHttpClient } from './http';
import {
  MASTER_ZONE_ID,
  type Actuator,
  type Factor,
  type HemisUser,
  type Zone,
  type ZoneSettings,
} from './types';

export type HemisService = ReturnType<typeof createHemisService>;

export function createHemisService({
  baseUrl,
  userId,
}: {
  baseUrl: string;
  userId: string;
}) {
  let token: string | undefined;

  const request = createHttpClient({
    baseUrl,
    encoding: 'form',
    getHeaders: () => ({
      'X-Logged-User': userId,
      ...(token && { Authorization: `Bearer ${token}` }),
    }),
  });

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
    return user.token;
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

  /** Actuators acting on a zone factor, with their actual state */
  const getFactorActuators = ({
    zoneId,
    factor,
  }: {
    zoneId: string;
    factor: Factor;
  }) =>
    request<Actuator[]>({
      path: `/WS_ReactiveEnvironmentDataManagement/${zoneId}/${factor}/actuators`,
    });

  /** Drives a single actuator, e.g. one blind's position or slats */
  const setActuatorState = async ({
    itId,
    actuatorId,
    value,
  }: {
    itId: string;
    actuatorId: string;
    value: number;
  }) => {
    await request<unknown>({
      method: 'PUT',
      path: `/intelligent-things/${encodeURIComponent(itId)}/actuator/${encodeURIComponent(actuatorId)}/state`,
      body: { value },
      encoding: 'json',
    });
  };

  return {
    login,
    getZones,
    getZoneSettings,
    setZoneFactor,
    getFactorActuators,
    setActuatorState,
  };
}
