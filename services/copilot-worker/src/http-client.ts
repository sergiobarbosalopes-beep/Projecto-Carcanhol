import {
  COPILOT_VALIDATION_PATH,
  COPILOT_WORKER_MAX_RESPONSE_BYTES,
  copilotValidationResponseSchema,
  type CopilotValidationResponse,
} from "./contract";
import { createSignedWorkerHeaders } from "./request-auth";

type WorkerHttpClientOptions = {
  baseUrl: string;
  hmacSecret: Uint8Array;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

export function createCopilotWorkerHttpClient({
  baseUrl,
  hmacSecret,
  timeoutMs,
  fetchImpl = fetch,
}: WorkerHttpClientOptions) {
  const endpoint = new URL(COPILOT_VALIDATION_PATH, `${baseUrl}/`);

  return async function validate(
    token: string,
    requestId: string
  ): Promise<CopilotValidationResponse> {
    let body = JSON.stringify({ requestId, token });
    const headers = createSignedWorkerHeaders({
      body,
      method: "POST",
      path: COPILOT_VALIDATION_PATH,
      requestId,
      secret: hmacSecret,
    });

    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        body,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          ...headers,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      });

      if (response.status === 504) {
        return { ok: false, requestId, code: "timeout" };
      }

      if (!response.ok) {
        return { ok: false, requestId, code: "unavailable" };
      }

      const responseBody = await readBoundedResponse(response);
      const parsed = copilotValidationResponseSchema.safeParse(
        JSON.parse(responseBody)
      );

      if (!parsed.success || parsed.data.requestId !== requestId) {
        return { ok: false, requestId, code: "unknown" };
      }

      return parsed.data;
    } catch (error) {
      return {
        ok: false,
        requestId,
        code: isTimeoutError(error) ? "timeout" : "unavailable",
      };
    } finally {
      body = "";
    }
  };
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));

  if (
    Number.isFinite(declaredLength) &&
    declaredLength > COPILOT_WORKER_MAX_RESPONSE_BYTES
  ) {
    throw new Error("Worker response exceeded the size limit.");
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > COPILOT_WORKER_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Worker response exceeded the size limit.");
    }

    chunks.push(value);
  }

  const result = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(result);
}

function isTimeoutError(error: unknown) {
  return (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}
