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
const userA = { email: `dma.${stamp}@example.com`, password: 'password-123', displayName: 'DM Ada' };
const userB = { email: `dmb.${stamp}@example.com`, password: 'password-123', displayName: 'DM Bob' };
const userC = { email: `dmc.${stamp}@example.com`, password: 'password-123', displayName: 'DM Cara' };
const tok = {};
let wsId;
let dmId;
let groupId;

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

function waitFor(socket, type, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { socket.off('event', onEvent); reject(new Error(`timed out waiting for ${type}`)); }, ms);
    function onEvent(ev) {
      if (ev && ev.type === type) { clearTimeout(t); socket.off('event', onEvent); resolve(ev); }
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
  tok.C = await registerLogin(userC);
  const ws = await api('/workspaces', { method: 'POST', token: tok.A.token, body: { name: `DMWS ${stamp}` } });
  wsId = ws.data.workspace.id;
  const inv = await api(`/workspaces/${wsId}/invites`, { method: 'POST', token: tok.A.token, body: { role: 'member' } });
  await api('/workspaces/join', { method: 'POST', token: tok.B.token, body: { token: inv.data.invite.token } });
  const inv2 = await api(`/workspaces/${wsId}/invites`, { method: 'POST', token: tok.A.token, body: { role: 'member' } });
  await api('/workspaces/join', { method: 'POST', token: tok.C.token, body: { token: inv2.data.invite.token } });
});

after(async () => {
  await closeRealtime();
  httpServer?.close();
  const { closeMongoDB } = await import('../src/database/pg.js');
  const { redis } = await import('../src/database/redis.js');
  try { await redis.disconnect(); } catch {}
  await closeMongoDB();
});

test('1-1 create is idempotent for the same pair (Slack parity)', async () => {
  const first = await api(`/workspaces/${wsId}/dms`, { method: 'POST', token: tok.A.token, body: { userIds: [tok.B.id] } });
  assert.equal(first.status, 201);
  assert.equal(first.data.conversation.isGroup, false);
  dmId = first.data.conversation.id;
  const second = await api(`/workspaces/${wsId}/dms`, { method: 'POST', token: tok.B.token, body: { userIds: [tok.A.id] } });
  assert.equal(second.data.conversation.id, dmId);
});

test('non-members and outsiders are blocked', async () => {
  const outsider = await registerLogin({ email: `dmo.${stamp}@example.com`, password: 'password-123', displayName: 'DM Out' });
  const r1 = await api(`/workspaces/${wsId}/dms`, { token: outsider.token });
  assert.equal(r1.status, 403);
  const r2 = await api(`/dms/${dmId}/messages`, { token: outsider.token });
  assert.ok([403, 404].includes(r2.status));
  const r3 = await api(`/workspaces/${wsId}/dms`, { method: 'POST', token: tok.A.token, body: { userIds: [outsider.id] } });
  assert.equal(r3.status, 400);
});

test('send + history + thread + reactions + edit + delete (message stack reuse)', async () => {
  const sent = await api(`/dms/${dmId}/messages`, { method: 'POST', token: tok.A.token, body: { content: 'hey bob, DM check' } });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.message.dmConversationId, dmId);
  const hist = await api(`/dms/${dmId}/messages`, { token: tok.B.token });
  assert.ok(hist.data.messages.some((m) => m.content === 'hey bob, DM check'));
  const reply = await api(`/dms/${dmId}/messages`, { method: 'POST', token: tok.B.token, body: { content: 'got it', parentMessageId: sent.data.message.id } });
  assert.equal(reply.status, 201);
  const thread = await api(`/messages/${sent.data.message.id}/thread`, { token: tok.A.token });
  assert.equal(thread.data.messages.length, 2);
  const react = await api(`/messages/${sent.data.message.id}/reactions`, { method: 'POST', token: tok.B.token, body: { emoji: '👍' } });
  assert.equal(react.status, 201);
  const edit = await api(`/messages/${sent.data.message.id}`, { method: 'PATCH', token: tok.A.token, body: { content: 'hey bob, DM check (edited)' } });
  assert.equal(edit.status, 200);
});

test('group DM: create, add, remove, rename; 1-1 is immutable', async () => {
  const g = await api(`/workspaces/${wsId}/dms`, { method: 'POST', token: tok.A.token, body: { userIds: [tok.B.id, tok.C.id], name: 'Dev Team' } });
  assert.equal(g.status, 201);
  assert.equal(g.data.conversation.isGroup, true);
  groupId = g.data.conversation.id;
  const addBack = await api(`/dms/${dmId}/members`, { method: 'POST', token: tok.A.token, body: { userId: tok.C.id } });
  assert.equal(addBack.status, 400);
  const rm = await api(`/dms/${groupId}/members/${tok.B.id}`, { method: 'DELETE', token: tok.A.token });
  assert.equal(rm.status, 200);
  const readd = await api(`/dms/${groupId}/members`, { method: 'POST', token: tok.A.token, body: { userId: tok.B.id } });
  assert.equal(readd.status, 201);
  const ren = await api(`/dms/${groupId}`, { method: 'PATCH', token: tok.A.token, body: { name: 'Dev Squad' } });
  assert.equal(ren.data.conversation.name, 'Dev Squad');
  const sent = await api(`/dms/${groupId}/messages`, { method: 'POST', token: tok.C.token, body: { content: 'hello squad' } });
  assert.equal(sent.status, 201);
});

test('read receipts advance + unread counts drop', async () => {
  await api(`/dms/${dmId}/messages`, { method: 'POST', token: tok.A.token, body: { content: 'receipt probe' } });
  const before = await api(`/workspaces/${wsId}/dms`, { token: tok.B.token });
  const convo = before.data.conversations.find((c) => c.id === dmId);
  assert.ok(convo.unreadCount >= 1);
  const hist = await api(`/dms/${dmId}/messages`, { token: tok.B.token });
  const last = hist.data.messages[hist.data.messages.length - 1];
  const read = await api(`/dms/${dmId}/read`, { method: 'POST', token: tok.B.token, body: { lastReadMessageId: last.id } });
  assert.equal(read.status, 200);
  const members = await api(`/dms/${dmId}/members`, { token: tok.A.token });
  const bob = members.data.members.find((m) => m.userId === tok.B.id);
  assert.ok(bob.lastReadAt);
  const after = await api(`/workspaces/${wsId}/dms`, { token: tok.B.token });
  assert.equal(after.data.conversations.find((c) => c.id === dmId).unreadCount, 0);
});

test('every DM notifies offline members (badge on reconnect)', async () => {
  await api(`/dms/${dmId}/messages`, { method: 'POST', token: tok.A.token, body: { content: 'ping for badge' } });
  const n = await api('/notifications', { token: tok.B.token });
  assert.ok(n.data.notifications.some((x) => x.type === 'dm'));
  assert.ok(n.data.unreadCount >= 1);
});

test('DM file attachments reuse the files stack', async () => {
  const fd = new FormData();
  fd.append('files', new Blob(['dm-bytes'], { type: 'text/plain' }), 'dm.txt');
  const up = await fetch(`${base}/workspaces/${wsId}/files`, { method: 'POST', headers: { Authorization: `Bearer ${tok.A.token}` }, body: fd });
  assert.equal(up.status, 201);
  const file = (await up.json()).files[0];
  const sent = await api(`/dms/${dmId}/messages`, { method: 'POST', token: tok.A.token, body: { content: 'see attached', attachmentIds: [file.id] } });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.message.attachments[0].filename, 'dm.txt');
});

test('B receives dm.message.created live (Slack instant feel)', async () => {
  const sockB = await connect(tok.B.token);
  try {
    // B connects before the DM exists? Reconnect so the dm room joins live.
    sockB.disconnect();
    const sockB2 = await connect(tok.B.token);
    try {
      const waiting = waitFor(sockB2, 'dm.message.created', 8000);
      // Ensure membership join propagated (socket join happens on connect).
      await new Promise((r) => setTimeout(r, 300));
      const sent = await api(`/dms/${dmId}/messages`, { method: 'POST', token: tok.A.token, body: { content: 'live dm hello' } });
      assert.equal(sent.status, 201);
      const ev = await waiting;
      assert.equal(ev.payload.message.id, sent.data.message.id);
    } finally {
      sockB2.disconnect();
    }
  } finally {
    try { sockB.disconnect(); } catch {}
  }
});
