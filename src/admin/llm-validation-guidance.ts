import type { LlmValidationErrorCode } from "@/src/admin/llm-provider-validation";

export const LLM_VALIDATION_GUIDANCE: Record<
  LlmValidationErrorCode,
  { message: string; action: string }
> = {
  invalid_token: {
    message: "A credencial foi recusada ou deixou de ser válida.",
    action:
      "Crie um novo fine-grained PAT com a permissão Copilot Requests e tente novamente.",
  },
  no_subscription: {
    message: "A identidade não tem acesso ativo ao GitHub Copilot.",
    action:
      "Confirme a subscrição Copilot da conta usada pelo token e tente novamente.",
  },
  org_policy_blocked: {
    message: "Uma política da organização bloqueia o acesso ao GitHub Copilot.",
    action:
      "Peça ao administrador da organização para autorizar o Copilot para esta conta.",
  },
  timeout: {
    message: "A validação excedeu o tempo máximo.",
    action: "Aguarde alguns instantes e valide novamente.",
  },
  unavailable: {
    message: "O serviço de validação do GitHub Copilot está indisponível.",
    action: "Tente novamente mais tarde.",
  },
  no_models: {
    message: "A conta autenticou, mas não devolveu modelos acessíveis.",
    action: "Confirme a subscrição e as políticas Copilot aplicáveis à conta.",
  },
  unknown: {
    message: "Não foi possível confirmar o acesso ao GitHub Copilot.",
    action: "Valide novamente; se persistir, substitua a credencial.",
  },
  provider_validation_unavailable: {
    message: "A validação real deste fornecedor ainda não está disponível.",
    action:
      "Use GitHub Copilot nesta entrega ou aguarde a implementação do adaptador.",
  },
};

export function getLlmValidationGuidance(
  code: string | null
): { message: string; action: string } | null {
  if (!code || !(code in LLM_VALIDATION_GUIDANCE)) {
    return null;
  }

  return LLM_VALIDATION_GUIDANCE[code as LlmValidationErrorCode];
}
