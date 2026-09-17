import { requireAuthorizedUser } from "@/src/auth/server";
import { createClient } from "@/src/database/server";
import { loadChatBootstrap } from "@/src/chat/repository";
import { ChatWorkspace } from "./chat-workspace";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ conversation?: string }>;
}) {
  const user = await requireAuthorizedUser();
  const client = await createClient();
  const { conversation } = await searchParams;
  const bootstrap = await loadChatBootstrap(client, user.id, conversation);

  return <ChatWorkspace initial={bootstrap} />;
}
