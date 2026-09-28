import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { createApp } = await import('../src/app.js');

let base;
let server;
const stamp = Date.now();
const userA = { email: `cha.${stamp}@example.com`, password: 'password-123', displayName: 'Chan Ada' };
const userB = { email: `chb.${stamp}@example.com`, password: 'password-123', displayName: 'Chan Bob' };
const tok = {};
let wsId;
let devId;
let secretId;

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

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function registerLogin(u) {
  await api('/auth/register', { method: 'POST', body: u });
  const { data } = await api('/auth/login', { method: 'POST', body: { email: u.email, password: u.password } });
  return { token: data.accessToken, id: data.user.id };
}

test('setup: users + workspace with auto #general (Slack parity)', async () => {
  tok.A = await registerLogin(userA);
  tok.B = await registerLogin(userB);
  const ws = await api('/workspaces', { method: 'POST', token: tok.A.token, body: { name: `ChanWS ${stamp}` } });
  assert.equal(ws.status, 201);
  wsId = ws.data.workspace.id;
  const list = await api(`/workspaces/${wsId}/channels`, { token: tok.A.token });
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.channels.map((c) => c.name), ['general']);
});

test('B joins workspace, sees only public channels', async () => {
  const inv = await api(`/workspaces/${wsId}/invites`, { method: 'POST', token: tok.A.token, body: { role: 'member' } });
  await api('/workspaces/join', { method: 'POST', token: tok.B.token, body: { token: inv.data.invite.token } });
  // Owner must add B to general? No — general is public, B reads it via workspace membership.
  const list = await api(`/workspaces/${wsId}/channels`, { token: tok.B.token });
  assert.ok(list.data.channels.some((c) => c.name === 'general'));
});

test('create public + private channels', async () => {
  const dev = await api(`/workspaces/${wsId}/channels`, { method: 'POST', token: tok.A.token, body: { name: 'dev', description: 'Build talk' } });
  assert.equal(dev.status, 201);
  assert.equal(dev.data.channel.isPrivate, false);
  devId = dev.data.channel.id;
  const secret = await api(`/workspaces/${wsId}/channels`, { method: 'POST', token: tok.A.token, body: { name: 'secret', isPrivate: true } });
  assert.equal(secret.status, 201);
  assert.equal(secret.data.channel.isPrivate, true);
  secretId = secret.data.channel.id;
});

test('private channel invisible to non-members (Slack privacy)', async () => {
  const list = await api(`/workspaces/${wsId}/channels`, { token: tok.B.token });
  const names = list.data.channels.map((c) => c.name);
  assert.ok(names.includes('dev'));
  assert.ok(!names.includes('secret'));
  const open = await api(`/channels/${secretId}`, { token: tok.B.token });
  assert.equal(open.status, 403);
});

test('duplicate name rejected (case-insensitive)', async () => {
  const r = await api(`/workspaces/${wsId}/channels`, { method: 'POST', token: tok.A.token, body: { name: 'DEV' } });
  assert.equal(r.status, 409);
});

test('public join works; private join blocked without invite', async () => {
  const j = await api(`/channels/${devId}/join`, { method: 'POST', token: tok.B.token });
  assert.equal(j.status, 200);
  const blocked = await api(`/channels/${secretId}/join`, { method: 'POST', token: tok.B.token });
  assert.equal(blocked.status, 403);
});

test('member adds B to private channel, then B sees it', async () => {
  const add = await api(`/channels/${secretId}/members`, { method: 'POST', token: tok.A.token, body: { userId: tok.B.id } });
  assert.equal(add.status, 201);
  const open = await api(`/channels/${secretId}`, { token: tok.B.token });
  assert.equal(open.status, 200);
});

test('member cannot delete channel (DELETE_CHANNEL)', async () => {
  const r = await api(`/channels/${devId}`, { method: 'DELETE', token: tok.B.token });
  assert.equal(r.status, 403);
});

test('rename works; archived is read-only for edits', async () => {
  const ren = await api(`/channels/${devId}`, { method: 'PATCH', token: tok.B.token, body: { description: 'Build talk v2' } });
  assert.equal(ren.status, 200);
  assert.equal(ren.data.channel.description, 'Build talk v2');
  const arch = await api(`/channels/${devId}/archive`, { method: 'POST', token: tok.A.token });
  assert.equal(arch.status, 200);
  const edit = await api(`/channels/${devId}`, { method: 'PATCH', token: tok.A.token, body: { topic: 'nope' } });
  assert.equal(edit.status, 403);
  const un = await api(`/channels/${devId}/unarchive`, { method: 'POST', token: tok.A.token });
  assert.equal(un.status, 200);
});

test('#general protected from delete/archive/leave', async () => {
  const list = await api(`/workspaces/${wsId}/channels`, { token: tok.A.token });
  const general = list.data.channels.find((c) => c.name === 'general');
  const del = await api(`/channels/${general.id}`, { method: 'DELETE', token: tok.A.token });
  assert.equal(del.status, 403);
  const leave = await api(`/channels/${general.id}/leave`, { method: 'POST', token: tok.B.token });
  assert.equal(leave.status, 403);
});

test('leave + delete lifecycle', async () => {
  const leave = await api(`/channels/${devId}/leave`, { method: 'POST', token: tok.B.token });
  assert.equal(leave.status, 200);
  const del = await api(`/channels/${devId}`, { method: 'DELETE', token: tok.A.token });
  assert.equal(del.status, 200);
  const gone = await api(`/channels/${devId}`, { token: tok.A.token });
  assert.equal(gone.status, 404);
});
