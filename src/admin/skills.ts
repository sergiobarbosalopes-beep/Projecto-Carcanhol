import "server-only";

import type { CarcanholClient } from "@/src/database/server";
import { createClient } from "@/src/database/server";
import type { Skill, SkillStatus } from "@/src/types/supabase";
import { SKILLS_PAGE_SIZE } from "@/src/admin/validation";

type SkillFields = Pick<
  Skill,
  "name" | "description" | "content_markdown" | "status"
>;

export type SkillList = {
  items: Skill[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function listSkills(
  supabase: CarcanholClient,
  userId: string,
  options: { page: number; query: string; status: SkillStatus | "all" }
): Promise<SkillList> {
  const from = (options.page - 1) * SKILLS_PAGE_SIZE;
  const to = from + SKILLS_PAGE_SIZE - 1;
  let request = supabase
    .from("skills")
    .select("*", { count: "exact" })
    .eq("user_id", userId);

  if (options.query) {
    request = request.ilike("name", `%${escapeLikePattern(options.query)}%`);
  }

  if (options.status !== "all") {
    request = request.eq("status", options.status);
  }

  const { data, error, count } = await request
    .order("updated_at", { ascending: false })
    .range(from, to);

  if (error) {
    throw new Error("Não foi possível carregar as Skills.", { cause: error });
  }

  const total = count ?? 0;

  return {
    items: data,
    page: options.page,
    pageSize: SKILLS_PAGE_SIZE,
    total,
    totalPages: Math.max(1, Math.ceil(total / SKILLS_PAGE_SIZE)),
  };
}

export async function getSkill(
  supabase: CarcanholClient,
  userId: string,
  id: string
): Promise<Skill | null> {
  const { data, error } = await supabase
    .from("skills")
    .select("*")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error("Não foi possível carregar a Skill.", { cause: error });
  }

  return data;
}

export async function createSkill(
  supabase: CarcanholClient,
  userId: string,
  fields: SkillFields
): Promise<Skill> {
  const { data, error } = await supabase
    .from("skills")
    .insert({ user_id: userId, ...fields })
    .select("*")
    .single();

  if (error) {
    throw new Error("Não foi possível criar a Skill.", { cause: error });
  }

  return data;
}

export async function updateSkillFields(
  supabase: CarcanholClient,
  userId: string,
  id: string,
  fields: Omit<SkillFields, "status">
): Promise<Skill | null> {
  const { data, error } = await supabase
    .from("skills")
    .update(fields)
    .eq("user_id", userId)
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error("Não foi possível atualizar a Skill.", { cause: error });
  }

  return data;
}

const ALLOWED_TRANSITIONS: Record<
  Exclude<SkillStatus, "archived"> | "restore",
  { from: SkillStatus[]; to: SkillStatus }
> = {
  active: { from: ["draft", "inactive"], to: "active" },
  inactive: { from: ["active"], to: "inactive" },
  draft: { from: [], to: "draft" },
  restore: { from: ["archived"], to: "inactive" },
};

export async function changeSkillStatus(
  supabase: CarcanholClient,
  userId: string,
  id: string,
  action: "activate" | "deactivate" | "archive" | "restore"
): Promise<Skill | null> {
  const current = await getSkill(supabase, userId, id);

  if (!current) {
    return null;
  }

  const transition =
    action === "activate"
      ? ALLOWED_TRANSITIONS.active
      : action === "deactivate"
        ? ALLOWED_TRANSITIONS.inactive
        : action === "restore"
          ? ALLOWED_TRANSITIONS.restore
          : {
              from: ["draft", "active", "inactive"] satisfies SkillStatus[],
              to: "archived" as const,
            };

  if (!transition.from.includes(current.status)) {
    throw new SkillLifecycleError("Esta alteração de estado não é permitida.");
  }

  const { data, error } = await supabase
    .from("skills")
    .update({ status: transition.to })
    .eq("user_id", userId)
    .eq("id", id)
    .eq("status", current.status)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error("Não foi possível alterar o estado da Skill.", {
      cause: error,
    });
  }

  if (!data) {
    throw new SkillLifecycleError(
      "A Skill foi alterada por outro pedido. Atualize a lista e tente novamente."
    );
  }

  return data;
}

export async function duplicateSkill(
  supabase: CarcanholClient,
  userId: string,
  id: string
): Promise<Skill | null> {
  const original = await getSkill(supabase, userId, id);

  if (!original) {
    return null;
  }

  const suffix = " (cópia)";
  const name = `${original.name.slice(0, 120 - suffix.length)}${suffix}`;

  return createSkill(supabase, userId, {
    name,
    description: original.description,
    content_markdown: original.content_markdown,
    status: "draft",
  });
}

export async function permanentlyDeleteSkill(
  supabase: CarcanholClient,
  userId: string,
  id: string,
  confirmationName: string
): Promise<"deleted" | "not_found"> {
  const current = await getSkill(supabase, userId, id);

  if (!current) {
    return "not_found";
  }

  if (current.status === "active") {
    throw new SkillLifecycleError(
      "Desative a Skill antes de a eliminar definitivamente."
    );
  }

  if (confirmationName !== current.name) {
    throw new SkillLifecycleError(
      "A confirmação não corresponde ao nome da Skill."
    );
  }

  const { error } = await supabase
    .from("skills")
    .delete()
    .eq("user_id", userId)
    .eq("id", id)
    .neq("status", "active")
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error("Não foi possível eliminar a Skill.", { cause: error });
  }

  const { data: remaining, error: remainingError } = await supabase
    .from("skills")
    .select("id")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();

  if (remainingError) {
    throw new Error("Não foi possível confirmar a eliminação da Skill.", {
      cause: remainingError,
    });
  }

  if (remaining) {
    throw new SkillLifecycleError(
      "A Skill foi alterada por outro pedido. Atualize a lista e tente novamente."
    );
  }

  return "deleted";
}

export async function listActiveSkills(
  userId: string,
  supabase?: CarcanholClient
): Promise<Pick<Skill, "id" | "name" | "description" | "updated_at">[]> {
  const client = supabase ?? (await createClient());
  const { data, error } = await client
    .from("skills")
    .select("id, name, description, updated_at")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("name")
    .limit(100);

  if (error) {
    throw new Error("Não foi possível carregar as Skills ativas.", {
      cause: error,
    });
  }

  return data;
}

export async function getActiveSkill(
  userId: string,
  id: string,
  supabase?: CarcanholClient
): Promise<Skill | null> {
  const client = supabase ?? (await createClient());
  const { data, error } = await client
    .from("skills")
    .select("*")
    .eq("user_id", userId)
    .eq("id", id)
    .eq("status", "active")
    .maybeSingle();

  if (error) {
    throw new Error("Não foi possível carregar a Skill ativa.", {
      cause: error,
    });
  }

  return data;
}

export class SkillLifecycleError extends Error {}
