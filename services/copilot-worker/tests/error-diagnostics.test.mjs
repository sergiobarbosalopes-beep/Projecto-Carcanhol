import assert from "node:assert/strict";
import test from "node:test";
import {
  collectCopilotErrorEvidence,
  createSafeUnknownCopilotErrorDiagnostic,
  redactCopilotDiagnosticMessage,
} from "../dist/error-diagnostics.js";
import { copilotValidationResponseSchema } from "../dist/contract.js";

const requestId = "d510ccb5-22af-47b5-9280-3b605aac4c68";
const pat = `github_pat_${"A".repeat(48)}`;
const oauthToken = `gho_${"B".repeat(40)}`;
const appToken = `ghu_${"C".repeat(40)}`;
const classicToken = `ghp_${"D".repeat(40)}`;
const opaque = "E".repeat(80);
const separatedOpaque = "AbCdEfGhIjKlMnO.PqRsTuVwXyZaBcD.EfGhIjKlMnOpQrS";
const colonOpaque = "ab12:cd34:ef56:ab78:cd90:ef12:ab34:cd56";
const schemeRelativeUrl = "//private.example.internal/path";
const bareUrl = "www.private.example/internal/path";
const twoSegmentOpaque = "abcdefghijkl:mnopqrstuvwxyz";
const threeSegmentOpaque = "abcdefgh:ijklmnop:qrstuvwx";
const ipv6Url = "2001:db8::1/private";
const internalHostUrl = "redis-master:6379/private";
const plusSeparatedOpaque = "abcd+efgh+ijkl:mnop+qrst+uvwx";
const percentSeparatedOpaque = "abcd%efgh%ijkl:mnop%qrst%uvwx";

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

  for (const unsafe of [
    separatedOpaque,
    colonOpaque,
    schemeRelativeUrl,
    bareUrl,
    twoSegmentOpaque,
    threeSegmentOpaque,
    ipv6Url,
    internalHostUrl,
    plusSeparatedOpaque,
    percentSeparatedOpaque,
  ]) {
    const redacted = redactCopilotDiagnosticMessage(unsafe);
    assert.notEqual(redacted, unsafe);
    assert.equal(redacted.includes(unsafe), false);
  }
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
        code: separatedOpaque,
        message: schemeRelativeUrl,
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

test("allows generic diagnostics only on correlated unknown responses", () => {
  const diagnostic = createSafeUnknownCopilotErrorDiagnostic(requestId, {
    name: "ResponseError",
    code: -32603,
    message: "Unexpected internal response",
  });

  assert.equal(
    copilotValidationResponseSchema.safeParse({
      ok: false,
      requestId,
      code: "unknown",
      diagnostic,
    }).success,
    true
  );
  assert.equal(
    copilotValidationResponseSchema.safeParse({
      ok: false,
      requestId,
      code: "invalid_token",
      diagnostic,
    }).success,
    false
  );
  assert.equal(
    copilotValidationResponseSchema.safeParse({
      ok: false,
      requestId,
      code: "unknown",
      diagnostic: {
        ...diagnostic,
        requestId: "3bebcccd-5254-40f8-809f-3a14579dba46",
      },
    }).success,
    false
  );
  assert.equal(
    copilotValidationResponseSchema.safeParse({
      ok: false,
      requestId,
      code: "unknown",
      diagnostic: {
        ...diagnostic,
        error: {
          ...diagnostic.error,
          message: "x".repeat(241),
        },
      },
    }).success,
    false
  );
  assert.equal(
    copilotValidationResponseSchema.safeParse({
      ok: false,
      requestId,
      code: "unknown",
      diagnostic: {
        ...diagnostic,
        error: {
          ...diagnostic.error,
          name: colonOpaque,
        },
      },
    }).success,
    false
  );
  assert.equal(
    copilotValidationResponseSchema.safeParse({
      ok: false,
      requestId,
      code: "unknown",
      diagnostic: {
        ...diagnostic,
        error: {
          ...diagnostic.error,
          stringCodes: [separatedOpaque],
        },
      },
    }).success,
    false
  );
  assert.equal(
    copilotValidationResponseSchema.safeParse({
      ok: false,
      requestId,
      code: "unknown",
      diagnostic: {
        ...diagnostic,
        error: {
          ...diagnostic.error,
          message: schemeRelativeUrl,
        },
      },
    }).success,
    false
  );
  assert.equal(
    copilotValidationResponseSchema.safeParse({
      ok: false,
      requestId,
      code: "unknown",
      diagnostic: {
        ...diagnostic,
        error: {
          ...diagnostic.error,
          message: bareUrl,
        },
      },
    }).success,
    false
  );
  for (const unsafeMessage of [
    twoSegmentOpaque,
    threeSegmentOpaque,
    ipv6Url,
    internalHostUrl,
    plusSeparatedOpaque,
    percentSeparatedOpaque,
  ]) {
    assert.equal(
      copilotValidationResponseSchema.safeParse({
        ok: false,
        requestId,
        code: "unknown",
        diagnostic: {
          ...diagnostic,
          error: {
            ...diagnostic.error,
            message: unsafeMessage,
          },
        },
      }).success,
      false,
      unsafeMessage
    );
  }
  for (const unsafeIdentifier of [twoSegmentOpaque, threeSegmentOpaque]) {
    assert.equal(
      copilotValidationResponseSchema.safeParse({
        ok: false,
        requestId,
        code: "unknown",
        diagnostic: {
          ...diagnostic,
          error: {
            ...diagnostic.error,
            name: unsafeIdentifier,
            stringCodes: [unsafeIdentifier],
          },
        },
      }).success,
      false,
      unsafeIdentifier
    );
  }
});

test("allows only fixed probe diagnostics on unavailable responses", () => {
  const networkDiagnostic = {
    event: "copilot_validation_probe_unavailable",
    requestId,
    code: "GITHUB_CREDENTIAL_PROBE_NETWORK_ERROR",
    message: "github credential probe could not reach GitHub",
    causeCode: "SELF_SIGNED_CERT_IN_CHAIN",
  };

  assert.equal(
    copilotValidationResponseSchema.safeParse({
      ok: false,
      requestId,
      code: "unavailable",
      diagnostic: networkDiagnostic,
    }).success,
    true
  );
  assert.equal(
    copilotValidationResponseSchema.safeParse({
      ok: false,
      requestId,
      code: "unavailable",
    }).success,
    true
  );

  for (const diagnostic of [
    {
      ...networkDiagnostic,
      requestId: "3bebcccd-5254-40f8-809f-3a14579dba46",
    },
    { ...networkDiagnostic, causeCode: "UND_ERR_CONNECT_TIMEOUT" },
    { ...networkDiagnostic, status: 503 },
    {
      ...networkDiagnostic,
      message: "network failed at https://api.github.com/user",
    },
    {
      event: "copilot_validation_probe_unavailable",
      requestId,
      code: "GITHUB_CREDENTIAL_PROBE_RATE_LIMITED",
      message: "github credential probe was rate limited",
      causeCode: "ETIMEDOUT",
    },
  ]) {
    assert.equal(
      copilotValidationResponseSchema.safeParse({
        ok: false,
        requestId,
        code: "unavailable",
        diagnostic,
      }).success,
      false
    );
  }

  assert.equal(
    copilotValidationResponseSchema.safeParse({
      ok: false,
      requestId,
      code: "unknown",
      diagnostic: networkDiagnostic,
    }).success,
    false
  );
});
