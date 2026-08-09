export function createConcurrencyGuard({
  maxConcurrent,
  retryAfterSeconds = 5,
  code = "SERVICE_BUSY",
  message = "Service is temporarily busy.",
}) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new TypeError("maxConcurrent must be a positive integer");
  }

  let active = 0;
  return function concurrencyGuard(_req, res, next) {
    if (active >= maxConcurrent) {
      res.set("Retry-After", String(retryAfterSeconds));
      res.status(503).json({
        code,
        error: message,
        retryAfterMs: retryAfterSeconds * 1_000,
      });
      return;
    }

    active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  };
}

