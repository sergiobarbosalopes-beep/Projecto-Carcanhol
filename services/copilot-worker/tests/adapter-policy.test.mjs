import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildChildRuntimeEnvironment,
  denyAllPermissions,
  listModelsAuthoritatively,
} from "../dist/copilot-adapter.js";
import {
  assertWorkerEnvironmentIsolated,
  parseWorkerConfig,
} from "../dist/config.js";

test("denies every future session permission request", () => {
  assert.deepEqual(
    denyAllPermissions(
      { kind: "shell", fullCommandText: "echo forbidden" },
      { sessionId: "session-1" }
    ),
    {
      kind: "reject",
      feedback: "Tool execution is disabled by service policy.",
    }
  );
});

test("does not inherit application secrets into the Copilot child process", () => {
  const environment = buildChildRuntimeEnvironment("C:\\safe-temp", {
    PATH: "safe-path",
    COPILOT_WORKER_HMAC_SECRET: "must-not-pass",
    SUPABASE_SERVICE_ROLE_KEY: "must-not-pass",
    LLM_CREDENTIAL_ENCRYPTION_KEY: "must-not-pass",
  });

  assert.equal(environment.PATH, "safe-path");
  assert.equal(environment.HOME, "C:\\safe-temp");
  assert.equal("COPILOT_WORKER_HMAC_SECRET" in environment, false);
  assert.equal("SUPABASE_SERVICE_ROLE_KEY" in environment, false);
  assert.equal("LLM_CREDENTIAL_ENCRYPTION_KEY" in environment, false);
});

test("fails closed if database or encryption secrets reach the worker", () => {
  assert.doesNotThrow(() =>
    assertWorkerEnvironmentIsolated({
      COPILOT_WORKER_HMAC_SECRET: Buffer.alloc(32).toString("base64"),
    })
  );
  assert.throws(
    () =>
      assertWorkerEnvironmentIsolated({
        SUPABASE_SERVICE_ROLE_KEY: "forbidden",
      }),
    /SUPABASE_SERVICE_ROLE_KEY/
  );
  assert.throws(
    () =>
      assertWorkerEnvironmentIsolated({
        LLM_CREDENTIAL_ENCRYPTION_KEY: "forbidden",
      }),
    /LLM_CREDENTIAL_ENCRYPTION_KEY/
  );
});

test("requires a shared replay store in production", () => {
  const baseEnvironment = {
    COPILOT_WORKER_HMAC_SECRET: Buffer.alloc(32).toString("base64"),
  };

  assert.throws(
    () => parseWorkerConfig(baseEnvironment, "production"),
    /COPILOT_REPLAY_REDIS_URL is required/
  );
  assert.equal(
    parseWorkerConfig(
      {
        ...baseEnvironment,
        COPILOT_REPLAY_REDIS_URL: "rediss://user:password@redis.example:6380",
      },
      "production"
    ).COPILOT_REPLAY_REDIS_URL,
    "rediss://user:password@redis.example:6380"
  );
  assert.throws(
    () =>
      parseWorkerConfig(
        {
          ...baseEnvironment,
          COPILOT_REPLAY_REDIS_URL: "rediss://user:password@redis.example:6380",
          COPILOT_VALIDATION_TIMEOUT_MS: "15001",
        },
        "production"
      ),
    /Invalid Copilot worker environment variables/
  );
});

test("pins the SDK and configures empty mode without logged-in fallback", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );
  const adapter = readFileSync(
    new URL("../src/copilot-adapter.ts", import.meta.url),
    "utf8"
  );

  assert.equal(packageJson.dependencies["@github/copilot-sdk"], "1.0.13");
  assert.match(adapter, /mode: "empty"/);
  assert.match(adapter, /useLoggedInUser: false/);
  assert.match(adapter, /logLevel: "none"/);
  assert.doesNotMatch(adapter, /getAuthStatus/);
  assert.doesNotMatch(adapter, /approveAll/);
});

test("uses listModels even when a stale auth status would be false", async () => {
  let authStatusCalls = 0;
  let listModelsCalls = 0;
  const client = {
    async getAuthStatus() {
      authStatusCalls += 1;
      return { isAuthenticated: false };
    },
    async listModels() {
      listModelsCalls += 1;
      return [{ id: "gpt-5", name: "GPT-5" }];
    },
  };

  const models = await listModelsAuthoritatively(
    client,
    new AbortController().signal
  );

  assert.equal(authStatusCalls, 0);
  assert.equal(listModelsCalls, 1);
  assert.equal(models[0].id, "gpt-5");
});

test("uses an atomic Redis nonce claim with expiry", () => {
  const replayStore = readFileSync(
    new URL("../src/redis-replay-store.ts", import.meta.url),
    "utf8"
  );

  assert.match(replayStore, /condition: "NX"/);
  assert.match(replayStore, /expiration: \{ type: "PX"/);
});
