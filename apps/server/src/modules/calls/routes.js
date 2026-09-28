import { Router } from 'express';
import { findOne, insertOne, updateOne, aggregate } from '../../database/db.js';
import { requireAuth } from '../../common/auth.js';
import { requireWorkspace } from '../workspaces/permissions.js';
import { publicCall, getCall, requireCall, callRoster } from './service.js';
import { callCreateSchema, callMediaSchema, validate } from '@teamchat/validation';
import { publish, getIO } from '../../websocket/index.js';

export const callsRouter = Router();

function joinCallRoom(userIds, callId) {
  try {
    const io = getIO();
    if (!io) return;
    for (const id of userIds) io.in(`user:${id}`).socketsJoin(`call:${callId}`);
  } catch {}
}

callsRouter.post('/workspaces/:wid/calls', requireAuth, requireWorkspace, async (req, res, next) => {
  try {
    const { channelId, dmConversationId } = validate(callCreateSchema, req.body);
    if (!!channelId === !!dmConversationId) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Exactly one of channelId/dmConversationId required' } });
    }
    let workspaceId = req.workspace.id;
    if (channelId) {
      const ch = await findOne('channels', { id: channelId, workspace_id: workspaceId });
      if (!ch) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Channel not found' } });
      if (ch.is_private) {
        const cm = await findOne('channel_members', { channel_id: channelId, user_id: req.user.id });
        if (!cm) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Private channel' } });
      }
    } else {
      const dm = await findOne('direct_conversations', { id: dmConversationId, workspace_id: workspaceId });
      if (!dm) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
      const mem = await findOne('direct_conversation_members', { conversation_id: dm.id, user_id: req.user.id });
      if (!mem) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not a conversation member' } });
    }
    const existingFilter = channelId
      ? { workspace_id: workspaceId, status: 'live', channel_id: channelId }
      : { workspace_id: workspaceId, status: 'live', dm_conversation_id: dmConversationId };
    const existing = await findOne('calls', existingFilter);
    const call = existing || await insertOne('calls', { workspace_id: workspaceId, status: 'live', channel_id: channelId || null, dm_conversation_id: dmConversationId || null, created_by: req.user.id });
    const part = await findOne('call_participants', { call_id: call.id, user_id: req.user.id });
    if (part) {
      await updateOne('call_participants', { call_id: call.id, user_id: req.user.id }, { $set: { left_at: null } });
    } else {
      await insertOne('call_participants', { call_id: call.id, user_id: req.user.id, left_at: null });
    }
    const roster = await callRoster(call.id);
    joinCallRoom(roster.map((p) => p.userId), call.id);
    await publish({ type: 'call.started', payload: { call: publicCall(call), roster } }, [`workspace:${workspaceId}`]);
    await publish({ type: 'call.joined', payload: { callId: call.id, userId: req.user.id, roster } }, [`call:${call.id}`]);
    res.status(existing ? 200 : 201).json({ call: { ...publicCall(call), participants: roster }, reused: Boolean(existing) });
  } catch (e) {
    next(e);
  }
});

callsRouter.get('/calls/active', requireAuth, async (req, res, next) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'workspaceId required' } });
    const wsMember = await findOne('workspace_members', { workspace_id: workspaceId, user_id: req.user.id });
    if (!wsMember) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not a workspace member' } });
    const r = await aggregate('calls', [
      { $match: { workspace_id: workspaceId, status: 'live' } },
      { $lookup: { from: 'channels', localField: 'channel_id', foreignField: '_id', as: 'channel' } },
      { $unwind: { path: '$channel', preserveNullAndEmptyArrays: true } },
      { $match: { $or: [{ channel_id: null }, { 'channel.is_private': false }, { 'channel.is_private': { $exists: false } }] } }
    ]);
    const out = [];
    for (const row of r) out.push({ ...publicCall(row), participants: await callRoster(row.id) });
    res.json({ calls: out });
  } catch (e) {
    next(e);
  }
});

callsRouter.get('/calls/:id', requireAuth, requireCall, async (req, res, next) => {
  try {
    res.json({ call: { ...publicCall(req.call), participants: await callRoster(req.call.id) } });
  } catch (e) {
    next(e);
  }
});

callsRouter.post('/calls/:id/media', requireAuth, requireCall, async (req, res, next) => {
  try {
    if (req.call.status !== 'live') return res.status(400).json({ error: { code: 'ENDED', message: 'Call has ended' } });
    const patch = validate(callMediaSchema, req.body);
    const sets = {};
    if (patch.muted !== undefined) sets.muted = patch.muted;
    if (patch.cameraOff !== undefined) sets.camera_off = patch.cameraOff;
    if (patch.sharing !== undefined) sets.sharing = patch.sharing;
    if (Object.keys(sets).length) {
      await updateOne('call_participants', { call_id: req.call.id, user_id: req.user.id, left_at: null }, { $set: sets });
    }
    const roster = await callRoster(req.call.id);
    await publish({ type: 'call.media', payload: { callId: req.call.id, userId: req.user.id, roster } }, [`call:${req.call.id}`]);
    res.json({ call: { ...publicCall(req.call), participants: roster } });
  } catch (e) {
    next(e);
  }
});

callsRouter.post('/calls/:id/leave', requireAuth, requireCall, async (req, res, next) => {
  try {
    await updateOne('call_participants', { call_id: req.call.id, user_id: req.user.id, left_at: null }, { $set: { left_at: new Date() } });
    const roster = await callRoster(req.call.id);
    await publish({ type: 'call.left', payload: { callId: req.call.id, userId: req.user.id, roster } }, [`call:${req.call.id}`]);
    if (!roster.length && req.call.status === 'live') {
      await updateOne('calls', { id: req.call.id }, { $set: { status: 'ended', ended_at: new Date() } });
      await publish({ type: 'call.ended', payload: { callId: req.call.id } }, [`workspace:${req.call.workspace_id}`]);
    }
    res.json({ ok: true, participants: roster });
  } catch (e) {
    next(e);
  }
});

callsRouter.post('/calls/:id/end', requireAuth, requireCall, async (req, res, next) => {
  try {
    if (req.call.created_by !== req.user.id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the starter can end the call' } });
    }
    await updateOne('calls', { id: req.call.id }, { $set: { status: 'ended', ended_at: new Date() } });
    await publish({ type: 'call.ended', payload: { callId: req.call.id } }, [`call:${req.call.id}`, `workspace:${req.call.workspace_id}`]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
