import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  boundedReconnectStrategy,
  createRedisReplayStoreFromClient,
} from "../dist/redis-replay-store.js";

test("claims a nonce atomically until the signature validity ends", async () => {
  const calls = [];
  let available = true;
  const client = {
    isOpen: true,
    isReady: true,
    async connect() {},
    async ping() {
      return "PONG";
    },
    async set(key, value, options) {
      calls.push({ key, value, options });

      if (!available) {
        return null;
      }

      available = false;
      return "OK";
    },
    once() {},
    removeListener() {},
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

test("shares recovery attempts and reconnects after a closed client", async () => {
  const client = new FakeRedisClient();
  let releaseConnection;
  client.connectionGate = new Promise((resolve) => {
    releaseConnection = resolve;
  });
  const store = createRedisReplayStoreFromClient(client, {
    keyPrefix: "test:replay:",
    signatureValidityMs: 30_000,
    commandTimeoutMs: 1_000,
  });
  const firstReadiness = store.readiness();
  const secondReadiness = store.readiness();

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.connectCalls, 1);
  releaseConnection();
  assert.deepEqual(await Promise.all([firstReadiness, secondReadiness]), [
    true,
    true,
  ]);

  client.failNextSet = true;
  await assert.rejects(() =>
    store.consume("failed-request", 1_000_000, 990_000)
  );
  assert.equal(client.isReady, false);

  assert.equal(
    await store.consume("recovered-request", 1_000_000, 990_000),
    true
  );
  assert.equal(client.connectCalls, 2);
  assert.equal(await store.readiness(), true);
});

test("clears a wedged reconnect attempt after terminal client failure", async () => {
  const client = new FakeRedisClient();
  client.isOpen = true;
  const store = createRedisReplayStoreFromClient(client, {
    keyPrefix: "test:replay:",
    signatureValidityMs: 30_000,
    commandTimeoutMs: 1_000,
  });
  const failedReadiness = store.readiness();

  await new Promise((resolve) => setImmediate(resolve));
  client.isOpen = false;
  client.emit("error", new Error("reconnect exhausted"));
  assert.equal(await failedReadiness, false);

  assert.equal(await store.readiness(), true);
  assert.equal(client.connectCalls, 1);
});

test("readiness fails closed when Redis can ping but cannot write", async () => {
  const client = new FakeRedisClient();
  client.isOpen = true;
  client.isReady = true;
  client.set = async () => {
    throw new Error("read only");
  };
  const store = createRedisReplayStoreFromClient(client, {
    keyPrefix: "test:replay:",
    signatureValidityMs: 30_000,
    commandTimeoutMs: 1_000,
  });

  assert.equal(await store.readiness(), false);
});

test("uses bounded exponential reconnect delays with jitter", () => {
  assert.equal(
    boundedReconnectStrategy(0, undefined, () => 0),
    100
  );
  assert.equal(
    boundedReconnectStrategy(3, undefined, () => 0),
    800
  );
  assert.equal(
    boundedReconnectStrategy(4, undefined, () => 0.999),
    1_849
  );
  assert.equal(boundedReconnectStrategy(5) instanceof Error, true);
});

class FakeRedisClient extends EventEmitter {
  isOpen = false;
  isReady = false;
  connectCalls = 0;
  connectionGate = Promise.resolve();
  failNextSet = false;
  keys = new Set();

  async connect() {
    this.connectCalls += 1;
    this.isOpen = true;
    await this.connectionGate;
    this.connectionGate = Promise.resolve();
    this.isReady = true;
    this.emit("ready");
  }

  async ping() {
    if (!this.isReady) {
      throw new Error("closed");
    }

    return "PONG";
  }

  async set(key) {
    if (this.failNextSet) {
      this.failNextSet = false;
      this.isOpen = false;
      this.isReady = false;
      throw new Error("closed");
    }

    if (this.keys.has(key)) {
      return null;
    }

    this.keys.add(key);
    return "OK";
  }

  async close() {
    this.isOpen = false;
    this.isReady = false;
  }
}
