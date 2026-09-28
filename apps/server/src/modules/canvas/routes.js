import { Router } from 'express';
import { findOne, insertOne, updateOne, deleteOne, find } from '../../database/db.js';
import { requireAuth } from '../../common/auth.js';
import { requireWorkspace } from '../workspaces/permissions.js';
import {
  canvasCreateSchema, canvasPatchSchema, canvasBlocksSchema,
  canvasCommentSchema, validate,
} from '@teamchat/validation';
import { publish } from '../../websocket/index.js';

export const canvasRouter = Router();

function publicCanvas(row) {
  return {
    id: row.id, workspaceId: row.workspace_id, channelId: row.channel_id,
    title: row.title, createdBy: row.created_by,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

async function requireCanvas(req, res, next) {
  try {
    const cv = await findOne('canvas', { id: req.params.id });
    if (!cv) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Canvas not found' } });
    const mem = await findOne('workspace_members', { workspace_id: cv.workspace_id, user_id: req.user.id });
    if (!mem) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not a workspace member' } });
    // Channel-linked canvases inherit private-channel visibility (Slack parity).
    if (cv.channel_id) {
      const ch = await findOne('channels', { id: cv.channel_id });
      if (ch?.is_private) {
        const cm = await findOne('channel_members', { channel_id: cv.channel_id, user_id: req.user.id });
        if (!cm) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Canvas not found' } });
      }
    }
    req.canvas = cv;
    next();
  } catch (e) {
    next(e);
  }
}

async function loadBlocks(canvasId) {
  const rows = await find('canvas_blocks', { canvas_id: canvasId });
  return rows.map((b) => ({
    id: b.id, kind: b.kind, content: b.content, data: b.data,
    position: Number(b.position), version: b.version ?? 1,
    updatedBy: b.updated_by, updatedAt: b.updated_at,
  }));
}

// POST /workspaces/:wid/canvas — new doc (seeded with one paragraph).
canvasRouter.post('/workspaces/:wid/canvas', requireAuth, requireWorkspace, async (req, res, next) => {
  try {
    const { title, channelId } = validate(canvasCreateSchema, req.body);
    if (channelId) {
      const ch = await findOne('channels', { id: channelId });
      if (!ch || ch.workspace_id !== req.workspace.id) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Channel not found' } });
      }
    }
    const cv = await insertOne('canvas', { workspace_id: req.workspace.id, channel_id: channelId || null, title, created_by: req.user.id });
    const first = await insertOne('canvas_blocks', { canvas_id: cv.id, kind: 'paragraph', content: '', position: 0, version: 1, updated_by: req.user.id });
    await publish({ type: 'canvas.created', payload: { canvas: publicCanvas(cv) } }, [`workspace:${req.workspace.id}`]);
    res.status(201).json({ canvas: publicCanvas(cv), blocks: await loadBlocks(cv.id), _seed: first.id });
  } catch (e) {
    next(e);
  }
});

// GET /workspaces/:wid/canvas — workspace docs.
canvasRouter.get('/workspaces/:wid/canvas', requireAuth, requireWorkspace, async (req, res, next) => {
  try {
    const rows = await find('canvas', { workspace_id: req.workspace.id });
    res.json({ canvas: rows.map(publicCanvas) });
  } catch (e) {
    next(e);
  }
});

// GET /canvas/:id — doc + blocks + comments.
canvasRouter.get('/canvas/:id', requireAuth, requireCanvas, async (req, res, next) => {
  try {
    const comments = await find('canvas_comments', { canvas_id: req.canvas.id }, { sort: { created_at: 1 } });
    const users = await find('users', { id: { $in: comments.map(c => c.user_id) } });
    const userMap = {};
    for (const u of users) userMap[u.id] = u;
    const commentsWithUsers = comments.map(c => ({ ...c, author: userMap[c.user_id]?.display_name }));
    res.json({ canvas: publicCanvas(req.canvas), blocks: await loadBlocks(req.canvas.id), comments: commentsWithUsers });
  } catch (e) {
    next(e);
  }
});

// PATCH /canvas/:id — rename.
canvasRouter.patch('/canvas/:id', requireAuth, requireCanvas, async (req, res, next) => {
  try {
    const { title } = validate(canvasPatchSchema, req.body);
    await updateOne('canvas', { id: req.canvas.id }, { $set: { title, updated_at: new Date() } });
    const updated = await findOne('canvas', { id: req.canvas.id });
    const out = publicCanvas(updated);
    await publish({ type: 'canvas.updated', payload: { canvas: out } }, [`canvas:${req.canvas.id}`]);
    res.json({ canvas: out });
  } catch (e) {
    next(e);
  }
});

// DELETE /canvas/:id
canvasRouter.delete('/canvas/:id', requireAuth, requireCanvas, async (req, res, next) => {
  try {
    await deleteOne('canvas', { id: req.canvas.id });
    await publish({ type: 'canvas.deleted', payload: { id: req.canvas.id } }, [`workspace:${req.canvas.workspace_id}`]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// PUT /canvas/:id/blocks — batch upsert with per-block LWW versioning:
// higher version wins, ties keep the stored row. All editors converge.
canvasRouter.put('/canvas/:id/blocks', requireAuth, requireCanvas, async (req, res, next) => {
  try {
    const { blocks } = validate(canvasBlocksSchema, req.body);
    const changed = [];
    for (const b of blocks) {
      if (b.delete && b.id) {
        await deleteOne('canvas_blocks', { id: b.id, canvas_id: req.canvas.id });
        changed.push({ id: b.id, deleted: true });
        continue;
      }
      if (b.id) {
        const cur = await findOne('canvas_blocks', { id: b.id, canvas_id: req.canvas.id });
        if (!cur) continue;
        const incoming = b.version ?? 1;
        const curVersion = cur.version ?? 1;
        if (incoming < curVersion) continue; // loser of the race — stored wins
        await updateOne('canvas_blocks', { id: b.id, canvas_id: req.canvas.id }, { $set: { kind: b.kind || cur.kind, content: b.content ?? cur.content, data: b.data ?? cur.data, position: b.position ?? cur.position, version: Math.max(incoming, curVersion + (incoming === curVersion ? 1 : 0)), updated_by: req.user.id, updated_at: new Date() } });
        const row = await findOne('canvas_blocks', { id: b.id, canvas_id: req.canvas.id });
        changed.push({ id: row.id, version: row.version });
      } else {
        const row = await insertOne('canvas_blocks', { canvas_id: req.canvas.id, kind: b.kind || 'paragraph', content: b.content || '', data: JSON.stringify(b.data ?? {}), position: b.position ?? Date.now(), version: 1, updated_by: req.user.id });
        changed.push({ id: row.id, version: row.version });
      }
    }
    await updateOne('canvas', { id: req.canvas.id }, { $set: { updated_at: new Date() } });
    const all = await loadBlocks(req.canvas.id);
    await publish({ type: 'canvas.blocks', payload: { canvasId: req.canvas.id, blocks: all, by: req.user.id } }, [`canvas:${req.canvas.id}`]);
    res.json({ blocks: all, changed });
  } catch (e) {
    next(e);
  }
});

// POST /canvas/:id/comments — discuss a doc or a block.
canvasRouter.post('/canvas/:id/comments', requireAuth, requireCanvas, async (req, res, next) => {
  try {
    const { content, blockId } = validate(canvasCommentSchema, req.body);
    if (blockId) {
      const blk = await findOne('canvas_blocks', { id: blockId, canvas_id: req.canvas.id });
      if (!blk) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Block not in this canvas' } });
    }
    const c = await insertOne('canvas_comments', { canvas_id: req.canvas.id, block_id: blockId || null, user_id: req.user.id, content });
    await publish({ type: 'canvas.comment', payload: { canvasId: req.canvas.id, comment: c } }, [`canvas:${req.canvas.id}`]);
    res.status(201).json({ comment: c });
  } catch (e) {
    next(e);
  }
});
