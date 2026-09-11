"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LogoutButton() {
  const router = useRouter();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleLogout() {
    setErrorMessage(null);
    setIsLoggingOut(true);

    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        cache: "no-store",
      });

      if (!response.ok) {
        setErrorMessage("Não foi possível terminar a sessão. Tente novamente.");
        return;
      }

      router.replace("/login");
      router.refresh();
    } catch {
      setErrorMessage("Não foi possível terminar a sessão. Tente novamente.");
    } finally {
      setIsLoggingOut(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        onClick={handleLogout}
        disabled={isLoggingOut}
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors duration-150 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
      >
        {isLoggingOut ? "A terminar..." : "Terminar sessão"}
      </button>
      {errorMessage && (
        <p role="alert" className="max-w-xs text-right text-sm text-red-700">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
