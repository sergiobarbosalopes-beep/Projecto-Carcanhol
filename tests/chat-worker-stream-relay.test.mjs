import assert from "node:assert/strict";
import test from "node:test";
import { relayCopilotWorkerStream } from "../src/chat/worker-stream-relay.ts";

const encoder = new TextEncoder();
const workerRequestId = "078f72e8-11c2-4665-8be1-120bfe93cf76";
const assistantMessageId = "46852cb7-62d7-4485-a1cb-662cedf464bd";

test("relays tool events, sources and done across proxy-like chunks", async () => {
  const publicEvents = [];
  const persisted = [];
  const workerEvents = [
    { v: 1, type: "start", requestId: workerRequestId },
    {
      v: 1,
      type: "tool",
      requestId: workerRequestId,
      tool: "web_fetch",
      status: "started",
      source: { url: "https://example.com/source" },
    },
    {
      v: 1,
      type: "tool",
      requestId: workerRequestId,
      tool: "web_fetch",
      status: "completed",
      source: { url: "https://example.com/source", title: "Source" },
    },
    {
      v: 1,
      type: "sources",
      requestId: workerRequestId,
      sources: [{ url: "https://example.com/source", title: "Source" }],
    },
    {
      v: 1,
      type: "done",
      requestId: workerRequestId,
      text: "Grounded answer",
      usage: { inputTokens: 7, outputTokens: 3 },
      durationMs: 20,
    },
  ];
  const payload = workerEvents.map(JSON.stringify).join("\n");

  await relayCopilotWorkerStream({
    stream: chunkedStream(encoder.encode(payload), [1, 8, 2, 21, 3]),
    workerRequestId,
    assistantMessageId,
    signal: new AbortController().signal,
    send: (event) => publicEvents.push(event),
    persistDone: async (content, usage) => persisted.push({ content, usage }),
    persistError: async () => assert.fail("unexpected failure persistence"),
    parseWorkerFrame: JSON.parse,
    maxResponseBytes: 512 * 1024,
  });

  assert.deepEqual(
    publicEvents.map((event) =>
      event.type === "tool" ? `${event.type}:${event.status}` : event.type
    ),
    ["tool:started", "tool:completed", "sources", "done"]
  );
  assert.deepEqual(persisted, [
    {
      content: "Grounded answer",
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        webSources: [{ url: "https://example.com/source", title: "Source" }],
      },
    },
  ]);
});

test("converts abrupt worker EOF into one public error even if persistence fails", async () => {
  const publicEvents = [];
  const workerEvents = [
    { v: 1, type: "start", requestId: workerRequestId },
    {
      v: 1,
      type: "delta",
      requestId: workerRequestId,
      sequence: 1,
      text: "partial",
    },
  ];

  await relayCopilotWorkerStream({
    stream: chunkedStream(
      encoder.encode(workerEvents.map(JSON.stringify).join("\n")),
      [5]
    ),
    workerRequestId,
    assistantMessageId,
    signal: new AbortController().signal,
    send: (event) => publicEvents.push(event),
    persistDone: async () => assert.fail("unexpected success persistence"),
    persistError: async () => {
      throw new Error("database unavailable");
    },
    parseWorkerFrame: JSON.parse,
    maxResponseBytes: 512 * 1024,
  });

  assert.deepEqual(
    publicEvents.map((event) => event.type),
    ["delta", "error"]
  );
  assert.equal(publicEvents.at(-1).code, "stream_interrupted");
});

test("maps a worker error to exactly one public terminal event", async () => {
  const publicEvents = [];
  const persisted = [];
  const workerEvents = [
    { v: 1, type: "start", requestId: workerRequestId },
    {
      v: 1,
      type: "error",
      requestId: workerRequestId,
      code: "unavailable",
    },
  ];

  await relayCopilotWorkerStream({
    stream: chunkedStream(
      encoder.encode(workerEvents.map(JSON.stringify).join("\n")),
      [37]
    ),
    workerRequestId,
    assistantMessageId,
    signal: new AbortController().signal,
    send: (event) => publicEvents.push(event),
    persistDone: async () => assert.fail("unexpected success persistence"),
    persistError: async (input) => persisted.push(input),
    parseWorkerFrame: JSON.parse,
    maxResponseBytes: 512 * 1024,
  });

  assert.deepEqual(
    publicEvents.map((event) => event.type),
    ["error"]
  );
  assert.equal(publicEvents[0].code, "provider_unavailable");
  assert.deepEqual(persisted, [
    {
      status: "failed",
      content: "",
      errorCode: "provider_unavailable",
    },
  ]);
});

function chunkedStream(bytes, sizes) {
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
