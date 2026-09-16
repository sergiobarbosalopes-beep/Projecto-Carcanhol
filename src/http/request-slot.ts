import "server-only";

import { createHash } from "node:crypto";

const activeRequests = new Set<string>();

export function acquireRequestSlot(scope: string, subject: string) {
  const key = createHash("sha256").update(`${scope}:${subject}`).digest("hex");

  if (activeRequests.has(key)) {
    return null;
  }

  activeRequests.add(key);
  let released = false;

  return () => {
    if (!released) {
      activeRequests.delete(key);
      released = true;
    }
  };
}
