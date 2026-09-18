import {
  COPILOT_WORKER_MAX_RESPONSE_BYTES,
  copilotStreamEventSchema,
} from "@/services/copilot-worker/src/contract";
import { AuthorizationError, requireAuthorizedUser } from "@/src/auth/server";
import {
  chatTurnSchema,
  mergeChatWebSources,
  type ChatWebSource,
  type PublicChatStreamEvent,
} from "@/src/chat/contract";
import {
  ChatConflictError,
  ChatNotFoundError,
  ChatSkillContextTooLargeError,
  ChatSkillUnavailableError,
  finalizeAssistantMessage,
  prepareChatTurn,
} from "@/src/chat/repository";
import { createClient } from "@/src/database/server";
import {
  jsonError,
  readBoundedRequestBody,
  rejectCrossOrigin,
  RequestBodyTooLargeError,
} from "@/src/http/api";
import { consumeUserAndIpRateLimit } from "@/src/http/rate-limit";
import { acquireRequestSlot } from "@/src/http/request-slot";
import {
  LlmInferenceTimeoutError,
  openLlmInferenceStream,
} from "@/src/llm/inference";
import type { Json } from "@/src/types/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const originError = rejectCrossOrigin(request);
  if (originError) return originError;

  let releaseSlot: (() => void) | null = null;
  let detachRequestAbort: (() => void) | null = null;

  try {
    const client = await createClient();
    const user = await requireAuthorizedUser({
      supabase: client,
      onUnauthorized: "throw",
    });
    const rateLimit = consumeUserAndIpRateLimit({
      request,
      scope: "chat-message",
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

    const parsed = chatTurnSchema.safeParse(
      JSON.parse(await readBoundedRequestBody(request, 12 * 1024))
    );
    if (!parsed.success) return jsonError("Pedido inválido.", 400);

    releaseSlot = acquireRequestSlot(
      "chat-conversation",
      `${user.id}:${parsed.data.conversationId}`
    );
    if (!releaseSlot) {
      return jsonError("Já existe uma resposta em curso nesta conversa.", 409);
    }

    const turn = await prepareChatTurn(client, user.id, parsed.data);

    if (turn.already_exists) {
      releaseSlot();
      releaseSlot = null;
      return jsonError("Este pedido já foi processado.", 409);
    }

    const streamAbort = new AbortController();
    const abortForRequest = () => streamAbort.abort("browser_disconnect");
    request.signal.addEventListener("abort", abortForRequest, { once: true });
    detachRequestAbort = () =>
      request.signal.removeEventListener("abort", abortForRequest);
    let worker: Awaited<ReturnType<typeof openLlmInferenceStream>>;
    try {
      worker = await openLlmInferenceStream(
        user.id,
        parsed.data.accountModelId,
        turn.prompt,
        client,
        { systemPrompt: turn.systemPrompt, signal: streamAbort.signal }
      );
    } catch (error) {
      await finalizeAssistantMessage(
        client,
        user.id,
        turn.assistant_message_id,
        "failed",
        "",
        {
          errorCode:
            error instanceof LlmInferenceTimeoutError
              ? "timeout"
              : "provider_unavailable",
        }
      ).catch(() => undefined);
      throw error;
    }
    const encoder = new TextEncoder();
    let released = false;
    const release = () => {
      if (!released) {
        releaseSlot?.();
        released = true;
      }
    };

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: PublicChatStreamEvent) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        let content = "";
        let terminalPersisted = false;
        let webSources: ChatWebSource[] = [];

        send({
          v: 1,
          type: "start",
          conversationId: turn.conversation_id,
          userMessageId: turn.user_message_id,
          assistantMessageId: turn.assistant_message_id,
          conversationVersion: turn.conversation_version,
        });

        try {
          const reader = worker.response.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let totalBytes = 0;
          let expectedSequence = 1;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > COPILOT_WORKER_MAX_RESPONSE_BYTES) {
              await reader.cancel();
              throw new Error("Worker stream exceeded limit.");
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line) continue;
              const event = copilotStreamEventSchema.parse(JSON.parse(line));
              if (event.requestId !== worker.requestId) {
                throw new Error("Mismatched worker request.");
              }

              if (event.type === "heartbeat") {
                send({ v: 1, type: "heartbeat" });
              } else if (event.type === "tool") {
                send({
                  v: 1,
                  type: "tool",
                  assistantMessageId: turn.assistant_message_id,
                  tool: event.tool,
                  status: event.status,
                  ...(event.source ? { source: event.source } : {}),
                });
              } else if (event.type === "sources") {
                webSources = mergeChatWebSources(webSources, event.sources);
                send({
                  v: 1,
                  type: "sources",
                  assistantMessageId: turn.assistant_message_id,
                  sources: webSources,
                });
              } else if (event.type === "delta") {
                if (event.sequence !== expectedSequence) {
                  throw new Error("Out-of-order worker stream.");
                }
                expectedSequence += 1;
                content += event.text;
                send({
                  v: 1,
                  type: "delta",
                  assistantMessageId: turn.assistant_message_id,
                  sequence: event.sequence,
                  text: event.text,
                });
              } else if (event.type === "done") {
                if (terminalPersisted)
                  throw new Error("Duplicate terminal event.");
                content = event.text;
                const usage = {
                  ...(event.usage ?? {}),
                  ...(webSources.length > 0 ? { webSources } : {}),
                } as Json;
                await finalizeAssistantMessage(
                  client,
                  user.id,
                  turn.assistant_message_id,
                  "complete",
                  content,
                  { usage }
                );
                terminalPersisted = true;
                send({
                  v: 1,
                  type: "done",
                  assistantMessageId: turn.assistant_message_id,
                  content,
                  ...(event.usage ? { usage: event.usage } : {}),
                });
              } else if (event.type === "error") {
                if (terminalPersisted)
                  throw new Error("Duplicate terminal event.");
                const cancelled = event.code === "cancelled";
                await finalizeAssistantMessage(
                  client,
                  user.id,
                  turn.assistant_message_id,
                  cancelled ? "cancelled" : "failed",
                  content,
                  {
                    errorCode: mapWorkerError(event.code),
                  }
                );
                terminalPersisted = true;
                send({
                  v: 1,
                  type: "error",
                  assistantMessageId: turn.assistant_message_id,
                  code: mapWorkerError(event.code),
                  message: cancelled
                    ? "Resposta cancelada."
                    : "Não foi possível concluir a resposta.",
                });
              }
            }
          }

          if (!terminalPersisted) {
            throw new Error("Worker stream ended without terminal event.");
          }
        } catch {
          if (!terminalPersisted) {
            const cancelled = streamAbort.signal.aborted;
            const finalized = await finalizeAssistantMessage(
              client,
              user.id,
              turn.assistant_message_id,
              cancelled ? "cancelled" : "failed",
              content,
              {
                errorCode: cancelled ? "cancelled" : "stream_interrupted",
              }
            )
              .then(() => true)
              .catch(() => false);
            terminalPersisted = finalized;
            if (finalized) {
              send({
                v: 1,
                type: "error",
                assistantMessageId: turn.assistant_message_id,
                code: cancelled ? "cancelled" : "stream_interrupted",
                message: cancelled
                  ? "Resposta cancelada."
                  : "A ligação à resposta foi interrompida.",
              });
            }
          }
        } finally {
          detachRequestAbort?.();
          release();
          controller.close();
        }
      },
      cancel() {
        streamAbort.abort("browser_cancelled");
        detachRequestAbort?.();
        release();
      },
    });

    return new Response(body, {
      headers: {
        "Cache-Control": "no-store, no-transform",
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    detachRequestAbort?.();
    releaseSlot?.();
    if (error instanceof AuthorizationError) {
      return jsonError("Sessão inválida ou sem acesso.", 401);
    }
    if (error instanceof ChatNotFoundError) {
      return jsonError("Conversa não encontrada.", 404);
    }
    if (error instanceof ChatConflictError) {
      return jsonError(
        "A conversa foi alterada. Atualize e tente novamente.",
        409
      );
    }
    if (
      error instanceof ChatSkillUnavailableError ||
      error instanceof ChatSkillContextTooLargeError
    ) {
      return jsonError("A seleção de Skills deixou de estar disponível.", 409);
    }
    if (error instanceof LlmInferenceTimeoutError) {
      return jsonError("A inferência excedeu o tempo limite.", 504);
    }
    if (
      error instanceof RequestBodyTooLargeError ||
      error instanceof SyntaxError
    ) {
      return jsonError("Pedido inválido.", 400);
    }
    return jsonError("Não foi possível iniciar a resposta.", 502);
  }
}

function mapWorkerError(
  code: "cancelled" | "timeout" | "unavailable" | "invalid_response"
) {
  return code === "unavailable" ? "provider_unavailable" : code;
}
