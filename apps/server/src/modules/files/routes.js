import { Router } from 'express';
import multer from 'multer';
import { createHash, randomUUID } from 'node:crypto';
import { findOne, insertOne, updateOne, deleteOne } from '../../database/db.js';
import { requireAuth } from '../../common/auth.js';
import { hasPermission } from '../workspaces/permissions.js';
import { putObject, getObject, deleteObject, signedUrl, presignPut, headObject } from './storage.js';
import { imageDims, makeThumb } from './thumbs.js';
import { getMessage, serializeMessage, resolveMentionEmails, loadAttachments, withButtons } from '../messages/service.js';
import { publish } from '../../websocket/index.js';
import { notifyUser } from '../notifications/routes.js';
import { filePresignSchema, fileShareSchema, validate } from '@teamchat/validation';

export const filesRouter = Router();

function maxMB() {
  return Number(process.env.FILE_MAX_MB || 50);
}
const BLOCKED_EXT = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'sh', 'dll', 'jar']);

function allowedMimes() {
  const raw = (process.env.FILE_ALLOWED_MIMES || '').trim();
  if (!raw) return null;
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxMB() * 1024 * 1024, files: 5 },
});

function extOf(name) {
  return (String(name).split('.').pop() || '').toLowerCase();
}

function checkType(filename, mime) {
  const ext = extOf(filename);
  if (BLOCKED_EXT.has(ext)) {
    const e = new Error(`Files of type .${ext} are not allowed`);
    e.status = 400;
    e.code = 'BLOCKED_TYPE';
    throw e;
  }
  const allow = allowedMimes();
  if (allow && mime && !allow.has(String(mime).toLowerCase())) {
    const ok = [...allow].some((a) => a.endsWith('/*') && String(mime).toLowerCase().startsWith(a.slice(0, -1)));
    if (!ok) {
      const e = new Error(`MIME ${mime} not allowed`);
      e.status = 400;
      e.code = 'BLOCKED_TYPE';
      throw e;
    }
  }
  return ext;
}

export async function scanFile(_buffer, _mime) {
  return { clean: true };
}

export function publicFile(f) {
  return {
    id: f.id,
    workspaceId: f.workspace_id,
    uploaderId: f.uploader_id,
    messageId: f.message_id,
    filename: f.filename,
    mimeType: f.mime_type,
    size: Number(f.size),
    width: f.width != null ? Number(f.width) : null,
    height: f.height != null ? Number(f.height) : null,
    duration: f.duration != null ? Number(f.duration) : null,
    url: `/files/${f.id}`,
    thumbUrl: f.thumb_storage_key ? `/files/${f.id}/thumb` : null,
    createdAt: f.created_at,
  };
}

function storageKey(workspaceId, filename) {
  const safe = String(filename).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'file';
  return `${workspaceId}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${safe}`;
}

async function storeBuffer({ workspaceId, uploaderId, filename, mimeType, buffer, size }) {
  const key = storageKey(workspaceId, filename);
  const stored = await putObject(key, buffer, mimeType);
  const checksum = createHash('sha256').update(buffer).digest('hex');
  const dims = await imageDims(buffer, mimeType);
  let thumbKey = null;
  let thumbBucket = null;
  try {
    const thumb = await makeThumb(buffer, mimeType);
    if (thumb) {
      const tkey = `${key}.thumb.jpg`;
      const tst = await putObject(tkey, thumb.buffer, thumb.mimeType);
      thumbKey = tst.key;
      thumbBucket = tst.bucket;
    }
  } catch {
    thumbKey = null;
  }
  const row = await insertOne('files', { workspace_id: workspaceId, uploader_id: uploaderId, filename: String(filename).slice(0, 255), mime_type: mimeType || 'application/octet-stream', size, storage_key: stored.key, bucket: stored.bucket, checksum, width: dims?.width ?? null, height: dims?.height ?? null, thumb_storage_key: thumbKey, thumb_bucket: thumbBucket });
  return row;
}

function attachRowArgs(msgId, file) {
  return [msgId, file.id, file.filename, file.mime_type, file.size, `/files/${file.id}`, file.thumb_storage_key ? `/files/${file.id}/thumb` : '', file.width ?? null, file.height ?? null];
}

export async function fileAccess(fileId, userId) {
  const file = await findOne('files', { id: fileId });
  if (!file) throw Object.assign(new Error('File not found'), { status: 404, code: 'NOT_FOUND' });
  const wsMember = await findOne('workspace_members', { workspace_id: file.workspace_id, user_id: userId });
  if (!wsMember) throw Object.assign(new Error('Not a workspace member'), { status: 403, code: 'FORBIDDEN' });
  if (file.message_id) {
    const msg = await findOne('messages', { id: file.message_id });
    if (msg?.dm_conversation_id) {
      const dm = await findOne('direct_conversation_members', { conversation_id: msg.dm_conversation_id, user_id: userId });
      if (!dm) throw Object.assign(new Error('Conversation not found'), { status: 403, code: 'FORBIDDEN' });
    } else if (msg?.channel_id) {
      const ch = await findOne('channels', { id: msg.channel_id });
      if (ch?.is_private) {
        const cm = await findOne('channel_members', { channel_id: msg.channel_id, user_id: userId });
        if (!cm) throw Object.assign(new Error('Private channel'), { status: 403, code: 'FORBIDDEN' });
      }
    }
  }
  return { file, wsRole: wsMember.role };
}

async function requireWorkspaceMember(wid, userId) {
  const ws = await findOne('workspaces', { id: wid });
  if (!ws) throw Object.assign(new Error('Workspace not found'), { status: 404, code: 'NOT_FOUND' });
  const member = await findOne('workspace_members', { workspace_id: ws.id, user_id: userId });
  if (!member) throw Object.assign(new Error('Not a workspace member'), { status: 403, code: 'FORBIDDEN' });
  return ws;
}

filesRouter.post('/workspaces/:wid/files', requireAuth, async (req, res, next) => {
  const run = upload.array('files', 5);
  run(req, res, async (err) => {
    if (err) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: { code: status === 413 ? 'TOO_LARGE' : 'BAD_REQUEST', message: status === 413 ? `File exceeds ${maxMB()}MB` : err.message } });
    }
    try {
      const ws = await requireWorkspaceMember(req.params.wid, req.user.id);
      if (!req.files?.length) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'No files uploaded (field: files)' } });
      const out = [];
      for (const f of req.files) {
        try {
          checkType(f.originalname, f.mimetype);
        } catch (e) {
          return res.status(e.status || 400).json({ error: { code: e.code || 'BLOCKED_TYPE', message: e.message } });
        }
        const scan = await scanFile(f.buffer, f.mimetype);
        if (!scan.clean) return res.status(400).json({ error: { code: 'BLOCKED_TYPE', message: 'File rejected by scanner' } });
        const row = await storeBuffer({ workspaceId: ws.id, uploaderId: req.user.id, filename: f.originalname, mimeType: f.mimetype || 'application/octet-stream', buffer: f.buffer, size: f.size });
        out.push(publicFile(row));
      }
      res.status(201).json({ files: out });
    } catch (e) {
      next(e);
    }
  });
});

filesRouter.post('/workspaces/:wid/files/presign', requireAuth, async (req, res, next) => {
  try {
    const ws = await requireWorkspaceMember(req.params.wid, req.user.id);
    const { filename, mimeType, size } = validate(filePresignSchema, req.body || {});
    try {
      checkType(filename, mimeType);
    } catch (e) {
      return res.status(e.status || 400).json({ error: { code: e.code || 'BLOCKED_TYPE', message: e.message } });
    }
    if (size && size > maxMB() * 1024 * 1024) {
      return res.status(413).json({ error: { code: 'TOO_LARGE', message: `File exceeds ${maxMB()}MB` } });
    }
    const key = storageKey(ws.id, filename);
    const mime = mimeType || 'application/octet-stream';
    const { uploadUrl, expiresIn, bucket } = await presignPut(key, mime);
    const row = await insertOne('files', { workspace_id: ws.id, uploader_id: req.user.id, filename: String(filename).slice(0, 255), mime_type: mime, size: size || 0, storage_key: key, bucket, checksum: null });
    res.status(201).json({ file: publicFile(row), uploadUrl, expiresIn });
  } catch (e) {
    next(e);
  }
});

filesRouter.post('/files/:id/confirm', requireAuth, async (req, res, next) => {
  try {
    const { file } = await fileAccess(req.params.id, req.user.id);
    if (file.uploader_id !== req.user.id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only uploader can confirm' } });
    }
    if (file.message_id) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'File already attached' } });
    let head;
    try {
      head = await headObject(file.storage_key);
    } catch {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Upload not found in storage — PUT bytes first' } });
    }
    if (head.size > maxMB() * 1024 * 1024) {
      await deleteObject(file.storage_key).catch(() => {});
      await deleteOne('files', { id: file.id });
      return res.status(413).json({ error: { code: 'TOO_LARGE', message: `File exceeds ${maxMB()}MB` } });
    }
    const obj = await getObject(file.storage_key);
    const chunks = [];
    for await (const c of obj.body) chunks.push(c);
    const buffer = Buffer.concat(chunks);
    const dims = await imageDims(buffer, file.mime_type);
    let thumbKey = null;
    let thumbBucket = null;
    const thumb = await makeThumb(buffer, file.mime_type).catch(() => null);
    if (thumb) {
      const tst = await putObject(`${file.storage_key}.thumb.jpg`, thumb.buffer, thumb.mimeType);
      thumbKey = tst.key;
      thumbBucket = tst.bucket;
    }
    const checksum = createHash('sha256').update(buffer).digest('hex');
    await updateOne('files', { id: file.id }, { $set: { size: head.size || buffer.length, checksum, width: dims?.width ?? null, height: dims?.height ?? null, thumb_storage_key: thumbKey, thumb_bucket: thumbBucket } });
    const updated = await findOne('files', { id: file.id });
    res.json({ file: publicFile(updated) });
  } catch (e) {
    next(e);
  }
});

function sendStream(res, file, body, { download = false } = {}) {
  res.setHeader('Content-Type', file.mime_type);
  if (file.size) res.setHeader('Content-Length', file.size);
  const disp = download ? 'attachment' : 'inline';
  res.setHeader('Content-Disposition', `${disp}; filename="${file.filename.replace(/"/g, '')}"`);
  body.pipe(res);
}

filesRouter.get('/files/:id', requireAuth, async (req, res, next) => {
  try {
    const { file } = await fileAccess(req.params.id, req.user.id);
    if (req.query.mode === 'redirect') {
      const url = await signedUrl(file.storage_key);
      return res.redirect(302, url);
    }
    const download = req.query.download === '1' || req.query.download === 'true';
    const obj = await getObject(file.storage_key);
    sendStream(res, file, obj.body, { download });
  } catch (e) {
    next(e);
  }
});

filesRouter.get('/files/:id/thumb', requireAuth, async (req, res, next) => {
  try {
    const { file } = await fileAccess(req.params.id, req.user.id);
    if (!file.thumb_storage_key) {
      if (req.query.mode === 'redirect') return res.redirect(302, await signedUrl(file.storage_key));
      const obj = await getObject(file.storage_key);
      return sendStream(res, file, obj.body);
    }
    if (req.query.mode === 'redirect') {
      return res.redirect(302, await signedUrl(file.thumb_storage_key));
    }
    const obj = await getObject(file.thumb_storage_key);
    res.setHeader('Content-Type', 'image/jpeg');
    obj.body.pipe(res);
  } catch (e) {
    next(e);
  }
});

filesRouter.delete('/files/:id', requireAuth, async (req, res, next) => {
  try {
    const { file } = await fileAccess(req.params.id, req.user.id);
    const isOwner = file.uploader_id === req.user.id;
    const canMod = await hasPermission(file.workspace_id, req.user.id, 'DELETE_MESSAGE');
    if (!isOwner && !canMod) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot delete this file' } });
    await deleteObject(file.storage_key).catch(() => {});
    if (file.thumb_storage_key) await deleteObject(file.thumb_storage_key).catch(() => {});
    await deleteOne('files', { id: file.id });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

filesRouter.post('/files/:id/share', requireAuth, async (req, res, next) => {
  try {
    const { file } = await fileAccess(req.params.id, req.user.id);
    const { channelId, content, parentMessageId } = validate(fileShareSchema, req.body || {});
    const ch = await findOne('channels', { id: channelId, workspace_id: file.workspace_id });
    if (!ch) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Channel not found' } });
    const cm = await findOne('channel_members', { channel_id: channelId, user_id: req.user.id });
    if (!cm) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Join the channel to post' } });
    if (ch.is_archived) return res.status(403).json({ error: { code: 'ARCHIVED', message: 'Channel is archived' } });
    if (parentMessageId) {
      const parent = await findOne('messages', { id: parentMessageId, deleted_at: null });
      if (!parent || parent.channel_id !== channelId) {
        return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Parent message not in this channel' } });
      }
    }
    const text = (content || file.filename).slice(0, 8000) || file.filename;
    const msg = await insertOne('messages', { workspace_id: file.workspace_id, channel_id: channelId, sender_id: req.user.id, parent_message_id: parentMessageId || null, content: text });
    await updateOne('files', { id: file.id }, { $set: { message_id: msg.id } });
    await insertOne('message_attachments', { message_id: msg.id, file_id: file.id, filename: file.filename, mime_type: file.mime_type, size: file.size, url: `/files/${file.id}`, thumb_url: file.thumb_storage_key ? `/files/${file.id}/thumb` : '', width: file.width ?? null, height: file.height ?? null });
    const emailIds = await resolveMentionEmails(file.workspace_id, text);
    const all = emailIds.filter((id) => id !== req.user.id);
    for (const uid of all) {
      await insertOne('message_mentions', { message_id: msg.id, mentioned_user_id: uid });
      await notifyUser(uid, file.workspace_id, 'mention', msg.id);
    }
    if (parentMessageId) {
      const parent = await findOne('messages', { id: parentMessageId });
      if (parent && parent.sender_id !== req.user.id && !all.includes(parent.sender_id)) {
        await notifyUser(parent.sender_id, file.workspace_id, 'thread_reply', msg.id);
      }
    }
    const full = await getMessage(msg.id);
    const out = (await withButtons([serializeMessage(full, { mentionIds: all, attachments: await loadAttachments([msg.id]) })]))[0];
    await publish({ type: 'message.created', payload: { message: out } }, [`channel:${channelId}`]);
    res.status(201).json({ message: out });
  } catch (e) {
    next(e);
  }
});
