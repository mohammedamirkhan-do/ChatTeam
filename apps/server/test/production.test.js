import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { createApp } = await import('../src/app.js');
const { gte } = await import('../src/modules/health/routes.js');

let base;
let server;

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

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test('semver gte: versions compare numerically', () => {
  assert.equal(gte('0.1.0', '0.1.0'), true);
  assert.equal(gte('0.2.0', '0.1.9'), true);
  assert.equal(gte('1.0.0', '0.9.9'), true);
  assert.equal(gte('0.0.9', '0.1.0'), false);
});

test('GET /version reports server + min app version', async () => {
  const r = await api('/version');
  assert.equal(r.status, 200);
  assert.equal(r.data.name, 'teamchat-server');
  assert.ok(r.data.minAppVersion);
});

test('GET /version?appVersion flags outdated apps (Slack force-update)', async () => {
  const ok = await api('/version?appVersion=99.0.0');
  assert.equal(ok.data.appSupported, true);
  const old = await api('/version?appVersion=0.0.1');
  assert.equal(old.data.appSupported, false);
});

test('GET /updates/latest: no feed configured -> available false', async () => {
  const r = await api('/updates/latest?current=0.1.0');
  assert.equal(r.status, 200);
  assert.equal(r.data.available, false);
});

test('POST /crashes stores report without auth', async () => {
  const r = await api('/crashes', { method: 'POST', body: { appVersion: '0.1.0', platform: 'win32', error: 'boom', stack: 'at main', context: { test: true } } });
  assert.equal(r.status, 201);
  assert.ok(r.data.id);
});

test('POST /crashes rejects empty error', async () => {
  const r = await api('/crashes', { method: 'POST', body: { error: '' } });
  assert.equal(r.status, 400);
});
