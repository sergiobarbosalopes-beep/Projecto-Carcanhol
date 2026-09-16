import "server-only";

import type {
  CopilotModel,
  SafeCopilotWorkerInternalDiagnostic,
  SafeCopilotWorkerTransportDiagnostic,
  SafeCopilotUnavailableDiagnostic,
  SafeUnknownCopilotErrorDiagnostic,
  CopilotValidationErrorCode,
} from "@/services/copilot-worker/src/contract";
import { validateWithCopilotWorker } from "@/src/admin/copilot-worker-client";
import type { LlmProvider } from "@/src/types/supabase";

export type LlmValidationErrorCode =
  CopilotValidationErrorCode | "provider_validation_unavailable";

type WorkerInvalidResponseDiagnostic = Extract<
  SafeCopilotWorkerTransportDiagnostic,
  { code: "WORKER_INVALID_RESPONSE" }
>;

type WorkerUnavailableDiagnostic = Extract<
  SafeCopilotWorkerTransportDiagnostic,
  {
    code:
      | "WORKER_AUTH_REJECTED"
      | "WORKER_RATE_LIMITED"
      | "WORKER_HTTP_UNAVAILABLE"
      | "WORKER_HTTP_ERROR"
      | "WORKER_NETWORK_ERROR";
  }
>;

type WorkerTimeoutDiagnostic = Extract<
  SafeCopilotWorkerTransportDiagnostic,
  { code: "WORKER_TIMEOUT" }
>;

export type LlmProviderValidationResult =
  | { ok: true; models: CopilotModel[] }
  | {
      ok: false;
      code: "unknown";
      diagnostic?:
        SafeUnknownCopilotErrorDiagnostic | WorkerInvalidResponseDiagnostic;
    }
  | {
      ok: false;
      code: "unavailable";
      diagnostic?:
        | SafeCopilotUnavailableDiagnostic
        | SafeCopilotWorkerInternalDiagnostic
        | WorkerUnavailableDiagnostic;
    }
  | {
      ok: false;
      code: "timeout";
      diagnostic?: WorkerTimeoutDiagnostic;
    }
  | {
      ok: false;
      code: Exclude<
        LlmValidationErrorCode,
        "unknown" | "unavailable" | "timeout"
      >;
    };

type LlmProviderValidator = {
  validate(
    credential: string,
    requestId: string
  ): Promise<LlmProviderValidationResult>;
};

const validators: Partial<Record<LlmProvider, LlmProviderValidator>> = {
  github_copilot: {
    async validate(credential, requestId) {
      const result = await validateWithCopilotWorker(credential, requestId);

      if (result.ok) {
        return { ok: true, models: result.models };
      }

      if (result.code === "unknown") {
        return {
          ok: false,
          code: result.code,
          ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
        };
      }

      if (result.code === "unavailable") {
        return {
          ok: false,
          code: result.code,
          ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
        };
      }

      if (result.code === "timeout") {
        return {
          ok: false,
          code: result.code,
          ...("diagnostic" in result && result.diagnostic
            ? { diagnostic: result.diagnostic }
            : {}),
        };
      }

      return { ok: false, code: result.code };
    },
  },
};

export function validateLlmProviderCredential(
  provider: LlmProvider,
  credential: string,
  requestId: string
): Promise<LlmProviderValidationResult> {
  const validator = validators[provider];

  if (!validator) {
    return Promise.resolve({
      ok: false,
      code: "provider_validation_unavailable",
    });
  }

  return validator
    .validate(credential, requestId)
    .catch(() => ({ ok: false, code: "unavailable" }));
}
