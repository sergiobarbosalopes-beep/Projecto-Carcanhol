import {
  createHash,
  createHmac,
  timingSafeEqual,
  type BinaryLike,
} from "node:crypto";
import { COPILOT_WORKER_HEADERS } from "./contract";

const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 64;
const SIGNATURE_PREFIX = "v1=";

export type SignedWorkerHeaders = Record<string, string>;

export type ReplayStore = {
  consume(
    requestId: string,
    timestampMs: number,
    nowMs: number,
    signal?: AbortSignal
  ): Promise<boolean>;
  readiness(signal?: AbortSignal): Promise<boolean>;
  close?(): Promise<void>;
};

export type WorkerRequestAuthInput = {
  method: string;
  path: string;
  body: string;
  requestId: string;
  timestamp: string;
  bodySha256: string;
  signature: string;
};

export type VerifyWorkerRequestOptions = {
  secret: Uint8Array;
  replayStore: ReplayStore;
  signal?: AbortSignal;
  now?: number;
  maxClockSkewMs?: number;
};

export type WorkerRequestAuthResult =
  | { ok: true; requestId: string }
  | {
      ok: false;
      reason:
        | "malformed"
        | "expired"
        | "body_mismatch"
        | "signature_mismatch"
        | "replayed";
    };

export function parseWorkerHmacSecret(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("COPILOT_WORKER_HMAC_SECRET must be canonical base64.");
  }

  const secret = Buffer.from(value, "base64");

  if (
    secret.byteLength < MIN_SECRET_BYTES ||
    secret.byteLength > MAX_SECRET_BYTES ||
    secret.toString("base64") !== value
  ) {
    throw new Error(
      "COPILOT_WORKER_HMAC_SECRET must encode between 32 and 64 bytes."
    );
  }

  return secret;
}

export function sha256Hex(value: BinaryLike): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createWorkerSignature(
  input: Omit<WorkerRequestAuthInput, "signature">,
  secret: Uint8Array
): string {
  return `${SIGNATURE_PREFIX}${createHmac("sha256", secret)
    .update(canonicalRequest(input))
    .digest("hex")}`;
}

export function createSignedWorkerHeaders({
  body,
  method,
  path,
  requestId,
  secret,
  timestampMs = Date.now(),
}: {
  body: string;
  method: string;
  path: string;
  requestId: string;
  secret: Uint8Array;
  timestampMs?: number;
}): SignedWorkerHeaders {
  const timestamp = String(timestampMs);
  const bodySha256 = sha256Hex(body);
  const signature = createWorkerSignature(
    { body, method, path, requestId, timestamp, bodySha256 },
    secret
  );

  return {
    [COPILOT_WORKER_HEADERS.bodySha256]: bodySha256,
    [COPILOT_WORKER_HEADERS.requestId]: requestId,
    [COPILOT_WORKER_HEADERS.signature]: signature,
    [COPILOT_WORKER_HEADERS.timestamp]: timestamp,
  };
}

export async function verifyWorkerRequest(
  input: WorkerRequestAuthInput,
  options: VerifyWorkerRequestOptions
): Promise<WorkerRequestAuthResult> {
  const now = options.now ?? Date.now();
  const maxClockSkewMs = options.maxClockSkewMs ?? 30_000;

  if (
    !/^[0-9]{13}$/.test(input.timestamp) ||
    !/^[0-9a-f]{64}$/.test(input.bodySha256) ||
    !/^v1=[0-9a-f]{64}$/.test(input.signature) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.requestId
    )
  ) {
    return { ok: false, reason: "malformed" };
  }

  const timestampMs = Number(input.timestamp);

  if (
    !Number.isSafeInteger(timestampMs) ||
    Math.abs(now - timestampMs) > maxClockSkewMs
  ) {
    return { ok: false, reason: "expired" };
  }

  const calculatedBodyHash = sha256Hex(input.body);

  if (!constantTimeEqual(calculatedBodyHash, input.bodySha256)) {
    return { ok: false, reason: "body_mismatch" };
  }

  const expectedSignature = createWorkerSignature(
    {
      body: input.body,
      method: input.method,
      path: input.path,
      requestId: input.requestId,
      timestamp: input.timestamp,
      bodySha256: input.bodySha256,
    },
    options.secret
  );

  if (!constantTimeEqual(expectedSignature, input.signature)) {
    return { ok: false, reason: "signature_mismatch" };
  }

  options.signal?.throwIfAborted();

  const consumed = await options.replayStore.consume(
    input.requestId,
    timestampMs,
    now,
    options.signal
  );
  options.signal?.throwIfAborted();

  if (!consumed) {
    return { ok: false, reason: "replayed" };
  }

  return { ok: true, requestId: input.requestId };
}

export class InMemoryReplayStore implements ReplayStore {
  private readonly requests = new Map<string, number>();

  constructor(
    private readonly signatureValidityMs = 30_000,
    private readonly maxEntries = 10_000
  ) {}

  async consume(requestId: string, timestampMs: number, nowMs: number) {
    this.prune(nowMs);

    if (this.requests.has(requestId)) {
      return false;
    }

    if (this.requests.size >= this.maxEntries) {
      const oldest = this.requests.keys().next().value as string | undefined;

      if (oldest) {
        this.requests.delete(oldest);
      }
    }

    this.requests.set(requestId, timestampMs + this.signatureValidityMs);
    return true;
  }

  async close() {
    this.requests.clear();
  }

  async readiness(signal?: AbortSignal) {
    signal?.throwIfAborted();
    return true;
  }

  private prune(nowMs: number) {
    for (const [requestId, expiresAt] of this.requests) {
      if (expiresAt < nowMs) {
        this.requests.delete(requestId);
      }
    }
  }
}

function canonicalRequest(
  input: Omit<WorkerRequestAuthInput, "signature">
): string {
  return [
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.requestId,
    input.bodySha256,
  ].join("\n");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");

  if (leftBuffer.byteLength !== rightBuffer.byteLength) {
    timingSafeEqual(leftBuffer, leftBuffer);
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
