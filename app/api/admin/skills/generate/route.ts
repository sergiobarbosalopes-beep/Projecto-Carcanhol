import { AuthorizationError, requireAuthorizedUser } from "@/src/auth/server";
import {
  generateSkillProposal,
  InvalidSkillProposalError,
  skillGenerationRequestSchema,
} from "@/src/admin/skill-generation";
import { createClient } from "@/src/database/server";
import {
  jsonError,
  jsonSuccess,
  readBoundedRequestBody,
  rejectCrossOrigin,
  RequestBodyTooLargeError,
} from "@/src/http/api";
import { consumeUserAndIpRateLimit } from "@/src/http/rate-limit";
import { acquireRequestSlot } from "@/src/http/request-slot";
import {
  LlmInferenceDefaultUnavailableError,
  LlmInferenceTimeoutError,
} from "@/src/llm/inference";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 4 * 1024;

export async function POST(request: Request) {
  const originError = rejectCrossOrigin(request);

  if (originError) {
    return originError;
  }

  let releaseSlot: (() => void) | null = null;

  try {
    const supabase = await createClient();
    const user = await requireAuthorizedUser({
      supabase,
      onUnauthorized: "throw",
    });
    const rateLimit = consumeUserAndIpRateLimit({
      request,
      scope: "skill-generation",
      userId: user.id,
      userLimit: 5,
      ipLimit: 15,
      windowMs: 60_000,
    });

    if (!rateLimit.allowed) {
      return jsonError(
        "Foram feitos demasiados pedidos. Aguarde antes de tentar novamente.",
        429,
        { retryAfterSeconds: rateLimit.retryAfterSeconds }
      );
    }

    releaseSlot = acquireRequestSlot("skill-generation", user.id);

    if (!releaseSlot) {
      return jsonError("Já existe uma geração em curso.", 409);
    }

    if (
      request.headers.get("content-type")?.split(";")[0]?.trim() !==
      "application/json"
    ) {
      return jsonError("Conteúdo inválido.", 415);
    }

    const body = await readBoundedRequestBody(request, MAX_BODY_BYTES);
    let input: unknown;

    try {
      input = JSON.parse(body);
    } catch {
      return jsonError("Pedido inválido.", 400);
    }

    const parsed = skillGenerationRequestSchema.safeParse(input);

    if (!parsed.success) {
      return jsonError("Descreva a Skill pretendida com mais detalhe.", 400);
    }

    const proposal = await generateSkillProposal(
      user.id,
      parsed.data.requirement,
      supabase,
      request.signal
    );

    return jsonSuccess({ proposal });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return jsonError("Sessão inválida ou sem acesso.", 401);
    }

    if (error instanceof RequestBodyTooLargeError) {
      return jsonError("Pedido demasiado grande.", 413);
    }

    if (error instanceof LlmInferenceDefaultUnavailableError) {
      return jsonError("Não existe uma predefinição LLM atual e ativa.", 409);
    }

    if (error instanceof LlmInferenceTimeoutError) {
      return jsonError(
        "A geração excedeu o tempo limite. Tente novamente.",
        504
      );
    }

    if (error instanceof InvalidSkillProposalError) {
      return jsonError(
        "A IA devolveu uma proposta inválida. Tente novamente.",
        502
      );
    }

    return jsonError("Não foi possível gerar a proposta de Skill.", 502);
  } finally {
    releaseSlot?.();
  }
}
