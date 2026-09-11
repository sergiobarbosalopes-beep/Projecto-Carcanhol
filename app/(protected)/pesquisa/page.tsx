import { requireAuthorizedUser } from "@/src/auth/server";
import { EmptyFeature } from "@/src/components/empty-feature";

export default async function SearchPage() {
  await requireAuthorizedUser();
  return (
    <EmptyFeature
      title="Pesquisa"
      description="Pesquisa de instrumentos e informação financeira."
    />
  );
}
