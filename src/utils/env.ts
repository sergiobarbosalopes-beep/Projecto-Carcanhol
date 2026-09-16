/**
 * Centralized environment variable access with runtime validation.
 *
 * Import from here instead of reading `process.env` directly so that
 * missing/misconfigured variables fail fast with a clear error message.
 */
import "server-only";

import { z } from "zod";
import { parseBase64EncryptionKey } from "@/src/security/llm-credential-crypto";
import { parseWorkerHmacSecret } from "@/services/copilot-worker/src/request-auth";

const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url({
    message: "NEXT_PUBLIC_SUPABASE_URL must be a valid URL",
  }),
});

const authEnvSchema = z.object({
  NEXT_SUPABASE_ANON_KEY: z.string().min(1, {
    message: "NEXT_SUPABASE_ANON_KEY is required",
  }),
});

const databaseEnvSchema = z.object({
  SUPABASE_SCHEMA: z
    .string()
    .regex(/^carcanhol(?:_[a-z0-9_]{1,40})?$/, {
      message:
        "SUPABASE_SCHEMA must be carcanhol or an isolated carcanhol_* preview schema",
    })
    .default("carcanhol"),
});

const encryptionKeySchema = z.string().transform((value, context) => {
  try {
    return parseBase64EncryptionKey(value);
  } catch {
    context.addIssue({
      code: "custom",
      message:
        "LLM_CREDENTIAL_ENCRYPTION_KEY must be canonical base64 for exactly 32 bytes",
    });
    return z.NEVER;
  }
});

const serverEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, {
    message: "SUPABASE_SERVICE_ROLE_KEY is required",
  }),
  SUPABASE_SCHEMA: databaseEnvSchema.shape.SUPABASE_SCHEMA,
  LLM_CREDENTIAL_ENCRYPTION_KEY: encryptionKeySchema,
  LLM_CREDENTIAL_ENCRYPTION_KEY_VERSION: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/, {
      message:
        "LLM_CREDENTIAL_ENCRYPTION_KEY_VERSION must be a safe 1-32 character identifier",
    })
    .default("1"),
});

const copilotWorkerUrlSchema = z.string().transform((value, context) => {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    context.addIssue({
      code: "custom",
      message: "COPILOT_WORKER_URL must be an absolute URL",
    });
    return z.NEVER;
  }

  const localDevelopmentUrl =
    process.env.NODE_ENV !== "production" &&
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(url.hostname);

  if (
    (url.protocol !== "https:" && !localDevelopmentUrl) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    context.addIssue({
      code: "custom",
      message:
        "COPILOT_WORKER_URL must be an HTTPS origin without credentials, path, query, or fragment",
    });
    return z.NEVER;
  }

  return url.origin;
});

const workerHmacSecretSchema = z.string().transform((value, context) => {
  try {
    return parseWorkerHmacSecret(value);
  } catch {
    context.addIssue({
      code: "custom",
      message:
        "COPILOT_WORKER_HMAC_SECRET must be canonical base64 for 32-64 bytes",
    });
    return z.NEVER;
  }
});

const copilotWorkerEnvSchema = z.object({
  COPILOT_WORKER_URL: copilotWorkerUrlSchema,
  COPILOT_WORKER_HMAC_SECRET: workerHmacSecretSchema,
  COPILOT_WORKER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(25_000)
    .max(90_000)
    .default(60_000),
});

/** Environment variables that are safe to expose to the browser. */
export function getPublicEnv() {
  const parsed = publicEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  });

  if (!parsed.success) {
    throw new Error(
      `Invalid public environment variables: ${parsed.error.message}`
    );
  }

  return parsed.data;
}

/** Supabase anon credential used exclusively by server-side auth clients. */
export function getAuthEnv() {
  const parsed = authEnvSchema.safeParse({
    NEXT_SUPABASE_ANON_KEY: process.env.NEXT_SUPABASE_ANON_KEY,
  });

  if (!parsed.success) {
    throw new Error(
      `Invalid authentication environment variables: ${parsed.error.message}`
    );
  }

  return parsed.data;
}

/** Allowlisted PostgREST schema used by both authenticated and service clients. */
export function getDatabaseEnv() {
  const parsed = databaseEnvSchema.safeParse({
    SUPABASE_SCHEMA: process.env.SUPABASE_SCHEMA,
  });

  if (!parsed.success) {
    throw new Error(
      `Invalid database environment variables: ${parsed.error.message}`
    );
  }

  return parsed.data;
}

/**
 * Environment variables that must never reach the browser bundle.
 * Only call this from server-side code (Route Handlers, Server Components,
 * Server Actions, middleware).
 */
export function getServerEnv() {
  const parsed = serverEnvSchema.safeParse({
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_SCHEMA: process.env.SUPABASE_SCHEMA,
    LLM_CREDENTIAL_ENCRYPTION_KEY: process.env.LLM_CREDENTIAL_ENCRYPTION_KEY,
    LLM_CREDENTIAL_ENCRYPTION_KEY_VERSION:
      process.env.LLM_CREDENTIAL_ENCRYPTION_KEY_VERSION,
  });

  if (!parsed.success) {
    throw new Error(
      `Invalid server environment variables: ${parsed.error.message}`
    );
  }

  return parsed.data;
}

/** Connection details for the isolated Copilot runtime worker. */
export function getCopilotWorkerEnv() {
  const parsed = copilotWorkerEnvSchema.safeParse({
    COPILOT_WORKER_URL: process.env.COPILOT_WORKER_URL,
    COPILOT_WORKER_HMAC_SECRET: process.env.COPILOT_WORKER_HMAC_SECRET,
    COPILOT_WORKER_TIMEOUT_MS: process.env.COPILOT_WORKER_TIMEOUT_MS,
  });

  if (!parsed.success) {
    throw new Error(
      `Invalid Copilot worker environment variables: ${parsed.error.message}`
    );
  }

  return parsed.data;
}
