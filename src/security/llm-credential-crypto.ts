import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const LLM_CREDENTIAL_ALGORITHM = "aes-256-gcm" as const;
export const LLM_CREDENTIAL_ENVELOPE_VERSION = 1 as const;

const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export type LlmCredentialContext = {
  userId: string;
  accountId: string;
  provider: string;
};

export type EncryptedLlmCredential = {
  ciphertext: string;
  nonce: string;
  authTag: string;
  algorithm: typeof LLM_CREDENTIAL_ALGORITHM;
  envelopeVersion: typeof LLM_CREDENTIAL_ENVELOPE_VERSION;
  keyVersion: string;
};

export function parseBase64EncryptionKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error("Encryption key must be canonical base64.");
  }

  const key = Buffer.from(value, "base64");

  if (key.byteLength !== KEY_BYTES || key.toString("base64") !== value) {
    throw new Error("Encryption key must decode to exactly 32 bytes.");
  }

  return key;
}

export function encryptLlmCredential(
  credential: string,
  key: Uint8Array,
  keyVersion: string,
  context: LlmCredentialContext
): EncryptedLlmCredential {
  assertKeyLength(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(LLM_CREDENTIAL_ALGORITHM, key, nonce);
  cipher.setAAD(additionalAuthenticatedData(context));

  const ciphertext = Buffer.concat([
    cipher.update(credential, "utf8"),
    cipher.final(),
  ]);

  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    algorithm: LLM_CREDENTIAL_ALGORITHM,
    envelopeVersion: LLM_CREDENTIAL_ENVELOPE_VERSION,
    keyVersion,
  };
}

export function decryptLlmCredential(
  encrypted: EncryptedLlmCredential,
  key: Uint8Array,
  context: LlmCredentialContext
): string {
  assertKeyLength(key);

  if (
    encrypted.algorithm !== LLM_CREDENTIAL_ALGORITHM ||
    encrypted.envelopeVersion !== LLM_CREDENTIAL_ENVELOPE_VERSION
  ) {
    throw new Error("Unsupported credential envelope.");
  }

  const decipher = createDecipheriv(
    encrypted.algorithm,
    key,
    Buffer.from(encrypted.nonce, "base64")
  );
  decipher.setAAD(additionalAuthenticatedData(context));
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function additionalAuthenticatedData(context: LlmCredentialContext) {
  return Buffer.from(
    [
      "carcanhol",
      "llm-credential",
      `v${LLM_CREDENTIAL_ENVELOPE_VERSION}`,
      context.userId,
      context.accountId,
      context.provider,
    ].join(":"),
    "utf8"
  );
}

function assertKeyLength(key: Uint8Array) {
  if (key.byteLength !== KEY_BYTES) {
    throw new Error("AES-256-GCM requires a 32-byte key.");
  }
}
