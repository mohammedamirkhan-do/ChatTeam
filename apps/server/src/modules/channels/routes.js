import { Router } from 'express';
import { findOne, insertOne, updateOne, deleteOne, find, count } from '../../database/db.js';
import { requireAuth } from '../../common/auth.js';
import { requireWorkspace, requirePermission, hasPermission } from '../workspaces/permissions.js';
import { createChannel, publicChannel, requireChannel } from './service.js';
import {
  channelCreateSchema,
  channelPatchSchema,
  channelMemberAddSchema,
  validate,
} from '@teamchat/validation';
import { publish } from '../../websocket/index.js';
import { auditLog } from '../admin/routes.js';

export const channelsRouter = Router();

function withCounts(rows) {
  return rows.map((c) => publicChannel(c));
}

// POST /workspaces/:wid/channels — CREATE_CHANNEL (guests blocked by matrix).
workspacesChannelRoutes();
function workspacesChannelRoutes() {
  channelsRouter.post('/workspaces/:wid/channels', requireAuth, requireWorkspace, requirePermission('CREATE_CHANNEL'), async (req, res, next) => {
    try {
      // Slack parity: channel names are lowercase.
      const input = validate(channelCreateSchema, { ...req.body, name: String(req.body?.name || '').toLowerCase() });
      const exists = await findOne('channels', { workspace_id: req.workspace.id, name: input.name });
      if (exists) return res.status(409).json({ error: { code: 'NAME_TAKEN', message: 'Channel name already in use' } });
      const ch = await createChannel(req.workspace.id, req.user.id, input);
      await publish({ type: 'channel.created', payload: { channel: publicChannel(ch, { memberCount: 1 }) } }, [`workspace:${req.workspace.id}`]);
      res.status(201).json({ channel: publicChannel(ch, { memberCount: 1 }) });
    } catch (e) {
      next(e);
    }
  });

  // GET /workspaces/:wid/channels — public + private-where-member (Slack privacy).
  channelsRouter.get('/workspaces/:wid/channels', requireAuth, requireWorkspace, async (req, res, next) => {
    try {
      const allChannels = await find('channels', { workspace_id: req.workspace.id });
      const rows = [];
      for (const c of allChannels) {
        if (c.is_private) {
          const cm = await findOne('channel_members', { channel_id: c.id, user_id: req.user.id });
          if (!cm) continue;
        }
        const memberCount = await count('channel_members', { channel_id: c.id });
        const lastRead = await findOne('channel_members', { channel_id: c.id, user_id: req.user.id });
        const unreadThreshold = lastRead?.last_read_at || null;
        let unreadCount = 0;
        if (unreadThreshold !== null) {
          const msgs = await find('messages', { channel_id: c.id, deleted_at: null, sender_id: { $ne: req.user.id }, created_at: { $gt: unreadThreshold } });
          unreadCount = msgs.length;
        } else {
          const msgs = await find('messages', { channel_id: c.id, deleted_at: null, sender_id: { $ne: req.user.id } });
          unreadCount = msgs.length;
        }
        rows.push({ ...c, member_count: memberCount, unread_count: unreadCount });
      }
      rows.sort((a, b) => (a.is_private !== b.is_private ? (a.is_private ? 1 : -1) : a.name.localeCompare(b.name)));
      res.json({ channels: withCounts(rows) });
    } catch (e) {
      next(e);
    }
  });
}

// GET /channels/:id
channelsRouter.get('/channels/:id', requireAuth, requireChannel, async (req, res, next) => {
  try {
    const memberCount = await count('channel_members', { channel_id: req.channel.id });
    res.json({ channel: publicChannel(req.channel, { memberCount, myRole: req.channelRole }) });
  } catch (e) {
    next(e);
  }
});

// PATCH /channels/:id — rename/description/topic. Members only, guests excluded.
channelsRouter.patch('/channels/:id', requireAuth, requireChannel, async (req, res, next) => {
  try {
    if (!req.channelRole) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Join the channel first' } });
    if (req.workspaceRole === 'guest') return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Guests cannot edit channels' } });
    if (req.channel.is_archived) return res.status(403).json({ error: { code: 'ARCHIVED', message: 'Archived channels are read-only' } });
    const patch = validate(channelPatchSchema, {
      ...req.body,
      ...(req.body?.name !== undefined ? { name: String(req.body.name).toLowerCase() } : {}),
    });
    const sets = {};
    if (patch.name !== undefined) {
      const clash = await findOne('channels', { workspace_id: req.channel.workspace_id, name: patch.name, id: { $ne: req.channel.id } });
      if (clash) return res.status(409).json({ error: { code: 'NAME_TAKEN', message: 'Channel name already in use' } });
      sets.name = patch.name;
      sets.slug = patch.name.toLowerCase();
    }
    if (patch.description !== undefined) {
      sets.description = patch.description;
    }
    if (patch.topic !== undefined) {
      sets.topic = patch.topic;
    }
    if (!Object.keys(sets).length) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Nothing to update' } });
    await updateOne('channels', { id: req.channel.id }, { $set: { ...sets, updated_at: new Date() } });
    const ch = await findOne('channels', { id: req.channel.id });
    await publish({ type: 'channel.updated', payload: { channel: publicChannel(ch) } }, [`workspace:${ch.workspace_id}`]);
    res.json({ channel: publicChannel(ch) });
  } catch (e) {
    next(e);
  }
});

// POST /channels/:id/join — public: any non-guest workspace member. Private: members only (idempotent).
channelsRouter.post('/channels/:id/join', requireAuth, requireChannel, async (req, res, next) => {
  try {
    if (req.channel.is_archived) return res.status(403).json({ error: { code: 'ARCHIVED', message: 'Channel is archived' } });
    if (req.channelRole) return res.json({ ok: true, already: true });
    if (req.channel.is_private) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Private channel — ask a member to add you' } });
    if (req.workspaceRole === 'guest') return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Guests join by invitation only' } });
    await insertOne('channel_members', { channel_id: req.channel.id, user_id: req.user.id, role: 'member' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// POST /channels/:id/leave
channelsRouter.post('/channels/:id/leave', requireAuth, requireChannel, async (req, res, next) => {
  try {
    if (!req.channelRole) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not a member' } });
    if (req.channel.slug === 'general') return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You cannot leave #general' } });
    await deleteOne('channel_members', { channel_id: req.channel.id, user_id: req.user.id });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// POST /channels/:id/archive | /unarchive — workspace managers (Slack parity).
channelsRouter.post('/channels/:id/archive', requireAuth, requireChannel, async (req, res, next) => {
  try {
    const ok = await hasPermission(req.channel.workspace_id, req.user.id, 'MANAGE_WORKSPACE');
    if (!ok) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Requires MANAGE_WORKSPACE' } });
    if (req.channel.slug === 'general') return res.status(403).json({ error: { code: 'FORBIDDEN', message: '#general cannot be archived' } });
    await updateOne('channels', { id: req.channel.id }, { $set: { is_archived: true } });
    await publish({ type: 'channel.archived', payload: { id: req.channel.id, workspaceId: req.channel.workspace_id } }, [`workspace:${req.channel.workspace_id}`]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

channelsRouter.post('/channels/:id/unarchive', requireAuth, requireChannel, async (req, res, next) => {
  try {
    const ok = await hasPermission(req.channel.workspace_id, req.user.id, 'MANAGE_WORKSPACE');
    if (!ok) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Requires MANAGE_WORKSPACE' } });
    await updateOne('channels', { id: req.channel.id }, { $set: { is_archived: false } });
    await publish({ type: 'channel.updated', payload: { channel: publicChannel({ ...req.channel, is_archived: false }) } }, [`workspace:${req.channel.workspace_id}`]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// GET /channels/:id/members
channelsRouter.get('/channels/:id/members', requireAuth, requireChannel, async (req, res, next) => {
  try {
    const members = await find('channel_members', { channel_id: req.channel.id });
    const userIds = members.map(m => m.user_id);
    const users = await find('users', { id: { $in: userIds } });
    const userMap = {};
    for (const u of users) userMap[u.id] = u;
    const membersWithUsers = members.map(m => ({
      ...userMap[m.user_id],
      role: m.role,
      joined_at: m.joined_at,
    }));
    membersWithUsers.sort((a, b) => new Date(a.joined_at) - new Date(b.joined_at));
    res.json({ members: membersWithUsers });
  } catch (e) {
    next(e);
  }
});

// POST /channels/:id/members {userId} — INVITE_MEMBER; target must be in workspace.
channelsRouter.post('/channels/:id/members', requireAuth, requireChannel, async (req, res, next) => {
  try {
    const ok = await hasPermission(req.channel.workspace_id, req.user.id, 'INVITE_MEMBER');
    if (!ok) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Requires INVITE_MEMBER' } });
    if (req.channel.is_archived) return res.status(403).json({ error: { code: 'ARCHIVED', message: 'Channel is archived' } });
    const { userId } = validate(channelMemberAddSchema, req.body);
    const wsMember = await findOne('workspace_members', { workspace_id: req.channel.workspace_id, user_id: userId });
    if (!wsMember) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'User is not in this workspace' } });
    await insertOne('channel_members', { channel_id: req.channel.id, user_id: userId, role: 'member' });
    res.status(201).json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// DELETE /channels/:id/members/:userId — REMOVE_MEMBER or self.
channelsRouter.delete('/channels/:id/members/:userId', requireAuth, requireChannel, async (req, res, next) => {
  try {
    const self = req.params.userId === req.user.id;
    if (!self) {
      const ok = await hasPermission(req.channel.workspace_id, req.user.id, 'REMOVE_MEMBER');
      if (!ok) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Requires REMOVE_MEMBER' } });
    }
    await deleteOne('channel_members', { channel_id: req.channel.id, user_id: req.params.userId });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// DELETE /channels/:id — DELETE_CHANNEL; #general protected (Slack parity).
channelsRouter.delete('/channels/:id', requireAuth, requireChannel, async (req, res, next) => {
  try {
    const ok = await hasPermission(req.channel.workspace_id, req.user.id, 'DELETE_CHANNEL');
    if (!ok) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Requires DELETE_CHANNEL' } });
    if (req.channel.slug === 'general') return res.status(403).json({ error: { code: 'FORBIDDEN', message: '#general cannot be deleted' } });
    await deleteOne('channels', { id: req.channel.id });
    await auditLog(req.channel.workspace_id, req.user.id, 'channel.deleted', 'channel', req.channel.id, { name: req.channel.name });
    await publish({ type: 'channel.deleted', payload: { id: req.channel.id, workspaceId: req.channel.workspace_id } }, [`workspace:${req.channel.workspace_id}`]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
