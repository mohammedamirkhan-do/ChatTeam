import { findOne } from '../../database/db.js';

export const ROLE_RANK = Object.freeze({ guest: 0, bot: 0, member: 1, moderator: 2, admin: 3, owner: 4 });
export const ROLES = Object.freeze(Object.keys(ROLE_RANK));

const PERMISSION_MATRIX = Object.freeze({
  owner: ['MANAGE_WORKSPACE', 'MANAGE_ROLES', 'INVITE_MEMBER', 'REMOVE_MEMBER', 'CREATE_CHANNEL', 'DELETE_CHANNEL', 'DELETE_MESSAGE', 'MANAGE_INTEGRATIONS', 'VIEW_AUDIT_LOG'],
  admin: ['MANAGE_WORKSPACE', 'MANAGE_ROLES', 'INVITE_MEMBER', 'REMOVE_MEMBER', 'CREATE_CHANNEL', 'DELETE_CHANNEL', 'DELETE_MESSAGE', 'MANAGE_INTEGRATIONS', 'VIEW_AUDIT_LOG'],
  moderator: ['INVITE_MEMBER', 'REMOVE_MEMBER', 'CREATE_CHANNEL', 'DELETE_MESSAGE', 'DELETE_CHANNEL', 'VIEW_AUDIT_LOG'],
  member: ['INVITE_MEMBER', 'CREATE_CHANNEL'],
  bot: ['INVITE_MEMBER', 'CREATE_CHANNEL'],
  guest: [],
});

export async function hasPermission(workspaceId, userId, permission) {
  const wsMember = await findOne('workspace_members', { workspace_id: workspaceId, user_id: userId });
  if (!wsMember) return false;
  // Prefer DB-driven role_permissions when seeded, fall back to matrix.
  try {
    const rp = await findOne('role_permissions', { role: wsMember.role, permission });
    if (rp) return true;
  } catch {}
  return (PERMISSION_MATRIX[wsMember.role] || []).includes(permission);
}

export async function requireWorkspace(req, res, next) {
  try {
    const wid = req.params.wid || req.params.id;
    if (!/^[0-9a-f]{24}$/i.test(wid || '') && !/^[0-9a-f-]{36}$/i.test(wid || '')) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } });
    }
    const ws = await findOne('workspaces', { id: wid });
    if (!ws) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } });
    const membership = await findOne('workspace_members', { workspace_id: wid, user_id: req.user.id });
    if (!membership) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not a workspace member' } });
    req.workspace = ws;
    req.membership = membership;
    next();
  } catch (e) {
    next(e);
  }
}

export function requirePermission(permission) {
  return async (req, res, next) => {
    try {
      const ok = await hasPermission(req.workspace.id, req.user.id, permission);
      if (!ok) return res.status(403).json({ error: { code: 'FORBIDDEN', message: `Requires ${permission}` } });
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function publicWorkspace(ws, role) {
  return {
    id: ws.id,
    name: ws.name,
    slug: ws.slug,
    iconUrl: ws.icon_url,
    settings: ws.settings,
    role: role || undefined,
    createdAt: ws.created_at,
  };
}
