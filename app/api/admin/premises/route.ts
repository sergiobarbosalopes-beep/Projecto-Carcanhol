import { AuthorizationError, requireAuthorizedUser } from "@/src/auth/server";
import { globalAssumptionsSchema } from "@/src/admin/validation";
import { saveGlobalAssumptions } from "@/src/admin/global-assumptions";
import { createClient } from "@/src/database/server";
import { jsonError, jsonSuccess, rejectCrossOrigin } from "@/src/http/api";

export async function PUT(request: Request) {
  const originError = rejectCrossOrigin(request);

  if (originError) {
    return originError;
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return jsonError("Conteúdo inválido.", 400);
  }

  const input = globalAssumptionsSchema.safeParse(body);

  if (!input.success) {
    return jsonError("O conteúdo não pode exceder 20 000 caracteres.", 400);
  }

  try {
    const supabase = await createClient();
    const user = await requireAuthorizedUser({
      supabase,
      onUnauthorized: "throw",
    });
    const assumptions = await saveGlobalAssumptions(
      supabase,
      user.id,
      input.data.content
    );

    return jsonSuccess({ assumptions });
  } catch (error) {
    return error instanceof AuthorizationError
      ? jsonError("Sessão inválida ou sem acesso.", 401)
      : jsonError("Não foi possível guardar as premissas globais.", 500);
  }
}
