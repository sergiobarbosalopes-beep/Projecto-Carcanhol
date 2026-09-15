import { createCopilotSdkRuntime } from "./copilot-adapter";
import { getWorkerConfig } from "./config";
import { createRedisReplayStore } from "./redis-replay-store";
import { InMemoryReplayStore } from "./request-auth";
import { validateCopilotCredential } from "./runtime";
import { createCopilotWorkerServer } from "./server";

const config = getWorkerConfig();
const replayStore = await initializeReplayStore();
const server = createCopilotWorkerServer({
  hmacSecret: config.COPILOT_WORKER_HMAC_SECRET,
  maxClockSkewMs: config.COPILOT_WORKER_CLOCK_SKEW_MS,
  maxConcurrency: config.COPILOT_WORKER_MAX_CONCURRENCY,
  maxQueue: config.COPILOT_WORKER_MAX_QUEUE,
  healthTimeoutMs: config.COPILOT_REPLAY_STORE_TIMEOUT_MS,
  validationDeadlineMs: config.COPILOT_VALIDATION_TIMEOUT_MS,
  replayStore,
  validate: async ({ requestId, token }, signal) => {
    const result = await validateCopilotCredential({
      token,
      requestId,
      timeoutMs: config.COPILOT_VALIDATION_TIMEOUT_MS,
      createRuntime: createCopilotSdkRuntime,
      signal,
      onUnknownError: (diagnostic) => {
        console.warn(JSON.stringify(diagnostic));
      },
    });

    if (!result.ok && result.code !== "unknown") {
      console.warn("Copilot validation failed.", {
        requestId,
        code: result.code,
      });
    }

    return result;
  },
});

server.requestTimeout = config.COPILOT_VALIDATION_TIMEOUT_MS + 5_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 32;
server.listen(config.PORT, "0.0.0.0", () => {
  console.info("Copilot validation worker is ready.");
});

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  const forcedExit = setTimeout(() => {
    server.closeAllConnections();
    process.exit(1);
  }, 25_000);
  forcedExit.unref();

  server.close(() => {
    clearTimeout(forcedExit);
    const closeReplayStore = replayStore.close?.() ?? Promise.resolve();
    void closeReplayStore
      .catch(() => {
        console.warn("Copilot replay store shutdown failed.");
      })
      .finally(() => process.exit(0));
  });
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

async function initializeReplayStore() {
  if (!config.COPILOT_REPLAY_REDIS_URL) {
    return new InMemoryReplayStore(config.COPILOT_WORKER_CLOCK_SKEW_MS);
  }

  try {
    return await createRedisReplayStore({
      url: config.COPILOT_REPLAY_REDIS_URL,
      keyPrefix: config.COPILOT_REPLAY_REDIS_PREFIX,
      signatureValidityMs: config.COPILOT_WORKER_CLOCK_SKEW_MS,
      commandTimeoutMs: config.COPILOT_REPLAY_STORE_TIMEOUT_MS,
    });
  } catch {
    console.error("Copilot replay store initialization failed.");
    process.exit(1);
  }
}
