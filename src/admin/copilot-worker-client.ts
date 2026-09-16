import "server-only";

import { createCopilotWorkerHttpClient } from "@/services/copilot-worker/src/http-client";
import { getCopilotWorkerEnv } from "@/src/utils/env";

export function validateWithCopilotWorker(
  credential: string,
  requestId: string
) {
  const {
    COPILOT_WORKER_URL,
    COPILOT_WORKER_HMAC_SECRET,
    COPILOT_WORKER_TIMEOUT_MS,
  } = getCopilotWorkerEnv();
  const validate = createCopilotWorkerHttpClient({
    baseUrl: COPILOT_WORKER_URL,
    hmacSecret: COPILOT_WORKER_HMAC_SECRET,
    timeoutMs: COPILOT_WORKER_TIMEOUT_MS,
  });

  return validate(credential, requestId);
}
