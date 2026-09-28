import { Router } from 'express';
import { findOne } from '../../database/db.js';
import { requireAuth } from '../../common/auth.js';
import { getPresence } from '../../websocket/index.js';

export const presenceRouter = Router();

presenceRouter.get('/presence', requireAuth, async (req, res, next) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'workspaceId required' } });
    const member = await findOne('workspace_members', { workspace_id: workspaceId, user_id: req.user.id });
    if (!member) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not a workspace member' } });
    res.json({ presence: await getPresence(workspaceId) });
  } catch (e) {
    next(e);
  }
});
