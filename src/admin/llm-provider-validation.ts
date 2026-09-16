import "server-only";

import type {
  CopilotModel,
  SafeCopilotUnavailableDiagnostic,
  SafeUnknownCopilotErrorDiagnostic,
  CopilotValidationErrorCode,
} from "@/services/copilot-worker/src/contract";
import { validateWithCopilotWorker } from "@/src/admin/copilot-worker-client";
import type { LlmProvider } from "@/src/types/supabase";

export type LlmValidationErrorCode =
  CopilotValidationErrorCode | "provider_validation_unavailable";

export type LlmProviderValidationResult =
  | { ok: true; models: CopilotModel[] }
  | {
      ok: false;
      code: "unknown";
      diagnostic?: SafeUnknownCopilotErrorDiagnostic;
    }
  | {
      ok: false;
      code: "unavailable";
      diagnostic?: SafeCopilotUnavailableDiagnostic;
    }
  | {
      ok: false;
      code: Exclude<LlmValidationErrorCode, "unknown" | "unavailable">;
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
