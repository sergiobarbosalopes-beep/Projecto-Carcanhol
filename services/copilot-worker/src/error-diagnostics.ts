import type { SafeUnknownCopilotErrorDiagnostic } from "./contract";
import {
  MAX_DIAGNOSTIC_ITEMS,
  MAX_INPUT_MESSAGE_LENGTH,
  isSafeDiagnosticIdentifier,
  redactCopilotDiagnosticMessage,
} from "./diagnostic-safety";

const MAX_CAUSE_DEPTH = 4;

export { redactCopilotDiagnosticMessage } from "./diagnostic-safety";

export type CopilotErrorEvidence = {
  constructorName: string;
  name: string;
  classificationCodes: Set<string>;
  stringCodes: Set<string>;
  numericCodes: Set<number>;
  statuses: Set<number>;
  rpcErrors: Array<{
    numericCode: number | null;
    message: string | null;
  }>;
  primaryMessage: string | null;
};

export function collectCopilotErrorEvidence(
  error: unknown
): CopilotErrorEvidence {
  const evidence: CopilotErrorEvidence = {
    constructorName: safeConstructorName(error),
    name: safeDiagnosticIdentifier(readErrorString(error, "name")),
    classificationCodes: new Set(),
    stringCodes: new Set(),
    numericCodes: new Set(),
    statuses: new Set(),
    rpcErrors: [],
    primaryMessage:
      readErrorString(error, "message") ?? primitiveMessage(error),
  };
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth += 1) {
    const record = asRecord(current);

    if (!record) {
      break;
    }

    collectRecordEvidence(record, evidence, true);
    const data = asRecord(readProperty(record, "data"));

    if (data) {
      collectRecordEvidence(data, evidence, true);
    }

    current = readProperty(record, "cause");
  }

  return evidence;
}

export function createSafeUnknownCopilotErrorDiagnostic(
  requestId: string,
  error: unknown,
  evidence = collectCopilotErrorEvidence(error)
): SafeUnknownCopilotErrorDiagnostic {
  return {
    event: "copilot_validation_unknown_error",
    requestId: safeRequestId(requestId),
    error: {
      constructor: evidence.constructorName,
      name: evidence.name,
      stringCodes: boundedSorted(evidence.stringCodes),
      numericCodes: boundedSorted(evidence.numericCodes),
      statuses: boundedSorted(evidence.statuses),
      message: redactCopilotDiagnosticMessage(evidence.primaryMessage),
    },
  };
}

function collectRecordEvidence(
  record: Record<string, unknown>,
  evidence: CopilotErrorEvidence,
  includeRpcPair: boolean
) {
  const stringCode = safeDiagnosticCode(readProperty(record, "code"));
  const classificationCode = safeClassificationCode(
    readProperty(record, "code")
  );
  const numericCode = safeInteger(readProperty(record, "code"));
  const status =
    safeStatus(readProperty(record, "status")) ??
    safeStatus(readProperty(record, "statusCode"));
  const message = safeShortString(readProperty(record, "message"));

  if (stringCode) {
    evidence.stringCodes.add(stringCode);
  }

  if (classificationCode) {
    evidence.classificationCodes.add(classificationCode);
  }

  if (numericCode !== null) {
    evidence.numericCodes.add(numericCode);
  }

  if (status !== null) {
    evidence.statuses.add(status);
  }

  if (!evidence.primaryMessage && message) {
    evidence.primaryMessage = message;
  }

  if (
    includeRpcPair &&
    (numericCode !== null || message) &&
    evidence.rpcErrors.length < MAX_CAUSE_DEPTH
  ) {
    evidence.rpcErrors.push({
      numericCode,
      message: message?.toLowerCase() ?? null,
    });
  }
}

function safeConstructorName(error: unknown): string {
  const record = asRecord(error);
  const constructor = record ? readProperty(record, "constructor") : null;

  if (typeof constructor === "function") {
    try {
      return safeDiagnosticIdentifier(constructor.name);
    } catch {
      return "unknown";
    }
  }

  const constructorRecord = asRecord(constructor);
  return safeDiagnosticIdentifier(
    constructorRecord ? readProperty(constructorRecord, "name") : null
  );
}

function readErrorString(error: unknown, property: string): string | null {
  const record = asRecord(error);
  return record ? safeShortString(readProperty(record, property)) : null;
}

function primitiveMessage(error: unknown): string | null {
  return typeof error === "string" ? error : null;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function safeShortString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_INPUT_MESSAGE_LENGTH
    ? normalized
    : null;
}

function safeDiagnosticIdentifier(value: unknown): string {
  return isSafeDiagnosticIdentifier(value) ? value : "unknown";
}

function safeRequestId(value: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  )
    ? value
    : "unknown";
}

function safeDiagnosticCode(value: unknown): string | null {
  const identifier = safeDiagnosticIdentifier(value);
  return identifier === "unknown" ? null : identifier.toUpperCase();
}

function safeClassificationCode(value: unknown): string | null {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 64 &&
    /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(value)
    ? value.toUpperCase()
    : null;
}

function safeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) ? Number(value) : null;
}

function safeStatus(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599
    ? Number(value)
    : null;
}

function boundedSorted<T extends string | number>(values: Set<T>): T[] {
  return [...values]
    .sort((left, right) => String(left).localeCompare(String(right)))
    .slice(0, MAX_DIAGNOSTIC_ITEMS);
}
