import "server-only";

import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/src/database/server";
import { hasCarcanholMembership } from "@/src/auth/membership";

/**
 * Returns the authenticated user only when their UUID is explicitly present
 * in carcanhol.profiles. Uses anon + session credentials, so RLS remains the
 * final database boundary.
 */
export async function getAuthorizedUser(): Promise<User | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const hasMembership = await hasCarcanholMembership(supabase, user.id);
  return hasMembership ? user : null;
}

/**
 * Guard for protected Server Components and future Route Handlers.
 * Route Handlers that need a JSON 401/403 response can call
 * getAuthorizedUser() directly and build the response explicitly.
 */
export async function requireAuthorizedUser(): Promise<User> {
  const user = await getAuthorizedUser();

  if (!user) {
    redirect("/login?error=access_denied");
  }

  return user;
}
