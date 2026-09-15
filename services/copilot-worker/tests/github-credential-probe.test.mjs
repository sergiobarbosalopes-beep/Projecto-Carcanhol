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
    [200, "valid"],
    [401, "invalid_token"],
    [403, "forbidden"],
    [408, "timeout"],
    [429, "unavailable"],
    [500, "unavailable"],
    [504, "timeout"],
    [422, "unknown"],
  ];

  for (const [status, outcome] of cases) {
    const result = await probeGitHubCredential(
      token,
      new AbortController().signal,
      async () => ({ status })
    );

    assert.deepEqual(result, { outcome });
    assert.equal(JSON.stringify(result).includes(token), false);
  }
});

test("maps probe failures without reflecting thrown details", async () => {
  const activeSignal = new AbortController().signal;
  const networkResult = await probeGitHubCredential(
    token,
    activeSignal,
    async () => {
      throw new Error(`network failed for ${token}`);
    }
  );
  assert.deepEqual(networkResult, { outcome: "unavailable" });
  assert.equal(JSON.stringify(networkResult).includes(token), false);

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
