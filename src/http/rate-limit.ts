import "server-only";

import { createHash } from "node:crypto";

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const MAX_ENTRIES = 5_000;
const entries = new Map<string, RateLimitEntry>();

export function consumeRateLimit({
  scope,
  subject,
  limit,
  windowMs,
  now = Date.now(),
}: {
  scope: string;
  subject: string;
  limit: number;
  windowMs: number;
  now?: number;
}) {
  prune(now);
  const key = `${scope}:${hashSubject(subject)}`;
  const existing = entries.get(key);

  if (!existing || existing.resetAt <= now) {
    if (entries.size >= MAX_ENTRIES) {
      entries.delete(entries.keys().next().value as string);
    }

    entries.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (existing.count >= limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((existing.resetAt - now) / 1_000)
      ),
    };
  }

  existing.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

export function requestClientAddress(request: Request) {
  return (
    request.headers.get("x-vercel-forwarded-for") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export function consumeUserAndIpRateLimit({
  request,
  scope,
  userId,
  userLimit,
  ipLimit,
  windowMs,
}: {
  request: Request;
  scope: string;
  userId: string;
  userLimit: number;
  ipLimit: number;
  windowMs: number;
}) {
  const user = consumeRateLimit({
    scope: `${scope}:user`,
    subject: userId,
    limit: userLimit,
    windowMs,
  });
  const ip = consumeRateLimit({
    scope: `${scope}:ip`,
    subject: requestClientAddress(request),
    limit: ipLimit,
    windowMs,
  });

  return {
    allowed: user.allowed && ip.allowed,
    retryAfterSeconds: Math.max(user.retryAfterSeconds, ip.retryAfterSeconds),
  };
}

function hashSubject(subject: string) {
  return createHash("sha256").update(subject).digest("hex");
}

function prune(now: number) {
  for (const [key, entry] of entries) {
    if (entry.resetAt <= now) {
      entries.delete(key);
    }
  }
}
