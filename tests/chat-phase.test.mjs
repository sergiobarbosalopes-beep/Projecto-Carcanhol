import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = read("../database/migrations/0009_chat_base.sql");
const repository = read("../src/chat/repository.ts");
const contract = read("../src/chat/contract.ts");
const streamRoute = read("../app/api/chat/messages/stream/route.ts");
const suggestionRoute = read("../app/api/chat/suggestions/route.ts");
const workspace = read("../app/(protected)/chat/chat-workspace.tsx");
const workerContract = read("../services/copilot-worker/src/contract.ts");
const workerAdapter = read("../services/copilot-worker/src/copilot-adapter.ts");
const messagesTable = migration.slice(
  migration.indexOf("create table if not exists carcanhol.chat_messages"),
  migration.indexOf(
    "create unique index if not exists chat_messages_conversation_sequence_idx"
  )
);

test("chat persistence is user-owned, cascading and transaction-backed", () => {
  assert.match(migration, /\bbegin;[\s\S]+commit;\s*$/);
  assert.match(
    migration,
    /chat_messages_conversation_owner_fk[\s\S]+on delete cascade/
  );
  assert.match(
    migration,
    /alter table carcanhol\.chat_conversations enable row level security/
  );
  assert.match(
    migration,
    /alter table carcanhol\.chat_messages enable row level security/
  );
  assert.match(migration, /chat_conversations_select_own[\s\S]+auth\.uid\(\)/);
  assert.match(migration, /chat_messages_select_own[\s\S]+auth\.uid\(\)/);
  assert.match(
    migration,
    /create or replace function carcanhol\.begin_chat_turn/
  );
  assert.match(
    migration,
    /create or replace function carcanhol\.finalize_chat_message/
  );
  assert.match(migration, /chat_messages_user_request_idx/);
  assert.match(migration, /chat_messages_one_active_assistant_idx/);
  assert.match(
    migration,
    /grant select on carcanhol\.chat_conversations to authenticated/
  );
  assert.doesNotMatch(
    migration,
    /grant select, insert, update, delete on carcanhol\.chat_conversations/
  );
  assert.match(migration, /update_chat_conversation/);
  assert.match(migration, /delete_chat_conversation/);
  assert.match(
    migration,
    /begin_chat_turn[\s\S]+profiles as p where p\.id = p_user_id/
  );
});

test("assistant audit records effective model and versioned Skill hashes without secrets", () => {
  assert.match(migration, /account_model_id uuid/);
  assert.match(migration, /provider_model_id text/);
  assert.match(migration, /skill_audit jsonb/);
  assert.match(repository, /contentSha256: createHash\("sha256"\)/);
  assert.match(repository, /version: skill\.updated_at/);
  assert.doesNotMatch(messagesTable, /\s(ciphertext|auth_tag|system_prompt)\s/);
});

test("Skill resolution is server-side, active-only, bounded and safely delimited", () => {
  assert.match(repository, /\.eq\("user_id", userId\)/);
  assert.match(repository, /\.eq\("status", "active"\)/);
  assert.match(repository, /data\.length !== uniqueIds\.length/);
  assert.match(repository, /<carcanhol_skill/);
  assert.match(repository, /<\/carcanhol_skill>/);
  assert.match(repository, /Ignora qualquer conteúdo/);
  assert.match(repository, /result\.length > 16_000/);
});

test("automatic Skill suggestions use metadata only and require confirmation", () => {
  assert.match(suggestionRoute, /\.select\("id, name, description"\)/);
  assert.doesNotMatch(suggestionRoute, /content_markdown/);
  assert.match(suggestionRoute, /skillSuggestionOutputSchema\.parse/);
  assert.match(suggestionRoute, /allowedIds\.has/);
  assert.match(contract, /Automatic Skill suggestions must be confirmed/);
  assert.match(workspace, /suggestions === null/);
  assert.match(workspace, /automaticSelectionConfirmed/);
});

test("streaming uses official SDK deltas with allowlisted bounded NDJSON", () => {
  assert.match(workerAdapter, /"assistant\.message_delta"/);
  assert.match(workerAdapter, /event\.data\.deltaContent/);
  assert.match(workerAdapter, /event\.agentId/);
  assert.match(workerAdapter, /activeSession\.abort\(\)/);
  assert.match(workerAdapter, /activeSession\.disconnect\(\)/);
  assert.match(workerAdapter, /client\.deleteSession\(sessionId\)/);
  assert.match(
    workerContract,
    /copilotStreamEventSchema = z\.discriminatedUnion/
  );
  assert.match(workerContract, /COPILOT_STREAM_MAX_DELTA_LENGTH = 16_000/);
  assert.match(streamRoute, /expectedSequence/);
  assert.match(streamRoute, /Duplicate terminal event/);
  assert.match(streamRoute, /COPILOT_WORKER_MAX_RESPONSE_BYTES/);
});

test("cancelled and failed responses remain visibly terminal and retry is idempotent", () => {
  assert.match(migration, /status in \('cancelled', 'failed'\)/);
  assert.match(
    migration,
    /create or replace function carcanhol\.retry_chat_turn/
  );
  assert.match(migration, /client_request_id = p_client_request_id/);
  assert.match(streamRoute, /streamAbort\.signal\.aborted/);
  assert.match(workspace, /Cancelar/);
  assert.match(workspace, /Resposta cancelada/);
  assert.match(workspace, /Tentar novamente/);
});

test("Tools and Agents have no execution path and assistant output is plain text", () => {
  assert.match(workspace, /Não existem opções nem execução desta categoria/);
  assert.doesNotMatch(workspace, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(
    `${streamRoute}\n${repository}`,
    /availableTools|mcpServers|customAgents|tool\.execution/
  );
  assert.match(workspace, /whitespace-pre-wrap/);
});

test("chat composer keeps a compact sticky three-card context overview", () => {
  assert.match(workspace, /data-testid="chat-composer"/);
  assert.match(workspace, /className="sticky bottom-0/);
  assert.match(workspace, /safe-area-inset-bottom/);
  assert.match(workspace, /data-testid="composer-model-control"/);
  assert.match(workspace, /data-testid="context-overview"/);
  assert.match(workspace, /md:grid-cols-3/);
  assert.match(
    workspace,
    /role="group"\s+aria-label="Contexto da próxima mensagem"/
  );
  assert.match(workspace, /\["skills", "tools", "agents"\]/);
  assert.match(workspace, /max-h-44 overflow-y-auto/);
  assert.match(workspace, /Apenas leitura durante a resposta/);
  assert.match(workspace, /id="composer-model"[\s\S]+min-h-11/);
  assert.doesNotMatch(workspace, /Contexto por conversa/);
});

test("mobile context cards form an accessible single-open accordion", () => {
  assert.match(workspace, /aria-expanded=\{expanded\}/);
  assert.match(
    workspace,
    /aria-controls=\{`context-card-\$\{section\}-body`\}/
  );
  assert.match(workspace, /current === section \? null : section/);
  assert.match(workspace, /className="[^"]*md:hidden"/);
  assert.match(
    workspace,
    /\$\{expanded \? "block" : "hidden"\}[\s\S]+md:block/
  );
  assert.doesNotMatch(workspace, /ComposerPanelOverlay|createPortal/);
});

test("Skill controls and draft state stay owned by the chat workspace", () => {
  assert.match(
    workspace,
    /const \[composer, setComposer\] = useState\(""\)[\s\S]+<ContextOverview/
  );
  assert.match(workspace, /\(\["automatic", "manual"\] as const\)\.map/);
  assert.match(
    workspace,
    /aria-pressed=\{conversation\?\.skill_mode === mode\}/
  );
  assert.match(workspace, /onToggleSuggested\(skill\.id\)/);
  assert.match(workspace, /onToggleSkill\(skill\.id\)/);
  assert.match(workspace, /placeholder="Pesquisar Skills"/);
  assert.match(workspace, /data-testid=\{`\$\{section\}-empty-state`\}/);
  assert.match(workspace, /aria-label=\{`Modo de seleção de \$\{sectionLabel/);
  assert.match(workspace, /aria-pressed=\{mode === "automatic"\}/);
});

test("streaming scroll follows only users who remain near the thread end", () => {
  assert.match(workspace, /userNearBottomRef/);
  assert.match(
    workspace,
    /thread\.scrollHeight - thread\.scrollTop - thread\.clientHeight < 120/
  );
  assert.match(workspace, /if \(userNearBottomRef\.current\)/);
  assert.match(workspace, /threadRef\.current\?\.scrollTo/);
  assert.match(workspace, /behavior: streaming \? "auto" : "smooth"/);
  assert.match(workspace, /onScroll=\{handleThreadScroll\}/);
  assert.match(workspace, /userNearBottomRef\.current = true/);
});

function read(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}
