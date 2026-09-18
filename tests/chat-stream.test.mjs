import assert from "node:assert/strict";
import test from "node:test";
import { consumeChatStream } from "../src/chat/stream.ts";

const encoder = new TextEncoder();
const assistantMessageId = "93050d47-24d8-4b0f-a9d0-eaf66d394f4b";
const conversationId = "f4db3ed1-75dd-4c05-a29d-6ecf9322f33d";
const userMessageId = "5a9dc838-dc4d-4b2c-af98-e341588557c0";

test("consumes Vercel-like chunks and a terminal frame without trailing newline", async () => {
  const payload = [
    frame({
      v: 1,
      type: "start",
      conversationId,
      userMessageId,
      assistantMessageId,
      conversationVersion: 1,
    }),
    frame({
      v: 1,
      type: "tool",
      assistantMessageId,
      tool: "web_fetch",
      status: "started",
      source: { url: "https://example.com/source" },
    }),
    frame({
      v: 1,
      type: "tool",
      assistantMessageId,
      tool: "web_fetch",
      status: "completed",
      source: { url: "https://example.com/source", title: "Fonte pública" },
    }),
    frame({
      v: 1,
      type: "sources",
      assistantMessageId,
      sources: [{ url: "https://example.com/source", title: "Fonte pública" }],
    }),
    JSON.stringify({
      v: 1,
      type: "done",
      assistantMessageId,
      content: "Informação verificada em português.",
    }),
  ].join("\n");
  const bytes = encoder.encode(payload);
  const events = [];

  await consumeChatStream(
    streamFromChunks(bytes, [1, 2, 5, 3, 11, 7, 13]),
    handlers(events)
  );

  assert.deepEqual(events, [
    "start",
    "tool:started",
    "tool:completed",
    "sources",
    "done",
  ]);
});

test("accepts error as the single terminal event", async () => {
  const events = [];
  const payload = [
    frame({
      v: 1,
      type: "start",
      conversationId,
      userMessageId,
      assistantMessageId,
      conversationVersion: 1,
    }),
    JSON.stringify({
      v: 1,
      type: "error",
      assistantMessageId,
      code: "provider_unavailable",
      message: "Não foi possível concluir a resposta.",
    }),
  ].join("\n");

  await consumeChatStream(streamFromChunks(encoder.encode(payload), [17]), {
    ...handlers(events),
  });

  assert.deepEqual(events, ["start", "error"]);
});

test("rejects abrupt EOF without a terminal event", async () => {
  const payload = [
    frame({
      v: 1,
      type: "start",
      conversationId,
      userMessageId,
      assistantMessageId,
      conversationVersion: 1,
    }),
    JSON.stringify({
      v: 1,
      type: "delta",
      assistantMessageId,
      sequence: 1,
      text: "parcial",
    }),
  ].join("\n");

  await assert.rejects(
    consumeChatStream(
      streamFromChunks(encoder.encode(payload), [4]),
      handlers([])
    ),
    /terminou inesperadamente/
  );
});

test("rejects missing start, duplicate terminals and events after terminal", async () => {
  const error = {
    v: 1,
    type: "error",
    assistantMessageId,
    code: "stream_interrupted",
    message: "A ligação à resposta foi interrompida.",
  };

  await assert.rejects(
    consumeChatStream(
      streamFromChunks(encoder.encode(JSON.stringify(error)), [9]),
      handlers([])
    ),
    /não foi iniciada/
  );

  const payload = [
    frame({
      v: 1,
      type: "start",
      conversationId,
      userMessageId,
      assistantMessageId,
      conversationVersion: 1,
    }),
    frame(error),
    JSON.stringify(error),
  ].join("\n");

  await assert.rejects(
    consumeChatStream(
      streamFromChunks(encoder.encode(payload), [23]),
      handlers([])
    ),
    /depois da resposta terminal/
  );
});

function frame(event) {
  return JSON.stringify(event);
}

function streamFromChunks(bytes, sizes) {
  return new ReadableStream({
    start(controller) {
      let offset = 0;
      let index = 0;
      while (offset < bytes.length) {
        const size = sizes[index % sizes.length];
        controller.enqueue(bytes.slice(offset, offset + size));
        offset += size;
        index += 1;
      }
      controller.close();
    },
  });
}

function handlers(events) {
  return {
    onStart() {
      events.push("start");
    },
    onDelta() {
      events.push("delta");
    },
    onTool(event) {
      events.push(`tool:${event.status}`);
    },
    onSources() {
      events.push("sources");
    },
    onDone() {
      events.push("done");
    },
    onError() {
      events.push("error");
    },
  };
}
