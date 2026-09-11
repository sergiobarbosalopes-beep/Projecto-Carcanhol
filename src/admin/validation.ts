import { z } from "zod";
import { SKILL_STATUSES } from "@/src/types/supabase";

export const GLOBAL_ASSUMPTIONS_MAX_LENGTH = 20_000;
export const SKILL_NAME_MAX_LENGTH = 120;
export const SKILL_DESCRIPTION_MAX_LENGTH = 500;
export const SKILL_CONTENT_MAX_LENGTH = 50_000;
export const SKILLS_PAGE_SIZE = 20;

export const globalAssumptionsSchema = z
  .object({
    content: z.string().max(GLOBAL_ASSUMPTIONS_MAX_LENGTH),
  })
  .strict();

export const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1).max(4096),
    password: z.string().min(8).max(128),
    confirmation: z.string().min(8).max(128),
  })
  .strict()
  .refine(({ password, confirmation }) => password === confirmation, {
    path: ["confirmation"],
    message: "As palavras-passe não coincidem.",
  });

export const skillFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(SKILL_NAME_MAX_LENGTH),
    description: z.string().trim().max(SKILL_DESCRIPTION_MAX_LENGTH),
    content_markdown: z.string().max(SKILL_CONTENT_MAX_LENGTH),
  })
  .strict();

export const createSkillSchema = skillFieldsSchema.extend({
  status: z.enum(SKILL_STATUSES).default("draft"),
});

export const updateSkillSchema = z.discriminatedUnion("action", [
  skillFieldsSchema.extend({
    action: z.literal("update"),
  }),
  z.object({
    action: z.literal("activate"),
  }),
  z.object({
    action: z.literal("deactivate"),
  }),
  z.object({
    action: z.literal("archive"),
  }),
  z.object({
    action: z.literal("restore"),
  }),
]);

export const deleteSkillSchema = z
  .object({
    confirmationName: z.string().max(SKILL_NAME_MAX_LENGTH),
  })
  .strict();

export const skillIdSchema = z.string().uuid();

export const listSkillsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  query: z.string().trim().max(100).default(""),
  status: z.enum([...SKILL_STATUSES, "all"]).default("all"),
});
