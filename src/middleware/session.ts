/**
 * Session refresh + route protection helper used by the root `proxy.ts`.
 *
 * Supabase's SSR auth relies on cookies that must be refreshed on every
 * request; this also lets us redirect unauthenticated users away from
 * protected routes (e.g. /dashboard) before any page code runs.
 */
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/src/types/supabase";
import { authCookieOptions } from "@/src/database/cookie-options";
import { getAuthEnv, getPublicEnv } from "@/src/utils/env";
import { hasCarcanholMembership } from "@/src/auth/membership";

/** Route prefixes that require an authenticated user. */
const PROTECTED_PATHS = ["/dashboard"];

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );
}

function redirectToLogin(
  request: NextRequest,
  supabaseResponse: NextResponse,
  options: { redirectedFrom?: string; accessDenied?: boolean } = {}
) {
  const redirectUrl = request.nextUrl.clone();
  redirectUrl.pathname = "/login";
  redirectUrl.search = "";

  if (options.redirectedFrom) {
    redirectUrl.searchParams.set("redirectedFrom", options.redirectedFrom);
  }

  if (options.accessDenied) {
    redirectUrl.searchParams.set("error", "access_denied");
  }

  const redirectResponse = NextResponse.redirect(redirectUrl);
  supabaseResponse.cookies
    .getAll()
    .forEach((cookie) => redirectResponse.cookies.set(cookie));

  return redirectResponse;
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const { NEXT_PUBLIC_SUPABASE_URL } = getPublicEnv();
  const { NEXT_SUPABASE_ANON_KEY } = getAuthEnv();

  const supabase = createServerClient<Database, "carcanhol">(
    NEXT_PUBLIC_SUPABASE_URL,
    NEXT_SUPABASE_ANON_KEY,
    {
      db: {
        schema: "carcanhol",
      },
      cookieOptions: authCookieOptions,
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: do not run any logic between createServerClient and
  // getUser(). A simple mistake could make it very hard to debug issues
  // with users being randomly logged out.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (!isProtectedPath(pathname)) {
    return supabaseResponse;
  }

  if (!user) {
    return redirectToLogin(request, supabaseResponse, {
      redirectedFrom: pathname,
    });
  }

  const hasMembership = await hasCarcanholMembership(supabase, user.id);

  if (!hasMembership) {
    await supabase.auth.signOut({ scope: "local" });
    return redirectToLogin(request, supabaseResponse, {
      accessDenied: true,
    });
  }

  return supabaseResponse;
}
