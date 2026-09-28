import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { createApp } = await import('../src/app.js');

let base;
let server;
const stamp = Date.now();
const userA = { email: `wsa.${stamp}@example.com`, password: 'password-123', displayName: 'Owner Ada' };
const userB = { email: `wsb.${stamp}@example.com`, password: 'password-123', displayName: 'Member Bob' };
const tok = {};
let wsId;
let inviteToken;

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

test('setup: two users', async () => {
  tok.A = await registerLogin(userA);
  tok.B = await registerLogin(userB);
  assert.ok(tok.A.token && tok.B.token);
});

test('creator becomes owner', async () => {
  const { status, data } = await api('/workspaces', { method: 'POST', token: tok.A.token, body: { name: `Acme ${stamp}` } });
  assert.equal(status, 201);
  assert.equal(data.workspace.role, 'owner');
  assert.ok(data.workspace.slug.startsWith('acme-'));
  wsId = data.workspace.id;
});

test('non-member cannot see or open the workspace (Slack private-by-default)', async () => {
  const list = await api('/workspaces', { token: tok.B.token });
  assert.deepEqual(list.data.workspaces, []);
  const open = await api(`/workspaces/${wsId}`, { token: tok.B.token });
  assert.equal(open.status, 403);
});

test('member cannot manage workspace (RBAC)', async () => {
  // Owner invites B as member first via direct flow below; here B is still outsider -> 403 either way.
  const r = await api(`/workspaces/${wsId}`, { method: 'PATCH', token: tok.B.token, body: { name: 'Hijacked' } });
  assert.equal(r.status, 403);
});

test('owner invites B, B joins via code (Slack invite link)', async () => {
  const inv = await api(`/workspaces/${wsId}/invites`, { method: 'POST', token: tok.A.token, body: { role: 'member' } });
  assert.equal(inv.status, 201);
  assert.ok(inv.data.invite.token);
  inviteToken = inv.data.invite.token;
  const join = await api('/workspaces/join', { method: 'POST', token: tok.B.token, body: { token: inviteToken } });
  assert.equal(join.status, 200);
  assert.equal(join.data.workspace.role, 'member');
  const list = await api('/workspaces', { token: tok.B.token });
  assert.equal(list.data.workspaces.length, 1);
});

test('member still cannot rename workspace', async () => {
  const r = await api(`/workspaces/${wsId}`, { method: 'PATCH', token: tok.B.token, body: { name: 'Hijacked' } });
  assert.equal(r.status, 403);
  assert.equal(r.data.error.code, 'FORBIDDEN');
});

test('owner renames workspace', async () => {
  const r = await api(`/workspaces/${wsId}`, { method: 'PATCH', token: tok.A.token, body: { name: 'Acme Inc' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.workspace.name, 'Acme Inc');
});

test('members list is visible to members, with roles', async () => {
  const { status, data } = await api(`/workspaces/${wsId}/members`, { token: tok.B.token });
  assert.equal(status, 200);
  assert.equal(data.members.length, 2);
  const roles = Object.fromEntries(data.members.map((m) => [m.user.email, m.role]));
  assert.equal(roles[userA.email], 'owner');
  assert.equal(roles[userB.email], 'member');
});

test('member cannot invite as moderator (no escalation past self)', async () => {
  const r = await api(`/workspaces/${wsId}/invites`, { method: 'POST', token: tok.B.token, body: { role: 'moderator' } });
  assert.equal(r.status, 403);
});

test('member CAN invite as guest (rank below self)', async () => {
  const r = await api(`/workspaces/${wsId}/invites`, { method: 'POST', token: tok.B.token, body: { role: 'guest' } });
  assert.equal(r.status, 201);
});

test('guest invite email-lock is enforced', async () => {
  const inv = await api(`/workspaces/${wsId}/invites`, { method: 'POST', token: tok.A.token, body: { email: 'someone-else@example.com', role: 'guest' } });
  const join = await api('/workspaces/join', { method: 'POST', token: tok.B.token, body: { token: inv.data.invite.token } });
  assert.equal(join.status, 403);
});

test('only MANAGE_ROLES can change roles; owner demotes/promotes', async () => {
  const denied = await api(`/workspaces/${wsId}/members/${tok.B.id}`, { method: 'PATCH', token: tok.B.token, body: { role: 'moderator' } });
  assert.equal(denied.status, 403);
  const ok = await api(`/workspaces/${wsId}/members/${tok.B.id}`, { method: 'PATCH', token: tok.A.token, body: { role: 'moderator' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.role, 'moderator');
});

test('users/:id visible within shared workspace only', async () => {
  const seen = await api(`/users/${tok.A.id}`, { token: tok.B.token });
  assert.equal(seen.status, 200);
  const userC = { email: `wsc.${stamp}@example.com`, password: 'password-123', displayName: 'Stranger' };
  const c = await registerLogin(userC);
  const hidden = await api(`/users/${tok.A.id}`, { token: c.token });
  assert.equal(hidden.status, 403);
});

test('switch returns workspace context', async () => {
  const { status, data } = await api(`/workspaces/${wsId}/switch`, { method: 'POST', token: tok.B.token });
  assert.equal(status, 200);
  assert.equal(data.workspace.memberCount, 2);
});

test('slug stays unique', async () => {
  const first = await api('/workspaces', { method: 'POST', token: tok.A.token, body: { name: `Dup ${stamp}` } });
  const second = await api('/workspaces', { method: 'POST', token: tok.A.token, body: { name: `Dup ${stamp}` } });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(first.data.workspace.slug, second.data.workspace.slug);
});

test('last owner cannot be removed; non-owner cannot delete workspace', async () => {
  const delDenied = await api(`/workspaces/${wsId}`, { method: 'DELETE', token: tok.B.token });
  assert.equal(delDenied.status, 403);
  const rmOwner = await api(`/workspaces/${wsId}/members/${tok.A.id}`, { method: 'DELETE', token: tok.A.token });
  assert.equal(rmOwner.status, 403);
});
