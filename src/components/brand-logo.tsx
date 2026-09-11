/**
 * Lightweight, reusable brand mark for "Projecto Carcanhol".
 *
 * Design notes (Fase 1, performance-first):
 * - Pure inline SVG (no icon library / image asset) — near-zero payload and
 *   no extra network request.
 * - Server Component: no interactivity, so it never needs "use client".
 * - Accessible: the symbol is decorative (`aria-hidden`) and the visible
 *   text label is the single accessible name — no duplicated/hidden text
 *   for screen readers.
 * - Sizes are controlled via Tailwind classes on the wrapper so the same
 *   component works at any breakpoint (mobile/tablet/desktop) without
 *   layout-shifting between variants.
 */
export function BrandLogo({
  className = "",
  iconClassName = "h-8 w-8",
  textClassName = "text-xl font-semibold tracking-tight",
}: {
  className?: string;
  iconClassName?: string;
  textClassName?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <svg
        viewBox="0 0 32 32"
        aria-hidden="true"
        focusable="false"
        className={`shrink-0 text-teal-700 ${iconClassName}`}
      >
        {/* Abstract ascending bars + trend line: growth / analysis symbol. */}
        <rect x="4" y="18" width="5" height="10" rx="1" fill="currentColor" />
        <rect
          x="13.5"
          y="12"
          width="5"
          height="16"
          rx="1"
          fill="currentColor"
        />
        <rect x="23" y="6" width="5" height="22" rx="1" fill="currentColor" />
        <path
          d="M3 15.5 12 8l6 5 11-9"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.55"
        />
      </svg>
      <span className={`text-slate-950 ${textClassName}`}>
        Projecto Carcanhol
      </span>
    </span>
  );
}
