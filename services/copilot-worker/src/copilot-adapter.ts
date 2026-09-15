import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CopilotClient,
  type PermissionHandler,
  type SessionConfig,
} from "@github/copilot-sdk";
import type { CopilotRuntimeClient, CopilotRuntimeFactory } from "./runtime";

export const denyAllPermissions: PermissionHandler = () => ({
  kind: "reject",
  feedback: "Tool execution is disabled by service policy.",
});

export const createCopilotSdkRuntime: CopilotRuntimeFactory = async (
  token,
  requestId,
  signal
) => {
  signal.throwIfAborted();
  const baseDirectory = await mkdtemp(
    join(tmpdir(), "carcanhol-copilot-validation-")
  );

  try {
    await chmod(baseDirectory, 0o700);
  } catch (error) {
    await removeTemporaryState(baseDirectory);
    throw error;
  }

  if (signal.aborted) {
    await removeTemporaryState(baseDirectory);
    signal.throwIfAborted();
  }

  const client = new CopilotClient({
    mode: "empty",
    baseDirectory,
    workingDirectory: baseDirectory,
    useLoggedInUser: false,
    logLevel: "none",
    env: buildChildRuntimeEnvironment(baseDirectory),
    builtinPluginDirectories: [],
    enableRemoteSessions: false,
  });
  const abortRuntime = () => void forceStop(client);
  signal.addEventListener("abort", abortRuntime, { once: true });

  try {
    await client.start();
    signal.throwIfAborted();
  } catch (error) {
    signal.removeEventListener("abort", abortRuntime);
    await forceStop(client);
    await removeTemporaryState(baseDirectory);
    throw error;
  }

  return new CopilotSdkRuntime(
    client,
    baseDirectory,
    signal,
    abortRuntime,
    token,
    requestId
  );
};

class CopilotSdkRuntime implements CopilotRuntimeClient {
  constructor(
    private readonly client: CopilotClient,
    private readonly baseDirectory: string,
    private readonly signal: AbortSignal,
    private readonly abortRuntime: () => void,
    private token: string,
    private readonly sessionId: string
  ) {}

  async listModels(signal: AbortSignal) {
    try {
      return await listModelsWithSession(
        this.client,
        this.token,
        this.sessionId,
        signal
      );
    } finally {
      this.token = "";
    }
  }

  async close() {
    this.signal.removeEventListener("abort", this.abortRuntime);

    try {
      const cleanupErrors = await withDeadline(this.client.stop(), 1_500);

      if (cleanupErrors.length > 0) {
        await forceStop(this.client);
      }
    } catch {
      await forceStop(this.client);
    } finally {
      this.token = "";
      await removeTemporaryState(this.baseDirectory);
    }
  }
}

export function createValidationSessionConfig(
  token: string,
  sessionId: string
): SessionConfig {
  return {
    sessionId,
    gitHubToken: token,
    availableTools: [],
    excludedTools: ["builtin:*", "mcp:*", "custom:*"],
    tools: [],
    canvases: [],
    commands: [],
    mcpServers: {},
    customAgents: [],
    skillDirectories: [],
    pluginDirectories: [],
    instructionDirectories: [],
    includedBuiltinSkills: [],
    enableConfigDiscovery: false,
    enableExperimentalMode: false,
    enableSessionTelemetry: false,
    enableFileChangeTracking: false,
    enableMcpApps: false,
    enableManagedSettings: false,
    enableOnDemandInstructionDiscovery: false,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableSessionStore: false,
    enableSkills: false,
    skipCustomInstructions: true,
    skipEmbeddingRetrieval: true,
    embeddingCacheStorage: "in-memory",
    mcpOAuthTokenStorage: "in-memory",
    infiniteSessions: { enabled: false },
    memory: { enabled: false },
    largeOutput: { enabled: false },
    customAgentsLocalOnly: true,
    coauthorEnabled: false,
    manageScheduleEnabled: false,
    requestCanvasRenderer: false,
    requestExtensions: false,
    streaming: false,
    includeSubAgentStreamingEvents: false,
    remoteSession: "off",
    onPermissionRequest: denyAllPermissions,
  };
}

export async function listModelsWithSession(
  client: Pick<CopilotClient, "createSession" | "deleteSession">,
  token: string,
  sessionId: string,
  signal: AbortSignal
) {
  let session: Awaited<ReturnType<CopilotClient["createSession"]>> | null =
    null;

  try {
    signal.throwIfAborted();
    session = await client.createSession(
      createValidationSessionConfig(token, sessionId)
    );
    signal.throwIfAborted();
    const result = await session.rpc.model.list({});
    signal.throwIfAborted();
    return result.list;
  } finally {
    const activeSession = session;

    if (activeSession) {
      await ignoreCleanupFailure(() =>
        withDeadline(activeSession.disconnect(), 1_000)
      );
    }

    await ignoreCleanupFailure(() =>
      withDeadline(client.deleteSession(sessionId), 1_000)
    );
  }
}

export function buildChildRuntimeEnvironment(
  baseDirectory: string,
  sourceEnvironment: NodeJS.ProcessEnv = process.env
) {
  const allowedKeys = [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "PATH",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "SystemRoot",
  ] as const;
  const environment: Record<string, string | undefined> = {
    HOME: baseDirectory,
    TMPDIR: baseDirectory,
    TEMP: baseDirectory,
    TMP: baseDirectory,
  };

  for (const key of allowedKeys) {
    environment[key] = sourceEnvironment[key];
  }

  return environment;
}

async function forceStop(client: CopilotClient) {
  try {
    await withDeadline(client.forceStop(), 1_000);
  } catch {
    // The process is already being torn down. Never return raw SDK errors.
  }
}

async function removeTemporaryState(baseDirectory: string) {
  try {
    await rm(baseDirectory, { recursive: true, force: true });
  } catch {
    // The directory contains no application data and is on ephemeral storage.
  }
}

async function ignoreCleanupFailure(cleanup: () => Promise<unknown>) {
  try {
    await cleanup();
  } catch {
    // The enclosing runtime cleanup removes the complete temporary state.
  }
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Copilot runtime shutdown timed out.")),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
