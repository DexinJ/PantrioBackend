const DEFAULT_WS_GRACE_MS = 5_000;
const DEFAULT_WS_TERMINATION_SETTLE_MS = 250;
const DEFAULT_HARD_DEADLINE_MS = 15_000;

function errorSummary(error) {
  return {
    name: String(error?.name || "Error"),
    code: error?.code ? String(error.code) : null,
  };
}

function closeHttpServer(server) {
  if (!server || typeof server.close !== "function") return Promise.resolve();

  return new Promise((resolve, reject) => {
    try {
      server.close((error) => {
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
          reject(error);
          return;
        }
        resolve();
      });
    } catch (error) {
      if (error?.code === "ERR_SERVER_NOT_RUNNING") resolve();
      else reject(error);
    }
  });
}

function settlesWithin(promise, timeoutMs) {
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(false), timeoutMs);
  });

  return Promise.race([promise.then(() => true), timeout]).finally(() => {
    clearTimeout(timeoutId);
  });
}

function requestWebSocketClose(wss) {
  return new Promise((resolve, reject) => {
    try {
      wss.close((error) => {
        if (error && error.code !== "WS_ERR_SERVER_NOT_RUNNING") {
          reject(error);
          return;
        }
        resolve();
      });
    } catch (error) {
      if (error?.code === "WS_ERR_SERVER_NOT_RUNNING") resolve();
      else reject(error);
    }
  });
}

async function closeWebSocketServer(
  wss,
  {
    graceMs = DEFAULT_WS_GRACE_MS,
    terminationSettleMs = DEFAULT_WS_TERMINATION_SETTLE_MS,
  } = {}
) {
  if (!wss || typeof wss.close !== "function") return;

  const closed = requestWebSocketClose(wss);
  for (const client of wss.clients || []) {
    try {
      client.close?.(1001, "Server shutting down");
    } catch {
      client.terminate?.();
    }
  }

  if (await settlesWithin(closed, graceMs)) return;

  for (const client of wss.clients || []) {
    try {
      client.terminate?.();
    } catch {
      // Continue terminating the remaining clients.
    }
  }

  if (!(await settlesWithin(closed, terminationSettleMs))) {
    const error = new Error("WebSocket server did not close after termination");
    error.code = "WS_SHUTDOWN_TIMEOUT";
    throw error;
  }
}

function logStepFailures(logger, results) {
  let failed = false;
  for (const result of results) {
    if (result.status === "fulfilled") continue;
    failed = true;
    logger.error?.("[shutdown] cleanup step failed", errorSummary(result.reason));
  }
  return failed;
}

export function createGracefulShutdown({
  server,
  wss,
  stopBackgroundWork = () => {},
  waitForBackgroundWork = () => null,
  closeDatabase = () => null,
  wsGraceMs = DEFAULT_WS_GRACE_MS,
  wsTerminationSettleMs = DEFAULT_WS_TERMINATION_SETTLE_MS,
  hardDeadlineMs = DEFAULT_HARD_DEADLINE_MS,
  logger = console,
  exitProcess = (code) => process.exit(code),
} = {}) {
  let shutdownPromise = null;

  return function requestShutdown(reason = "shutdown") {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      logger.log?.(`[shutdown] ${reason} received`);

      let hardDeadlineId;
      const hardDeadline = new Promise((resolve) => {
        hardDeadlineId = setTimeout(
          () => resolve({ timedOut: true }),
          hardDeadlineMs
        );
      });

      const cleanup = (async () => {
        let failed = false;
        try {
          stopBackgroundWork();
        } catch (error) {
          failed = true;
          logger.error?.(
            "[shutdown] failed to stop background work",
            errorSummary(error)
          );
        }

        const drainResults = await Promise.allSettled([
          closeHttpServer(server),
          closeWebSocketServer(wss, {
            graceMs: wsGraceMs,
            terminationSettleMs: wsTerminationSettleMs,
          }),
          Promise.resolve().then(waitForBackgroundWork),
        ]);
        failed = logStepFailures(logger, drainResults) || failed;

        const databaseResults = await Promise.allSettled([
          Promise.resolve().then(closeDatabase),
        ]);
        failed = logStepFailures(logger, databaseResults) || failed;

        return { timedOut: false, failed };
      })();

      const result = await Promise.race([cleanup, hardDeadline]);
      clearTimeout(hardDeadlineId);

      if (result.timedOut) {
        logger.error?.(`[shutdown] exceeded ${hardDeadlineMs}ms deadline`);
        for (const client of wss?.clients || []) {
          try {
            client.terminate?.();
          } catch {
            // The process exits immediately below.
          }
        }
        try {
          server?.closeAllConnections?.();
        } catch {
          // The process exits immediately below.
        }
        exitProcess(1);
        return result;
      }

      logger.log?.(
        result.failed
          ? "[shutdown] completed with cleanup errors"
          : "[shutdown] complete"
      );
      exitProcess(result.failed ? 1 : 0);
      return result;
    })();

    return shutdownPromise;
  };
}
