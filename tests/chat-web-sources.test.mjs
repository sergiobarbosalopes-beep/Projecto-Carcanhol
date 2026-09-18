import assert from "node:assert/strict";
import test from "node:test";
import { mergeChatWebSources } from "../src/chat/contract.ts";

test("bounds and deduplicates web sources across stream events", () => {
  const first = Array.from({ length: 12 }, (_, index) => ({
    url: `https://example.com/source-${index}`,
    title: `Source ${index}`,
  }));
  const second = Array.from({ length: 12 }, (_, index) => ({
    url: `https://example.com/source-${index + 8}`,
    title: `Updated ${index + 8}`,
  }));

  const merged = mergeChatWebSources(mergeChatWebSources([], first), second);

  assert.equal(merged.length, 16);
  assert.equal(new Set(merged.map((source) => source.url)).size, 16);
  assert.equal(
    merged.find((source) => source.url.endsWith("source-8"))?.title,
    "Updated 8"
  );
  assert.equal(
    merged.some((source) => source.url.endsWith("source-16")),
    false
  );
});
