import type { Logger } from 'homebridge';
import { toLogJson } from './utils';

export type RefreshTask = {
  name: string;
  refresh: () => Promise<void>;
};

/**
 * Refreshes each task once per interval, one at a time and evenly spread,
 * so the API sees a steady trickle of requests rather than bursts.
 */
export function startPeriodicRefresh({
  tasks,
  interval,
  logger,
}: {
  tasks: RefreshTask[];
  interval: number;
  logger: Logger;
}) {
  if (interval <= 0 || tasks.length === 0) return () => {};

  let next = 0;
  const timer = setInterval(() => {
    const task = tasks[next];
    next = (next + 1) % tasks.length;
    task.refresh().catch((err: unknown) => {
      logger.debug(`Failed to refresh ${task.name}: ${toLogJson(err)}`);
    });
  }, interval / tasks.length);

  return () => clearInterval(timer);
}
