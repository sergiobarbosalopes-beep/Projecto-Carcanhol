import { AuthorizationError, requireAuthorizedUser } from "@/src/auth/server";
import {
  LlmAccountLifecycleError,
  setGlobalLlmDefault,
} from "@/src/admin/llm-accounts";
import { setGlobalLlmDefaultSchema } from "@/src/admin/llm-validation";
import { createClient } from "@/src/database/server";
import { jsonError, jsonSuccess, rejectCrossOrigin } from "@/src/http/api";

export async function PUT(request: Request) {
  const originError = rejectCrossOrigin(request);

  if (originError) {
    return originError;
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return jsonError("Modelo predefinido inválido.", 400);
  }

  const input = setGlobalLlmDefaultSchema.safeParse(body);

  if (!input.success) {
    return jsonError("Modelo predefinido inválido.", 400);
  }

  try {
    const supabase = await createClient();
    const user = await requireAuthorizedUser({
      supabase,
      onUnauthorized: "throw",
    });
    const accountModelId = await setGlobalLlmDefault(
      user.id,
      input.data.accountModelId
    );

    return jsonSuccess({ accountModelId });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return jsonError("Sessão inválida ou sem acesso.", 401);
    }

    if (error instanceof LlmAccountLifecycleError) {
      return jsonError(error.message, 409);
    }

    return jsonError("Não foi possível alterar a predefinição LLM.", 500);
  }
}
