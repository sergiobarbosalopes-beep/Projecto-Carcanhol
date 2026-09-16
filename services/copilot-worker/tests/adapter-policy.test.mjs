import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildChildRuntimeEnvironment,
  createValidationSessionConfig,
  denyAllPermissions,
  listModelsWithSession,
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

test("inherits only portable runtime paths into the Copilot child process", () => {
  const sourceEnvironment = {
    PATH: "safe-path",
    SystemRoot: "C:\\Windows",
    HTTPS_PROXY: "https://proxy.example",
    HTTP_PROXY: "http://proxy.example",
    NO_PROXY: "localhost",
    NODE_EXTRA_CA_CERTS: "C:\\certs\\corporate.pem",
    SSL_CERT_DIR: "C:\\certs",
    SSL_CERT_FILE: "C:\\certs\\bundle.pem",
    COPILOT_WORKER_HMAC_SECRET: "must-not-pass",
    SUPABASE_SERVICE_ROLE_KEY: "must-not-pass",
    LLM_CREDENTIAL_ENCRYPTION_KEY: "must-not-pass",
    UNDEFINED_VALUE: undefined,
  };
  const linuxEnvironment = buildChildRuntimeEnvironment(
    "/safe-temp",
    sourceEnvironment,
    "linux"
  );
  const windowsEnvironment = buildChildRuntimeEnvironment(
    "C:\\safe-temp",
    sourceEnvironment,
    "win32"
  );

  assert.deepEqual(linuxEnvironment, {
    HOME: "/safe-temp",
    TMPDIR: "/safe-temp",
    TEMP: "/safe-temp",
    TMP: "/safe-temp",
    PATH: "safe-path",
  });
  assert.deepEqual(windowsEnvironment, {
    HOME: "C:\\safe-temp",
    TMPDIR: "C:\\safe-temp",
    TEMP: "C:\\safe-temp",
    TMP: "C:\\safe-temp",
    PATH: "safe-path",
    SystemRoot: "C:\\Windows",
  });

  for (const environment of [linuxEnvironment, windowsEnvironment]) {
    for (const forbidden of [
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_DIR",
      "SSL_CERT_FILE",
      "COPILOT_WORKER_HMAC_SECRET",
      "SUPABASE_SERVICE_ROLE_KEY",
      "LLM_CREDENTIAL_ENCRYPTION_KEY",
      "UNDEFINED_VALUE",
    ]) {
      assert.equal(forbidden in environment, false, forbidden);
    }

    assert.equal(
      Object.values(environment).every((value) => typeof value === "string"),
      true
    );
  }

  assert.deepEqual(buildChildRuntimeEnvironment("/safe-temp", {}, "linux"), {
    HOME: "/safe-temp",
    TMPDIR: "/safe-temp",
    TEMP: "/safe-temp",
    TMP: "/safe-temp",
  });
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
  const sdkPackageJson = JSON.parse(
    readFileSync(
      new URL(
        "../node_modules/@github/copilot-sdk/package.json",
        import.meta.url
      ),
      "utf8"
    )
  );
  const adapter = readFileSync(
    new URL("../src/copilot-adapter.ts", import.meta.url),
    "utf8"
  );

  assert.equal(packageJson.dependencies["@github/copilot-sdk"], "1.0.14");
  assert.equal(sdkPackageJson.version, "1.0.14");
  assert.equal(sdkPackageJson.copilotCliVersion, "1.0.85");
  assert.match(adapter, /mode: "empty"/);
  assert.match(adapter, /useLoggedInUser: false/);
  assert.match(adapter, /logLevel: "none"/);
  assert.doesNotMatch(adapter, /getAuthStatus/);
  assert.doesNotMatch(adapter, /client\.listModels\(\)/);
  assert.doesNotMatch(adapter, /client\.rpc\.models\.list/);
  assert.match(adapter, /client\.createSession/);
  assert.match(adapter, /session\.rpc\.model\.list/);
  assert.match(adapter, /activeSession\.disconnect/);
  assert.match(adapter, /client\.deleteSession/);
  assert.doesNotMatch(adapter, /\.send(?:AndWait)?\(/);
  assert.doesNotMatch(adapter, /approveAll/);

  const constructorStart = adapter.indexOf("new CopilotClient({");
  const constructorEnd = adapter.indexOf("});", constructorStart);
  assert.notEqual(constructorStart, -1);
  assert.notEqual(constructorEnd, -1);
  assert.doesNotMatch(
    adapter.slice(constructorStart, constructorEnd),
    /gitHubToken/
  );
});

test("installs and verifies the native runtime CA bundle", () => {
  const dockerfile = readFileSync(
    new URL("../Dockerfile.vercel", import.meta.url),
    "utf8"
  );
  const workflow = readFileSync(
    new URL("../../../.github/workflows/ci.yml", import.meta.url),
    "utf8"
  );
  const runtimeStage = dockerfile.indexOf(
    "FROM node:24.12.0-bookworm-slim AS runtime"
  );
  const caInstall = dockerfile.indexOf(
    "apt-get install -y --no-install-recommends ca-certificates",
    runtimeStage
  );
  const nodeUser = dockerfile.indexOf("USER node", runtimeStage);

  assert.notEqual(runtimeStage, -1);
  assert.equal(caInstall > runtimeStage, true);
  assert.equal(nodeUser > caInstall, true);
  assert.match(dockerfile, /rm -rf \/var\/lib\/apt\/lists\/\*/);
  assert.match(workflow, /--tag carcanhol-copilot-worker:ci/);
  assert.match(workflow, /test -s \/etc\/ssl\/certs\/ca-certificates\.crt/);
});

test("builds a request-bound empty session without a model or tools", () => {
  const token = `github_pat_${"A".repeat(40)}`;
  const sessionId = "3bebcccd-5254-40f8-809f-3a14579dba46";
  const config = createValidationSessionConfig(token, sessionId);

  assert.equal(config.sessionId, sessionId);
  assert.equal(config.gitHubToken, token);
  assert.equal("model" in config, false);
  assert.equal("systemMessage" in config, false);
  assert.equal("onEvent" in config, false);
  assert.deepEqual(config.availableTools, []);
  assert.deepEqual(config.excludedTools, ["builtin:*", "mcp:*", "custom:*"]);
  assert.deepEqual(config.tools, []);
  assert.deepEqual(config.mcpServers, {});
  assert.deepEqual(config.customAgents, []);
  assert.deepEqual(config.includedBuiltinSkills, []);
  assert.equal(config.enableSkills, false);
  assert.equal(config.enableSessionStore, false);
  assert.equal(config.enableSessionTelemetry, false);
  assert.deepEqual(config.infiniteSessions, { enabled: false });
  assert.deepEqual(config.memory, { enabled: false });
  assert.deepEqual(config.onPermissionRequest({}, { sessionId }), {
    kind: "reject",
    feedback: "Tool execution is disabled by service policy.",
  });
});

test("lists session models with token only in session.create and cleans up", async () => {
  const events = [];
  let authStatusCalls = 0;
  let clientListModelsCalls = 0;
  let promptCalls = 0;
  let capturedConfig;
  let capturedListParams;
  const client = {
    async getAuthStatus() {
      authStatusCalls += 1;
      return { isAuthenticated: false };
    },
    async listModels() {
      clientListModelsCalls += 1;
      return [{ id: "gpt-5", name: "GPT-5" }];
    },
    async createSession(config) {
      events.push("create");
      capturedConfig = config;
      return {
        rpc: {
          model: {
            async list(params) {
              events.push("list");
              capturedListParams = params;
              return { list: [{ id: "gpt-5", name: "GPT-5" }] };
            },
          },
        },
        async send() {
          promptCalls += 1;
        },
        async sendAndWait() {
          promptCalls += 1;
        },
        async disconnect() {
          events.push("disconnect");
        },
      };
    },
    async deleteSession(sessionId) {
      events.push(`delete:${sessionId}`);
    },
  };
  const token = `github_pat_${"A".repeat(40)}`;
  const sessionId = "3bebcccd-5254-40f8-809f-3a14579dba46";

  const models = await listModelsWithSession(
    client,
    token,
    sessionId,
    new AbortController().signal
  );

  assert.equal(authStatusCalls, 0);
  assert.equal(clientListModelsCalls, 0);
  assert.equal(promptCalls, 0);
  assert.equal(capturedConfig.gitHubToken, token);
  assert.equal(capturedConfig.sessionId, sessionId);
  assert.deepEqual(capturedListParams, {});
  assert.deepEqual(events, [
    "create",
    "list",
    "disconnect",
    `delete:${sessionId}`,
  ]);
  assert.equal(models[0].id, "gpt-5");
});

test("cleans the ephemeral session after model-list errors", async () => {
  const events = [];
  const client = createSessionClient(events, async () => {
    throw { code: -32603, message: "Not authenticated" };
  });

  await assert.rejects(() =>
    listModelsWithSession(
      client,
      `github_pat_${"B".repeat(40)}`,
      "d510ccb5-22af-47b5-9280-3b605aac4c68",
      new AbortController().signal
    )
  );
  assert.deepEqual(events, [
    "create",
    "list",
    "disconnect",
    "delete:d510ccb5-22af-47b5-9280-3b605aac4c68",
  ]);
});

test("cleans the ephemeral session when model listing is aborted", async () => {
  const events = [];
  const controller = new AbortController();
  const client = createSessionClient(events, async () => {
    controller.abort();
    throw new DOMException("aborted", "AbortError");
  });

  await assert.rejects(() =>
    listModelsWithSession(
      client,
      `github_pat_${"C".repeat(40)}`,
      "ef4acbcc-cb43-4435-9e3f-f16472bcbb43",
      controller.signal
    )
  );
  assert.deepEqual(events, [
    "create",
    "list",
    "disconnect",
    "delete:ef4acbcc-cb43-4435-9e3f-f16472bcbb43",
  ]);
});

test("uses an atomic Redis nonce claim with expiry", () => {
  const replayStore = readFileSync(
    new URL("../src/redis-replay-store.ts", import.meta.url),
    "utf8"
  );

  assert.match(replayStore, /condition: "NX"/);
  assert.match(replayStore, /expiration: \{ type: "PX"/);
});

function createSessionClient(events, listModels) {
  return {
    async createSession() {
      events.push("create");
      return {
        rpc: {
          model: {
            async list() {
              events.push("list");
              return listModels();
            },
          },
        },
        async disconnect() {
          events.push("disconnect");
        },
      };
    },
    async deleteSession(sessionId) {
      events.push(`delete:${sessionId}`);
    },
  };
}
