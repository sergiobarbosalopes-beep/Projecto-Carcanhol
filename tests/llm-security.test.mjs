import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  decryptLlmCredential,
  encryptLlmCredential,
  parseBase64EncryptionKey,
} from "../src/security/llm-credential-crypto.ts";
import {
  LLM_CREDENTIAL_TYPES,
  LLM_PROVIDERS,
  createLlmAccountSchema,
  getLlmCredentialError,
  isManuallyManagedLlmCredentialType,
  replaceLlmCredentialSchema,
  updateLlmAccountSchema,
} from "../src/admin/llm-validation.ts";

const KEY_BASE64 = Buffer.alloc(32, 7).toString("base64");
const CONTEXT = {
  userId: "1617a876-1788-4c3e-a851-6d5a6f2b8af5",
  accountId: "d510ccb5-22af-47b5-9280-3b605aac4c68",
  provider: "github_copilot",
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
  const credential = `github_pat_${"A".repeat(40)}`;
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

test("legacy GitHub Models envelopes retain their original AAD provider", () => {
  const key = parseBase64EncryptionKey(KEY_BASE64);
  const legacyContext = { ...CONTEXT, provider: "github_models" };
  const encrypted = encryptLlmCredential(
    `github_pat_${"B".repeat(40)}`,
    key,
    "1",
    legacyContext
  );

  assert.doesNotThrow(() =>
    decryptLlmCredential(encrypted, key, legacyContext)
  );
  assert.throws(() => decryptLlmCredential(encrypted, key, CONTEXT));
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

test("uses GitHub Copilot as the canonical provider", () => {
  assert.equal(LLM_PROVIDERS.includes("github_copilot"), true);
  assert.equal(LLM_PROVIDERS.includes("github_models"), false);
  assert.equal(LLM_CREDENTIAL_TYPES.includes("fine_grained_pat"), true);
  assert.equal(LLM_CREDENTIAL_TYPES.includes("oauth_app_user"), true);
  assert.equal(LLM_CREDENTIAL_TYPES.includes("github_app_user"), true);
});

test("accepts only fine-grained PATs for manual GitHub Copilot accounts", () => {
  const validCredential = `github_pat_${"A1_".repeat(12)}`;
  const parsed = createLlmAccountSchema.parse({
    provider: "github_copilot",
    displayName: "GitHub Copilot pessoal",
    credential: validCredential,
    customEndpoint: null,
  });

  assert.equal(parsed.credential, validCredential);

  const invalidCredentials = [
    "ghp_x",
    "gho_x",
    "ghu_x",
    `ghp_${"a".repeat(40)}`,
    `gho_${"a".repeat(40)}`,
    `ghu_${"a".repeat(40)}`,
    `github_pat_${"a".repeat(8)}`,
    `github_pat_${"a".repeat(20)}-invalid`,
    "provider-api-key",
    "not-a-github-token",
  ];

  for (const credential of invalidCredentials) {
    const result = createLlmAccountSchema.safeParse({
      provider: "github_copilot",
      displayName: "GitHub Copilot rejeitado",
      credential,
      customEndpoint: null,
    });

    assert.equal(result.success, false, credential.slice(0, 11));

    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      assert.equal(
        messages.some((message) => message.includes(credential)),
        false
      );
    }
  }

  assert.match(
    getLlmCredentialError("github_copilot", `ghp_${"a".repeat(40)}`) ?? "",
    /classic/
  );
  assert.match(
    getLlmCredentialError("github_copilot", `gho_${"a".repeat(40)}`) ?? "",
    /OAuth/
  );
  assert.match(
    getLlmCredentialError("github_copilot", `ghu_${"a".repeat(40)}`) ?? "",
    /GitHub App/
  );
});

test("keeps future user tokens out of the manual replacement flow", () => {
  assert.equal(isManuallyManagedLlmCredentialType("fine_grained_pat"), true);
  assert.equal(isManuallyManagedLlmCredentialType("api_key"), true);
  assert.equal(isManuallyManagedLlmCredentialType("token"), true);
  assert.equal(isManuallyManagedLlmCredentialType("oauth_app_user"), false);
  assert.equal(isManuallyManagedLlmCredentialType("github_app_user"), false);
  assert.equal(isManuallyManagedLlmCredentialType("oauth"), false);
});

test("preserves API-key behavior for the other providers", () => {
  for (const provider of ["anthropic", "google_gemini", "deepseek"]) {
    assert.equal(
      createLlmAccountSchema.safeParse({
        provider,
        displayName: `${provider} pessoal`,
        credential: "provider-api-key",
        customEndpoint: null,
      }).success,
      true,
      provider
    );
  }
});

test("migration 0004 preserves encrypted AAD before renaming the provider", () => {
  const migration = readFileSync(
    new URL(
      "../database/migrations/0004_github_copilot_provider.sql",
      import.meta.url
    ),
    "utf8"
  );
  const aadBackfill = migration.indexOf("set aad_provider = account.provider");
  const providerRename = migration.indexOf("set provider = 'github_copilot'");

  assert.notEqual(aadBackfill, -1);
  assert.notEqual(providerRename, -1);
  assert.equal(aadBackfill < providerRename, true);
  assert.match(
    migration,
    /where provider = 'github_models';[\s\S]+set provider = 'github_copilot'/
  );
  assert.match(migration, /add column if not exists aad_provider text/);
  assert.match(migration, /provider = 'github_copilot'[\s\S]+fine_grained_pat/);
  assert.match(migration, /oauth_app_user/);
  assert.match(migration, /github_app_user/);
});
