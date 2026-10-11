import { createHttpClient } from './http';
import type { Building, UbiantUser } from './types';

const UBIANT_BASE_URL = 'https://hemisphere.ubiant.com';
const TOKEN_RENEWAL_MARGIN = 20 * 60 * 1000; /* ms */

function getTokenExpiry(token: string): number | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString(),
    ) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export function createUbiantService() {
  let token: string | undefined;

  const request = createHttpClient({
    baseUrl: UBIANT_BASE_URL,
    encoding: 'json',
    getHeaders: (): Record<string, string> =>
      token ? { Authorization: `Bearer ${token}` } : {},
  });

  const login = async ({
    email,
    password,
  }: {
    email: string;
    password: string;
  }) => {
    const user = await request<UbiantUser>({
      method: 'POST',
      path: '/users/signin',
      body: { email, password },
    });
    token = user.token;
    return user;
  };

  const getBuildings = () =>
    request<Building[]>({ path: '/buildings/mine/infos' });

  const isTokenValid = () => {
    const expiry = token && getTokenExpiry(token);
    return !!expiry && Date.now() + TOKEN_RENEWAL_MARGIN < expiry;
  };

  const reset = () => {
    token = undefined;
  };

  return { login, getBuildings, isTokenValid, reset };
}
