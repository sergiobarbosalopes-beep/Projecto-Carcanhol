"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  AUTO_VALIDATION_MAX_ACCOUNTS,
  createRequestCoalescer,
  isAutomaticLlmRefreshDue,
  runBoundedAccountValidation,
} from "@/src/admin/llm-auto-validation";
import {
  LLM_ACCOUNT_NAME_MAX_LENGTH,
  LLM_CREDENTIAL_MAX_LENGTH,
  LLM_CUSTOM_ENDPOINT_MAX_LENGTH,
  LLM_PROVIDERS,
  getLlmCredentialError,
  isManuallyManagedLlmCredentialType,
} from "@/src/admin/llm-validation";
import {
  getLlmValidationGuidance,
  isTransientLlmValidationError,
} from "@/src/admin/llm-validation-guidance";
import type {
  LlmAccountPublic,
  LlmAccountStatus,
  LlmCredentialType,
  LlmProvider,
} from "@/src/types/supabase";

const PROVIDER_DETAILS: Record<
  LlmProvider,
  { label: string; shortLabel: string; credentialLabel: string }
> = {
  github_copilot: {
    label: "GitHub Copilot",
    shortLabel: "GH",
    credentialLabel: "Fine-grained PAT",
  },
  anthropic: {
    label: "Anthropic",
    shortLabel: "AN",
    credentialLabel: "API key",
  },
  google_gemini: {
    label: "Google Gemini",
    shortLabel: "GE",
    credentialLabel: "API key",
  },
  deepseek: {
    label: "DeepSeek",
    shortLabel: "DS",
    credentialLabel: "API key",
  },
  openai_compatible: {
    label: "OpenAI-compatible / custom",
    shortLabel: "OA",
    credentialLabel: "API key",
  },
};

const STATUS_LABELS: Record<LlmAccountStatus, string> = {
  pending_validation: "Por validar",
  active: "Ativa",
  invalid: "Requer atenção",
  error: "Requer atenção",
  inactive: "Requer atenção",
};

const CREDENTIAL_TYPE_LABELS: Record<LlmCredentialType, string> = {
  fine_grained_pat: "Fine-grained PAT",
  oauth_app_user: "OAuth user token",
  github_app_user: "GitHub App user token",
  api_key: "API key",
  token: "Token legado",
  oauth: "OAuth legado",
};

type AccountActionType = "edit" | "credential" | "delete";
type AccountAction = {
  type: AccountActionType;
  accountId: string;
} | null;

type Feedback = {
  kind: "success" | "error";
  message: string;
  action?: string;
} | null;

const accountValidationRequests =
  createRequestCoalescer<ApiResult<{ account: LlmAccountPublic }>>();

export function LlmPanel({
  active,
  initialAccounts,
}: {
  active: boolean;
  initialAccounts: LlmAccountPublic[];
}) {
  const [accounts, setAccounts] = useState(initialAccounts);
  const [creating, setCreating] = useState(false);
  const [action, setAction] = useState<AccountAction>(null);
  const [loading, setLoading] = useState(false);
  const [defaultPendingId, setDefaultPendingId] = useState<string | null>(null);
  const [validatingIds, setValidatingIds] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState<Feedback>(null);
  const mountedRef = useRef(false);
  const automaticValidationStartedRef = useRef(false);
  const accountsRef = useRef(accounts);

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  useEffect(() => {
    mountedRef.current = true;

    if (!active) {
      automaticValidationStartedRef.current = false;
      return () => {
        mountedRef.current = false;
      };
    }

    if (!automaticValidationStartedRef.current) {
      automaticValidationStartedRef.current = true;
      const githubAccountIds = accountsRef.current
        .filter(
          (account) =>
            account.provider === "github_copilot" &&
            isAutomaticLlmRefreshDue(
              account.quota?.attempted_at ?? account.last_validation_at
            )
        )
        .map((account) => account.id);

      void runBoundedAccountValidation({
        accountIds: githubAccountIds,
        validate: validateAccountRequest,
        onStart: (accountId) => {
          if (mountedRef.current) {
            setValidatingIds((current) => withSetValue(current, accountId));
          }
        },
        onResult: (accountId, result) => {
          if (!mountedRef.current) {
            return;
          }

          setValidatingIds((current) => withoutSetValue(current, accountId));

          if (result.ok) {
            setAccounts((current) =>
              replaceAccount(current, result.data.account)
            );
          } else {
            if (result.code === "validation_superseded") {
              void loadAccounts();
            }

            setFeedback({
              kind: "error",
              message: result.error,
              action: result.action,
            });
          }
        },
        onError: (accountId) => {
          if (mountedRef.current) {
            setValidatingIds((current) => withoutSetValue(current, accountId));
          }
        },
      });

      if (githubAccountIds.length > AUTO_VALIDATION_MAX_ACCOUNTS) {
        setFeedback({
          kind: "error",
          message: `Foram validadas apenas as primeiras ${AUTO_VALIDATION_MAX_ACCOUNTS.toLocaleString("pt-PT")} contas GitHub Copilot.`,
          action:
            "Use “Validar novamente” nas restantes contas ou reduza o número de contas configuradas.",
        });
      }
    }

    return () => {
      mountedRef.current = false;
    };
  }, [active]);

  async function validateAccount(accountId: string) {
    setValidatingIds((current) => withSetValue(current, accountId));
    setFeedback(null);
    const result = await validateAccountRequest(accountId);

    if (!mountedRef.current) {
      return;
    }

    setValidatingIds((current) => withoutSetValue(current, accountId));

    if (!result.ok) {
      if (result.code === "validation_superseded") {
        await loadAccounts();
      }

      setFeedback({
        kind: "error",
        message: result.error,
        action: result.action,
      });
      return;
    }

    setAccounts((current) => replaceAccount(current, result.data.account));
    const guidance = getLlmValidationGuidance(
      result.data.account.last_validation_error_code
    );
    setFeedback(
      result.data.account.status === "active"
        ? {
            kind: "success",
            message: "Conta validada e catálogo de modelos sincronizado.",
          }
        : {
            kind: "error",
            message:
              guidance?.message ?? "A conta requer atenção antes de ser usada.",
            action: guidance?.action,
          }
    );
  }

  async function loadAccounts() {
    setLoading(true);
    const result = await requestJson<{ accounts: LlmAccountPublic[] }>(
      "/api/admin/llm-accounts"
    );
    setLoading(false);

    if (!result.ok) {
      setFeedback({ kind: "error", message: result.error });
      return false;
    }

    setAccounts(result.data.accounts);
    return true;
  }

  async function selectDefault(accountModelId: string) {
    setDefaultPendingId(accountModelId);
    setFeedback(null);
    const result = await requestJson<{ accountModelId: string }>(
      "/api/admin/llm-default",
      {
        method: "PUT",
        body: JSON.stringify({ accountModelId }),
      }
    );
    setDefaultPendingId(null);

    if (!result.ok) {
      setFeedback({ kind: "error", message: result.error });
      return;
    }

    setAccounts((current) =>
      current.map((account) => ({
        ...account,
        models: account.models.map((model) => ({
          ...model,
          is_default: model.id === result.data.accountModelId,
        })),
      }))
    );
    setFeedback({
      kind: "success",
      message: "Predefinição global atualizada.",
    });
  }

  const pendingCount = accounts.filter(
    (account) => account.status !== "active"
  ).length;
  const activeCount = accounts.filter(
    (account) => account.status === "active"
  ).length;
  const availableModelCount = accounts.reduce(
    (total, account) =>
      total +
      (account.status === "active"
        ? account.models.filter((model) => !model.is_stale).length
        : 0),
    0
  );

  return (
    <div className="min-w-0">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <SectionTitle
          title="Contas de fornecedores LLM"
          description="Valide contas, consulte modelos e utilização account-wide e escolha a combinação conta+modelo usada por predefinição."
        />
        <button
          type="button"
          onClick={() => {
            setCreating(true);
            setAction(null);
            setFeedback(null);
          }}
          disabled={creating || loading}
          className={`${PRIMARY_BUTTON_CLASS} self-start`}
        >
          Adicionar conta
        </button>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          label="Contas configuradas"
          value={accounts.length.toLocaleString("pt-PT")}
        />
        <SummaryCard
          label="Requerem atenção"
          value={pendingCount.toLocaleString("pt-PT")}
        />
        <SummaryCard
          label="Contas ativas"
          value={activeCount.toLocaleString("pt-PT")}
        />
        <SummaryCard
          label="Modelos disponíveis"
          value={availableModelCount.toLocaleString("pt-PT")}
        />
      </div>

      <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-950">
        As contas GitHub Copilot são revalidadas ao entrar nesta área. Uma conta
        só fica ativa após autenticação real e descoberta de pelo menos um
        modelo. A atualização automática respeita um intervalo mínimo de 15
        minutos; “Validar novamente” força uma atualização imediata.
      </div>

      <FeedbackMessage feedback={feedback} />

      {creating && (
        <div className="mt-6 rounded-xl border border-teal-200 bg-teal-50/40 p-4 sm:p-6">
          <CreateAccountForm
            onCancel={() => setCreating(false)}
            onCreated={async (account) => {
              setCreating(false);
              setAccounts((current) => [account, ...current]);
              setFeedback({
                kind: "success",
                message:
                  "Conta validada e guardada. A credencial não voltará a ser mostrada.",
              });
            }}
          />
        </div>
      )}

      <section className="mt-8" aria-labelledby="llm-connections-heading">
        <div className="flex min-h-11 items-center justify-between gap-3">
          <h3
            id="llm-connections-heading"
            className="text-base font-bold text-slate-950"
          >
            Ligações
          </h3>
          {loading && (
            <span role="status" className="text-xs text-slate-500">
              A atualizar...
            </span>
          )}
        </div>

        {accounts.length === 0 ? (
          <div className="mt-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center">
            <div
              className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-teal-100 text-sm font-bold text-teal-800"
              aria-hidden="true"
            >
              LLM
            </div>
            <h4 className="mt-4 text-lg font-bold text-slate-900">
              Ainda não existem contas
            </h4>
            <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-slate-600">
              Adicione uma conta GitHub Copilot com um fine-grained PAT. Pode
              configurar várias contas, desde que tenham nomes diferentes.
            </p>
          </div>
        ) : (
          <ul className="mt-2 grid gap-4 xl:grid-cols-2">
            {accounts.map((account) => {
              const currentAction =
                action?.accountId === account.id ? action.type : null;

              return (
                <li
                  key={account.id}
                  aria-busy={validatingIds.has(account.id)}
                  className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"
                >
                  <AccountCard
                    account={account}
                    action={currentAction}
                    busy={loading || validatingIds.has(account.id)}
                    validating={validatingIds.has(account.id)}
                    onValidate={() => void validateAccount(account.id)}
                    onAction={(type) => {
                      setAction(
                        currentAction === type
                          ? null
                          : { type, accountId: account.id }
                      );
                      setCreating(false);
                      setFeedback(null);
                    }}
                  />

                  {currentAction === "edit" && (
                    <EditAccountForm
                      account={account}
                      onCancel={() => setAction(null)}
                      onSaved={async () => {
                        setAction(null);
                        if (await loadAccounts()) {
                          setFeedback({
                            kind: "success",
                            message: "Metadados da conta atualizados.",
                          });
                        }
                      }}
                    />
                  )}
                  {currentAction === "credential" && (
                    <ReplaceCredentialForm
                      account={account}
                      onCancel={() => setAction(null)}
                      onSaved={async () => {
                        setAction(null);
                        if (await loadAccounts()) {
                          setFeedback({
                            kind: "success",
                            message:
                              "Credencial substituída. A conta continua “Por validar”.",
                          });
                        }
                      }}
                    />
                  )}
                  {currentAction === "delete" && (
                    <DeleteAccountConfirmation
                      account={account}
                      onCancel={() => setAction(null)}
                      onDeleted={async () => {
                        setAction(null);
                        if (await loadAccounts()) {
                          setFeedback({
                            kind: "success",
                            message: "Conta LLM eliminada definitivamente.",
                          });
                        }
                      }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="mt-8 grid gap-4">
        <ModelCatalogSection
          accounts={accounts}
          defaultPendingId={defaultPendingId}
          onSelectDefault={(modelId) => void selectDefault(modelId)}
        />
        <UsageAvailabilitySection accounts={accounts} />
      </div>
    </div>
  );
}

function AccountCard({
  account,
  action,
  busy,
  validating,
  onValidate,
  onAction,
}: {
  account: LlmAccountPublic;
  action: AccountActionType | null;
  busy: boolean;
  validating: boolean;
  onValidate: () => void;
  onAction: (action: AccountActionType) => void;
}) {
  const provider = PROVIDER_DETAILS[account.provider];
  const validationGuidance = getLlmValidationGuidance(
    account.last_validation_error_code
  );
  const currentModelCount = account.models.filter(
    (model) => !model.is_stale
  ).length;
  const transientFailure =
    account.status === "error" &&
    isTransientLlmValidationError(account.last_validation_error_code);
  const lastCatalogAt = account.models.reduce<string | null>(
    (latest, model) =>
      !latest || new Date(model.last_seen_at) > new Date(latest)
        ? model.last_seen_at
        : latest,
    null
  );

  return (
    <>
      <div className="flex items-start gap-3">
        <div
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xs font-black text-slate-700"
          aria-hidden="true"
        >
          {provider.shortLabel}
        </div>
        <div className="min-w-0 flex-1">
          <StatusBadge status={account.status} validating={validating} />
          <h4 className="mt-2 break-words text-lg font-bold text-slate-950">
            {account.display_name}
          </h4>
          <p className="mt-1 text-sm text-slate-600">{provider.label}</p>
        </div>
      </div>

      <dl className="mt-5 grid gap-x-4 gap-y-3 rounded-xl bg-slate-50 p-4 text-xs sm:grid-cols-2">
        <Metadata label="Autenticação">
          {CREDENTIAL_TYPE_LABELS[account.credential_type]}
        </Metadata>
        <Metadata label="Credencial">
          <span className="font-mono">{account.credential_hint}</span>
        </Metadata>
        {account.custom_endpoint && (
          <Metadata label="Endpoint" wide>
            <span className="break-all">{account.custom_endpoint}</span>
          </Metadata>
        )}
        <Metadata label="Criada">{formatDate(account.created_at)}</Metadata>
        <Metadata label="Atualizada">{formatDate(account.updated_at)}</Metadata>
        <Metadata label="Credencial substituída" wide>
          {formatDate(account.credential_updated_at)}
        </Metadata>
        <Metadata label="Último teste">
          {formatOptionalDate(account.last_validation_at)}
        </Metadata>
        <Metadata label="Modelos encontrados">
          {currentModelCount.toLocaleString("pt-PT")}
          {transientFailure && currentModelCount > 0
            ? " (catálogo preservado; conta indisponível)"
            : account.models.some((model) => model.is_stale)
              ? ` (${account.models.length.toLocaleString("pt-PT")} no último catálogo)`
              : ""}
        </Metadata>
        {lastCatalogAt && (
          <Metadata label="Último catálogo válido" wide>
            {formatDate(lastCatalogAt)}
          </Metadata>
        )}
      </dl>

      {validationGuidance && (
        <div
          role="status"
          className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950"
        >
          <p>{validationGuidance.message}</p>
          <p className="mt-1 font-semibold">{validationGuidance.action}</p>
        </div>
      )}

      {account.provider !== "github_copilot" && (
        <p className="mt-4 rounded-lg bg-slate-100 p-3 text-sm text-slate-700">
          A validação real deste fornecedor ainda não está disponível; esta
          conta não é ativada automaticamente.
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-200 pt-4">
        {account.provider === "github_copilot" && (
          <button
            type="button"
            onClick={onValidate}
            disabled={busy}
            aria-live="polite"
            className={PRIMARY_BUTTON_CLASS}
          >
            {validating ? "A validar…" : "Validar novamente"}
          </button>
        )}
        <ActionButton
          active={action === "edit"}
          disabled={busy}
          controls={`llm-account-${account.id}-edit`}
          onClick={() => onAction("edit")}
        >
          Editar
        </ActionButton>
        {isManuallyManagedLlmCredentialType(account.credential_type) && (
          <ActionButton
            active={action === "credential"}
            disabled={busy}
            controls={`llm-account-${account.id}-credential`}
            onClick={() => onAction("credential")}
          >
            Substituir credencial
          </ActionButton>
        )}
        <button
          type="button"
          aria-expanded={action === "delete"}
          aria-controls={`llm-account-${account.id}-delete`}
          disabled={busy}
          onClick={() => onAction("delete")}
          className={DANGER_BUTTON_CLASS}
        >
          Eliminar
        </button>
      </div>
    </>
  );
}

function CreateAccountForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (account: LlmAccountPublic) => Promise<void>;
}) {
  const formId = useId();
  const [provider, setProvider] = useState<LlmProvider>("github_copilot");
  const [displayName, setDisplayName] = useState("");
  const [credential, setCredential] = useState("");
  const [customEndpoint, setCustomEndpoint] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    const credentialError = getLlmCredentialError(provider, credential);

    if (credentialError) {
      setFeedback({ kind: "error", message: credentialError });
      return;
    }

    setPending(true);
    const result = await requestJson<{ account: LlmAccountPublic }>(
      "/api/admin/llm-accounts",
      {
        method: "POST",
        body: JSON.stringify({
          provider,
          displayName,
          credential,
          customEndpoint:
            provider === "openai_compatible" ? customEndpoint : null,
        }),
      }
    );
    setPending(false);

    if (!result.ok) {
      setFeedback({
        kind: "error",
        message: result.error,
        action: result.action,
      });
      return;
    }

    setCredential("");
    await onCreated(result.data.account);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <h3 className="text-lg font-bold text-slate-950">
          Adicionar conta LLM
        </h3>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          A credencial é cifrada no servidor e nunca volta a ser devolvida ao
          browser.
        </p>
      </div>
      <FormField label="Fornecedor" htmlFor={`${formId}-provider`}>
        <select
          id={`${formId}-provider`}
          value={provider}
          onChange={(event) => {
            setProvider(event.target.value as LlmProvider);
            setCustomEndpoint("");
          }}
          className={INPUT_CLASS}
        >
          {LLM_PROVIDERS.map((value) => (
            <option
              key={value}
              value={value}
              disabled={value !== "github_copilot"}
            >
              {PROVIDER_DETAILS[value].label}
              {value !== "github_copilot"
                ? " — validação ainda indisponível"
                : ""}
            </option>
          ))}
        </select>
      </FormField>
      <FormField label="Nome da conta" htmlFor={`${formId}-name`}>
        <input
          id={`${formId}-name`}
          required
          autoFocus
          maxLength={LLM_ACCOUNT_NAME_MAX_LENGTH}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          className={INPUT_CLASS}
          placeholder="Ex.: GitHub Copilot pessoal"
        />
      </FormField>
      <FormField
        label={PROVIDER_DETAILS[provider].credentialLabel}
        htmlFor={`${formId}-credential`}
      >
        <input
          id={`${formId}-credential`}
          type="password"
          required
          minLength={8}
          maxLength={LLM_CREDENTIAL_MAX_LENGTH}
          autoComplete="new-password"
          spellCheck={false}
          value={credential}
          onChange={(event) => setCredential(event.target.value)}
          className={INPUT_CLASS}
        />
      </FormField>
      {provider === "github_copilot" && (
        <p className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm leading-6 text-blue-950">
          Use um fine-grained PAT <code>github_pat_</code>, criado na sua conta
          pessoal com a Account permission <strong>Copilot Requests</strong>.
          Não use a password, um token Vercel, um token GitHub Models nem um
          token classic <code>ghp_</code>. Antes de guardar, o worker isolado
          confirma a identidade, o entitlement/política aplicável e os modelos
          realmente acessíveis. OAuth continuará preferível numa versão web
          multiutilizador.
        </p>
      )}
      {provider === "openai_compatible" && (
        <FormField label="Endpoint HTTPS" htmlFor={`${formId}-endpoint`}>
          <input
            id={`${formId}-endpoint`}
            type="url"
            inputMode="url"
            required
            maxLength={LLM_CUSTOM_ENDPOINT_MAX_LENGTH}
            value={customEndpoint}
            onChange={(event) => setCustomEndpoint(event.target.value)}
            className={INPUT_CLASS}
            placeholder="https://api.exemplo.com/v1"
          />
        </FormField>
      )}
      <p className="text-xs leading-5 text-slate-500">
        Para GitHub Copilot, a conta só será guardada depois de autenticação
        real e descoberta de modelos. Outros fornecedores ainda não podem ser
        validados nem adicionados nesta entrega.
      </p>
      <FeedbackMessage feedback={feedback} />
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className={SECONDARY_BUTTON_CLASS}
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={pending}
          className={PRIMARY_BUTTON_CLASS}
        >
          {pending ? "A validar…" : "Validar e guardar"}
        </button>
      </div>
    </form>
  );
}

function EditAccountForm({
  account,
  onCancel,
  onSaved,
}: {
  account: LlmAccountPublic;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const formId = useId();
  const [displayName, setDisplayName] = useState(account.display_name);
  const [customEndpoint, setCustomEndpoint] = useState(
    account.custom_endpoint ?? ""
  );
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    setPending(true);
    const result = await requestJson<{ account: LlmAccountPublic }>(
      `/api/admin/llm-accounts/${account.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          displayName,
          customEndpoint:
            account.provider === "openai_compatible" ? customEndpoint : null,
        }),
      }
    );
    setPending(false);

    if (!result.ok) {
      setFeedback({ kind: "error", message: result.error });
      return;
    }

    await onSaved();
  }

  return (
    <form
      id={`llm-account-${account.id}-edit`}
      onSubmit={handleSubmit}
      className="mt-5 space-y-4 border-t border-slate-200 pt-5"
    >
      <h5 className="font-bold text-slate-900">Editar metadados</h5>
      <FormField label="Nome da conta" htmlFor={`${formId}-name`}>
        <input
          id={`${formId}-name`}
          required
          autoFocus
          maxLength={LLM_ACCOUNT_NAME_MAX_LENGTH}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          className={INPUT_CLASS}
        />
      </FormField>
      {account.provider === "openai_compatible" && (
        <FormField label="Endpoint HTTPS" htmlFor={`${formId}-endpoint`}>
          <input
            id={`${formId}-endpoint`}
            type="url"
            required
            inputMode="url"
            maxLength={LLM_CUSTOM_ENDPOINT_MAX_LENGTH}
            value={customEndpoint}
            onChange={(event) => setCustomEndpoint(event.target.value)}
            className={INPUT_CLASS}
          />
        </FormField>
      )}
      <FeedbackMessage feedback={feedback} />
      <FormActions
        pending={pending}
        onCancel={onCancel}
        submitLabel="Guardar alterações"
      />
    </form>
  );
}

function ReplaceCredentialForm({
  account,
  onCancel,
  onSaved,
}: {
  account: LlmAccountPublic;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const inputId = useId();
  const [credential, setCredential] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    const credentialError = getLlmCredentialError(account.provider, credential);

    if (credentialError) {
      setFeedback({ kind: "error", message: credentialError });
      return;
    }

    setPending(true);
    const result = await requestJson<{ account: LlmAccountPublic }>(
      `/api/admin/llm-accounts/${account.id}/credential`,
      {
        method: "PUT",
        body: JSON.stringify({ credential }),
      }
    );
    setPending(false);

    if (!result.ok) {
      setFeedback({ kind: "error", message: result.error });
      return;
    }

    setCredential("");
    await onSaved();
  }

  return (
    <form
      id={`llm-account-${account.id}-credential`}
      onSubmit={handleSubmit}
      className="mt-5 space-y-4 border-t border-slate-200 pt-5"
    >
      <div>
        <h5 className="font-bold text-slate-900">Substituir credencial</h5>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          A credencial guardada ({account.credential_hint}) não pode ser
          consultada. Introduza uma nova para a substituir definitivamente.
        </p>
      </div>
      <FormField label="Nova credencial" htmlFor={inputId}>
        <input
          id={inputId}
          type="password"
          required
          autoFocus
          minLength={8}
          maxLength={LLM_CREDENTIAL_MAX_LENGTH}
          autoComplete="new-password"
          spellCheck={false}
          value={credential}
          onChange={(event) => setCredential(event.target.value)}
          className={INPUT_CLASS}
        />
      </FormField>
      {account.provider === "github_copilot" && (
        <p className="text-xs leading-5 text-slate-500">
          Introduza apenas um novo fine-grained PAT <code>github_pat_</code>.
          Tokens classic, OAuth e GitHub App não são aceites neste formulário.
        </p>
      )}
      <FeedbackMessage feedback={feedback} />
      <FormActions
        pending={pending}
        onCancel={onCancel}
        submitLabel="Substituir credencial"
      />
    </form>
  );
}

function DeleteAccountConfirmation({
  account,
  onCancel,
  onDeleted,
}: {
  account: LlmAccountPublic;
  onCancel: () => void;
  onDeleted: () => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function deleteAccount() {
    setPending(true);
    setError(null);
    const result = await requestJson<{ success: true }>(
      `/api/admin/llm-accounts/${account.id}`,
      {
        method: "DELETE",
        body: JSON.stringify({ confirmationName: confirmation }),
      }
    );
    setPending(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    await onDeleted();
  }

  return (
    <div
      id={`llm-account-${account.id}-delete`}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={`llm-account-${account.id}-delete-title`}
      className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4"
    >
      <h5
        id={`llm-account-${account.id}-delete-title`}
        className="font-bold text-red-950"
      >
        Confirmar eliminação definitiva
      </h5>
      <p className="mt-2 text-sm leading-6 text-red-900">
        A conta e a credencial cifrada serão eliminadas. Escreva exatamente{" "}
        <strong>{account.display_name}</strong> para confirmar.
      </p>
      <label className="mt-4 block text-sm font-bold text-red-950">
        Nome da conta
        <input
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          className={`${INPUT_CLASS} mt-1 border-red-300`}
          autoFocus
        />
      </label>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-900">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className={SECONDARY_BUTTON_CLASS}
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={() => void deleteAccount()}
          disabled={pending || confirmation !== account.display_name}
          className={DANGER_FILLED_BUTTON_CLASS}
        >
          {pending ? "A eliminar..." : "Eliminar para sempre"}
        </button>
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-4">
      <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p className="mt-2 text-2xl font-black text-slate-950">{value}</p>
    </div>
  );
}

function ModelCatalogSection({
  accounts,
  defaultPendingId,
  onSelectDefault,
}: {
  accounts: LlmAccountPublic[];
  defaultPendingId: string | null;
  onSelectDefault: (modelId: string) => void;
}) {
  const catalogAccounts = accounts.filter(
    (account) => account.models.length > 0
  );
  const availableCount = catalogAccounts.reduce(
    (total, account) =>
      total +
      (account.status === "active"
        ? account.models.filter((model) => !model.is_stale).length
        : 0),
    0
  );

  return (
    <section
      className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5"
      aria-labelledby="llm-model-catalog-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3
            id="llm-model-catalog-heading"
            className="font-bold text-slate-950"
          >
            Modelos disponíveis
          </h3>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
            Cada opção identifica o fornecedor e a conta. Uma única combinação
            ativa e atual pode ser a predefinição global.
          </p>
        </div>
        <span
          role="status"
          aria-live="polite"
          className="inline-flex min-h-8 items-center rounded-full bg-teal-100 px-3 text-xs font-bold text-teal-900"
        >
          {availableCount.toLocaleString("pt-PT")} disponíveis
        </span>
      </div>

      {catalogAccounts.length === 0 ? (
        <p className="mt-4 rounded-lg bg-slate-50 p-4 text-sm text-slate-600">
          Valide uma conta GitHub Copilot para descobrir os modelos disponíveis.
        </p>
      ) : (
        <div className="mt-5 space-y-5">
          {catalogAccounts.map((account) => (
            <section
              key={account.id}
              aria-labelledby={`llm-model-account-${account.id}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4
                  id={`llm-model-account-${account.id}`}
                  className="text-sm font-bold text-slate-900"
                >
                  {PROVIDER_DETAILS[account.provider].label} ·{" "}
                  {account.display_name}
                </h4>
                <span className="text-xs font-semibold text-slate-500">
                  {account.models.length.toLocaleString("pt-PT")} no catálogo
                </span>
              </div>
              <ul className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {account.models.map((model) => {
                  const maxPromptTokens = modelCapabilityNumber(
                    model.capabilities,
                    "maxPromptTokens"
                  );
                  const maxContextTokens = modelCapabilityNumber(
                    model.capabilities,
                    "maxContextWindowTokens"
                  );

                  return (
                    <li
                      key={model.id}
                      className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 p-3"
                    >
                      <p className="break-words text-sm font-bold text-slate-950">
                        {model.display_name}
                      </p>
                      <p className="mt-1 break-all font-mono text-xs text-slate-500">
                        {model.provider_model_id}
                      </p>
                      <p className="mt-2 text-xs font-semibold text-slate-700">
                        Fornecedor: {PROVIDER_DETAILS[account.provider].label}
                        {" · "}Conta: {account.display_name}
                      </p>
                      {(maxPromptTokens || maxContextTokens) && (
                        <p className="mt-2 text-xs leading-5 text-slate-600">
                          {maxPromptTokens &&
                            `Prompt: ${formatTokenLimit(maxPromptTokens)}`}
                          {maxPromptTokens && maxContextTokens ? " · " : ""}
                          {maxContextTokens &&
                            `Contexto: ${formatTokenLimit(maxContextTokens)}`}
                        </p>
                      )}
                      <p className="mt-2 text-xs font-semibold text-slate-600">
                        {modelCatalogStatus(account, model)}
                      </p>
                      <button
                        type="button"
                        aria-pressed={model.is_default}
                        disabled={
                          defaultPendingId !== null ||
                          account.status !== "active" ||
                          model.is_stale ||
                          model.is_default
                        }
                        onClick={() => onSelectDefault(model.id)}
                        className={`mt-3 min-h-10 w-full rounded-lg px-3 text-xs font-bold transition ${
                          model.is_default
                            ? "bg-teal-700 text-white"
                            : "border border-slate-300 bg-white text-slate-800 hover:border-teal-500 disabled:cursor-not-allowed disabled:opacity-55"
                        }`}
                      >
                        {model.is_default
                          ? "★ Predefinido"
                          : defaultPendingId === model.id
                            ? "A guardar…"
                            : "Definir como predefinido"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

function UsageAvailabilitySection({
  accounts,
}: {
  accounts: LlmAccountPublic[];
}) {
  return (
    <section
      className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5"
      aria-labelledby="llm-provider-usage-heading"
    >
      <h3 id="llm-provider-usage-heading" className="font-bold text-slate-950">
        Utilização do GitHub Copilot
      </h3>
      <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
        Métrica experimental account-wide{" "}
        <code className="font-mono text-xs">premium_interactions</code>.
        Conforme o plano, o GitHub pode apresentá-la como créditos de IA ou
        pedidos premium; a API tipada atual não identifica a unidade. Os valores
        são unidades do fornecedor, não tokens de prompt/contexto nem utilização
        de sessões desta aplicação.
      </p>

      {accounts.length === 0 ? (
        <p className="mt-4 rounded-lg bg-slate-50 p-4 text-sm text-slate-600">
          Adicione uma conta para consultar a utilização disponibilizada pelo
          fornecedor.
        </p>
      ) : (
        <ul className="mt-5 grid gap-3 lg:grid-cols-2">
          {accounts.map((account) => (
            <li
              key={account.id}
              className="rounded-lg border border-slate-200 bg-slate-50 p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-bold text-slate-950">
                    {account.display_name}
                  </p>
                  <p className="mt-1 text-xs text-slate-600">
                    {PROVIDER_DETAILS[account.provider].label}
                  </p>
                </div>
                <QuotaStatusBadge account={account} />
              </div>
              <QuotaDetails account={account} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function QuotaStatusBadge({ account }: { account: LlmAccountPublic }) {
  const quota = account.quota;
  const label =
    account.provider !== "github_copilot"
      ? "Não suportado"
      : quota?.status === "available"
        ? "Atualizado"
        : quota?.status === "stale"
          ? "Desatualizado"
          : "Não disponível";

  return (
    <span className="inline-flex rounded-full bg-slate-200 px-2 py-1 text-xs font-bold text-slate-700">
      {label}
    </span>
  );
}

function QuotaDetails({ account }: { account: LlmAccountPublic }) {
  if (account.provider !== "github_copilot") {
    return (
      <p className="mt-4 text-sm leading-6 text-slate-600">
        Este fornecedor não declara a capacidade{" "}
        <code className="font-mono text-xs">premium_interactions</code>; não é
        feita qualquer equivalência artificial.
      </p>
    );
  }

  const quota = account.quota;

  if (!quota || quota.status === "unavailable") {
    return (
      <p className="mt-4 text-sm leading-6 text-slate-600">
        Não disponível. A falha desta métrica não altera a validade da conta nem
        o catálogo de modelos.
      </p>
    );
  }

  return (
    <>
      {quota.status === "stale" && (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          Último valor conhecido; a atualização mais recente da quota falhou.
        </p>
      )}
      <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
        <Metadata label="Unidades utilizadas">
          {formatOptionalCount(quota.used_units)}
        </Metadata>
        <Metadata label="Unidades incluídas">
          {quota.is_unlimited
            ? "Ilimitados"
            : formatOptionalCount(quota.included_units)}
        </Metadata>
        <Metadata label="Unidades restantes">
          {quota.is_unlimited
            ? "Ilimitados"
            : formatOptionalCount(quota.remaining_units)}
        </Metadata>
        <Metadata label="Percentagem restante">
          {quota.is_unlimited || quota.remaining_percentage === null
            ? "Não aplicável"
            : `${quota.remaining_percentage.toLocaleString("pt-PT", {
                maximumFractionDigits: 2,
              })}%`}
        </Metadata>
        <Metadata label="Unidades adicionais">
          {formatOptionalCount(quota.overage_units)}
        </Metadata>
        {quota.reset_at !== null && (
          <Metadata label="Próxima reposição">
            {formatOptionalDate(quota.reset_at)}
          </Metadata>
        )}
        <Metadata label="Última observação" wide>
          {formatOptionalDate(quota.observed_at)}
        </Metadata>
      </dl>
    </>
  );
}

function formatOptionalCount(value: number | null) {
  return value === null
    ? "Não disponível"
    : value.toLocaleString("pt-PT", { maximumFractionDigits: 6 });
}

function modelCapabilityNumber(
  capabilities: LlmAccountPublic["models"][number]["capabilities"],
  key: "maxPromptTokens" | "maxContextWindowTokens"
) {
  if (
    typeof capabilities !== "object" ||
    capabilities === null ||
    Array.isArray(capabilities)
  ) {
    return null;
  }

  const value = capabilities[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function formatTokenLimit(value: number) {
  return `${value.toLocaleString("pt-PT")} tokens`;
}

function modelCatalogStatus(
  account: LlmAccountPublic,
  model: LlmAccountPublic["models"][number]
) {
  if (model.is_stale) {
    return "Catálogo anterior";
  }

  if (account.status !== "active") {
    return "Preservado · conta indisponível";
  }

  return model.is_default ? "Disponível · Predefinido" : "Disponível";
}

function Metadata({
  label,
  wide = false,
  children,
}: {
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <dt className="font-bold text-slate-500">{label}</dt>
      <dd className="mt-1 text-slate-800">{children}</dd>
    </div>
  );
}

function FormField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-bold text-slate-700">
      {label}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

function FormActions({
  pending,
  onCancel,
  submitLabel,
}: {
  pending: boolean;
  onCancel: () => void;
  submitLabel: string;
}) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <button
        type="button"
        onClick={onCancel}
        disabled={pending}
        className={SECONDARY_BUTTON_CLASS}
      >
        Cancelar
      </button>
      <button type="submit" disabled={pending} className={PRIMARY_BUTTON_CLASS}>
        {pending ? "A guardar..." : submitLabel}
      </button>
    </div>
  );
}

function ActionButton({
  active,
  disabled,
  controls,
  onClick,
  children,
}: {
  active: boolean;
  disabled: boolean;
  controls: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={active}
      aria-controls={controls}
      disabled={disabled}
      onClick={onClick}
      className={active ? PRIMARY_BUTTON_CLASS : SECONDARY_BUTTON_CLASS}
    >
      {children}
    </button>
  );
}

function StatusBadge({
  status,
  validating,
}: {
  status: LlmAccountStatus;
  validating: boolean;
}) {
  const styles: Record<LlmAccountStatus, string> = {
    pending_validation: "bg-amber-100 text-amber-900",
    active: "bg-emerald-100 text-emerald-900",
    invalid: "bg-red-100 text-red-900",
    error: "bg-red-100 text-red-900",
    inactive: "bg-slate-200 text-slate-700",
  };

  return (
    <span
      role="status"
      aria-live="polite"
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-bold ${styles[status]}`}
    >
      {validating ? "A validar…" : STATUS_LABELS[status]}
    </span>
  );
}

function FeedbackMessage({ feedback }: { feedback: Feedback }) {
  if (!feedback) {
    return null;
  }

  return (
    <div
      role={feedback.kind === "error" ? "alert" : "status"}
      className={`mt-4 rounded-lg px-3 py-2 text-sm ${
        feedback.kind === "error"
          ? "bg-red-50 text-red-800"
          : "bg-emerald-50 text-emerald-800"
      }`}
    >
      <p>{feedback.message}</p>
      {feedback.action && (
        <p className="mt-1 font-semibold">{feedback.action}</p>
      )}
    </div>
  );
}

function SectionTitle({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div>
      <h2 className="text-xl font-bold tracking-tight text-slate-950">
        {title}
      </h2>
      <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
        {description}
      </p>
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("pt-PT", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatOptionalDate(value: string | null) {
  return value ? formatDate(value) : "Nunca";
}

type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string; action?: string };

async function requestJson<T>(
  url: string,
  init?: RequestInit
): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      headers: init?.body
        ? { "Content-Type": "application/json", ...init.headers }
        : init?.headers,
    });
    const data: unknown = await response.json();

    if (!response.ok) {
      return {
        ok: false,
        error:
          typeof data === "object" &&
          data !== null &&
          "error" in data &&
          typeof data.error === "string"
            ? data.error
            : "Não foi possível concluir a operação.",
        code:
          typeof data === "object" &&
          data !== null &&
          "code" in data &&
          typeof data.code === "string"
            ? data.code
            : undefined,
        action:
          typeof data === "object" &&
          data !== null &&
          "action" in data &&
          typeof data.action === "string"
            ? data.action
            : undefined,
      };
    }

    return { ok: true, data: data as T };
  } catch {
    return {
      ok: false,
      error: "Não foi possível contactar o servidor. Tente novamente.",
    };
  }
}

function validateAccountRequest(accountId: string, signal?: AbortSignal) {
  return accountValidationRequests.run(accountId, () =>
    requestJson<{ account: LlmAccountPublic }>(
      `/api/admin/llm-accounts/${accountId}/validate`,
      { method: "POST", signal }
    )
  );
}

function replaceAccount(
  accounts: LlmAccountPublic[],
  replacement: LlmAccountPublic
) {
  return accounts.map((account) =>
    account.id === replacement.id ? replacement : account
  );
}

function withSetValue(values: Set<string>, value: string) {
  const next = new Set(values);
  next.add(value);
  return next;
}

function withoutSetValue(values: Set<string>, value: string) {
  const next = new Set(values);
  next.delete(value);
  return next;
}

const INPUT_CLASS =
  "min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-950 shadow-sm outline-none placeholder:text-slate-400 focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20";
const PRIMARY_BUTTON_CLASS =
  "min-h-11 rounded-lg bg-teal-700 px-4 text-sm font-bold text-white transition-colors duration-150 hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";
const SECONDARY_BUTTON_CLASS =
  "min-h-11 rounded-lg border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";
const DANGER_BUTTON_CLASS =
  "min-h-11 rounded-lg border border-red-200 bg-white px-4 text-sm font-bold text-red-700 transition-colors duration-150 hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";
const DANGER_FILLED_BUTTON_CLASS =
  "min-h-11 rounded-lg bg-red-700 px-4 text-sm font-bold text-white hover:bg-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 disabled:cursor-not-allowed disabled:opacity-45";
