import { z } from 'zod';

export const emailSchema = z.string().email().max(255);
export const passwordSchema = z.string().min(8).max(128);
export const displayNameSchema = z.string().min(1).max(80);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1),
});

export const workspaceSchema = z.object({
  name: z.string().min(1).max(80),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
});

export const channelSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9-_]+$/),
  description: z.string().max(500).optional().default(''),
  isPrivate: z.boolean().optional().default(false),
});

export const messageSchema = z.object({
  content: z.string().min(1).max(8000),
  parentMessageId: z.string().min(1).nullable().optional(),
});

export function validate(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const err = new Error('Validation failed');
    err.status = 400;
    err.details = result.error.flatten();
    throw err;
  }
  return result.data;
}

// ---- Phase 3: workspaces ----
export const roleSchema = z.enum(['owner', 'admin', 'moderator', 'member', 'guest', 'bot']);

export const workspaceCreateSchema = z.object({
  name: z.string().min(1).max(80),
  slug: z.string().min(2).max(40).regex(/^[a-z0-9-]+$/).optional(),
});

export const workspacePatchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  iconUrl: z.string().url().max(500).nullable().optional(),
});

export const inviteCreateSchema = z.object({
  email: z.string().email().max(255).optional(),
  role: roleSchema.optional().default('member'),
});

export const joinSchema = z.object({
  token: z.string().min(8),
});

export const memberRoleSchema = z.object({
  role: roleSchema,
});

// ---- Phase 4: channels ----
export const channelCreateSchema = z.object({
  name: z.string().min(1).max(40).regex(/^[a-z0-9-_]+$/),
  description: z.string().max(500).optional().default(''),
  topic: z.string().max(250).optional().default(''),
  isPrivate: z.boolean().optional().default(false),
});

export const channelPatchSchema = z.object({
  name: z.string().min(1).max(40).regex(/^[a-z0-9-_]+$/).optional(),
  description: z.string().max(500).optional(),
  topic: z.string().max(250).optional(),
});

export const channelMemberAddSchema = z.object({
  userId: z.string().min(1),
});

// ---- Phase 5: messaging ----
export const messageCreateSchema = z.object({
  content: z.string().min(1).max(8000),
  parentMessageId: z.string().min(1).nullable().optional(),
  mentions: z.array(z.string().min(1)).max(50).optional().default([]),
  attachmentIds: z.array(z.string().min(1)).max(5).optional().default([]),
});

export const messagePatchSchema = z.object({
  content: z.string().min(1).max(8000),
});

export const reactionSchema = z.object({
  emoji: z.string().min(1).max(32),
});

export const readSchema = z.object({
  lastReadMessageId: z.string().min(1),
});

export const messagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(30),
  before: z.string().min(1).optional(),
});

// ---- Phase 7: files ----
export const filePresignSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(127).optional().default('application/octet-stream'),
  size: z.number().int().min(1).max(500 * 1024 * 1024).optional(),
});

export const fileConfirmSchema = z.object({
  size: z.number().int().min(1).optional(),
  checksum: z.string().max(64).optional(),
});

export const fileShareSchema = z.object({
  channelId: z.string().min(1),
  content: z.string().max(8000).optional(),
  parentMessageId: z.string().min(1).nullable().optional(),
});

// ---- Phase 9: direct messages ----
export const dmCreateSchema = z.object({
  userIds: z.array(z.string().min(1)).min(1).max(20),
  name: z.string().min(1).max(80).optional(),
});

export const dmPatchSchema = z.object({
  name: z.string().min(1).max(80),
});

export const dmMemberAddSchema = z.object({
  userId: z.string().min(1),
});

export const dmMessageCreateSchema = z.object({
  content: z.string().min(1).max(8000),
  parentMessageId: z.string().min(1).nullable().optional(),
  mentions: z.array(z.string().min(1)).max(50).optional().default([]),
  attachmentIds: z.array(z.string().min(1)).max(5).optional().default([]),
});

export const dmReadSchema = z.object({
  lastReadMessageId: z.string().min(1),
});

export const dmMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(30),
  before: z.string().min(1).optional(),
});

// ---- Phase 11: advanced ----
// A. Calls
export const callCreateSchema = z.object({
  channelId: z.string().min(1).nullable().optional(),
  dmConversationId: z.string().min(1).nullable().optional(),
});
export const callMediaSchema = z.object({
  muted: z.boolean().optional(),
  cameraOff: z.boolean().optional(),
  sharing: z.boolean().optional(),
});
// B. Canvas
export const canvasCreateSchema = z.object({
  title: z.string().min(1).max(200).optional().default('Untitled canvas'),
  channelId: z.string().min(1).nullable().optional(),
});
export const canvasPatchSchema = z.object({ title: z.string().min(1).max(200) });
export const canvasBlockSchema = z.object({
  id: z.string().min(1).optional(),
  kind: z.enum(['paragraph', 'heading', 'checklist', 'code', 'image', 'table']).optional().default('paragraph'),
  content: z.string().max(20000).optional().default(''),
  data: z.record(z.unknown()).optional().default({}),
  position: z.number().optional().default(0),
  version: z.number().int().min(1).optional(),
  delete: z.boolean().optional().default(false),
});
export const canvasBlocksSchema = z.object({ blocks: z.array(canvasBlockSchema).max(200) });
export const canvasCommentSchema = z.object({
  content: z.string().min(1).max(4000),
  blockId: z.string().min(1).nullable().optional(),
});
// C. Bots
export const botCreateSchema = z.object({ name: z.string().min(1).max(80) });
export const botCommandSchema = z.object({
  command: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/),
  description: z.string().max(200).optional().default(''),
  responseTemplate: z.string().max(4000).optional().default(''),
  buttons: z.array(z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(80) })).max(5).optional().default([]),
});
export const botMessageSchema = z.object({
  channelId: z.string().min(1).nullable().optional(),
  dmConversationId: z.string().min(1).nullable().optional(),
  content: z.string().min(1).max(8000),
});
export const botCallbackSchema = z.object({
  messageId: z.string().min(1),
  action: z.string().min(1).max(80),
});
// D. Integrations
export const integrationCreateSchema = z.object({
  name: z.string().min(1).max(80),
  provider: z.string().max(40).optional().default('custom'),
  channelId: z.string().min(1).nullable().optional(),
});
export const subscriptionSchema = z.object({
  url: z.string().url().max(500),
  events: z.array(z.string().max(60)).min(1).max(20).optional().default(['message.created']),
});
// E. Workflows
export const workflowCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional().default(''),
  trigger: z.record(z.unknown()).optional().default({}),
  steps: z.array(z.object({ kind: z.string().min(1).max(40), config: z.record(z.unknown()).optional().default({}) })).max(20).optional().default([]),
});
export const workflowRunSchema = z.object({ inputs: z.record(z.unknown()).optional().default({}) });
export const onboardingSchema = z.object({
  newUserEmail: z.string().email().max(255),
  channelName: z.string().min(1).max(40).regex(/^[a-z0-9-_]+$/).optional().default('onboarding'),
  hrUserId: z.string().min(1).nullable().optional(),
});

// ---- Phase 8: search ----
export const searchTypeSchema = z.enum(['messages', 'users', 'channels', 'files', 'all']);

export const searchQuerySchema = z.object({
  q: z.string().min(1).max(500),
  workspaceId: z.string().min(1),
  type: searchTypeSchema.optional().default('all'),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  cursor: z.string().max(64).optional(),
});
