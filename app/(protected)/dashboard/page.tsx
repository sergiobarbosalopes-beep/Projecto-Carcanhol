import Link from "next/link";
import { requireAuthorizedUser } from "@/src/auth/server";
import { PageHeading } from "@/src/components/page-heading";

const SHORTCUTS = [
  {
    href: "/pesquisa",
    title: "Pesquisa",
    description: "Descobrir instrumentos e dados financeiros.",
  },
  {
    href: "/chat",
    title: "Chat",
    description: "Conversar com o futuro assistente de análise.",
  },
  {
    href: "/analises",
    title: "Análises",
    description: "Consultar análises temáticas e sectoriais.",
  },
  {
    href: "/administracao",
    title: "Administração",
    description: "Gerir fornecedores LLM, Skills, premissas globais e a conta.",
  },
] as const;

export default async function DashboardPage() {
  await requireAuthorizedUser();

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeading
        title="Início"
        description="Acesso rápido às áreas principais do Projecto Carcanhol."
      />
      <section aria-labelledby="atalhos-heading">
        <h2
          id="atalhos-heading"
          className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-500"
        >
          Atalhos
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {SHORTCUTS.map((shortcut, index) => (
            <Link
              key={shortcut.href}
              href={shortcut.href}
              className="group min-h-32 rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition-colors duration-150 hover:border-teal-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 motion-reduce:transition-none"
            >
              <span className="text-xs font-bold text-teal-700">
                0{index + 1}
              </span>
              <h3 className="mt-3 font-bold text-slate-950">
                {shortcut.title}
              </h3>
              <p className="mt-1 text-sm leading-5 text-slate-600">
                {shortcut.description}
              </p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
