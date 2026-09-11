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
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
};
