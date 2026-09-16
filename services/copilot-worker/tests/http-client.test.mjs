import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createCopilotWorkerHttpClient } from "../dist/http-client.js";
import { validateCopilotCredential } from "../dist/runtime.js";
import { createCopilotWorkerServer } from "../dist/server.js";

const secret = Buffer.alloc(32, 29);
const token = `github_pat_${"C".repeat(40)}`;
const requestId = "3bebcccd-5254-40f8-809f-3a14579dba46";
const clientSource = await readFile(
  new URL("../src/http-client.ts", import.meta.url),
  "utf8"
);

test("does not log BFF transport failures", () => {
  assert.doesNotMatch(clientSource, /\bconsole\./);
});

test("BFF client and worker exchange a signed validation request", async () => {
  const server = createCopilotWorkerServer({
    hmacSecret: secret,
    validate: async ({
      requestId: receivedRequestId,
      token: receivedToken,
    }) => {
      assert.equal(receivedToken, token);
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
    const validate = createCopilotWorkerHttpClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      hmacSecret: secret,
      timeoutMs: 1_000,
    });
    const result = await validate(token, requestId);

    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes(token), false);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("BFF client maps timeouts and malformed responses without reflection", async () => {
  const timeoutClient = createCopilotWorkerHttpClient({
    baseUrl: "https://worker.example",
    hmacSecret: secret,
    timeoutMs: 10,
    fetchImpl: async () => {
      throw new DOMException(token, "TimeoutError");
    },
  });

  const malformedClient = createCopilotWorkerHttpClient({
    baseUrl: "https://worker.example",
    hmacSecret: secret,
    timeoutMs: 10,
    fetchImpl: async () =>
      new Response(JSON.stringify({ token }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  });
  const deadlineClient = createCopilotWorkerHttpClient({
    baseUrl: "https://worker.example",
    hmacSecret: secret,
    timeoutMs: 10,
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: "Worker request timed out." }), {
        status: 504,
        headers: { "Content-Type": "application/json" },
      }),
  });

  assert.deepEqual(await timeoutClient(token, requestId), {
    ok: false,
    requestId,
    code: "timeout",
    diagnostic: {
      event: "copilot_worker_transport_error",
      requestId,
      code: "WORKER_TIMEOUT",
      message: "copilot worker request timed out",
    },
  });
  assert.deepEqual(await malformedClient(token, requestId), {
    ok: false,
    requestId,
    code: "unknown",
    diagnostic: {
      event: "copilot_worker_transport_error",
      requestId,
      code: "WORKER_INVALID_RESPONSE",
      message: "copilot worker returned an invalid response",
    },
  });
  assert.deepEqual(await deadlineClient(token, requestId), {
    ok: false,
    requestId,
    code: "timeout",
    diagnostic: {
      event: "copilot_worker_transport_error",
      requestId,
      code: "WORKER_TIMEOUT",
      message: "copilot worker request timed out",
    },
  });
});

test("classifies non-2xx worker responses without reading response details", async () => {
  const cases = [
    [
      401,
      "unavailable",
      "WORKER_AUTH_REJECTED",
      "copilot worker rejected request authentication",
    ],
    [
      403,
      "unavailable",
      "WORKER_AUTH_REJECTED",
      "copilot worker rejected request authentication",
    ],
    [
      429,
      "unavailable",
      "WORKER_RATE_LIMITED",
      "copilot worker rate limited the request",
    ],
    [
      500,
      "unavailable",
      "WORKER_HTTP_UNAVAILABLE",
      "copilot worker returned an unavailable response",
    ],
    [
      418,
      "unavailable",
      "WORKER_HTTP_ERROR",
      "copilot worker returned an unexpected HTTP response",
    ],
    [504, "timeout", "WORKER_TIMEOUT", "copilot worker request timed out"],
  ];

  for (const [status, code, diagnosticCode, message] of cases) {
    const accessed = [];
    const response = new Proxy(
      {},
      {
        get(_target, property) {
          accessed.push(property);

          if (property === "then") {
            return undefined;
          }

          if (property === "status") {
            return status;
          }

          if (property === "ok") {
            return false;
          }

          throw new Error(`unexpected response access: ${String(property)}`);
        },
      }
    );
    const validate = createCopilotWorkerHttpClient({
      baseUrl: "https://worker.example",
      hmacSecret: secret,
      timeoutMs: 1_000,
      fetchImpl: async () => response,
    });
    const result = await validate(token, requestId);
    const serialized = JSON.stringify(result);

    assert.deepEqual(result, {
      ok: false,
      requestId,
      code,
      diagnostic: {
        event: "copilot_worker_transport_error",
        requestId,
        code: diagnosticCode,
        message,
      },
    });
    assert.deepEqual(
      [...new Set(accessed.filter((property) => property !== "then"))].sort(),
      status === 504 ? ["status"] : ["ok", "status"]
    );
    assert.equal(serialized.includes(String(status)), false);
    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes("worker.example"), false);
  }
});

test("allowlists BFF network cause codes and discards raw errors", async () => {
  const allowedCodes = [
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNRESET",
    "ETIMEDOUT",
    "CERT_HAS_EXPIRED",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ];

  for (const causeCode of [...allowedCodes, token]) {
    const validate = createCopilotWorkerHttpClient({
      baseUrl: "https://worker.example",
      hmacSecret: secret,
      timeoutMs: 1_000,
      fetchImpl: async () => {
        throw {
          message: `failed for ${token} at https://private.example`,
          cause: { code: causeCode, headers: { authorization: token } },
        };
      },
    });
    const result = await validate(token, requestId);
    const expectedCauseCode = allowedCodes.includes(causeCode)
      ? causeCode
      : undefined;

    assert.deepEqual(result, {
      ok: false,
      requestId,
      code: "unavailable",
      diagnostic: {
        event: "copilot_worker_transport_error",
        requestId,
        code: "WORKER_NETWORK_ERROR",
        message: "copilot worker could not be reached",
        ...(expectedCauseCode ? { causeCode: expectedCauseCode } : {}),
      },
    });
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(JSON.stringify(result).includes("private.example"), false);
  }
});

test("uses one fixed diagnostic for malformed worker responses", async () => {
  const responseFactories = [
    () =>
      new Response("x", {
        status: 200,
        headers: { "Content-Length": String(256 * 1024 + 1) },
      }),
    () => new Response("{", { status: 200 }),
    () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    () =>
      new Response(
        JSON.stringify({
          ok: false,
          requestId: "d510ccb5-22af-47b5-9280-3b605aac4c69",
          code: "unknown",
        }),
        { status: 200 }
      ),
  ];

  for (const createResponse of responseFactories) {
    const validate = createCopilotWorkerHttpClient({
      baseUrl: "https://worker.example",
      hmacSecret: secret,
      timeoutMs: 1_000,
      fetchImpl: async () => createResponse(),
    });

    assert.deepEqual(await validate(token, requestId), {
      ok: false,
      requestId,
      code: "unknown",
      diagnostic: {
        event: "copilot_worker_transport_error",
        requestId,
        code: "WORKER_INVALID_RESPONSE",
        message: "copilot worker returned an invalid response",
      },
    });
  }
});

test("transports only a redacted diagnostic for unknown validation", async () => {
  const server = createCopilotWorkerServer({
    hmacSecret: secret,
    validate: ({ requestId: receivedRequestId, token: receivedToken }) =>
      validateCopilotCredential({
        token: receivedToken,
        requestId: receivedRequestId,
        timeoutMs: 100,
        createRuntime: async () => ({
          async listModels() {
            throw {
              name: "ResponseError",
              code: -32603,
              status: 418,
              message: `Unexpected ${receivedToken} at https://example.com`,
              stack: receivedToken,
            };
          },
          async close() {},
        }),
      }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const validate = createCopilotWorkerHttpClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      hmacSecret: secret,
      timeoutMs: 1_000,
    });
    const result = await validate(token, requestId);
    const serialized = JSON.stringify(result);

    assert.equal(result.ok, false);
    assert.equal(result.code, "unknown");
    assert.equal(result.diagnostic.event, "copilot_validation_unknown_error");
    assert.equal(result.diagnostic.requestId, requestId);
    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes("example.com"), false);
    assert.equal(serialized.includes("stack"), false);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("transports only allowlisted probe diagnostics for unavailable", async () => {
  const diagnostic = {
    event: "copilot_validation_probe_unavailable",
    requestId,
    code: "GITHUB_CREDENTIAL_PROBE_NETWORK_ERROR",
    message: "github credential probe could not reach GitHub",
    causeCode: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  };
  const server = createCopilotWorkerServer({
    hmacSecret: secret,
    validate: async ({ requestId: receivedRequestId }) => ({
      ok: false,
      requestId: receivedRequestId,
      code: "unavailable",
      diagnostic: { ...diagnostic, requestId: receivedRequestId },
    }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const validate = createCopilotWorkerHttpClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      hmacSecret: secret,
      timeoutMs: 1_000,
    });

    assert.deepEqual(await validate(token, requestId), {
      ok: false,
      requestId,
      code: "unavailable",
      diagnostic,
    });
  } finally {
    server.close();
    await once(server, "close");
  }

  const malformedClient = createCopilotWorkerHttpClient({
    baseUrl: "https://worker.example",
    hmacSecret: secret,
    timeoutMs: 1_000,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          ok: false,
          requestId,
          code: "unavailable",
          diagnostic: {
            ...diagnostic,
            code: "GITHUB_CREDENTIAL_PROBE_NETWORK_ERROR",
            message: `network failed for ${token}`,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      ),
  });

  assert.deepEqual(await malformedClient(token, requestId), {
    ok: false,
    requestId,
    code: "unknown",
    diagnostic: {
      event: "copilot_worker_transport_error",
      requestId,
      code: "WORKER_INVALID_RESPONSE",
      message: "copilot worker returned an invalid response",
    },
  });
});
