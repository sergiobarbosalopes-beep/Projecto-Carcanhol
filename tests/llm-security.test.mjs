import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptLlmCredential,
  encryptLlmCredential,
  parseBase64EncryptionKey,
} from "../src/security/llm-credential-crypto.ts";
import {
  createLlmAccountSchema,
  replaceLlmCredentialSchema,
  updateLlmAccountSchema,
} from "../src/admin/llm-validation.ts";

const KEY_BASE64 = Buffer.alloc(32, 7).toString("base64");
const CONTEXT = {
  userId: "1617a876-1788-4c3e-a851-6d5a6f2b8af5",
  accountId: "d510ccb5-22af-47b5-9280-3b605aac4c68",
  provider: "github_models",
};

test("accepts only a canonical base64 32-byte encryption key", () => {
  assert.deepEqual(parseBase64EncryptionKey(KEY_BASE64), Buffer.alloc(32, 7));
  assert.throws(() => parseBase64EncryptionKey("not-base64"));
  assert.throws(() =>
    parseBase64EncryptionKey(Buffer.alloc(31).toString("base64"))
  );
  assert.throws(() => parseBase64EncryptionKey(`${KEY_BASE64.slice(0, -1)}A`));
});

test("AES-256-GCM round-trips and authenticates account context", () => {
  const key = parseBase64EncryptionKey(KEY_BASE64);
  const credential = "github_pat_dedicated_example";
  const encrypted = encryptLlmCredential(credential, key, "2026-09", CONTEXT);

  assert.equal(encrypted.algorithm, "aes-256-gcm");
  assert.equal(encrypted.envelopeVersion, 1);
  assert.equal(encrypted.keyVersion, "2026-09");
  assert.notEqual(encrypted.ciphertext, credential);
  assert.equal(decryptLlmCredential(encrypted, key, CONTEXT), credential);
  assert.throws(() =>
    decryptLlmCredential(encrypted, key, {
      ...CONTEXT,
      accountId: "adbf1647-c30d-4b1a-bb5e-2d64b71b04f8",
    })
  );
});

test("AES-256-GCM rejects a modified authentication tag", () => {
  const key = parseBase64EncryptionKey(KEY_BASE64);
  const encrypted = encryptLlmCredential(
    "sk-ant-example-secret",
    key,
    "1",
    CONTEXT
  );
  const tag = Buffer.from(encrypted.authTag, "base64");
  tag[0] ^= 1;

  assert.throws(() =>
    decryptLlmCredential(
      { ...encrypted, authTag: tag.toString("base64") },
      key,
      CONTEXT
    )
  );
});

test("validates provider-specific endpoints without accepting headers", () => {
  const validEndpoints = [
    ["https://a.example.com", "https://a.example.com"],
    ["https://a.example.com/", "https://a.example.com"],
    ["https://a.example.com/v1/", "https://a.example.com/v1"],
    [
      "https://a.example.com:8443/provider/v1",
      "https://a.example.com:8443/provider/v1",
    ],
  ];

  for (const [input, expected] of validEndpoints) {
    const parsed = createLlmAccountSchema.parse({
      provider: "openai_compatible",
      displayName: "Fornecedor custom",
      credential: "custom-api-key",
      customEndpoint: input,
    });

    assert.equal(parsed.customEndpoint, expected);
  }

  const invalidEndpoints = [
    "http://a.example.com/v1",
    "https://a.example.com/v1?",
    "https://a.example.com/v1?model=x",
    "https://a.example.com/v1#",
    "https://a.example.com/v1#models",
    "https://user:password@a.example.com/v1",
    "https://a.example.com/v1@beta",
    " https://a.example.com/v1",
    "https://a.example.com/v1 ",
    "https://a.example.com/v 1",
  ];

  for (const customEndpoint of invalidEndpoints) {
    assert.equal(
      createLlmAccountSchema.safeParse({
        provider: "openai_compatible",
        displayName: "Endpoint rejeitado antes da BD",
        credential: "custom-api-key",
        customEndpoint,
      }).success,
      false,
      customEndpoint
    );
  }

  assert.equal(
    createLlmAccountSchema.safeParse({
      provider: "anthropic",
      displayName: "Endpoint indevido",
      credential: "anthropic-api-key",
      customEndpoint: "https://llm.example.com",
    }).success,
    false
  );
  assert.equal(
    createLlmAccountSchema.safeParse({
      provider: "openai_compatible",
      displayName: "Payload extra",
      credential: "custom-api-key",
      customEndpoint: "https://llm.example.com",
      headers: { Authorization: "secret" },
    }).success,
    false
  );
});

test("never accepts credentials with whitespace or credential fields on edit", () => {
  assert.equal(
    replaceLlmCredentialSchema.safeParse({
      credential: "secret with spaces",
    }).success,
    false
  );
  assert.equal(
    replaceLlmCredentialSchema.safeParse({
      credential: "secret-with-newline\n",
    }).success,
    false
  );
  assert.equal(
    updateLlmAccountSchema.safeParse({
      displayName: "Nome editado",
      customEndpoint: null,
      credential: "must-not-be-accepted",
    }).success,
    false
  );
});
