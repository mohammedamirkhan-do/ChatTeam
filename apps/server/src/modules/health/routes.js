import { Router } from 'express';
import { config } from '../../config/index.js';
import { checkMongoDB } from '../../database/pg.js';
import { checkRedis } from '../../database/redis.js';

export const healthRouter = Router();

healthRouter.get('/health', async (_req, res) => {
  const [mongo, redis] = await Promise.all([checkMongoDB(), checkRedis()]);
  const ok = mongo.ok && redis.ok;
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    version: config.version,
    deps: { mongo, redis },
  });
});

healthRouter.get('/version', (req, res) => {
  const appVersion = String(req.query.appVersion || req.headers['x-app-version'] || '');
  res.json({
    version: config.version,
    name: 'teamchat-server',
    minAppVersion: config.minAppVersion,
    // Slack-style compat check: packaged apps compare their version server-side.
    ...(appVersion ? { appSupported: gte(appVersion, config.minAppVersion), appVersion } : {}),
  });
});

// Phase 10: desktop update feed (env-driven; electron-updater generic
// provider can point at hosted RELEASES, this endpoint drives the in-app
// changelog UI without any hosting infra).
healthRouter.get('/updates/latest', (req, res) => {
  if (!config.updateVersion || !config.updateUrl) {
    return res.json({ available: false, version: config.version });
  }
  const current = String(req.query.current || '');
  res.json({
    available: current ? gt(config.updateVersion, current) : true,
    version: config.updateVersion,
    url: config.updateUrl,
    notes: config.updateNotes,
    mandatory: gte(config.minAppVersion, current || '0.0.0'),
  });
});

// Minimal semver compare (no dep): returns 1/0/-1 style booleans.
function parts(v) {
  return String(v).split('.').map((n) => Number.parseInt(n, 10) || 0);
}
export function gte(a, b) {
  const [x1 = 0, y1 = 0, z1 = 0] = parts(a);
  const [x2 = 0, y2 = 0, z2 = 0] = parts(b);
  if (x1 !== x2) return x1 > x2;
  if (y1 !== y2) return y1 > y2;
  return z1 >= z2;
}
function gt(a, b) {
  return gte(a, b) && String(a) !== String(b);
}
