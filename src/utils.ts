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
      status: _.get(err, 'status'),
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
