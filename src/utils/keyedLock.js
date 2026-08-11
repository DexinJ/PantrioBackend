const lockTails = new Map();

/**
 * Serialize destructive and credential-linking work for one account. The
 * backend currently supports one process/replica, so a process-local keyed
 * lock matches the rest of its in-memory concurrency controls.
 */
export async function acquireKeyedLock(key) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) throw new TypeError("A lock key is required");

  const previous = lockTails.get(normalizedKey) || Promise.resolve();
  let releaseCurrent;
  const current = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.then(() => current);
  lockTails.set(normalizedKey, tail);

  await previous;
  let released = false;

  return () => {
    if (released) return;
    released = true;
    releaseCurrent();
    void tail.finally(() => {
      if (lockTails.get(normalizedKey) === tail) {
        lockTails.delete(normalizedKey);
      }
    });
  };
}
