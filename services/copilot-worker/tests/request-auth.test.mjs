import assert from "node:assert/strict";
import test from "node:test";
import {
  createSignedWorkerHeaders,
  InMemoryReplayStore,
  parseWorkerHmacSecret,
  verifyWorkerRequest,
} from "../dist/request-auth.js";
import {
  COPILOT_VALIDATION_PATH,
  COPILOT_WORKER_HEADERS,
} from "../dist/contract.js";

const secret = Buffer.alloc(32, 19);
const secretBase64 = secret.toString("base64");
const requestId = "d510ccb5-22af-47b5-9280-3b605aac4c68";
const now = 1_789_489_000_000;
const body = JSON.stringify({
  requestId,
  token: `github_pat_${"A".repeat(40)}`,
});

test("accepts only canonical, sufficiently strong HMAC secrets", () => {
  assert.deepEqual(parseWorkerHmacSecret(secretBase64), secret);
  assert.throws(() => parseWorkerHmacSecret("not-base64"));
  assert.throws(() =>
    parseWorkerHmacSecret(Buffer.alloc(31).toString("base64"))
  );
  assert.throws(() => parseWorkerHmacSecret(`${secretBase64}=`));
});

test("verifies a signed request exactly once", async () => {
  const headers = createSignedWorkerHeaders({
    body,
    method: "POST",
    path: COPILOT_VALIDATION_PATH,
    requestId,
    secret,
    timestampMs: now,
  });
  const replayStore = new InMemoryReplayStore();
  const input = {
    body,
    method: "POST",
    path: COPILOT_VALIDATION_PATH,
    requestId: headers[COPILOT_WORKER_HEADERS.requestId],
    timestamp: headers[COPILOT_WORKER_HEADERS.timestamp],
    bodySha256: headers[COPILOT_WORKER_HEADERS.bodySha256],
    signature: headers[COPILOT_WORKER_HEADERS.signature],
  };

  assert.deepEqual(
    await verifyWorkerRequest(input, { secret, replayStore, now }),
    {
      ok: true,
      requestId,
    }
  );
  assert.deepEqual(
    await verifyWorkerRequest(input, { secret, replayStore, now }),
    {
      ok: false,
      reason: "replayed",
    }
  );
});

test("rejects stale, tampered, and incorrectly signed requests", async () => {
  const headers = createSignedWorkerHeaders({
    body,
    method: "POST",
    path: COPILOT_VALIDATION_PATH,
    requestId,
    secret,
    timestampMs: now,
  });
  const base = {
    body,
    method: "POST",
    path: COPILOT_VALIDATION_PATH,
    requestId,
    timestamp: headers[COPILOT_WORKER_HEADERS.timestamp],
    bodySha256: headers[COPILOT_WORKER_HEADERS.bodySha256],
    signature: headers[COPILOT_WORKER_HEADERS.signature],
  };

  assert.equal(
    (
      await verifyWorkerRequest(base, {
        secret,
        replayStore: new InMemoryReplayStore(),
        now: now + 30_001,
      })
    ).reason,
    "expired"
  );
  assert.equal(
    (
      await verifyWorkerRequest(
        { ...base, body: `${body} ` },
        { secret, replayStore: new InMemoryReplayStore(), now }
      )
    ).reason,
    "body_mismatch"
  );
  assert.equal(
    (
      await verifyWorkerRequest(
        { ...base, signature: `v1=${"0".repeat(64)}` },
        { secret, replayStore: new InMemoryReplayStore(), now }
      )
    ).reason,
    "signature_mismatch"
  );
});

test("retains replay ids for the full configured signature window", async () => {
  const headers = createSignedWorkerHeaders({
    body,
    method: "POST",
    path: COPILOT_VALIDATION_PATH,
    requestId,
    secret,
    timestampMs: now,
  });
  const replayStore = new InMemoryReplayStore(120_000);
  const input = {
    body,
    method: "POST",
    path: COPILOT_VALIDATION_PATH,
    requestId,
    timestamp: headers[COPILOT_WORKER_HEADERS.timestamp],
    bodySha256: headers[COPILOT_WORKER_HEADERS.bodySha256],
    signature: headers[COPILOT_WORKER_HEADERS.signature],
  };

  assert.equal(
    (
      await verifyWorkerRequest(input, {
        secret,
        replayStore,
        now,
        maxClockSkewMs: 120_000,
      })
    ).ok,
    true
  );
  assert.deepEqual(
    await verifyWorkerRequest(input, {
      secret,
      replayStore,
      now: now + 61_000,
      maxClockSkewMs: 120_000,
    }),
    { ok: false, reason: "replayed" }
  );
});
