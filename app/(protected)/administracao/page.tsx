import { requireAuthorizedUser } from "@/src/auth/server";
import { getGlobalAssumptions } from "@/src/admin/global-assumptions";
import { listLlmAccounts } from "@/src/admin/llm-accounts";
import { listSkills } from "@/src/admin/skills";
import { createClient } from "@/src/database/server";
import { PageHeading } from "@/src/components/page-heading";
import { AdminPanel } from "./admin-panel";

export const dynamic = "force-dynamic";

export default async function AdministrationPage() {
  const user = await requireAuthorizedUser();
  const supabase = await createClient();
  const [accounts, assumptions, skills] = await Promise.all([
    listLlmAccounts(user.id),
    getGlobalAssumptions(supabase, user.id),
    listSkills(supabase, user.id, { page: 1, query: "", status: "all" }),
  ]);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeading
        title="Administração"
        description="Gerir fornecedores LLM, conta e instruções que irão orientar o assistente."
      />
      <AdminPanel
        email={user.email ?? "Email não disponível"}
        initialLlmAccounts={accounts}
        initialAssumptions={assumptions?.content ?? ""}
        initialSkills={skills}
      />
    </div>
  );
}
