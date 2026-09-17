import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createCopilotInferenceWorkerHttpClient } from "@/services/copilot-worker/src/http-client";
import { createCopilotStreamingWorkerHttpClient } from "@/services/copilot-worker/src/http-client";
import {
  createClient,
  createServiceRoleClient,
  type CarcanholClient,
} from "@/src/database/server";
import { decryptCredentialForValidation } from "@/src/security/llm-credentials";
import { getCopilotWorkerEnv } from "@/src/utils/env";

const inferenceDefaultSchema = z
  .object({
    account_id: z.string().uuid(),
    provider: z.literal("github_copilot"),
    provider_model_id: z.string().trim().min(1).max(255),
    aad_provider: z.string().trim().min(1).max(64),
    ciphertext: z.string().min(1),
    nonce: z.string().min(1),
    auth_tag: z.string().min(1),
    algorithm: z.literal("aes-256-gcm"),
    envelope_version: z.literal(1),
    key_version: z.string().min(1).max(32),
  })
  .strict();

export async function runLlmInference(
  userId: string,
  prompt: string,
  authenticatedClient?: CarcanholClient,
  options: {
    systemPrompt?: string;
    signal?: AbortSignal;
    accountModelId?: string;
  } = {}
) {
  const client = authenticatedClient ?? (await createClient());
  const target = await loadOwnedInferenceTarget(
    client,
    userId,
    options.accountModelId
  );
  let credential = "";

  try {
    credential = decryptCredentialForValidation(
      {
        ciphertext: target.ciphertext,
        nonce: target.nonce,
        authTag: target.auth_tag,
        algorithm: target.algorithm,
        envelopeVersion: target.envelope_version,
        keyVersion: target.key_version,
      },
      {
        userId,
        accountId: target.account_id,
        provider: target.aad_provider,
      }
    );
    const requestId = randomUUID();
    const {
      COPILOT_WORKER_URL,
      COPILOT_WORKER_HMAC_SECRET,
      COPILOT_WORKER_TIMEOUT_MS,
    } = getCopilotWorkerEnv();
    const infer = createCopilotInferenceWorkerHttpClient({
      baseUrl: COPILOT_WORKER_URL,
      hmacSecret: COPILOT_WORKER_HMAC_SECRET,
      timeoutMs: COPILOT_WORKER_TIMEOUT_MS,
    });
    const result = await infer(
      credential,
      target.provider_model_id,
      prompt,
      requestId,
      options.systemPrompt,
      options.signal
    );

    if (!result.ok) {
      if (result.code === "timeout") {
        throw new LlmInferenceTimeoutError();
      }

      throw new LlmInferenceUnavailableError();
    }

    return {
      text: result.text,
      ...(result.usage ? { usage: result.usage } : {}),
      durationMs: result.durationMs,
    };
  } finally {
    credential = "";
  }
}

export async function openLlmInferenceStream(
  userId: string,
  accountModelId: string,
  prompt: string,
  authenticatedClient: CarcanholClient,
  options: { systemPrompt?: string; signal?: AbortSignal } = {}
) {
  const target = await loadOwnedInferenceTarget(
    authenticatedClient,
    userId,
    accountModelId
  );
  let credential = "";

  try {
    credential = decryptCredentialForValidation(
      {
        ciphertext: target.ciphertext,
        nonce: target.nonce,
        authTag: target.auth_tag,
        algorithm: target.algorithm,
        envelopeVersion: target.envelope_version,
        keyVersion: target.key_version,
      },
      {
        userId,
        accountId: target.account_id,
        provider: target.aad_provider,
      }
    );
    const requestId = randomUUID();
    const {
      COPILOT_WORKER_URL,
      COPILOT_WORKER_HMAC_SECRET,
      COPILOT_WORKER_TIMEOUT_MS,
    } = getCopilotWorkerEnv();
    const stream = createCopilotStreamingWorkerHttpClient({
      baseUrl: COPILOT_WORKER_URL,
      hmacSecret: COPILOT_WORKER_HMAC_SECRET,
      timeoutMs: COPILOT_WORKER_TIMEOUT_MS,
    });
    const result = await stream(
      credential,
      target.provider_model_id,
      prompt,
      requestId,
      options.systemPrompt,
      options.signal
    );

    if (!result.ok) {
      if (result.code === "timeout") {
        throw new LlmInferenceTimeoutError();
      }
      throw new LlmInferenceUnavailableError();
    }

    return result;
  } finally {
    credential = "";
  }
}

async function loadOwnedInferenceTarget(
  client: CarcanholClient,
  userId: string,
  accountModelId?: string
) {
  if (accountModelId) {
    const serviceClient = createServiceRoleClient();
    const { data, error } = await serviceClient
      .rpc("get_llm_chat_target", {
        p_user_id: userId,
        p_account_model_id: accountModelId,
      })
      .maybeSingle();

    if (error) {
      throw new LlmInferenceUnavailableError();
    }

    if (!data) {
      throw new LlmInferenceDefaultUnavailableError();
    }

    const parsed = inferenceDefaultSchema.safeParse(data);

    if (!parsed.success) {
      throw new LlmInferenceUnavailableError();
    }

    return parsed.data;
  }

  const { data: preference, error: preferenceError } = await client
    .from("llm_model_preferences")
    .select("account_model_id")
    .eq("user_id", userId)
    .eq("scope", "global")
    .maybeSingle();

  if (preferenceError) {
    throw new LlmInferenceUnavailableError();
  }

  if (!preference) {
    throw new LlmInferenceDefaultUnavailableError();
  }

  const serviceClient = createServiceRoleClient();
  const { data, error } = await serviceClient
    .rpc("get_llm_inference_target", {
      p_user_id: userId,
      p_account_model_id: preference.account_model_id,
    })
    .maybeSingle();

  if (error) {
    throw new LlmInferenceUnavailableError();
  }

  if (!data) {
    throw new LlmInferenceDefaultUnavailableError();
  }

  const parsed = inferenceDefaultSchema.safeParse(data);

  if (!parsed.success) {
    throw new LlmInferenceUnavailableError();
  }

  return parsed.data;
}

export class LlmInferenceDefaultUnavailableError extends Error {}
export class LlmInferenceTimeoutError extends Error {}
export class LlmInferenceUnavailableError extends Error {}
