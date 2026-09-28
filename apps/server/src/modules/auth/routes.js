import { Router } from 'express';
import { findOne, insertOne, updateOne, deleteOne } from '../../database/db.js';
import { ensureRedis } from '../../database/redis.js';
import { logger } from '../../common/logger.js';
import { publicUser, requireAuth } from '../../common/auth.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { signAccessToken, newOpaqueToken, hashToken } from './tokens.js';
import { registerSchema, loginSchema, validate } from '@teamchat/validation';

export const authRouter = Router();

const REFRESH_DAYS = Number(process.env.REFRESH_TOKEN_EXPIRES_IN_DAYS || 30);

function daysFromNow(days) {
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
}

async function createSession(userId, req) {
  const expiresAt = daysFromNow(REFRESH_DAYS);
  const s = await insertOne('sessions', { userId, device_info: req.headers['user-agent']?.slice(0, 255) || null, ip: req.ip || null, expires_at: expiresAt });
  return s;
}

async function issueRefresh(userId, sessionId) {
  const raw = newOpaqueToken();
  const expiresAt = daysFromNow(REFRESH_DAYS);
  const row = await insertOne('refresh_tokens', { userId, session_id: sessionId, token_hash: hashToken(raw), expires_at: expiresAt });
  return { raw, row };
}

async function revokeSession(sessionId) {
  await updateOne('sessions', { id: sessionId }, { $set: { revoked_at: new Date() } });
  await updateOne('refresh_tokens', { session_id: sessionId, revoked_at: null }, { $set: { revoked_at: new Date() } });
}

// POST /auth/register
authRouter.post('/auth/register', async (req, res, next) => {
  try {
    const { email, password, displayName } = validate(registerSchema, req.body);
    const existing = await findOne('users', { email });
    if (existing) return res.status(409).json({ error: { code: 'EMAIL_TAKEN', message: 'Email already registered' } });
    const passwordHash = await hashPassword(password);
    const user = await insertOne('users', { email, password_hash: passwordHash, display_name: displayName });
    const raw = newOpaqueToken(32);
    await insertOne('email_verification_tokens', { user_id: user.id, token_hash: hashToken(raw), expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000) });
    logger.info({ email, userId: user.id }, 'registered (dev: verify token below)');
    logger.info({ verifyToken: raw }, 'DEV ONLY: email verification token');
    res.status(201).json({ user: publicUser(user), verificationRequired: true });
  } catch (e) {
    next(e);
  }
});

// POST /auth/login (Redis-throttled: 10 attempts/min per email)
authRouter.post('/auth/login', async (req, res, next) => {
  try {
    const { email, password } = validate(loginSchema, req.body);
    const redis = await ensureRedis();
    const key = `login:${email.toLowerCase()}`;
    let attempts = 0;
    try {
      attempts = await redis.incr(key);
      if (attempts === 1) await redis.expire(key, 60);
    } catch {}
    if (attempts > 10) return res.status(429).json({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many login attempts, try again in a minute' } });

    const user = await findOne('users', { email });
    const ok = user ? await verifyPassword(user.password_hash, password) : false;
    if (!ok) return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });

    const session = await createSession(user.id, req);
    const { raw } = await issueRefresh(user.id, session.id);
    await updateOne('users', { id: user.id }, { $set: { status: 'ONLINE' } });
    logger.info({ userId: user.id, sessionId: session.id }, 'login');
    res.json({ accessToken: signAccessToken(user.id, session.id), refreshToken: raw, user: publicUser(user) });
  } catch (e) {
    next(e);
  }
});

// POST /auth/refresh (rotation + reuse detection)
authRouter.post('/auth/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'refreshToken required' } });
    const stored = await findOne('refresh_tokens', { token_hash: hashToken(refreshToken) });
    if (!stored) return res.status(401).json({ error: { code: 'INVALID_REFRESH', message: 'Invalid refresh token' } });
    if (stored.revoked_at || stored.rotated_to || new Date(stored.expires_at) < new Date()) {
      // Possible reuse attack: kill the whole session chain.
      await revokeSession(stored.session_id);
      logger.warn({ sessionId: stored.session_id }, 'refresh reuse detected — session revoked');
      return res.status(401).json({ error: { code: 'REFRESH_REUSED', message: 'Session revoked, please login again' } });
    }
    const session = await findOne('sessions', { id: stored.session_id });
    if (!session || session.revoked_at || new Date(session.expires_at) < new Date()) {
      return res.status(401).json({ error: { code: 'INVALID_REFRESH', message: 'Session expired' } });
    }
    const { raw, row } = await issueRefresh(stored.user_id, stored.session_id);
    await updateOne('refresh_tokens', { id: stored.id }, { $set: { rotated_to: row.id, revoked_at: new Date() } });
    res.json({ accessToken: signAccessToken(stored.user_id, stored.session_id), refreshToken: raw });
  } catch (e) {
    next(e);
  }
});

// POST /auth/logout
authRouter.post('/auth/logout', requireAuth, async (req, res, next) => {
  try {
    await revokeSession(req.session.id);
    await updateOne('users', { id: req.user.id }, { $set: { status: 'OFFLINE' } });
    logger.info({ userId: req.user.id, sessionId: req.session.id }, 'logout');
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// GET /auth/verify-email?token=
authRouter.get('/auth/verify-email', async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'token required' } });
    const stored = await findOne('email_verification_tokens', { token_hash: hashToken(String(token)) });
    if (!stored || stored.used_at || new Date(stored.expires_at) < new Date()) {
      return res.status(400).json({ error: { code: 'INVALID_TOKEN', message: 'Invalid or expired verification token' } });
    }
    await updateOne('email_verification_tokens', { id: stored.id }, { $set: { used_at: new Date() } });
    await updateOne('users', { id: stored.user_id }, { $set: { email_verified_at: new Date() } });
    res.json({ verified: true });
  } catch (e) {
    next(e);
  }
});

// POST /auth/forgot-password (always 200 — no user enumeration)
authRouter.post('/auth/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body || {};
    const user = email ? await findOne('users', { email }) : null;
    if (user) {
      const raw = newOpaqueToken(32);
      await insertOne('password_reset_tokens', { user_id: user.id, token_hash: hashToken(raw), expires_at: new Date(Date.now() + 1 * 3600 * 1000) });
      logger.info({ userId: user.id, resetToken: raw }, 'DEV ONLY: password reset token');
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// POST /auth/reset-password (resets + revokes all sessions)
authRouter.post('/auth/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password || String(password).length < 8 || String(password).length > 128) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'token and password (8-128 chars) required' } });
    }
    const stored = await findOne('password_reset_tokens', { token_hash: hashToken(String(token)) });
    if (!stored || stored.used_at || new Date(stored.expires_at) < new Date()) {
      return res.status(400).json({ error: { code: 'INVALID_TOKEN', message: 'Invalid or expired reset token' } });
    }
    await updateOne('password_reset_tokens', { id: stored.id }, { $set: { used_at: new Date() } });
    await updateOne('users', { id: stored.user_id }, { $set: { password_hash: await hashPassword(password) } });
    await updateOne('sessions', { user_id: stored.user_id, revoked_at: null }, { $set: { revoked_at: new Date() } });
    await updateOne('refresh_tokens', { user_id: stored.user_id, revoked_at: null }, { $set: { revoked_at: new Date() } });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// GET /auth/me
authRouter.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});
