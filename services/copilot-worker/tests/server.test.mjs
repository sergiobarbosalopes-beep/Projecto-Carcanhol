import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import {
  COPILOT_HEALTH_PATH,
  COPILOT_INFERENCE_PATH,
  COPILOT_STREAM_PATH,
  COPILOT_VALIDATION_PATH,
  copilotStreamEventSchema,
} from "../dist/contract.js";
import { createSignedWorkerHeaders } from "../dist/request-auth.js";
import { validateCopilotCredential } from "../dist/runtime.js";
import { createCopilotWorkerServer } from "../dist/server.js";

const secret = Buffer.alloc(32, 23);
const token = `github_pat_${"T".repeat(40)}`;
const internalFailureMessage = "copilot worker failed internally";

test("serves only signed, replay-protected inference requests without browser origins", async () => {
  const calls = [];
  const server = createCopilotWorkerServer({
    hmacSecret: secret,
    validate: async ({ requestId }) => ({
      ok: false,
      requestId,
      code: "unknown",
    }),
    infer: async (request) => {
      calls.push(request);
      return {
        ok: true,
        requestId: request.requestId,
        text: "Lisboa",
        durationMs: 12,
      };
    },
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const requestId = "c5d20776-84ba-474f-9703-f49220ca31be";
    const body = JSON.stringify({
      requestId,
      token,
      model: "claude-haiku-4.5",
      prompt: "Qual é a capital de Portugal?",
    });

    const headers = createSignedWorkerHeaders({
      body,
      method: "POST",
      path: COPILOT_INFERENCE_PATH,
      requestId,
      secret,
    });
    const response = await fetch(`${baseUrl}${COPILOT_INFERENCE_PATH}`, {
      method: "POST",
      body,
      headers: { ...headers, "Content-Type": "application/json" },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      requestId,
      text: "Lisboa",
      durationMs: 12,
    });
    assert.equal(calls.length, 1);

    const replay = await fetch(`${baseUrl}${COPILOT_INFERENCE_PATH}`, {
      method: "POST",
      body,
      headers: { ...headers, "Content-Type": "application/json" },
    });
    assert.equal(replay.status, 401);

    const browserRequestId = "763573d7-3459-44eb-b215-a5def55a3883";
    const browserBody = JSON.stringify({
      requestId: browserRequestId,
      token,
      model: "claude-haiku-4.5",
      prompt: "blocked",
    });
    const browserHeaders = createSignedWorkerHeaders({
      body: browserBody,
      method: "POST",
      path: COPILOT_INFERENCE_PATH,
      requestId: browserRequestId,
      secret,
    });
    const browser = await fetch(`${baseUrl}${COPILOT_INFERENCE_PATH}`, {
      method: "POST",
      body: browserBody,
      headers: {
        ...browserHeaders,
        "Content-Type": "application/json",
        Origin: "https://example.com",
      },
    });
    assert.equal(browser.status, 403);
    assert.equal(calls.length, 1);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("streams only ordered allowlisted NDJSON events for a signed request", async () => {
  const requestId = "6969d102-dba7-4f30-92f3-7446259f59e4";
  const server = createCopilotWorkerServer({
    hmacSecret: secret,
    validate: async ({ requestId: id }) => ({
      ok: false,
      requestId: id,
      code: "unknown",
    }),
    inferStream: async (request, _signal, emit) => {
      await emit({ v: 1, type: "start", requestId: request.requestId });
      await emit({
        v: 1,
        type: "delta",
        requestId: request.requestId,
        sequence: 1,
        text: "Lis",
      });
      await emit({
        v: 1,
        type: "delta",
        requestId: request.requestId,
        sequence: 2,
        text: "boa",
      });
      await emit({
        v: 1,
        type: "done",
        requestId: request.requestId,
        text: "Lisboa",
        durationMs: 10,
      });
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const body = JSON.stringify({
      requestId,
      token,
      model: "claude-haiku-4.5",
      prompt: "Capital?",
    });
    const headers = createSignedWorkerHeaders({
      body,
      method: "POST",
      path: COPILOT_STREAM_PATH,
      requestId,
      secret,
    });
    const response = await fetch(
      `http://127.0.0.1:${address.port}${COPILOT_STREAM_PATH}`,
      {
        method: "POST",
        body,
        headers: {
          ...headers,
          Accept: "application/x-ndjson",
          "Content-Type": "application/json",
        },
      }
    );
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "delta", "delta", "done"]
    );
    assert.deepEqual(
      events
        .filter((event) => event.type === "delta")
        .map((event) => event.sequence),
      [1, 2]
    );
    assert.equal(JSON.stringify(events).includes(token), false);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("adds one error terminal when a tool stream returns without a terminal event", async () => {
  const requestId = "9718c7fc-6774-4075-af87-a11b65de6cf0";
  const server = createCopilotWorkerServer({
    hmacSecret: secret,
    validate: async ({ requestId: id }) => ({
      ok: false,
      requestId: id,
      code: "unknown",
    }),
    inferStream: async (request, _signal, emit) => {
      await emit({ v: 1, type: "start", requestId: request.requestId });
      await emit({
        v: 1,
        type: "tool",
        requestId: request.requestId,
        tool: "web_fetch",
        status: "started",
        source: { url: "https://example.com/source" },
      });
      await emit({
        v: 1,
        type: "tool",
        requestId: request.requestId,
        tool: "web_fetch",
        status: "completed",
        source: {
          url: "https://example.com/source",
          title: "Example source",
        },
      });
      await emit({
        v: 1,
        type: "sources",
        requestId: request.requestId,
        sources: [
          {
            url: "https://example.com/source",
            title: "Example source",
          },
        ],
      });
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const events = await fetchStreamEvents(server, requestId);

    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "tool", "tool", "sources", "error"]
    );
    assert.equal(events.at(-1).code, "invalid_response");
    assert.equal(
      events.filter((event) => event.type === "done" || event.type === "error")
        .length,
      1
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("adds one error terminal when inference throws after partial output", async () => {
  const requestId = "b87692a4-51ea-4d05-a4dc-ddf82e86c240";
  const server = createCopilotWorkerServer({
    hmacSecret: secret,
    validate: async ({ requestId: id }) => ({
      ok: false,
      requestId: id,
      code: "unknown",
    }),
    inferStream: async (request, _signal, emit) => {
      await emit({ v: 1, type: "start", requestId: request.requestId });
      await emit({
        v: 1,
        type: "delta",
        requestId: request.requestId,
        sequence: 1,
        text: "partial",
      });
      throw new Error("provider stream failed");
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const events = await fetchStreamEvents(server, requestId);

    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "delta", "error"]
    );
    assert.equal(events.at(-1).code, "invalid_response");
    assert.equal(
      events.filter((event) => event.type === "done" || event.type === "error")
        .length,
      1
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("rejects malformed and oversized public stream events", () => {
  assert.equal(
    copilotStreamEventSchema.safeParse({
      v: 1,
      type: "delta",
      requestId: "6969d102-dba7-4f30-92f3-7446259f59e4",
      sequence: 0,
      text: "invalid",
    }).success,
    false
  );
  assert.equal(
    copilotStreamEventSchema.safeParse({
      v: 1,
      type: "delta",
      requestId: "6969d102-dba7-4f30-92f3-7446259f59e4",
      sequence: 1,
      text: "x".repeat(16_001),
    }).success,
    false
  );
  assert.equal(
    copilotStreamEventSchema.safeParse({
      v: 1,
      type: "done",
      requestId: "6969d102-dba7-4f30-92f3-7446259f59e4",
      text: "ok",
      durationMs: 1,
      rawError: "forbidden",
    }).success,
    false
  );
});

async function fetchStreamEvents(server, requestId) {
  const address = server.address();
  assert.equal(typeof address, "object");
  const body = JSON.stringify({
    requestId,
    token,
    model: "claude-haiku-4.5",
    prompt: "Read a source",
  });
  const headers = createSignedWorkerHeaders({
    body,
    method: "POST",
    path: COPILOT_STREAM_PATH,
    requestId,
    secret,
  });
  const response = await fetch(
    `http://127.0.0.1:${address.port}${COPILOT_STREAM_PATH}`,
    {
      method: "POST",
      body,
      headers: {
        ...headers,
        Accept: "application/x-ndjson",
        "Content-Type": "application/json",
      },
    }
  );

  assert.equal(response.status, 200);
  return (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

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

test("accepts the exact builder-error probe result through the server schema", async () => {
  const cases = [
    {
      requestId: "50f962dd-c7ae-4231-b9a5-69a99ba81682",
      probeResult: { outcome: "valid" },
      code: "unknown",
      diagnostic: {
        event: "copilot_validation_probe_unknown",
        code: "GITHUB_CREDENTIAL_PROBE_SUCCEEDED",
        message:
          "github credential probe succeeded; Copilot runtime transport failed",
      },
    },
    {
      requestId: "ca23b302-d255-46c8-b42c-b97ec0cc348b",
      probeResult: { outcome: "forbidden" },
      code: "unknown",
      diagnostic: {
        event: "copilot_validation_probe_unknown",
        code: "GITHUB_CREDENTIAL_PROBE_FORBIDDEN",
        message:
          "github credential probe forbidden; Copilot runtime transport failed",
      },
    },
    {
      requestId: "16cf33f1-21a9-48f5-9aa4-4fd61623dc86",
      probeResult: { outcome: "unknown" },
      code: "unknown",
      diagnostic: {
        event: "copilot_validation_probe_unknown",
        code: "GITHUB_CREDENTIAL_PROBE_UNEXPECTED_STATUS",
        message:
          "github credential probe returned an unexpected status; Copilot runtime transport failed",
      },
    },
    {
      requestId: "fb1d4ae1-17bf-41ec-b3d9-fe927c6b64a8",
      probeResult: {
        outcome: "unavailable",
        category: "network_error",
        causeCode: "SELF_SIGNED_CERT_IN_CHAIN",
      },
      code: "unavailable",
      diagnostic: {
        event: "copilot_validation_probe_unavailable",
        code: "GITHUB_CREDENTIAL_PROBE_NETWORK_ERROR",
        message: "github credential probe could not reach GitHub",
        causeCode: "SELF_SIGNED_CERT_IN_CHAIN",
      },
    },
    {
      requestId: "cc416a0f-8e31-49e8-b72a-93ad3fed117a",
      probeResult: {
        outcome: "unavailable",
        category: "rate_limited",
      },
      code: "unavailable",
      diagnostic: {
        event: "copilot_validation_probe_unavailable",
        code: "GITHUB_CREDENTIAL_PROBE_RATE_LIMITED",
        message: "github credential probe was rate limited",
      },
    },
    {
      requestId: "a81dd629-2909-4d77-8395-763a1f21b2db",
      probeResult: {
        outcome: "unavailable",
        category: "github_unavailable",
      },
      code: "unavailable",
      diagnostic: {
        event: "copilot_validation_probe_unavailable",
        code: "GITHUB_CREDENTIAL_PROBE_GITHUB_UNAVAILABLE",
        message: "github credential probe found GitHub unavailable",
      },
    },
    {
      requestId: "536329aa-4d9c-4343-b24b-9f3a43fcfc4f",
      probeResult: { outcome: "invalid_token" },
      code: "invalid_token",
    },
    {
      requestId: "ece1470d-dcf2-4d76-9701-97b5432de4bb",
      probeResult: { outcome: "timeout" },
      code: "timeout",
    },
  ];

  for (const { requestId, probeResult, code, diagnostic } of cases) {
    const emittedDiagnostics = [];
    const server = createCopilotWorkerServer({
      hmacSecret: secret,
      validate: (
        { token: receivedToken, requestId: receivedRequestId },
        signal
      ) =>
        validateCopilotCredential({
          token: receivedToken,
          requestId: receivedRequestId,
          timeoutMs: 100,
          signal,
          createRuntime: async () => ({
            async listModels() {
              throw {
                name: "ResponseError",
                code: -32603,
                message:
                  "SDK session authentication failed: network fetch failed: request failed: builder error",
              };
            },
            async close() {},
          }),
          async probeCredential() {
            return probeResult;
          },
          onDiagnostic(value) {
            emittedDiagnostics.push(value);
          },
        }),
      onDiagnostic(value) {
        emittedDiagnostics.push(value);
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
      const payload = await response.json();
      const expectedDiagnostic = diagnostic
        ? { requestId, ...diagnostic }
        : undefined;

      assert.equal(response.status, 200);
      assert.deepEqual(payload, {
        ok: false,
        requestId,
        code,
        ...(expectedDiagnostic ? { diagnostic: expectedDiagnostic } : {}),
      });
      assert.deepEqual(
        emittedDiagnostics,
        expectedDiagnostic ? [expectedDiagnostic] : []
      );
      assert.equal(JSON.stringify(payload).includes(token), false);
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
