import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createCopilotWorkerHttpClient } from "../dist/http-client.js";
import { validateCopilotCredential } from "../dist/runtime.js";
import { createCopilotWorkerServer } from "../dist/server.js";

const secret = Buffer.alloc(32, 29);
const token = `github_pat_${"C".repeat(40)}`;
const requestId = "3bebcccd-5254-40f8-809f-3a14579dba46";

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
  });
  assert.deepEqual(await malformedClient(token, requestId), {
    ok: false,
    requestId,
    code: "unknown",
  });
  assert.deepEqual(await deadlineClient(token, requestId), {
    ok: false,
    requestId,
    code: "timeout",
  });
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
