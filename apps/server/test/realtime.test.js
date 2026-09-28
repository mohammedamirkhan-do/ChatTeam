import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { io as ioClient } from 'socket.io-client';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { createApp } = await import('../src/app.js');
const { initRealtime } = await import('../src/websocket/index.js');

let base;
let httpServer;
const stamp = Date.now();
const userA = { email: `rta.${stamp}@example.com`, password: 'password-123', displayName: 'Live Ada' };
const userB = { email: `rtb.${stamp}@example.com`, password: 'password-123', displayName: 'Live Bob' };
const tok = {};
let chId;
let wsId;

function api(path, { method = 'GET', body, token } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
}

async function registerLogin(u) {
  await api('/auth/register', { method: 'POST', body: u });
  const { data } = await api('/auth/login', { method: 'POST', body: { email: u.email, password: u.password } });
  return { token: data.accessToken, id: data.user.id };
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const s = ioClient(base, { auth: { token }, reconnection: false, timeout: 5000 });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

function waitFor(socket, type, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off('event', onEvent);
      reject(new Error(`timed out waiting for ${type}`));
    }, ms);
    function onEvent(ev) {
      if (ev && ev.type === type) {
        clearTimeout(t);
        socket.off('event', onEvent);
        resolve(ev);
      }
    }
    socket.on('event', onEvent);
  });
}

before(async () => {
  const app = createApp();
  httpServer = createServer(app);
  const { config } = await import('../src/config/index.js');
  initRealtime(httpServer, config.corsOrigin);
  await new Promise((r) => httpServer.listen(0, r));
  base = `http://localhost:${httpServer.address().port}`;

  tok.A = await registerLogin(userA);
  tok.B = await registerLogin(userB);
  const ws = await api('/workspaces', { method: 'POST', token: tok.A.token, body: { name: `LiveWS ${stamp}` } });
  wsId = ws.data.workspace.id;
  const inv = await api(`/workspaces/${wsId}/invites`, { method: 'POST', token: tok.A.token, body: { role: 'member' } });
  await api('/workspaces/join', { method: 'POST', token: tok.B.token, body: { token: inv.data.invite.token } });
  const ch = await api(`/workspaces/${wsId}/channels`, { method: 'POST', token: tok.A.token, body: { name: 'live' } });
  chId = ch.data.channel.id;
  await api(`/channels/${chId}/join`, { method: 'POST', token: tok.B.token });
});

after(async () => {
  const { closeRealtime } = await import('../src/websocket/index.js');
  await closeRealtime();
  httpServer?.close();
  const { closeMongoDB } = await import('../src/database/pg.js');
  const { redis } = await import('../src/database/redis.js');
  try { await redis.disconnect(); } catch {}
  await closeMongoDB();
});

test('B receives message.created live when A posts (<2s, Slack instant feel)', async () => {
  const sockB = await connect(tok.B.token);
  try {
    const waiting = waitFor(sockB, 'message.created', 8000);
    const sent = await api(`/channels/${chId}/messages`, { method: 'POST', token: tok.A.token, body: { content: 'hello live world' } });
    assert.equal(sent.status, 201);
    const ev = await waiting;
    assert.equal(ev.payload.message.id, sent.data.message.id);
    assert.equal(ev.payload.message.content, 'hello live world');
  } finally {
    sockB.disconnect();
  }
});

test('typing relays to channel peers, then clears', async () => {
  const sockA = await connect(tok.A.token);
  const sockB = await connect(tok.B.token);
  try {
    const waiting = waitFor(sockB, 'user.typing', 5000);
    sockA.emit('typing.start', { channelId: chId });
    const ev = await waiting;
    assert.equal(ev.payload.userId, tok.A.id);
    assert.equal(ev.payload.channelId, chId);
    sockA.emit('typing.stop', { channelId: chId });
  } finally {
    sockA.disconnect();
    sockB.disconnect();
  }
});

test('presence lists online users; disconnect flips to OFFLINE', async () => {
  const sockA = await connect(tok.A.token);
  const sockB = await connect(tok.B.token);
  try {
    await new Promise((r) => setTimeout(r, 500));
    const list = await new Promise((resolve) => sockB.emit('presence.list', { workspaceId: wsId }, resolve));
    assert.ok(list[tok.A.id]);
    assert.equal(list[tok.A.id].state, 'ONLINE');
    const flipping = waitFor(sockB, 'user.presence_changed', 5000);
    sockA.disconnect();
    const ev = await flipping;
    assert.equal(ev.payload.userId, tok.A.id);
    assert.equal(ev.payload.state, 'OFFLINE');
  } finally {
    try { sockA.disconnect(); } catch {}
    sockB.disconnect();
  }
});

test('@mention notifies + pushes notification.created (Slack ping)', async () => {
  const sockB = await connect(tok.B.token);
  try {
    const waiting = waitFor(sockB, 'notification.created', 8000);
    await api(`/channels/${chId}/messages`, { method: 'POST', token: tok.A.token, body: { content: `hey @${userB.email}, look here` } });
    const ev = await waiting;
    assert.equal(ev.payload.type, 'mention');
    const list = await api('/notifications', { token: tok.B.token });
    assert.ok(list.data.unreadCount >= 1);
    assert.ok(list.data.notifications.some((n) => n.type === 'mention'));
    const read = await api('/notifications/read', { method: 'POST', token: tok.B.token, body: {} });
    assert.equal(read.status, 200);
    const after = await api('/notifications', { token: tok.B.token });
    assert.equal(after.data.unreadCount, 0);
  } finally {
    sockB.disconnect();
  }
});

test('reconnect resyncs history over REST (missed-message safety)', async () => {
  const sent = await api(`/channels/${chId}/messages`, { method: 'POST', token: tok.A.token, body: { content: 'while you were away' } });
  assert.equal(sent.status, 201);
  const sockB = await connect(tok.B.token);
  try {
    const feed = await api(`/channels/${chId}/messages?limit=30`, { token: tok.B.token });
    assert.ok(feed.data.messages.some((m) => m.id === sent.data.message.id));
  } finally {
    sockB.disconnect();
  }
});
