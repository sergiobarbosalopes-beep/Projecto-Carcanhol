import { AuthorizationError, requireAuthorizedUser } from "@/src/auth/server";
import { passwordChangeSchema } from "@/src/admin/validation";
import { createClient } from "@/src/database/server";
import { jsonError, jsonSuccess, rejectCrossOrigin } from "@/src/http/api";

const GENERIC_PASSWORD_ERROR =
  "Não foi possível alterar a palavra-passe. Tente novamente.";

export async function POST(request: Request) {
  const originError = rejectCrossOrigin(request);

  if (originError) {
    return originError;
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return jsonError("Preencha os três campos de palavra-passe.", 400);
  }

  const input = passwordChangeSchema.safeParse(body);

  if (!input.success) {
    return jsonError(
      input.error.issues.some(
        (issue) => issue.message === "As palavras-passe não coincidem."
      )
        ? "As palavras-passe não coincidem."
        : "Revise a palavra-passe atual e use entre 8 e 128 caracteres na nova.",
      400
    );
  }

  try {
    const supabase = await createClient();
    const user = await requireAuthorizedUser({
      supabase,
      onUnauthorized: "throw",
    });

    if (!user.email) {
      return jsonError(GENERIC_PASSWORD_ERROR, 400);
    }

    const { error: verificationError } = await supabase.auth.signInWithPassword(
      {
        email: user.email,
        password: input.data.currentPassword,
      }
    );

    if (verificationError) {
      return jsonError("A palavra-passe atual não está correta.", 400);
    }

    const { error } = await supabase.auth.updateUser({
      password: input.data.password,
    });

    if (error) {
      return jsonError(GENERIC_PASSWORD_ERROR, 400);
    }

    return jsonSuccess({ success: true });
  } catch (error) {
    return error instanceof AuthorizationError
      ? jsonError("Sessão inválida ou sem acesso.", 401)
      : jsonError(GENERIC_PASSWORD_ERROR, 503);
  }
}
