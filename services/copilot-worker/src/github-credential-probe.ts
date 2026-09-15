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

export type GitHubCredentialProbeResult = {
  outcome: GitHubCredentialProbeOutcome;
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
      return { outcome: "unavailable" };
    }

    return { outcome: "unknown" };
  } catch {
    return {
      outcome: signal.aborted ? "timeout" : "unavailable",
    };
  }
}
