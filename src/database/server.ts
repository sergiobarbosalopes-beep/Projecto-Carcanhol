/**
 * Server-side Supabase client for use in Server Components, Route Handlers
 * and Server Actions. Reads/writes the auth cookie via Next.js `cookies()`
 * so that the user's session is available on the server.
 *
 * Uses the anon key (respects RLS) — this is the client to use for any
 * request performed "as the logged-in user". For privileged/service-role
 * access (bypassing RLS), use `createServiceRoleClient` instead, and only
 * from trusted server-side code that never forwards the key to the client.
 *
 * Scoped to the "carcanhol" Postgres schema.
 */
import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/types/supabase";
import { authCookieOptions } from "@/src/database/cookie-options";
import { getAuthEnv, getPublicEnv, getServerEnv } from "@/src/utils/env";

export type CarcanholClient = ReturnType<
  typeof createSupabaseClient<Database, "carcanhol">
>;

export async function createClient() {
  const cookieStore = await cookies();
  const { NEXT_PUBLIC_SUPABASE_URL } = getPublicEnv();
  const { NEXT_SUPABASE_ANON_KEY } = getAuthEnv();

  return createServerClient<Database, "carcanhol">(
    NEXT_PUBLIC_SUPABASE_URL,
    NEXT_SUPABASE_ANON_KEY,
    {
      db: {
        schema: "carcanhol",
      },
      cookieOptions: authCookieOptions,
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component: the middleware refreshes the
            // session instead, so this can be safely ignored.
          }
        },
      },
    }
  );
}

/**
 * Privileged client using the SUPABASE_SERVICE_ROLE_KEY. This bypasses RLS
 * entirely, so only use it for trusted server-side operations (e.g. admin
 * tasks, background jobs). NEVER import this module from client components
 * and NEVER expose the service role key to the browser.
 */
export function createServiceRoleClient() {
  const { NEXT_PUBLIC_SUPABASE_URL } = getPublicEnv();
  const { SUPABASE_SERVICE_ROLE_KEY, SUPABASE_SCHEMA } = getServerEnv();

  return createSupabaseClient<Database, "carcanhol">(
    NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    {
      db: {
        schema: SUPABASE_SCHEMA as "carcanhol",
      },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}
