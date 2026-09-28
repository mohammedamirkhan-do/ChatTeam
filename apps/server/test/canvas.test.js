import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { createApp } = await import('../src/app.js');

let base;
let server;
const stamp = Date.now();
const userA = { email: `cva.${stamp}@example.com`, password: 'password-123', displayName: 'Canvas Ada' };
const userB = { email: `cvb.${stamp}@example.com`, password: 'password-123', displayName: 'Canvas Bob' };
const tok = {};
let wsId;
let cvId;

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function registerLogin(u) {
  await api('/auth/register', { method: 'POST', body: u });
  const { data } = await api('/auth/login', { method: 'POST', body: { email: u.email, password: u.password } });
  return { token: data.accessToken, id: data.user.id };
}

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  base = `http://localhost:${server.address().port}`;

  tok.A = await registerLogin(userA);
  tok.B = await registerLogin(userB);
  const ws = await api('/workspaces', { method: 'POST', token: tok.A.token, body: { name: `CanvasWS ${stamp}` } });
  wsId = ws.data.workspace.id;
  const inv = await api(`/workspaces/${wsId}/invites`, { method: 'POST', token: tok.A.token, body: { role: 'member' } });
  await api('/workspaces/join', { method: 'POST', token: tok.B.token, body: { token: inv.data.invite.token } });
});

after(async () => {
  server?.close();
  const { closeMongoDB } = await import('../src/database/pg.js');
  const { redis } = await import('../src/database/redis.js');
  try { await redis.disconnect(); } catch {}
  await closeMongoDB();
});

test('create canvas seeds one block; list shows it', async () => {
  const r = await api(`/workspaces/${wsId}/canvas`, { method: 'POST', token: tok.A.token, body: { title: 'Sprint plan' } });
  assert.equal(r.status, 201);
  cvId = r.data.canvas.id;
  assert.equal(r.data.blocks.length, 1);
  const list = await api(`/workspaces/${wsId}/canvas`, { token: tok.B.token });
  assert.ok(list.data.canvas.some((c) => c.id === cvId));
});

test('batch block edits: kinds, checklist, table, code', async () => {
  const cur = await api(`/canvas/${cvId}`, { token: tok.A.token });
  const seed = cur.data.blocks[0];
  const r = await api(`/canvas/${cvId}/blocks`, {
    method: 'PUT', token: tok.A.token,
    body: {
      blocks: [
        { id: seed.id, kind: 'heading', content: 'Sprint 12', version: seed.version },
        { kind: 'checklist', content: 'Ship search', data: { checked: true }, position: 1 },
        { kind: 'table', content: 'a|b\n1|2', position: 2 },
        { kind: 'code', content: 'console.log(1)', position: 3 },
      ],
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.blocks.length, 4);
  assert.ok(r.data.blocks.some((b) => b.kind === 'table'));
});

test('concurrent edits converge: higher version wins, stale loses', async () => {
  const cur = await api(`/canvas/${cvId}`, { token: tok.A.token });
  const head = cur.data.blocks.find((b) => b.kind === 'heading');
  // A writes v+1, B's stale v0 write is ignored.
  const a = await api(`/canvas/${cvId}/blocks`, { method: 'PUT', token: tok.A.token, body: { blocks: [{ id: head.id, content: 'Sprint 12 FINAL', version: head.version }] } });
  assert.ok(a.data.blocks.find((b) => b.id === head.id).content.includes('FINAL'));
  const stale = await api(`/canvas/${cvId}/blocks`, { method: 'PUT', token: tok.B.token, body: { blocks: [{ id: head.id, content: 'stale overwrite', version: 1 }] } });
  assert.ok(!stale.data.blocks.find((b) => b.id === head.id).content.includes('stale'));
  const fin = await api(`/canvas/${cvId}`, { token: tok.A.token });
  assert.ok(fin.data.blocks.find((b) => b.id === head.id).content.includes('FINAL'));
});

test('comments discuss the doc', async () => {
  const r = await api(`/canvas/${cvId}/comments`, { method: 'POST', token: tok.B.token, body: { content: 'Looks good!' } });
  assert.equal(r.status, 201);
  const got = await api(`/canvas/${cvId}`, { token: tok.A.token });
  assert.ok(got.data.comments.some((c) => c.content === 'Looks good!'));
});

test('non-members cannot read or write', async () => {
  const outsider = await registerLogin({ email: `cvo.${stamp}@example.com`, password: 'password-123', displayName: 'Canvas Out' });
  const r = await api(`/canvas/${cvId}`, { token: outsider.token });
  assert.equal(r.status, 403);
  const w = await api(`/canvas/${cvId}/blocks`, { method: 'PUT', token: outsider.token, body: { blocks: [] } });
  assert.equal(w.status, 403);
});

test('rename + delete lifecycle', async () => {
  const ren = await api(`/canvas/${cvId}`, { method: 'PATCH', token: tok.A.token, body: { title: 'Sprint plan v2' } });
  assert.equal(ren.data.canvas.title, 'Sprint plan v2');
  const del = await api(`/canvas/${cvId}`, { method: 'DELETE', token: tok.A.token });
  assert.equal(del.status, 200);
  const gone = await api(`/canvas/${cvId}`, { token: tok.A.token });
  assert.equal(gone.status, 404);
});
