import _ from 'lodash';

import type { Logger } from 'homebridge';

export function createChildLogger({
  parentLogger,
  prefix,
}: {
  parentLogger: Logger;
  prefix: string;
}) {
  return _.merge({}, parentLogger, {
    prefix: _.chain([parentLogger.prefix, prefix]).compact().join(':').value(),
  });
}

function serializeError(err: Error): Record<string, unknown> {
  return _.omitBy(
    {
      name: err.name,
      message: err.message,
      code: _.get(err, 'code'),
      status: _.get(err, 'response.status'),
      cause: err.cause,
    },
    (v) => v === undefined,
  );
}

export function toLogJson(value: unknown) {
  return JSON.stringify(value, (_key, v: unknown) =>
    v instanceof Error ? serializeError(v) : v,
  );
}

function loggerParamsAdapter(
  log: (msg: string) => void,
): (argsOrMsg: unknown, msg?: string) => void {
  return (argsOrMsg, msg) => {
    if (_.isString(argsOrMsg)) {
      log(argsOrMsg);
      return;
    }

    if (!msg) {
      log(toLogJson(argsOrMsg));
      return;
    }

    log(`${msg} ${toLogJson(argsOrMsg)}`);
  };
}

type SupportedLogLevels = 'info' | 'warn' | 'error' | 'debug';

export function loggerAdapter({ logger }: { logger: Logger }): {
  [key in SupportedLogLevels]: (argsOrMsg: unknown, msg?: string) => void;
} {
  return {
    info: loggerParamsAdapter(logger.info?.bind(logger)),
    warn: loggerParamsAdapter(logger.warn?.bind(logger)),
    error: loggerParamsAdapter(logger.error?.bind(logger)),
    debug: loggerParamsAdapter(logger.debug?.bind(logger)),
  };
}
