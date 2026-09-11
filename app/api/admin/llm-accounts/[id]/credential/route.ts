import { AuthorizationError, requireAuthorizedUser } from "@/src/auth/server";
import {
  LlmAccountLifecycleError,
  LlmCredentialValidationError,
  replaceLlmCredential,
} from "@/src/admin/llm-accounts";
import {
  llmAccountIdSchema,
  replaceLlmCredentialSchema,
} from "@/src/admin/llm-validation";
import { createClient } from "@/src/database/server";
import { jsonError, jsonSuccess, rejectCrossOrigin } from "@/src/http/api";

type LlmCredentialRouteContext = {
  params: Promise<{ id: string }>;
};

export async function PUT(
  request: Request,
  context: LlmCredentialRouteContext
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

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return jsonError("Credencial inválida.", 400);
  }

  const input = replaceLlmCredentialSchema.safeParse(body);

  if (!input.success) {
    return jsonError("Indique uma credencial válida.", 400);
  }

  try {
    const supabase = await createClient();
    const user = await requireAuthorizedUser({
      supabase,
      onUnauthorized: "throw",
    });
    const account = await replaceLlmCredential(
      user.id,
      parsedId.data,
      input.data.credential
    );

    return account
      ? jsonSuccess({ account })
      : jsonError("Conta LLM não encontrada.", 404);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return jsonError("Sessão inválida ou sem acesso.", 401);
    }

    if (error instanceof LlmCredentialValidationError) {
      return jsonError(error.message, 400);
    }

    if (error instanceof LlmAccountLifecycleError) {
      return jsonError(error.message, 409);
    }

    return jsonError("Não foi possível substituir a credencial LLM.", 500);
  }
}
