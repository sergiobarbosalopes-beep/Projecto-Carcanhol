import "server-only";

import type {
  CopilotModel,
  CopilotValidationErrorCode,
} from "@/services/copilot-worker/src/contract";
import { validateWithCopilotWorker } from "@/src/admin/copilot-worker-client";
import type { LlmProvider } from "@/src/types/supabase";

export type LlmValidationErrorCode =
  CopilotValidationErrorCode | "provider_validation_unavailable";

export type LlmProviderValidationResult =
  | { ok: true; models: CopilotModel[] }
  | { ok: false; code: LlmValidationErrorCode };

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

      return result.ok
        ? { ok: true, models: result.models }
        : { ok: false, code: result.code };
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
