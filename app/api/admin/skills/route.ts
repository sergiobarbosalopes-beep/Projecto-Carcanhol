import { AuthorizationError, requireAuthorizedUser } from "@/src/auth/server";
import {
  createSkillSchema,
  listSkillsQuerySchema,
} from "@/src/admin/validation";
import { createSkill, listSkills } from "@/src/admin/skills";
import { createClient } from "@/src/database/server";
import { jsonError, jsonSuccess, rejectCrossOrigin } from "@/src/http/api";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const input = listSkillsQuerySchema.safeParse({
    page: requestUrl.searchParams.get("page") ?? undefined,
    query: requestUrl.searchParams.get("query") ?? undefined,
    status: requestUrl.searchParams.get("status") ?? undefined,
  });

  if (!input.success) {
    return jsonError("Filtros de pesquisa inválidos.", 400);
  }

  try {
    const supabase = await createClient();
    const user = await requireAuthorizedUser({
      supabase,
      onUnauthorized: "throw",
    });
    const result = await listSkills(supabase, user.id, input.data);

    return jsonSuccess(result);
  } catch (error) {
    return error instanceof AuthorizationError
      ? jsonError("Sessão inválida ou sem acesso.", 401)
      : jsonError("Não foi possível carregar as Skills.", 500);
  }
}

export async function POST(request: Request) {
  const originError = rejectCrossOrigin(request);

  if (originError) {
    return originError;
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return jsonError("Dados da Skill inválidos.", 400);
  }

  const input = createSkillSchema.safeParse(body);

  if (!input.success) {
    return jsonError("Revise o nome, descrição e conteúdo da Skill.", 400);
  }

  try {
    const supabase = await createClient();
    const user = await requireAuthorizedUser({
      supabase,
      onUnauthorized: "throw",
    });
    const skill = await createSkill(supabase, user.id, input.data);

    return jsonSuccess({ skill }, 201);
  } catch (error) {
    return error instanceof AuthorizationError
      ? jsonError("Sessão inválida ou sem acesso.", 401)
      : jsonError("Não foi possível criar a Skill.", 500);
  }
}
