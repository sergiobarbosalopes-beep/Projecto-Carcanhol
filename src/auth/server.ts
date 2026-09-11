import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/src/database/server";
import type { CarcanholClient } from "@/src/database/server";
import { hasCarcanholMembership } from "@/src/auth/membership";

/**
 * Returns the authenticated user only when their UUID is explicitly present
 * in carcanhol.profiles. Uses anon + session credentials, so RLS remains the
 * final database boundary.
 */
export async function getAuthorizedUser(
  supabase?: CarcanholClient
): Promise<User | null> {
  if (!supabase) {
    return getAuthorizedUserForRequest();
  }

  return resolveAuthorizedUser(supabase);
}

const getAuthorizedUserForRequest = cache(async () => {
  const supabase = await createClient();
  return resolveAuthorizedUser(supabase);
});

async function resolveAuthorizedUser(
  client: CarcanholClient
): Promise<User | null> {
  const {
    data: { user },
  } = await client.auth.getUser();

  if (!user) {
    return null;
  }

  const hasMembership = await hasCarcanholMembership(client, user.id);
  return hasMembership ? user : null;
}

/**
 * Guard for protected Server Components and Route Handlers. Handlers pass
 * `onUnauthorized: "throw"` so they can return JSON rather than redirect.
 */
export async function requireAuthorizedUser(
  options: {
    supabase?: CarcanholClient;
    onUnauthorized?: "redirect" | "throw";
  } = {}
): Promise<User> {
  const user = await getAuthorizedUser(options.supabase);

  if (!user) {
    if (options.onUnauthorized === "throw") {
      throw new AuthorizationError();
    }

    redirect("/login?error=access_denied");
  }

  return user;
}

export class AuthorizationError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "AuthorizationError";
  }
}
