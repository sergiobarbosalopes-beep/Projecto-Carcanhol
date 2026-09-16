import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AUTO_VALIDATION_MAX_ACCOUNTS,
  createRequestCoalescer,
  isAutomaticLlmRefreshDue,
  runBoundedAccountValidation,
} from "../src/admin/llm-auto-validation.ts";
import { persistOnlyAfterValidation } from "../src/admin/validated-account-creation.ts";
import { isTransientLlmValidationError } from "../src/admin/llm-validation-guidance.ts";

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
  const quota = { status: "unavailable" };
  const result = await persistOnlyAfterValidation({
    validate: async () => ({ ok: true, models, quota }),
    persist: async (validatedModels, validatedQuota) => {
      assert.equal(validatedModels, models);
      assert.equal(validatedQuota, quota);
      return "created";
    },
  });

  assert.deepEqual(result, { ok: true, value: "created" });
});

test("refresh TTL avoids repeated automatic provider calls", () => {
  const now = Date.parse("2026-09-16T09:00:00Z");

  assert.equal(isAutomaticLlmRefreshDue(null, now), true);
  assert.equal(isAutomaticLlmRefreshDue("2026-09-16T08:44:59Z", now), true);
  assert.equal(isAutomaticLlmRefreshDue("2026-09-16T08:50:00Z", now), false);
  assert.equal(isAutomaticLlmRefreshDue("invalid", now), true);
});

test("distinguishes transient infrastructure failures from credential failures", () => {
  for (const code of ["timeout", "unavailable", "unknown"]) {
    assert.equal(isTransientLlmValidationError(code), true, code);
  }

  for (const code of [
    "invalid_token",
    "no_subscription",
    "org_policy_blocked",
    "no_models",
  ]) {
    assert.equal(isTransientLlmValidationError(code), false, code);
  }
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

test("migrations atomically sync models and preserve transient catalogs", () => {
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
  const transientMigration = readFileSync(
    new URL(
      "../database/migrations/0006_preserve_transient_validation_catalog.sql",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(transientMigration, /\bbegin;[\s\S]+commit;\s*$/);
  assert.match(
    transientMigration,
    /create or replace function carcanhol\.apply_llm_account_validation/
  );
  const definitiveFailureStart = transientMigration.search(
    /if applied\s+and p_error_code in/
  );
  assert.notEqual(definitiveFailureStart, -1);
  const definitiveFailureMutation = transientMigration.slice(
    definitiveFailureStart,
    transientMigration.indexOf("end if;", definitiveFailureStart)
  );
  assert.match(definitiveFailureMutation, /invalid_token/);
  assert.match(definitiveFailureMutation, /no_subscription/);
  assert.doesNotMatch(definitiveFailureMutation, /timeout/);
  assert.doesNotMatch(definitiveFailureMutation, /unavailable/);
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

test("migration atomically enforces owned eligible global defaults and quota lifecycle", () => {
  const migration = readFileSync(
    new URL(
      "../database/migrations/0007_llm_defaults_and_provider_quota.sql",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(migration, /\bbegin;[\s\S]+commit;\s*$/);
  assert.match(
    migration,
    /create table if not exists carcanhol\.llm_model_preferences/
  );
  assert.match(migration, /where scope = 'global'/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(
    migration,
    /set_global_llm_default[\s\S]+security definer[\s\S]+set search_path = ''/
  );
  assert.match(
    migration,
    /model\.user_id = p_user_id[\s\S]+not model\.is_stale[\s\S]+account\.status = 'active'/
  );
  assert.match(migration, /\(select auth\.uid\(\)\) is null/);
  assert.match(
    migration,
    /p_user_id is distinct from \(select auth\.uid\(\)\)/
  );
  assert.match(
    migration,
    /clear_ineligible_llm_preferences[\s\S]+security definer[\s\S]+pg_advisory_xact_lock/
  );
  assert.match(
    migration,
    /grant select on carcanhol\.llm_model_preferences to authenticated/
  );
  assert.doesNotMatch(
    migration,
    /grant select,\s*insert,\s*delete on carcanhol\.llm_model_preferences/
  );
  assert.match(migration, /delete from carcanhol\.llm_model_preferences/);
  assert.match(migration, /on delete cascade/);
  assert.match(migration, /llm_models_clear_ineligible_preferences/);
  assert.match(migration, /llm_accounts_clear_ineligible_preferences/);
  assert.match(
    migration,
    /create table if not exists carcanhol\.llm_account_quotas/
  );
  assert.match(migration, /metric = 'premium_interactions'/);
  assert.match(migration, /included_units numeric\(18, 6\)/);
  assert.match(migration, /used_units numeric\(18, 6\)/);
  assert.match(migration, /remaining_units numeric\(18, 6\)/);
  assert.match(migration, /overage_units numeric\(18, 6\)/);
  assert.doesNotMatch(migration, /included_requests bigint/);
  assert.match(migration, /status in \('available', 'unavailable', 'stale'\)/);
  assert.match(migration, /provider_validation_failed/);
  assert.match(migration, /credential_changed/);
  assert.doesNotMatch(migration, /\braw_(?:error|body|headers|token)\b/i);

  const route = readFileSync(
    new URL("../app/api/admin/llm-default/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(route, /rejectCrossOrigin\(request\)/);
  assert.match(route, /requireAuthorizedUser/);
  assert.match(route, /setGlobalLlmDefault\(\s*user\.id/);
  assert.doesNotMatch(route, /body\.userId|input\.data\.userId/);
});

test("authenticated and service clients share the allowlisted database schema", () => {
  const databaseSource = readFileSync(
    new URL("../src/database/server.ts", import.meta.url),
    "utf8"
  );
  const envSource = readFileSync(
    new URL("../src/utils/env.ts", import.meta.url),
    "utf8"
  );

  assert.match(databaseSource, /getDatabaseEnv\(\)/);
  assert.match(databaseSource, /schema: SUPABASE_SCHEMA as "carcanhol"/g);
  assert.match(envSource, /\^carcanhol\(\?:_\[a-z0-9_\]\{1,40\}\)\?\$/);
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
  assert.match(panel, /catálogo preservado; conta indisponível/);
  assert.match(panel, /function ModelCatalogSection/);
  assert.match(panel, /Modelos disponíveis/);
  assert.match(panel, /account\.models\.map/);
  assert.match(panel, /model\.provider_model_id/);
  assert.match(panel, /maxContextWindowTokens/);
  assert.match(panel, /Fornecedor:/);
  assert.match(panel, /Conta:/);
  assert.match(panel, /★ Predefinido/);
  assert.match(panel, /Definir como predefinido/);
  assert.match(panel, /Utilização do GitHub Copilot/);
  assert.match(panel, /premium_interactions/);
  assert.match(panel, /créditos de IA ou\s+pedidos/);
  assert.match(panel, /Créditos de IA ou pedidos premium, conforme o plano/);
  assert.match(panel, /% disponível/);
  assert.match(panel, /restantes/);
  assert.match(panel, /Próxima reposição/);
  assert.match(panel, /quota\.reset_at !== null/);
  assert.match(panel, /account-wide/);
  assert.match(panel, /Quota ilimitada/);
  assert.match(panel, /Desatualizado/);
  assert.doesNotMatch(panel, /autorização pendente/);
  assert.doesNotMatch(panel, /Utilização de tokens no ciclo/);
  assert.doesNotMatch(panel, /function FutureSection/);
});

test("safe diagnostics are ephemeral and limited to owned revalidation responses", () => {
  const repository = readFileSync(
    new URL("../src/admin/llm-accounts.ts", import.meta.url),
    "utf8"
  );
  const provider = readFileSync(
    new URL("../src/admin/llm-provider-validation.ts", import.meta.url),
    "utf8"
  );
  const validationRoute = readFileSync(
    new URL(
      "../app/api/admin/llm-accounts/[id]/validate/route.ts",
      import.meta.url
    ),
    "utf8"
  );
  const listRoute = readFileSync(
    new URL("../app/api/admin/llm-accounts/route.ts", import.meta.url),
    "utf8"
  );
  const types = readFileSync(
    new URL("../src/types/supabase.ts", import.meta.url),
    "utf8"
  );
  const panel = readFileSync(
    new URL("../app/(protected)/administracao/llm-panel.tsx", import.meta.url),
    "utf8"
  );
  const migrations = [
    "0005_github_copilot_validation.sql",
    "0006_preserve_transient_validation_catalog.sql",
  ]
    .map((file) =>
      readFileSync(
        new URL(`../database/migrations/${file}`, import.meta.url),
        "utf8"
      )
    )
    .join("\n");

  assert.match(provider, /result\.code === "unknown"/);
  assert.match(provider, /result\.code === "unavailable"/);
  assert.match(provider, /result\.code === "timeout"/);
  assert.match(provider, /result\.diagnostic/);
  assert.match(repository, /diagnostic: validation\.diagnostic/);
  assert.match(repository, /validation\.code === "unavailable"/);
  assert.match(repository, /validation\.code === "timeout"/);
  assert.match(validationRoute, /requireAuthorizedUser/);
  assert.match(validationRoute, /jsonSuccess\(validation\)/);
  assert.doesNotMatch(listRoute, /diagnostic/);
  assert.doesNotMatch(types, /diagnostic/);
  assert.doesNotMatch(panel, /diagnostic/);
  assert.doesNotMatch(
    migrations,
    /\bp_diagnostic\b|\bdiagnostic\s+(?:jsonb|text)\b/i
  );
  assert.doesNotMatch(repository, /p_diagnostic/);
});
