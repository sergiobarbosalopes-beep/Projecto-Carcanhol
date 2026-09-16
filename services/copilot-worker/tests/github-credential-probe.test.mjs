import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { probeGitHubCredential } from "../dist/github-credential-probe.js";

const token = `github_pat_${"P".repeat(40)}`;
const probeSource = await readFile(
  new URL("../src/github-credential-probe.ts", import.meta.url),
  "utf8"
);

test("does not contain response-body, response-header, or logging access", () => {
  assert.doesNotMatch(
    probeSource,
    /response\.(?:arrayBuffer|blob|body|formData|headers|json|text)\b/
  );
  assert.doesNotMatch(probeSource, /\bconsole\./);
});

test("probes only the fixed GitHub user endpoint without reading the response", async () => {
  const controller = new AbortController();
  const calls = [];
  const responseProperties = [];
  const response = new Proxy(
    {},
    {
      get(_target, property) {
        responseProperties.push(property);

        if (property === "then") {
          return undefined;
        }

        if (property === "status") {
          return 200;
        }

        throw new Error(`unexpected response access: ${String(property)}`);
      },
    }
  );

  const result = await probeGitHubCredential(
    token,
    controller.signal,
    async (url, init) => {
      calls.push({ url, init });
      return response;
    }
  );

  assert.deepEqual(result, { outcome: "valid" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/user");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.signal, controller.signal);
  assert.deepEqual(calls[0].init.headers, {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "Projecto-Carcanhol-Copilot-Worker",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  assert.equal("body" in calls[0].init, false);
  assert.deepEqual(
    [...new Set(responseProperties.filter((property) => property !== "then"))],
    ["status"]
  );
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("maps only the GitHub status without exposing response data", async () => {
  const cases = [
    [200, { outcome: "valid" }],
    [401, { outcome: "invalid_token" }],
    [403, { outcome: "forbidden" }],
    [408, { outcome: "timeout" }],
    [429, { outcome: "unavailable", category: "rate_limited" }],
    [500, { outcome: "unavailable", category: "github_unavailable" }],
    [504, { outcome: "timeout" }],
    [422, { outcome: "unknown" }],
  ];

  for (const [status, expected] of cases) {
    const result = await probeGitHubCredential(
      token,
      new AbortController().signal,
      async () => ({ status })
    );

    assert.deepEqual(result, expected);
    assert.equal(JSON.stringify(result).includes(token), false);
  }
});

test("allowlists network cause codes without reflecting thrown details", async () => {
  const activeSignal = new AbortController().signal;
  const allowedCodes = [
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNRESET",
    "ETIMEDOUT",
    "CERT_HAS_EXPIRED",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ];

  for (const causeCode of allowedCodes) {
    const networkResult = await probeGitHubCredential(
      token,
      activeSignal,
      async () => {
        throw {
          message: `network failed for ${token}`,
          cause: {
            code: causeCode.toLowerCase(),
            body: token,
          },
        };
      }
    );
    assert.deepEqual(networkResult, {
      outcome: "unavailable",
      category: "network_error",
      causeCode,
    });
    assert.equal(JSON.stringify(networkResult).includes(token), false);
  }

  const unclassifiedResult = await probeGitHubCredential(
    token,
    activeSignal,
    async () => {
      throw { code: token, message: token };
    }
  );
  assert.deepEqual(unclassifiedResult, {
    outcome: "unavailable",
    category: "network_error",
  });
  assert.equal(JSON.stringify(unclassifiedResult).includes(token), false);

  let inspectedProperties = 0;
  const hostileResult = await probeGitHubCredential(
    token,
    activeSignal,
    async () => {
      throw new Proxy(
        {},
        {
          get() {
            inspectedProperties += 1;
            throw new Error(token);
          },
        }
      );
    }
  );
  assert.deepEqual(hostileResult, {
    outcome: "unavailable",
    category: "network_error",
  });
  assert.equal(inspectedProperties <= 2, true);
  assert.equal(JSON.stringify(hostileResult).includes(token), false);

  const aborted = new AbortController();
  aborted.abort();
  let fetchCalls = 0;
  const timeoutResult = await probeGitHubCredential(
    token,
    aborted.signal,
    async () => {
      fetchCalls += 1;
      throw new Error(`aborted for ${token}`);
    }
  );
  assert.deepEqual(timeoutResult, { outcome: "timeout" });
  assert.equal(fetchCalls, 0);
  assert.equal(JSON.stringify(timeoutResult).includes(token), false);
});
