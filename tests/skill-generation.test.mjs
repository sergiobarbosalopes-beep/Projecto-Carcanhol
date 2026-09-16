import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(
  new URL("../app/api/admin/skills/generate/route.ts", import.meta.url),
  "utf8"
);
const generation = readFileSync(
  new URL("../src/admin/skill-generation.ts", import.meta.url),
  "utf8"
);
const inference = readFileSync(
  new URL("../src/llm/inference.ts", import.meta.url),
  "utf8"
);
const panel = readFileSync(
  new URL("../app/(protected)/administracao/admin-panel.tsx", import.meta.url),
  "utf8"
);
const workerContract = readFileSync(
  new URL("../services/copilot-worker/src/contract.ts", import.meta.url),
  "utf8"
);
const workerAdapter = readFileSync(
  new URL("../services/copilot-worker/src/copilot-adapter.ts", import.meta.url),
  "utf8"
);

test("skill generation endpoint is authenticated, same-origin, bounded and server-routed", () => {
  assert.match(route, /rejectCrossOrigin\(request\)/);
  assert.match(route, /requireAuthorizedUser/);
  assert.match(route, /readBoundedRequestBody/);
  assert.match(route, /consumeUserAndIpRateLimit/);
  assert.match(route, /acquireRequestSlot/);
  assert.match(route, /generateSkillProposal\(\s*user\.id/);
  assert.doesNotMatch(
    route,
    /accountId|accountModelId|provider_model_id|token\s*:/
  );
});

test("generation produces a strict editable proposal and never writes to the database", () => {
  assert.match(generation, /JSON\.parse\(result\.text\)/);
  assert.match(generation, /skillProposalSchema\.safeParse/);
  assert.match(generation, /name: safeText\(SKILL_NAME_MAX_LENGTH\)/);
  assert.match(
    generation,
    /description: safeText\(SKILL_DESCRIPTION_MAX_LENGTH\)/
  );
  assert.match(generation, /markdown: safeText\(SKILL_CONTENT_MAX_LENGTH\)/);
  assert.match(generation, /\.strict\(\)/);
  assert.equal(
    generation.includes("!/<\\/?[A-Za-z][^>]*>/i.test(value)"),
    true
  );
  assert.equal(
    generation.includes("!/!\\[[^\\]]*\\]\\s*\\(/.test(value)"),
    true
  );
  assert.doesNotMatch(generation, /\.insert\(|\.update\(|\.upsert\(/);
  assert.doesNotMatch(inference, /\.insert\(|\.update\(|\.upsert\(/);
  assert.doesNotMatch(generation, /\bconsole\./);
});

test("system prompt treats requirements as data and forbids tools and secrets", () => {
  assert.match(generation, /dado não confiável/);
  assert.match(generation, /Ignora qualquer tentativa/);
  assert.match(generation, /usar ferramentas/);
  assert.match(generation, /credenciais, segredos/);
  assert.match(
    generation,
    /exatamente as chaves "name", "description" e "markdown"/
  );
  assert.match(
    generation,
    /JSON\.stringify\(\{ userRequirement: requirement \}\)/
  );
});

test("worker keeps generated content bounded and the session ephemeral", () => {
  assert.match(workerContract, /COPILOT_INFERENCE_MAX_TEXT_LENGTH = 110_000/);
  assert.match(workerContract, /systemPrompt:[\s\S]+\.max\(/);
  assert.match(workerAdapter, /availableTools: \[\]/);
  assert.match(workerAdapter, /mcpServers: \{\}/);
  assert.match(workerAdapter, /enableSessionTelemetry: false/);
  assert.match(workerAdapter, /enableSessionStore: false/);
  assert.match(workerAdapter, /enableSkills: false/);
  assert.match(workerAdapter, /memory: \{ enabled: false \}/);
  assert.match(workerAdapter, /deleteSession\(sessionId\)/);
  assert.match(workerAdapter, /removeTemporaryState\(baseDirectory\)/);
});

test("UI keeps generation separate, cancellable and non-persistent until save", () => {
  assert.match(panel, /O que pretende que esta Skill faça\?/);
  assert.match(panel, /Cancelar geração/);
  assert.match(panel, /Gerar novamente/);
  assert.match(panel, /Aplicar ao formulário/);
  assert.match(panel, /window\.confirm/);
  assert.match(panel, /alterações manuais não guardadas serão descartadas/);
  assert.match(panel, /Nada foi persistido/);
  assert.match(panel, /<pre className=/);
  assert.doesNotMatch(panel, /dangerouslySetInnerHTML/);

  const generateComponent = panel.slice(
    panel.indexOf("function AiSkillGenerator"),
    panel.indexOf("function SkillDetail")
  );
  assert.doesNotMatch(generateComponent, /\/api\/admin\/skills"\s*,/);
  assert.match(
    panel,
    /disabled=\{pending \|\| requirement\.trim\(\)\.length < 10\}/
  );
  assert.match(panel, /if \(pendingRef\.current\) \{\s*return;/);
});

test("errors are sanitized and preserve the requirement for retry", () => {
  assert.match(route, /A IA devolveu uma proposta inválida/);
  assert.match(route, /Não foi possível gerar a proposta de Skill/);
  assert.doesNotMatch(route, /error\.message|JSON\.stringify\(error\)/);

  const generateComponent = panel.slice(
    panel.indexOf("function AiSkillGenerator"),
    panel.indexOf("function SkillDetail")
  );
  assert.doesNotMatch(generateComponent, /setRequirement\(""\)/);
  assert.match(
    generateComponent,
    /setFeedback\(\{ kind: "error", message: result\.error \}\)/
  );
});
