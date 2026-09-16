import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("inference contract accepts the authorized probe and rejects client-controlled extras", () => {
  const contract = readFileSync(
    new URL("../services/copilot-worker/src/contract.ts", import.meta.url),
    "utf8"
  );

  assert.match(contract, /COPILOT_INFERENCE_MAX_PROMPT_LENGTH = 500/);
  assert.match(
    contract,
    /copilotInferenceRequestSchema[\s\S]+prompt: copilotInferencePromptSchema/
  );
  assert.match(contract, /copilotInferenceRequestSchema[\s\S]+\.strict\(\)/);
  assert.match(contract, /model: boundedLabelSchema/);
});

test("inference response permits only bounded text and safe usage fields", () => {
  const contract = readFileSync(
    new URL("../services/copilot-worker/src/contract.ts", import.meta.url),
    "utf8"
  );

  assert.match(contract, /COPILOT_INFERENCE_MAX_TEXT_LENGTH = 4_096/);
  assert.match(
    contract,
    /inputTokens: z\.number\(\)\.int\(\)\.nonnegative\(\)/
  );
  assert.match(
    contract,
    /outputTokens: z\.number\(\)\.int\(\)\.nonnegative\(\)/
  );
  assert.match(contract, /durationMs: z\.number\(\)\.int\(\)\.nonnegative\(\)/);
  assert.doesNotMatch(contract, /rawProviderResponse|rawError/);
});

test("BFF requires origin, auth, rate limits, and accepts only prompt", () => {
  const route = readFileSync(
    new URL("../app/api/llm/infer/route.ts", import.meta.url),
    "utf8"
  );

  assert.match(route, /rejectCrossOrigin\(request\)/);
  assert.match(route, /requireAuthorizedUser/);
  assert.match(route, /consumeUserAndIpRateLimit/);
  assert.match(route, /\.object\(\{\s*prompt:/);
  assert.match(route, /\.strict\(\)/);
  assert.doesNotMatch(
    route,
    /accountId|accountModelId|provider_model_id|token:/
  );
  assert.match(
    route,
    /runLlmInference\(user\.id, parsed\.data\.prompt, supabase\)/
  );
});

test("database resolver atomically requires an owned active current default", () => {
  const migration = readFileSync(
    new URL(
      "../database/migrations/0008_llm_inference_default.sql",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(migration, /\bbegin;[\s\S]+commit;\s*$/);
  assert.match(migration, /security definer[\s\S]+set search_path = ''/);
  assert.match(migration, /preference\.scope = 'global'/);
  assert.match(migration, /preference\.account_model_id = p_account_model_id/);
  assert.match(migration, /account\.status = 'active'/);
  assert.match(migration, /account\.last_validation_status = 'succeeded'/);
  assert.match(migration, /not model\.is_stale/);
  assert.match(migration, /account\.provider = 'github_copilot'/);
  assert.match(migration, /revoke all[\s\S]+public, anon, authenticated/);
  assert.match(migration, /grant execute[\s\S]+to service_role/);
});

test("BFF resolves and decrypts the server-selected model without persistence", () => {
  const domain = readFileSync(
    new URL("../src/llm/inference.ts", import.meta.url),
    "utf8"
  );

  assert.match(domain, /\.from\("llm_model_preferences"\)/);
  assert.match(domain, /\.eq\("user_id", userId\)/);
  assert.match(domain, /\.eq\("scope", "global"\)/);
  assert.match(domain, /createServiceRoleClient/);
  assert.match(domain, /\.rpc\("get_llm_inference_target"/);
  assert.match(domain, /target\.provider_model_id/);
  assert.match(domain, /decryptCredentialForValidation/);
  assert.match(domain, /finally \{\s*credential = "";/);
  assert.doesNotMatch(domain, /\bconsole\./);
  assert.doesNotMatch(domain, /\.insert\(|\.update\(|\.upsert\(/);
});
