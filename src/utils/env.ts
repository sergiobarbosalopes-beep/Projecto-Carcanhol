/**
 * Centralized environment variable access with runtime validation.
 *
 * Import from here instead of reading `process.env` directly so that
 * missing/misconfigured variables fail fast with a clear error message.
 */
import "server-only";

import { z } from "zod";

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

const serverEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, {
    message: "SUPABASE_SERVICE_ROLE_KEY is required",
  }),
  SUPABASE_SCHEMA: z.string().min(1).default("carcanhol"),
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

/**
 * Environment variables that must never reach the browser bundle.
 * Only call this from server-side code (Route Handlers, Server Components,
 * Server Actions, middleware).
 */
export function getServerEnv() {
  const parsed = serverEnvSchema.safeParse({
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_SCHEMA: process.env.SUPABASE_SCHEMA,
  });

  if (!parsed.success) {
    throw new Error(
      `Invalid server environment variables: ${parsed.error.message}`
    );
  }

  return parsed.data;
}
