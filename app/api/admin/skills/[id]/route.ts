import { AuthorizationError, requireAuthorizedUser } from "@/src/auth/server";
import {
  deleteSkillSchema,
  skillIdSchema,
  updateSkillSchema,
} from "@/src/admin/validation";
import {
  changeSkillStatus,
  getSkill,
  permanentlyDeleteSkill,
  SkillLifecycleError,
  updateSkillFields,
} from "@/src/admin/skills";
import { createClient } from "@/src/database/server";
import { jsonError, jsonSuccess, rejectCrossOrigin } from "@/src/http/api";

type SkillRouteContext = {
  params: Promise<{ id: string }>;
};

async function parseId(context: SkillRouteContext) {
  const { id } = await context.params;
  return skillIdSchema.safeParse(id);
}

export async function GET(_request: Request, context: SkillRouteContext) {
  const id = await parseId(context);

  if (!id.success) {
    return jsonError("Identificador de Skill inválido.", 400);
  }

  try {
    const supabase = await createClient();
    const user = await requireAuthorizedUser({
      supabase,
      onUnauthorized: "throw",
    });
    const skill = await getSkill(supabase, user.id, id.data);

    return skill
      ? jsonSuccess({ skill })
      : jsonError("Skill não encontrada.", 404);
  } catch (error) {
    return error instanceof AuthorizationError
      ? jsonError("Sessão inválida ou sem acesso.", 401)
      : jsonError("Não foi possível carregar a Skill.", 500);
  }
}

export async function PATCH(request: Request, context: SkillRouteContext) {
  const originError = rejectCrossOrigin(request);

  if (originError) {
    return originError;
  }

  const id = await parseId(context);

  if (!id.success) {
    return jsonError("Identificador de Skill inválido.", 400);
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return jsonError("Dados da Skill inválidos.", 400);
  }

  const input = updateSkillSchema.safeParse(body);

  if (!input.success) {
    return jsonError("Revise os dados da Skill.", 400);
  }

  try {
    const supabase = await createClient();
    const user = await requireAuthorizedUser({
      supabase,
      onUnauthorized: "throw",
    });
    const skill =
      input.data.action === "update"
        ? await updateSkillFields(supabase, user.id, id.data, {
            name: input.data.name,
            description: input.data.description,
            content_markdown: input.data.content_markdown,
          })
        : await changeSkillStatus(
            supabase,
            user.id,
            id.data,
            input.data.action
          );

    return skill
      ? jsonSuccess({ skill })
      : jsonError("Skill não encontrada.", 404);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return jsonError("Sessão inválida ou sem acesso.", 401);
    }

    if (error instanceof SkillLifecycleError) {
      return jsonError(error.message, 409);
    }

    return jsonError("Não foi possível atualizar a Skill.", 500);
  }
}

export async function DELETE(request: Request, context: SkillRouteContext) {
  const originError = rejectCrossOrigin(request);

  if (originError) {
    return originError;
  }

  const id = await parseId(context);

  if (!id.success) {
    return jsonError("Identificador de Skill inválido.", 400);
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return jsonError("Confirmação inválida.", 400);
  }

  const input = deleteSkillSchema.safeParse(body);

  if (!input.success) {
    return jsonError("Confirmação inválida.", 400);
  }

  try {
    const supabase = await createClient();
    const user = await requireAuthorizedUser({
      supabase,
      onUnauthorized: "throw",
    });
    const result = await permanentlyDeleteSkill(
      supabase,
      user.id,
      id.data,
      input.data.confirmationName
    );

    return result === "deleted"
      ? jsonSuccess({ success: true })
      : jsonError("Skill não encontrada.", 404);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return jsonError("Sessão inválida ou sem acesso.", 401);
    }

    if (error instanceof SkillLifecycleError) {
      return jsonError(error.message, 409);
    }

    return jsonError("Não foi possível eliminar a Skill.", 500);
  }
}
