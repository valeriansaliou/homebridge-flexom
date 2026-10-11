import type { Logger } from 'homebridge';

export function createChildLogger({
  parentLogger,
  prefix,
}: {
  parentLogger: Logger;
  prefix: string;
}): Logger {
  // Homebridge log methods print `this.prefix`: copy them with a new prefix
  return Object.assign({}, parentLogger, {
    prefix: [parentLogger.prefix, prefix].filter(Boolean).join(':'),
  });
}

/** Calls `fn` once calls stopped for `delay` ms, with the last arguments */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delay: number,
): (...args: Args) => void {
  let timeout: NodeJS.Timeout | undefined;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}

export function formatDuration(ms: number) {
  return ms >= 60_000 ? `${ms / 60_000} min` : `${ms / 1000}s`;
}

function serializeError(err: Error & { code?: unknown; status?: unknown }) {
  return Object.fromEntries(
    Object.entries({
      name: err.name,
      message: err.message,
      code: err.code,
      status: err.status,
      cause: err.cause,
    }).filter(([, value]) => value !== undefined),
  );
}

export function toLogJson(value: unknown) {
  return JSON.stringify(value, (_key, v: unknown) =>
    v instanceof Error ? serializeError(v) : v,
  );
}
