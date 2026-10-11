import type { Logger } from 'homebridge';
import { toLogJson } from './utils';

export type RefreshTask = {
  name: string;
  refresh: () => Promise<void>;
};

/**
 * Refreshes each task once per interval, one at a time and evenly spread,
 * so the API sees a steady trickle of requests rather than bursts. A tick is
 * skipped while the previous refresh is still running, so a slow API never
 * gets requests piling up.
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
  let isRefreshing = false;
  const timer = setInterval(() => {
    if (isRefreshing) return;
    const task = tasks[next];
    next = (next + 1) % tasks.length;
    isRefreshing = true;
    task
      .refresh()
      .catch((err: unknown) => {
        logger.debug(`Failed to refresh ${task.name}: ${toLogJson(err)}`);
      })
      .finally(() => {
        isRefreshing = false;
      });
  }, interval / tasks.length);

  return () => clearInterval(timer);
}
