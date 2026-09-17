import { z } from "zod";
import { AuthorizationError, requireAuthorizedUser } from "@/src/auth/server";
import { createConversation, loadChatBootstrap } from "@/src/chat/repository";
import { createConversationSchema } from "@/src/chat/contract";
import { createClient } from "@/src/database/server";
import {
  jsonError,
  jsonSuccess,
  readBoundedRequestBody,
  rejectCrossOrigin,
  RequestBodyTooLargeError,
} from "@/src/http/api";
import { consumeUserAndIpRateLimit } from "@/src/http/rate-limit";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const client = await createClient();
    const user = await requireAuthorizedUser({
      supabase: client,
      onUnauthorized: "throw",
    });
    const conversationId = new URL(request.url).searchParams.get(
      "conversationId"
    );

    if (
      conversationId &&
      !z.string().uuid().safeParse(conversationId).success
    ) {
      return jsonError("Conversa inválida.", 400);
    }

    return jsonSuccess(
      await loadChatBootstrap(client, user.id, conversationId ?? undefined)
    );
  } catch (error) {
    return error instanceof AuthorizationError
      ? jsonError("Sessão inválida ou sem acesso.", 401)
      : jsonError("Não foi possível carregar o Chat.", 500);
  }
}

export async function POST(request: Request) {
  const originError = rejectCrossOrigin(request);

  if (originError) {
    return originError;
  }

  try {
    const client = await createClient();
    const user = await requireAuthorizedUser({
      supabase: client,
      onUnauthorized: "throw",
    });
    const rateLimit = consumeUserAndIpRateLimit({
      request,
      scope: "chat-conversation-create",
      userId: user.id,
      userLimit: 20,
      ipLimit: 60,
      windowMs: 60_000,
    });

    if (!rateLimit.allowed) {
      return jsonError("Demasiados pedidos.", 429, {
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
    }

    const parsed = createConversationSchema.safeParse(
      JSON.parse(await readBoundedRequestBody(request, 1024))
    );

    if (!parsed.success) {
      return jsonError("Pedido inválido.", 400);
    }

    return jsonSuccess(
      await createConversation(client, user.id, parsed.data.accountModelId),
      201
    );
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
    return jsonError("Não foi possível criar a conversa.", 409);
  }
}
