import { AuthorizationError, requireAuthorizedUser } from "@/src/auth/server";
import {
  createLlmAccount,
  listLlmAccounts,
  LlmAccountConflictError,
  LlmCredentialValidationError,
} from "@/src/admin/llm-accounts";
import { createLlmAccountSchema } from "@/src/admin/llm-validation";
import { createClient } from "@/src/database/server";
import { jsonError, jsonSuccess, rejectCrossOrigin } from "@/src/http/api";

export async function GET() {
  try {
    const supabase = await createClient();
    const user = await requireAuthorizedUser({
      supabase,
      onUnauthorized: "throw",
    });
    const accounts = await listLlmAccounts(user.id);

    return jsonSuccess({ accounts });
  } catch (error) {
    return error instanceof AuthorizationError
      ? jsonError("Sessão inválida ou sem acesso.", 401)
      : jsonError("Não foi possível carregar as contas LLM.", 500);
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
    return jsonError("Dados da conta LLM inválidos.", 400);
  }

  const input = createLlmAccountSchema.safeParse(body);

  if (!input.success) {
    const credentialIssues = input.error.issues.filter(
      (issue) => issue.path[0] === "credential"
    );
    const credentialIssue = credentialIssues[credentialIssues.length - 1];

    return jsonError(
      credentialIssue?.message ??
        "Revise o fornecedor, nome, credencial e endpoint da conta.",
      400
    );
  }

  try {
    const supabase = await createClient();
    const user = await requireAuthorizedUser({
      supabase,
      onUnauthorized: "throw",
    });
    const account = await createLlmAccount(user.id, input.data);

    return jsonSuccess({ account }, 201);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return jsonError("Sessão inválida ou sem acesso.", 401);
    }

    if (error instanceof LlmAccountConflictError) {
      return jsonError(error.message, 409);
    }

    if (error instanceof LlmCredentialValidationError) {
      return jsonError(error.message, 400);
    }

    return jsonError("Não foi possível criar a conta LLM.", 500);
  }
}
