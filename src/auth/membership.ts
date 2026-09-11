import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/types/supabase";

type CarcanholClient = SupabaseClient<Database, "carcanhol">;

/**
 * Checks the app allowlist through the caller's Supabase session and RLS.
 * Errors are propagated so authorization fails closed without disguising
 * database/configuration failures as a missing membership.
 */
export async function hasCarcanholMembership(
  supabase: CarcanholClient,
  userId: string
): Promise<boolean> {
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw new Error("Não foi possível validar o acesso ao Carcanhol.", {
      cause: error,
    });
  }

  return profile !== null;
}
