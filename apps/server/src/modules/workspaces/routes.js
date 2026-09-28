import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { findOne, insertOne, updateOne, deleteOne, find, count } from '../../database/db.js';
import { publicUser, requireAuth } from '../../common/auth.js';
import { hashToken, newOpaqueToken } from '../auth/tokens.js';
import {
  requireWorkspace,
  requirePermission,
  publicWorkspace,
  hasPermission,
  ROLE_RANK,
  ROLES,
} from './permissions.js';
import {
  workspaceCreateSchema,
  workspacePatchSchema,
  inviteCreateSchema,
  joinSchema,
  memberRoleSchema,
  validate,
} from '@teamchat/validation';
import { ensureGeneral } from '../channels/service.js';
import { auditLog } from '../admin/routes.js';

export const workspacesRouter = Router();

function slugify(name) {
  return (
    name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'workspace'
  );
}

async function uniqueSlug(base) {
  let slug = base;
  for (let i = 0; i < 10; i++) {
    const exists = await findOne('workspaces', { slug });
    if (!exists) return slug;
    slug = `${base}-${randomBytes(3).toString('hex')}`;
  }
  return `${base}-${Date.now()}`;
}

// POST /workspaces — creator becomes owner (like Slack).
workspacesRouter.post('/workspaces', requireAuth, async (req, res, next) => {
  try {
    const { name, slug } = validate(workspaceCreateSchema, req.body);
    const finalSlug = await uniqueSlug(slug || slugify(name));
    const ws = await insertOne('workspaces', { name, slug: finalSlug, created_by: req.user.id });
    await insertOne('workspace_members', { workspace_id: ws.id, user_id: req.user.id, role: 'owner', invited_by: req.user.id });
    await ensureGeneral(ws.id, req.user.id);
    res.status(201).json({ workspace: publicWorkspace(ws, 'owner') });
  } catch (e) {
    next(e);
  }
});

// GET /workspaces — mine with my role.
workspacesRouter.get('/workspaces', requireAuth, async (req, res, next) => {
  try {
    const memberships = await find('workspace_members', { user_id: req.user.id });
    const out = [];
    for (const m of memberships) {
      const ws = await findOne('workspaces', { id: m.workspace_id });
      if (ws) out.push(publicWorkspace(ws, m.role));
    }
    res.json({ workspaces: out });
  } catch (e) {
    next(e);
  }
});

// GET /workspaces/:id
workspacesRouter.get('/workspaces/:id', requireAuth, requireWorkspace, async (req, res) => {
  const memberCount = await count('workspace_members', { workspace_id: req.workspace.id });
  res.json({ workspace: { ...publicWorkspace(req.workspace, req.membership.role), memberCount } });
});

// PATCH /workspaces/:id
workspacesRouter.patch('/workspaces/:id', requireAuth, requireWorkspace, requirePermission('MANAGE_WORKSPACE'), async (req, res, next) => {
  try {
    const patch = validate(workspacePatchSchema, req.body);
    const set = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.iconUrl !== undefined) set.iconUrl = patch.iconUrl;
    set.updated_at = new Date();
    if (!Object.keys(set).length) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Nothing to update' } });
    await updateOne('workspaces', { id: req.workspace.id }, { $set: set });
    const ws = await findOne('workspaces', { id: req.workspace.id });
    res.json({ workspace: publicWorkspace(ws, req.membership.role) });
  } catch (e) {
    next(e);
  }
});

// DELETE /workspaces/:id — owner only.
workspacesRouter.delete('/workspaces/:id', requireAuth, requireWorkspace, async (req, res, next) => {
  try {
    if (req.membership.role !== 'owner') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the owner can delete a workspace' } });
    }
    await deleteOne('workspaces', { id: req.workspace.id });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// POST /workspaces/:id/invites — shareable code, optional email lock.
workspacesRouter.post('/workspaces/:id/invites', requireAuth, requireWorkspace, requirePermission('INVITE_MEMBER'), async (req, res, next) => {
  try {
    const { email, role } = validate(inviteCreateSchema, req.body);
    if (ROLE_RANK[role] >= ROLE_RANK[req.membership.role]) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot invite at or above your own role' } });
    }
    const raw = newOpaqueToken(24);
    const inv = await insertOne('invites', { workspace_id: req.workspace.id, email: email || null, role, token_hash: hashToken(raw), created_by: req.user.id });
    res.status(201).json({ invite: { ...inv, token: raw } });
  } catch (e) {
    next(e);
  }
});

// POST /workspaces/join { token }
workspacesRouter.post('/workspaces/join', requireAuth, async (req, res, next) => {
  try {
    const { token } = validate(joinSchema, req.body);
    const inv = await findOne('invites', { token_hash: hashToken(token) });
    if (!inv || inv.accepted_at || new Date(inv.expires_at) < new Date()) {
      return res.status(400).json({ error: { code: 'INVALID_TOKEN', message: 'Invalid or expired invite' } });
    }
    if (inv.email && inv.email.toLowerCase() !== req.user.email.toLowerCase()) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This invite is for a different email' } });
    }
    await insertOne('workspace_members', { workspace_id: inv.workspace_id, user_id: req.user.id, role: inv.role, invited_by: inv.created_by });
    // Slack parity: every workspace member is in #general.
    const general = await findOne('channels', { workspace_id: inv.workspace_id, slug: 'general' });
    if (general) {
      const existing = await findOne('channel_members', { channel_id: general.id, user_id: req.user.id });
      if (!existing) await insertOne('channel_members', { channel_id: general.id, user_id: req.user.id, role: 'member' });
    }
    await updateOne('invites', { id: inv.id }, { $set: { accepted_at: new Date() } });
    const ws = await findOne('workspaces', { id: inv.workspace_id });
    res.json({ workspace: publicWorkspace(ws, inv.role) });
  } catch (e) {
    next(e);
  }
});

// GET /workspaces/:id/members
workspacesRouter.get('/workspaces/:id/members', requireAuth, requireWorkspace, async (req, res, next) => {
  try {
    const members = await find('workspace_members', { workspace_id: req.workspace.id });
    const out = [];
    for (const m of members) {
      const u = await findOne('users', { id: m.user_id });
      if (!u) continue;
      out.push({ user: publicUser(u), role: m.role, joinedAt: m.created_at });
    }
    res.json({ members: out });
  } catch (e) {
    next(e);
  }
});

// PATCH /workspaces/:id/members/:userId — owners manage roles, never escalate past self.
workspacesRouter.patch('/workspaces/:id/members/:userId', requireAuth, requireWorkspace, requirePermission('MANAGE_ROLES'), async (req, res, next) => {
  try {
    const { role } = validate(memberRoleSchema, req.body);
    if (!ROLES.includes(role)) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Unknown role' } });
    const target = await findOne('workspace_members', { workspace_id: req.workspace.id, user_id: req.params.userId });
    if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Member not found' } });
    if (target.role === 'owner') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Ownership cannot be changed here' } });
    }
    if (ROLE_RANK[role] >= ROLE_RANK[req.membership.role] || ROLE_RANK[target.role] >= ROLE_RANK[req.membership.role]) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot grant or change a role at/above your own' } });
    }
    await updateOne('workspace_members', { workspace_id: req.workspace.id, user_id: req.params.userId }, { $set: { role } });
    await auditLog(req.workspace.id, req.user.id, 'member.role_changed', 'user', req.params.userId, { from: target.role, to: role });
    res.json({ ok: true, role });
  } catch (e) {
    next(e);
  }
});

// DELETE /workspaces/:id/members/:userId — remove (or leave yourself).
workspacesRouter.delete('/workspaces/:id/members/:userId', requireAuth, requireWorkspace, async (req, res, next) => {
  try {
    const leaving = req.params.userId === req.user.id;
    if (!leaving) {
      const ok = await hasPermission(req.workspace.id, req.user.id, 'REMOVE_MEMBER');
      if (!ok) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Requires REMOVE_MEMBER' } });
    }
    const target = await findOne('workspace_members', { workspace_id: req.workspace.id, user_id: req.params.userId });
    if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Member not found' } });
    if (target.role === 'owner') {
      const ownerCount = await count('workspace_members', { workspace_id: req.workspace.id, role: 'owner' });
      if (ownerCount <= 1) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'A workspace needs at least one owner' } });
    }
    await deleteOne('workspace_members', { workspace_id: req.workspace.id, user_id: req.params.userId });
    await auditLog(req.workspace.id, req.user.id, leaving ? 'member.left' : 'member.removed', 'user', req.params.userId, {});
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// POST /workspaces/:id/switch — current workspace context (token scoping lands with channels).
workspacesRouter.post('/workspaces/:id/switch', requireAuth, requireWorkspace, async (req, res) => {
  const memberCount = await count('workspace_members', { workspace_id: req.workspace.id });
  res.json({ workspace: { ...publicWorkspace(req.workspace, req.membership.role), memberCount } });
});

// GET /users/:id — visible only within a shared workspace (like Slack).
export async function userDetailHandler(req, res, next) {
  try {
    if (req.params.id !== req.user.id) {
      const mine = await find('workspace_members', { user_id: req.user.id });
      const mineIds = new Set(mine.map((m) => m.workspace_id));
      let shared = false;
      if (mineIds.size) {
        const theirs = await find('workspace_members', { user_id: req.params.id });
        shared = theirs.some((m) => mineIds.has(m.workspace_id));
      }
      if (!shared) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'No shared workspace' } });
      }
    }
    const u = await findOne('users', { id: req.params.id });
    if (!u) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    res.json({ user: publicUser(u) });
  } catch (e) {
    next(e);
  }
}
