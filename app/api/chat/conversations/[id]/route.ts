import { AuthorizationError, requireAuthorizedUser } from "@/src/auth/server";
import { deleteConversation, updateConversation } from "@/src/chat/repository";
import { updateConversationSchema } from "@/src/chat/contract";
import { createClient } from "@/src/database/server";
import {
  jsonError,
  jsonSuccess,
  readBoundedRequestBody,
  rejectCrossOrigin,
  RequestBodyTooLargeError,
} from "@/src/http/api";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const originError = rejectCrossOrigin(request);
  if (originError) return originError;

  try {
    const { id } = await context.params;
    const client = await createClient();
    const user = await requireAuthorizedUser({
      supabase: client,
      onUnauthorized: "throw",
    });
    const parsed = updateConversationSchema.safeParse(
      JSON.parse(await readBoundedRequestBody(request, 4096))
    );

    if (!parsed.success) {
      return jsonError("Pedido inválido.", 400);
    }

    const conversation = await updateConversation(
      client,
      user.id,
      id,
      parsed.data
    );
    return conversation
      ? jsonSuccess(conversation)
      : jsonError("Conversa não encontrada.", 404);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return jsonError("Sessão inválida ou sem acesso.", 401);
    }
    if (
      error instanceof RequestBodyTooLargeError ||
      error instanceof SyntaxError
    ) {
      return jsonError("Pedido inválido.", 400);
    }
    return jsonError("Não foi possível atualizar a conversa.", 409);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const originError = rejectCrossOrigin(request);
  if (originError) return originError;

  try {
    const { id } = await context.params;
    const client = await createClient();
    const user = await requireAuthorizedUser({
      supabase: client,
      onUnauthorized: "throw",
    });
    return (await deleteConversation(client, user.id, id))
      ? jsonSuccess({ success: true })
      : jsonError("Conversa não encontrada.", 404);
  } catch (error) {
    return error instanceof AuthorizationError
      ? jsonError("Sessão inválida ou sem acesso.", 401)
      : jsonError("Não foi possível eliminar a conversa.", 500);
  }
}
