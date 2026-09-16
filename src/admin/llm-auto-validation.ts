export const AUTO_VALIDATION_MAX_ACCOUNTS = 20;
export const AUTO_VALIDATION_CONCURRENCY = 2;
export const AUTO_VALIDATION_TIMEOUT_MS = 60_000;
export const LLM_ACCOUNT_REFRESH_TTL_MS = 15 * 60_000;

export function isAutomaticLlmRefreshDue(
  attemptedAt: string | null,
  now = Date.now()
) {
  if (!attemptedAt) {
    return true;
  }

  const timestamp = Date.parse(attemptedAt);
  return (
    !Number.isFinite(timestamp) || now - timestamp >= LLM_ACCOUNT_REFRESH_TTL_MS
  );
}

export function createRequestCoalescer<T>() {
  const requests = new Map<string, Promise<T>>();

  return {
    run(key: string, start: () => Promise<T>) {
      const current = requests.get(key);

      if (current) {
        return current;
      }

      const request = start().finally(() => {
        if (requests.get(key) === request) {
          requests.delete(key);
        }
      });
      requests.set(key, request);
      return request;
    },
  };
}

export async function runBoundedAccountValidation<T>({
  accountIds,
  validate,
  onStart,
  onResult,
  onError,
  concurrency = AUTO_VALIDATION_CONCURRENCY,
  timeoutMs = AUTO_VALIDATION_TIMEOUT_MS,
}: {
  accountIds: string[];
  validate: (accountId: string, signal: AbortSignal) => Promise<T>;
  onStart: (accountId: string) => void;
  onResult: (accountId: string, result: T) => void;
  onError: (accountId: string) => void;
  concurrency?: number;
  timeoutMs?: number;
}) {
  const queue = accountIds.slice(0, AUTO_VALIDATION_MAX_ACCOUNTS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let nextIndex = 0;

  async function worker() {
    while (!controller.signal.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      const accountId = queue[index];

      if (!accountId) {
        return;
      }

      onStart(accountId);

      try {
        const result = await validate(accountId, controller.signal);
        onResult(accountId, result);
      } catch {
        onError(accountId);
      }
    }
  }

  try {
    await Promise.all(
      Array.from(
        { length: Math.min(Math.max(1, concurrency), queue.length) },
        () => worker()
      )
    );
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
