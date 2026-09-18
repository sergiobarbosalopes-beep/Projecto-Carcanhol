import { z } from "zod";
import {
  MAX_DIAGNOSTIC_IDENTIFIER_LENGTH,
  MAX_DIAGNOSTIC_ITEMS,
  MAX_DIAGNOSTIC_MESSAGE_LENGTH,
  isSafeDiagnosticIdentifier,
  isSafeDiagnosticMessage,
} from "./diagnostic-safety";
import { safeNetworkCauseCodes } from "./network-error";

export {
  safeNetworkCauseCodes,
  type SafeNetworkCauseCode,
} from "./network-error";

export const COPILOT_VALIDATION_PATH = "/v1/copilot/validate";
export const COPILOT_INFERENCE_PATH = "/v1/copilot/infer";
export const COPILOT_STREAM_PATH = "/v1/copilot/stream";
export const COPILOT_HEALTH_PATH = "/health";
export const COPILOT_WORKER_MAX_BODY_BYTES = 40 * 1024;
export const COPILOT_WORKER_MAX_RESPONSE_BYTES = 512 * 1024;
export const COPILOT_WORKER_MAX_MODELS = 100;
export const COPILOT_TOKEN_MAX_LENGTH = 4096;
export const COPILOT_INFERENCE_MAX_PROMPT_LENGTH = 8_000;
export const COPILOT_INFERENCE_MAX_SYSTEM_PROMPT_LENGTH = 16_000;
export const COPILOT_INFERENCE_MAX_TEXT_LENGTH = 110_000;
export const COPILOT_STREAM_PROTOCOL_VERSION = 1;
export const COPILOT_STREAM_MAX_DELTA_LENGTH = 16_000;
export const COPILOT_QUOTA_ERROR_CODES = [
  "provider_quota_unavailable",
  "provider_quota_not_available",
  "malformed_provider_quota",
] as const;

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
        causeCode: z.enum(safeNetworkCauseCodes).optional(),
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

const probeUnknownDiagnosticBase = {
  event: z.literal("copilot_validation_probe_unknown"),
  requestId: z.string().uuid(),
};

export const safeCopilotProbeUnknownDiagnosticSchema = z.discriminatedUnion(
  "code",
  [
    z
      .object({
        ...probeUnknownDiagnosticBase,
        code: z.literal("GITHUB_CREDENTIAL_PROBE_SUCCEEDED"),
        message: z.literal(
          "github credential probe succeeded; Copilot runtime transport failed"
        ),
      })
      .strict(),
    z
      .object({
        ...probeUnknownDiagnosticBase,
        code: z.literal("GITHUB_CREDENTIAL_PROBE_FORBIDDEN"),
        message: z.literal(
          "github credential probe forbidden; Copilot runtime transport failed"
        ),
      })
      .strict(),
    z
      .object({
        ...probeUnknownDiagnosticBase,
        code: z.literal("GITHUB_CREDENTIAL_PROBE_UNEXPECTED_STATUS"),
        message: z.literal(
          "github credential probe returned an unexpected status; Copilot runtime transport failed"
        ),
      })
      .strict(),
  ]
);

export type SafeCopilotProbeUnknownDiagnostic = z.infer<
  typeof safeCopilotProbeUnknownDiagnosticSchema
>;

export const copilotWorkerRequestPhases = [
  "receiving_body",
  "authenticating",
  "parsing_request",
  "validating",
  "validating_response",
  "streaming_response",
  "writing_response",
] as const;

export type CopilotWorkerRequestPhase =
  (typeof copilotWorkerRequestPhases)[number];

export const safeCopilotWorkerInternalDiagnosticSchema = z
  .object({
    event: z.literal("copilot_worker_internal_error"),
    requestId: z.string().uuid(),
    code: z.literal("WORKER_INTERNAL_FAILURE"),
    message: z.literal("copilot worker failed internally"),
    phase: z.enum(copilotWorkerRequestPhases),
  })
  .strict();

export type SafeCopilotWorkerInternalDiagnostic = z.infer<
  typeof safeCopilotWorkerInternalDiagnosticSchema
>;

export type SafeCopilotValidationDiagnostic =
  | SafeUnknownCopilotErrorDiagnostic
  | SafeCopilotUnavailableDiagnostic
  | SafeCopilotProbeUnknownDiagnostic
  | SafeCopilotWorkerInternalDiagnostic;

export const COPILOT_WORKER_TRANSPORT_DIAGNOSTICS = {
  authRejected: {
    code: "WORKER_AUTH_REJECTED",
    message: "copilot worker rejected request authentication",
  },
  rateLimited: {
    code: "WORKER_RATE_LIMITED",
    message: "copilot worker rate limited the request",
  },
  httpUnavailable: {
    code: "WORKER_HTTP_UNAVAILABLE",
    message: "copilot worker returned an unavailable response",
  },
  httpError: {
    code: "WORKER_HTTP_ERROR",
    message: "copilot worker returned an unexpected HTTP response",
  },
  networkError: {
    code: "WORKER_NETWORK_ERROR",
    message: "copilot worker could not be reached",
  },
  invalidResponse: {
    code: "WORKER_INVALID_RESPONSE",
    message: "copilot worker returned an invalid response",
  },
  timeout: {
    code: "WORKER_TIMEOUT",
    message: "copilot worker request timed out",
  },
} as const;

const workerTransportDiagnosticBase = {
  event: z.literal("copilot_worker_transport_error"),
  requestId: z.string().uuid(),
};

const workerAuthRejectedDiagnosticSchema = z
  .object({
    ...workerTransportDiagnosticBase,
    code: z.literal(COPILOT_WORKER_TRANSPORT_DIAGNOSTICS.authRejected.code),
    message: z.literal(
      COPILOT_WORKER_TRANSPORT_DIAGNOSTICS.authRejected.message
    ),
  })
  .strict();

const workerRateLimitedDiagnosticSchema = z
  .object({
    ...workerTransportDiagnosticBase,
    code: z.literal(COPILOT_WORKER_TRANSPORT_DIAGNOSTICS.rateLimited.code),
    message: z.literal(
      COPILOT_WORKER_TRANSPORT_DIAGNOSTICS.rateLimited.message
    ),
  })
  .strict();

const workerHttpUnavailableDiagnosticSchema = z
  .object({
    ...workerTransportDiagnosticBase,
    code: z.literal(COPILOT_WORKER_TRANSPORT_DIAGNOSTICS.httpUnavailable.code),
    message: z.literal(
      COPILOT_WORKER_TRANSPORT_DIAGNOSTICS.httpUnavailable.message
    ),
  })
  .strict();

const workerHttpErrorDiagnosticSchema = z
  .object({
    ...workerTransportDiagnosticBase,
    code: z.literal(COPILOT_WORKER_TRANSPORT_DIAGNOSTICS.httpError.code),
    message: z.literal(COPILOT_WORKER_TRANSPORT_DIAGNOSTICS.httpError.message),
  })
  .strict();

const workerNetworkErrorDiagnosticSchema = z
  .object({
    ...workerTransportDiagnosticBase,
    code: z.literal(COPILOT_WORKER_TRANSPORT_DIAGNOSTICS.networkError.code),
    message: z.literal(
      COPILOT_WORKER_TRANSPORT_DIAGNOSTICS.networkError.message
    ),
    causeCode: z.enum(safeNetworkCauseCodes).optional(),
  })
  .strict();

const workerInvalidResponseDiagnosticSchema = z
  .object({
    ...workerTransportDiagnosticBase,
    code: z.literal(COPILOT_WORKER_TRANSPORT_DIAGNOSTICS.invalidResponse.code),
    message: z.literal(
      COPILOT_WORKER_TRANSPORT_DIAGNOSTICS.invalidResponse.message
    ),
  })
  .strict();

const workerTimeoutDiagnosticSchema = z
  .object({
    ...workerTransportDiagnosticBase,
    code: z.literal(COPILOT_WORKER_TRANSPORT_DIAGNOSTICS.timeout.code),
    message: z.literal(COPILOT_WORKER_TRANSPORT_DIAGNOSTICS.timeout.message),
  })
  .strict();

const workerUnavailableTransportDiagnosticSchema = z.union([
  workerAuthRejectedDiagnosticSchema,
  workerRateLimitedDiagnosticSchema,
  workerHttpUnavailableDiagnosticSchema,
  workerHttpErrorDiagnosticSchema,
  workerNetworkErrorDiagnosticSchema,
]);

export const safeCopilotWorkerTransportDiagnosticSchema = z.discriminatedUnion(
  "code",
  [
    workerAuthRejectedDiagnosticSchema,
    workerRateLimitedDiagnosticSchema,
    workerHttpUnavailableDiagnosticSchema,
    workerHttpErrorDiagnosticSchema,
    workerNetworkErrorDiagnosticSchema,
    workerInvalidResponseDiagnosticSchema,
    workerTimeoutDiagnosticSchema,
  ]
);

export type SafeCopilotWorkerTransportDiagnostic = z.infer<
  typeof safeCopilotWorkerTransportDiagnosticSchema
>;

export type SafeCopilotDiagnostic =
  SafeCopilotValidationDiagnostic | SafeCopilotWorkerTransportDiagnostic;

export const copilotWorkerTransportFailureSchema = z
  .union([
    z
      .object({
        ok: z.literal(false),
        requestId: z.string().uuid(),
        code: z.literal("unavailable"),
        diagnostic: workerUnavailableTransportDiagnosticSchema,
      })
      .strict(),
    z
      .object({
        ok: z.literal(false),
        requestId: z.string().uuid(),
        code: z.literal("unknown"),
        diagnostic: workerInvalidResponseDiagnosticSchema,
      })
      .strict(),
    z
      .object({
        ok: z.literal(false),
        requestId: z.string().uuid(),
        code: z.literal("timeout"),
        diagnostic: workerTimeoutDiagnosticSchema,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.diagnostic.requestId !== value.requestId) {
      context.addIssue({
        code: "custom",
        path: ["diagnostic", "requestId"],
        message: "Diagnostic requestId must match the response requestId.",
      });
    }
  });

export type CopilotWorkerTransportFailure = z.infer<
  typeof copilotWorkerTransportFailureSchema
>;

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

export const copilotPremiumInteractionsQuotaSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("available"),
        metric: z.literal("premium_interactions"),
        isUnlimited: z.boolean(),
        usedUnits: z.number().finite().nonnegative().max(1_000_000_000),
        includedUnits: z
          .number()
          .finite()
          .nonnegative()
          .max(1_000_000_000)
          .optional(),
        remainingUnits: z
          .number()
          .finite()
          .nonnegative()
          .max(1_000_000_000)
          .optional(),
        remainingPercentage: z.number().min(0).max(100).optional(),
        overageUnits: z.number().finite().nonnegative().max(1_000_000_000),
        usageAllowedAfterLimit: z.boolean(),
        overageAllowed: z.boolean(),
        resetAt: z.string().datetime({ offset: true }).optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (
          value.isUnlimited &&
          (value.includedUnits !== undefined ||
            value.remainingUnits !== undefined ||
            value.remainingPercentage !== undefined)
        ) {
          context.addIssue({
            code: "custom",
            message: "Unlimited quota must not expose a finite allowance.",
          });
        }

        if (!value.isUnlimited && value.includedUnits === undefined) {
          context.addIssue({
            code: "custom",
            message: "Finite quota requires an included provider-unit count.",
          });
        }
      }),
    z
      .object({
        status: z.literal("unavailable"),
        metric: z.literal("premium_interactions"),
        errorCode: z.enum(COPILOT_QUOTA_ERROR_CODES),
      })
      .strict(),
  ]
);

export type CopilotPremiumInteractionsQuota = z.infer<
  typeof copilotPremiumInteractionsQuotaSchema
>;

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

export const copilotInferencePromptSchema = z
  .string()
  .trim()
  .min(1)
  .max(COPILOT_INFERENCE_MAX_PROMPT_LENGTH)
  .refine(
    (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
    {
      message: "Prompt contains unsupported control characters.",
    }
  );

export const copilotInferenceRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    token: z
      .string()
      .min(8)
      .max(COPILOT_TOKEN_MAX_LENGTH)
      .regex(/^github_pat_[A-Za-z0-9_]{20,255}$/),
    model: boundedLabelSchema,
    prompt: copilotInferencePromptSchema,
    systemPrompt: z
      .string()
      .trim()
      .min(1)
      .max(COPILOT_INFERENCE_MAX_SYSTEM_PROMPT_LENGTH)
      .optional(),
  })
  .strict();

export type CopilotInferenceRequest = z.infer<
  typeof copilotInferenceRequestSchema
>;

export const inferenceUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().max(10_000_000),
    outputTokens: z.number().int().nonnegative().max(10_000_000),
  })
  .strict();

export const safeWebSourceSchema = z
  .object({
    url: z
      .string()
      .url()
      .max(2_048)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (!url.port || url.port === "443")
        );
      }),
    title: z.string().min(1).max(200).optional(),
  })
  .strict();

const successfulInferenceSchema = z
  .object({
    ok: z.literal(true),
    requestId: z.string().uuid(),
    text: z.string().min(1).max(COPILOT_INFERENCE_MAX_TEXT_LENGTH),
    usage: inferenceUsageSchema.optional(),
    durationMs: z.number().int().nonnegative().max(120_000),
  })
  .strict();

const inferenceFailureSchema = z
  .object({
    ok: z.literal(false),
    requestId: z.string().uuid(),
    code: z.enum(["timeout", "unavailable", "invalid_response"]),
    diagnostic: safeCopilotWorkerInternalDiagnosticSchema.optional(),
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

export const copilotInferenceResponseSchema = z.union([
  successfulInferenceSchema,
  inferenceFailureSchema,
]);

export type CopilotInferenceResponse = z.infer<
  typeof copilotInferenceResponseSchema
>;

export const copilotStreamEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      v: z.literal(COPILOT_STREAM_PROTOCOL_VERSION),
      type: z.literal("start"),
      requestId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      v: z.literal(COPILOT_STREAM_PROTOCOL_VERSION),
      type: z.literal("delta"),
      requestId: z.string().uuid(),
      sequence: z.number().int().positive().max(1_000_000),
      text: z.string().min(1).max(COPILOT_STREAM_MAX_DELTA_LENGTH),
    })
    .strict(),
  z
    .object({
      v: z.literal(COPILOT_STREAM_PROTOCOL_VERSION),
      type: z.literal("tool"),
      requestId: z.string().uuid(),
      tool: z.literal("web_fetch"),
      status: z.enum(["started", "completed"]),
      source: safeWebSourceSchema.optional(),
    })
    .strict(),
  z
    .object({
      v: z.literal(COPILOT_STREAM_PROTOCOL_VERSION),
      type: z.literal("sources"),
      requestId: z.string().uuid(),
      sources: z.array(safeWebSourceSchema).min(1).max(16),
    })
    .strict(),
  z
    .object({
      v: z.literal(COPILOT_STREAM_PROTOCOL_VERSION),
      type: z.literal("done"),
      requestId: z.string().uuid(),
      text: z.string().min(1).max(COPILOT_INFERENCE_MAX_TEXT_LENGTH),
      usage: inferenceUsageSchema.optional(),
      durationMs: z.number().int().nonnegative().max(120_000),
    })
    .strict(),
  z
    .object({
      v: z.literal(COPILOT_STREAM_PROTOCOL_VERSION),
      type: z.literal("error"),
      requestId: z.string().uuid(),
      code: z.enum(["cancelled", "timeout", "unavailable", "invalid_response"]),
    })
    .strict(),
  z
    .object({
      v: z.literal(COPILOT_STREAM_PROTOCOL_VERSION),
      type: z.literal("heartbeat"),
      requestId: z.string().uuid(),
    })
    .strict(),
]);

export type CopilotStreamEvent = z.infer<typeof copilotStreamEventSchema>;

const successfulValidationSchema = z
  .object({
    ok: z.literal(true),
    requestId: z.string().uuid(),
    models: z.array(copilotModelSchema).min(1).max(COPILOT_WORKER_MAX_MODELS),
    quota: copilotPremiumInteractionsQuotaSchema.optional(),
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
    diagnostic: z
      .union([
        safeUnknownCopilotErrorDiagnosticSchema,
        safeCopilotProbeUnknownDiagnosticSchema,
      ])
      .optional(),
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
    diagnostic: z
      .union([
        safeCopilotUnavailableDiagnosticSchema,
        safeCopilotWorkerInternalDiagnosticSchema,
      ])
      .optional(),
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
