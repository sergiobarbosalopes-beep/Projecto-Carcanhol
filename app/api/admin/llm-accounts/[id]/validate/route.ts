import { AuthorizationError, requireAuthorizedUser } from "@/src/auth/server";
import {
  LlmProviderValidationError,
  LlmValidationSupersededError,
  revalidateLlmAccount,
} from "@/src/admin/llm-accounts";
import { llmAccountIdSchema } from "@/src/admin/llm-validation";
import { createClient } from "@/src/database/server";
import { jsonError, jsonSuccess, rejectCrossOrigin } from "@/src/http/api";
import { consumeUserAndIpRateLimit } from "@/src/http/rate-limit";

export const runtime = "nodejs";

type LlmValidationRouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(
  request: Request,
  context: LlmValidationRouteContext
) {
  const originError = rejectCrossOrigin(request);

  if (originError) {
    return originError;
  }

  const { id } = await context.params;
  const parsedId = llmAccountIdSchema.safeParse(id);

  if (!parsedId.success) {
    return jsonError("Identificador de conta LLM inválido.", 400);
  }

  try {
    const supabase = await createClient();
    const user = await requireAuthorizedUser({
      supabase,
      onUnauthorized: "throw",
    });
    const rateLimit = consumeUserAndIpRateLimit({
      request,
      scope: "llm-account-validation",
      userId: user.id,
      userLimit: 60,
      ipLimit: 200,
      windowMs: 5 * 60_000,
    });

    if (!rateLimit.allowed) {
      return jsonError(
        "Foram feitas demasiadas validações. Aguarde antes de tentar novamente.",
        429,
        { retryAfterSeconds: rateLimit.retryAfterSeconds }
      );
    }

    const account = await revalidateLlmAccount(user.id, parsedId.data);

    return account
      ? jsonSuccess({ account })
      : jsonError("Conta LLM não encontrada.", 404);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return jsonError("Sessão inválida ou sem acesso.", 401);
    }

    if (error instanceof LlmProviderValidationError) {
      return jsonError(error.message, 422, {
        code: error.code,
        action: error.action,
      });
    }

    if (error instanceof LlmValidationSupersededError) {
      return jsonError(
        "Esta validação foi substituída por um pedido mais recente.",
        409,
        {
          code: "validation_superseded",
          action: "Atualize a conta para consultar o resultado mais recente.",
        }
      );
    }

    return jsonError("Não foi possível validar a conta LLM.", 500);
  }
}
