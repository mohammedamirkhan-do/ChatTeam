import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { createApp } = await import('../src/app.js');

let base;
let server;
const stamp = Date.now();
const userA = { email: `iga.${stamp}@example.com`, password: 'password-123', displayName: 'Integ Ada' };
const userB = { email: `igb.${stamp}@example.com`, password: 'password-123', displayName: 'Integ Bob' };
const tok = {};
let wsId;
let chId;
let captured = [];

async function api(path, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function registerLogin(u) {
  await api('/auth/register', { method: 'POST', body: u });
  const { data } = await api('/auth/login', { method: 'POST', body: { email: u.email, password: u.password } });
  return { token: data.accessToken, id: data.user.id };
}

let captureServer;
let captureBase;

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  base = `http://localhost:${server.address().port}`;

  // Outgoing-webhook capture endpoint (acts as the "CI server").
  captureServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured.push({ event: req.headers['x-teamchat-event'], sig: req.headers['x-teamchat-signature'], body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => captureServer.listen(0, r));
  captureBase = `http://localhost:${captureServer.address().port}`;

  tok.A = await registerLogin(userA);
  tok.B = await registerLogin(userB);
  const ws = await api('/workspaces', { method: 'POST', token: tok.A.token, body: { name: `IntegWS ${stamp}` } });
  wsId = ws.data.workspace.id;
  const inv = await api(`/workspaces/${wsId}/invites`, { method: 'POST', token: tok.A.token, body: { role: 'member' } });
  await api('/workspaces/join', { method: 'POST', token: tok.B.token, body: { token: inv.data.invite.token } });
  const ch = await api(`/workspaces/${wsId}/channels`, { method: 'POST', token: tok.A.token, body: { name: 'development' } });
  chId = ch.data.channel.id;
  await api(`/channels/${chId}/join`, { method: 'POST', token: tok.B.token });
});

after(async () => {
  captureServer?.close();
  server?.close();
  const { closeMongoDB } = await import('../src/database/pg.js');
  const { redis } = await import('../src/database/redis.js');
  try { await redis.disconnect(); } catch {}
  await closeMongoDB();
});

test('create integration returns webhook URL (admin-gated)', async () => {
  const denied = await api(`/workspaces/${wsId}/integrations`, { method: 'POST', token: tok.B.token, body: { name: 'X' } });
  assert.equal(denied.status, 403);
  const r = await api(`/workspaces/${wsId}/integrations`, { method: 'POST', token: tok.A.token, body: { name: 'GitHub', provider: 'github', channelId: chId } });
  assert.equal(r.status, 201);
  assert.ok(r.data.incomingUrl.startsWith('/hooks/'));
  globalThis.__hook = r.data.incomingUrl;
});

test('generic incoming webhook posts text to the channel', async () => {
  const r = await api(globalThis.__hook, { method: 'POST', body: { text: 'CI build #42 passed ✅' } });
  assert.equal(r.status, 201);
  const feed = await api(`/channels/${chId}/messages?limit=5`, { token: tok.A.token });
  assert.ok(feed.data.messages.some((m) => m.content.includes('CI build #42')));
});

test('GitHub PR-merged payload formats like the vision doc', async () => {
  const r = await api(globalThis.__hook, {
    method: 'POST',
    headers: { 'x-github-event': 'pull_request' },
    body: { action: 'closed', pull_request: { number: 125, title: 'Add search', merged: true, user: { login: 'amir' } } },
  });
  assert.equal(r.status, 201);
  assert.ok(r.data.message.content.includes('PR #125 was merged'));
});

test('unknown webhook token 404s', async () => {
  const r = await api('/hooks/nope', { method: 'POST', body: { text: 'x' } });
  assert.equal(r.status, 404);
});

test('outgoing subscription receives signed message.created', async () => {
  const integ = await api(`/workspaces/${wsId}/integrations`, { token: tok.A.token });
  const integId = integ.data.integrations[0].id;
  const sub = await api(`/integrations/${integId}/subscriptions`, { method: 'POST', token: tok.A.token, body: { url: `${captureBase}/hook`, events: ['message.created'] } });
  assert.equal(sub.status, 201);
  captured = [];
  await api(`/channels/${chId}/messages`, { method: 'POST', token: tok.A.token, body: { content: 'outgoing probe' } });
  // Fire-and-forget delivery: poll briefly.
  const deadline = Date.now() + 5000;
  while (!captured.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.equal(captured.length, 1);
  assert.equal(captured[0].event, 'message.created');
  assert.ok(captured[0].sig?.startsWith('sha256='));
  assert.ok(captured[0].body.message.content.includes('outgoing probe'));
});
