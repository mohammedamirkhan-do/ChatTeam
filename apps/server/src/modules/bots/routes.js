import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { findOne, insertOne, updateOne, deleteOne, find } from '../../database/db.js';
import { requireAuth } from '../../common/auth.js';
import { requireWorkspace, requirePermission } from '../workspaces/permissions.js';
import { botCreateSchema, botCommandSchema, botMessageSchema, botCallbackSchema, validate } from '@teamchat/validation';
import { executeSlash, postBotMessage } from './commands.js';

export const botsRouter = Router();

export function publicBot(b) {
  return { id: b.id, workspaceId: b.workspace_id, userId: b.user_id, name: b.name, createdAt: b.created_at };
}

// Bot identity: a real users row (threads/reactions/search just work) with a
// workspace 'bot' role, driven by an opaque token (sha256 stored).
async function createBotUser(workspaceId, name, creatorId) {
  const email = `bot-${randomBytes(6).toString('hex')}@bots.local`;
  const user = await insertOne('users', { email, password_hash: '!', display_name: name, status: 'ONLINE' });
  await insertOne('workspace_members', { workspace_id: workspaceId, user_id: user.id, role: 'bot', invited_by: creatorId });
  return user;
}

// POST /workspaces/:wid/bots {name} — MANAGE_INTEGRATIONS (Slack: apps need admin).
botsRouter.post('/workspaces/:wid/bots', requireAuth, requireWorkspace, requirePermission('MANAGE_INTEGRATIONS'), async (req, res, next) => {
  try {
    const { name } = validate(botCreateSchema, req.body);
    const user = await createBotUser(req.workspace.id, name, req.user.id);
    const token = randomBytes(32).toString('hex');
    const bot = await insertOne('bots', { workspace_id: req.workspace.id, user_id: user.id, name, token_hash: createHash('sha256').update(token).digest('hex'), created_by: req.user.id });
    res.status(201).json({ bot: publicBot(bot), token });
  } catch (e) {
    next(e);
  }
});

// GET /workspaces/:wid/bots
botsRouter.get('/workspaces/:wid/bots', requireAuth, requireWorkspace, async (req, res, next) => {
  try {
    const rows = await find('bots', { workspace_id: req.workspace.id });
    res.json({ bots: rows.map(publicBot) });
  } catch (e) {
    next(e);
  }
});

// POST /bots/:id/commands — register /<command> (Slack slash registration).
botsRouter.post('/bots/:id/commands', requireAuth, async (req, res, next) => {
  try {
    const bot = await findOne('bots', { id: req.params.id });
    if (!bot) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bot not found' } });
    const mem = await findOne('workspace_members', { workspace_id: bot.workspace_id, user_id: req.user.id });
    if (!mem) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not a workspace member' } });
    const { hasPermission } = await import('../workspaces/permissions.js');
    if (!(await hasPermission(bot.workspace_id, req.user.id, 'MANAGE_INTEGRATIONS'))) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Requires MANAGE_INTEGRATIONS' } });
    const cmd = validate(botCommandSchema, req.body);
    const existing = await findOne('bot_commands', { bot_id: bot.id, command: cmd.command });
    let row;
    if (existing) {
      await updateOne('bot_commands', { bot_id: bot.id, command: cmd.command }, { $set: { description: cmd.description, response_template: cmd.responseTemplate, buttons: JSON.stringify(cmd.buttons) } });
      row = await findOne('bot_commands', { bot_id: bot.id, command: cmd.command });
    } else {
      row = await insertOne('bot_commands', { bot_id: bot.id, command: cmd.command, description: cmd.description, response_template: cmd.responseTemplate, buttons: JSON.stringify(cmd.buttons) });
    }
    res.status(201).json({ command: row });
  } catch (e) {
    next(e);
  }
});

function botAuth(req, res, next) {
  const token = req.headers['x-bot-token'];
  if (!token) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'x-bot-token required' } });
  findOne('bots', { token_hash: createHash('sha256').update(String(token)).digest('hex') })
    .then((bot) => {
      if (!bot) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Bad bot token' } });
      req.bot = bot;
      next();
    })
    .catch(next);
}

// POST /bots/:id/messages — external services post as the bot (token auth).
botsRouter.post('/bots/:id/messages', botAuth, async (req, res, next) => {
  try {
    if (req.bot.id !== req.params.id) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Token mismatch' } });
    const { channelId, dmConversationId, content } = validate(botMessageSchema, req.body);
    if (!!channelId === !!dmConversationId) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Exactly one target required' } });
    }
    const out = await postBotMessage(req.bot, { channelId, dmConversationId, content });
    res.status(201).json({ message: out });
  } catch (e) {
    next(e);
  }
});

// POST /bots/callbacks {messageId, action} — interactive button clicks.
botsRouter.post('/bots/callbacks', requireAuth, async (req, res, next) => {
  try {
    const { messageId, action } = validate(botCallbackSchema, req.body);
    const btn = await findOne('message_buttons', { message_id: messageId, action_id: action });
    if (!btn) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown button' } });
    const { getMessage } = await import('../messages/service.js');
    const msg = await getMessage(messageId);
    if (!msg) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Message not found' } });
    const home = msg.dm_conversation_id
      ? { dmConversationId: msg.dm_conversation_id }
      : { channelId: msg.channel_id };
    // Attribute the click to whoever owns the button's bot.
    const bot = await findOne('bots', { user_id: msg.sender_id });
    const who = req.user.display_name;
    const text = bot
      ? `👆 ${who} clicked *${btn.label}*`
      : `👆 ${who} clicked *${btn.label}*`;
    if (bot) {
      await postBotMessage(bot, { ...home, content: text });
    }
    res.json({ ok: true, label: btn.label });
  } catch (e) {
    next(e);
  }
});

// Slash entry shared by channel + DM send paths (see commands.js).
export { executeSlash };
