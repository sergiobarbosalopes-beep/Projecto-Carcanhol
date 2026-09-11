import { requireAuthorizedUser } from "@/src/auth/server";
import { EmptyFeature } from "@/src/components/empty-feature";

export default async function AnalysesPage() {
  await requireAuthorizedUser();
  return (
    <EmptyFeature
      title="Análises"
      description="Histórico e detalhe das análises de investimento."
    />
  );
}
