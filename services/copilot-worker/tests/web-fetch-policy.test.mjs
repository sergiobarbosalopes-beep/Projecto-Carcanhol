import assert from "node:assert/strict";
import test from "node:test";
import {
  createWebFetchPermissionHandler,
  sanitizePublicHttpsUrl,
  sanitizeWebSource,
} from "../dist/web-fetch-policy.js";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const approvePublic = createWebFetchPermissionHandler({
  lookup: publicLookup,
});

test("approves only public HTTPS URL permissions", async () => {
  assert.deepEqual(
    await approvePublic(
      { kind: "url", url: "https://example.com/news", intention: "read" },
      { sessionId: "session-1" }
    ),
    { kind: "approved" }
  );

  for (const request of [
    { kind: "url", url: "http://example.com", intention: "read" },
    { kind: "url", url: "https://user:pass@example.com", intention: "read" },
    { kind: "url", url: "https://example.com:8443", intention: "read" },
    { kind: "url", url: "https://127.0.0.1", intention: "read" },
    { kind: "url", url: "https://localhost", intention: "read" },
    {
      kind: "url",
      url: "https://example.com",
      intention: "read",
      requestSandboxBypass: true,
    },
    {
      kind: "url",
      url: "https://example.com",
      intention: "read",
      managedApprovalRequired: true,
    },
    { kind: "read", path: "/etc/passwd", intention: "read" },
    { kind: "shell", fullCommandText: "curl example.com" },
  ]) {
    const result = await approvePublic(request, { sessionId: "session-1" });
    assert.equal(result.kind, "reject");
  }
});

test("rejects private, link-local, metadata and mixed DNS answers", async () => {
  for (const records of [
    [{ address: "10.0.0.1", family: 4 }],
    [{ address: "169.254.169.254", family: 4 }],
    [{ address: "::1", family: 6 }],
    [{ address: "fc00::1", family: 6 }],
    [
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.1.5", family: 4 },
    ],
    [],
  ]) {
    const handler = createWebFetchPermissionHandler({
      lookup: async () => records,
    });
    const result = await handler(
      { kind: "url", url: "https://example.com", intention: "read" },
      { sessionId: "session-1" }
    );
    assert.equal(result.kind, "reject");
  }
});

test("revalidates redirect origins and fails closed on DNS timeout", async () => {
  const redirect = await approvePublic(
    {
      kind: "url",
      url: "https://example.com/final",
      redirectedFrom: "https://127.0.0.1/private",
      intention: "redirect",
    },
    { sessionId: "session-1" }
  );
  assert.equal(redirect.kind, "reject");

  const timeoutHandler = createWebFetchPermissionHandler({
    lookup: async () => new Promise(() => {}),
    dnsTimeoutMs: 5,
  });
  const timeout = await timeoutHandler(
    { kind: "url", url: "https://example.com", intention: "read" },
    { sessionId: "session-1" }
  );
  assert.equal(timeout.kind, "reject");

  const redirectLimitHandler = createWebFetchPermissionHandler({
    lookup: publicLookup,
  });
  for (let index = 0; index < 5; index += 1) {
    assert.equal(
      (
        await redirectLimitHandler(
          {
            kind: "url",
            url: `https://example.com/${index + 1}`,
            redirectedFrom: `https://example.com/${index}`,
            intention: "redirect",
          },
          { sessionId: "session-1" }
        )
      ).kind,
      "approved"
    );
  }
  assert.equal(
    (
      await redirectLimitHandler(
        {
          kind: "url",
          url: "https://example.com/6",
          redirectedFrom: "https://example.com/5",
          intention: "redirect",
        },
        { sessionId: "session-1" }
      )
    ).kind,
    "reject"
  );
});

test("sanitizes source metadata without leaking queries or untrusted fields", () => {
  assert.equal(
    sanitizePublicHttpsUrl(
      "https://example.com/news?token=secret#private-fragment"
    ),
    "https://example.com/news"
  );
  assert.deepEqual(
    sanitizeWebSource({
      url: "https://example.com/news?token=secret",
      title: "Current\u0000 news",
      content: "must not be transported",
    }),
    {
      url: "https://example.com/news",
      title: "Current  news",
    }
  );
  assert.equal(sanitizeWebSource({ url: "http://example.com" }), undefined);
});
