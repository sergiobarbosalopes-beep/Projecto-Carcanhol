import { requireAuthorizedUser } from "@/src/auth/server";
import { EmptyFeature } from "@/src/components/empty-feature";

export default async function ChatPage() {
  await requireAuthorizedUser();
  return (
    <EmptyFeature
      title="Chat"
      description="Assistente para análise temática e apoio à decisão."
    />
  );
}
