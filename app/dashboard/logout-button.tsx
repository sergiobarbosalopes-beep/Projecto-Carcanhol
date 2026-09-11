"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/src/database/client";

export default function LogoutButton() {
  const router = useRouter();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  async function handleLogout() {
    setIsLoggingOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={isLoggingOut}
      className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors duration-150 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
    >
      {isLoggingOut ? "A terminar..." : "Terminar sessão"}
    </button>
  );
}
