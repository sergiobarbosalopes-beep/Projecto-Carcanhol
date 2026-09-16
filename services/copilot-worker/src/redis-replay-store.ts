import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import type { ReplayStore } from "./request-auth";

const MAX_RECONNECT_ATTEMPTS = 5;
const MAX_RECONNECT_DELAY_MS = 2_000;

export async function createRedisReplayStore({
  url,
  keyPrefix,
  signatureValidityMs,
  commandTimeoutMs,
}: {
  url: string;
  keyPrefix: string;
  signatureValidityMs: number;
  commandTimeoutMs: number;
}): Promise<ReplayStore> {
  const client = createClient({
    url,
    socket: {
      connectTimeout: commandTimeoutMs,
      reconnectStrategy: boundedReconnectStrategy,
    },
  });
  client.on("error", () => {
    console.warn("Copilot replay store connection error.");
  });
  const replayClient: ReplayRedisClient = {
    get isOpen() {
      return client.isOpen;
    },
    get isReady() {
      return client.isReady;
    },
    async connect() {
      await client.connect();
    },
    async ping() {
      return client.ping();
    },
    async set(key, value, options) {
      return client.set(key, value, options);
    },
    once(event, listener) {
      client.once(event, listener);
    },
    on(event, listener) {
      client.on(event, listener);
    },
    removeListener(event, listener) {
      client.removeListener(event, listener);
    },
    async close() {
      await client.close();
    },
  };
  const store = createRedisReplayStoreFromClient(replayClient, {
    keyPrefix,
    signatureValidityMs,
    commandTimeoutMs,
  });

  if (!(await store.readiness())) {
    throw new Error("Copilot replay store is unavailable.");
  }

  return store;
}

type ReplayRedisClient = {
  readonly isOpen: boolean;
  readonly isReady: boolean;
  connect(): Promise<void>;
  ping(): Promise<string>;
  set(
    key: string,
    value: string,
    options: {
      condition: "NX";
      expiration: { type: "PX"; value: number };
    }
  ): Promise<string | null>;
  once(event: "ready" | "end", listener: () => void): void;
  on(event: "error", listener: () => void): void;
  removeListener(event: "ready" | "end" | "error", listener: () => void): void;
  close(): Promise<void>;
};

export function createRedisReplayStoreFromClient(
  client: ReplayRedisClient,
  {
    keyPrefix,
    signatureValidityMs,
    commandTimeoutMs,
  }: {
    keyPrefix: string;
    signatureValidityMs: number;
    commandTimeoutMs: number;
  }
): ReplayStore {
  let connectionAttempt: Promise<void> | null = null;
  let closing = false;

  async function ensureConnected(signal?: AbortSignal) {
    signal?.throwIfAborted();

    if (closing) {
      throw new ReplayStoreUnavailableError();
    }

    if (client.isReady) {
      return;
    }

    if (!connectionAttempt) {
      const connectionController = new AbortController();
      const connectionTimeout = setTimeout(
        () => connectionController.abort(new ReplayStoreUnavailableError()),
        commandTimeoutMs
      );
      connectionTimeout.unref?.();
      const attempt = openOrAwaitReady(
        client,
        connectionController.signal
      ).finally(() => {
        clearTimeout(connectionTimeout);

        if (connectionAttempt === attempt) {
          connectionAttempt = null;
        }
      });
      connectionAttempt = attempt;
    }

    await withSignal(connectionAttempt, signal);

    if (!client.isReady) {
      throw new ReplayStoreUnavailableError();
    }
  }

  return {
    async consume(requestId, timestampMs, nowMs, signal) {
      await ensureConnected(signal);
      const remainingValidityMs = Math.max(
        1,
        timestampMs + signatureValidityMs - nowMs
      );
      const result = await withTimeout(
        client.set(`${keyPrefix}${requestId}`, "1", {
          condition: "NX",
          expiration: { type: "PX", value: remainingValidityMs },
        }),
        commandTimeoutMs,
        signal
      );

      return result === "OK";
    },
    async readiness(signal) {
      try {
        await ensureConnected(signal);
        const ping = await withTimeout(client.ping(), commandTimeoutMs, signal);
        const writeProbe = await withTimeout(
          client.set(`${keyPrefix}health:${randomUUID()}`, "1", {
            condition: "NX",
            expiration: {
              type: "PX",
              value: Math.max(1_000, commandTimeoutMs * 2),
            },
          }),
          commandTimeoutMs,
          signal
        );

        return ping === "PONG" && writeProbe === "OK";
      } catch {
        return false;
      }
    },
    async close() {
      closing = true;

      if (client.isOpen) {
        await withTimeout(client.close(), commandTimeoutMs);
      }
    },
  };
}

export function boundedReconnectStrategy(
  retries: number,
  _cause?: Error,
  random: () => number = Math.random
): number | Error {
  if (retries >= MAX_RECONNECT_ATTEMPTS) {
    return new Error("Copilot replay store reconnect limit reached.");
  }

  const exponentialDelay = Math.min(
    100 * 2 ** Math.max(0, retries),
    MAX_RECONNECT_DELAY_MS
  );
  const jitter = Math.floor(random() * Math.min(250, exponentialDelay / 4));
  return exponentialDelay + jitter;
}

async function openOrAwaitReady(
  client: ReplayRedisClient,
  signal: AbortSignal
) {
  signal.throwIfAborted();

  if (client.isReady) {
    return;
  }

  if (!client.isOpen) {
    await withSignal(client.connect(), signal);

    if (!client.isReady) {
      throw new ReplayStoreUnavailableError();
    }

    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onEnd = () => {
      cleanup();
      reject(new ReplayStoreUnavailableError());
    };
    const onError = () => {
      if (!client.isOpen) {
        cleanup();
        reject(new ReplayStoreUnavailableError());
      }
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => {
      client.removeListener("ready", onReady);
      client.removeListener("end", onEnd);
      client.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };

    client.once("ready", onReady);
    client.once("end", onEnd);
    client.on("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });

    if (client.isReady) {
      cleanup();
      resolve();
    } else if (!client.isOpen) {
      cleanup();
      reject(new ReplayStoreUnavailableError());
    }
  });
}

async function withSignal<T>(operation: Promise<T>, signal?: AbortSignal) {
  if (!signal) {
    return operation;
  }

  signal.throwIfAborted();
  let abortOperation: (() => void) | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        abortOperation = () => reject(signal.reason);
        signal.addEventListener("abort", abortOperation, { once: true });
      }),
    ]);
  } finally {
    if (abortOperation) {
      signal.removeEventListener("abort", abortOperation);
    }
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortOperation: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    abortOperation = () => reject(signal?.reason);
    signal?.addEventListener("abort", abortOperation, { once: true });
  });

  try {
    return await Promise.race([
      operation,
      aborted,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new ReplayStoreUnavailableError()),
          timeoutMs
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }

    if (abortOperation) {
      signal?.removeEventListener("abort", abortOperation);
    }
  }
}

class ReplayStoreUnavailableError extends Error {}
