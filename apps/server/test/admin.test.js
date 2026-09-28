import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { createApp } = await import('../src/app.js');

let base;
let server;
const stamp = Date.now();
const userA = { email: `ada.${stamp}@example.com`, password: 'password-123', displayName: 'Admin Ada' };
const userB = { email: `adb.${stamp}@example.com`, password: 'password-123', displayName: 'Admin Bob' };
const tok = {};
let wsId;

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
  const ws = await api('/workspaces', { method: 'POST', token: tok.A.token, body: { name: `AdminWS ${stamp}` } });
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

test('members cannot view admin; owners can', async () => {
  const denied = await api(`/admin/audit?workspaceId=${wsId}`, { token: tok.B.token });
  assert.equal(denied.status, 403);
  const ok = await api(`/admin/audit?workspaceId=${wsId}`, { token: tok.A.token });
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.data.audit));
});

test('privileged actions land in the audit trail', async () => {
  // Promote Bob to moderator (owner-only action).
  const role = await api(`/workspaces/${wsId}/members/${tok.B.id}`, { method: 'PATCH', token: tok.A.token, body: { role: 'moderator' } });
  assert.equal(role.status, 200);
  // Create + delete a channel (DELETE_CHANNEL needs owner/admin — Ada is owner).
  const ch = await api(`/workspaces/${wsId}/channels`, { method: 'POST', token: tok.A.token, body: { name: 'auditchan' } });
  await api(`/channels/${ch.data.channel.id}`, { method: 'DELETE', token: tok.A.token });
  const audit = await api(`/admin/audit?workspaceId=${wsId}`, { token: tok.A.token });
  const actions = audit.data.audit.map((a) => a.action);
  assert.ok(actions.includes('member.role_changed'));
  assert.ok(actions.includes('channel.deleted'));
});

test('admin directory, sessions and usage', async () => {
  const users = await api(`/admin/users?workspaceId=${wsId}`, { token: tok.A.token });
  assert.ok(users.data.users.some((u) => u.email === userA.email));
  const sessions = await api(`/admin/sessions?workspaceId=${wsId}`, { token: tok.A.token });
  assert.ok(Array.isArray(sessions.data.sessions));
  const usage = await api(`/admin/usage?workspaceId=${wsId}`, { token: tok.A.token });
  assert.ok(usage.data.usage.channels >= 1);
});
