"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  ChatBootstrap,
  ChatModelOption,
  ChatSkillOption,
} from "@/src/chat/repository";
import type { PublicChatStreamEvent } from "@/src/chat/contract";
import type {
  ChatConversation,
  ChatMessage,
  ChatSkillMode,
} from "@/src/types/supabase";

type Suggestion = { id: string; reason: string };
type SelectorSection = "skills" | "tools" | "agents";

export function ChatWorkspace({ initial }: { initial: ChatBootstrap }) {
  const [conversations, setConversations] = useState(initial.conversations);
  const [selectedId, setSelectedId] = useState(initial.selectedConversationId);
  const [messages, setMessages] = useState(initial.messages);
  const [models] = useState(initial.models);
  const [skills] = useState(initial.skills);
  const [composer, setComposer] = useState("");
  const [expandedSection, setExpandedSection] =
    useState<SelectorSection | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [suggestedIds, setSuggestedIds] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const userNearBottomRef = useRef(true);
  const selected = conversations.find((item) => item.id === selectedId) ?? null;
  const selectedModel =
    models.find((model) => model.id === selected?.current_account_model_id) ??
    models.find((model) => model.isDefault) ??
    models[0] ??
    null;

  useEffect(() => {
    if (userNearBottomRef.current) {
      threadRef.current?.scrollTo({
        top: threadRef.current.scrollHeight,
        behavior: streaming ? "auto" : "smooth",
      });
    }
  }, [messages, streaming]);

  useLayoutEffect(() => {
    userNearBottomRef.current = true;
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [selectedId]);

  const handleThreadScroll = useCallback(() => {
    const thread = threadRef.current;
    if (!thread) return;
    userNearBottomRef.current =
      thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
  }, []);

  async function refreshConversation(conversationId: string) {
    if (streaming || conversationId === selectedId) return;
    setLoadingConversation(true);
    setFeedback("");
    const result = await apiRequest<ChatBootstrap>(
      `/api/chat/conversations?conversationId=${encodeURIComponent(
        conversationId
      )}`
    );
    setLoadingConversation(false);

    if (!result.ok) {
      setFeedback(result.error);
      return;
    }

    setConversations(result.data.conversations);
    setSelectedId(result.data.selectedConversationId);
    setMessages(result.data.messages);
    setSuggestions(null);
    setSuggestedIds([]);
    setExpandedSection(null);
    window.history.replaceState(
      null,
      "",
      `/chat?conversation=${conversationId}`
    );
  }

  async function createNewConversation() {
    if (streaming || !selectedModel) return;
    setFeedback("");
    const result = await apiRequest<ChatConversation>(
      "/api/chat/conversations",
      {
        method: "POST",
        body: JSON.stringify({}),
      }
    );

    if (!result.ok) {
      setFeedback(result.error);
      return;
    }

    setConversations((current) => [result.data, ...current]);
    setSelectedId(result.data.id);
    setMessages([]);
    setComposer("");
    setExpandedSection(null);
    setSuggestions(null);
    setSuggestedIds([]);
    window.history.replaceState(
      null,
      "",
      `/chat?conversation=${result.data.id}`
    );
  }

  async function saveConversation(
    conversationId: string,
    changes: Record<string, unknown>
  ) {
    const result = await apiRequest<ChatConversation>(
      `/api/chat/conversations/${conversationId}`,
      { method: "PATCH", body: JSON.stringify(changes) }
    );

    if (!result.ok) {
      setFeedback(result.error);
      return false;
    }

    setConversations((current) =>
      current.map((item) => (item.id === result.data.id ? result.data : item))
    );
    return true;
  }

  async function submitRename(event: FormEvent) {
    event.preventDefault();
    if (!renamingId || !renameValue.trim()) return;
    if (await saveConversation(renamingId, { title: renameValue.trim() })) {
      setRenamingId(null);
    }
  }

  async function confirmDelete() {
    if (!deleteId) return;
    const result = await apiRequest<{ success: true }>(
      `/api/chat/conversations/${deleteId}`,
      { method: "DELETE" }
    );

    if (!result.ok) {
      setFeedback(result.error);
      return;
    }

    const remaining = conversations.filter((item) => item.id !== deleteId);
    setConversations(remaining);
    setDeleteId(null);

    if (selectedId === deleteId) {
      const next = remaining[0] ?? null;
      setSelectedId(next?.id ?? null);
      setMessages([]);
      window.history.replaceState(
        null,
        "",
        next ? `/chat?conversation=${next.id}` : "/chat"
      );
      if (next) await refreshConversation(next.id);
    }
  }

  async function changeModel(accountModelId: string) {
    if (!selected) return;
    await saveConversation(selected.id, { accountModelId });
  }

  async function changeSkillMode(skillMode: ChatSkillMode) {
    if (!selected) return;
    setSuggestions(null);
    setSuggestedIds([]);
    await saveConversation(selected.id, { skillMode });
  }

  async function toggleSkill(id: string) {
    if (!selected) return;
    const skillIds = selected.selected_skill_ids.includes(id)
      ? selected.selected_skill_ids.filter((item) => item !== id)
      : [...selected.selected_skill_ids, id];
    await saveConversation(selected.id, { skillIds });
  }

  async function requestSuggestions() {
    if (!selected || !selectedModel || !composer.trim()) return;
    setSuggesting(true);
    setFeedback("");
    const result = await apiRequest<{ suggestions: Suggestion[] }>(
      "/api/chat/suggestions",
      {
        method: "POST",
        body: JSON.stringify({
          conversationId: selected.id,
          accountModelId: selectedModel.id,
          prompt: composer,
        }),
      }
    );
    setSuggesting(false);

    if (!result.ok) {
      setFeedback(result.error);
      return;
    }

    setSuggestions(result.data.suggestions);
    setSuggestedIds(result.data.suggestions.map((item) => item.id));
  }

  async function handleSend(event: FormEvent) {
    event.preventDefault();
    if (!selected || !selectedModel || !composer.trim() || streaming) return;

    if (selected.skill_mode === "automatic" && suggestions === null) {
      await requestSuggestions();
      return;
    }

    await streamMessage({
      content: composer.trim(),
      skillIds:
        selected.skill_mode === "automatic"
          ? suggestedIds
          : selected.selected_skill_ids,
      automaticSelectionConfirmed: selected.skill_mode === "automatic",
    });
  }

  async function retryMessage(message: ChatMessage) {
    if (!selected || !selectedModel || streaming) return;
    const userMessage = messages.find(
      (item) => item.id === message.reply_to_message_id
    );
    if (!userMessage) return;

    await streamMessage({
      content: userMessage.content,
      skillIds: auditSkillIds(message),
      automaticSelectionConfirmed: true,
      retryAssistantMessageId: message.id,
    });
  }

  async function streamMessage(input: {
    content: string;
    skillIds: string[];
    automaticSelectionConfirmed: boolean;
    retryAssistantMessageId?: string;
  }) {
    if (!selected || !selectedModel) return;
    const clientRequestId = crypto.randomUUID();
    const optimisticUserId = crypto.randomUUID();
    const optimisticAssistantId = crypto.randomUUID();
    const isRetry = Boolean(input.retryAssistantMessageId);
    const controller = new AbortController();
    let serverStarted = false;
    let serverAssistantId: string | null = null;
    abortRef.current = controller;
    userNearBottomRef.current = true;
    setStreaming(true);
    setFeedback("");
    setSuggestions(null);
    setSuggestedIds([]);

    if (!isRetry) {
      setMessages((current) => [
        ...current,
        optimisticMessage({
          id: optimisticUserId,
          conversationId: selected.id,
          role: "user",
          status: "complete",
          content: input.content,
          requestId: clientRequestId,
          replyTo: null,
        }),
        optimisticMessage({
          id: optimisticAssistantId,
          conversationId: selected.id,
          role: "assistant",
          status: "streaming",
          content: "",
          requestId: crypto.randomUUID(),
          replyTo: optimisticUserId,
          model: selectedModel,
        }),
      ]);
      setComposer("");
    } else {
      setMessages((current) => [
        ...current,
        optimisticMessage({
          id: optimisticAssistantId,
          conversationId: selected.id,
          role: "assistant",
          status: "streaming",
          content: "",
          requestId: clientRequestId,
          replyTo:
            current.find((item) => item.id === input.retryAssistantMessageId)
              ?.reply_to_message_id ?? null,
          model: selectedModel,
        }),
      ]);
    }

    try {
      const response = await fetch("/api/chat/messages/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          conversationId: selected.id,
          accountModelId: selectedModel.id,
          clientRequestId,
          expectedVersion: selected.version,
          content: input.content,
          skillMode: selected.skill_mode,
          skillIds: input.skillIds,
          automaticSelectionConfirmed: input.automaticSelectionConfirmed,
          ...(input.retryAssistantMessageId
            ? { retryAssistantMessageId: input.retryAssistantMessageId }
            : {}),
        }),
      });

      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          payload?.error ?? "Não foi possível enviar a mensagem."
        );
      }

      await consumeChatStream(response.body, {
        onStart(event) {
          serverStarted = true;
          serverAssistantId = event.assistantMessageId;
          setConversations((current) =>
            current.map((conversation) =>
              conversation.id === event.conversationId
                ? {
                    ...conversation,
                    version: event.conversationVersion,
                    current_account_model_id: selectedModel.id,
                    selected_skill_ids: input.skillIds,
                    title:
                      conversation.title === "Nova conversa" && !isRetry
                        ? deterministicTitle(input.content)
                        : conversation.title,
                  }
                : conversation
            )
          );
          setMessages((current) =>
            current.map((message) => {
              if (message.id === optimisticUserId) {
                return { ...message, id: event.userMessageId };
              }
              if (message.id === optimisticAssistantId) {
                return {
                  ...message,
                  id: event.assistantMessageId,
                  reply_to_message_id: event.userMessageId,
                };
              }
              return message;
            })
          );
        },
        onDelta(event) {
          setMessages((current) =>
            current.map((message) =>
              message.id === event.assistantMessageId ||
              message.id === optimisticAssistantId
                ? { ...message, content: message.content + event.text }
                : message
            )
          );
        },
        onDone(event) {
          setMessages((current) =>
            current.map((message) =>
              message.id === event.assistantMessageId ||
              message.id === optimisticAssistantId
                ? {
                    ...message,
                    id: event.assistantMessageId,
                    content: event.content,
                    status: "complete",
                    usage: event.usage ?? null,
                    completed_at: new Date().toISOString(),
                  }
                : message
            )
          );
        },
        onError(event) {
          setMessages((current) =>
            current.map((message) =>
              message.id === event.assistantMessageId ||
              message.id === optimisticAssistantId
                ? {
                    ...message,
                    status: event.code === "cancelled" ? "cancelled" : "failed",
                    error_code: event.code,
                    completed_at: new Date().toISOString(),
                  }
                : message
            )
          );
          setFeedback(event.message);
        },
      });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      if (!serverStarted) {
        setMessages((current) =>
          current.filter(
            (message) =>
              message.id !== optimisticAssistantId &&
              (isRetry || message.id !== optimisticUserId)
          )
        );
        if (!isRetry) setComposer(input.content);
      } else {
        setMessages((current) =>
          current.map((message) =>
            message.id === serverAssistantId ||
            message.id === optimisticAssistantId
              ? {
                  ...message,
                  status: cancelled ? "cancelled" : "failed",
                  error_code: cancelled ? "cancelled" : "stream_interrupted",
                  completed_at: new Date().toISOString(),
                }
              : message
          )
        );
      }
      setFeedback(
        cancelled
          ? "Resposta cancelada."
          : error instanceof Error
            ? error.message
            : "A resposta foi interrompida."
      );
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  }

  return (
    <div className="mx-auto grid min-h-[calc(100dvh-8rem)] max-w-[96rem] gap-4 lg:grid-cols-[19rem_minmax(0,1fr)]">
      <aside className="flex max-h-[calc(100dvh-8rem)] flex-col rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 p-4">
          <button
            type="button"
            onClick={createNewConversation}
            disabled={streaming || models.length === 0}
            className="min-h-11 w-full rounded-xl bg-teal-700 px-4 text-sm font-bold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Nova conversa
          </button>
        </div>
        <div className="min-h-32 flex-1 space-y-2 overflow-y-auto p-3">
          {conversations.length === 0 ? (
            <p className="p-3 text-sm text-slate-500">
              Ainda não existem conversas.
            </p>
          ) : (
            conversations.map((conversation) => (
              <div
                key={conversation.id}
                className={`rounded-xl border p-2 ${
                  selectedId === conversation.id
                    ? "border-teal-300 bg-teal-50"
                    : "border-transparent hover:bg-slate-50"
                }`}
              >
                {renamingId === conversation.id ? (
                  <form onSubmit={submitRename} className="flex gap-2">
                    <input
                      autoFocus
                      value={renameValue}
                      maxLength={120}
                      onChange={(event) => setRenameValue(event.target.value)}
                      aria-label="Novo título"
                      className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
                    />
                    <button className="text-xs font-bold text-teal-800">
                      Guardar
                    </button>
                  </form>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={streaming}
                      onClick={() => refreshConversation(conversation.id)}
                      className="min-h-9 w-full truncate text-left text-sm font-semibold text-slate-800"
                    >
                      {conversation.title}
                    </button>
                    <div className="flex gap-3 px-1 text-xs">
                      <button
                        type="button"
                        onClick={() => {
                          setRenamingId(conversation.id);
                          setRenameValue(conversation.title);
                        }}
                        className="text-slate-600 underline"
                      >
                        Renomear
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteId(conversation.id)}
                        className="text-rose-700 underline"
                      >
                        Eliminar
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </aside>

      <section className="flex h-[calc(100dvh-6.5rem)] min-h-[32rem] min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm lg:h-[calc(100dvh-8rem)] lg:min-h-[44rem]">
        <header className="border-b border-slate-200 p-4">
          <h1 className="text-lg font-bold text-slate-950">Chat</h1>
          <p className="text-sm text-slate-500">
            Conversas de texto persistentes. Sem Tools, agentes ou dados
            financeiros nesta fase.
          </p>
        </header>

        <div
          ref={threadRef}
          onScroll={handleThreadScroll}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain bg-slate-50 p-4 pb-8 sm:p-6 sm:pb-10"
          aria-live="polite"
          aria-busy={streaming || loadingConversation}
          data-testid="chat-thread"
        >
          {loadingConversation ? (
            <p className="text-sm text-slate-500">A carregar conversa…</p>
          ) : messages.length === 0 ? (
            <div className="mx-auto max-w-lg py-16 text-center">
              <h2 className="text-xl font-bold text-slate-900">
                Comece uma conversa
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                Escolha conta, modelo e Skills antes de enviar a primeira
                mensagem.
              </p>
            </div>
          ) : (
            messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                onRetry={() => retryMessage(message)}
                retryDisabled={streaming}
              />
            ))
          )}
        </div>

        <div
          className="sticky bottom-0 z-10 border-t border-slate-200 bg-white/95 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_24px_-20px_rgba(15,23,42,0.7)] backdrop-blur sm:px-4"
          data-testid="chat-composer"
        >
          <ModelControl
            selectedModel={selectedModel}
            conversation={selected}
            models={models}
            streaming={streaming}
            onModelChange={changeModel}
          />
          <CopilotCapabilitiesSummary />
          <ContextOverview
            expandedSection={expandedSection}
            conversation={selected}
            skills={skills}
            suggestedIds={suggestedIds}
            suggestions={suggestions}
            disabled={streaming}
            onExpandedSectionChange={(section) =>
              setExpandedSection((current) =>
                current === section ? null : section
              )
            }
            onModeChange={changeSkillMode}
            onToggleSkill={toggleSkill}
            onToggleSuggested={(id) =>
              setSuggestedIds((current) =>
                current.includes(id)
                  ? current.filter((item) => item !== id)
                  : [...current, id]
              )
            }
          />
          {feedback && (
            <p
              role="alert"
              className="mt-2 text-sm font-semibold text-rose-700"
            >
              {feedback}
            </p>
          )}

          <form onSubmit={handleSend} className="mt-2 flex items-end gap-2">
            <label className="sr-only" htmlFor="chat-message">
              Mensagem
            </label>
            <textarea
              id="chat-message"
              rows={2}
              maxLength={4000}
              value={composer}
              disabled={!selected || !selectedModel || streaming}
              onChange={(event) => {
                setComposer(event.target.value);
                setSuggestions(null);
                setSuggestedIds([]);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Escreva uma mensagem…"
              className="min-h-14 max-h-40 min-w-0 flex-1 resize-y rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
            {streaming ? (
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="min-h-11 shrink-0 rounded-xl bg-rose-700 px-3 text-sm font-bold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700 sm:px-4"
              >
                Cancelar
              </button>
            ) : (
              <button
                type="submit"
                disabled={
                  !selected || !selectedModel || !composer.trim() || suggesting
                }
                className="min-h-11 shrink-0 rounded-xl bg-teal-700 px-3 text-sm font-bold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:cursor-not-allowed disabled:opacity-50 sm:px-5"
              >
                {suggesting
                  ? "A sugerir…"
                  : selected?.skill_mode === "automatic" && suggestions === null
                    ? "Sugerir Skills do Carcanhol"
                    : "Enviar"}
              </button>
            )}
          </form>
          <p className="mt-1 text-right text-xs text-slate-400">
            {composer.length}/4000 · Enter envia, Shift+Enter cria linha
          </p>
        </div>
      </section>

      {deleteId && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-chat-title"
          className="fixed inset-0 z-50 grid place-items-center bg-slate-950/50 p-4"
        >
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <h2 id="delete-chat-title" className="text-lg font-bold">
              Eliminar conversa?
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              As mensagens e metadados relacionados serão eliminados.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                autoFocus
                onClick={() => setDeleteId(null)}
                className="min-h-11 rounded-lg border border-slate-300 px-4 font-semibold"
              >
                Manter
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                className="min-h-11 rounded-lg bg-rose-700 px-4 font-bold text-white"
              >
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ModelControl({
  selectedModel,
  conversation,
  models,
  streaming,
  onModelChange,
}: {
  selectedModel: ChatModelOption | null;
  conversation: ChatConversation | null;
  models: ChatModelOption[];
  streaming: boolean;
  onModelChange: (id: string) => void;
}) {
  return (
    <div
      className="mb-2 flex min-w-0 flex-wrap items-center gap-2"
      data-testid="composer-model-control"
    >
      <label
        htmlFor="composer-model"
        className="shrink-0 text-xs font-bold text-slate-600"
      >
        Modelo
      </label>
      <select
        id="composer-model"
        value={selectedModel?.id ?? ""}
        title={
          selectedModel
            ? `${providerLabel(selectedModel.provider)} · ${
                selectedModel.accountName
              } · ${selectedModel.modelName}`
            : "Sem modelo disponível"
        }
        aria-label="Conta e modelo para a próxima mensagem"
        disabled={!conversation || streaming || models.length === 0}
        onChange={(event) => onModelChange(event.target.value)}
        className="min-h-11 min-w-0 flex-1 truncate rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20 disabled:cursor-not-allowed disabled:bg-slate-100"
      >
        {models.length === 0 && (
          <option value="">Sem predefinição LLM ativa</option>
        )}
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.modelName} · {providerLabel(model.provider)} ·{" "}
            {model.accountName}
          </option>
        ))}
      </select>
      {streaming && (
        <span className="w-full text-right text-xs text-slate-500">
          Apenas leitura durante a resposta
        </span>
      )}
    </div>
  );
}

function CopilotCapabilitiesSummary() {
  const description =
    "O runtime gere automaticamente apenas as capacidades GitHub Copilot que estejam disponíveis e sejam compatíveis. Este controlo não expõe permissões nem ativa novas capacidades.";

  return (
    <div
      className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs"
      role="status"
      aria-label={`Capacidades GitHub Copilot: automáticas. ${description}`}
      title={description}
      data-testid="copilot-capabilities-summary"
    >
      <span className="font-bold text-slate-700">
        Capacidades GitHub Copilot: automáticas
      </span>
      <span className="text-slate-500">Geridas pelo runtime</span>
    </div>
  );
}

function ContextOverview({
  expandedSection,
  conversation,
  skills,
  suggestions,
  suggestedIds,
  disabled,
  onExpandedSectionChange,
  onModeChange,
  onToggleSkill,
  onToggleSuggested,
}: {
  expandedSection: SelectorSection | null;
  conversation: ChatConversation | null;
  skills: ChatSkillOption[];
  suggestions: Suggestion[] | null;
  suggestedIds: string[];
  disabled: boolean;
  onExpandedSectionChange: (section: SelectorSection) => void;
  onModeChange: (mode: ChatSkillMode) => void;
  onToggleSkill: (id: string) => void;
  onToggleSuggested: (id: string) => void;
}) {
  const sections: SelectorSection[] = ["skills", "tools", "agents"];

  return (
    <div
      className="grid gap-2 md:grid-cols-3"
      role="group"
      aria-label="Capacidades do Projecto Carcanhol para a próxima mensagem"
      data-testid="context-overview"
    >
      {sections.map((section) => {
        const expanded = expandedSection === section;
        const summary =
          section === "skills"
            ? conversation?.skill_mode === "automatic"
              ? "Automático"
              : `${conversation?.selected_skill_ids.length ?? 0} selecionada(s)`
            : "Automático · 0 disponíveis";

        return (
          <section
            key={section}
            className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-slate-50"
            data-testid={`context-card-${section}`}
          >
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={`context-card-${section}-body`}
              onClick={() => onExpandedSectionChange(section)}
              className="flex min-h-11 w-full items-center justify-between gap-3 px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-700 md:hidden"
            >
              <span className="font-bold text-slate-900">
                {sectionLabel(section)}
              </span>
              <span className="text-right text-xs text-slate-500">
                {summary}
              </span>
            </button>
            <div className="hidden min-h-11 items-center justify-between gap-2 border-b border-slate-200 px-3 md:flex">
              <h2 className="font-bold text-slate-900">
                {sectionLabel(section)}
              </h2>
              <p className="text-right text-xs text-slate-500">{summary}</p>
            </div>
            <div
              id={`context-card-${section}-body`}
              className={`${expanded ? "block" : "hidden"} max-h-44 overflow-y-auto overscroll-contain border-t border-slate-200 p-2 md:block md:border-t-0`}
            >
              <SelectorPanel
                section={section}
                conversation={conversation}
                skills={skills}
                suggestedIds={suggestedIds}
                suggestions={suggestions}
                disabled={disabled}
                onModeChange={onModeChange}
                onToggleSkill={onToggleSkill}
                onToggleSuggested={onToggleSuggested}
              />
            </div>
          </section>
        );
      })}
    </div>
  );
}

function SelectorPanel({
  section,
  conversation,
  skills,
  suggestions,
  suggestedIds,
  disabled,
  onModeChange,
  onToggleSkill,
  onToggleSuggested,
}: {
  section: SelectorSection;
  conversation: ChatConversation | null;
  skills: ChatSkillOption[];
  suggestions: Suggestion[] | null;
  suggestedIds: string[];
  disabled: boolean;
  onModeChange: (mode: ChatSkillMode) => void;
  onToggleSkill: (id: string) => void;
  onToggleSuggested: (id: string) => void;
}) {
  const [query, setQuery] = useState("");

  if (section !== "skills") {
    return (
      <div className="space-y-2" data-testid={`${section}-empty-state`}>
        <div
          className="sticky top-0 z-[1] flex rounded-lg border border-slate-300 bg-white p-1"
          role="group"
          aria-label={`Modo de seleção de ${sectionLabel(section)}`}
        >
          {(["automatic", "manual"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              disabled
              aria-pressed={mode === "automatic"}
              className={`min-h-11 flex-1 rounded-md px-2 text-xs font-bold md:min-h-9 ${
                mode === "automatic"
                  ? "bg-slate-200 text-slate-600"
                  : "text-slate-400"
              }`}
            >
              {mode === "automatic" ? "Automático" : "Manual"}
            </button>
          ))}
        </div>
        <p className="rounded-lg border border-dashed border-slate-300 bg-white p-3 text-xs leading-5 text-slate-500">
          Ainda não existem {sectionLabel(section)} disponíveis nem execução
          desta categoria nesta fase.
        </p>
      </div>
    );
  }

  const filtered = skills.filter((skill) =>
    `${skill.name} ${skill.description}`
      .toLocaleLowerCase("pt")
      .includes(query.toLocaleLowerCase("pt"))
  );
  const automatic = conversation?.skill_mode === "automatic";

  return (
    <div>
      <div className="sticky top-0 z-[1] flex flex-wrap items-center justify-between gap-2 bg-slate-50 pb-2">
        <div
          className="flex rounded-lg border border-slate-300 bg-white p-1"
          role="group"
          aria-label="Modo de seleção de Skills do Carcanhol"
        >
          {(["automatic", "manual"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={conversation?.skill_mode === mode}
              disabled={!conversation || disabled}
              onClick={() => onModeChange(mode)}
              className={`min-h-11 rounded-md px-3 text-xs font-bold md:min-h-9 ${
                conversation?.skill_mode === mode
                  ? "bg-teal-700 text-white"
                  : "text-slate-600"
              }`}
            >
              {mode === "automatic" ? "Automático" : "Manual"}
            </button>
          ))}
        </div>
        <p className="text-xs text-slate-500">
          {automatic
            ? "As sugestões só são aplicadas depois da sua confirmação."
            : `${conversation?.selected_skill_ids.length ?? 0} selecionada(s).`}
        </p>
      </div>

      {automatic && suggestions === null ? (
        <p className="rounded-lg border border-dashed border-slate-300 bg-white p-3 text-xs leading-5 text-slate-500">
          Escreva a mensagem e peça sugestões de Skills do Carcanhol. Apenas
          nomes e descrições são usados nessa etapa.
        </p>
      ) : (
        <>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Pesquisar Skills"
            aria-label="Pesquisar Skills do Carcanhol"
            className="min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
          />
          <div className="mt-2 space-y-1">
            {filtered.length === 0 ? (
              <p className="p-2 text-sm text-slate-500">
                Não existem Skills do Carcanhol ativas correspondentes.
              </p>
            ) : (
              filtered.map((skill) => {
                const checked = automatic
                  ? suggestedIds.includes(skill.id)
                  : (conversation?.selected_skill_ids.includes(skill.id) ??
                    false);
                const reason = suggestions?.find(
                  (item) => item.id === skill.id
                )?.reason;
                return (
                  <label
                    key={skill.id}
                    className="flex cursor-pointer gap-3 rounded-lg p-2 hover:bg-white"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() =>
                        automatic
                          ? onToggleSuggested(skill.id)
                          : onToggleSkill(skill.id)
                      }
                      className="mt-1 h-4 w-4"
                    />
                    <span className="min-w-0 text-sm">
                      <span className="block font-semibold text-slate-800">
                        {skill.name}
                      </span>
                      <span className="block text-xs text-slate-500">
                        {reason ?? skill.description}
                      </span>
                    </span>
                  </label>
                );
              })
            )}
          </div>
          {automatic && suggestions !== null && (
            <p className="mt-2 text-xs font-semibold text-teal-800">
              Confirme ou edite as caixas e prima Enviar.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function MessageBubble({
  message,
  onRetry,
  retryDisabled,
}: {
  message: ChatMessage;
  onRetry: () => void;
  retryDisabled: boolean;
}) {
  const assistant = message.role === "assistant";
  const audit = Array.isArray(message.skill_audit)
    ? message.skill_audit
        .map((item) =>
          item && typeof item === "object" && "name" in item
            ? String(item.name)
            : ""
        )
        .filter(Boolean)
    : [];

  return (
    <article
      className={`max-w-[90%] rounded-2xl px-4 py-3 shadow-sm ${
        assistant
          ? "mr-auto border border-slate-200 bg-white"
          : "ml-auto bg-teal-700 text-white"
      }`}
    >
      <p className="whitespace-pre-wrap text-sm leading-6">{message.content}</p>
      {assistant && message.status === "streaming" && (
        <p className="mt-2 text-xs font-semibold text-teal-700">A responder…</p>
      )}
      {assistant &&
        (message.status === "cancelled" || message.status === "failed") && (
          <div className="mt-3 border-t border-slate-100 pt-2">
            <p className="text-xs font-semibold text-rose-700">
              {message.status === "cancelled"
                ? "Resposta cancelada"
                : "Resposta incompleta"}
            </p>
            <button
              type="button"
              disabled={retryDisabled}
              onClick={onRetry}
              className="mt-1 text-xs font-bold text-teal-800 underline disabled:opacity-50"
            >
              Tentar novamente
            </button>
          </div>
        )}
      {assistant && message.account_name && (
        <p className="mt-2 text-[11px] text-slate-400">
          {providerLabel(message.provider ?? "")} · {message.account_name} ·{" "}
          {message.model_name}
          {audit.length > 0
            ? ` · Skills do Carcanhol: ${audit.join(", ")}`
            : ""}
        </p>
      )}
    </article>
  );
}

async function consumeChatStream(
  stream: ReadableStream<Uint8Array>,
  handlers: {
    onStart: (event: Extract<PublicChatStreamEvent, { type: "start" }>) => void;
    onDelta: (event: Extract<PublicChatStreamEvent, { type: "delta" }>) => void;
    onDone: (event: Extract<PublicChatStreamEvent, { type: "done" }>) => void;
    onError: (event: Extract<PublicChatStreamEvent, { type: "error" }>) => void;
  }
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line) continue;
      const event = JSON.parse(line) as PublicChatStreamEvent;
      if (event.v !== 1) throw new Error("Versão de stream inválida.");
      if (event.type === "start") handlers.onStart(event);
      if (event.type === "delta") handlers.onDelta(event);
      if (event.type === "done") {
        if (terminal) throw new Error("Resposta terminal duplicada.");
        terminal = true;
        handlers.onDone(event);
      }
      if (event.type === "error") {
        if (terminal) throw new Error("Resposta terminal duplicada.");
        terminal = true;
        handlers.onError(event);
      }
    }
  }

  if (!terminal) throw new Error("A resposta terminou inesperadamente.");
}

function optimisticMessage({
  id,
  conversationId,
  role,
  status,
  content,
  requestId,
  replyTo,
  model,
}: {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  status: "complete" | "streaming";
  content: string;
  requestId: string;
  replyTo: string | null;
  model?: ChatModelOption;
}): ChatMessage {
  const now = new Date().toISOString();
  return {
    id,
    conversation_id: conversationId,
    user_id: "",
    sequence: Date.now(),
    role,
    status,
    content,
    client_request_id: requestId,
    reply_to_message_id: replyTo,
    account_model_id: model?.id ?? null,
    provider: model?.provider ?? null,
    account_name: model?.accountName ?? null,
    provider_model_id: model?.providerModelId ?? null,
    model_name: model?.modelName ?? null,
    skill_audit: [],
    usage: null,
    error_code: null,
    created_at: now,
    completed_at: status === "complete" ? now : null,
  };
}

function auditSkillIds(message: ChatMessage) {
  if (!Array.isArray(message.skill_audit)) return [];
  return message.skill_audit
    .map((item) =>
      item && typeof item === "object" && "id" in item ? String(item.id) : ""
    )
    .filter(Boolean);
}

function deterministicTitle(content: string) {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length <= 60 ? compact : `${compact.slice(0, 57).trim()}...`;
}

function providerLabel(provider: string) {
  return provider === "github_copilot" ? "GitHub Copilot" : provider;
}

function sectionLabel(section: SelectorSection) {
  return section === "skills"
    ? "Skills do Carcanhol"
    : section === "tools"
      ? "Tools do Carcanhol"
      : "Agentes do Carcanhol";
}

async function apiRequest<T>(
  url: string,
  init: RequestInit = {}
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const payload = (await response.json()) as T & { error?: string };
    return response.ok
      ? { ok: true, data: payload }
      : { ok: false, error: payload.error ?? "O pedido falhou." };
  } catch {
    return { ok: false, error: "Não foi possível contactar o servidor." };
  }
}
