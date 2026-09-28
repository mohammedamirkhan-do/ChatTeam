import { Router } from 'express';
import { findOne, insertOne, updateOne, deleteOne, find, aggregate } from '../../database/db.js';
import { requireAuth } from '../../common/auth.js';
import { requireWorkspace } from '../workspaces/permissions.js';
import { requireDm, publicDM, findDirectPair, dmMemberList, withDmHome } from './service.js';
import {
  serializeMessage,
  getMessage,
  loadReactions,
  loadMentions,
  loadAttachments,
  withButtons,
  resolveMentionEmails,
  filterWorkspaceMembers,
} from '../messages/service.js';
import {
  dmCreateSchema,
  dmPatchSchema,
  dmMemberAddSchema,
  dmMessageCreateSchema,
  dmReadSchema,
  dmMessagesQuerySchema,
  validate,
} from '@teamchat/validation';
import { publish } from '../../websocket/index.js';
import { getIO } from '../../websocket/index.js';
import { notifyUser } from '../notifications/routes.js';
import { executeSlash } from '../bots/commands.js';
import { dispatchIntegrationEvent } from '../integrations/routes.js';

export const dmsRouter = Router();

function joinDmRoom(userIds, dmId) {
  try {
    const io = getIO();
    if (!io) return;
    for (const id of userIds) io.in(`user:${id}`).socketsJoin(`dm:${dmId}`);
  } catch {}
}

function dmDisplayName(memberRows) {
  return memberRows.map((m) => m.display_name.split(' ')[0]).slice(0, 4).join(', ');
}

dmsRouter.post('/workspaces/:wid/dms', requireAuth, requireWorkspace, async (req, res, next) => {
  try {
    const { userIds, name } = validate(dmCreateSchema, req.body);
    const others = [...new Set(userIds)].filter((id) => id !== req.user.id);
    if (!others.length) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invite at least one other member' } });
    const members = await find('workspace_members', { workspace_id: req.workspace.id, user_id: { $in: others } });
    if (members.length !== others.length) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'All DM members must belong to the workspace' } });
    }
    const allIds = [req.user.id, ...others];
    const isPair = allIds.length === 2 && !name;
    if (isPair) {
      const existing = await findDirectPair(req.workspace.id, allIds);
      if (existing) return res.json({ conversation: await fullDm(existing.id, req.user.id), reused: true });
    }
    const isGroup = allIds.length > 2 || Boolean(name);
    let dmName = name || null;
    const dm = await insertOne('direct_conversations', { workspace_id: req.workspace.id, is_group: isGroup, name: dmName, created_by: req.user.id });
    for (const uid of allIds) {
      await insertOne('direct_conversation_members', { conversation_id: dm.id, user_id: uid });
    }
    if (!dmName && isGroup) {
      const rows = await find('users', { id: { $in: allIds } });
      dmName = dmDisplayName(rows);
      await updateOne('direct_conversations', { id: dm.id }, { $set: { name: dmName } });
      dm.name = dmName;
    }
    const out = await fullDm(dm.id, req.user.id);
    joinDmRoom(allIds, dm.id);
    await publish({ type: 'dm.created', payload: { conversation: out } }, allIds.map((id) => `user:${id}`));
    res.status(201).json({ conversation: out, reused: false });
  } catch (e) {
    next(e);
  }
});

dmsRouter.get('/workspaces/:wid/dms', requireAuth, requireWorkspace, async (req, res, next) => {
  try {
    const r = await aggregate('direct_conversations', [
      { $match: { workspace_id: req.workspace.id } },
      { $addFields: { member_ids: [] } },
      { $sort: { created_at: -1 } }
    ]);
    const list = [];
    for (const row of r) {
      const hasMember = await findOne('direct_conversation_members', { conversation_id: row.id, user_id: req.user.id });
      if (!hasMember) continue;
      const last = await aggregate('messages', [
        { $match: { dm_conversation_id: row.id, deleted_at: null } },
        { $sort: { created_at: -1, id: -1 } },
        { $limit: 1 },
        { $lookup: { from: 'users', localField: 'sender_id', foreignField: 'id', as: 'sender_doc' } },
        { $unwind: { path: '$sender_doc', preserveNullAndEmptyArrays: true } }
      ]);
      const lastMsg = last[0] || null;
      const allMsgs = await find('messages', { dm_conversation_id: row.id, deleted_at: null });
      const lastReadAt = hasMember.last_read_at || null;
      const unreadCount = allMsgs.filter((m) => m.sender_id !== req.user.id && (!lastReadAt || new Date(m.created_at) > new Date(lastReadAt))).length;
      list.push(publicDM({ ...row, unread_count: unreadCount }, {
        lastMessage: lastMsg ? withDmHome(serializeMessage(lastMsg, { sender_name: lastMsg.sender_name, sender_avatar: lastMsg.sender_avatar }), row.id) : null,
      }));
    }
    res.json({ conversations: list });
  } catch (e) {
    next(e);
  }
});

dmsRouter.get('/dms/:id', requireAuth, requireDm, async (req, res, next) => {
  try {
    res.json({ conversation: await fullDm(req.dm.id, req.user.id) });
  } catch (e) {
    next(e);
  }
});

dmsRouter.get('/dms/:id/members', requireAuth, requireDm, async (req, res, next) => {
  try {
    res.json({ members: await dmMemberList(req.dm.id) });
  } catch (e) {
    next(e);
  }
});

dmsRouter.patch('/dms/:id', requireAuth, requireDm, async (req, res, next) => {
  try {
    if (!req.dm.is_group) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: '1-1 conversations cannot be renamed' } });
    const { name } = validate(dmPatchSchema, req.body);
    await updateOne('direct_conversations', { id: req.dm.id }, { $set: { name } });
    const updated = await findOne('direct_conversations', { id: req.dm.id });
    const out = await fullDm(updated.id, req.user.id);
    await publish({ type: 'dm.updated', payload: { conversation: out } }, [`dm:${req.dm.id}`]);
    res.json({ conversation: out });
  } catch (e) {
    next(e);
  }
});

dmsRouter.post('/dms/:id/members', requireAuth, requireDm, async (req, res, next) => {
  try {
    if (!req.dm.is_group) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Cannot add members to a 1-1 conversation' } });
    const { userId } = validate(dmMemberAddSchema, req.body);
    const wsMember = await findOne('workspace_members', { workspace_id: req.dm.workspace_id, user_id: userId });
    if (!wsMember) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'User must belong to the workspace' } });
    await insertOne('direct_conversation_members', { conversation_id: req.dm.id, user_id: userId });
    const out = await fullDm(req.dm.id, req.user.id);
    joinDmRoom([userId], req.dm.id);
    await publish({ type: 'dm.updated', payload: { conversation: out } }, [`dm:${req.dm.id}`, `user:${userId}`]);
    res.status(201).json({ conversation: out });
  } catch (e) {
    next(e);
  }
});

dmsRouter.delete('/dms/:id/members/:uid', requireAuth, requireDm, async (req, res, next) => {
  try {
    if (!req.dm.is_group) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Cannot remove members from a 1-1 conversation' } });
    await deleteOne('direct_conversation_members', { conversation_id: req.dm.id, user_id: req.params.uid });
    const out = await fullDm(req.dm.id, req.user.id);
    await publish({ type: 'dm.updated', payload: { conversation: out } }, [`dm:${req.dm.id}`, `user:${req.params.uid}`]);
    res.json({ conversation: out });
  } catch (e) {
    next(e);
  }
});

dmsRouter.get('/dms/:id/messages', requireAuth, requireDm, async (req, res, next) => {
  try {
    const { limit, before } = validate(dmMessagesQuerySchema, req.query);
    const pipeline = [
      { $match: { dm_conversation_id: req.dm.id, parent_message_id: null } },
      { $sort: { created_at: -1, id: -1 } },
      { $limit: limit + 1 },
      { $lookup: { from: 'users', localField: 'sender_id', foreignField: 'id', as: 'sender_doc' } },
      { $unwind: { path: '$sender_doc', preserveNullAndEmptyArrays: true } }
    ];
    if (before) {
      const cursor = await findOne('messages', { id: before, dm_conversation_id: req.dm.id });
      if (!cursor) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Unknown cursor' } });
      pipeline[0].$match = { ...pipeline[0].$match, $or: [{ created_at: { $lt: cursor.created_at } }, { created_at: { $eq: cursor.created_at, id: { $lt: cursor.id } } }] };
    }
    const r = await aggregate('messages', pipeline);
    const hasMore = r.length > limit;
    const page = (hasMore ? r.slice(0, limit) : r).reverse();
    const ids = page.map((m) => m.id);
    const [reactions, mentions, attachments] = await Promise.all([loadReactions(ids, req.user.id), loadMentions(ids), loadAttachments(ids)]);
    res.json({
      messages: await withButtons(page.map((m) => withDmHome(serializeMessage(m, { reactions, mentionIds: mentions[m.id] || [], attachments }), req.dm.id))),
      nextCursor: hasMore ? page[0].id : null,
    });
  } catch (e) {
    next(e);
  }
});

dmsRouter.post('/dms/:id/messages', requireAuth, requireDm, async (req, res, next) => {
  try {
    const { content, parentMessageId, mentions, attachmentIds } = validate(dmMessageCreateSchema, req.body);
    if (parentMessageId) {
      const parent = await findOne('messages', { id: parentMessageId, deleted_at: null });
      if (!parent || parent.dm_conversation_id !== req.dm.id) {
        return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Parent message not in this conversation' } });
      }
    }
    const msg = await insertOne('messages', { workspace_id: req.dm.workspace_id, channel_id: null, dm_conversation_id: req.dm.id, sender_id: req.user.id, parent_message_id: parentMessageId || null, content });
    const emailIds = await resolveMentionEmails(req.dm.workspace_id, content);
    const validIds = await filterWorkspaceMembers(req.dm.workspace_id, mentions);
    const all = [...new Set([...emailIds, ...validIds])].filter((id) => id !== req.user.id);
    for (const uid of all) {
      await insertOne('message_mentions', { message_id: msg.id, mentioned_user_id: uid });
    }
    for (const fid of [...new Set(attachmentIds)]) {
      const f = await findOne('files', { id: fid, uploader_id: req.user.id, workspace_id: req.dm.workspace_id, message_id: null });
      if (!f) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Unknown or already-attached file' } });
      await updateOne('files', { id: fid }, { $set: { message_id: msg.id } });
      await insertOne('message_attachments', { message_id: msg.id, file_id: f.id, filename: f.filename, mime_type: f.mime_type, size: f.size, url: `/files/${f.id}`, thumb_url: f.thumb_storage_key ? `/files/${f.id}/thumb` : '', width: f.width, height: f.height });
    }
    const full = await getMessage(msg.id);
    const attachments = await loadAttachments([msg.id]);
    const out = withDmHome(serializeMessage(full, { mentionIds: all, attachments }), req.dm.id);
    await publish({ type: 'dm.message.created', payload: { message: out } }, [`dm:${req.dm.id}`]);
    let slash = null;
    if (content.startsWith('/')) {
      try {
        const r = await executeSlash({ workspaceId: req.dm.workspace_id, scope: { dmConversationId: req.dm.id }, user: req.user, text: content });
        if (r?.handled) slash = r.ephemeral ? { ephemeral: r.ephemeral } : { message: r.message };
      } catch (err) {
        slash = { error: err.message };
      }
    }
    dispatchIntegrationEvent(req.dm.workspace_id, 'dm.message.created', { message: out }).catch(() => {});
    const others = (await dmMemberList(req.dm.id)).map((m) => m.userId).filter((id) => id !== req.user.id);
    for (const uid of others) {
      await notifyUser(uid, req.dm.workspace_id, 'dm', msg.id);
    }
    for (const uid of all.filter((id) => !others.includes(id))) {
      await notifyUser(uid, req.dm.workspace_id, 'mention', msg.id);
    }
    if (parentMessageId) {
      const parent = await findOne('messages', { id: parentMessageId });
      if (parent && parent.sender_id !== req.user.id && !all.includes(parent.sender_id) && !others.includes(parent.sender_id)) {
        await notifyUser(parent.sender_id, req.dm.workspace_id, 'thread_reply', msg.id);
      }
    }
    res.status(201).json({ message: (await withButtons([out]))[0], ...(slash ? { slash } : {}) });
  } catch (e) {
    next(e);
  }
});

dmsRouter.post('/dms/:id/read', requireAuth, requireDm, async (req, res, next) => {
  try {
    const { lastReadMessageId } = validate(dmReadSchema, req.body);
    const msg = await findOne('messages', { id: lastReadMessageId, dm_conversation_id: req.dm.id });
    if (!msg) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Message not in this conversation' } });
    await updateOne('direct_conversation_members', { conversation_id: req.dm.id, user_id: req.user.id }, { $set: { last_read_at: new Date() } });
    await publish({ type: 'dm.read', payload: { dmId: req.dm.id, userId: req.user.id } }, [`dm:${req.dm.id}`]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

async function fullDm(dmId, meId) {
  const row = await findOne('direct_conversations', { id: dmId });
  if (!row) return null;
  const members = await find('direct_conversation_members', { conversation_id: dmId });
  const memberIds = members.map((m) => m.user_id);
  const member_ids = memberIds;
  const allMessages = await find('messages', { dm_conversation_id: dmId, deleted_at: null });
  const lastReadDoc = await findOne('direct_conversation_members', { conversation_id: dmId, user_id: meId });
  const lastReadAt = lastReadDoc ? lastReadDoc.last_read_at : null;
  const unread_count = allMessages.filter((m) => m.sender_id !== meId && (!lastReadAt || new Date(m.created_at) > new Date(lastReadAt))).length;
  const updated_at = allMessages.length > 0 ? allMessages[0].created_at : row.created_at;
  const dmPublic = publicDM({ ...row, member_ids, unread_count, updated_at });
  const dmMembers = await dmMemberList(dmId);
  return { ...dmPublic, members: dmMembers };
}
