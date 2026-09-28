import { findOne, aggregate } from '../../database/db.js';

export function publicCall(row, extra = {}) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    dmConversationId: row.dm_conversation_id,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    endedAt: row.ended_at,
    ...extra,
  };
}

export async function getCall(id) {
  return findOne('calls', { id: id });
}

export async function requireCall(req, res, next) {
  try {
    const call = await getCall(req.params.id);
    if (!call) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Call not found' } });
    const wsMember = await findOne('workspace_members', { workspace_id: call.workspace_id, user_id: req.user.id });
    if (!wsMember) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not a workspace member' } });
    if (call.channel_id) {
      const ch = await findOne('channels', { id: call.channel_id });
      if (ch?.is_private) {
        const cm = await findOne('channel_members', { channel_id: call.channel_id, user_id: req.user.id });
        if (!cm) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Call not found' } });
      }
    } else {
      const dm = await findOne('direct_conversation_members', { conversation_id: call.dm_conversation_id, user_id: req.user.id });
      if (!dm) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Call not found' } });
    }
    req.call = call;
    next();
  } catch (e) {
    next(e);
  }
}

export async function callRoster(callId) {
  const r = await aggregate('call_participants', [
    { $match: { call_id: callId, left_at: null } },
    { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'user' } },
    { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
    { $project: { user_id: '$user_id', display_name: '$user.display_name', avatar_url: '$user.avatar_url', muted: 1, camera_off: 1, sharing: 1, joined_at: 1 } }
  ]);
  return r.map((p) => ({
    userId: p.user_id, displayName: p.display_name, avatarUrl: p.avatar_url,
    muted: p.muted, cameraOff: p.camera_off, sharing: p.sharing, joinedAt: p.joined_at,
  }));
}
