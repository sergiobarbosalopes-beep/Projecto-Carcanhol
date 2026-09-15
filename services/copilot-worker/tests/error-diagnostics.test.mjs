import assert from "node:assert/strict";
import test from "node:test";
import {
  collectCopilotErrorEvidence,
  createSafeUnknownCopilotErrorDiagnostic,
  redactCopilotDiagnosticMessage,
} from "../dist/error-diagnostics.js";

const requestId = "d510ccb5-22af-47b5-9280-3b605aac4c68";
const pat = `github_pat_${"A".repeat(48)}`;
const oauthToken = `gho_${"B".repeat(40)}`;
const appToken = `ghu_${"C".repeat(40)}`;
const classicToken = `ghp_${"D".repeat(40)}`;
const opaque = "E".repeat(80);

test("redacts secrets, URLs, headers, payloads, and opaque sequences", () => {
  const message = [
    `request failed; Authorization: Bearer ${pat};`,
    `fallback Basic ${opaque};`,
    `url=https://user:password@example.com/path?token=${oauthToken};`,
    `payload='{"token":"${appToken}","value":"private"}';`,
    `classic=${classicToken}; opaque=${opaque}`,
  ].join(" ");
  const sanitized = redactCopilotDiagnosticMessage(message);

  for (const forbidden of [
    "github_pat_",
    "gho_",
    "ghu_",
    "ghp_",
    "Authorization",
    "Bearer",
    "Basic",
    "example.com",
    "private",
    opaque,
  ]) {
    assert.equal(sanitized.includes(forbidden), false, forbidden);
  }

  assert.match(sanitized, /\[(?:auth|url|quoted|opaque)\]/);
  assert.equal(Array.from(sanitized).length <= 240, true);
});

test("builds only the bounded allowlisted diagnostic shape", () => {
  const error = {
    name: pat,
    code: classicToken,
    status: 409,
    message: `Unknown failure at https://example.com with ${opaque}`,
    stack: `stack contains ${pat}`,
    requestBody: { token: pat },
    environment: { GITHUB_TOKEN: pat },
    data: {
      code: "SDK_UNKNOWN",
      statusCode: 429,
      payload: pat,
      opaqueCode: opaque,
    },
    cause: {
      code: -32001,
      message: "nested detail",
      cause: {
        code: opaque,
        message: "opaque code",
      },
    },
  };
  const diagnostic = createSafeUnknownCopilotErrorDiagnostic(requestId, error);
  const serialized = JSON.stringify(diagnostic);

  assert.deepEqual(Object.keys(diagnostic), ["event", "requestId", "error"]);
  assert.deepEqual(Object.keys(diagnostic.error), [
    "constructor",
    "name",
    "stringCodes",
    "numericCodes",
    "statuses",
    "message",
  ]);
  assert.equal(diagnostic.event, "copilot_validation_unknown_error");
  assert.equal(diagnostic.requestId, requestId);
  assert.equal(diagnostic.error.constructor, "Object");
  assert.equal(diagnostic.error.name, "unknown");
  assert.deepEqual(diagnostic.error.stringCodes, ["SDK_UNKNOWN"]);
  assert.deepEqual(diagnostic.error.numericCodes, [-32001]);
  assert.deepEqual(diagnostic.error.statuses, [409, 429]);
  assert.equal(diagnostic.error.message.length <= 240, true);
  assert.equal(serialized.includes(pat), false);
  assert.equal(serialized.includes("requestBody"), false);
  assert.equal(serialized.includes("environment"), false);
  assert.equal(serialized.includes("stack"), false);
  assert.equal(serialized.length < 1_024, true);
});

test("handles hostile getters and overlong messages without leaking", () => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error(pat);
      },
    }
  );

  assert.doesNotThrow(() => collectCopilotErrorEvidence(hostile));
  assert.deepEqual(
    createSafeUnknownCopilotErrorDiagnostic("not-a-request-id", hostile),
    {
      event: "copilot_validation_unknown_error",
      requestId: "unknown",
      error: {
        constructor: "unknown",
        name: "unknown",
        stringCodes: [],
        numericCodes: [],
        statuses: [],
        message: "unavailable",
      },
    }
  );
  assert.equal(
    redactCopilotDiagnosticMessage("safe ".repeat(1_000)),
    "unavailable"
  );
});
