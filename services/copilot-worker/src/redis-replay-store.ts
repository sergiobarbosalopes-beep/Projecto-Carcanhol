import { createClient } from "redis";
import type { ReplayStore } from "./request-auth";

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
      reconnectStrategy: false,
    },
  });
  client.on("error", () => {
    console.warn("Copilot replay store connection error.");
  });
  await withTimeout(client.connect(), commandTimeoutMs);

  return createRedisReplayStoreFromClient(client, {
    keyPrefix,
    signatureValidityMs,
    commandTimeoutMs,
  });
}

type ReplayRedisClient = Pick<
  ReturnType<typeof createClient>,
  "close" | "isOpen" | "set"
>;

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
  return {
    async consume(requestId, timestampMs, nowMs, signal) {
      signal?.throwIfAborted();
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
    async close() {
      if (client.isOpen) {
        await withTimeout(client.close(), commandTimeoutMs);
      }
    },
  };
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
          () => reject(new Error("Replay store operation timed out.")),
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
