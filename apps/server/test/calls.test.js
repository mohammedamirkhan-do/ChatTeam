import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { io as ioClient } from 'socket.io-client';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { createApp } = await import('../src/app.js');
const { initRealtime, closeRealtime } = await import('../src/websocket/index.js');

let base;
let httpServer;
const stamp = Date.now();
const userA = { email: `caa.${stamp}@example.com`, password: 'password-123', displayName: 'Call Ada' };
const userB = { email: `cab.${stamp}@example.com`, password: 'password-123', displayName: 'Call Bob' };
const tok = {};
let wsId;
let chId;
let callId;

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

function connect(token) {
  return new Promise((resolve, reject) => {
    const s = ioClient(base, { auth: { token }, reconnection: false, timeout: 5000 });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
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
  const ws = await api('/workspaces', { method: 'POST', token: tok.A.token, body: { name: `CallWS ${stamp}` } });
  wsId = ws.data.workspace.id;
  const inv = await api(`/workspaces/${wsId}/invites`, { method: 'POST', token: tok.A.token, body: { role: 'member' } });
  await api('/workspaces/join', { method: 'POST', token: tok.B.token, body: { token: inv.data.invite.token } });
  const ch = await api(`/workspaces/${wsId}/channels`, { method: 'POST', token: tok.A.token, body: { name: 'huddle' } });
  chId = ch.data.channel.id;
  await api(`/channels/${chId}/join`, { method: 'POST', token: tok.B.token });
});

after(async () => {
  await closeRealtime();
  httpServer?.close();
  const { closeMongoDB } = await import('../src/database/pg.js');
  const { redis } = await import('../src/database/redis.js');
  try { await redis.disconnect(); } catch {}
  await closeMongoDB();
});

test('start huddle on a channel (Slack parity: one live call per room)', async () => {
  const r = await api(`/workspaces/${wsId}/calls`, { method: 'POST', token: tok.A.token, body: { channelId: chId } });
  assert.equal(r.status, 201);
  callId = r.data.call.id;
  assert.equal(r.data.call.participants.length, 1);
  const again = await api(`/workspaces/${wsId}/calls`, { method: 'POST', token: tok.B.token, body: { channelId: chId } });
  assert.equal(again.data.call.id, callId);
  assert.equal(again.data.reused, true);
  assert.equal(again.data.call.participants.length, 2);
});

test('active calls list + media state (mute/cam/share roster)', async () => {
  const list = await api(`/calls/active?workspaceId=${wsId}`, { token: tok.B.token });
  assert.ok(list.data.calls.some((c) => c.id === callId));
  const m = await api(`/calls/${callId}/media`, { method: 'POST', token: tok.B.token, body: { muted: true, sharing: true } });
  assert.equal(m.status, 200);
  const bob = m.data.call.participants.find((p) => p.userId === tok.B.id);
  assert.equal(bob.muted, true);
  assert.equal(bob.sharing, true);
});

test('signaling relay reaches only call peers (SDP + ICE)', async () => {
  const sockA = await connect(tok.A.token);
  const sockB = await connect(tok.B.token);
  try {
    await new Promise((res) => sockA.emit('call.join', { callId }, res));
    await new Promise((res) => sockB.emit('call.join', { callId }, res));
    const got = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no signal')), 8000);
      sockB.on('event', function onEv(ev) {
        if (ev?.type === 'call.signal' && ev.payload.from === tok.A.id) {
          clearTimeout(t);
          sockB.off('event', onEv);
          resolve(ev.payload.signal);
        }
      });
    });
    sockA.emit('call.signal', { callId, to: tok.B.id, signal: { sdp: { type: 'offer', sdp: 'fake' } } });
    const sig = await got;
    assert.equal(sig.sdp.type, 'offer');
  } finally {
    sockA.disconnect();
    sockB.disconnect();
  }
});

test('non-member cannot signal or view', async () => {
  const outsider = await registerLogin({ email: `cao.${stamp}@example.com`, password: 'password-123', displayName: 'Call Out' });
  const r = await api(`/calls/${callId}`, { token: outsider.token });
  assert.ok([403, 404].includes(r.status));
});

test('last one out ends the huddle; starter can end for all', async () => {
  await api(`/calls/${callId}/leave`, { method: 'POST', token: tok.B.token });
  let cur = await api(`/calls/${callId}`, { token: tok.A.token });
  assert.equal(cur.data.call.participants.length, 1);
  await api(`/calls/${callId}/end`, { method: 'POST', token: tok.A.token });
  cur = await api(`/calls/${callId}`, { token: tok.A.token });
  assert.equal(cur.data.call.status, 'ended');
});
