/**
 * Browser (client-side) Supabase client.
 *
 * Uses only the public URL + anon key (safe to expose to the browser).
 * Row Level Security (RLS) policies in Postgres are what actually protect
 * data — the anon key alone grants no special access.
 *
 * Scoped to the "carcanhol" Postgres schema (see database/migrations) so
 * that this app never touches `public` or another app's tables in the
 * shared Supabase project.
 */
"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/src/types/supabase";
import { getPublicEnv } from "@/src/utils/env";

export function createClient() {
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } =
    getPublicEnv();

  return createBrowserClient<Database, "carcanhol">(
    NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      db: {
        schema: "carcanhol",
      },
    }
  );
}
