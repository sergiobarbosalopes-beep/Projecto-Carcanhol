import "server-only";

import type { CarcanholClient } from "@/src/database/server";
import type { GlobalAssumptions } from "@/src/types/supabase";

export async function getGlobalAssumptions(
  supabase: CarcanholClient,
  userId: string
): Promise<GlobalAssumptions | null> {
  const { data, error } = await supabase
    .from("global_assumptions")
    .select("user_id, content, created_at, updated_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error("Não foi possível carregar as premissas globais.", {
      cause: error,
    });
  }

  return data;
}

export async function saveGlobalAssumptions(
  supabase: CarcanholClient,
  userId: string,
  content: string
): Promise<GlobalAssumptions> {
  const { data, error } = await supabase
    .from("global_assumptions")
    .upsert({ user_id: userId, content }, { onConflict: "user_id" })
    .select("user_id, content, created_at, updated_at")
    .single();

  if (error) {
    throw new Error("Não foi possível guardar as premissas globais.", {
      cause: error,
    });
  }

  return data;
}
