import { findOne, insertOne, updateOne, deleteOne, find } from '../../database/db.js';
import { serializeMessage, getMessage, loadReactions, loadMentions, loadAttachments } from '../messages/service.js';
import { publish } from '../../websocket/index.js';

export async function postBotMessage(bot, { channelId = null, dmConversationId = null, content, buttons = [] }) {
  const msg = await insertOne('messages', { workspace_id: bot.workspace_id, channel_id: channelId, dm_conversation_id: dmConversationId, sender_id: bot.user_id, content, message_type: 'bot' });
  for (const b of buttons.slice(0, 5)) {
    await insertOne('message_buttons', { message_id: msg.id, action_id: b.id, label: b.label });
  }
  const full = await getMessage(msg.id);
  const [reactions, mentions, attachments] = await Promise.all([loadReactions([msg.id], bot.user_id), loadMentions([msg.id]), loadAttachments([msg.id])]);
  const buttonsRows = await find('message_buttons', { message_id: msg.id });
  const out = {
    ...serializeMessage(full, { reactions, mentionIds: mentions[msg.id] || [], attachments }),
    ...(dmConversationId ? { channelId: null, dmConversationId } : {}),
    buttons: buttonsRows,
  };
  const room = dmConversationId ? `dm:${dmConversationId}` : `channel:${channelId}`;
  const type = dmConversationId ? 'dm.message.created' : 'message.created';
  await publish({ type, payload: { message: out } }, [room]);
  return out;
}

function fill(template, vars) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_m, k) => vars[k] ?? '');
}

async function builtin(workspaceId, scope, user, name, args) {
  const at = scope.dmConversationId ? { dmConversationId: scope.dmConversationId } : { channelId: scope.channelId };
  if (name === 'meeting') {
    const sub = args[0] || 'create';
    if (sub !== 'create') return { text: `Usage: /meeting create [title]`, ephemeral: true };
    const title = args.slice(1).join(' ') || 'Quick sync';
    const call = await insertOne('calls', { workspace_id: workspaceId, channel_id: scope.channelId || null, dm_conversation_id: scope.dmConversationId || null, created_by: user.id });
    await insertOne('call_participants', { call_id: call.id, user_id: user.id });
    await publish({ type: 'call.started', payload: { call: { id: call.id }, roster: [] } }, [`workspace:${workspaceId}`]);
    return {
      text: `📅 *${title}* — meeting created by ${user.display_name} (call \`${call.id.slice(0, 8)}\`)`,
      buttons: [{ id: 'join', label: 'Join' }],
      extra: { callId: call.id },
    };
  }
  if (name === 'github') {
    const [sub, env] = args;
    if (sub === 'deploy' && env) {
      return { text: `🚀 Deploying *${env}* — triggered by ${user.display_name} via /github` };
    }
    return { text: `Usage: /github deploy <env> — e.g. \`/github deploy production\``, ephemeral: true };
  }
  if (name === 'poll') {
    const [question, ...opts] = args.join(' ').split(';').map((s) => s.trim()).filter(Boolean);
    if (!question || !opts.length) return { text: `Usage: /poll question?; option A; option B`, ephemeral: true };
    return {
      text: `📊 *${question}* — vote below (posted by ${user.display_name})`,
      buttons: opts.slice(0, 5).map((o, i) => ({ id: `vote-${i}`, label: o })),
    };
  }
  return null;
}

export async function executeSlash({ workspaceId, scope, user, text }) {
  if (!text.startsWith('/')) return null;
  const [head, ...args] = text.slice(1).split(/\s+/);
  const name = (head || '').toLowerCase();
  if (!name) return null;

  const builtinRes = await builtin(workspaceId, scope, user, name, args);
  if (builtinRes) {
    if (builtinRes.ephemeral) return { handled: true, ephemeral: builtinRes.text };
    const bots = await find('bots', { workspace_id: workspaceId }, { sort: { created_at: 1 }, limit: 1 });
    const bot = bots[0] || await ensureHelperBot(workspaceId, user.id);
    const out = await postBotMessage(bot, { ...scope, content: builtinRes.text, buttons: builtinRes.buttons || [] });
    return { handled: true, message: out };
  }

  const cmds = await find('bot_commands', { command: name });
  if (!cmds.length) return null;
  let row = null;
  let bot = null;
  for (const c of cmds) {
    const b = await findOne('bots', { id: c.bot_id });
    if (b && b.workspace_id === workspaceId) { row = c; bot = b; break; }
  }
  if (!row) return null;
  let buttons = [];
  try {
    buttons = typeof row.buttons === 'string' ? JSON.parse(row.buttons) : row.buttons || [];
  } catch {}
  const out = await postBotMessage(bot, {
    ...scope,
    content: fill(row.response_template || `/${name} by ${user.display_name}`, { user: user.display_name, args: args.join(' ') }),
    buttons,
  });
  return { handled: true, message: out };
}

async function ensureHelperBot(workspaceId, creatorId) {
  const existing = await findOne('bots', { workspace_id: workspaceId, name: 'Slackbot' });
  if (existing) return existing;
  const { randomBytes, createHash } = await import('node:crypto');
  const email = `bot-${randomBytes(6).toString('hex')}@bots.local`;
  const user = await insertOne('users', { email, password_hash: '!', display_name: 'Slackbot', status: 'ONLINE' });
  await insertOne('workspace_members', { workspace_id: workspaceId, user_id: user.id, role: 'bot', invited_by: creatorId });
  return insertOne('bots', { workspace_id: workspaceId, user_id: user.id, name: 'Slackbot', token_hash: createHash('sha256').update(randomBytes(32)).digest('hex'), created_by: creatorId });
}
