import "server-only";

import { randomUUID } from "node:crypto";
import { AuthorizationError, requireAuthorizedUser } from "@/src/auth/server";
import {
  getLlmCredentialError,
  isManuallyManagedLlmCredentialType,
} from "@/src/admin/llm-validation";
import {
  validateLlmProviderCredential,
  type LlmProviderValidationResult,
  type LlmValidationErrorCode,
} from "@/src/admin/llm-provider-validation";
import { getLlmValidationGuidance } from "@/src/admin/llm-validation-guidance";
import { persistOnlyAfterValidation } from "@/src/admin/validated-account-creation";
import {
  createClient,
  createServiceRoleClient,
  type CarcanholClient,
} from "@/src/database/server";
import {
  decryptCredentialForValidation,
  encryptCredentialForStorage,
} from "@/src/security/llm-credentials";
import type {
  Json,
  LlmAccount,
  LlmAccountModel,
  LlmAccountModelPublic,
  LlmAccountPublic,
  LlmCredentialType,
  LlmProvider,
} from "@/src/types/supabase";

const PUBLIC_ACCOUNT_COLUMNS =
  "id, user_id, provider, display_name, credential_type, status, custom_endpoint, credential_suffix, credential_updated_at, last_validation_status, last_validation_at, last_validation_error_code, validation_generation, last_validation_request_id, created_at, updated_at";
const PUBLIC_MODEL_COLUMNS =
  "id, user_id, account_id, provider_model_id, display_name, enabled, discovery_metadata, is_stale, discovered_at, last_seen_at, created_at, updated_at";

const validationRequests = new Map<string, Promise<LlmAccountPublic | null>>();

const CREDENTIAL_TYPE_BY_PROVIDER: Record<
  LlmProvider,
  Extract<LlmCredentialType, "fine_grained_pat" | "api_key">
> = {
  github_copilot: "fine_grained_pat",
  anthropic: "api_key",
  google_gemini: "api_key",
  deepseek: "api_key",
  openai_compatible: "api_key",
};

export type CreateLlmAccountInput = {
  provider: LlmProvider;
  displayName: string;
  credential: string;
  customEndpoint?: string | null;
};

export type UpdateLlmAccountInput = {
  displayName: string;
  customEndpoint?: string | null;
};

export async function listLlmAccounts(
  userId: string
): Promise<LlmAccountPublic[]> {
  const client = await createAuthorizedClient(userId);
  const { data, error } = await client
    .from("llm_accounts")
    .select(PUBLIC_ACCOUNT_COLUMNS)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });

  if (error) {
    throw new Error("Não foi possível carregar as contas LLM.", {
      cause: error,
    });
  }

  const models = await listModelsForAccounts(
    client,
    userId,
    data.map((account) => account.id)
  );

  return data.map((account) =>
    toPublicAccount(account, models.get(account.id) ?? [])
  );
}

export async function createLlmAccount(
  userId: string,
  input: CreateLlmAccountInput
): Promise<LlmAccountPublic> {
  const client = await createAuthorizedClient(userId);
  const credentialError = getLlmCredentialError(
    input.provider,
    input.credential
  );

  if (credentialError) {
    throw new LlmCredentialValidationError(credentialError);
  }

  const validationRequestId = randomUUID();
  const creation = await persistOnlyAfterValidation({
    validate: () =>
      validateLlmProviderCredential(
        input.provider,
        input.credential,
        validationRequestId
      ),
    persist: async (models) => {
      const accountId = randomUUID();
      const encrypted = encryptCredentialForStorage(input.credential, {
        userId,
        accountId,
        provider: input.provider,
      });
      const serviceClient = createServiceRoleClient();
      const { data, error } = await serviceClient
        .rpc("create_validated_llm_account", {
          p_account_id: accountId,
          p_user_id: userId,
          p_provider: input.provider,
          p_display_name: input.displayName,
          p_credential_type: CREDENTIAL_TYPE_BY_PROVIDER[input.provider],
          p_custom_endpoint:
            input.provider === "openai_compatible"
              ? (input.customEndpoint ?? null)
              : null,
          p_credential_suffix: credentialSuffix(input.credential),
          p_ciphertext: encrypted.ciphertext,
          p_nonce: encrypted.nonce,
          p_auth_tag: encrypted.authTag,
          p_algorithm: encrypted.algorithm,
          p_envelope_version: encrypted.envelopeVersion,
          p_key_version: encrypted.keyVersion,
          p_validation_request_id: validationRequestId,
          p_models: models as Json,
        })
        .single();

      if (error) {
        if (error.code === "23505") {
          throw new LlmAccountConflictError(
            "Já existe uma conta LLM com este nome."
          );
        }

        throw new Error("Não foi possível criar a conta LLM.", {
          cause: error,
        });
      }

      const created = await getOwnedPublicAccount(client, userId, data.id);

      if (!created) {
        throw new Error(
          "A conta validada não ficou disponível após a criação."
        );
      }

      return created;
    },
  });

  if (!creation.ok) {
    throw new LlmProviderValidationError(creation.code);
  }

  return creation.value;
}

export async function revalidateLlmAccount(
  userId: string,
  accountId: string
): Promise<LlmAccountPublic | null> {
  const key = `${userId}:${accountId}`;
  const current = validationRequests.get(key);

  if (current) {
    return current;
  }

  const request = revalidateLlmAccountOnce(userId, accountId).finally(() => {
    if (validationRequests.get(key) === request) {
      validationRequests.delete(key);
    }
  });
  validationRequests.set(key, request);

  return request;
}

async function revalidateLlmAccountOnce(
  userId: string,
  accountId: string
): Promise<LlmAccountPublic | null> {
  const client = await createAuthorizedClient(userId);
  const current = await getOwnedAccount(client, userId, accountId);

  if (!current) {
    return null;
  }

  if (current.provider !== "github_copilot") {
    throw new LlmProviderValidationError("provider_validation_unavailable");
  }

  const validationRequestId = randomUUID();
  const serviceClient = createServiceRoleClient();
  const { data: secret, error: beginError } = await serviceClient
    .rpc("begin_llm_account_validation", {
      p_account_id: accountId,
      p_user_id: userId,
      p_validation_request_id: validationRequestId,
    })
    .maybeSingle();

  if (beginError) {
    throw new Error("Não foi possível iniciar a validação da conta LLM.", {
      cause: beginError,
    });
  }

  if (!secret) {
    return null;
  }

  let credential = "";
  let validation: LlmProviderValidationResult;

  try {
    if (secret.algorithm !== "aes-256-gcm" || secret.envelope_version !== 1) {
      throw new Error("Unsupported credential envelope.");
    }

    credential = decryptCredentialForValidation(
      {
        ciphertext: secret.ciphertext,
        nonce: secret.nonce,
        authTag: secret.auth_tag,
        algorithm: "aes-256-gcm",
        envelopeVersion: 1,
        keyVersion: secret.key_version,
      },
      {
        userId,
        accountId,
        provider: secret.aad_provider,
      }
    );
    validation = await validateLlmProviderCredential(
      current.provider,
      credential,
      validationRequestId
    );
  } catch {
    validation = { ok: false, code: "unknown" };
  } finally {
    credential = "";
  }

  const { data: applied, error: applyError } = await serviceClient.rpc(
    "apply_llm_account_validation",
    {
      p_account_id: accountId,
      p_user_id: userId,
      p_validation_request_id: validationRequestId,
      p_validation_generation: secret.validation_generation,
      p_succeeded: validation.ok,
      p_error_code: validation.ok ? null : validation.code,
      p_models: validation.ok ? (validation.models as Json) : [],
    }
  );

  if (applyError) {
    throw new Error("Não foi possível aplicar a validação da conta LLM.", {
      cause: applyError,
    });
  }

  if (!applied) {
    throw new LlmValidationSupersededError();
  }

  return getOwnedPublicAccount(client, userId, accountId);
}

export async function updateLlmAccount(
  userId: string,
  accountId: string,
  input: UpdateLlmAccountInput
): Promise<LlmAccountPublic | null> {
  const client = await createAuthorizedClient(userId);
  const current = await getOwnedAccount(client, userId, accountId);

  if (!current) {
    return null;
  }

  if (current.provider === "openai_compatible" && !input.customEndpoint) {
    throw new LlmAccountLifecycleError(
      "Indique o endpoint do fornecedor OpenAI-compatible."
    );
  }

  if (current.provider !== "openai_compatible" && input.customEndpoint) {
    throw new LlmAccountLifecycleError(
      "Este fornecedor não aceita um endpoint personalizado."
    );
  }

  const { data, error } = await client
    .from("llm_accounts")
    .update({
      display_name: input.displayName,
      custom_endpoint:
        current.provider === "openai_compatible"
          ? (input.customEndpoint ?? null)
          : null,
    })
    .eq("id", accountId)
    .eq("user_id", userId)
    .eq("updated_at", current.updated_at)
    .select(PUBLIC_ACCOUNT_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      throw new LlmAccountConflictError(
        "Já existe uma conta LLM com este nome."
      );
    }

    throw new Error("Não foi possível atualizar a conta LLM.", {
      cause: error,
    });
  }

  if (!data) {
    throw new LlmAccountLifecycleError(
      "A conta foi alterada por outro pedido. Atualize a lista e tente novamente."
    );
  }

  const updated = await getOwnedPublicAccount(client, userId, data.id);

  if (!updated) {
    throw new Error("A conta atualizada deixou de estar disponível.");
  }

  return updated;
}

export async function replaceLlmCredential(
  userId: string,
  accountId: string,
  credential: string
): Promise<LlmAccountPublic | null> {
  const client = await createAuthorizedClient(userId);
  const current = await getOwnedAccount(client, userId, accountId);

  if (!current) {
    return null;
  }

  if (!isManuallyManagedLlmCredentialType(current.credential_type)) {
    throw new LlmCredentialValidationError(
      "Esta credencial é gerida pela integração e não pode ser substituída manualmente."
    );
  }

  const credentialError = getLlmCredentialError(current.provider, credential);

  if (credentialError) {
    throw new LlmCredentialValidationError(credentialError);
  }

  const encrypted = encryptCredentialForStorage(credential, {
    userId,
    accountId,
    provider: current.provider,
  });
  const serviceClient = createServiceRoleClient();
  const { data, error } = await serviceClient
    .rpc("rotate_llm_account_secret", {
      p_account_id: accountId,
      p_user_id: userId,
      p_credential_suffix: credentialSuffix(credential),
      p_ciphertext: encrypted.ciphertext,
      p_nonce: encrypted.nonce,
      p_auth_tag: encrypted.authTag,
      p_algorithm: encrypted.algorithm,
      p_envelope_version: encrypted.envelopeVersion,
      p_key_version: encrypted.keyVersion,
    })
    .single();

  if (error) {
    if (error.code === "P0002") {
      throw new LlmAccountLifecycleError(
        "A conta foi alterada por outro pedido. Atualize a lista e tente novamente."
      );
    }

    throw new Error("Não foi possível substituir a credencial LLM.", {
      cause: error,
    });
  }

  const rotated = await getOwnedPublicAccount(client, userId, data.id);

  if (!rotated) {
    throw new Error("A conta atualizada deixou de estar disponível.");
  }

  return rotated;
}

export async function permanentlyDeleteLlmAccount(
  userId: string,
  accountId: string,
  confirmationName: string
): Promise<"deleted" | "not_found"> {
  const client = await createAuthorizedClient(userId);
  const current = await getOwnedAccount(client, userId, accountId);

  if (!current) {
    return "not_found";
  }

  if (confirmationName !== current.display_name) {
    throw new LlmAccountLifecycleError(
      "A confirmação não corresponde ao nome da conta."
    );
  }

  const { data, error } = await client
    .from("llm_accounts")
    .delete()
    .eq("id", accountId)
    .eq("user_id", userId)
    .eq("display_name", current.display_name)
    .eq("updated_at", current.updated_at)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error("Não foi possível eliminar a conta LLM.", {
      cause: error,
    });
  }

  if (!data) {
    const remaining = await getOwnedAccount(client, userId, accountId);

    if (!remaining) {
      return "not_found";
    }

    throw new LlmAccountLifecycleError(
      "A conta foi alterada por outro pedido. Atualize a lista e tente novamente."
    );
  }

  return "deleted";
}

async function createAuthorizedClient(userId: string) {
  const client = await createClient();
  const user = await requireAuthorizedUser({
    supabase: client,
    onUnauthorized: "throw",
  });

  if (user.id !== userId) {
    throw new AuthorizationError();
  }

  return client;
}

async function getOwnedAccount(
  client: CarcanholClient,
  userId: string,
  accountId: string
): Promise<LlmAccount | null> {
  const { data, error } = await client
    .from("llm_accounts")
    .select(PUBLIC_ACCOUNT_COLUMNS)
    .eq("id", accountId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error("Não foi possível carregar a conta LLM.", {
      cause: error,
    });
  }

  return data;
}

async function getOwnedPublicAccount(
  client: CarcanholClient,
  userId: string,
  accountId: string
): Promise<LlmAccountPublic | null> {
  const account = await getOwnedAccount(client, userId, accountId);

  if (!account) {
    return null;
  }

  const models = await listModelsForAccounts(client, userId, [accountId]);
  return toPublicAccount(account, models.get(accountId) ?? []);
}

async function listModelsForAccounts(
  client: CarcanholClient,
  userId: string,
  accountIds: string[]
) {
  const byAccount = new Map<string, LlmAccountModel[]>();

  if (accountIds.length === 0) {
    return byAccount;
  }

  const { data, error } = await client
    .from("llm_account_models")
    .select(PUBLIC_MODEL_COLUMNS)
    .eq("user_id", userId)
    .in("account_id", accountIds)
    .order("display_name", { ascending: true });

  if (error) {
    throw new Error("Não foi possível carregar os modelos LLM.", {
      cause: error,
    });
  }

  for (const model of data) {
    const current = byAccount.get(model.account_id) ?? [];
    current.push(model);
    byAccount.set(model.account_id, current);
  }

  return byAccount;
}

function credentialSuffix(credential: string) {
  return credential.slice(-4);
}

function toPublicAccount(
  account: LlmAccount,
  models: LlmAccountModel[]
): LlmAccountPublic {
  return {
    id: account.id,
    provider: account.provider,
    display_name: account.display_name,
    credential_type: account.credential_type,
    status: account.status,
    custom_endpoint: account.custom_endpoint,
    credential_hint: `•••• ${account.credential_suffix}`,
    credential_updated_at: account.credential_updated_at,
    last_validation_status: account.last_validation_status,
    last_validation_at: account.last_validation_at,
    last_validation_error_code: account.last_validation_error_code,
    created_at: account.created_at,
    updated_at: account.updated_at,
    models: models.map(toPublicModel),
  };
}

function toPublicModel(model: LlmAccountModel): LlmAccountModelPublic {
  const metadata =
    typeof model.discovery_metadata === "object" &&
    model.discovery_metadata !== null &&
    !Array.isArray(model.discovery_metadata)
      ? model.discovery_metadata
      : {};

  return {
    id: model.id,
    provider_model_id: model.provider_model_id,
    display_name: model.display_name,
    enabled: model.enabled,
    is_stale: model.is_stale,
    discovered_at: model.discovered_at,
    last_seen_at: model.last_seen_at,
    capabilities: metadata.capabilities ?? {},
    policy: metadata.policy ?? {},
    billing: metadata.billing ?? {},
  };
}

export class LlmAccountConflictError extends Error {}
export class LlmAccountLifecycleError extends Error {}
export class LlmCredentialValidationError extends Error {}
export class LlmValidationSupersededError extends Error {}
export class LlmProviderValidationError extends Error {
  readonly code: LlmValidationErrorCode;
  readonly action: string;

  constructor(code: LlmValidationErrorCode) {
    const guidance = getLlmValidationGuidance(code);
    super(guidance?.message ?? "Não foi possível validar a conta LLM.");
    this.code = code;
    this.action =
      guidance?.action ?? "Revise a configuração e tente novamente.";
  }
}
