import {
  githubCredentialProbeNetworkCauseCodes,
  type GitHubCredentialProbeNetworkCauseCode,
} from "./contract";

const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_ACCEPT = "application/vnd.github+json";
const GITHUB_USER_AGENT = "Projecto-Carcanhol-Copilot-Worker";

export type GitHubCredentialProbeOutcome =
  | "valid"
  | "invalid_token"
  | "forbidden"
  | "timeout"
  | "unavailable"
  | "unknown";

export type GitHubCredentialProbeResult =
  | {
      outcome: Exclude<GitHubCredentialProbeOutcome, "unavailable">;
    }
  | {
      outcome: "unavailable";
      category: "network_error" | "rate_limited" | "github_unavailable";
      causeCode?: GitHubCredentialProbeNetworkCauseCode;
    };

export type GitHubCredentialProbe = (
  token: string,
  signal: AbortSignal
) => Promise<GitHubCredentialProbeResult>;

export async function probeGitHubCredential(
  token: string,
  signal: AbortSignal,
  fetchImplementation: typeof fetch = fetch
): Promise<GitHubCredentialProbeResult> {
  if (signal.aborted) {
    return { outcome: "timeout" };
  }

  try {
    const response = await fetchImplementation(GITHUB_USER_URL, {
      method: "GET",
      headers: {
        Accept: GITHUB_ACCEPT,
        Authorization: `Bearer ${token}`,
        "User-Agent": GITHUB_USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal,
    });
    const status = response.status;

    if (status === 200) {
      return { outcome: "valid" };
    }

    if (status === 401) {
      return { outcome: "invalid_token" };
    }

    if (status === 403) {
      return { outcome: "forbidden" };
    }

    if (status === 408 || status === 504) {
      return { outcome: "timeout" };
    }

    if (status === 429 || (status >= 500 && status <= 599)) {
      return {
        outcome: "unavailable",
        category: status === 429 ? "rate_limited" : "github_unavailable",
      };
    }

    return { outcome: "unknown" };
  } catch (error) {
    if (signal.aborted) {
      return { outcome: "timeout" };
    }

    const causeCode = findAllowedNetworkCauseCode(error);

    return {
      outcome: "unavailable",
      category: "network_error",
      ...(causeCode ? { causeCode } : {}),
    };
  }
}

function findAllowedNetworkCauseCode(
  error: unknown
): GitHubCredentialProbeNetworkCauseCode | undefined {
  let current = error;

  for (let depth = 0; depth < 4 && current; depth += 1) {
    const record = asRecord(current);

    if (!record) {
      return undefined;
    }

    const code = readProperty(record, "code");

    if (typeof code === "string") {
      const normalizedCode = code.toUpperCase();
      const allowedCode = githubCredentialProbeNetworkCauseCodes.find(
        (candidate) => candidate === normalizedCode
      );

      if (allowedCode) {
        return allowedCode;
      }
    }

    current = readProperty(record, "cause");
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readProperty(
  record: Record<string, unknown>,
  property: string
): unknown {
  try {
    return Reflect.get(record, property);
  } catch {
    return undefined;
  }
}
