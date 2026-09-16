import { z } from "zod";
import { parseWorkerHmacSecret } from "./request-auth";

const hmacSecretSchema = z.string().transform((value, context) => {
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

const redisUrlSchema = z
  .string()
  .url()
  .refine((value) => ["redis:", "rediss:"].includes(new URL(value).protocol), {
    message: "COPILOT_REPLAY_REDIS_URL must use redis:// or rediss://",
  })
  .optional();

const workerEnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  COPILOT_WORKER_HMAC_SECRET: hmacSecretSchema,
  COPILOT_VALIDATION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(15_000)
    .default(15_000),
  COPILOT_INFERENCE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(25_000)
    .default(20_000),
  COPILOT_WORKER_CLOCK_SKEW_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(120_000)
    .default(30_000),
  COPILOT_WORKER_MAX_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(8)
    .default(2),
  COPILOT_WORKER_MAX_QUEUE: z.coerce.number().int().min(0).max(100).default(8),
  COPILOT_REPLAY_REDIS_URL: redisUrlSchema,
  COPILOT_REPLAY_REDIS_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9:_-]{1,64}$/)
    .default("carcanhol:copilot-replay:"),
  COPILOT_REPLAY_STORE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(5_000)
    .default(1_000),
});

export function getWorkerConfig() {
  return parseWorkerConfig(process.env, process.env.NODE_ENV);
}

export function parseWorkerConfig(
  environment: NodeJS.ProcessEnv,
  nodeEnvironment?: string
) {
  assertWorkerEnvironmentIsolated(environment);
  const parsed = workerEnvSchema.safeParse({
    PORT: environment.PORT,
    COPILOT_WORKER_HMAC_SECRET: environment.COPILOT_WORKER_HMAC_SECRET,
    COPILOT_VALIDATION_TIMEOUT_MS: environment.COPILOT_VALIDATION_TIMEOUT_MS,
    COPILOT_INFERENCE_TIMEOUT_MS: environment.COPILOT_INFERENCE_TIMEOUT_MS,
    COPILOT_WORKER_CLOCK_SKEW_MS: environment.COPILOT_WORKER_CLOCK_SKEW_MS,
    COPILOT_WORKER_MAX_CONCURRENCY: environment.COPILOT_WORKER_MAX_CONCURRENCY,
    COPILOT_WORKER_MAX_QUEUE: environment.COPILOT_WORKER_MAX_QUEUE,
    COPILOT_REPLAY_REDIS_URL: environment.COPILOT_REPLAY_REDIS_URL,
    COPILOT_REPLAY_REDIS_PREFIX: environment.COPILOT_REPLAY_REDIS_PREFIX,
    COPILOT_REPLAY_STORE_TIMEOUT_MS:
      environment.COPILOT_REPLAY_STORE_TIMEOUT_MS,
  });

  if (!parsed.success) {
    throw new Error(
      `Invalid Copilot worker environment variables: ${parsed.error.message}`
    );
  }

  if (
    nodeEnvironment === "production" &&
    !parsed.data.COPILOT_REPLAY_REDIS_URL
  ) {
    throw new Error(
      "COPILOT_REPLAY_REDIS_URL is required in production for cross-instance replay protection."
    );
  }

  return parsed.data;
}

export function assertWorkerEnvironmentIsolated(
  environment: NodeJS.ProcessEnv
) {
  const forbiddenVariables = [
    "LLM_CREDENTIAL_ENCRYPTION_KEY",
    "NEXT_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const forbidden = forbiddenVariables.find((name) => environment[name]);

  if (forbidden) {
    throw new Error(
      `Forbidden environment variable configured for Copilot worker: ${forbidden}`
    );
  }
}
