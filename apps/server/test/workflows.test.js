import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { createApp } = await import('../src/app.js');

let base;
let server;
const stamp = Date.now();
const userA = { email: `wfa.${stamp}@example.com`, password: 'password-123', displayName: 'Flow Ada' };
const userB = { email: `wfb.${stamp}@example.com`, password: 'password-123', displayName: 'Flow Newhire' };
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
  const ws = await api('/workspaces', { method: 'POST', token: tok.A.token, body: { name: `FlowWS ${stamp}` } });
  wsId = ws.data.workspace.id;
});

after(async () => {
  server?.close();
  const { closeMongoDB } = await import('../src/database/pg.js');
  const { redis } = await import('../src/database/redis.js');
  try { await redis.disconnect(); } catch {}
  await closeMongoDB();
});

test('builder: create workflow with steps, then run it', async () => {
  const created = await api(`/workspaces/${wsId}/workflows`, {
    method: 'POST', token: tok.A.token,
    body: {
      name: 'Welcome flow', description: 'greets',
      steps: [
        { kind: 'create_channel', config: { name: `welcomebot${stamp % 100000}` } },
        { kind: 'post_message', config: { content: 'Hello {{channelId}}' } },
      ],
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.workflow.steps.length, 2);
  const run = await api(`/workflows/${created.data.workflow.id}/run`, { method: 'POST', token: tok.A.token, body: {} });
  assert.equal(run.status, 201);
  assert.ok(run.data.results.create_channel.channelId);
  assert.ok(run.data.results.post_message.messageId);
});

test('unknown step kinds fail the run (visible error)', async () => {
  const created = await api(`/workspaces/${wsId}/workflows`, {
    method: 'POST', token: tok.A.token,
    body: { name: 'Broken', steps: [{ kind: 'teleport', config: {} }] },
  });
  const run = await api(`/workflows/${created.data.workflow.id}/run`, { method: 'POST', token: tok.A.token, body: {} });
  assert.equal(run.status, 400);
});

test('onboarding template: channel + welcome + invite + HR notify', async () => {
  // New hire must exist as a user but NOT be a workspace member yet.
  const run = await api('/workflows/templates/onboarding', {
    method: 'POST', token: tok.A.token,
    body: { newUserEmail: userB.email, channelName: `onboard${stamp % 100000}`, hrUserId: tok.A.id },
  });
  assert.equal(run.status, 201);
  assert.ok(run.data.results.create_channel.channelId);
  assert.ok(run.data.results.post_message.messageId);
  assert.equal(run.data.results.invite_user.invited, true);
  assert.equal(run.data.results.notify_user.notified, tok.A.id);
  // Hire is now a member; welcome message greets them.
  const chans = await api(`/workspaces/${wsId}/channels`, { token: tok.B.token });
  assert.ok(chans.data.channels.some((c) => c.id === run.data.results.create_channel.channelId));
  const notifs = await api('/notifications', { token: tok.A.token });
  assert.ok(notifs.data.notifications.some((n) => n.type === 'workflow'));
});
