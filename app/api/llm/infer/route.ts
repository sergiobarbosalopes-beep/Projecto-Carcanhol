import { AuthorizationError, requireAuthorizedUser } from "@/src/auth/server";
import { createClient } from "@/src/database/server";
import {
  jsonError,
  jsonSuccess,
  readBoundedRequestBody,
  rejectCrossOrigin,
  RequestBodyTooLargeError,
} from "@/src/http/api";
import { consumeUserAndIpRateLimit } from "@/src/http/rate-limit";
import {
  LlmInferenceDefaultUnavailableError,
  LlmInferenceTimeoutError,
  runLlmInference,
} from "@/src/llm/inference";
import { copilotInferencePromptSchema } from "@/services/copilot-worker/src/contract";
import { z } from "zod";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 2 * 1024;
const inferenceRequestSchema = z
  .object({
    prompt: copilotInferencePromptSchema,
  })
  .strict();

export async function POST(request: Request) {
  const originError = rejectCrossOrigin(request);

  if (originError) {
    return originError;
  }

  try {
    const supabase = await createClient();
    const user = await requireAuthorizedUser({
      supabase,
      onUnauthorized: "throw",
    });
    const rateLimit = consumeUserAndIpRateLimit({
      request,
      scope: "llm-inference",
      userId: user.id,
      userLimit: 10,
      ipLimit: 30,
      windowMs: 60_000,
    });

    if (!rateLimit.allowed) {
      return jsonError(
        "Foram feitos demasiados pedidos. Aguarde antes de tentar novamente.",
        429,
        { retryAfterSeconds: rateLimit.retryAfterSeconds }
      );
    }

    if (
      request.headers.get("content-type")?.split(";")[0]?.trim() !==
      "application/json"
    ) {
      return jsonError("Conteúdo inválido.", 415);
    }

    const body = await readBoundedRequestBody(request, MAX_BODY_BYTES);
    let input: unknown;

    try {
      input = JSON.parse(body);
    } catch {
      return jsonError("Pedido inválido.", 400);
    }

    const parsed = inferenceRequestSchema.safeParse(input);

    if (!parsed.success) {
      return jsonError("Pedido inválido.", 400);
    }

    return jsonSuccess(
      await runLlmInference(user.id, parsed.data.prompt, supabase)
    );
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return jsonError("Sessão inválida ou sem acesso.", 401);
    }

    if (error instanceof RequestBodyTooLargeError) {
      return jsonError("Pedido demasiado grande.", 413);
    }

    if (error instanceof LlmInferenceDefaultUnavailableError) {
      return jsonError("Não existe uma predefinição LLM atual e ativa.", 409);
    }

    if (error instanceof LlmInferenceTimeoutError) {
      return jsonError("A inferência excedeu o tempo limite.", 504);
    }

    return jsonError("Não foi possível executar a inferência.", 502);
  }
}
