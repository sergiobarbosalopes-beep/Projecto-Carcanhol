import type { ReactNode } from "react";

export function PageHeading({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
          {title}
        </h1>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600 sm:text-base">
          {description}
        </p>
      </div>
      {action}
    </header>
  );
}
