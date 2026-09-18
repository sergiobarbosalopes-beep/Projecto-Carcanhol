import {
  publicChatStreamEventSchema,
  type PublicChatStreamEvent,
} from "./contract.ts";
import { NdjsonFrameDecoder } from "./ndjson.ts";

type ChatStreamHandlers = {
  onStart: (event: Extract<PublicChatStreamEvent, { type: "start" }>) => void;
  onDelta: (event: Extract<PublicChatStreamEvent, { type: "delta" }>) => void;
  onTool: (event: Extract<PublicChatStreamEvent, { type: "tool" }>) => void;
  onSources: (
    event: Extract<PublicChatStreamEvent, { type: "sources" }>
  ) => void;
  onDone: (event: Extract<PublicChatStreamEvent, { type: "done" }>) => void;
  onError: (event: Extract<PublicChatStreamEvent, { type: "error" }>) => void;
};

export async function consumeChatStream(
  stream: ReadableStream<Uint8Array>,
  handlers: ChatStreamHandlers
) {
  const reader = stream.getReader();
  const decoder = new NdjsonFrameDecoder();
  let started = false;
  let terminal = false;

  const consumeFrame = (frame: string) => {
    const event = publicChatStreamEventSchema.parse(JSON.parse(frame));

    if (terminal) {
      throw new Error("Evento recebido depois da resposta terminal.");
    }
    if (event.type === "start") {
      if (started) throw new Error("Resposta inicial duplicada.");
      started = true;
      handlers.onStart(event);
      return;
    }
    if (!started) throw new Error("A resposta não foi iniciada.");

    if (event.type === "delta") handlers.onDelta(event);
    if (event.type === "tool") handlers.onTool(event);
    if (event.type === "sources") handlers.onSources(event);
    if (event.type === "done") {
      terminal = true;
      handlers.onDone(event);
    }
    if (event.type === "error") {
      terminal = true;
      handlers.onError(event);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const frame of decoder.push(value)) {
      consumeFrame(frame);
    }
  }

  for (const frame of decoder.finish()) {
    consumeFrame(frame);
  }

  if (!started) throw new Error("A resposta não foi iniciada.");
  if (!terminal) throw new Error("A resposta terminou inesperadamente.");
}
