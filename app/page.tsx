import { redirect } from "next/navigation";
import { getAuthorizedUser } from "@/src/auth/server";

/**
 * Root route: send authenticated users to the dashboard and everyone else
 * to the login page. No public marketing/landing content in Phase 1.
 */
export default async function HomePage() {
  const user = await getAuthorizedUser();
  redirect(user ? "/dashboard" : "/login");
}
