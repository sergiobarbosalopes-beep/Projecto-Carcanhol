"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LogoutButton({ compact = false }: { compact?: boolean }) {
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
        setErrorMessage("Não foi possível terminar a sessão.");
        return;
      }

      router.replace("/login");
      router.refresh();
    } catch {
      setErrorMessage("Não foi possível terminar a sessão.");
    } finally {
      setIsLoggingOut(false);
    }
  }

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={handleLogout}
        disabled={isLoggingOut}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-semibold text-slate-700 transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
        aria-label={compact ? "Terminar sessão" : undefined}
        title={compact ? "Terminar sessão" : undefined}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-5 w-5 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <path d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4M14 8l4 4-4 4M8 12h10" />
        </svg>
        {!compact && (
          <span>{isLoggingOut ? "A terminar..." : "Terminar sessão"}</span>
        )}
      </button>
      {errorMessage && !compact && (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
