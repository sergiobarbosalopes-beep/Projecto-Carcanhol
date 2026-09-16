import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import {
  COPILOT_HEALTH_PATH,
  COPILOT_VALIDATION_PATH,
} from "../dist/contract.js";
import { createSignedWorkerHeaders } from "../dist/request-auth.js";
import { createCopilotWorkerServer } from "../dist/server.js";

const secret = Buffer.alloc(32, 23);
const token = `github_pat_${"T".repeat(40)}`;
const internalFailureMessage = "copilot worker failed internally";

test("serves health without details and validates only authenticated strict requests", async () => {
  const server = createCopilotWorkerServer({
    hmacSecret: secret,
    validate: async ({ requestId }) => ({
      ok: true,
      requestId,
      models: [
        {
          id: "gpt-5",
          displayName: "GPT-5",
          capabilities: {},
          policy: {},
          billing: {},
        },
      ],
    }),
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${baseUrl}${COPILOT_HEALTH_PATH}`);

    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    assert.equal(health.headers.has("access-control-allow-origin"), false);

    const requestId = "d510ccb5-22af-47b5-9280-3b605aac4c68";
    const body = JSON.stringify({ requestId, token });
    const headers = createSignedWorkerHeaders({
      body,
      method: "POST",
      path: COPILOT_VALIDATION_PATH,
      requestId,
      secret,
    });
    const first = await fetch(`${baseUrl}${COPILOT_VALIDATION_PATH}`, {
      method: "POST",
      body,
      headers: { ...headers, "Content-Type": "application/json" },
    });
    const firstBody = await first.text();

    assert.equal(first.status, 200);
    assert.equal(firstBody.includes(token), false);
    assert.equal(JSON.parse(firstBody).models.length, 1);

    const replay = await fetch(`${baseUrl}${COPILOT_VALIDATION_PATH}`, {
      method: "POST",
      body,
      headers: { ...headers, "Content-Type": "application/json" },
    });
    assert.equal(replay.status, 401);
    assert.equal((await replay.text()).includes(token), false);

    const browserRequest = await fetch(`${baseUrl}${COPILOT_VALIDATION_PATH}`, {
      method: "POST",
      body,
      headers: {
        ...headers,
        "Content-Type": "application/json",
        Origin: "https://example.com",
      },
    });
    assert.equal(browserRequest.status, 403);
    assert.equal(
      browserRequest.headers.has("access-control-allow-origin"),
      false
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("health is readiness-aware and recovers with the replay store", async () => {
  let ready = false;
  const server = createCopilotWorkerServer({
    hmacSecret: secret,
    replayStore: {
      async consume() {
        return true;
      },
      async readiness() {
        if (!ready) {
          throw new Error("redis unavailable");
        }

        return ready;
      },
    },
    validate: async ({ requestId }) => ({
      ok: false,
      requestId,
      code: "unknown",
    }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const healthUrl = `http://127.0.0.1:${address.port}${COPILOT_HEALTH_PATH}`;
    const unhealthy = await fetch(healthUrl);

    assert.equal(unhealthy.status, 503);
    assert.deepEqual(await unhealthy.json(), { status: "unavailable" });

    ready = true;
    const healthy = await fetch(healthUrl);

    assert.equal(healthy.status, 200);
    assert.deepEqual(await healthy.json(), { status: "ok" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("never reflects a token from an invalid signed payload", async () => {
  let diagnosticCalls = 0;
  const server = createCopilotWorkerServer({
    hmacSecret: secret,
    onDiagnostic() {
      diagnosticCalls += 1;
    },
    validate: async () => {
      throw new Error(token);
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const requestId = "f582add4-1405-46f0-967c-1ad945d6ce07";
    const body = JSON.stringify({ requestId, token, prompt: "forbidden" });
    const headers = createSignedWorkerHeaders({
      body,
      method: "POST",
      path: COPILOT_VALIDATION_PATH,
      requestId,
      secret,
    });
    const response = await fetch(
      `http://127.0.0.1:${address.port}${COPILOT_VALIDATION_PATH}`,
      {
        method: "POST",
        body,
        headers: { ...headers, "Content-Type": "application/json" },
      }
    );
    const responseBody = await response.text();

    assert.equal(response.status, 400);
    assert.equal(responseBody.includes(token), false);
    assert.equal(diagnosticCalls, 0);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("keeps authentication failures opaque before request parsing", async () => {
  let diagnosticCalls = 0;
  const server = createCopilotWorkerServer({
    hmacSecret: secret,
    replayStore: {
      async consume() {
        throw new Error(token);
      },
    },
    onDiagnostic() {
      diagnosticCalls += 1;
    },
    validate: async ({ requestId }) => ({
      ok: false,
      requestId,
      code: "unknown",
    }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const requestId = "2a15da72-2e72-4819-a3c8-fd48006ef427";
    const body = JSON.stringify({ requestId, token });
    const headers = createSignedWorkerHeaders({
      body,
      method: "POST",
      path: COPILOT_VALIDATION_PATH,
      requestId,
      secret,
    });
    const response = await fetch(
      `http://127.0.0.1:${address.port}${COPILOT_VALIDATION_PATH}`,
      {
        method: "POST",
        body,
        headers: { ...headers, "Content-Type": "application/json" },
      }
    );
    const responseBody = await response.text();

    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(responseBody), {
      error: "Worker unavailable.",
    });
    assert.equal(responseBody.includes(token), false);
    assert.equal(diagnosticCalls, 0);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("reports fixed internal diagnostics after authenticated validation starts", async () => {
  const cases = [
    {
      phase: "validating",
      requestId: "78db495f-2834-407c-b2eb-d7554b565293",
      validate: async () => {
        throw new Error(`runtime failed for ${token}`);
      },
    },
    {
      phase: "validating_response",
      requestId: "3a6c572b-3caf-4c5d-9f73-48d89d43675f",
      validate: async ({ requestId }) => ({
        ok: true,
        requestId,
        models: [],
        raw: token,
      }),
    },
  ];

  for (const { phase, requestId, validate } of cases) {
    const diagnostics = [];
    const server = createCopilotWorkerServer({
      hmacSecret: secret,
      validate,
      onDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address();
      assert.equal(typeof address, "object");
      const body = JSON.stringify({ requestId, token });
      const headers = createSignedWorkerHeaders({
        body,
        method: "POST",
        path: COPILOT_VALIDATION_PATH,
        requestId,
        secret,
      });
      const response = await fetch(
        `http://127.0.0.1:${address.port}${COPILOT_VALIDATION_PATH}`,
        {
          method: "POST",
          body,
          headers: { ...headers, "Content-Type": "application/json" },
        }
      );
      const responseBody = await response.text();
      const expectedDiagnostic = {
        event: "copilot_worker_internal_error",
        requestId,
        code: "WORKER_INTERNAL_FAILURE",
        message: internalFailureMessage,
        phase,
      };

      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(responseBody), {
        ok: false,
        requestId,
        code: "unavailable",
        diagnostic: expectedDiagnostic,
      });
      assert.deepEqual(diagnostics, [expectedDiagnostic]);
      assert.equal(responseBody.includes(token), false);
    } finally {
      server.close();
      await once(server, "close");
    }
  }
});

test("logs only a fixed phase when writing the validated response fails", async () => {
  const diagnostics = [];
  let writeCalls = 0;
  const server = createCopilotWorkerServer({
    hmacSecret: secret,
    validate: async ({ requestId }) => ({
      ok: true,
      requestId,
      models: [
        {
          id: "gpt-5",
          displayName: "GPT-5",
          capabilities: {},
          policy: {},
          billing: {},
        },
      ],
    }),
    onDiagnostic(diagnostic) {
      diagnostics.push(diagnostic);
    },
    writeResponse() {
      writeCalls += 1;
      throw new Error(`write failed for ${token}`);
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const requestId = "40eb2135-76d2-45c2-a71c-7d057ad4e29d";
    const body = JSON.stringify({ requestId, token });
    const headers = createSignedWorkerHeaders({
      body,
      method: "POST",
      path: COPILOT_VALIDATION_PATH,
      requestId,
      secret,
    });

    await assert.rejects(
      fetch(`http://127.0.0.1:${address.port}${COPILOT_VALIDATION_PATH}`, {
        method: "POST",
        body,
        headers: { ...headers, "Content-Type": "application/json" },
      })
    );

    assert.equal(writeCalls, 1);
    assert.deepEqual(diagnostics, [
      {
        event: "copilot_worker_internal_error",
        requestId,
        code: "WORKER_INTERNAL_FAILURE",
        message: internalFailureMessage,
        phase: "writing_response",
      },
    ]);
    assert.equal(JSON.stringify(diagnostics).includes(token), false);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("expires queued validation without starting SDK work", async () => {
  let validationCalls = 0;
  const server = createCopilotWorkerServer({
    hmacSecret: secret,
    maxConcurrency: 1,
    maxQueue: 2,
    validationDeadlineMs: 20,
    validate: async ({ requestId: receivedRequestId }) => {
      validationCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return {
        ok: true,
        requestId: receivedRequestId,
        models: [
          {
            id: "gpt-5",
            displayName: "GPT-5",
            capabilities: {},
            policy: {},
            billing: {},
          },
        ],
      };
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const requestIds = [
      "2cc30469-e717-41b8-80f0-7b803f85e62d",
      "410c6cdd-95f3-4561-98b0-753d6e83e56c",
    ];
    const requests = requestIds.map((currentRequestId) => {
      const body = JSON.stringify({
        requestId: currentRequestId,
        token,
      });
      const headers = createSignedWorkerHeaders({
        body,
        method: "POST",
        path: COPILOT_VALIDATION_PATH,
        requestId: currentRequestId,
        secret,
      });
      return fetch(`${baseUrl}${COPILOT_VALIDATION_PATH}`, {
        method: "POST",
        body,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    });
    const responses = await Promise.all(requests);
    const payloads = await Promise.all(
      responses.map((response) => response.json())
    );

    assert.equal(validationCalls, 1);
    assert.deepEqual(
      payloads.map((payload) => payload.code),
      ["timeout", "timeout"]
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("includes replay-store latency in the end-to-end deadline", async () => {
  let validationCalls = 0;
  let replaySignal;
  const server = createCopilotWorkerServer({
    hmacSecret: secret,
    validationDeadlineMs: 20,
    replayStore: {
      async consume(_requestId, _timestampMs, _nowMs, signal) {
        replaySignal = signal;
        return new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve(false), {
            once: true,
          });
        });
      },
    },
    validate: async ({ requestId: receivedRequestId }) => {
      validationCalls += 1;
      return {
        ok: false,
        requestId: receivedRequestId,
        code: "unknown",
      };
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const currentRequestId = "ef4acbcc-cb43-4435-9e3f-f16472bcbb43";
    const body = JSON.stringify({ requestId: currentRequestId, token });
    const headers = createSignedWorkerHeaders({
      body,
      method: "POST",
      path: COPILOT_VALIDATION_PATH,
      requestId: currentRequestId,
      secret,
    });
    const response = await fetch(
      `http://127.0.0.1:${address.port}${COPILOT_VALIDATION_PATH}`,
      {
        method: "POST",
        body,
        headers: { ...headers, "Content-Type": "application/json" },
      }
    );

    assert.equal(response.status, 504);
    assert.equal(replaySignal.aborted, true);
    assert.equal(validationCalls, 0);
  } finally {
    server.close();
    await once(server, "close");
  }
});
