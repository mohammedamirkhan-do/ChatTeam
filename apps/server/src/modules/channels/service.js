import { findOne, insertOne, find } from '../../database/db.js';

export async function createChannel(workspaceId, creatorId, { name, description = '', topic = '', isPrivate = false }) {
  const slug = name.toLowerCase();
  const ch = await insertOne('channels', { workspace_id: workspaceId, name, slug, description, topic, is_private: isPrivate, created_by: creatorId });
  await insertOne('channel_members', { channel_id: ch.id, user_id: creatorId, role: 'owner' });
  return ch;
}

export async function ensureGeneral(workspaceId, ownerId) {
  let general = await findOne('channels', { workspace_id: workspaceId, slug: 'general' });
  if (!general) {
    general = await createChannel(workspaceId, ownerId, { name: 'general', description: 'Company-wide announcements and chat' });
  }
  const members = await find('workspace_members', { workspace_id: workspaceId });
  for (const m of members) {
    const existing = await findOne('channel_members', { channel_id: general.id, user_id: m.user_id });
    if (!existing) {
      await insertOne('channel_members', { channel_id: general.id, user_id: m.user_id, role: m.role === 'owner' ? 'owner' : 'member' });
    }
  }
  return general;
}

export function publicChannel(ch, extra = {}) {
  return {
    id: ch.id,
    workspaceId: ch.workspace_id,
    name: ch.name,
    slug: ch.slug,
    description: ch.description,
    topic: ch.topic,
    isPrivate: ch.is_private,
    isArchived: ch.is_archived,
    memberCount: ch.member_count !== undefined ? Number(ch.member_count) : undefined,
    unreadCount: ch.unread_count !== undefined ? Number(ch.unread_count) : undefined,
    ...extra,
  };
}

export async function requireChannel(req, res, next) {
  try {
    const ch = await findOne('channels', { id: req.params.id });
    if (!ch) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Channel not found' } });
    const wsMember = await findOne('workspace_members', { workspace_id: ch.workspace_id, user_id: req.user.id });
    if (!wsMember) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not a workspace member' } });
    const chMember = await findOne('channel_members', { channel_id: ch.id, user_id: req.user.id });
    if (ch.is_private && !chMember) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Private channel' } });
    }
    req.channel = ch;
    req.workspaceRole = wsMember.role;
    req.channelRole = chMember ? chMember.role : null;
    next();
  } catch (e) {
    next(e);
  }
}
