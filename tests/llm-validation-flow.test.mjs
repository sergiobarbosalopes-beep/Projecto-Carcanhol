import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AUTO_VALIDATION_MAX_ACCOUNTS,
  createRequestCoalescer,
  runBoundedAccountValidation,
} from "../src/admin/llm-auto-validation.ts";
import { persistOnlyAfterValidation } from "../src/admin/validated-account-creation.ts";

test("does not persist an account when real validation fails", async () => {
  let persisted = false;
  const result = await persistOnlyAfterValidation({
    validate: async () => ({ ok: false, code: "invalid_token" }),
    persist: async () => {
      persisted = true;
      return "created";
    },
  });

  assert.deepEqual(result, { ok: false, code: "invalid_token" });
  assert.equal(persisted, false);
});

test("persists only the sanitized models returned by successful validation", async () => {
  const models = [{ id: "gpt-5" }];
  const result = await persistOnlyAfterValidation({
    validate: async () => ({ ok: true, models }),
    persist: async (validatedModels) => {
      assert.equal(validatedModels, models);
      return "created";
    },
  });

  assert.deepEqual(result, { ok: true, value: "created" });
});

test("coalesces concurrent validation requests for the same account", async () => {
  const coalescer = createRequestCoalescer();
  let calls = 0;
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const first = coalescer.run("account-1", async () => {
    calls += 1;
    await blocked;
    return "done";
  });
  const second = coalescer.run("account-1", async () => {
    calls += 1;
    return "duplicate";
  });

  assert.equal(first, second);
  release();
  assert.equal(await first, "done");
  assert.equal(calls, 1);

  assert.equal(
    await coalescer.run("account-1", async () => {
      calls += 1;
      return "new-entry";
    }),
    "new-entry"
  );
  assert.equal(calls, 2);
});

test("auto-validation is capped and uses low concurrency", async () => {
  const accountIds = Array.from(
    { length: 25 },
    (_, index) => `account-${index}`
  );
  const started = [];
  const completed = [];
  let active = 0;
  let maximumActive = 0;

  await runBoundedAccountValidation({
    accountIds,
    concurrency: 2,
    timeoutMs: 5_000,
    onStart: (accountId) => started.push(accountId),
    onResult: (accountId) => completed.push(accountId),
    onError: () => assert.fail("Validation should not fail."),
    validate: async (accountId) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return accountId;
    },
  });

  assert.equal(started.length, AUTO_VALIDATION_MAX_ACCOUNTS);
  assert.equal(completed.length, AUTO_VALIDATION_MAX_ACCOUNTS);
  assert.equal(maximumActive, 2);
});

test("migration 0005 atomically syncs models and rejects stale writes", () => {
  const migration = readFileSync(
    new URL(
      "../database/migrations/0005_github_copilot_validation.sql",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(migration, /\bbegin;[\s\S]+commit;\s*$/);
  assert.match(migration, /create_validated_llm_account/);
  assert.match(migration, /perform carcanhol\.sync_llm_model_catalog/);
  assert.match(
    migration,
    /last_validation_request_id = p_validation_request_id[\s\S]+validation_generation = p_validation_generation/
  );
  assert.match(migration, /enabled = false,[\s\S]+is_stale = true/);
  assert.match(migration, /llm_accounts_require_current_models/);
  assert.match(migration, /llm_models_preserve_active_account/);
  assert.match(
    migration,
    /drop function if exists carcanhol\.create_llm_account_with_secret/
  );

  const repository = readFileSync(
    new URL("../src/admin/llm-accounts.ts", import.meta.url),
    "utf8"
  );
  assert.match(repository, /data: applied/);
  assert.match(repository, /if \(!applied\)/);
  assert.match(repository, /LlmValidationSupersededError/);
});

test("LLM cards expose accessible manual and automatic validation states", () => {
  const panel = readFileSync(
    new URL("../app/(protected)/administracao/llm-panel.tsx", import.meta.url),
    "utf8"
  );

  assert.match(panel, /runBoundedAccountValidation/);
  assert.match(panel, /Validar novamente/);
  assert.match(panel, /A validar…/);
  assert.match(panel, /aria-busy=\{validatingIds\.has\(account\.id\)\}/);
  assert.match(panel, /aria-live="polite"/);
});
