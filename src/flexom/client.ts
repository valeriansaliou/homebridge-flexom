import { setTimeout as sleep } from 'node:timers/promises';
import { createHemisService } from './hemis';
import { FlexomHttpError } from './http';
import type { Logger } from './types';
import { createUbiantService } from './ubiant';

const MAX_RATE_LIMIT_RETRIES = 10;

async function retryOnRateLimit<T>(
  fn: () => Promise<T>,
  logger: Logger,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err: unknown) {
      const isRateLimited =
        err instanceof FlexomHttpError && err.status === 429;
      if (!isRateLimited || attempt >= MAX_RATE_LIMIT_RETRIES) throw err;
      logger.warn('Too many login requests, waiting to retry...');
      await sleep(Math.min(1000 * 2 ** attempt, 60_000));
    }
  }
}

export type FlexomClient = Awaited<ReturnType<typeof createClient>>;

export async function createClient({
  email,
  password,
  logger,
}: {
  email: string;
  password: string;
  logger: Logger;
}) {
  const ubiant = createUbiantService();
  let ubiantUser = await retryOnRateLimit(
    () => ubiant.login({ email, password }),
    logger,
  );

  // TODO: handle multiple buildings
  const [building] = await ubiant.getBuildings();
  if (!building) {
    throw new Error('No Flexom building found');
  }

  const hemis = createHemisService({
    baseUrl: building.hemis_base_url,
    wsUrl: building.hemis_stomp_url,
    userId: ubiantUser.id,
    buildingId: building.buildingId,
    logger,
  });
  const hemisLogin = () =>
    retryOnRateLimit(
      () =>
        hemis.login({
          email: ubiantUser.email,
          token: building.authorizationToken,
          kernelId: building.kernel_slot,
        }),
      logger,
    );
  await hemisLogin();

  function withAuth<Args extends unknown[], R>(
    fn: (...args: Args) => R | Promise<R>,
  ): (...args: Args) => Promise<R> {
    return async (...args) => {
      if (!ubiant.isTokenValid()) {
        ubiantUser = await retryOnRateLimit(
          () => ubiant.login({ email, password }),
          logger,
        );
        await hemisLogin();
      }
      return fn(...args);
    };
  }

  return {
    getZones: withAuth(hemis.getZones),
    getZoneSettings: withAuth(hemis.getZoneSettings),
    setZoneFactor: withAuth(hemis.setZoneFactor),
    subscribe: withAuth(hemis.subscribe),
    unsubscribe: hemis.unsubscribe,
    disconnect: hemis.logout,
  };
}
