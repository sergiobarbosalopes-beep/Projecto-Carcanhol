export const safeNetworkCauseCodes = [
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ETIMEDOUT",
  "CERT_HAS_EXPIRED",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
] as const;

export type SafeNetworkCauseCode = (typeof safeNetworkCauseCodes)[number];

export function findSafeNetworkCauseCode(
  error: unknown
): SafeNetworkCauseCode | undefined {
  let current = error;

  for (let depth = 0; depth < 4 && current; depth += 1) {
    const record = asRecord(current);

    if (!record) {
      return undefined;
    }

    const code = readProperty(record, "code");

    if (typeof code === "string" && code.length <= 64) {
      const normalizedCode = code.toUpperCase();
      const allowedCode = safeNetworkCauseCodes.find(
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
