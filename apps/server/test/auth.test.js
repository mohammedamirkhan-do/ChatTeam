import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { createApp } = await import('../src/app.js');

let base;
let server;
const email = `phase2.${Date.now()}@example.com`;
const password = 'correct-horse-123';
let accessToken;
let refreshToken;

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

test('register creates user (Slack-style)', async () => {
  const { status, data } = await api('/auth/register', {
    method: 'POST',
    body: { email, password, displayName: 'Phase Two' },
  });
  assert.equal(status, 201);
  assert.equal(data.user.email, email);
  assert.equal(data.user.emailVerified, false);
  assert.ok(!('password_hash' in data.user));
});

test('duplicate register is rejected', async () => {
  const { status, data } = await api('/auth/register', {
    method: 'POST',
    body: { email, password, displayName: 'Dup' },
  });
  assert.equal(status, 409);
  assert.equal(data.error.code, 'EMAIL_TAKEN');
});

test('bad input is validated', async () => {
  const { status } = await api('/auth/register', { method: 'POST', body: { email: 'nope', password: 'short', displayName: '' } });
  assert.equal(status, 400);
});

test('wrong password is rejected', async () => {
  const { status, data } = await api('/auth/login', { method: 'POST', body: { email, password: 'wrong-pass-000' } });
  assert.equal(status, 401);
  assert.equal(data.error.code, 'INVALID_CREDENTIALS');
});

test('login returns tokens + user', async () => {
  const { status, data } = await api('/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(status, 200);
  assert.ok(data.accessToken);
  assert.ok(data.refreshToken);
  assert.equal(data.user.email, email);
  accessToken = data.accessToken;
  refreshToken = data.refreshToken;
});

test('me works with access token, fails without', async () => {
  const anon = await api('/auth/me');
  assert.equal(anon.status, 401);
  const { status, data } = await api('/auth/me', { token: accessToken });
  assert.equal(status, 200);
  assert.equal(data.user.email, email);
});

test('users/me patch updates profile', async () => {
  const { status, data } = await api('/users/me', {
    method: 'PATCH',
    token: accessToken,
    body: { displayName: 'Phase Two Renamed', status: 'AWAY' },
  });
  assert.equal(status, 200);
  assert.equal(data.user.displayName, 'Phase Two Renamed');
  assert.equal(data.user.status, 'AWAY');
});

test('refresh rotates; old token reuse kills session (Slack-style security)', async () => {
  const r1 = await api('/auth/refresh', { method: 'POST', body: { refreshToken } });
  assert.equal(r1.status, 200);
  assert.ok(r1.data.accessToken);
  const rotatedAccess = r1.data.accessToken;
  const rotatedRefresh = r1.data.refreshToken;
  // Reuse the already-rotated token -> must revoke the whole session.
  const reuse = await api('/auth/refresh', { method: 'POST', body: { refreshToken } });
  assert.equal(reuse.status, 401);
  assert.equal(reuse.data.error.code, 'REFRESH_REUSED');
  // Even the freshly-rotated access token must now be dead.
  const dead = await api('/auth/me', { token: rotatedAccess });
  assert.equal(dead.status, 401);
  // And the rotated refresh token is dead too.
  const dead2 = await api('/auth/refresh', { method: 'POST', body: { refreshToken: rotatedRefresh } });
  assert.equal(dead2.status, 401);
});

test('logout revokes session', async () => {
  const login = await api('/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(login.status, 200);
  const out = await api('/auth/logout', { method: 'POST', token: login.data.accessToken });
  assert.equal(out.status, 200);
  const me = await api('/auth/me', { token: login.data.accessToken });
  assert.equal(me.status, 401);
});

test('forgot-password never enumerates users', async () => {
  const { status, data } = await api('/auth/forgot-password', { method: 'POST', body: { email: 'nobody@example.com' } });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
});
