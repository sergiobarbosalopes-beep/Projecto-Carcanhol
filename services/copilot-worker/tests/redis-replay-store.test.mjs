import assert from "node:assert/strict";
import test from "node:test";
import { createRedisReplayStoreFromClient } from "../dist/redis-replay-store.js";

test("claims a nonce atomically until the signature validity ends", async () => {
  const calls = [];
  let available = true;
  const client = {
    isOpen: true,
    async set(key, value, options) {
      calls.push({ key, value, options });

      if (!available) {
        return null;
      }

      available = false;
      return "OK";
    },
    async close() {},
  };
  const store = createRedisReplayStoreFromClient(client, {
    keyPrefix: "test:replay:",
    signatureValidityMs: 120_000,
    commandTimeoutMs: 1_000,
  });

  assert.equal(await store.consume("request-id", 1_000_000, 950_000), true);
  assert.equal(await store.consume("request-id", 1_000_000, 950_000), false);
  assert.deepEqual(calls[0], {
    key: "test:replay:request-id",
    value: "1",
    options: {
      condition: "NX",
      expiration: { type: "PX", value: 170_000 },
    },
  });
});
