"use client";

import { useId, useState, type FormEvent } from "react";
import {
  LLM_ACCOUNT_NAME_MAX_LENGTH,
  LLM_CREDENTIAL_MAX_LENGTH,
  LLM_CUSTOM_ENDPOINT_MAX_LENGTH,
  LLM_PROVIDERS,
  getLlmCredentialError,
  isManuallyManagedLlmCredentialType,
} from "@/src/admin/llm-validation";
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
  inactive: "Inativa",
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

type Feedback = { kind: "success" | "error"; message: string } | null;

export function LlmPanel({
  initialAccounts,
}: {
  initialAccounts: LlmAccountPublic[];
}) {
  const [accounts, setAccounts] = useState(initialAccounts);
  const [creating, setCreating] = useState(false);
  const [action, setAction] = useState<AccountAction>(null);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

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

  const pendingCount = accounts.filter(
    (account) => account.status === "pending_validation"
  ).length;

  return (
    <div className="min-w-0">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <SectionTitle
          title="Contas de fornecedores LLM"
          description="Guarde ligações individuais aos fornecedores que pretende usar. Nesta fase são apenas configuradas e ficam indisponíveis para execução."
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

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <SummaryCard
          label="Contas configuradas"
          value={accounts.length.toLocaleString("pt-PT")}
        />
        <SummaryCard
          label="Por validar"
          value={pendingCount.toLocaleString("pt-PT")}
        />
        <SummaryCard label="Disponíveis para execução" value="0" />
      </div>

      <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
        <strong>Nenhuma conta está ativa.</strong> Não são feitas chamadas aos
        fornecedores nem validação de credenciais, descoberta de modelos ou
        geração LLM nesta fase.
      </div>

      <FeedbackMessage feedback={feedback} />

      {creating && (
        <div className="mt-6 rounded-xl border border-teal-200 bg-teal-50/40 p-4 sm:p-6">
          <CreateAccountForm
            onCancel={() => setCreating(false)}
            onCreated={async () => {
              setCreating(false);
              if (await loadAccounts()) {
                setFeedback({
                  kind: "success",
                  message:
                    "Conta guardada como “Por validar”. A credencial não voltará a ser mostrada.",
                });
              }
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
              Adicione uma conta por fine-grained PAT ou API key. Pode
              configurar várias contas do mesmo fornecedor, desde que tenham
              nomes diferentes.
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
                  className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"
                >
                  <AccountCard
                    account={account}
                    action={currentAction}
                    busy={loading}
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

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <FutureSection
          title="Modelos e encaminhamento"
          description="A descoberta automática de modelos, autorização manual, modelo geral, regras por funcionalidade e fallbacks ordenados ficarão disponíveis quando a validação dos fornecedores for integrada."
        />
        <FutureSection
          title="Utilização"
          description="Tokens de entrada e saída, latência, estado e custo estimado serão apresentados após existir execução LLM. Prompts e respostas não farão parte desta telemetria."
        />
      </div>
    </div>
  );
}

function AccountCard({
  account,
  action,
  busy,
  onAction,
}: {
  account: LlmAccountPublic;
  action: AccountActionType | null;
  busy: boolean;
  onAction: (action: AccountActionType) => void;
}) {
  const provider = PROVIDER_DETAILS[account.provider];

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
          <StatusBadge status={account.status} />
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
      </dl>

      <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-200 pt-4">
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
  onCreated: () => Promise<void>;
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
      setFeedback({ kind: "error", message: result.error });
      return;
    }

    setCredential("");
    await onCreated();
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
            <option key={value} value={value}>
              {PROVIDER_DETAILS[value].label}
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
          token classic <code>ghp_</code>. A permissão não pode ser confirmada
          localmente; a validação real será futura. OAuth será preferível numa
          versão web multiutilizador.
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
        Guardar não testa a credencial nem contacta o endpoint. A conta ficará
        sempre no estado “Por validar”.
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
          {pending ? "A guardar..." : "Guardar conta"}
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

function FutureSection({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50 p-5">
      <span className="inline-flex rounded-full bg-slate-200 px-2 py-1 text-xs font-bold text-slate-700">
        Disponível após integração
      </span>
      <h3 className="mt-3 font-bold text-slate-950">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>
    </section>
  );
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

function StatusBadge({ status }: { status: LlmAccountStatus }) {
  const styles: Record<LlmAccountStatus, string> = {
    pending_validation: "bg-amber-100 text-amber-900",
    inactive: "bg-slate-200 text-slate-700",
  };

  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-bold ${styles[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function FeedbackMessage({ feedback }: { feedback: Feedback }) {
  if (!feedback) {
    return null;
  }

  return (
    <p
      role={feedback.kind === "error" ? "alert" : "status"}
      className={`mt-4 rounded-lg px-3 py-2 text-sm ${
        feedback.kind === "error"
          ? "bg-red-50 text-red-800"
          : "bg-emerald-50 text-emerald-800"
      }`}
    >
      {feedback.message}
    </p>
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

type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

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
