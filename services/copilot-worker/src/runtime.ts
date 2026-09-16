import {
  COPILOT_WORKER_MAX_MODELS,
  copilotModelSchema,
  type CopilotPremiumRequestsQuota,
  type CopilotModel,
  type SafeCopilotProbeUnknownDiagnostic,
  type SafeCopilotUnavailableDiagnostic,
  type SafeCopilotValidationDiagnostic,
  type SafeUnknownCopilotErrorDiagnostic,
  type CopilotValidationErrorCode,
  type CopilotValidationResponse,
} from "./contract";
import {
  collectCopilotErrorEvidence,
  createSafeUnknownCopilotErrorDiagnostic,
  type CopilotErrorEvidence,
} from "./error-diagnostics";
import {
  probeGitHubCredential,
  type GitHubCredentialProbe,
} from "./github-credential-probe";

export type CopilotRuntimeClient = {
  listModels(signal: AbortSignal): Promise<readonly unknown[]>;
  getPremiumRequestsQuota?(
    signal: AbortSignal
  ): Promise<CopilotPremiumRequestsQuota>;
  close(): Promise<void>;
};

export type CopilotRuntimeFactory = (
  token: string,
  requestId: string,
  signal: AbortSignal
) => Promise<CopilotRuntimeClient>;

export async function validateCopilotCredential({
  token,
  requestId,
  timeoutMs,
  createRuntime,
  probeCredential = probeGitHubCredential,
  signal,
  onDiagnostic,
}: {
  token: string;
  requestId: string;
  timeoutMs: number;
  createRuntime: CopilotRuntimeFactory;
  probeCredential?: GitHubCredentialProbe;
  signal?: AbortSignal;
  onDiagnostic?: (diagnostic: SafeCopilotValidationDiagnostic) => void;
}): Promise<CopilotValidationResponse> {
  const startedAt = Date.now();
  const controller = new AbortController();
  let runtime: CopilotRuntimeClient | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const abortForCaller = () => controller.abort();
  signal?.addEventListener("abort", abortForCaller, { once: true });

  if (signal?.aborted) {
    controller.abort();
  }

  const timedOut = new Promise<never>((_, reject) => {
    if (controller.signal.aborted) {
      reject(new ValidationTimeoutError());
      return;
    }

    controller.signal.addEventListener(
      "abort",
      () => reject(new ValidationTimeoutError()),
      { once: true }
    );
    timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
  });

  try {
    const runtimePromise = createRuntime(token, requestId, controller.signal);
    void runtimePromise.then(
      async (createdRuntime) => {
        if (controller.signal.aborted && runtime !== createdRuntime) {
          await closeRuntime(createdRuntime);
        }
      },
      () => undefined
    );

    runtime = await Promise.race([runtimePromise, timedOut]);
    const rawModels = await Promise.race([
      runtime.listModels(controller.signal),
      timedOut,
    ]);
    const discoveredModels = sanitizeCopilotModels(rawModels);
    const models = discoveredModels.filter(
      (model) => model.policy.state !== "disabled"
    );

    if (models.length === 0) {
      return {
        ok: false,
        requestId,
        code: discoveredModels.some(
          (model) => model.policy.state === "disabled"
        )
          ? "org_policy_blocked"
          : "no_models",
      };
    }

    let quota: CopilotPremiumRequestsQuota;

    try {
      const remainingMs = timeoutMs - (Date.now() - startedAt) - 500;
      quota =
        runtime.getPremiumRequestsQuota && remainingMs > 0
          ? await withQuotaDeadline(
              runtime.getPremiumRequestsQuota(controller.signal),
              Math.min(3_000, remainingMs)
            )
          : {
              status: "unavailable",
              metric: "premium_requests",
              errorCode: "provider_quota_not_available",
            };
    } catch {
      quota = {
        status: "unavailable",
        metric: "premium_requests",
        errorCode: "provider_quota_unavailable",
      };
    }

    return { ok: true, requestId, models, quota };
  } catch (error) {
    const evidence = collectCopilotErrorEvidence(error);
    let code = classifyCopilotError(error, evidence);
    let unknownDiagnostic:
      | SafeUnknownCopilotErrorDiagnostic
      | SafeCopilotProbeUnknownDiagnostic
      | undefined;
    let unavailableDiagnostic: SafeCopilotUnavailableDiagnostic | undefined;

    if (code === "unknown" && isSessionAuthenticationBuilderError(evidence)) {
      try {
        const probeResult = await Promise.race([
          probeCredential(token, controller.signal),
          timedOut,
        ]);
        const resolution = applyCredentialProbeResult(requestId, probeResult);
        code = resolution.code;

        if (resolution.code === "unknown") {
          unknownDiagnostic = resolution.diagnostic;
        } else if (resolution.code === "unavailable") {
          unavailableDiagnostic = resolution.diagnostic;
        }
      } catch {
        code = controller.signal.aborted ? "timeout" : "unavailable";
        unavailableDiagnostic = controller.signal.aborted
          ? undefined
          : createProbeUnavailableDiagnostic(requestId, {
              outcome: "unavailable",
              category: "network_error",
            });
      }
    }

    if (code === "unknown" && !unknownDiagnostic) {
      try {
        unknownDiagnostic = createSafeUnknownCopilotErrorDiagnostic(
          requestId,
          error,
          evidence
        );
      } catch {
        unknownDiagnostic = undefined;
      }
    }

    const diagnostic = unknownDiagnostic ?? unavailableDiagnostic;

    if (diagnostic && onDiagnostic) {
      try {
        onDiagnostic(diagnostic);
      } catch {
        // Diagnostics must never change the sanitized validation result.
      }
    }

    if (code === "unknown" && unknownDiagnostic) {
      return {
        ok: false,
        requestId,
        code,
        diagnostic: unknownDiagnostic,
      };
    }

    if (code === "unavailable" && unavailableDiagnostic) {
      return {
        ok: false,
        requestId,
        code,
        diagnostic: unavailableDiagnostic,
      };
    }

    return { ok: false, requestId, code };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }

    signal?.removeEventListener("abort", abortForCaller);

    if (runtime) {
      await closeRuntime(runtime);
    }
  }
}

async function withQuotaDeadline(
  quota: Promise<CopilotPremiumRequestsQuota>,
  timeoutMs: number
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      quota,
      new Promise<CopilotPremiumRequestsQuota>((resolve) => {
        timeout = setTimeout(
          () =>
            resolve({
              status: "unavailable",
              metric: "premium_requests",
              errorCode: "provider_quota_unavailable",
            }),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function sanitizeCopilotModels(
  values: readonly unknown[]
): CopilotModel[] {
  const models = new Map<string, CopilotModel>();

  for (const value of values.slice(0, COPILOT_WORKER_MAX_MODELS)) {
    const record = asRecord(value);
    const id = safeString(record?.id);

    if (!id || models.has(id)) {
      continue;
    }

    const capabilities = asRecord(record?.capabilities);
    const limits = asRecord(capabilities?.limits);
    const supports = asRecord(capabilities?.supports);
    const policy = asRecord(record?.policy);
    const billing = asRecord(record?.billing);
    const candidate = {
      id,
      displayName: safeString(record?.name) ?? id,
      capabilities: compact({
        supportsVision: safeBoolean(
          capabilities?.supportsVision,
          supports?.vision
        ),
        supportsReasoningEffort: safeBoolean(
          capabilities?.supportsReasoningEffort,
          supports?.reasoningEffort
        ),
        maxPromptTokens: safePositiveInteger(
          capabilities?.maxPromptTokens,
          limits?.maxPromptTokens,
          limits?.max_prompt_tokens
        ),
        maxContextWindowTokens: safePositiveInteger(
          capabilities?.maxContextWindowTokens,
          limits?.maxContextWindowTokens,
          limits?.max_context_window_tokens
        ),
      }),
      policy: compact({
        state: safePolicyState(policy?.state),
      }),
      billing: compact({
        multiplier: safeNonNegativeNumber(billing?.multiplier),
      }),
    };
    const parsed = copilotModelSchema.safeParse(candidate);

    if (parsed.success) {
      models.set(parsed.data.id, parsed.data);
    }
  }

  return [...models.values()];
}

export function classifyCopilotError(
  error: unknown,
  evidence = collectCopilotErrorEvidence(error)
): CopilotValidationErrorCode {
  if (error instanceof ValidationTimeoutError) {
    return "timeout";
  }

  if (
    evidence.statuses.has(401) ||
    evidence.rpcErrors.some(
      (rpcError) =>
        rpcError.numericCode === -32603 &&
        (rpcError.message === "not authenticated" ||
          isSessionAuthenticationUnauthorized(rpcError.message))
    ) ||
    intersects(evidence.classificationCodes, [
      "BAD_CREDENTIALS",
      "INVALID_TOKEN",
      "TOKEN_EXPIRED",
      "UNAUTHORIZED",
    ])
  ) {
    return "invalid_token";
  }

  if (
    intersects(evidence.classificationCodes, [
      "COPILOT_NOT_ENTITLED",
      "NO_COPILOT_SUBSCRIPTION",
      "NO_SUBSCRIPTION",
    ])
  ) {
    return "no_subscription";
  }

  if (
    intersects(evidence.classificationCodes, [
      "COPILOT_POLICY_BLOCKED",
      "ORG_POLICY_BLOCKED",
      "POLICY_BLOCKED",
    ])
  ) {
    return "org_policy_blocked";
  }

  if (
    intersects(evidence.classificationCodes, [
      "ABORT_ERR",
      "ETIMEDOUT",
      "ERR_COPILOT_TIMEOUT",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
    ])
  ) {
    return "timeout";
  }

  if (
    intersects(evidence.classificationCodes, [
      "ECONNREFUSED",
      "ECONNRESET",
      "EAI_AGAIN",
      "ENETUNREACH",
      "ENOTFOUND",
      "ERR_COPILOT_UNAVAILABLE",
    ]) ||
    [...evidence.statuses].some((status) => status >= 500 && status <= 599)
  ) {
    return "unavailable";
  }

  return "unknown";
}

function isSessionAuthenticationUnauthorized(message: string | null) {
  return (
    message !== null &&
    message.includes("sdk session authentication failed:") &&
    message.includes("failed to fetch copilot user info:") &&
    /\b401 unauthorized\b/.test(message)
  );
}

function isSessionAuthenticationBuilderError(evidence: CopilotErrorEvidence) {
  const message =
    "sdk session authentication failed: network fetch failed: request failed: builder error";

  return evidence.rpcErrors.some(
    (rpcError) =>
      rpcError.numericCode === -32603 &&
      (rpcError.message === message ||
        rpcError.message?.endsWith(`: ${message}`) === true)
  );
}

type CredentialProbeResolution =
  | {
      code: Exclude<CopilotValidationErrorCode, "unknown" | "unavailable">;
      diagnostic?: never;
    }
  | {
      code: "unknown";
      diagnostic: SafeCopilotProbeUnknownDiagnostic;
    }
  | {
      code: "unavailable";
      diagnostic: SafeCopilotUnavailableDiagnostic;
    };

function applyCredentialProbeResult(
  requestId: string,
  result: Awaited<ReturnType<GitHubCredentialProbe>>
): CredentialProbeResolution {
  if (result.outcome === "invalid_token") {
    return { code: "invalid_token" };
  }

  if (result.outcome === "timeout") {
    return { code: "timeout" };
  }

  if (result.outcome === "unavailable") {
    return {
      code: "unavailable",
      diagnostic: createProbeUnavailableDiagnostic(requestId, result),
    };
  }

  return {
    code: "unknown",
    diagnostic: createProbeUnknownDiagnostic(requestId, result.outcome),
  };
}

function createProbeUnknownDiagnostic(
  requestId: string,
  outcome: "valid" | "forbidden" | "unknown"
): SafeCopilotProbeUnknownDiagnostic {
  const base = {
    event: "copilot_validation_probe_unknown" as const,
    requestId,
  };

  if (outcome === "valid") {
    return {
      ...base,
      code: "GITHUB_CREDENTIAL_PROBE_SUCCEEDED",
      message:
        "github credential probe succeeded; Copilot runtime transport failed",
    };
  }

  if (outcome === "forbidden") {
    return {
      ...base,
      code: "GITHUB_CREDENTIAL_PROBE_FORBIDDEN",
      message:
        "github credential probe forbidden; Copilot runtime transport failed",
    };
  }

  return {
    ...base,
    code: "GITHUB_CREDENTIAL_PROBE_UNEXPECTED_STATUS",
    message:
      "github credential probe returned an unexpected status; Copilot runtime transport failed",
  };
}

function createProbeUnavailableDiagnostic(
  requestId: string,
  result: Extract<
    Awaited<ReturnType<GitHubCredentialProbe>>,
    { outcome: "unavailable" }
  >
): SafeCopilotUnavailableDiagnostic {
  const base = {
    event: "copilot_validation_probe_unavailable" as const,
    requestId,
  };

  if (result.category === "network_error") {
    return {
      ...base,
      code: "GITHUB_CREDENTIAL_PROBE_NETWORK_ERROR",
      message: "github credential probe could not reach GitHub",
      ...(result.causeCode ? { causeCode: result.causeCode } : {}),
    };
  }

  if (result.category === "rate_limited") {
    return {
      ...base,
      code: "GITHUB_CREDENTIAL_PROBE_RATE_LIMITED",
      message: "github credential probe was rate limited",
    };
  }

  return {
    ...base,
    code: "GITHUB_CREDENTIAL_PROBE_GITHUB_UNAVAILABLE",
    message: "github credential probe found GitHub unavailable",
  };
}

class ValidationTimeoutError extends Error {
  readonly code = "ERR_COPILOT_TIMEOUT";
}

async function closeRuntime(runtime: CopilotRuntimeClient) {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      runtime.close(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 3_000);
      }),
    ]);
  } catch {
    // The request result is already sanitized. Shutdown failures are not
    // returned because provider errors could contain credential material.
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function safeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 255 ? normalized : null;
}

function safeBoolean(...values: unknown[]): boolean | undefined {
  return values.find((value): value is boolean => typeof value === "boolean");
}

function safePositiveInteger(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number =>
      Number.isInteger(value) &&
      Number(value) > 0 &&
      Number(value) <= 10_000_000
  );
}

function safeNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1_000_000
    ? value
    : undefined;
}

function safePolicyState(
  value: unknown
): "enabled" | "disabled" | "unconfigured" | undefined {
  return ["enabled", "disabled", "unconfigured"].includes(String(value))
    ? (String(value) as "enabled" | "disabled" | "unconfigured")
    : undefined;
}

function compact<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}

function intersects(values: Set<string>, expected: string[]) {
  return expected.some((value) => values.has(value));
}
