import {
  mergeChatWebSources,
  type ChatWebSource,
  type PublicChatStreamEvent,
} from "./contract.ts";
import { NdjsonFrameDecoder } from "./ndjson.ts";
import type { Json } from "../types/supabase.ts";

type WorkerStreamEvent =
  | { type: "start"; requestId: string }
  | { type: "heartbeat"; requestId: string }
  | {
      type: "tool";
      requestId: string;
      tool: "web_fetch";
      status: "started" | "completed";
      source?: ChatWebSource;
    }
  | {
      type: "sources";
      requestId: string;
      sources: ChatWebSource[];
    }
  | {
      type: "delta";
      requestId: string;
      sequence: number;
      text: string;
    }
  | {
      type: "done";
      requestId: string;
      text: string;
      usage?: { inputTokens: number; outputTokens: number };
    }
  | {
      type: "error";
      requestId: string;
      code: "cancelled" | "timeout" | "unavailable" | "invalid_response";
    };

type PersistErrorInput = {
  status: "cancelled" | "failed";
  content: string;
  errorCode:
    | "cancelled"
    | "timeout"
    | "provider_unavailable"
    | "invalid_response"
    | "stream_interrupted";
};

export async function relayCopilotWorkerStream({
  stream,
  workerRequestId,
  assistantMessageId,
  signal,
  send,
  persistDone,
  persistError,
  parseWorkerFrame,
  maxResponseBytes,
}: {
  stream: ReadableStream<Uint8Array>;
  workerRequestId: string;
  assistantMessageId: string;
  signal: AbortSignal;
  send: (event: PublicChatStreamEvent) => void;
  persistDone: (content: string, usage: Json) => Promise<void>;
  persistError: (input: PersistErrorInput) => Promise<void>;
  parseWorkerFrame: (frame: string) => WorkerStreamEvent;
  maxResponseBytes: number;
}) {
  const reader = stream.getReader();
  const decoder = new NdjsonFrameDecoder();
  let totalBytes = 0;
  let expectedSequence = 1;
  let content = "";
  let terminalPersisted = false;
  let terminalSent = false;
  let webSources: ChatWebSource[] = [];

  const sendTerminal = (
    event:
      | Extract<PublicChatStreamEvent, { type: "done" }>
      | Extract<PublicChatStreamEvent, { type: "error" }>
  ) => {
    if (terminalSent) throw new Error("Duplicate terminal event.");
    send(event);
    terminalSent = true;
  };

  const consumeWorkerFrame = async (frame: string) => {
    const event = parseWorkerFrame(frame);
    if (event.requestId !== workerRequestId) {
      throw new Error("Mismatched worker request.");
    }

    if (event.type === "heartbeat") {
      send({ v: 1, type: "heartbeat" });
    } else if (event.type === "tool") {
      send({
        v: 1,
        type: "tool",
        assistantMessageId,
        tool: event.tool,
        status: event.status,
        ...(event.source ? { source: event.source } : {}),
      });
    } else if (event.type === "sources") {
      webSources = mergeChatWebSources(webSources, event.sources);
      send({
        v: 1,
        type: "sources",
        assistantMessageId,
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
        assistantMessageId,
        sequence: event.sequence,
        text: event.text,
      });
    } else if (event.type === "done") {
      if (terminalSent) throw new Error("Duplicate terminal event.");
      content = event.text;
      const usage = {
        ...(event.usage ?? {}),
        ...(webSources.length > 0 ? { webSources } : {}),
      } as Json;
      await persistDone(content, usage);
      terminalPersisted = true;
      sendTerminal({
        v: 1,
        type: "done",
        assistantMessageId,
        content,
        ...(event.usage ? { usage: event.usage } : {}),
      });
    } else if (event.type === "error") {
      if (terminalSent) throw new Error("Duplicate terminal event.");
      const cancelled = event.code === "cancelled";
      terminalPersisted = await persistError({
        status: cancelled ? "cancelled" : "failed",
        content,
        errorCode: mapWorkerError(event.code),
      })
        .then(() => true)
        .catch(() => false);
      sendTerminal({
        v: 1,
        type: "error",
        assistantMessageId,
        code: mapWorkerError(event.code),
        message: cancelled
          ? "Resposta cancelada."
          : "Não foi possível concluir a resposta.",
      });
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxResponseBytes) {
        await reader.cancel();
        throw new Error("Worker stream exceeded limit.");
      }
      for (const frame of decoder.push(value)) {
        await consumeWorkerFrame(frame);
      }
    }
    for (const frame of decoder.finish()) {
      await consumeWorkerFrame(frame);
    }

    if (!terminalSent) {
      throw new Error("Worker stream ended without terminal event.");
    }
  } catch {
    if (terminalSent) return;
    const cancelled = signal.aborted;
    if (!terminalPersisted) {
      terminalPersisted = await persistError({
        status: cancelled ? "cancelled" : "failed",
        content,
        errorCode: cancelled ? "cancelled" : "stream_interrupted",
      })
        .then(() => true)
        .catch(() => false);
    }
    sendTerminal({
      v: 1,
      type: "error",
      assistantMessageId,
      code: cancelled ? "cancelled" : "stream_interrupted",
      message: cancelled
        ? "Resposta cancelada."
        : "A ligação à resposta foi interrompida.",
    });
  }
}

function mapWorkerError(
  code: "cancelled" | "timeout" | "unavailable" | "invalid_response"
) {
  return code === "unavailable" ? "provider_unavailable" : code;
}
