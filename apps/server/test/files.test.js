import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.FILE_MAX_MB = process.env.FILE_MAX_MB || '1'; // small quota to prove 413 cheaply

const { createApp } = await import('../src/app.js');

let base;
let server;
const stamp = Date.now();
const userA = { email: `fla.${stamp}@example.com`, password: 'password-123', displayName: 'File Ada' };
const userB = { email: `flb.${stamp}@example.com`, password: 'password-123', displayName: 'File Bob' };
const tok = {};
let wsId;
let chId;
let privId;

function pngBuffer() {
  // Minimal valid 1x1 PNG.
  return Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff0300000600050b606', 'hex');
}

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  server?.close();
  const { closeMongoDB } = await import('../src/database/pg.js');
  const { redis } = await import('../src/database/redis.js');
  try { await redis.disconnect(); } catch {}
  await closeMongoDB();
});

async function api(path, { method = 'GET', body, token, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!form) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => ({})) : await res.arrayBuffer();
  return { status: res.status, data, headers: res.headers };
}

async function registerLogin(u) {
  await api('/auth/register', { method: 'POST', body: u });
  const { data } = await api('/auth/login', { method: 'POST', body: { email: u.email, password: u.password } });
  return { token: data.accessToken, id: data.user.id };
}

function uploadForm(buf, filename, type) {
  const fd = new FormData();
  fd.append('files', new Blob([buf], { type }), filename);
  return fd;
}

test('setup: users + workspace + public/private channels', async () => {
  tok.A = await registerLogin(userA);
  tok.B = await registerLogin(userB);
  const ws = await api('/workspaces', { method: 'POST', token: tok.A.token, body: { name: `FileWS ${stamp}` } });
  wsId = ws.data.workspace.id;
  const inv = await api(`/workspaces/${wsId}/invites`, { method: 'POST', token: tok.A.token, body: { role: 'member' } });
  await api('/workspaces/join', { method: 'POST', token: tok.B.token, body: { token: inv.data.invite.token } });
  const ch = await api(`/workspaces/${wsId}/channels`, { method: 'POST', token: tok.A.token, body: { name: 'files' } });
  chId = ch.data.channel.id;
  await api(`/channels/${chId}/join`, { method: 'POST', token: tok.B.token });
  const priv = await api(`/workspaces/${wsId}/channels`, { method: 'POST', token: tok.A.token, body: { name: 'vault', isPrivate: true } });
  privId = priv.data.channel.id;
});

test('upload -> attach -> message carries metadata (Slack attach flow)', async () => {
  const up = await api(`/workspaces/${wsId}/files`, { method: 'POST', token: tok.A.token, form: uploadForm(pngBuffer(), 'dot.png', 'image/png') });
  assert.equal(up.status, 201);
  const f = up.data.files[0];
  assert.equal(f.filename, 'dot.png');
  assert.equal(f.mimeType, 'image/png');
  assert.ok(f.size > 0);
  const msg = await api(`/channels/${chId}/messages`, { method: 'POST', token: tok.A.token, body: { content: 'see attached', attachmentIds: [f.id] } });
  assert.equal(msg.status, 201);
  assert.equal(msg.data.message.attachments.length, 1);
  assert.equal(msg.data.message.attachments[0].filename, 'dot.png');
  assert.equal(msg.data.message.attachments[0].url, `/files/${f.id}`);
});

test('download round-trips exact bytes with content type', async () => {
  const up = await api(`/workspaces/${wsId}/files`, { method: 'POST', token: tok.A.token, form: uploadForm(pngBuffer(), 'copy.png', 'image/png') });
  const fid = up.data.files[0].id;
  const dl = await api(`/files/${fid}`, { token: tok.B.token });
  assert.equal(dl.status, 200);
  assert.ok((dl.headers.get('content-type') || '').includes('image/png'));
  assert.deepEqual(Buffer.from(dl.data), pngBuffer());
});

test('private-channel file invisible to non-members', async () => {
  const up = await api(`/workspaces/${wsId}/files`, { method: 'POST', token: tok.A.token, form: uploadForm(pngBuffer(), 'secret.png', 'image/png') });
  const fid = up.data.files[0].id;
  const msg = await api(`/channels/${privId}/messages`, { method: 'POST', token: tok.A.token, body: { content: 'vault file', attachmentIds: [fid] } });
  assert.equal(msg.status, 201);
  const denied = await api(`/files/${fid}`, { token: tok.B.token });
  assert.equal(denied.status, 403);
  const allowed = await api(`/files/${fid}`, { token: tok.A.token });
  assert.equal(allowed.status, 200);
});

test('dangerous types rejected', async () => {
  const bad = await api(`/workspaces/${wsId}/files`, { method: 'POST', token: tok.A.token, form: uploadForm(Buffer.from('MZ'), 'run.exe', 'application/octet-stream') });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error.code, 'BLOCKED_TYPE');
});

test('over-quota upload rejected (413)', async () => {
  const big = Buffer.alloc(2 * 1024 * 1024, 1); // 2MB > 1MB test quota
  const r = await api(`/workspaces/${wsId}/files`, { method: 'POST', token: tok.A.token, form: uploadForm(big, 'big.bin', 'application/octet-stream') });
  assert.equal(r.status, 413);
  assert.equal(r.data.error.code, 'TOO_LARGE');
});

test('delete removes file + storage (uploader)', async () => {
  const up = await api(`/workspaces/${wsId}/files`, { method: 'POST', token: tok.A.token, form: uploadForm(pngBuffer(), 'gone.png', 'image/png') });
  const fid = up.data.files[0].id;
  const denied = await api(`/files/${fid}`, { method: 'DELETE', token: tok.B.token });
  assert.equal(denied.status, 403);
  const del = await api(`/files/${fid}`, { method: 'DELETE', token: tok.A.token });
  assert.equal(del.status, 200);
  const gone = await api(`/files/${fid}`, { token: tok.A.token });
  assert.equal(gone.status, 404);
});

test('share posts file into a channel (Slack /share)', async () => {
  const up = await api(`/workspaces/${wsId}/files`, { method: 'POST', token: tok.A.token, form: uploadForm(pngBuffer(), 'shared.png', 'image/png') });
  const fid = up.data.files[0].id;
  const shared = await api(`/files/${fid}/share`, { method: 'POST', token: tok.A.token, body: { channelId: chId, content: 'sharing this' } });
  assert.equal(shared.status, 201);
  assert.equal(shared.data.message.attachments[0].filename, 'shared.png');
});
