import { findOne, find, count, aggregate } from '../../database/db.js';

export function serializeMessage(row, { reactions = [], mentionIds = [], attachments = [], buttonsMap = {} } = {}) {
  const deleted = Boolean(row.deleted_at);
  const counts = {};
  const mine = new Set();
  for (const r of reactions) {
    if (r.message_id !== row.id) continue;
    counts[r.emoji] = Number(r.n || 0);
    if (r.mine) mine.add(r.emoji);
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    parentMessageId: row.parent_message_id,
    sender: {
      id: row.sender_id,
      displayName: row.sender_name,
      avatarUrl: row.sender_avatar,
    },
    content: deleted ? null : row.content,
    messageType: row.message_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    edited: Number(row.edit_count || 0) > 0,
    deleted,
    replyCount: Number(row.reply_count || 0),
    reactions: Object.entries(counts).map(([emoji, count]) => ({ emoji, count, me: mine.has(emoji) })),
    mentions: mentionIds,
    buttons: buttonsMap[row.id] || [],
    attachments: attachments.filter((a) => a.message_id === row.id).map((a) => ({
      fileId: a.file_id,
      filename: a.filename,
      mimeType: a.mime_type,
      size: Number(a.size),
      url: a.url,
      thumbUrl: a.thumb_url || null,
      width: a.width != null ? Number(a.width) : null,
      height: a.height != null ? Number(a.height) : null,
    })),
  };
}

export async function loadReactions(messageIds, meId) {
  if (!messageIds.length) return [];
  const r = await aggregate('message_reactions', [
    { $match: { message_id: { $in: messageIds } } },
    { $group: { _id: { message_id: '$message_id', emoji: '$emoji' }, n: { $sum: 1 }, mine: { $max: { $eq: ['$user_id', meId] } } } },
    { $project: { _id: 0, message_id: '$_id.message_id', emoji: '$_id.emoji', n: 1, mine: 1 } }
  ]);
  return r;
}

export async function loadAttachments(messageIds) {
  if (!messageIds.length) return [];
  const r = await find('message_attachments', { message_id: { $in: messageIds } });
  return r;
}

export async function loadButtons(messageIds) {
  if (!messageIds.length) return {};
  const r = await find('message_buttons', { message_id: { $in: messageIds } });
  const map = {};
  for (const row of r) {
    (map[row.message_id] = map[row.message_id] || []).push({ id: row.action_id, label: row.label });
  }
  return map;
}

export async function withButtons(serialized) {
  const map = await loadButtons(serialized.map((m) => m.id));
  return serialized.map((m) => ({ ...m, buttons: map[m.id] || m.buttons || [] }));
}

export async function loadMentions(messageIds) {
  if (!messageIds.length) return {};
  const r = await find('message_mentions', { message_id: { $in: messageIds } });
  const map = {};
  for (const row of r) {
    (map[row.message_id] = map[row.message_id] || []).push(row.mentioned_user_id);
  }
  return map;
}

export async function getMessage(id) {
  const results = await aggregate('messages', [
    { $match: { _id: id } },
    { $lookup: { from: 'users', localField: 'sender_id', foreignField: '_id', as: 'sender_doc' } },
    { $unwind: { path: '$sender_doc', preserveNullAndEmptyArrays: true } },
    { $addFields: { sender_name: '$sender_doc.display_name', sender_avatar: '$sender_doc.avatar_url' } },
    { $lookup: { from: 'messages', let: { parentId: '$_id' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$parent_message_id', '$$parentId'] }, { $eq: ['$deleted_at', null] }] } } }, { $count: 'reply_count' }], as: 'reply_count_doc' } },
    { $addFields: { reply_count: { $ifNull: ['$reply_count_doc.0', 0] } } },
    { $lookup: { from: 'message_edits', localField: '_id', foreignField: 'message_id', as: 'edits_doc' } },
    { $addFields: { edit_count: { $size: '$edits_doc' } } },
    { $project: { sender_doc: 0, reply_count_doc: 0, edits_doc: 0 } }
  ]);
  return results[0] || null;
}

export async function accessMessage(messageId, userId) {
  const message = await getMessage(messageId);
  if (!message) throw Object.assign(new Error('Message not found'), { status: 404, code: 'NOT_FOUND' });
  if (message.dm_conversation_id) {
    const dm = await findOne('direct_conversations', { id: message.dm_conversation_id });
    const wsMember = await findOne('workspace_members', { workspace_id: dm.workspace_id, user_id: userId });
    if (!wsMember) throw Object.assign(new Error('Not a workspace member'), { status: 403, code: 'FORBIDDEN' });
    const dmMember = await findOne('direct_conversation_members', { conversation_id: dm.id, user_id: userId });
    if (!dmMember) throw Object.assign(new Error('Conversation not found'), { status: 404, code: 'NOT_FOUND' });
    return { message, dm, wsRole: wsMember.role, chRole: null };
  }
  const channel = await findOne('channels', { id: message.channel_id });
  const wsMember = await findOne('workspace_members', { workspace_id: channel.workspace_id, user_id: userId });
  if (!wsMember) throw Object.assign(new Error('Not a workspace member'), { status: 403, code: 'FORBIDDEN' });
  const chMember = await findOne('channel_members', { channel_id: channel.id, user_id: userId });
  if (channel.is_private && !chMember) throw Object.assign(new Error('Private channel'), { status: 403, code: 'FORBIDDEN' });
  return { message, channel, wsRole: wsMember.role, chRole: chMember ? chMember.role : null };
}

export async function resolveMentionEmails(workspaceId, content) {
  const emails = [...new Set(Array.from(content.matchAll(/@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g), (m) => m[1].toLowerCase()))];
  if (!emails.length) return [];
  const r = await aggregate('workspace_members', [
    { $match: { workspace_id: workspaceId } },
    { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'user' } },
    { $unwind: '$user' },
    { $match: { 'user.email': { $in: emails } } },
    { $project: { _id: 0, id: '$user._id' } }
  ]);
  return r.map((x) => x.id);
}

export async function filterWorkspaceMembers(workspaceId, userIds) {
  const ids = [...new Set(userIds)];
  if (!ids.length) return [];
  const r = await find('workspace_members', { workspace_id: workspaceId, user_id: { $in: ids } });
  return r.map((x) => x.user_id);
}
