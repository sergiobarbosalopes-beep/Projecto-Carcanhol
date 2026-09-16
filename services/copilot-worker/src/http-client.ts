import {
  COPILOT_WORKER_TRANSPORT_DIAGNOSTICS,
  COPILOT_INFERENCE_PATH,
  COPILOT_VALIDATION_PATH,
  COPILOT_WORKER_MAX_RESPONSE_BYTES,
  copilotInferenceResponseSchema,
  copilotValidationResponseSchema,
  type CopilotInferenceResponse,
  type CopilotValidationResponse,
  type CopilotWorkerTransportFailure,
  type SafeNetworkCauseCode,
} from "./contract";
import { findSafeNetworkCauseCode } from "./network-error";
import { createSignedWorkerHeaders } from "./request-auth";

type WorkerHttpClientOptions = {
  baseUrl: string;
  hmacSecret: Uint8Array;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

export type CopilotWorkerClientResult =
  CopilotValidationResponse | CopilotWorkerTransportFailure;

export type CopilotInferenceWorkerClientResult =
  CopilotInferenceResponse | CopilotWorkerTransportFailure;

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
  ): Promise<CopilotWorkerClientResult> {
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
        return createTimeoutFailure(requestId);
      }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return createUnavailableFailure(requestId, "authRejected");
        }

        if (response.status === 429) {
          return createUnavailableFailure(requestId, "rateLimited");
        }

        if (response.status >= 500 && response.status <= 599) {
          return createUnavailableFailure(requestId, "httpUnavailable");
        }

        return createUnavailableFailure(requestId, "httpError");
      }

      try {
        const responseBody = await readBoundedResponse(response);
        const parsed = copilotValidationResponseSchema.safeParse(
          JSON.parse(responseBody)
        );

        if (!parsed.success || parsed.data.requestId !== requestId) {
          return createInvalidResponseFailure(requestId);
        }

        return parsed.data;
      } catch (error) {
        return isTimeoutError(error)
          ? createTimeoutFailure(requestId)
          : createInvalidResponseFailure(requestId);
      }
    } catch (error) {
      return isTimeoutError(error)
        ? createTimeoutFailure(requestId)
        : createUnavailableFailure(
            requestId,
            "networkError",
            findSafeNetworkCauseCode(error)
          );
    } finally {
      body = "";
    }
  };
}

export function createCopilotInferenceWorkerHttpClient({
  baseUrl,
  hmacSecret,
  timeoutMs,
  fetchImpl = fetch,
}: WorkerHttpClientOptions) {
  const endpoint = new URL(COPILOT_INFERENCE_PATH, `${baseUrl}/`);

  return async function infer(
    token: string,
    model: string,
    prompt: string,
    requestId: string,
    systemPrompt?: string,
    signal?: AbortSignal
  ): Promise<CopilotInferenceWorkerClientResult> {
    let body = JSON.stringify({
      requestId,
      token,
      model,
      prompt,
      ...(systemPrompt ? { systemPrompt } : {}),
    });
    const headers = createSignedWorkerHeaders({
      body,
      method: "POST",
      path: COPILOT_INFERENCE_PATH,
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
        signal: signal
          ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
          : AbortSignal.timeout(timeoutMs),
        headers: {
          ...headers,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      });

      if (response.status === 504) {
        return createTimeoutFailure(requestId);
      }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return createUnavailableFailure(requestId, "authRejected");
        }

        if (response.status === 429) {
          return createUnavailableFailure(requestId, "rateLimited");
        }

        if (response.status >= 500 && response.status <= 599) {
          return createUnavailableFailure(requestId, "httpUnavailable");
        }

        return createUnavailableFailure(requestId, "httpError");
      }

      try {
        const responseBody = await readBoundedResponse(response);
        const parsed = copilotInferenceResponseSchema.safeParse(
          JSON.parse(responseBody)
        );

        if (!parsed.success || parsed.data.requestId !== requestId) {
          return createInvalidResponseFailure(requestId);
        }

        return parsed.data;
      } catch (error) {
        return isTimeoutError(error)
          ? createTimeoutFailure(requestId)
          : createInvalidResponseFailure(requestId);
      }
    } catch (error) {
      return isTimeoutError(error)
        ? createTimeoutFailure(requestId)
        : createUnavailableFailure(
            requestId,
            "networkError",
            findSafeNetworkCauseCode(error)
          );
    } finally {
      body = "";
    }
  };
}

type WorkerUnavailableDiagnosticKind =
  | "authRejected"
  | "rateLimited"
  | "httpUnavailable"
  | "httpError"
  | "networkError";

function createUnavailableFailure(
  requestId: string,
  kind: WorkerUnavailableDiagnosticKind,
  causeCode?: SafeNetworkCauseCode
): CopilotWorkerTransportFailure {
  const definition = COPILOT_WORKER_TRANSPORT_DIAGNOSTICS[kind];

  if (kind === "networkError") {
    return {
      ok: false,
      requestId,
      code: "unavailable",
      diagnostic: {
        event: "copilot_worker_transport_error",
        requestId,
        ...definition,
        ...(causeCode ? { causeCode } : {}),
      },
    };
  }

  return {
    ok: false,
    requestId,
    code: "unavailable",
    diagnostic: {
      event: "copilot_worker_transport_error",
      requestId,
      ...definition,
    },
  };
}

function createInvalidResponseFailure(
  requestId: string
): CopilotWorkerTransportFailure {
  return {
    ok: false,
    requestId,
    code: "unknown",
    diagnostic: {
      event: "copilot_worker_transport_error",
      requestId,
      ...COPILOT_WORKER_TRANSPORT_DIAGNOSTICS.invalidResponse,
    },
  };
}

function createTimeoutFailure(
  requestId: string
): CopilotWorkerTransportFailure {
  return {
    ok: false,
    requestId,
    code: "timeout",
    diagnostic: {
      event: "copilot_worker_transport_error",
      requestId,
      ...COPILOT_WORKER_TRANSPORT_DIAGNOSTICS.timeout,
    },
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
