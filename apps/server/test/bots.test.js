import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { createApp } = await import('../src/app.js');

let base;
let server;
const stamp = Date.now();
const userA = { email: `bta.${stamp}@example.com`, password: 'password-123', displayName: 'Bot Ada' };
const userB = { email: `btb.${stamp}@example.com`, password: 'password-123', displayName: 'Bot Bob' };
const tok = {};
let wsId;
let chId;
let botId;
let botToken;

async function api(path, { method = 'GET', body, token, bot } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(bot ? { 'x-bot-token': bot } : {}),
    },
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
  const ws = await api('/workspaces', { method: 'POST', token: tok.A.token, body: { name: `BotWS ${stamp}` } });
  wsId = ws.data.workspace.id;
  const inv = await api(`/workspaces/${wsId}/invites`, { method: 'POST', token: tok.A.token, body: { role: 'member' } });
  await api('/workspaces/join', { method: 'POST', token: tok.B.token, body: { token: inv.data.invite.token } });
  const ch = await api(`/workspaces/${wsId}/channels`, { method: 'POST', token: tok.A.token, body: { name: 'bots' } });
  chId = ch.data.channel.id;
  await api(`/channels/${chId}/join`, { method: 'POST', token: tok.B.token });
});

after(async () => {
  server?.close();
  const { closeMongoDB } = await import('../src/database/pg.js');
  const { redis } = await import('../src/database/redis.js');
  try { await redis.disconnect(); } catch {}
  await closeMongoDB();
});

test('create bot returns token once; members cannot (Slack admin apps)', async () => {
  const denied = await api(`/workspaces/${wsId}/bots`, { method: 'POST', token: tok.B.token, body: { name: 'Nope' } });
  assert.equal(denied.status, 403);
  const r = await api(`/workspaces/${wsId}/bots`, { method: 'POST', token: tok.A.token, body: { name: 'Deploybot' } });
  assert.equal(r.status, 201);
  assert.ok(r.data.token);
  botId = r.data.bot.id;
  botToken = r.data.token;
  const list = await api(`/workspaces/${wsId}/bots`, { token: tok.B.token });
  assert.ok(list.data.bots.some((b) => b.id === botId));
  assert.ok(!('token_hash' in list.data.bots[0]));
});

test('/meeting create posts a join card (+ huddle); /github deploys', async () => {
  const m = await api(`/channels/${chId}/messages`, { method: 'POST', token: tok.A.token, body: { content: '/meeting create Planning' } });
  assert.equal(m.status, 201);
  assert.ok(m.data.slash?.message);
  assert.ok(m.data.slash.message.content.includes('Planning'));
  assert.equal(m.data.slash.message.buttons[0].label, 'Join');
  const g = await api(`/channels/${chId}/messages`, { method: 'POST', token: tok.A.token, body: { content: '/github deploy production' } });
  assert.ok(g.data.slash.message.content.includes('production'));
});

test('/poll posts clickable options; unknown /commands stay plain text', async () => {
  const p = await api(`/channels/${chId}/messages`, { method: 'POST', token: tok.A.token, body: { content: '/poll Lunch?; Pizza; Sushi' } });
  assert.equal(p.data.slash.message.buttons.length, 2);
  const u = await api(`/channels/${chId}/messages`, { method: 'POST', token: tok.A.token, body: { content: '/frobnicate now' } });
  assert.equal(u.status, 201);
  assert.ok(!u.data.slash);
});

test('custom bot command with {{placeholders}} + button callback', async () => {
  await api(`/bots/${botId}/commands`, { method: 'POST', token: tok.A.token, body: { command: 'standup', responseTemplate: 'Standup for {{user}}: {{args}}', buttons: [{ id: 'ack', label: 'Ack' }] } });
  const s = await api(`/channels/${chId}/messages`, { method: 'POST', token: tok.B.token, body: { content: '/standup done yesterday' } });
  assert.ok(s.data.slash.message.content.includes('Bot Bob'));
  assert.ok(s.data.slash.message.content.includes('done yesterday'));
  const cb = await api('/bots/callbacks', { method: 'POST', token: tok.B.token, body: { messageId: s.data.slash.message.id, action: 'ack' } });
  assert.equal(cb.status, 200);
  assert.equal(cb.data.label, 'Ack');
});

test('bot token posts externally; bad token rejected', async () => {
  const bad = await api(`/bots/${botId}/messages`, { method: 'POST', bot: 'nope', body: { channelId: chId, content: 'hi' } });
  assert.equal(bad.status, 401);
  const ok = await api(`/bots/${botId}/messages`, { method: 'POST', bot: botToken, body: { channelId: chId, content: 'external ping' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.message.messageType, 'bot');
});
