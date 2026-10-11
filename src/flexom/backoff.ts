export function createBackoff({
  initialDelay,
  maxDelay,
}: {
  initialDelay: number;
  maxDelay: number;
}) {
  let delay = initialDelay;
  return {
    next: () => {
      const current = delay;
      delay = Math.min(delay * 2, maxDelay);
      return current;
    },
    reset: () => {
      delay = initialDelay;
    },
  };
}
