import { redirect } from "next/navigation";
import { createClient } from "@/src/database/server";

/**
 * Root route: send authenticated users to the dashboard and everyone else
 * to the login page. No public marketing/landing content in Phase 1.
 */
export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  redirect(user ? "/dashboard" : "/login");
}
