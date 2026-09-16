import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CopilotClient,
  type PermissionHandler,
  type SessionConfig,
} from "@github/copilot-sdk";
import {
  copilotPremiumInteractionsQuotaSchema,
  type CopilotPremiumInteractionsQuota,
} from "./contract";
import type { CopilotRuntimeClient, CopilotRuntimeFactory } from "./runtime";

type AccountGetQuotaResult = Awaited<
  ReturnType<CopilotClient["rpc"]["account"]["getQuota"]>
>;
type AccountQuotaSnapshot = NonNullable<
  AccountGetQuotaResult["quotaSnapshots"][string]
>;

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
    return listModelsWithSession(
      this.client,
      this.token,
      this.sessionId,
      signal
    );
  }

  async getPremiumInteractionsQuota(signal: AbortSignal) {
    try {
      signal.throwIfAborted();
      const result = await this.client.rpc.account.getQuota({
        gitHubToken: this.token,
      });
      signal.throwIfAborted();
      return sanitizePremiumInteractionsQuota(result);
    } catch {
      return unavailableQuota("provider_quota_unavailable");
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

export function sanitizePremiumInteractionsQuota(
  result: AccountGetQuotaResult
): CopilotPremiumInteractionsQuota {
  const snapshot = result.quotaSnapshots.premium_interactions;

  if (!snapshot) {
    return unavailableQuota("provider_quota_not_available");
  }

  return normalizeQuotaSnapshot(snapshot);
}

function normalizeQuotaSnapshot(
  snapshot: AccountQuotaSnapshot
): CopilotPremiumInteractionsQuota {
  const {
    entitlementRequests,
    isUnlimitedEntitlement,
    overage,
    overageAllowedWithExhaustedQuota,
    remainingPercentage,
    resetDate,
    usageAllowedWithExhaustedQuota,
    usedRequests,
  } = snapshot;

  if (
    !isValidProviderUnits(usedRequests) ||
    usedRequests < 0 ||
    !isValidProviderUnits(overage) ||
    overage < 0 ||
    !Number.isFinite(remainingPercentage) ||
    remainingPercentage < 0 ||
    remainingPercentage > 100 ||
    (resetDate !== undefined && !Number.isFinite(Date.parse(resetDate)))
  ) {
    return unavailableQuota("malformed_provider_quota");
  }

  if (isUnlimitedEntitlement) {
    return parseNormalizedQuota({
      status: "available",
      metric: "premium_interactions",
      isUnlimited: true,
      usedUnits: usedRequests,
      overageUnits: overage,
      usageAllowedAfterLimit: usageAllowedWithExhaustedQuota,
      overageAllowed: overageAllowedWithExhaustedQuota,
      ...(isFutureIsoDate(resetDate) ? { resetAt: resetDate } : {}),
    });
  }

  if (!isValidProviderUnits(entitlementRequests) || entitlementRequests < 0) {
    return unavailableQuota("malformed_provider_quota");
  }

  return parseNormalizedQuota({
    status: "available",
    metric: "premium_interactions",
    isUnlimited: false,
    usedUnits: usedRequests,
    includedUnits: entitlementRequests,
    remainingUnits: Math.max(0, entitlementRequests - usedRequests),
    remainingPercentage,
    overageUnits: overage,
    usageAllowedAfterLimit: usageAllowedWithExhaustedQuota,
    overageAllowed: overageAllowedWithExhaustedQuota,
    ...(isFutureIsoDate(resetDate) ? { resetAt: resetDate } : {}),
  });
}

function parseNormalizedQuota(
  value: CopilotPremiumInteractionsQuota
): CopilotPremiumInteractionsQuota {
  const parsed = copilotPremiumInteractionsQuotaSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : unavailableQuota("malformed_provider_quota");
}

function unavailableQuota(
  errorCode:
    | "provider_quota_unavailable"
    | "provider_quota_not_available"
    | "malformed_provider_quota"
): CopilotPremiumInteractionsQuota {
  return {
    status: "unavailable",
    metric: "premium_interactions",
    errorCode,
  };
}

function isValidProviderUnits(value: number) {
  return Number.isFinite(value) && value <= 1_000_000_000;
}

function isFutureIsoDate(value: string | undefined) {
  if (!value) {
    return false;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now();
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
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
) {
  const environment: Record<string, string> = {
    HOME: baseDirectory,
    TMPDIR: baseDirectory,
    TEMP: baseDirectory,
    TMP: baseDirectory,
  };
  const path = sourceEnvironment.PATH;

  if (typeof path === "string") {
    environment.PATH = path;
  }

  const systemRoot = sourceEnvironment.SystemRoot;

  if (platform === "win32" && typeof systemRoot === "string") {
    environment.SystemRoot = systemRoot;
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
