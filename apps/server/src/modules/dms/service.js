import { findOne, aggregate } from '../../database/db.js';
import { serializeMessage, getMessage } from '../messages/service.js';

export function publicDM(row, extra = {}) {
  const memberIds = row.member_ids || [];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    isGroup: row.is_group,
    name: row.name,
    memberIds,
    memberCount: memberIds.length,
    lastMessage: row.last_message || null,
    unreadCount: row.unread_count !== undefined ? Number(row.unread_count) : undefined,
    updatedAt: row.updated_at || row.created_at,
    ...extra,
  };
}

export function withDmHome(serialized, dmId) {
  return { ...serialized, channelId: null, dmConversationId: dmId };
}

export async function getDmConversation(id) {
  return findOne('direct_conversations', { id: id });
}

export async function requireDm(req, res, next) {
  try {
    const dm = await getDmConversation(req.params.id);
    if (!dm) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
    const wsMember = await findOne('workspace_members', { workspace_id: dm.workspace_id, user_id: req.user.id });
    if (!wsMember) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not a workspace member' } });
    const member = await findOne('direct_conversation_members', { conversation_id: dm.id, user_id: req.user.id });
    if (!member) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
    req.dm = dm;
    req.dmMember = member;
    next();
  } catch (e) {
    next(e);
  }
}

export async function accessDmMessage(messageId, userId) {
  const message = await getMessage(messageId);
  if (!message) throw Object.assign(new Error('Message not found'), { status: 404, code: 'NOT_FOUND' });
  if (!message.dm_conversation_id) throw Object.assign(new Error('Not a DM message'), { status: 400, code: 'BAD_REQUEST' });
  const dm = await getDmConversation(message.dm_conversation_id);
  const wsMember = await findOne('workspace_members', { workspace_id: dm.workspace_id, user_id: userId });
  if (!wsMember) throw Object.assign(new Error('Not a workspace member'), { status: 403, code: 'FORBIDDEN' });
  const member = await findOne('direct_conversation_members', { conversation_id: dm.id, user_id: userId });
  if (!member) throw Object.assign(new Error('Conversation not found'), { status: 404, code: 'NOT_FOUND' });
  return { message, dm };
}

export async function findDirectPair(workspaceId, userIds) {
  const sorted = [...new Set(userIds)].sort();
  const r = await aggregate('direct_conversations', [
    { $match: { workspace_id: workspaceId, is_group: false } },
    { $lookup: { from: 'direct_conversation_members', localField: '_id', foreignField: 'conversation_id', as: 'members' } },
    { $addFields: { member_count: { $size: '$members' } } },
    { $match: { member_count: sorted.length, 'members.user_id': { $all: sorted } } },
  ]);
  return r[0] || null;
}

export async function dmMemberList(dmId) {
  const r = await aggregate('direct_conversation_members', [
    { $match: { conversation_id: dmId } },
    { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'user' } },
    { $unwind: '$user' },
    { $project: { user_id: '$user_id', display_name: '$user.display_name', avatar_url: '$user.avatar_url', email: '$user.email', status: '$user.status', last_read_at: 1, joined_at: 1 } }
  ]);
  return r.map((m) => ({
    userId: m.user_id,
    displayName: m.display_name,
    avatarUrl: m.avatar_url,
    email: m.email,
    status: m.status,
    lastReadAt: m.last_read_at,
    joinedAt: m.joined_at,
  }));
}

export async function serializeDmMessage(msgId, meId, dmId) {
  const { loadReactions, loadMentions, loadAttachments, withButtons } = await import('../messages/service.js');
  const full = await getMessage(msgId);
  const [reactions, mentions, attachments] = await Promise.all([
    loadReactions([msgId], meId), loadMentions([msgId]), loadAttachments([msgId]),
  ]);
  const [out] = await withButtons([withDmHome(serializeMessage(full, { reactions, mentionIds: mentions[msgId] || [], attachments }), dmId)]);
  return out;
}
