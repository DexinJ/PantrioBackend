export function createAsyncConcurrencyLimit(maxConcurrent) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new TypeError("maxConcurrent must be a positive integer");
  }

  let active = 0;
  const waiters = [];

  return async function runWithLimit(task) {
    if (typeof task !== "function") throw new TypeError("task must be a function");
    if (active >= maxConcurrent) {
      await new Promise((resolve) => waiters.push(resolve));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      const next = waiters.shift();
      if (next) {
        // Transfer this slot directly to the oldest waiter. Keeping `active`
        // unchanged prevents a newly arriving task from barging in before the
        // resolved waiter's microtask resumes and temporarily exceeding the
        // configured limit.
        next();
      } else {
        active = Math.max(0, active - 1);
      }
    }
  };
}
