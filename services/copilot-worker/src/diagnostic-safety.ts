export const MAX_DIAGNOSTIC_ITEMS = 8;
export const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 240;
export const MAX_INPUT_MESSAGE_LENGTH = 4_096;
export const MAX_DIAGNOSTIC_IDENTIFIER_LENGTH = 64;

export function redactCopilotDiagnosticMessage(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_INPUT_MESSAGE_LENGTH) {
    return "unavailable";
  }

  const sanitized = redactSeparatedOpaqueValues(
    value
      .replace(
        /\b(?:authorization|proxy-authorization|x-auth-token|x-github-token|cookie|set-cookie)\s*[:=]\s*[^\r\n,;]*/gi,
        "[auth]"
      )
      .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9+/_=.-]{4,}/gi, "[auth]")
      .replace(
        /\b(?:access[_-]?token|api[_-]?key|secret|password)\s*[:=]\s*[^\s,;]*/gi,
        "[secret]"
      )
      .replace(
        /\b(?:github_pat_|gho_|ghu_|ghp_)[A-Za-z0-9_+=/-]{4,}/gi,
        "[token]"
      )
      .replace(/\b[A-Za-z][A-Za-z0-9+.-]{1,15}:\/\/[^\s<>"'`]+/g, "[url]")
      .replace(
        /(?:\/\/|www\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?::\d+)?(?:\/[^\s<>"'`]*)?/gi,
        "[url]"
      )
      .replace(
        /\b(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,63}(?::\d+)?(?:\/[^\s<>"'`]*)?/g,
        "[url]"
      )
      .replace(
        /\b(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/[^\s<>"'`]*)?/gi,
        "[url]"
      )
      .replace(
        /\b(?:[A-Fa-f0-9]{1,4}:){2,}[A-Fa-f0-9:]{1,39}(?:\/[^\s<>"'`]*)?/g,
        "[url]"
      )
      .replace(/\b[A-Za-z][A-Za-z0-9-]{1,63}:\d{1,5}\/[^\s<>"'`]*/g, "[url]")
      .replace(
        /\b[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g,
        "[email]"
      )
      .replace(
        /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
        "[quoted]"
      )
      .replace(/\{[^{}\r\n]{0,512}\}|\[[^\[\]\r\n]{0,512}\]/g, "[payload]")
      .replace(
        /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g,
        "[opaque]"
      )
      .replace(/[A-Za-z0-9+/_=-]{24,}/g, "[opaque]")
  )
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!sanitized) {
    return "unavailable";
  }

  return Array.from(sanitized).slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH).join("");
}

export function isSafeDiagnosticIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_DIAGNOSTIC_IDENTIFIER_LENGTH &&
    /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(value) &&
    !/^(?:github_pat_|gho_|ghu_|ghp_)/i.test(value) &&
    redactCopilotDiagnosticMessage(value) === value
  );
}

export function isSafeDiagnosticMessage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_DIAGNOSTIC_MESSAGE_LENGTH &&
    redactCopilotDiagnosticMessage(value) === value
  );
}

function redactSeparatedOpaqueValues(value: string): string {
  return value.replace(
    /[A-Za-z0-9][^\s<>"'`\[\]]{10,}[A-Za-z0-9]/g,
    (candidate) =>
      /[^A-Za-z0-9]/.test(candidate) &&
      candidate.replace(/[^A-Za-z0-9]/g, "").length >= 12
        ? "[opaque]"
        : candidate
  );
}
