import { Router } from 'express';
import { findOne, insertOne, find, aggregate, count, updateOne } from '../../database/db.js';
import { requireAuth } from '../../common/auth.js';
import { publish } from '../../websocket/index.js';

export const notificationsRouter = Router();

export async function notifyUser(userId, workspaceId, type, refId) {
  const n = await insertOne('notifications', { user_id: userId, workspace_id: workspaceId, type, ref_id: refId || null, is_read: false, created_at: new Date() });
  await publish(
    {
      type: 'notification.created',
      payload: {
        id: n.id,
        userId,
        workspaceId,
        type,
        refId: n.ref_id,
        createdAt: n.created_at,
      },
    },
    [`user:${userId}`]
  );
  return n;
}

notificationsRouter.get('/notifications', requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const r = await aggregate('notifications', [
      { $match: { user_id: req.user.id } },
      { $lookup: { from: 'workspaces', localField: 'workspace_id', foreignField: '_id', as: 'workspace' } },
      { $unwind: { path: '$workspace', preserveNullAndEmptyArrays: true } },
      { $addFields: { workspace_name: '$workspace.name' } },
      { $sort: { created_at: -1 } },
      { $limit: limit }
    ]);
    const unread = await count('notifications', { user_id: req.user.id, is_read: false });
    res.json({ notifications: r, unreadCount: unread });
  } catch (e) {
    next(e);
  }
});

notificationsRouter.post('/notifications/read', requireAuth, async (req, res, next) => {
  try {
    const { ids } = req.body || {};
    if (ids && ids.length) {
      await updateOne('notifications', { user_id: req.user.id }, { $set: { is_read: true } });
    } else {
      await updateOne('notifications', { user_id: req.user.id }, { $set: { is_read: true } });
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
