import { Router } from 'express';
import { findOne, insertOne, aggregate, count } from '../../database/db.js';
import { requireAuth } from '../../common/auth.js';
import { hasPermission } from '../workspaces/permissions.js';

export async function auditLog(workspaceId, actorId, action, targetType = null, targetId = null, meta = {}) {
  try {
    await insertOne('audit_logs', { workspace_id: workspaceId, actor_id: actorId, action, target_type: targetType, target_id: targetId, meta: JSON.stringify(meta) });
  } catch {}
}

export const adminRouter = Router();

async function requireAuditViewer(req, res, next) {
  const { workspaceId } = req.query;
  if (!workspaceId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'workspaceId required' } });
  const mem = await findOne('workspace_members', { workspace_id: workspaceId, user_id: req.user.id });
  if (!mem) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not a workspace member' } });
  if (!(await hasPermission(workspaceId, req.user.id, 'VIEW_AUDIT_LOG'))) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Requires VIEW_AUDIT_LOG' } });
  }
  req.auditWorkspace = workspaceId;
  next();
}

adminRouter.get('/admin/users', requireAuth, requireAuditViewer, async (req, res, next) => {
  try {
    const r = await aggregate('workspace_members', [
      { $match: { workspace_id: req.auditWorkspace } },
      { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
      { $project: { id: '$user.id', email: '$user.email', display_name: '$user.display_name', status: '$user.status', created_at: '$user.created_at', role: 1, joined_at: 1 } },
      { $sort: { joined_at: 1 } },
      { $limit: 200 }
    ]);
    res.json({ users: r });
  } catch (e) {
    next(e);
  }
});

adminRouter.get('/admin/sessions', requireAuth, requireAuditViewer, async (req, res, next) => {
  try {
    const r = await aggregate('sessions', [
      { $match: { workspace_id: req.auditWorkspace } },
      { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
      { $lookup: { from: 'workspace_members', localField: 'user_id', foreignField: 'user_id', as: 'wm' } },
      { $unwind: '$wm' },
      { $project: { id: 1, user_id: 1, display_name: '$user.display_name', device_info: 1, ip: 1, created_at: 1, expires_at: 1 } },
      { $sort: { created_at: -1 } },
      { $limit: 200 }
    ]);
    res.json({ sessions: r });
  } catch (e) {
    next(e);
  }
});

adminRouter.get('/admin/audit', requireAuth, requireAuditViewer, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const r = await aggregate('audit_logs', [
      { $match: { workspace_id: req.auditWorkspace } },
      { $lookup: { from: 'users', localField: 'actor_id', foreignField: '_id', as: 'user' } },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      { $addFields: { actor: '$user.display_name' } },
      { $sort: { created_at: -1 } },
      { $limit: limit }
    ]);
    res.json({ audit: r });
  } catch (e) {
    next(e);
  }
});

adminRouter.get('/admin/usage', requireAuth, requireAuditViewer, async (req, res, next) => {
  try {
    const wid = req.auditWorkspace;
    const [msgs, files, channels, dms, bots, integs, calls, canvases] = await Promise.all([
      count('messages', { workspace_id: wid }),
      aggregate('files', [{ $match: { workspace_id: wid } }, { $group: { _id: null, n: { $sum: 1 }, bytes: { $sum: '$size' } } }]),
      count('channels', { workspace_id: wid }),
      count('direct_conversations', { workspace_id: wid }),
      count('bots', { workspace_id: wid }),
      count('integrations', { workspace_id: wid }),
      count('calls', { workspace_id: wid }),
      count('canvas', { workspace_id: wid }),
    ]);
    const fileStats = files[0] || { n: 0, bytes: 0 };
    res.json({
      usage: {
        messages: msgs, files: fileStats.n, fileBytes: Number(fileStats.bytes || 0),
        channels: channels, conversations: dms, bots: bots,
        integrations: integs, calls: calls, canvases: canvases,
      },
    });
  } catch (e) {
    next(e);
  }
});
