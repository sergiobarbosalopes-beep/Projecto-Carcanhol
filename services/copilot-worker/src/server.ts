import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  COPILOT_HEALTH_PATH,
  COPILOT_VALIDATION_PATH,
  COPILOT_WORKER_HEADERS,
  COPILOT_WORKER_MAX_BODY_BYTES,
  copilotValidationRequestSchema,
  copilotValidationResponseSchema,
  type CopilotValidationRequest,
  type CopilotValidationResponse,
  type CopilotWorkerRequestPhase,
  type SafeCopilotWorkerInternalDiagnostic,
} from "./contract";
import {
  ConcurrencyGate,
  WorkerAbortedError,
  WorkerBusyError,
} from "./concurrency";
import {
  InMemoryReplayStore,
  verifyWorkerRequest,
  type ReplayStore,
} from "./request-auth";

export type CopilotWorkerServerOptions = {
  hmacSecret: Uint8Array;
  validate: (
    request: CopilotValidationRequest,
    signal: AbortSignal
  ) => Promise<CopilotValidationResponse>;
  maxClockSkewMs?: number;
  maxConcurrency?: number;
  maxQueue?: number;
  healthTimeoutMs?: number;
  validationDeadlineMs?: number;
  replayStore?: ReplayStore;
  onDiagnostic?: (diagnostic: SafeCopilotWorkerInternalDiagnostic) => void;
  writeResponse?: typeof sendJson;
};

export function createCopilotWorkerServer(options: CopilotWorkerServerOptions) {
  const maxClockSkewMs = options.maxClockSkewMs ?? 30_000;
  const replayStore =
    options.replayStore ?? new InMemoryReplayStore(maxClockSkewMs);
  const gate = new ConcurrencyGate(
    options.maxConcurrency ?? 2,
    options.maxQueue ?? 8
  );
  const writeResponse = options.writeResponse ?? sendJson;

  return createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'none'");
    response.setHeader("X-Content-Type-Options", "nosniff");

    try {
      await handleRequest(request, response, {
        ...options,
        maxClockSkewMs,
        replayStore,
        gate,
        writeResponse,
      });
    } catch {
      if (!response.destroyed) {
        try {
          writeResponse(response, 500, { error: "Worker request failed." });
        } catch {
          response.destroy();
        }
      }
    }
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: CopilotWorkerServerOptions & {
    replayStore: ReplayStore;
    gate: ConcurrencyGate;
    writeResponse: typeof sendJson;
  }
) {
  let phase: CopilotWorkerRequestPhase = "receiving_body";
  const url = new URL(request.url ?? "/", "http://worker.internal");

  if (request.headers.origin) {
    options.writeResponse(response, 403, {
      error: "Browser requests are not accepted.",
    });
    return;
  }

  if (
    request.method === "GET" &&
    url.pathname === COPILOT_HEALTH_PATH &&
    !url.search
  ) {
    const ready = await options.replayStore
      .readiness(AbortSignal.timeout(options.healthTimeoutMs ?? 1_500))
      .catch(() => false);
    options.writeResponse(
      response,
      ready ? 200 : 503,
      ready ? { status: "ok" } : { status: "unavailable" }
    );
    return;
  }

  if (
    request.method !== "POST" ||
    url.pathname !== COPILOT_VALIDATION_PATH ||
    url.search
  ) {
    options.writeResponse(response, 404, { error: "Not found." });
    return;
  }

  const contentType = request.headers["content-type"]?.split(";")[0]?.trim();

  if (contentType !== "application/json") {
    options.writeResponse(response, 415, {
      error: "Unsupported media type.",
    });
    return;
  }

  const declaredLength = Number(request.headers["content-length"]);

  if (
    Number.isFinite(declaredLength) &&
    declaredLength > COPILOT_WORKER_MAX_BODY_BYTES
  ) {
    options.writeResponse(response, 413, { error: "Payload too large." });
    return;
  }

  let body: string;

  try {
    body = await readBody(request, COPILOT_WORKER_MAX_BODY_BYTES);
  } catch (error) {
    options.writeResponse(
      response,
      error instanceof PayloadTooLargeError ? 413 : 400,
      {
        error: "Invalid request body.",
      }
    );
    return;
  }

  phase = "authenticating";
  const requestId = header(request, COPILOT_WORKER_HEADERS.requestId);
  const timestamp = header(request, COPILOT_WORKER_HEADERS.timestamp);
  const bodySha256 = header(request, COPILOT_WORKER_HEADERS.bodySha256);
  const signature = header(request, COPILOT_WORKER_HEADERS.signature);

  if (!requestId || !timestamp || !bodySha256 || !signature) {
    options.writeResponse(response, 401, { error: "Unauthorized." });
    return;
  }

  const controller = new AbortController();
  const abortForDisconnect = () => controller.abort();
  const abortForClosedResponse = () => {
    if (!response.writableEnded) {
      controller.abort();
    }
  };
  request.once("aborted", abortForDisconnect);
  response.once("close", abortForClosedResponse);
  const deadline = setTimeout(
    () => controller.abort(),
    options.validationDeadlineMs ?? 15_000
  );
  deadline.unref?.();
  let authenticated = false;
  let parsedRequest: CopilotValidationRequest | null = null;

  try {
    const authentication = await verifyWorkerRequest(
      {
        method: request.method,
        path: url.pathname,
        body,
        requestId,
        timestamp,
        bodySha256,
        signature,
      },
      {
        secret: options.hmacSecret,
        replayStore: options.replayStore,
        signal: controller.signal,
        ...(options.maxClockSkewMs === undefined
          ? {}
          : { maxClockSkewMs: options.maxClockSkewMs }),
      }
    );

    if (!authentication.ok) {
      options.writeResponse(response, 401, { error: "Unauthorized." });
      return;
    }

    authenticated = true;
    phase = "parsing_request";
    let input: unknown;

    try {
      input = JSON.parse(body);
    } catch {
      options.writeResponse(response, 400, {
        error: "Invalid request body.",
      });
      return;
    }

    const parsed = copilotValidationRequestSchema.safeParse(input);

    if (!parsed.success || parsed.data.requestId !== authentication.requestId) {
      options.writeResponse(response, 400, {
        error: "Invalid request body.",
      });
      return;
    }

    const validatedRequest = parsed.data;
    parsedRequest = validatedRequest;
    phase = "validating";
    const result = await options.gate.run(
      () => options.validate(validatedRequest, controller.signal),
      controller.signal
    );
    controller.signal.throwIfAborted();
    phase = "validating_response";
    const validatedResult = copilotValidationResponseSchema.parse(result);

    if (!response.destroyed) {
      phase = "writing_response";
      options.writeResponse(response, 200, validatedResult);
    }
  } catch (error) {
    if (phase === "writing_response" && authenticated && parsedRequest) {
      emitInternalDiagnostic(options, parsedRequest.requestId, phase);

      if (!response.destroyed) {
        response.destroy();
      }

      return;
    }

    if (response.destroyed) {
      return;
    }

    if (error instanceof WorkerAbortedError || controller.signal.aborted) {
      try {
        phase = "writing_response";
        options.writeResponse(
          response,
          authenticated && parsedRequest ? 200 : 504,
          authenticated && parsedRequest
            ? {
                ok: false,
                requestId: parsedRequest.requestId,
                code: "timeout",
              }
            : { error: "Worker request timed out." }
        );
      } catch {
        if (authenticated && parsedRequest) {
          emitInternalDiagnostic(
            options,
            parsedRequest.requestId,
            "writing_response"
          );
        }
        response.destroy();
      }
      return;
    }

    if (error instanceof WorkerBusyError) {
      try {
        phase = "writing_response";
        options.writeResponse(response, 503, {
          error: "Worker unavailable.",
        });
      } catch {
        if (authenticated && parsedRequest) {
          emitInternalDiagnostic(
            options,
            parsedRequest.requestId,
            "writing_response"
          );
        }
        response.destroy();
      }
      return;
    }

    if (authenticated && parsedRequest) {
      const diagnostic = createInternalDiagnostic(
        parsedRequest.requestId,
        phase
      );
      emitDiagnostic(options, diagnostic);

      try {
        phase = "writing_response";
        options.writeResponse(response, 200, {
          ok: false,
          requestId: parsedRequest.requestId,
          code: "unavailable",
          diagnostic,
        });
      } catch {
        emitInternalDiagnostic(
          options,
          parsedRequest.requestId,
          "writing_response"
        );
        response.destroy();
      }
      return;
    }

    try {
      options.writeResponse(response, 500, {
        error: "Worker unavailable.",
      });
    } catch {
      response.destroy();
    }
  } finally {
    clearTimeout(deadline);
    request.removeListener("aborted", abortForDisconnect);
    response.removeListener("close", abortForClosedResponse);
    body = "";

    if (parsedRequest) {
      parsedRequest.token = "";
    }
  }
}

function createInternalDiagnostic(
  requestId: string,
  phase: CopilotWorkerRequestPhase
): SafeCopilotWorkerInternalDiagnostic {
  return {
    event: "copilot_worker_internal_error",
    requestId,
    code: "WORKER_INTERNAL_FAILURE",
    message: "copilot worker failed internally",
    phase,
  };
}

function emitInternalDiagnostic(
  options: CopilotWorkerServerOptions,
  requestId: string,
  phase: CopilotWorkerRequestPhase
) {
  emitDiagnostic(options, createInternalDiagnostic(requestId, phase));
}

function emitDiagnostic(
  options: CopilotWorkerServerOptions,
  diagnostic: SafeCopilotWorkerInternalDiagnostic
) {
  try {
    options.onDiagnostic?.(diagnostic);
  } catch {
    // Diagnostics must not affect request handling.
  }
}

async function readBody(request: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let length = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;

    if (length > maxBytes) {
      throw new PayloadTooLargeError();
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" ? value : null;
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: Record<string, unknown>
) {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

class PayloadTooLargeError extends Error {}
