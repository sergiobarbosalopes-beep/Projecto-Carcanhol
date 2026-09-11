import { AuthorizationError, requireAuthorizedUser } from "@/src/auth/server";
import {
  LlmAccountConflictError,
  LlmAccountLifecycleError,
  permanentlyDeleteLlmAccount,
  updateLlmAccount,
} from "@/src/admin/llm-accounts";
import {
  deleteLlmAccountSchema,
  llmAccountIdSchema,
  updateLlmAccountSchema,
} from "@/src/admin/llm-validation";
import { createClient } from "@/src/database/server";
import { jsonError, jsonSuccess, rejectCrossOrigin } from "@/src/http/api";

type LlmAccountRouteContext = {
  params: Promise<{ id: string }>;
};

async function parseId(context: LlmAccountRouteContext) {
  const { id } = await context.params;
  return llmAccountIdSchema.safeParse(id);
}

export async function PATCH(request: Request, context: LlmAccountRouteContext) {
  const originError = rejectCrossOrigin(request);

  if (originError) {
    return originError;
  }

  const id = await parseId(context);

  if (!id.success) {
    return jsonError("Identificador de conta LLM inválido.", 400);
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return jsonError("Dados da conta LLM inválidos.", 400);
  }

  const input = updateLlmAccountSchema.safeParse(body);

  if (!input.success) {
    return jsonError("Revise o nome e o endpoint da conta.", 400);
  }

  try {
    const supabase = await createClient();
    const user = await requireAuthorizedUser({
      supabase,
      onUnauthorized: "throw",
    });
    const account = await updateLlmAccount(user.id, id.data, input.data);

    return account
      ? jsonSuccess({ account })
      : jsonError("Conta LLM não encontrada.", 404);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return jsonError("Sessão inválida ou sem acesso.", 401);
    }

    if (
      error instanceof LlmAccountConflictError ||
      error instanceof LlmAccountLifecycleError
    ) {
      return jsonError(error.message, 409);
    }

    return jsonError("Não foi possível atualizar a conta LLM.", 500);
  }
}

export async function DELETE(
  request: Request,
  context: LlmAccountRouteContext
) {
  const originError = rejectCrossOrigin(request);

  if (originError) {
    return originError;
  }

  const id = await parseId(context);

  if (!id.success) {
    return jsonError("Identificador de conta LLM inválido.", 400);
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return jsonError("Confirmação inválida.", 400);
  }

  const input = deleteLlmAccountSchema.safeParse(body);

  if (!input.success) {
    return jsonError("Confirmação inválida.", 400);
  }

  try {
    const supabase = await createClient();
    const user = await requireAuthorizedUser({
      supabase,
      onUnauthorized: "throw",
    });
    const result = await permanentlyDeleteLlmAccount(
      user.id,
      id.data,
      input.data.confirmationName
    );

    return result === "deleted"
      ? jsonSuccess({ success: true })
      : jsonError("Conta LLM não encontrada.", 404);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return jsonError("Sessão inválida ou sem acesso.", 401);
    }

    if (error instanceof LlmAccountLifecycleError) {
      return jsonError(error.message, 409);
    }

    return jsonError("Não foi possível eliminar a conta LLM.", 500);
  }
}
