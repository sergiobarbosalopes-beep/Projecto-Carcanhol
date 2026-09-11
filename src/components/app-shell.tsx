"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SVGProps,
} from "react";
import { BrandLogo } from "@/src/components/brand-logo";
import { LogoutButton } from "@/src/components/logout-button";

const NAVIGATION = [
  { href: "/dashboard", label: "Início", icon: HomeIcon },
  { href: "/pesquisa", label: "Pesquisa", icon: SearchIcon },
  { href: "/chat", label: "Chat", icon: ChatIcon },
  { href: "/analises", label: "Análises", icon: ChartIcon },
  {
    href: "/administracao",
    label: "Administração",
    icon: SettingsIcon,
  },
] as const;

export function AppShell({
  children,
  email,
}: {
  children: ReactNode;
  email: string;
}) {
  const pathname = usePathname();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!isDrawerOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    drawerRef.current?.querySelector<HTMLAnchorElement>("a")?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsDrawerOpen(false);
        menuButtonRef.current?.focus();
        return;
      }

      if (event.key === "Tab" && drawerRef.current) {
        const focusable = Array.from(
          drawerRef.current.querySelectorAll<HTMLElement>(
            'a, button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'
          )
        );
        const first = focusable[0];
        const last = focusable.at(-1);

        if (first && last) {
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isDrawerOpen]);

  return (
    <div className="min-h-dvh bg-slate-50 text-slate-950">
      <a
        href="#conteudo-principal"
        className="fixed left-3 top-3 z-50 -translate-y-20 rounded-md bg-white px-4 py-3 font-semibold text-teal-800 shadow-lg focus:translate-y-0"
      >
        Saltar para o conteúdo
      </a>

      <aside
        className={`fixed inset-y-0 left-0 z-30 hidden border-r border-slate-200 bg-white transition-[width] duration-150 motion-reduce:transition-none xl:flex xl:flex-col ${
          isCollapsed ? "w-20" : "w-64"
        }`}
        aria-label="Navegação principal"
      >
        <div className="flex min-h-16 items-center border-b border-slate-100 px-4">
          <BrandLogo
            className="min-w-0"
            iconClassName="h-8 w-8"
            textClassName={
              isCollapsed
                ? "sr-only"
                : "truncate text-base font-bold tracking-tight"
            }
          />
        </div>
        <Navigation pathname={pathname} compact={isCollapsed} />
        <div className="mt-auto border-t border-slate-100 p-3">
          {!isCollapsed && (
            <p
              className="mb-3 truncate px-1 text-xs text-slate-500"
              title={email}
            >
              {email}
            </p>
          )}
          <LogoutButton compact={isCollapsed} />
          <button
            type="button"
            onClick={() => setIsCollapsed((current) => !current)}
            className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold text-slate-600 transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 motion-reduce:transition-none"
            aria-expanded={!isCollapsed}
            aria-label={
              isCollapsed ? "Expandir barra lateral" : "Recolher barra lateral"
            }
          >
            <ChevronIcon
              className={`h-5 w-5 transition-transform duration-150 motion-reduce:transition-none ${
                isCollapsed ? "rotate-180" : ""
              }`}
            />
            {!isCollapsed && <span>Recolher</span>}
          </button>
        </div>
      </aside>

      <div
        className={`min-w-0 transition-[padding] duration-150 motion-reduce:transition-none ${
          isCollapsed ? "xl:pl-20" : "xl:pl-64"
        }`}
      >
        <header className="sticky top-0 z-20 flex min-h-16 items-center justify-between border-b border-slate-200 bg-white/95 px-4 backdrop-blur xl:hidden">
          <BrandLogo
            iconClassName="h-7 w-7"
            textClassName="text-sm font-bold tracking-tight"
          />
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setIsDrawerOpen(true)}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
            aria-expanded={isDrawerOpen}
            aria-controls="mobile-navigation"
            aria-label="Abrir menu"
          >
            <MenuIcon className="h-6 w-6" />
          </button>
        </header>

        <main
          id="conteudo-principal"
          className="min-w-0 px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
        >
          {children}
        </main>
      </div>

      {isDrawerOpen && (
        <div className="fixed inset-0 z-40 xl:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-slate-950/45"
            onClick={() => {
              setIsDrawerOpen(false);
              menuButtonRef.current?.focus();
            }}
            aria-label="Fechar menu"
          />
          <aside
            ref={drawerRef}
            id="mobile-navigation"
            className="absolute inset-y-0 left-0 flex w-[min(20rem,88vw)] flex-col bg-white shadow-2xl"
            aria-label="Navegação principal"
            aria-modal="true"
            role="dialog"
          >
            <div className="flex min-h-16 items-center justify-between border-b border-slate-100 px-4">
              <BrandLogo
                iconClassName="h-8 w-8"
                textClassName="text-base font-bold tracking-tight"
              />
              <button
                type="button"
                onClick={() => {
                  setIsDrawerOpen(false);
                  menuButtonRef.current?.focus();
                }}
                className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
                aria-label="Fechar menu"
              >
                <CloseIcon className="h-6 w-6" />
              </button>
            </div>
            <Navigation
              pathname={pathname}
              onNavigate={() => setIsDrawerOpen(false)}
            />
            <div className="mt-auto border-t border-slate-100 p-4">
              <p className="mb-3 truncate text-xs text-slate-500" title={email}>
                {email}
              </p>
              <LogoutButton />
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function Navigation({
  pathname,
  compact = false,
  onNavigate,
}: {
  pathname: string;
  compact?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <nav className="flex-1 space-y-1 overflow-y-auto p-3">
      {NAVIGATION.map((item) => {
        const active =
          pathname === item.href || pathname.startsWith(`${item.href}/`);
        const Icon = item.icon;

        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            title={compact ? item.label : undefined}
            className={`flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-semibold transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 motion-reduce:transition-none ${
              active
                ? "bg-teal-50 text-teal-800"
                : "text-slate-600 hover:bg-slate-50 hover:text-slate-950"
            } ${compact ? "justify-center" : ""}`}
          >
            <Icon className="h-5 w-5 shrink-0" />
            <span className={compact ? "sr-only" : ""}>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

type IconProps = SVGProps<SVGSVGElement>;

function IconBase({ children, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  );
}

function HomeIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m3 11 9-8 9 8v9a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" />
    </IconBase>
  );
}
function SearchIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </IconBase>
  );
}
function ChatIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
    </IconBase>
  );
}
function ChartIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </IconBase>
  );
}
function SettingsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.13.37.34.72.6 1 .3.29.68.43 1.1.4h.09v4h-.09c-.42-.03-.8.11-1.1.4-.26.28-.47.63-.6 1Z" />
    </IconBase>
  );
}
function MenuIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </IconBase>
  );
}
function CloseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </IconBase>
  );
}
function ChevronIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m15 18-6-6 6-6" />
    </IconBase>
  );
}
