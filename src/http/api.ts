import "server-only";

import { NextResponse } from "next/server";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
};

export function jsonSuccess<T>(data: T, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: NO_STORE_HEADERS,
  });
}

export function jsonError(
  message: string,
  status: number,
  details: Record<string, unknown> = {}
) {
  return NextResponse.json(
    { ...details, error: message },
    {
      status,
      headers: NO_STORE_HEADERS,
    }
  );
}

export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");

  if (!origin) {
    return false;
  }

  let originUrl: URL;

  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }

  const requestUrl = new URL(request.url);

  if (originUrl.origin === requestUrl.origin) {
    return true;
  }

  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");

  if (!forwardedHost) {
    return false;
  }

  const expectedProtocol =
    forwardedProto?.split(",")[0]?.trim() || requestUrl.protocol.slice(0, -1);
  const expectedHost = forwardedHost.split(",")[0]?.trim();

  return originUrl.origin === `${expectedProtocol}://${expectedHost}`;
}

export function rejectCrossOrigin(request: Request) {
  return isSameOrigin(request) ? null : jsonError("Pedido inválido.", 403);
}
