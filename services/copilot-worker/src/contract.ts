import { z } from "zod";

export const COPILOT_VALIDATION_PATH = "/v1/copilot/validate";
export const COPILOT_HEALTH_PATH = "/health";
export const COPILOT_WORKER_MAX_BODY_BYTES = 8 * 1024;
export const COPILOT_WORKER_MAX_RESPONSE_BYTES = 256 * 1024;
export const COPILOT_WORKER_MAX_MODELS = 100;
export const COPILOT_TOKEN_MAX_LENGTH = 4096;

export const COPILOT_WORKER_HEADERS = {
  bodySha256: "x-carcanhol-content-sha256",
  requestId: "x-carcanhol-request-id",
  signature: "x-carcanhol-signature",
  timestamp: "x-carcanhol-timestamp",
} as const;

export const copilotValidationErrorCodes = [
  "invalid_token",
  "no_subscription",
  "org_policy_blocked",
  "timeout",
  "unavailable",
  "no_models",
  "unknown",
] as const;

export type CopilotValidationErrorCode =
  (typeof copilotValidationErrorCodes)[number];

const boundedLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: "Control characters are not allowed.",
  });

export const copilotModelSchema = z
  .object({
    id: boundedLabelSchema,
    displayName: boundedLabelSchema,
    capabilities: z
      .object({
        supportsVision: z.boolean().optional(),
        supportsReasoningEffort: z.boolean().optional(),
        maxPromptTokens: z.number().int().positive().max(10_000_000).optional(),
        maxContextWindowTokens: z
          .number()
          .int()
          .positive()
          .max(10_000_000)
          .optional(),
      })
      .strict(),
    policy: z
      .object({
        state: z.enum(["enabled", "disabled", "unconfigured"]).optional(),
      })
      .strict(),
    billing: z
      .object({
        multiplier: z.number().finite().nonnegative().max(1_000_000).optional(),
      })
      .strict(),
  })
  .strict();

export type CopilotModel = z.infer<typeof copilotModelSchema>;

export const copilotValidationRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    token: z
      .string()
      .min(8)
      .max(COPILOT_TOKEN_MAX_LENGTH)
      .regex(/^github_pat_[A-Za-z0-9_]{20,255}$/),
  })
  .strict();

export type CopilotValidationRequest = z.infer<
  typeof copilotValidationRequestSchema
>;

const successfulValidationSchema = z
  .object({
    ok: z.literal(true),
    requestId: z.string().uuid(),
    models: z.array(copilotModelSchema).min(1).max(COPILOT_WORKER_MAX_MODELS),
  })
  .strict();

const failedValidationSchema = z
  .object({
    ok: z.literal(false),
    requestId: z.string().uuid(),
    code: z.enum(copilotValidationErrorCodes),
  })
  .strict();

export const copilotValidationResponseSchema = z.discriminatedUnion("ok", [
  successfulValidationSchema,
  failedValidationSchema,
]);

export type CopilotValidationResponse = z.infer<
  typeof copilotValidationResponseSchema
>;

export const copilotHealthResponseSchema = z
  .object({ status: z.enum(["ok", "unavailable"]) })
  .strict();
