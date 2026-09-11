/**
 * Minimal hand-written types for the "carcanhol" Postgres schema.
 *
 * These are intentionally lightweight for the current phase. Once the
 * Supabase project is reachable, prefer regenerating this file with:
 *
 *   npx supabase gen types typescript --project-id <project-ref> --schema carcanhol > src/types/supabase.ts
 *
 * and then re-adding the manual augmentations below if still needed.
 */
import type {
  LLM_ACCOUNT_STATUSES,
  LLM_CREDENTIAL_TYPES,
  LLM_PROVIDERS,
} from "@/src/admin/llm-validation";

export type Profile = {
  id: string;
  email: string | null;
  created_at: string;
};

export type GlobalAssumptions = {
  user_id: string;
  content: string;
  created_at: string;
  updated_at: string;
};

export const SKILL_STATUSES = [
  "draft",
  "active",
  "inactive",
  "archived",
] as const;

export type SkillStatus = (typeof SKILL_STATUSES)[number];

export type Skill = {
  id: string;
  user_id: string;
  name: string;
  description: string;
  status: SkillStatus;
  content_markdown: string;
  created_at: string;
  updated_at: string;
};

export type LlmProvider = (typeof LLM_PROVIDERS)[number];
export type LlmCredentialType = (typeof LLM_CREDENTIAL_TYPES)[number];
export type LlmAccountStatus = (typeof LLM_ACCOUNT_STATUSES)[number];

export type LlmAccount = {
  id: string;
  user_id: string;
  provider: LlmProvider;
  display_name: string;
  credential_type: LlmCredentialType;
  status: LlmAccountStatus;
  custom_endpoint: string | null;
  credential_suffix: string;
  credential_updated_at: string;
  last_validation_status: "succeeded" | "failed" | null;
  last_validation_at: string | null;
  last_validation_error_code: string | null;
  created_at: string;
  updated_at: string;
};

export type LlmAccountPublic = Omit<
  LlmAccount,
  "user_id" | "credential_suffix"
> & {
  credential_hint: string;
};

type LlmAccountSecret = {
  account_id: string;
  user_id: string;
  aad_provider: string;
  ciphertext: string;
  nonce: string;
  auth_tag: string;
  algorithm: "aes-256-gcm";
  envelope_version: 1;
  key_version: string;
  credential_version: number;
  created_at: string;
  updated_at: string;
};

type LlmAccountModel = {
  id: string;
  user_id: string;
  account_id: string;
  provider_model_id: string;
  display_name: string;
  enabled: boolean;
  discovery_metadata: Record<string, unknown>;
  discovered_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
};

type LlmRoutingRule = {
  id: string;
  user_id: string;
  account_model_id: string;
  scope: "general" | "feature";
  feature_key: string | null;
  fallback_order: number;
  created_at: string;
  updated_at: string;
};

type LlmUsageEvent = {
  id: string;
  user_id: string;
  account_id: string;
  account_model_id: string | null;
  feature_key: string | null;
  status: "succeeded" | "failed" | "cancelled";
  input_tokens: number;
  output_tokens: number;
  latency_ms: number | null;
  estimated_cost: number | null;
  cost_currency: string | null;
  occurred_at: string;
  created_at: string;
};

export type Database = {
  carcanhol: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: Partial<Profile> & { id: string };
        Update: Partial<Profile>;
        Relationships: [];
      };
      global_assumptions: {
        Row: GlobalAssumptions;
        Insert: Pick<GlobalAssumptions, "user_id"> &
          Partial<Omit<GlobalAssumptions, "user_id">>;
        Update: Partial<Omit<GlobalAssumptions, "user_id" | "created_at">>;
        Relationships: [];
      };
      skills: {
        Row: Skill;
        Insert: Pick<Skill, "user_id" | "name"> &
          Partial<Omit<Skill, "id" | "user_id" | "name">>;
        Update: Partial<
          Omit<Skill, "id" | "user_id" | "created_at" | "updated_at">
        >;
        Relationships: [];
      };
      llm_accounts: {
        Row: LlmAccount;
        Insert: Pick<
          LlmAccount,
          | "user_id"
          | "provider"
          | "display_name"
          | "credential_type"
          | "credential_suffix"
        > &
          Partial<
            Omit<
              LlmAccount,
              | "user_id"
              | "provider"
              | "display_name"
              | "credential_type"
              | "credential_suffix"
            >
          >;
        Update: Partial<Omit<LlmAccount, "id" | "user_id" | "created_at">>;
        Relationships: [];
      };
      llm_account_secrets: {
        Row: LlmAccountSecret;
        Insert: Omit<
          LlmAccountSecret,
          "credential_version" | "created_at" | "updated_at"
        > &
          Partial<
            Pick<
              LlmAccountSecret,
              "credential_version" | "created_at" | "updated_at"
            >
          >;
        Update: Partial<
          Omit<LlmAccountSecret, "account_id" | "user_id" | "created_at">
        >;
        Relationships: [];
      };
      llm_account_models: {
        Row: LlmAccountModel;
        Insert: Pick<
          LlmAccountModel,
          "user_id" | "account_id" | "provider_model_id" | "display_name"
        > &
          Partial<
            Omit<
              LlmAccountModel,
              | "id"
              | "user_id"
              | "account_id"
              | "provider_model_id"
              | "display_name"
            >
          >;
        Update: Partial<
          Omit<LlmAccountModel, "id" | "user_id" | "account_id" | "created_at">
        >;
        Relationships: [];
      };
      llm_routing_rules: {
        Row: LlmRoutingRule;
        Insert: Pick<LlmRoutingRule, "user_id" | "account_model_id" | "scope"> &
          Partial<
            Omit<
              LlmRoutingRule,
              "id" | "user_id" | "account_model_id" | "scope"
            >
          >;
        Update: Partial<Omit<LlmRoutingRule, "id" | "user_id" | "created_at">>;
        Relationships: [];
      };
      llm_usage_events: {
        Row: LlmUsageEvent;
        Insert: Pick<LlmUsageEvent, "user_id" | "account_id" | "status"> &
          Partial<
            Omit<LlmUsageEvent, "id" | "user_id" | "account_id" | "status">
          >;
        Update: Partial<Omit<LlmUsageEvent, "id" | "user_id" | "created_at">>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      create_llm_account_with_secret: {
        Args: {
          p_account_id: string;
          p_user_id: string;
          p_provider: string;
          p_display_name: string;
          p_credential_type: string;
          p_custom_endpoint: string | null;
          p_credential_suffix: string;
          p_ciphertext: string;
          p_nonce: string;
          p_auth_tag: string;
          p_algorithm: string;
          p_envelope_version: number;
          p_key_version: string;
        };
        Returns: LlmAccount[];
      };
      rotate_llm_account_secret: {
        Args: {
          p_account_id: string;
          p_user_id: string;
          p_credential_suffix: string;
          p_ciphertext: string;
          p_nonce: string;
          p_auth_tag: string;
          p_algorithm: string;
          p_envelope_version: number;
          p_key_version: string;
        };
        Returns: LlmAccount[];
      };
    };
    Enums: Record<string, never>;
  };
};
