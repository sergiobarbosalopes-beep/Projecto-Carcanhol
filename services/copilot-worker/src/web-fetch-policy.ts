import { lookup as defaultLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { PermissionHandler } from "@github/copilot-sdk";

const DNS_TIMEOUT_MS = 1_500;
const MAX_REDIRECTS = 5;
const MAX_SOURCE_URL_LENGTH = 2_048;
const MAX_SOURCE_TITLE_LENGTH = 200;
const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google",
  "instance-data",
]);
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".lan",
];

export type SafeWebSource = {
  url: string;
  title?: string;
};

type DnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true }
) => Promise<readonly { address: string; family: number }[]>;

export function createWebFetchPermissionHandler({
  lookup = defaultLookup,
  dnsTimeoutMs = DNS_TIMEOUT_MS,
}: {
  lookup?: DnsLookup;
  dnsTimeoutMs?: number;
} = {}): PermissionHandler {
  let redirectCount = 0;

  return async (request) => {
    if (
      request.kind !== "url" ||
      request.managedApprovalRequired ||
      request.requestSandboxBypass
    ) {
      return rejectPermission();
    }

    try {
      if (request.redirectedFrom && ++redirectCount > MAX_REDIRECTS) {
        return rejectPermission();
      }

      await validatePublicHttpsUrl(request.url, lookup, dnsTimeoutMs);

      if (request.redirectedFrom) {
        await validatePublicHttpsUrl(
          request.redirectedFrom,
          lookup,
          dnsTimeoutMs
        );
      }

      return { kind: "approved" };
    } catch {
      return rejectPermission();
    }
  };
}

export function sanitizeWebSource(value: unknown): SafeWebSource | undefined {
  if (!isRecord(value) || typeof value.url !== "string") {
    return undefined;
  }

  const url = sanitizePublicHttpsUrl(value.url);
  if (!url) {
    return undefined;
  }

  const title =
    typeof value.title === "string"
      ? value.title.replace(/[\u0000-\u001f\u007f]/g, " ").trim()
      : "";

  return {
    url,
    ...(title ? { title: title.slice(0, MAX_SOURCE_TITLE_LENGTH) } : {}),
  };
}

export function sanitizePublicHttpsUrl(value: string): string | undefined {
  if (value.length > MAX_SOURCE_URL_LENGTH) {
    return undefined;
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (!hasSafeUrlShape(url)) {
    return undefined;
  }

  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function validatePublicHttpsUrl(
  value: string,
  lookup: DnsLookup,
  dnsTimeoutMs: number
) {
  if (value.length > MAX_SOURCE_URL_LENGTH) {
    throw new Error("URL exceeds policy limit.");
  }

  const url = new URL(value);
  if (!hasSafeUrlShape(url)) {
    throw new Error("URL is not allowed.");
  }

  const records = await withDnsDeadline(
    lookup(url.hostname, { all: true, verbatim: true }),
    dnsTimeoutMs
  );

  if (
    records.length === 0 ||
    records.some((record) => !isPublicAddress(record.address))
  ) {
    throw new Error("URL did not resolve exclusively to public addresses.");
  }
}

function hasSafeUrlShape(url: URL) {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");

  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    (!url.port || url.port === "443") &&
    hostname.length > 0 &&
    !isIP(hostname) &&
    !BLOCKED_HOSTS.has(hostname) &&
    !BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  );
}

function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    if (octets.length !== 4) {
      return false;
    }
    const a = octets[0] ?? -1;
    const b = octets[1] ?? -1;
    const c = octets[2] ?? -1;

    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }

  if (family === 6) {
    const normalized = address.toLowerCase().split("%")[0] ?? "";

    if (normalized === "::" || normalized === "::1") {
      return false;
    }

    if (normalized.startsWith("::ffff:")) {
      return isPublicAddress(normalized.slice("::ffff:".length));
    }

    const first = Number.parseInt(normalized.split(":")[0] ?? "0", 16);
    const second = Number.parseInt(normalized.split(":")[1] ?? "0", 16);
    return !(
      (first & 0xfe00) === 0xfc00 ||
      (first & 0xffc0) === 0xfe80 ||
      (first & 0xff00) === 0xff00 ||
      (first & 0xffc0) === 0x0000 ||
      (first === 0x2001 && second === 0x0db8)
    );
  }

  return false;
}

async function withDnsDeadline<T>(promise: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("DNS resolution timed out.")),
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

function rejectPermission() {
  return {
    kind: "reject" as const,
    feedback: "URL access is blocked by service policy.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
