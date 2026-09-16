import { z } from "zod";

export const CHAT_MAX_MESSAGE_LENGTH = 4_000;
export const CHAT_MAX_TITLE_LENGTH = 120;
export const CHAT_MAX_SKILLS = 20;
export const CHAT_STREAM_PROTOCOL_VERSION = 1;

const uuidSchema = z.string().uuid();

export const chatSkillModeSchema = z.enum(["manual", "automatic"]);

export const createConversationSchema = z
  .object({
    accountModelId: uuidSchema.optional(),
  })
  .strict();

export const updateConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(CHAT_MAX_TITLE_LENGTH).optional(),
    accountModelId: uuidSchema.optional(),
    skillMode: chatSkillModeSchema.optional(),
    skillIds: z.array(uuidSchema).max(CHAT_MAX_SKILLS).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

export const chatTurnSchema = z
  .object({
    conversationId: uuidSchema,
    accountModelId: uuidSchema,
    clientRequestId: uuidSchema,
    expectedVersion: z.number().int().nonnegative(),
    content: z.string().trim().min(1).max(CHAT_MAX_MESSAGE_LENGTH),
    skillMode: chatSkillModeSchema,
    skillIds: z.array(uuidSchema).max(CHAT_MAX_SKILLS),
    automaticSelectionConfirmed: z.boolean(),
    retryAssistantMessageId: uuidSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.skillMode === "automatic" && !value.automaticSelectionConfirmed) {
      context.addIssue({
        code: "custom",
        path: ["automaticSelectionConfirmed"],
        message: "Automatic Skill suggestions must be confirmed.",
      });
    }
  });

export const skillSuggestionRequestSchema = z
  .object({
    conversationId: uuidSchema,
    accountModelId: uuidSchema,
    prompt: z.string().trim().min(1).max(CHAT_MAX_MESSAGE_LENGTH),
  })
  .strict();

export const skillSuggestionOutputSchema = z
  .object({
    suggestions: z
      .array(
        z
          .object({
            id: uuidSchema,
            reason: z.string().trim().min(1).max(240),
          })
          .strict()
      )
      .max(CHAT_MAX_SKILLS),
  })
  .strict();

export const publicChatStreamEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      v: z.literal(CHAT_STREAM_PROTOCOL_VERSION),
      type: z.literal("start"),
      conversationId: uuidSchema,
      userMessageId: uuidSchema,
      assistantMessageId: uuidSchema,
      conversationVersion: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      v: z.literal(CHAT_STREAM_PROTOCOL_VERSION),
      type: z.literal("delta"),
      assistantMessageId: uuidSchema,
      sequence: z.number().int().positive(),
      text: z.string().min(1).max(16_000),
    })
    .strict(),
  z
    .object({
      v: z.literal(CHAT_STREAM_PROTOCOL_VERSION),
      type: z.literal("done"),
      assistantMessageId: uuidSchema,
      content: z.string().min(1).max(110_000),
      usage: z
        .object({
          inputTokens: z.number().int().nonnegative(),
          outputTokens: z.number().int().nonnegative(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      v: z.literal(CHAT_STREAM_PROTOCOL_VERSION),
      type: z.literal("error"),
      assistantMessageId: uuidSchema.optional(),
      code: z.enum([
        "cancelled",
        "timeout",
        "provider_unavailable",
        "invalid_response",
        "stream_interrupted",
        "conflict",
      ]),
      message: z.string().min(1).max(240),
    })
    .strict(),
  z
    .object({
      v: z.literal(CHAT_STREAM_PROTOCOL_VERSION),
      type: z.literal("heartbeat"),
    })
    .strict(),
]);

export type PublicChatStreamEvent = z.infer<typeof publicChatStreamEventSchema>;
