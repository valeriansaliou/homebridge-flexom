import type { Logger } from 'homebridge';
import { createBackoff, isInvalidCredentialsError } from './flexom';
import { formatDuration, toLogJson } from './utils';

const RETRY_DELAY = 10_000; /* ms */
const MAX_RETRY_DELAY = 5 * 60_000; /* ms */
// Retrying a wrong password too often could get the account locked
const INVALID_CREDENTIALS_RETRY_DELAY = 30 * 60_000; /* ms */

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason as Error);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Runs `fn` until it succeeds, or until `signal` is aborted (then rejects) */
export async function retryUntilSuccess<T>(
  fn: () => Promise<T>,
  {
    description,
    logger,
    signal,
  }: { description: string; logger: Logger; signal: AbortSignal },
): Promise<T> {
  const backoff = createBackoff({
    initialDelay: RETRY_DELAY,
    maxDelay: MAX_RETRY_DELAY,
  });
  for (;;) {
    signal.throwIfAborted();
    try {
      return await fn();
    } catch (err: unknown) {
      if (isInvalidCredentialsError(err)) {
        logger.error(
          `Flexom rejected the email or password, retrying in ${formatDuration(INVALID_CREDENTIALS_RETRY_DELAY)}`,
        );
        await sleep(INVALID_CREDENTIALS_RETRY_DELAY, signal);
      } else {
        const delay = backoff.next();
        logger.warn(
          `Failed to ${description}, retrying in ${formatDuration(delay)}: ${toLogJson(err)}`,
        );
        await sleep(delay, signal);
      }
    }
  }
}
