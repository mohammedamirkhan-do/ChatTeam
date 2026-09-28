import { Router } from 'express';
import { findOne, insertOne, updateOne, deleteOne, find, count } from '../../database/db.js';
import { requireAuth } from '../../common/auth.js';
import { hasPermission } from '../workspaces/permissions.js';
import { requireChannel } from '../channels/service.js';
import {
  serializeMessage,
  getMessage,
  accessMessage,
  loadReactions,
  loadMentions,
  loadAttachments,
  withButtons,
  resolveMentionEmails,
  filterWorkspaceMembers,
} from './service.js';
import {
  messageCreateSchema,
  messagePatchSchema,
  reactionSchema,
  readSchema,
  messagesQuerySchema,
  validate,
} from '@teamchat/validation';
import { publish } from '../../websocket/index.js';
import { notifyUser } from '../notifications/routes.js';
import { executeSlash } from '../bots/commands.js';
import { dispatchIntegrationEvent } from '../integrations/routes.js';

export const messagesRouter = Router();

const EDIT_WINDOW_MS = 24 * 3600 * 1000;

// POST /channels/:id/messages — members only (Slack: join to post).
messagesRouter.post('/channels/:id/messages', requireAuth, requireChannel, async (req, res, next) => {
  try {
    if (!req.channelRole) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Join the channel to post' } });
    if (req.channel.is_archived) return res.status(403).json({ error: { code: 'ARCHIVED', message: 'Channel is archived' } });
    const { content, parentMessageId, mentions, attachmentIds } = validate(messageCreateSchema, req.body);
    if (parentMessageId) {
      const parent = await findOne('messages', { id: parentMessageId, deleted_at: null });
      if (!parent || parent.channel_id !== req.channel.id) {
        return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Parent message not in this channel' } });
      }
    }
    const msg = await insertOne('messages', { workspace_id: req.channel.workspace_id, channel_id: req.channel.id, sender_id: req.user.id, parent_message_id: parentMessageId || null, content });
    const emailIds = await resolveMentionEmails(req.channel.workspace_id, content);
    const validIds = await filterWorkspaceMembers(req.channel.workspace_id, mentions);
    const all = [...new Set([...emailIds, ...validIds])].filter((id) => id !== req.user.id);
    for (const uid of all) {
      await insertOne('message_mentions', { message_id: msg.id, mentioned_user_id: uid });
    }
    // Link sender-owned, unattached files from this workspace (Slack attach flow).
    for (const fid of [...new Set(attachmentIds)]) {
      const f = await findOne('files', { id: fid, uploader_id: req.user.id, workspace_id: req.channel.workspace_id, message_id: null });
      if (!f) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Unknown or already-attached file' } });
      await updateOne('files', { id: fid }, { $set: { message_id: msg.id } });
      await insertOne('message_attachments', { message_id: msg.id, file_id: f.id, filename: f.filename, mime_type: f.mime_type, size: f.size, url: `/files/${f.id}`, thumb_url: f.thumb_storage_key ? `/files/${f.id}/thumb` : '', width: f.width, height: f.height });
    }
    const full = await getMessage(msg.id);
    const attachments = await loadAttachments([msg.id]);
    const out = serializeMessage(full, { mentionIds: all, attachments });
    await publish({ type: 'message.created', payload: { message: out } }, [`channel:${req.channel.id}`]);
    // Phase 11C: slash commands (Slack /command parity) + outgoing webhooks.
    let slash = null;
    if (content.startsWith('/')) {
      try {
        const r = await executeSlash({ workspaceId: req.channel.workspace_id, scope: { channelId: req.channel.id }, user: req.user, text: content });
        if (r?.handled) slash = r.ephemeral ? { ephemeral: r.ephemeral } : { message: r.message };
      } catch (err) {
        slash = { error: err.message };
      }
    }
    dispatchIntegrationEvent(req.channel.workspace_id, 'message.created', { message: out }).catch(() => {});
    // Notifications: mentions + thread replies (Slack rules).
    for (const uid of all) {
      await notifyUser(uid, req.channel.workspace_id, 'mention', msg.id);
    }
    if (parentMessageId) {
      const parent = await findOne('messages', { id: parentMessageId });
      if (parent && parent.sender_id !== req.user.id && !all.includes(parent.sender_id)) {
        await notifyUser(parent.sender_id, req.channel.workspace_id, 'thread_reply', msg.id);
      }
    }
    res.status(201).json({ message: (await withButtons([out]))[0], ...(slash ? { slash } : {}) });
  } catch (e) {
    next(e);
  }
});

// GET /channels/:id/messages — keyset pagination (Slack-style infinite scroll).
messagesRouter.get('/channels/:id/messages', requireAuth, requireChannel, async (req, res, next) => {
  try {
    const { limit, before } = validate(messagesQuerySchema, req.query);
    const filter = { channel_id: req.channel.id, parent_message_id: null };
    if (before) {
      const cursor = await findOne('messages', { id: before, channel_id: req.channel.id });
      if (!cursor) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Unknown cursor' } });
      filter.$or = [
        { created_at: { $lt: cursor.created_at } },
        { created_at: cursor.created_at, id: { $lt: cursor.id } }
      ];
    }
    const msgs = await find('messages', filter, { sort: { created_at: -1, id: -1 }, limit: limit + 1 });
    const hasMore = msgs.length > limit;
    const page = (hasMore ? msgs.slice(0, limit) : msgs).reverse();
    const ids = page.map((m) => m.id);
    const [reactions, mentions, attachments] = await Promise.all([loadReactions(ids, req.user.id), loadMentions(ids), loadAttachments(ids)]);
    for (const m of page) {
      m.reply_count = await count('messages', { parent_message_id: m.id, deleted_at: null });
    }
    res.json({
      messages: await withButtons(page.map((m) => serializeMessage(m, { reactions, mentionIds: mentions[m.id] || [], attachments }))),
      nextCursor: hasMore ? page[0].id : null,
    });
  } catch (e) {
    next(e);
  }
});

// GET /messages/:id/thread — root + chronological replies (channels + DMs).
messagesRouter.get('/messages/:id/thread', requireAuth, async (req, res, next) => {
  try {
    const { message, channel, dm } = await accessMessage(req.params.id, req.user.id);
    const rootId = message.parent_message_id || message.id;
    const root = message.parent_message_id ? await getMessage(rootId) : message;
    if (!root) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Thread root not found' } });
    const rows = await find('messages', { parent_message_id: rootId }, { sort: { created_at: 1 } });
    const all = [root, ...rows];
    const ids = all.map((m) => m.id);
    const [reactions, mentions, attachments] = await Promise.all([loadReactions(ids, req.user.id), loadMentions(ids), loadAttachments(ids)]);
    const home = dm ? dm.id : null;
    const messages = all.map((m) => {
      const s = serializeMessage(m, { reactions, mentionIds: mentions[m.id] || [], attachments });
      return home ? { ...s, channelId: null, dmConversationId: home } : s;
    });
    res.json({
      ...(dm ? { dmConversationId: dm.id } : { channelId: channel.id }),
      messages: await withButtons(messages),
    });
  } catch (e) {
    next(e);
  }
});

// PATCH /messages/:id — author only, 24h window, history kept (channels + DMs).
messagesRouter.patch('/messages/:id', requireAuth, async (req, res, next) => {
  try {
    const { message, channel, dm } = await accessMessage(req.params.id, req.user.id);
    if (message.sender_id !== req.user.id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the author can edit' } });
    }
    if (message.deleted_at) return res.status(403).json({ error: { code: 'DELETED', message: 'Message is deleted' } });
    if (channel?.is_archived) return res.status(403).json({ error: { code: 'ARCHIVED', message: 'Channel is archived' } });
    if (Date.now() - new Date(message.created_at).getTime() > EDIT_WINDOW_MS) {
      return res.status(403).json({ error: { code: 'EDIT_WINDOW', message: 'Edit window (24h) expired' } });
    }
    const { content } = validate(messagePatchSchema, req.body);
    await insertOne('message_edits', { message_id: message.id, content: message.content });
    await updateOne('messages', { id: message.id }, { $set: { content, updated_at: new Date() } });
    const updated = await findOne('messages', { id: message.id });
    const full = await getMessage(updated.id);
    const [reactions, mentions, attachments] = await Promise.all([loadReactions([full.id], req.user.id), loadMentions([full.id]), loadAttachments([full.id])]);
    const base = serializeMessage(full, { reactions, mentionIds: mentions[full.id] || [], attachments });
    if (dm) {
      const out = { ...base, channelId: null, dmConversationId: dm.id };
      await publish({ type: 'dm.message.updated', payload: { message: out } }, [`dm:${dm.id}`]);
      return res.json({ message: (await withButtons([out]))[0] });
    }
    const out = base;
    await publish({ type: 'message.updated', payload: { message: out } }, [`channel:${channel.id}`]);
    res.json({ message: (await withButtons([out]))[0] });
  } catch (e) {
    next(e);
  }
});

// DELETE /messages/:id — soft delete; author or DELETE_MESSAGE holders (channels + DMs).
messagesRouter.delete('/messages/:id', requireAuth, async (req, res, next) => {
  try {
    const { message, channel, dm } = await accessMessage(req.params.id, req.user.id);
    if (message.deleted_at) return res.json({ ok: true });
    const isAuthor = message.sender_id === req.user.id;
    const canMod = dm ? false : await hasPermission(channel.workspace_id, req.user.id, 'DELETE_MESSAGE');
    if (!isAuthor && !canMod) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot delete this message' } });
    }
    await updateOne('messages', { id: message.id }, { $set: { deleted_at: new Date() } });
    const full = await getMessage(message.id);
    if (dm) {
      await publish({ type: 'dm.message.deleted', payload: { id: message.id, dmId: dm.id } }, [`dm:${dm.id}`]);
      return res.json({ message: { ...serializeMessage(full), channelId: null, dmConversationId: dm.id } });
    }
    await publish({ type: 'message.deleted', payload: { id: message.id, channelId: channel.id } }, [`channel:${channel.id}`]);
    res.json({ message: serializeMessage(full) });
  } catch (e) {
    next(e);
  }
});

// POST /messages/:id/reactions — idempotent toggle target (channels + DMs).
messagesRouter.post('/messages/:id/reactions', requireAuth, async (req, res, next) => {
  try {
    const { message, channel, dm, chRole } = await accessMessage(req.params.id, req.user.id);
    if (dm) {
      if (message.deleted_at) return res.status(403).json({ error: { code: 'DELETED', message: 'Message is deleted' } });
      const { emoji } = validate(reactionSchema, req.body);
      const dmExisting = await findOne('message_reactions', { message_id: message.id, user_id: req.user.id, emoji });
      if (!dmExisting) await insertOne('message_reactions', { message_id: message.id, user_id: req.user.id, emoji });
      const reactions = await loadReactions([message.id], req.user.id);
      const full = await getMessage(message.id);
      const out = { ...serializeMessage(full, { reactions, attachments: await loadAttachments([message.id]) }), channelId: null, dmConversationId: dm.id };
      await publish({ type: 'dm.reaction.added', payload: { messageId: message.id, dmId: dm.id, emoji, userId: req.user.id } }, [`dm:${dm.id}`]);
      return res.status(201).json({ message: (await withButtons([out]))[0] });
    }
    if (!chRole) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Join the channel to react' } });
    if (channel.is_archived) return res.status(403).json({ error: { code: 'ARCHIVED', message: 'Channel is archived' } });
    if (message.deleted_at) return res.status(403).json({ error: { code: 'DELETED', message: 'Message is deleted' } });
    const { emoji } = validate(reactionSchema, req.body);
    const existing = await findOne('message_reactions', { message_id: message.id, user_id: req.user.id, emoji });
    if (!existing) await insertOne('message_reactions', { message_id: message.id, user_id: req.user.id, emoji });
    const reactions = await loadReactions([message.id], req.user.id);
    const full = await getMessage(message.id);
    await publish({ type: 'reaction.added', payload: { messageId: message.id, channelId: channel.id, emoji, userId: req.user.id } }, [`channel:${channel.id}`]);
    res.status(201).json({ message: (await withButtons([serializeMessage(full, { reactions, attachments: await loadAttachments([message.id]) })]))[0] });
  } catch (e) {
    next(e);
  }
});

// DELETE /messages/:id/reactions?emoji= — remove own reaction (channels + DMs).
messagesRouter.delete('/messages/:id/reactions', requireAuth, async (req, res, next) => {
  try {
    const { message, chRole, dm } = await accessMessage(req.params.id, req.user.id);
    if (dm) {
      const { emoji } = validate(reactionSchema, req.query);
      await deleteOne('message_reactions', { message_id: message.id, user_id: req.user.id, emoji });
      const reactions = await loadReactions([message.id], req.user.id);
      const full = await getMessage(message.id);
      const out = { ...serializeMessage(full, { reactions, attachments: await loadAttachments([message.id]) }), channelId: null, dmConversationId: dm.id };
      await publish({ type: 'dm.reaction.removed', payload: { messageId: message.id, dmId: dm.id, emoji, userId: req.user.id } }, [`dm:${dm.id}`]);
      return res.json({ message: (await withButtons([out]))[0] });
    }
    if (!chRole) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Join the channel first' } });
    const { emoji } = validate(reactionSchema, req.query);
    await deleteOne('message_reactions', { message_id: message.id, user_id: req.user.id, emoji });
    const reactions = await loadReactions([message.id], req.user.id);
    const full = await getMessage(message.id);
    await publish({ type: 'reaction.removed', payload: { messageId: message.id, channelId: message.channel_id, emoji, userId: req.user.id } }, [`channel:${message.channel_id}`]);
    res.json({ message: (await withButtons([serializeMessage(full, { reactions, attachments: await loadAttachments([message.id]) })]))[0] });
  } catch (e) {
    next(e);
  }
});

// POST /channels/:id/read — advance read marker; drives unread counts.
messagesRouter.post('/channels/:id/read', requireAuth, requireChannel, async (req, res, next) => {
  try {
    if (!req.channelRole) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Join the channel first' } });
    const { lastReadMessageId } = validate(readSchema, req.body);
    const msg = await findOne('messages', { id: lastReadMessageId, channel_id: req.channel.id });
    if (!msg) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Message not in this channel' } });
    // Mark = now(): everything up to this instant is read. (Using the message's
    // own timestamp would wrongly leave same-millisecond siblings unread.)
    await updateOne('channel_members', { channel_id: req.channel.id, user_id: req.user.id }, { $set: { last_read_at: new Date() } });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
