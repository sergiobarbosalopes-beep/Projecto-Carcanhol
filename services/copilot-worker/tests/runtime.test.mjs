import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCopilotError,
  sanitizeCopilotModels,
  validateCopilotCredential,
} from "../dist/runtime.js";

const requestId = "d510ccb5-22af-47b5-9280-3b605aac4c68";
const token = `github_pat_${"S".repeat(40)}`;
const sessionBuilderError = {
  name: "ResponseError",
  code: -32603,
  status: 403,
  message:
    "SDK session authentication failed: network fetch failed: request failed: builder error",
  data: { code: "UNCLASSIFIED_PROVIDER_CODE" },
};

test("sanitizes and bounds the official model metadata fields", () => {
  const models = sanitizeCopilotModels([
    {
      id: "gpt-5",
      name: "GPT-5",
      capabilities: {
        supports: { vision: true, reasoningEffort: true, ignored: "secret" },
        limits: {
          max_prompt_tokens: 128_000,
          max_context_window_tokens: 256_000,
        },
      },
      policy: { state: "enabled", terms: "not persisted" },
      billing: { multiplier: 2, tokenPrices: { raw: "not persisted" } },
      arbitrary: { payload: "not persisted" },
    },
    { id: "gpt-5", name: "Duplicate" },
    { id: "", name: "Invalid" },
  ]);

  assert.deepEqual(models, [
    {
      id: "gpt-5",
      displayName: "GPT-5",
      capabilities: {
        supportsVision: true,
        supportsReasoningEffort: true,
        maxPromptTokens: 128_000,
        maxContextWindowTokens: 256_000,
      },
      policy: { state: "enabled" },
      billing: { multiplier: 2 },
    },
  ]);
  assert.equal(JSON.stringify(models).includes("not persisted"), false);
});

test("validates with a mock runtime and always closes it", async () => {
  let closed = false;
  const result = await validateCopilotCredential({
    token,
    requestId,
    timeoutMs: 100,
    createRuntime: async (receivedToken) => {
      assert.equal(receivedToken, token);
      return {
        async listModels() {
          return [
            {
              id: "claude-sonnet",
              name: "Claude Sonnet",
              capabilities: {
                supports: { vision: false, reasoningEffort: true },
                limits: { max_context_window_tokens: 200_000 },
              },
              policy: { state: "enabled" },
            },
          ];
        },
        async close() {
          closed = true;
        },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(closed, true);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("rejects a catalog blocked by explicit model policy", async () => {
  const result = await validateCopilotCredential({
    token,
    requestId,
    timeoutMs: 100,
    createRuntime: async () => ({
      async listModels() {
        return [
          {
            id: "blocked-model",
            name: "Blocked",
            capabilities: {},
            policy: { state: "disabled" },
          },
        ];
      },
      async close() {},
    }),
  });

  assert.deepEqual(result, {
    ok: false,
    requestId,
    code: "org_policy_blocked",
  });
});

test("does not infer a policy block from an unconfigured model", async () => {
  const result = await validateCopilotCredential({
    token,
    requestId,
    timeoutMs: 100,
    createRuntime: async () => ({
      async listModels() {
        return [
          {
            id: "unconfigured-model",
            name: "Unconfigured",
            capabilities: {},
            policy: { state: "unconfigured" },
          },
        ];
      },
      async close() {},
    }),
  });

  assert.equal(result.ok, true);
});

test("maps only explicit error evidence and treats a generic 403 as unknown", () => {
  assert.equal(classifyCopilotError({ status: 401 }), "invalid_token");
  assert.equal(
    classifyCopilotError({
      code: -32603,
      message: "Not authenticated",
    }),
    "invalid_token"
  );
  assert.equal(
    classifyCopilotError({
      name: "ResponseError",
      code: -32603,
      message:
        "SDK session authentication failed: Failed to fetch Copilot user info: 401 Unauthorized",
    }),
    "invalid_token"
  );
  assert.equal(
    classifyCopilotError({
      name: "ResponseError",
      code: -32603,
      message:
        "SDK session authentication failed: Failed to fetch Copilot user info: 500 Internal Server Error",
    }),
    "unknown"
  );
  assert.equal(
    classifyCopilotError({
      code: -32603,
      message: "Internal error",
    }),
    "unknown"
  );
  assert.equal(
    classifyCopilotError({ message: "Not authenticated" }),
    "unknown"
  );
  assert.equal(
    classifyCopilotError({ code: "NO_COPILOT_SUBSCRIPTION" }),
    "no_subscription"
  );
  assert.equal(
    classifyCopilotError({
      code: -32603,
      message: "Internal error",
      data: { code: "NO_COPILOT_SUBSCRIPTION" },
    }),
    "no_subscription"
  );
  assert.equal(
    classifyCopilotError({
      code: -32603,
      message: "Internal error",
      data: { code: -32603, message: "Not authenticated" },
    }),
    "invalid_token"
  );
  assert.equal(
    classifyCopilotError({ code: "COPILOT_POLICY_BLOCKED" }),
    "org_policy_blocked"
  );
  assert.equal(classifyCopilotError({ status: 403 }), "unknown");
  assert.equal(classifyCopilotError({ code: "ENOTFOUND" }), "unavailable");
});

test("maps a real listModels authentication rejection and still closes", async () => {
  let closed = false;
  let diagnosticCalls = 0;
  const result = await validateCopilotCredential({
    token,
    requestId,
    timeoutMs: 100,
    createRuntime: async () => ({
      async listModels() {
        throw {
          code: -32603,
          message: "Not authenticated",
        };
      },
      async close() {
        closed = true;
      },
    }),
    onUnknownError() {
      diagnosticCalls += 1;
    },
  });

  assert.deepEqual(result, { ok: false, requestId, code: "invalid_token" });
  assert.equal(closed, true);
  assert.equal(diagnosticCalls, 0);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("maps a session authentication rejection and still closes", async () => {
  let closed = false;
  let diagnosticCalls = 0;
  const result = await validateCopilotCredential({
    token,
    requestId,
    timeoutMs: 100,
    createRuntime: async () => ({
      async listModels() {
        throw {
          name: "ResponseError",
          code: -32603,
          message:
            "SDK session authentication failed: Failed to fetch Copilot user info: 401 Unauthorized",
        };
      },
      async close() {
        closed = true;
      },
    }),
    onUnknownError() {
      diagnosticCalls += 1;
    },
  });

  assert.deepEqual(result, { ok: false, requestId, code: "invalid_token" });
  assert.equal(closed, true);
  assert.equal(diagnosticCalls, 0);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("uses the fixed credential probe only for the exact session builder error", async () => {
  let probeCalls = 0;
  let closed = false;
  const result = await validateCopilotCredential({
    token,
    requestId,
    timeoutMs: 100,
    createRuntime: async () => ({
      async listModels() {
        throw sessionBuilderError;
      },
      async close() {
        closed = true;
      },
    }),
    async probeCredential(receivedToken, signal) {
      probeCalls += 1;
      assert.equal(receivedToken, token);
      assert.equal(signal.aborted, false);
      return { outcome: "valid" };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "unknown");
  assert.deepEqual(result.diagnostic.error.stringCodes, [
    "GITHUB_CREDENTIAL_PROBE_SUCCEEDED",
  ]);
  assert.deepEqual(result.diagnostic.error.statuses, []);
  assert.equal(
    result.diagnostic.error.message,
    "github credential probe succeeded; Copilot runtime transport failed"
  );
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(probeCalls, 1);
  assert.equal(closed, true);

  const otherResult = await validateCopilotCredential({
    token,
    requestId,
    timeoutMs: 100,
    createRuntime: async () => ({
      async listModels() {
        throw {
          code: -32603,
          message: "network fetch failed: request failed: builder error",
        };
      },
      async close() {},
    }),
    async probeCredential() {
      probeCalls += 1;
      return { outcome: "invalid_token" };
    },
  });

  assert.equal(otherResult.ok, false);
  assert.equal(otherResult.code, "unknown");
  assert.equal(probeCalls, 1);

  const authenticationResult = await validateCopilotCredential({
    token,
    requestId,
    timeoutMs: 100,
    createRuntime: async () => ({
      async listModels() {
        throw {
          code: -32603,
          message:
            "SDK session authentication failed: Failed to fetch Copilot user info: 401 Unauthorized",
        };
      },
      async close() {},
    }),
    async probeCredential() {
      probeCalls += 1;
      return { outcome: "valid" };
    },
  });

  assert.equal(authenticationResult.ok, false);
  assert.equal(authenticationResult.code, "invalid_token");
  assert.equal(probeCalls, 1);

  const wrappedResult = await validateCopilotCredential({
    token,
    requestId,
    timeoutMs: 100,
    createRuntime: async () => ({
      async listModels() {
        throw {
          code: -32603,
          message: `Request session.create failed with message: ${sessionBuilderError.message}`,
        };
      },
      async close() {},
    }),
    async probeCredential() {
      probeCalls += 1;
      return { outcome: "forbidden" };
    },
  });

  assert.equal(wrappedResult.ok, false);
  assert.equal(wrappedResult.code, "unknown");
  assert.deepEqual(wrappedResult.diagnostic.error.stringCodes, [
    "GITHUB_CREDENTIAL_PROBE_FORBIDDEN",
  ]);
  assert.deepEqual(wrappedResult.diagnostic.error.statuses, []);
  assert.equal(
    wrappedResult.diagnostic.error.message,
    "github credential probe forbidden; Copilot runtime transport failed"
  );
  assert.equal(probeCalls, 2);
});

test("maps credential probe outcomes without inferring entitlement", async () => {
  const cases = [
    {
      probeResult: { outcome: "invalid_token" },
      expectedCode: "invalid_token",
    },
    {
      probeResult: { outcome: "forbidden" },
      expectedCode: "unknown",
      expectedDiagnosticCode: "GITHUB_CREDENTIAL_PROBE_FORBIDDEN",
      expectedMessage:
        "github credential probe forbidden; Copilot runtime transport failed",
    },
    {
      probeResult: { outcome: "timeout" },
      expectedCode: "timeout",
    },
    {
      probeResult: { outcome: "unavailable" },
      expectedCode: "unavailable",
    },
    {
      probeResult: { outcome: "unknown" },
      expectedCode: "unknown",
      expectedDiagnosticCode: "GITHUB_CREDENTIAL_PROBE_UNEXPECTED_STATUS",
      expectedMessage:
        "github credential probe returned an unexpected status; Copilot runtime transport failed",
    },
  ];

  for (const {
    probeResult,
    expectedCode,
    expectedDiagnosticCode,
    expectedMessage,
  } of cases) {
    const result = await validateCopilotCredential({
      token,
      requestId,
      timeoutMs: 100,
      createRuntime: async () => ({
        async listModels() {
          throw sessionBuilderError;
        },
        async close() {},
      }),
      async probeCredential() {
        return probeResult;
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, expectedCode);
    if (expectedDiagnosticCode) {
      assert.equal(
        result.diagnostic?.error.stringCodes.includes(expectedDiagnosticCode),
        true
      );
      assert.deepEqual(result.diagnostic?.error.statuses, []);
      assert.equal(result.diagnostic?.error.message, expectedMessage);
    } else {
      assert.equal(result.diagnostic, undefined);
    }
    assert.equal(JSON.stringify(result).includes(token), false);
  }
});

test("fails closed when an injected credential probe throws", async () => {
  const result = await validateCopilotCredential({
    token,
    requestId,
    timeoutMs: 100,
    createRuntime: async () => ({
      async listModels() {
        throw sessionBuilderError;
      },
      async close() {},
    }),
    async probeCredential() {
      throw new Error(`probe failed for ${token}`);
    },
  });

  assert.deepEqual(result, { ok: false, requestId, code: "unavailable" });
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("emits bounded internal diagnostics only for unknown errors", async () => {
  let diagnostic;
  const result = await validateCopilotCredential({
    token,
    requestId,
    timeoutMs: 100,
    createRuntime: async () => ({
      async listModels() {
        throw {
          name: "ResponseError",
          code: -32603,
          status: 418,
          message: `Unexpected response for ${token} at https://example.com`,
          stack: token,
        };
      },
      async close() {},
    }),
    onUnknownError(value) {
      diagnostic = value;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.requestId, requestId);
  assert.equal(result.code, "unknown");
  assert.equal(result.diagnostic, diagnostic);
  assert.equal(diagnostic.event, "copilot_validation_unknown_error");
  assert.equal(diagnostic.requestId, requestId);
  assert.equal(diagnostic.error.name, "ResponseError");
  assert.deepEqual(diagnostic.error.numericCodes, [-32603]);
  assert.deepEqual(diagnostic.error.statuses, [418]);
  assert.equal(JSON.stringify(diagnostic).includes(token), false);
  assert.equal(JSON.stringify(diagnostic).includes("example.com"), false);
});

test("returns a sanitized timeout and closes a stalled runtime", async () => {
  let closed = false;
  const result = await validateCopilotCredential({
    token,
    requestId,
    timeoutMs: 10,
    createRuntime: async () => ({
      listModels: async () => new Promise(() => {}),
      async close() {
        closed = true;
      },
    }),
  });

  assert.deepEqual(result, { ok: false, requestId, code: "timeout" });
  assert.equal(closed, true);
});

test("closes a runtime that resolves only after startup timed out", async () => {
  let releaseRuntime;
  let closed = false;
  const pendingValidation = validateCopilotCredential({
    token,
    requestId,
    timeoutMs: 10,
    createRuntime: async () =>
      new Promise((resolve) => {
        releaseRuntime = resolve;
      }),
  });
  const result = await pendingValidation;

  assert.deepEqual(result, { ok: false, requestId, code: "timeout" });
  releaseRuntime({
    async listModels() {
      return [];
    },
    async close() {
      closed = true;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closed, true);
});
