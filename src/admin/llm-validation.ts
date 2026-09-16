import { z } from "zod";

export const LLM_PROVIDERS = [
  "github_copilot",
  "anthropic",
  "google_gemini",
  "deepseek",
  "openai_compatible",
] as const;

export const LLM_CREDENTIAL_TYPES = [
  "fine_grained_pat",
  "oauth_app_user",
  "github_app_user",
  "api_key",
  "token",
  "oauth",
] as const;
export const LLM_ACCOUNT_STATUSES = [
  "pending_validation",
  "active",
  "invalid",
  "error",
  "inactive",
] as const;

export const LLM_ACCOUNT_NAME_MAX_LENGTH = 120;
export const LLM_CREDENTIAL_MAX_LENGTH = 4096;
export const LLM_CUSTOM_ENDPOINT_MAX_LENGTH = 2048;

type LlmProviderValue = (typeof LLM_PROVIDERS)[number];
type LlmCredentialTypeValue = (typeof LLM_CREDENTIAL_TYPES)[number];

const GITHUB_COPILOT_FINE_GRAINED_PAT_PATTERN =
  /^github_pat_[A-Za-z0-9_]{20,255}$/;

// Keep this equivalent to llm_accounts_endpoint_by_provider in migration 0003.
const CUSTOM_ENDPOINT_DATABASE_PATTERN =
  /^https:\/\/[^/?#@\s]+(?:\/[^?#@\s]*)?$/;

const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(LLM_ACCOUNT_NAME_MAX_LENGTH);

const credentialSchema = z.string().superRefine((value, context) => {
  const error = getLlmCredentialError(null, value);

  if (error) {
    context.addIssue({
      code: "custom",
      message: error,
    });
  }
});

export function getLlmCredentialError(
  provider: LlmProviderValue | null,
  credential: string
): string | null {
  if (provider === "github_copilot" && credential.startsWith("ghp_")) {
    return "Tokens classic (ghp_) não são suportados. Use um fine-grained PAT com prefixo github_pat_.";
  }

  if (
    provider === "github_copilot" &&
    (credential.startsWith("gho_") || credential.startsWith("ghu_"))
  ) {
    return "Tokens OAuth e GitHub App ficam reservados para integrações futuras. Use agora um fine-grained PAT com prefixo github_pat_.";
  }

  if (credential.length < 8) {
    return "A credencial deve ter pelo menos 8 caracteres.";
  }

  if (credential.length > LLM_CREDENTIAL_MAX_LENGTH) {
    return "A credencial excede o tamanho máximo permitido.";
  }

  if (/\s/.test(credential)) {
    return "A credencial não pode conter espaços.";
  }

  if (provider !== "github_copilot") {
    return null;
  }

  if (!GITHUB_COPILOT_FINE_GRAINED_PAT_PATTERN.test(credential)) {
    return "A credencial do GitHub Copilot deve ser um fine-grained PAT válido com prefixo github_pat_.";
  }

  return null;
}

export function isManuallyManagedLlmCredentialType(
  credentialType: LlmCredentialTypeValue
) {
  return ["fine_grained_pat", "api_key", "token"].includes(credentialType);
}

const strictHttpsEndpointSchema = z
  .string()
  .max(LLM_CUSTOM_ENDPOINT_MAX_LENGTH)
  .transform((value, context) => {
    if (!CUSTOM_ENDPOINT_DATABASE_PATTERN.test(value)) {
      context.addIssue({
        code: "custom",
        message:
          "O endpoint deve usar HTTPS e não pode incluir credenciais, parâmetros, fragmentos, @ ou espaços.",
      });
      return z.NEVER;
    }

    let endpoint: URL;

    try {
      endpoint = new URL(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Indique um endpoint HTTPS válido.",
      });
      return z.NEVER;
    }

    if (endpoint.protocol !== "https:" || !endpoint.hostname) {
      context.addIssue({
        code: "custom",
        message: "Indique um endpoint HTTPS válido.",
      });
      return z.NEVER;
    }

    const normalizedEndpoint = endpoint.toString().replace(/\/$/, "");

    if (!CUSTOM_ENDPOINT_DATABASE_PATTERN.test(normalizedEndpoint)) {
      context.addIssue({
        code: "custom",
        message:
          "O endpoint normalizado não é compatível com o formato seguro.",
      });
      return z.NEVER;
    }

    return normalizedEndpoint;
  });

const optionalEndpointSchema = z.preprocess(
  (value) => (value === "" ? null : value),
  strictHttpsEndpointSchema.nullable().optional()
);

export const createLlmAccountSchema = z
  .object({
    provider: z.enum(LLM_PROVIDERS),
    displayName: displayNameSchema,
    credential: credentialSchema,
    customEndpoint: optionalEndpointSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const credentialError = getLlmCredentialError(
      value.provider,
      value.credential
    );

    if (credentialError) {
      context.addIssue({
        code: "custom",
        path: ["credential"],
        message: credentialError,
      });
    }

    if (value.provider === "openai_compatible" && !value.customEndpoint) {
      context.addIssue({
        code: "custom",
        path: ["customEndpoint"],
        message: "Indique o endpoint do fornecedor OpenAI-compatible.",
      });
    }

    if (value.provider !== "openai_compatible" && value.customEndpoint) {
      context.addIssue({
        code: "custom",
        path: ["customEndpoint"],
        message: "Este fornecedor não aceita um endpoint personalizado.",
      });
    }
  });

export const updateLlmAccountSchema = z
  .object({
    displayName: displayNameSchema,
    customEndpoint: optionalEndpointSchema,
  })
  .strict();

export const replaceLlmCredentialSchema = z
  .object({
    credential: credentialSchema,
  })
  .strict();

export const deleteLlmAccountSchema = z
  .object({
    confirmationName: z.string().max(LLM_ACCOUNT_NAME_MAX_LENGTH),
  })
  .strict();

export const llmAccountIdSchema = z.string().uuid();

export const setGlobalLlmDefaultSchema = z
  .object({
    accountModelId: z.string().uuid(),
  })
  .strict();
