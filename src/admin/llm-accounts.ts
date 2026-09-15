import "server-only";

import { randomUUID } from "node:crypto";
import { AuthorizationError, requireAuthorizedUser } from "@/src/auth/server";
import {
  getLlmCredentialError,
  isManuallyManagedLlmCredentialType,
} from "@/src/admin/llm-validation";
import {
  createClient,
  createServiceRoleClient,
  type CarcanholClient,
} from "@/src/database/server";
import { encryptCredentialForStorage } from "@/src/security/llm-credentials";
import type {
  LlmAccount,
  LlmAccountPublic,
  LlmCredentialType,
  LlmProvider,
} from "@/src/types/supabase";

const PUBLIC_ACCOUNT_COLUMNS =
  "id, user_id, provider, display_name, credential_type, status, custom_endpoint, credential_suffix, credential_updated_at, last_validation_status, last_validation_at, last_validation_error_code, created_at, updated_at";

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

  return data.map(toPublicAccount);
}

export async function createLlmAccount(
  userId: string,
  input: CreateLlmAccountInput
): Promise<LlmAccountPublic> {
  await createAuthorizedClient(userId);
  const credentialError = getLlmCredentialError(
    input.provider,
    input.credential
  );

  if (credentialError) {
    throw new LlmCredentialValidationError(credentialError);
  }

  const accountId = randomUUID();
  const encrypted = encryptCredentialForStorage(input.credential, {
    userId,
    accountId,
    provider: input.provider,
  });
  const serviceClient = createServiceRoleClient();
  const { data, error } = await serviceClient
    .rpc("create_llm_account_with_secret", {
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

  return toPublicAccount(data);
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

  return toPublicAccount(data);
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

  return toPublicAccount(data);
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

function credentialSuffix(credential: string) {
  return credential.slice(-4);
}

function toPublicAccount(account: LlmAccount): LlmAccountPublic {
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
  };
}

export class LlmAccountConflictError extends Error {}
export class LlmAccountLifecycleError extends Error {}
export class LlmCredentialValidationError extends Error {}
