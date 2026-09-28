import { verifyAccessToken } from '../modules/auth/tokens.js';
import { findOne } from '../database/db.js';

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    avatarUrl: u.avatar_url,
    timezone: u.timezone,
    status: u.status,
    customStatus: u.custom_status,
    emailVerified: Boolean(u.email_verified_at),
    createdAt: u.created_at,
  };
}

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing bearer token' } });
    }
    let claims;
    try {
      claims = verifyAccessToken(token);
    } catch {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
    }
    const user = await findOne('users', { id: claims.sub });
    if (!user) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'User not found' } });
    const session = await findOne('sessions', { id: claims.sid });
    if (!session || session.revoked_at || new Date(session.expires_at) < new Date()) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Session revoked or expired' } });
    }
    req.user = user;
    req.session = session;
    next();
  } catch (e) {
    next(e);
  }
}
