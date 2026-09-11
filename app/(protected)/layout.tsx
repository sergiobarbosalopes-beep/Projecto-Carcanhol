import type { ReactNode } from "react";
import { requireAuthorizedUser } from "@/src/auth/server";
import { AppShell } from "@/src/components/app-shell";

export default async function ProtectedLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await requireAuthorizedUser();

  return (
    <AppShell email={user.email ?? "Utilizador Carcanhol"}>{children}</AppShell>
  );
}
