import { NextResponse } from "next/server";
import { createClient } from "@/src/database/server";

/**
 * Server-side logout endpoint. Provided as a backend alternative to the
 * client-side `supabase.auth.signOut()` call used by the dashboard's
 * logout button (e.g. for non-JS form submissions or future server actions).
 */
export async function POST() {
  const supabase = await createClient();
  await supabase.auth.signOut();

  return NextResponse.json({ success: true });
}
