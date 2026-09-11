import { redirect } from "next/navigation";
import { createClient } from "@/src/database/server";
import LogoutButton from "./logout-button";

/**
 * Protected placeholder dashboard. Access control is enforced twice:
 * 1. `middleware.ts` redirects unauthenticated requests before this page runs.
 * 2. This server component re-checks the session as defense in depth.
 *
 * No business features yet (Fase 1 scope) — just a welcome placeholder.
 */
export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="flex min-h-screen w-full flex-col bg-zinc-50 dark:bg-black">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-950 sm:px-6 lg:px-8">
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Carcanhol
        </h1>
        <LogoutButton />
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-4 py-16 text-center sm:px-6 lg:px-8">
        <h2 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50 sm:text-3xl">
          Bem-vindo à Plataforma Carcanhol
        </h2>
        <p className="mt-3 max-w-md text-sm text-zinc-600 dark:text-zinc-400 sm:text-base">
          Sessão iniciada como <span className="font-medium">{user.email}</span>
          . As funcionalidades de análise de investimentos serão
          disponibilizadas nas próximas fases do projeto.
        </p>
      </main>
    </div>
  );
}
