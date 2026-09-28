import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { findOne, insertOne } from '../src/database/db.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { createApp } = await import('../src/app.js');
const { parseSearchQuery } = await import('../src/modules/search/parser.js');

let base;
let server;
const stamp = Date.now();
const userA = { email: `sea.${stamp}@example.com`, password: 'password-123', displayName: 'Search Ada' };
const userB = { email: `seb.${stamp}@example.com`, password: 'password-123', displayName: 'Search Bob' };
const tok = {};
let wsId;
let devId;
let vaultId;

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
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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

// ---- parser unit tests (no DB) ----
test('parser: from/in/phrase/has/before/after', () => {
  const p = parseSearchQuery('from:amir in:#development "connection timeout" has:file before:2026-09-01 after:2026-08-01 hello');
  assert.equal(p.from, 'amir');
  assert.equal(p.inChannel, 'development');
  assert.deepEqual(p.phrases, ['connection timeout']);
  assert.equal(p.hasFile, true);
  assert.equal(p.before.toISOString().slice(0, 10), '2026-09-01');
  assert.equal(p.after.toISOString().slice(0, 10), '2026-08-01');
  assert.equal(p.text, 'hello');
});

test('parser: @/# prefixes stripped, empty safe', () => {
  const p = parseSearchQuery('from:@bob in:#dev');
  assert.equal(p.from, 'bob');
  assert.equal(p.inChannel, 'dev');
  assert.deepEqual(parseSearchQuery('').phrases, []);
});

test('setup: users + workspace + public/private channels + messages', async () => {
  tok.A = await registerLogin(userA);
  tok.B = await registerLogin(userB);
  const ws = await api('/workspaces', { method: 'POST', token: tok.A.token, body: { name: `SearchWS ${stamp}` } });
  wsId = ws.data.workspace.id;
  const inv = await api(`/workspaces/${wsId}/invites`, { method: 'POST', token: tok.A.token, body: { role: 'member' } });
  await api('/workspaces/join', { method: 'POST', token: tok.B.token, body: { token: inv.data.invite.token } });
  const dev = await api(`/workspaces/${wsId}/channels`, { method: 'POST', token: tok.A.token, body: { name: 'development' } });
  devId = dev.data.channel.id;
  await api(`/channels/${devId}/join`, { method: 'POST', token: tok.B.token });
  const vault = await api(`/workspaces/${wsId}/channels`, { method: 'POST', token: tok.A.token, body: { name: 'vault', isPrivate: true } });
  vaultId = vault.data.channel.id;

  await api(`/channels/${devId}/messages`, { method: 'POST', token: tok.A.token, body: { content: 'connection timeout in production database, investigating now' } });
  await api(`/channels/${devId}/messages`, { method: 'POST', token: tok.B.token, body: { content: 'hello world from bob' } });
  await api(`/channels/${vaultId}/messages`, { method: 'POST', token: tok.A.token, body: { content: 'vault secret token alpha bravo' } });

  // Simulate a file attachment without S3: message_attachments row only.
  const msg = await findOne('messages', { channel_id: devId, content: { $regex: 'timeout', $options: 'i' } });
  await insertOne('message_attachments', { message_id: msg.id, file_id: crypto.randomUUID(), filename: 'timeout.log', mime_type: 'text/plain', size: 12, url: '/files/fake' });
});

async function search(q, token, extra = '') {
  return api(`/search?workspaceId=${wsId}&q=${encodeURIComponent(q)}${extra}`, { token });
}

test('free text finds the timeout message (Slack-style)', async () => {
  const r = await search('timeout', tok.A.token, '&type=messages');
  assert.equal(r.status, 200);
  assert.ok(r.data.items.some((m) => m.content.includes('timeout')));
  assert.ok(r.data.items[0].snippet.length > 0);
});

test('"exact phrase" matches only contiguous text', async () => {
  const hit = await search('"connection timeout"', tok.A.token, '&type=messages');
  assert.ok(hit.data.items.length >= 1);
  const miss = await search('"timeout connection"', tok.A.token, '&type=messages');
  assert.equal(miss.data.items.length, 0);
});

test('from: filters by author', async () => {
  const a = await search(`from:${userB.email} hello`, tok.A.token, '&type=messages');
  assert.ok(a.data.items.length >= 1);
  assert.ok(a.data.items.every((m) => m.sender.displayName === 'Search Bob'));
  const none = await search('from:nobody@example.com hello', tok.A.token, '&type=messages');
  assert.equal(none.data.items.length, 0);
});

test('in: filters by channel', async () => {
  const r = await search('in:#development timeout', tok.A.token, '&type=messages');
  assert.ok(r.data.items.length >= 1);
  assert.ok(r.data.items.every((m) => m.channelId === devId));
});

test('has:file returns only attached messages', async () => {
  const r = await search('has:file timeout', tok.A.token, '&type=messages');
  assert.ok(r.data.items.length >= 1);
  assert.ok(r.data.items.every((m) => m.hasFile === true));
});

test('before:/after: bound by date', async () => {
  const future = await search('timeout before:2000-01-01', tok.A.token, '&type=messages');
  assert.equal(future.data.items.length, 0);
  const past = await search('timeout after:2000-01-01', tok.A.token, '&type=messages');
  assert.ok(past.data.items.length >= 1);
});

test('private-channel content invisible to non-members (Slack privacy)', async () => {
  const a = await search('vault secret', tok.A.token, '&type=messages');
  assert.ok(a.data.items.some((m) => m.content.includes('vault')));
  const b = await search('vault secret', tok.B.token, '&type=messages');
  assert.equal(b.data.items.length, 0);
  const chB = await search('vault', tok.B.token, '&type=channels');
  assert.ok(chB.data.items.every((c) => c.name !== 'vault'));
});

test('users/channels/files scopes are workspace-safe', async () => {
  const u = await search('Search Bob', tok.A.token, '&type=users');
  assert.ok(u.data.items.some((x) => x.email === userB.email));
  const c = await search('develop', tok.A.token, '&type=channels');
  assert.ok(c.data.items.some((x) => x.name === 'development'));
});

test('non-member gets 403', async () => {
  const outsider = await registerLogin({ email: `seo.${stamp}@example.com`, password: 'password-123', displayName: 'Outsider' });
  const r = await search('timeout', outsider.token, '&type=messages');
  assert.equal(r.status, 403);
});

test('acceptance: combined Slack query from: + in: + phrase + has:file', async () => {
  const q = `from:${userA.email} in:#development "connection timeout" has:file`;
  const r = await search(q, tok.A.token, '&type=messages');
  assert.equal(r.status, 200);
  assert.ok(r.data.items.length >= 1);
  assert.ok(r.data.items[0].content.includes('connection timeout'));
});
