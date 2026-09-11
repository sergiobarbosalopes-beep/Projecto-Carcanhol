"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { sanitizeRedirectPath } from "@/src/utils/redirect";
import { BrandLogo } from "@/src/components/brand-logo";

const GENERIC_LOGIN_ERROR =
  "Não foi possível iniciar sessão. Verifique os dados ou contacte o administrador.";

/**
 * Login page (email/password only).
 *
 * Phase 1 scope note: there is intentionally NO public sign-up flow. Users
 * are created manually by the project owner via the Supabase Dashboard
 * (Authentication → Users). This page only authenticates existing users.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectedFrom = sanitizeRedirectPath(
    searchParams.get("redirectedFrom")
  );
  const accessWasDenied = searchParams.get("error") === "access_denied";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(
    accessWasDenied ? GENERIC_LOGIN_ERROR : null
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password }),
        cache: "no-store",
      });

      if (!response.ok) {
        setErrorMessage(GENERIC_LOGIN_ERROR);
        return;
      }

      router.replace(redirectedFrom);
      router.refresh();
    } catch {
      setErrorMessage(GENERIC_LOGIN_ERROR);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-dvh w-full items-center justify-center bg-slate-50 px-4 py-12 sm:px-6 lg:px-8">
      <div className="w-full max-w-sm space-y-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="text-center">
          <BrandLogo className="justify-center" />
          <p className="mt-2 text-sm text-slate-600">
            Inicie sessão para aceder à plataforma
          </p>
        </div>

        <form className="space-y-5" onSubmit={handleSubmit}>
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-bold text-slate-700"
            >
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 block min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 shadow-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
              placeholder="o.seu@email.com"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-sm font-bold text-slate-700"
            >
              Palavra-passe
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={4096}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 block min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 shadow-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
              placeholder="••••••••"
            />
          </div>

          {errorMessage && (
            <p
              role="alert"
              className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {errorMessage}
            </p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="flex min-h-11 w-full items-center justify-center rounded-lg bg-teal-700 px-4 text-sm font-bold text-white transition-colors duration-150 hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
          >
            {isSubmitting ? "A entrar..." : "Entrar"}
          </button>
        </form>

        <p className="text-center text-xs text-slate-500">
          Não existe registo público. Contacte o administrador para obter
          acesso.
        </p>
      </div>
    </main>
  );
}
