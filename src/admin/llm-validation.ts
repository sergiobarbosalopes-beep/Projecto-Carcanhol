import { z } from "zod";

export const LLM_PROVIDERS = [
  "github_models",
  "anthropic",
  "google_gemini",
  "deepseek",
  "openai_compatible",
] as const;

export const LLM_CREDENTIAL_TYPES = ["token", "api_key", "oauth"] as const;
export const LLM_ACCOUNT_STATUSES = ["pending_validation", "inactive"] as const;

export const LLM_ACCOUNT_NAME_MAX_LENGTH = 120;
export const LLM_CREDENTIAL_MAX_LENGTH = 4096;
export const LLM_CUSTOM_ENDPOINT_MAX_LENGTH = 2048;

const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(LLM_ACCOUNT_NAME_MAX_LENGTH);

const credentialSchema = z
  .string()
  .min(8)
  .max(LLM_CREDENTIAL_MAX_LENGTH)
  .refine((value) => !/\s/.test(value), {
    message: "A credencial não pode conter espaços.",
  });

const strictHttpsEndpointSchema = z
  .string()
  .trim()
  .max(LLM_CUSTOM_ENDPOINT_MAX_LENGTH)
  .transform((value, context) => {
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

    if (
      endpoint.protocol !== "https:" ||
      !endpoint.hostname ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    ) {
      context.addIssue({
        code: "custom",
        message:
          "O endpoint deve usar HTTPS e não pode incluir credenciais, parâmetros ou fragmentos.",
      });
      return z.NEVER;
    }

    return endpoint.toString().replace(/\/$/, "");
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
