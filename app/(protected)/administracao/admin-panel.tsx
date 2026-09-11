"use client";

import { useId, useState, type FormEvent, type KeyboardEvent } from "react";
import type { SkillList } from "@/src/admin/skills";
import {
  GLOBAL_ASSUMPTIONS_MAX_LENGTH,
  SKILL_CONTENT_MAX_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_NAME_MAX_LENGTH,
} from "@/src/admin/validation";
import type { Skill, SkillStatus } from "@/src/types/supabase";

const TABS = [
  { id: "llm", label: "LLM" },
  { id: "skills", label: "Skills" },
  { id: "premissas", label: "Premissas" },
  { id: "conta", label: "Conta" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const STATUS_LABELS: Record<SkillStatus, string> = {
  draft: "Rascunho",
  active: "Ativa",
  inactive: "Inativa",
  archived: "Arquivada",
};

export function AdminPanel({
  email,
  initialAssumptions,
  initialSkills,
}: {
  email: string;
  initialAssumptions: string;
  initialSkills: SkillList;
}) {
  const [activeTab, setActiveTab] = useState<TabId>("llm");

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }

    event.preventDefault();
    const current = TABS.findIndex((tab) => tab.id === activeTab);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? TABS.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) %
            TABS.length;
    const nextTab = TABS[next];

    if (nextTab) {
      setActiveTab(nextTab.id);
      document.getElementById(`admin-tab-${nextTab.id}`)?.focus();
    }
  }

  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div
        role="tablist"
        aria-label="Áreas de administração"
        className="flex overflow-x-auto border-b border-slate-200 px-2 sm:px-4"
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            id={`admin-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`admin-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={handleTabKeyDown}
            className={`min-h-12 shrink-0 border-b-2 px-4 text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-700 ${
              activeTab === tab.id
                ? "border-teal-700 text-teal-800"
                : "border-transparent text-slate-500 hover:text-slate-900"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="p-4 sm:p-6 lg:p-8">
        <div
          id="admin-panel-llm"
          role="tabpanel"
          aria-labelledby="admin-tab-llm"
          hidden={activeTab !== "llm"}
        >
          <LlmPanel />
        </div>
        <div
          id="admin-panel-skills"
          role="tabpanel"
          aria-labelledby="admin-tab-skills"
          hidden={activeTab !== "skills"}
        >
          <SkillsPanel initialSkills={initialSkills} />
        </div>
        <div
          id="admin-panel-premissas"
          role="tabpanel"
          aria-labelledby="admin-tab-premissas"
          hidden={activeTab !== "premissas"}
        >
          <AssumptionsPanel initialContent={initialAssumptions} />
        </div>
        <div
          id="admin-panel-conta"
          role="tabpanel"
          aria-labelledby="admin-tab-conta"
          hidden={activeTab !== "conta"}
        >
          <AccountPanel email={email} />
        </div>
      </div>
    </section>
  );
}

function LlmPanel() {
  return (
    <div className="max-w-4xl">
      <SectionTitle
        title="Modelos LLM"
        description="Área reservada aos modelos de linguagem que irão suportar as funcionalidades inteligentes da aplicação."
      />
      <div className="mt-6 flex min-h-64 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center">
        <div className="max-w-md">
          <div
            className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-teal-100 text-sm font-bold text-teal-800"
            aria-hidden="true"
          >
            LLM
          </div>
          <h3 className="mt-4 text-lg font-bold text-slate-900">
            Configuração disponível numa fase posterior
          </h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            A seleção e a configuração dos modelos LLM serão desenvolvidas numa
            fase posterior do projeto.
          </p>
        </div>
      </div>
    </div>
  );
}

function AccountPanel({ email }: { email: string }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);

    if (password.length < 8 || password.length > 128) {
      setFeedback({
        kind: "error",
        message: "A palavra-passe deve ter entre 8 e 128 caracteres.",
      });
      return;
    }

    if (password !== confirmation) {
      setFeedback({
        kind: "error",
        message: "As palavras-passe não coincidem.",
      });
      return;
    }

    setPending(true);
    const result = await apiRequest<{ success: true }>(
      "/api/account/password",
      {
        method: "POST",
        body: JSON.stringify({ currentPassword, password, confirmation }),
      }
    );
    setPending(false);

    if (!result.ok) {
      setFeedback({ kind: "error", message: result.error });
      return;
    }

    setCurrentPassword("");
    setPassword("");
    setConfirmation("");
    setFeedback({
      kind: "success",
      message: "Palavra-passe alterada com sucesso.",
    });
  }

  return (
    <div className="max-w-2xl">
      <SectionTitle
        title="Conta"
        description="Consulte o email da sessão e altere a palavra-passe com segurança."
      />
      <div className="mt-6 rounded-xl bg-slate-50 p-4">
        <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
          Email atual
        </p>
        <p className="mt-1 break-all text-sm font-semibold text-slate-900">
          {email}
        </p>
        <p className="mt-2 text-xs text-slate-500">
          A alteração de email não está disponível nesta fase.
        </p>
      </div>

      <form className="mt-8 space-y-5" onSubmit={handleSubmit}>
        <h3 className="text-base font-bold text-slate-900">
          Alterar palavra-passe
        </h3>
        <FormField label="Palavra-passe atual" htmlFor="current-password">
          <input
            id="current-password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={4096}
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            className={INPUT_CLASS}
          />
        </FormField>
        <FormField label="Nova palavra-passe" htmlFor="new-password">
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className={INPUT_CLASS}
          />
        </FormField>
        <FormField label="Confirmar palavra-passe" htmlFor="confirm-password">
          <input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={128}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            className={INPUT_CLASS}
          />
        </FormField>
        <FeedbackMessage feedback={feedback} />
        <PrimaryButton pending={pending}>
          {pending ? "A alterar..." : "Alterar palavra-passe"}
        </PrimaryButton>
      </form>
    </div>
  );
}

function AssumptionsPanel({ initialContent }: { initialContent: string }) {
  const [content, setContent] = useState(initialContent);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setFeedback(null);
    const result = await apiRequest<{ assumptions: { content: string } }>(
      "/api/admin/premises",
      {
        method: "PUT",
        body: JSON.stringify({ content }),
      }
    );
    setPending(false);
    setFeedback(
      result.ok
        ? { kind: "success", message: "Premissas globais guardadas." }
        : { kind: "error", message: result.error }
    );
  }

  return (
    <div className="max-w-4xl">
      <SectionTitle
        title="Premissas globais"
        description="Defina a versão atual das instruções globais. Este conteúdo será uma fonte superior de contexto para a futura integração LLM."
      />
      <form className="mt-6" onSubmit={handleSubmit}>
        <FormField label="Instruções globais" htmlFor="global-assumptions">
          <textarea
            id="global-assumptions"
            rows={16}
            maxLength={GLOBAL_ASSUMPTIONS_MAX_LENGTH}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            className={`${INPUT_CLASS} min-h-72 resize-y font-mono leading-6`}
            placeholder="Ex.: Responder sempre em português europeu e distinguir factos de inferências..."
          />
        </FormField>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-slate-500">
            {content.length.toLocaleString("pt-PT")} /{" "}
            {GLOBAL_ASSUMPTIONS_MAX_LENGTH.toLocaleString("pt-PT")} caracteres
          </p>
          <PrimaryButton pending={pending}>
            {pending ? "A guardar..." : "Guardar premissas"}
          </PrimaryButton>
        </div>
        <FeedbackMessage feedback={feedback} />
      </form>
    </div>
  );
}

type SkillMode = "view" | "edit" | "create";

function SkillsPanel({ initialSkills }: { initialSkills: SkillList }) {
  const [skills, setSkills] = useState(initialSkills);
  const [selected, setSelected] = useState<Skill | null>(
    initialSkills.items[0] ?? null
  );
  const [mode, setMode] = useState<SkillMode>("view");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SkillStatus | "all">("all");
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  async function loadSkills(page = 1) {
    setLoading(true);
    setFeedback(null);
    const params = new URLSearchParams({
      page: String(page),
      query,
      status,
    });
    const result = await apiRequest<SkillList>(
      `/api/admin/skills?${params.toString()}`
    );
    setLoading(false);

    if (!result.ok) {
      setFeedback({ kind: "error", message: result.error });
      return;
    }

    setSkills(result.data);
    setSelected((current) => {
      if (!current) {
        return result.data.items[0] ?? null;
      }

      return (
        result.data.items.find((item) => item.id === current.id) ??
        result.data.items[0] ??
        null
      );
    });
    setMode("view");
  }

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await loadSkills(1);
  }

  async function performAction(
    action: "activate" | "deactivate" | "archive" | "restore"
  ) {
    if (!selected) {
      return;
    }

    setLoading(true);
    setFeedback(null);
    const result = await apiRequest<{ skill: Skill }>(
      `/api/admin/skills/${selected.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ action }),
      }
    );
    setLoading(false);

    if (!result.ok) {
      setFeedback({ kind: "error", message: result.error });
      return;
    }

    setSelected(result.data.skill);
    setFeedback({ kind: "success", message: "Estado da Skill atualizado." });
    await loadSkills(skills.page);
  }

  async function duplicateSelected() {
    if (!selected) {
      return;
    }

    setLoading(true);
    const result = await apiRequest<{ skill: Skill }>(
      `/api/admin/skills/${selected.id}/duplicate`,
      { method: "POST" }
    );
    setLoading(false);

    if (!result.ok) {
      setFeedback({ kind: "error", message: result.error });
      return;
    }

    setSelected(result.data.skill);
    setMode("edit");
    setFeedback({ kind: "success", message: "Cópia criada como rascunho." });
    await loadSkills(1);
    setSelected(result.data.skill);
    setMode("edit");
  }

  return (
    <div className="min-w-0">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <SectionTitle
          title="Skills"
          description="Crie e mantenha instruções especializadas. Apenas as Skills ativas poderão ser carregadas pelo futuro agente."
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled
            title="Disponível após integração LLM"
            className={`${SECONDARY_BUTTON_CLASS} cursor-not-allowed opacity-50`}
          >
            Criar com IA
          </button>
          <button
            type="button"
            onClick={() => {
              setSelected(null);
              setMode("create");
              setFeedback(null);
            }}
            className={PRIMARY_BUTTON_CLASS}
          >
            Nova Skill
          </button>
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        “Criar com IA” estará disponível após a integração LLM.
      </p>

      <form
        onSubmit={handleSearch}
        className="mt-6 grid gap-3 rounded-xl bg-slate-50 p-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto]"
        role="search"
      >
        <FormField label="Pesquisar por nome" htmlFor="skill-search">
          <input
            id="skill-search"
            type="search"
            maxLength={100}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className={INPUT_CLASS}
            placeholder="Nome da Skill"
          />
        </FormField>
        <FormField label="Estado" htmlFor="skill-status">
          <select
            id="skill-status"
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as SkillStatus | "all")
            }
            className={INPUT_CLASS}
          >
            <option value="all">Todos</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </FormField>
        <button
          type="submit"
          disabled={loading}
          className={`${SECONDARY_BUTTON_CLASS} self-end`}
        >
          Pesquisar
        </button>
      </form>

      <FeedbackMessage feedback={feedback} />

      <div className="mt-6 grid min-w-0 gap-6 xl:grid-cols-[20rem_minmax(0,1fr)]">
        <div className="min-w-0">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900">
              {skills.total} {skills.total === 1 ? "Skill" : "Skills"}
            </h3>
            {loading && (
              <span className="text-xs text-slate-500" role="status">
                A atualizar...
              </span>
            )}
          </div>
          {skills.items.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
              Nenhuma Skill encontrada.
            </div>
          ) : (
            <ul className="space-y-2" aria-label="Lista de Skills">
              {skills.items.map((skill) => (
                <li key={skill.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(skill);
                      setMode("view");
                      setFeedback(null);
                      setDeleteOpen(false);
                    }}
                    className={`min-h-16 w-full rounded-xl border p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 ${
                      selected?.id === skill.id
                        ? "border-teal-300 bg-teal-50"
                        : "border-slate-200 bg-white hover:border-slate-300"
                    }`}
                  >
                    <span className="block truncate text-sm font-bold text-slate-900">
                      {skill.name}
                    </span>
                    <span className="mt-1 flex items-center justify-between gap-2 text-xs text-slate-500">
                      <StatusBadge status={skill.status} />
                      <span>{formatDate(skill.updated_at)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              disabled={skills.page <= 1 || loading}
              onClick={() => loadSkills(skills.page - 1)}
              className={PAGINATION_BUTTON_CLASS}
            >
              Anterior
            </button>
            <span className="text-xs text-slate-500">
              {skills.page} / {skills.totalPages}
            </span>
            <button
              type="button"
              disabled={skills.page >= skills.totalPages || loading}
              onClick={() => loadSkills(skills.page + 1)}
              className={PAGINATION_BUTTON_CLASS}
            >
              Seguinte
            </button>
          </div>
        </div>

        <div className="min-w-0 rounded-xl border border-slate-200 p-4 sm:p-6">
          {mode === "create" ? (
            <SkillEditor
              mode="create"
              onCancel={() => {
                setMode("view");
                setSelected(skills.items[0] ?? null);
              }}
              onSaved={async (skill) => {
                await loadSkills(1);
                setSelected(skill);
                setMode("view");
                setFeedback({
                  kind: "success",
                  message: "Skill criada com sucesso.",
                });
              }}
            />
          ) : selected ? (
            mode === "edit" ? (
              <SkillEditor
                mode="edit"
                skill={selected}
                onCancel={() => setMode("view")}
                onSaved={async (skill) => {
                  setSelected(skill);
                  setMode("view");
                  setFeedback({
                    kind: "success",
                    message: "Skill guardada.",
                  });
                  await loadSkills(skills.page);
                  setSelected(skill);
                }}
              />
            ) : (
              <SkillDetail
                skill={selected}
                busy={loading}
                deleteOpen={deleteOpen}
                onEdit={() => setMode("edit")}
                onDuplicate={duplicateSelected}
                onAction={performAction}
                onDeleteOpen={() => setDeleteOpen(true)}
                onDeleteClose={() => setDeleteOpen(false)}
                onDeleted={async () => {
                  setDeleteOpen(false);
                  setSelected(null);
                  await loadSkills(1);
                  setFeedback({
                    kind: "success",
                    message: "Skill eliminada definitivamente.",
                  });
                }}
              />
            )
          ) : (
            <div className="flex min-h-64 items-center justify-center text-center text-sm text-slate-500">
              Selecione uma Skill ou crie uma nova.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SkillEditor({
  mode,
  skill,
  onCancel,
  onSaved,
}: {
  mode: "create" | "edit";
  skill?: Skill;
  onCancel: () => void;
  onSaved: (skill: Skill) => Promise<void>;
}) {
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [content, setContent] = useState(skill?.content_markdown ?? "");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const formId = useId();

  async function save(status?: "draft" | "active") {
    if (!name.trim()) {
      setFeedback({ kind: "error", message: "Indique um nome para a Skill." });
      return;
    }

    setPending(true);
    setFeedback(null);
    const result =
      mode === "create"
        ? await apiRequest<{ skill: Skill }>("/api/admin/skills", {
            method: "POST",
            body: JSON.stringify({
              name,
              description,
              content_markdown: content,
              status: status ?? "draft",
            }),
          })
        : await apiRequest<{ skill: Skill }>(`/api/admin/skills/${skill?.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              action: "update",
              name,
              description,
              content_markdown: content,
            }),
          });
    setPending(false);

    if (!result.ok) {
      setFeedback({ kind: "error", message: result.error });
      return;
    }

    await onSaved(result.data.skill);
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="space-y-5"
    >
      <h3 className="text-lg font-bold text-slate-950">
        {mode === "create" ? "Nova Skill" : "Editar Skill"}
      </h3>
      <FormField label="Nome" htmlFor={`${formId}-name`}>
        <input
          id={`${formId}-name`}
          required
          maxLength={SKILL_NAME_MAX_LENGTH}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={INPUT_CLASS}
        />
      </FormField>
      <FormField label="Descrição" htmlFor={`${formId}-description`}>
        <textarea
          id={`${formId}-description`}
          rows={3}
          maxLength={SKILL_DESCRIPTION_MAX_LENGTH}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className={`${INPUT_CLASS} resize-y`}
        />
      </FormField>
      <FormField label="Conteúdo Markdown" htmlFor={`${formId}-content`}>
        <textarea
          id={`${formId}-content`}
          rows={18}
          maxLength={SKILL_CONTENT_MAX_LENGTH}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          className={`${INPUT_CLASS} min-h-80 resize-y font-mono leading-6`}
          placeholder="# Objetivo&#10;&#10;Descreva as instruções da Skill..."
        />
      </FormField>
      <p className="text-right text-xs text-slate-500">
        {content.length.toLocaleString("pt-PT")} /{" "}
        {SKILL_CONTENT_MAX_LENGTH.toLocaleString("pt-PT")}
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
        {mode === "create" && (
          <button
            type="button"
            onClick={() => void save("active")}
            disabled={pending}
            className={SECONDARY_BUTTON_CLASS}
          >
            Guardar e ativar
          </button>
        )}
        <button
          type="submit"
          disabled={pending}
          className={PRIMARY_BUTTON_CLASS}
        >
          {pending
            ? "A guardar..."
            : mode === "create"
              ? "Guardar rascunho"
              : "Guardar alterações"}
        </button>
      </div>
    </form>
  );
}

function SkillDetail({
  skill,
  busy,
  deleteOpen,
  onEdit,
  onDuplicate,
  onAction,
  onDeleteOpen,
  onDeleteClose,
  onDeleted,
}: {
  skill: Skill;
  busy: boolean;
  deleteOpen: boolean;
  onEdit: () => void;
  onDuplicate: () => Promise<void>;
  onAction: (
    action: "activate" | "deactivate" | "archive" | "restore"
  ) => Promise<void>;
  onDeleteOpen: () => void;
  onDeleteClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function deleteSkill() {
    setDeletePending(true);
    setDeleteError(null);
    const result = await apiRequest<{ success: true }>(
      `/api/admin/skills/${skill.id}`,
      {
        method: "DELETE",
        body: JSON.stringify({ confirmationName: confirmation }),
      }
    );
    setDeletePending(false);

    if (!result.ok) {
      setDeleteError(result.error);
      return;
    }

    await onDeleted();
  }

  return (
    <div className="min-w-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <StatusBadge status={skill.status} />
          <h3 className="mt-2 break-words text-xl font-bold text-slate-950">
            {skill.name}
          </h3>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-600">
            {skill.description || "Sem descrição."}
          </p>
        </div>
        <button
          type="button"
          onClick={onEdit}
          disabled={busy}
          className={SECONDARY_BUTTON_CLASS}
        >
          Editar
        </button>
      </div>
      <dl className="mt-5 grid gap-3 rounded-xl bg-slate-50 p-4 text-xs sm:grid-cols-2">
        <div>
          <dt className="font-bold text-slate-500">Criada</dt>
          <dd className="mt-1 text-slate-700">
            {formatDate(skill.created_at)}
          </dd>
        </div>
        <div>
          <dt className="font-bold text-slate-500">Atualizada</dt>
          <dd className="mt-1 text-slate-700">
            {formatDate(skill.updated_at)}
          </dd>
        </div>
      </dl>
      <section className="mt-6" aria-labelledby="skill-preview-heading">
        <h4
          id="skill-preview-heading"
          className="text-sm font-bold text-slate-900"
        >
          Pré-visualização segura
        </h4>
        <pre className="mt-2 max-h-[32rem] min-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-slate-950 p-4 font-mono text-xs leading-6 text-slate-100">
          {skill.content_markdown || "Sem conteúdo Markdown."}
        </pre>
      </section>
      <div className="mt-6 flex flex-wrap gap-2 border-t border-slate-200 pt-5">
        <button
          type="button"
          onClick={() => void onDuplicate()}
          disabled={busy}
          className={SECONDARY_BUTTON_CLASS}
        >
          Duplicar
        </button>
        {skill.status !== "archived" && (
          <button
            type="button"
            onClick={() => void onAction("activate")}
            disabled={busy}
            className={PRIMARY_BUTTON_CLASS}
          >
            Ativar
          </button>
        )}
        {skill.status === "active" && (
          <button
            type="button"
            onClick={() => void onAction("deactivate")}
            disabled={busy}
            className={SECONDARY_BUTTON_CLASS}
          >
            Desativar
          </button>
        )}
        {(skill.status === "draft" || skill.status === "inactive") && (
          <button
            type="button"
            onClick={() => void onAction("archive")}
            disabled={busy}
            className={SECONDARY_BUTTON_CLASS}
          >
            Arquivar
          </button>
        )}
        {skill.status === "archived" && (
          <button
            type="button"
            onClick={() => void onAction("restore")}
            disabled={busy}
            className={SECONDARY_BUTTON_CLASS}
          >
            Restaurar
          </button>
        )}
        <button
          type="button"
          onClick={onDeleteOpen}
          disabled={busy || skill.status === "active"}
          title={
            skill.status === "active"
              ? "Desative a Skill antes de a eliminar"
              : undefined
          }
          className="min-h-11 rounded-lg border border-red-200 px-4 text-sm font-bold text-red-700 hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 disabled:cursor-not-allowed disabled:opacity-45"
        >
          Eliminar definitivamente
        </button>
      </div>
      {skill.status === "active" && (
        <p className="mt-2 text-xs text-slate-500">
          Uma Skill ativa tem de ser desativada antes de ser eliminada.
        </p>
      )}

      {deleteOpen && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="delete-skill-title"
          className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4"
        >
          <h4 id="delete-skill-title" className="font-bold text-red-900">
            Confirmar eliminação definitiva
          </h4>
          <p className="mt-2 text-sm leading-6 text-red-800">
            Esta ação não pode ser anulada. Escreva exatamente{" "}
            <strong>{skill.name}</strong> para confirmar.
          </p>
          <label className="mt-4 block text-sm font-bold text-red-900">
            Nome da Skill
            <input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              className={`${INPUT_CLASS} mt-1 border-red-300`}
              autoFocus
            />
          </label>
          {deleteError && (
            <p role="alert" className="mt-2 text-sm text-red-800">
              {deleteError}
            </p>
          )}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setConfirmation("");
                setDeleteError(null);
                onDeleteClose();
              }}
              disabled={deletePending}
              className={SECONDARY_BUTTON_CLASS}
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => void deleteSkill()}
              disabled={deletePending || confirmation !== skill.name}
              className="min-h-11 rounded-lg bg-red-700 px-4 text-sm font-bold text-white hover:bg-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {deletePending ? "A eliminar..." : "Eliminar para sempre"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

type Feedback = { kind: "success" | "error"; message: string } | null;

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

function StatusBadge({ status }: { status: SkillStatus }) {
  const styles: Record<SkillStatus, string> = {
    draft: "bg-amber-100 text-amber-800",
    active: "bg-emerald-100 text-emerald-800",
    inactive: "bg-slate-200 text-slate-700",
    archived: "bg-violet-100 text-violet-800",
  };

  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 font-bold ${styles[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function PrimaryButton({
  pending,
  children,
}: {
  pending: boolean;
  children: React.ReactNode;
}) {
  return (
    <button type="submit" disabled={pending} className={PRIMARY_BUTTON_CLASS}>
      {children}
    </button>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("pt-PT", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function apiRequest<T>(
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
const PAGINATION_BUTTON_CLASS =
  "min-h-11 rounded-lg px-3 text-sm font-bold text-teal-800 hover:bg-teal-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:cursor-not-allowed disabled:opacity-40";
