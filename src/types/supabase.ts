/**
 * Minimal hand-written types for the "carcanhol" Postgres schema.
 *
 * These are intentionally lightweight for Phase 1 (Foundation). Once the
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

export type Database = {
  carcanhol: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: Partial<Profile> & { id: string };
        Update: Partial<Profile>;
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
};
