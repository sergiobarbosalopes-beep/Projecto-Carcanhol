import { AuthorizationError, requireAuthorizedUser } from "@/src/auth/server";
import { duplicateSkill } from "@/src/admin/skills";
import { skillIdSchema } from "@/src/admin/validation";
import { createClient } from "@/src/database/server";
import { jsonError, jsonSuccess, rejectCrossOrigin } from "@/src/http/api";

type DuplicateRouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: DuplicateRouteContext) {
  const originError = rejectCrossOrigin(request);

  if (originError) {
    return originError;
  }

  const { id } = await context.params;
  const parsedId = skillIdSchema.safeParse(id);

  if (!parsedId.success) {
    return jsonError("Identificador de Skill inválido.", 400);
  }

  try {
    const supabase = await createClient();
    const user = await requireAuthorizedUser({
      supabase,
      onUnauthorized: "throw",
    });
    const skill = await duplicateSkill(supabase, user.id, parsedId.data);

    return skill
      ? jsonSuccess({ skill }, 201)
      : jsonError("Skill não encontrada.", 404);
  } catch (error) {
    return error instanceof AuthorizationError
      ? jsonError("Sessão inválida ou sem acesso.", 401)
      : jsonError("Não foi possível duplicar a Skill.", 500);
  }
}
