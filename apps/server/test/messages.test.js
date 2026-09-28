import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { createApp } = await import('../src/app.js');

let base;
let server;
const stamp = Date.now();
const userA = { email: `msa.${stamp}@example.com`, password: 'password-123', displayName: 'Msg Ada' };
const userB = { email: `msb.${stamp}@example.com`, password: 'password-123', displayName: 'Msg Bob' };
const tok = {};
let wsId;
let chId;
let rootId;
let replyId;

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

test('setup: users + workspace + channel, B joins', async () => {
  tok.A = await registerLogin(userA);
  tok.B = await registerLogin(userB);
  const ws = await api('/workspaces', { method: 'POST', token: tok.A.token, body: { name: `MsgWS ${stamp}` } });
  wsId = ws.data.workspace.id;
  const inv = await api(`/workspaces/${wsId}/invites`, { method: 'POST', token: tok.A.token, body: { role: 'member' } });
  await api('/workspaces/join', { method: 'POST', token: tok.B.token, body: { token: inv.data.invite.token } });
  const ch = await api(`/workspaces/${wsId}/channels`, { method: 'POST', token: tok.A.token, body: { name: 'chat' } });
  chId = ch.data.channel.id;
  await api(`/channels/${chId}/join`, { method: 'POST', token: tok.B.token });
});

test('two users converse; @email mention extracted (Slack-style)', async () => {
  const m1 = await api(`/channels/${chId}/messages`, { method: 'POST', token: tok.A.token, body: { content: `Hey @${userB.email}, the API is failing.` } });
  assert.equal(m1.status, 201);
  assert.deepEqual(m1.data.message.mentions, [tok.B.id]);
  rootId = m1.data.message.id;
  const m2 = await api(`/channels/${chId}/messages`, { method: 'POST', token: tok.B.token, body: { content: 'Looking into it now.' } });
  assert.equal(m2.status, 201);
});

test('thread replies nest under root; thread endpoint returns both', async () => {
  const r = await api(`/channels/${chId}/messages`, { method: 'POST', token: tok.B.token, body: { content: 'Found it, pushing a fix.', parentMessageId: rootId } });
  assert.equal(r.status, 201);
  replyId = r.data.message.id;
  const t = await api(`/messages/${rootId}/thread`, { token: tok.A.token });
  assert.equal(t.status, 200);
  assert.equal(t.data.messages.length, 2);
  assert.equal(t.data.messages[0].id, rootId);
  // Root lists replyCount on the feed.
  const feed = await api(`/channels/${chId}/messages?limit=10`, { token: tok.A.token });
  const root = feed.data.messages.find((m) => m.id === rootId);
  assert.equal(root.replyCount, 1);
});

test('reactions are idempotent; removal works', async () => {
  const add1 = await api(`/messages/${rootId}/reactions`, { method: 'POST', token: tok.B.token, body: { emoji: '👍' } });
  assert.equal(add1.status, 201);
  const add2 = await api(`/messages/${rootId}/reactions`, { method: 'POST', token: tok.B.token, body: { emoji: '👍' } });
  assert.equal(add2.status, 201);
  assert.deepEqual(add2.data.message.reactions, [{ emoji: '👍', count: 1, me: true }]);
  const other = await api(`/messages/${rootId}/reactions`, { method: 'POST', token: tok.A.token, body: { emoji: '👍' } });
  assert.equal(other.data.message.reactions[0].count, 2);
  const del = await api(`/messages/${rootId}/reactions?emoji=${encodeURIComponent('👍')}`, { method: 'DELETE', token: tok.B.token });
  assert.equal(del.data.message.reactions[0].count, 1);
  assert.equal(del.data.message.reactions[0].me, false);
});

test('only the author can edit; history flag set', async () => {
  const denied = await api(`/messages/${rootId}`, { method: 'PATCH', token: tok.B.token, body: { content: 'hijack' } });
  assert.equal(denied.status, 403);
  const ok = await api(`/messages/${rootId}`, { method: 'PATCH', token: tok.A.token, body: { content: 'Hey team, the API is failing (updated).' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.message.edited, true);
});

test('soft delete hides content but keeps thread (Slack-style)', async () => {
  const del = await api(`/messages/${replyId}`, { method: 'DELETE', token: tok.B.token });
  assert.equal(del.status, 200);
  assert.equal(del.data.message.deleted, true);
  assert.equal(del.data.message.content, null);
  const t = await api(`/messages/${rootId}/thread`, { token: tok.A.token });
  assert.equal(t.data.messages.length, 2);
  assert.equal(t.data.messages[1].deleted, true);
});

test('non-author cannot delete without DELETE_MESSAGE', async () => {
  const other = await api(`/channels/${chId}/messages`, { method: 'POST', token: tok.A.token, body: { content: 'mine, not yours' } });
  const denied = await api(`/messages/${other.data.message.id}`, { method: 'DELETE', token: tok.B.token });
  assert.equal(denied.status, 403);
});

test('history paginates deterministically (keyset cursor)', async () => {
  for (let i = 0; i < 5; i++) {
    await api(`/channels/${chId}/messages`, { method: 'POST', token: tok.A.token, body: { content: `bulk ${i}` } });
  }
  const p1 = await api(`/channels/${chId}/messages?limit=3`, { token: tok.A.token });
  assert.equal(p1.data.messages.length, 3);
  assert.ok(p1.data.nextCursor);
  const p2 = await api(`/channels/${chId}/messages?limit=3&before=${p1.data.nextCursor}`, { token: tok.A.token });
  assert.equal(p2.data.messages.length, 3);
  const ids1 = new Set(p1.data.messages.map((m) => m.id));
  for (const m of p2.data.messages) assert.ok(!ids1.has(m.id));
  // Chronological within page.
  const times = p2.data.messages.map((m) => m.createdAt);
  assert.deepEqual([...times].sort(), times);
});

test('unread counts + read marker (Slack-style)', async () => {
  const before = await api(`/workspaces/${wsId}/channels`, { token: tok.B.token });
  const entry = before.data.channels.find((c) => c.id === chId);
  assert.ok(entry.unreadCount > 0);
  const latest = await api(`/channels/${chId}/messages?limit=1`, { token: tok.B.token });
  const lastId = latest.data.messages[latest.data.messages.length - 1].id;
  const mark = await api(`/channels/${chId}/read`, { method: 'POST', token: tok.B.token, body: { lastReadMessageId: lastId } });
  assert.equal(mark.status, 200);
  const after = await api(`/workspaces/${wsId}/channels`, { token: tok.B.token });
  assert.equal(after.data.channels.find((c) => c.id === chId).unreadCount, 0);
});
