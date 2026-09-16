import { z } from "zod";
import {
  MAX_DIAGNOSTIC_IDENTIFIER_LENGTH,
  MAX_DIAGNOSTIC_ITEMS,
  MAX_DIAGNOSTIC_MESSAGE_LENGTH,
  isSafeDiagnosticIdentifier,
  isSafeDiagnosticMessage,
} from "./diagnostic-safety";

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

const classifiedCopilotValidationErrorCodes = [
  "invalid_token",
  "no_subscription",
  "org_policy_blocked",
  "timeout",
  "no_models",
] as const;

export const githubCredentialProbeNetworkCauseCodes = [
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ETIMEDOUT",
  "CERT_HAS_EXPIRED",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
] as const;

export type GitHubCredentialProbeNetworkCauseCode =
  (typeof githubCredentialProbeNetworkCauseCodes)[number];

const diagnosticIdentifierSchema = z
  .string()
  .min(1)
  .max(MAX_DIAGNOSTIC_IDENTIFIER_LENGTH)
  .refine(isSafeDiagnosticIdentifier, {
    message: "Diagnostic identifiers must not contain secret-like values.",
  });

const diagnosticMessageSchema = z
  .string()
  .min(1)
  .max(MAX_DIAGNOSTIC_MESSAGE_LENGTH)
  .refine(isSafeDiagnosticMessage, {
    message: "Diagnostic messages must already be redacted.",
  });

export const safeUnknownCopilotErrorDiagnosticSchema = z
  .object({
    event: z.literal("copilot_validation_unknown_error"),
    requestId: z.union([z.string().uuid(), z.literal("unknown")]),
    error: z
      .object({
        constructor: diagnosticIdentifierSchema,
        name: diagnosticIdentifierSchema,
        stringCodes: z
          .array(diagnosticIdentifierSchema)
          .max(MAX_DIAGNOSTIC_ITEMS),
        numericCodes: z
          .array(z.number().int().safe())
          .max(MAX_DIAGNOSTIC_ITEMS),
        statuses: z
          .array(z.number().int().min(100).max(599))
          .max(MAX_DIAGNOSTIC_ITEMS),
        message: diagnosticMessageSchema,
      })
      .strict(),
  })
  .strict();

export type SafeUnknownCopilotErrorDiagnostic = z.infer<
  typeof safeUnknownCopilotErrorDiagnosticSchema
>;

const probeUnavailableDiagnosticBase = {
  event: z.literal("copilot_validation_probe_unavailable"),
  requestId: z.string().uuid(),
};

export const safeCopilotUnavailableDiagnosticSchema = z.discriminatedUnion(
  "code",
  [
    z
      .object({
        ...probeUnavailableDiagnosticBase,
        code: z.literal("GITHUB_CREDENTIAL_PROBE_NETWORK_ERROR"),
        message: z.literal("github credential probe could not reach GitHub"),
        causeCode: z.enum(githubCredentialProbeNetworkCauseCodes).optional(),
      })
      .strict(),
    z
      .object({
        ...probeUnavailableDiagnosticBase,
        code: z.literal("GITHUB_CREDENTIAL_PROBE_RATE_LIMITED"),
        message: z.literal("github credential probe was rate limited"),
      })
      .strict(),
    z
      .object({
        ...probeUnavailableDiagnosticBase,
        code: z.literal("GITHUB_CREDENTIAL_PROBE_GITHUB_UNAVAILABLE"),
        message: z.literal("github credential probe found GitHub unavailable"),
      })
      .strict(),
  ]
);

export type SafeCopilotUnavailableDiagnostic = z.infer<
  typeof safeCopilotUnavailableDiagnosticSchema
>;

export type SafeCopilotValidationDiagnostic =
  SafeUnknownCopilotErrorDiagnostic | SafeCopilotUnavailableDiagnostic;

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

const classifiedFailureSchema = z
  .object({
    ok: z.literal(false),
    requestId: z.string().uuid(),
    code: z.enum(classifiedCopilotValidationErrorCodes),
  })
  .strict();

const unknownFailureSchema = z
  .object({
    ok: z.literal(false),
    requestId: z.string().uuid(),
    code: z.literal("unknown"),
    diagnostic: safeUnknownCopilotErrorDiagnosticSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.diagnostic && value.diagnostic.requestId !== value.requestId) {
      context.addIssue({
        code: "custom",
        path: ["diagnostic", "requestId"],
        message: "Diagnostic requestId must match the response requestId.",
      });
    }
  });

const unavailableFailureSchema = z
  .object({
    ok: z.literal(false),
    requestId: z.string().uuid(),
    code: z.literal("unavailable"),
    diagnostic: safeCopilotUnavailableDiagnosticSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.diagnostic && value.diagnostic.requestId !== value.requestId) {
      context.addIssue({
        code: "custom",
        path: ["diagnostic", "requestId"],
        message: "Diagnostic requestId must match the response requestId.",
      });
    }
  });

export const copilotValidationResponseSchema = z.union([
  successfulValidationSchema,
  classifiedFailureSchema,
  unknownFailureSchema,
  unavailableFailureSchema,
]);

export type CopilotValidationResponse = z.infer<
  typeof copilotValidationResponseSchema
>;

export const copilotHealthResponseSchema = z
  .object({ status: z.enum(["ok", "unavailable"]) })
  .strict();
