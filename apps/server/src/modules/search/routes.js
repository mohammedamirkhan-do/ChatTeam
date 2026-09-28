import { Router } from 'express';
import { requireAuth } from '../../common/auth.js';
import { findOne } from '../../database/db.js';
import { searchQuerySchema, validate } from '@teamchat/validation';
import { parseSearchQuery, resolveSearchRefs } from './parser.js';
import { SearchService } from './service.js';

export const searchRouter = Router();

searchRouter.get('/search', requireAuth, async (req, res, next) => {
  try {
    const { q, workspaceId, type, limit, cursor } = validate(searchQuerySchema, req.query);
    const member = await findOne('workspace_members', { workspace_id: workspaceId, user_id: req.user.id });
    if (!member) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not a workspace member' } });

    const parsed = parseSearchQuery(q);
    const resolved = await resolveSearchRefs(workspaceId, parsed);
    const freeText = [resolved.text, ...resolved.phrases].filter(Boolean).join(' ');

    if (type === 'messages') {
      const r = await SearchService.searchMessages({ workspaceId, userId: req.user.id, parsed: resolved, limit, cursor });
      return res.json({ type, query: q, parsed: sanitizeParsed(resolved), ...r });
    }
    if (type === 'users') {
      const r = await SearchService.searchUsers({ workspaceId, text: resolved.from || freeText, limit, cursor });
      return res.json({ type, query: q, ...r });
    }
    if (type === 'channels') {
      const r = await SearchService.searchChannels({ workspaceId, userId: req.user.id, text: resolved.inChannel || freeText, limit, cursor });
      return res.json({ type, query: q, ...r });
    }
    if (type === 'files') {
      const r = await SearchService.searchFiles({ workspaceId, userId: req.user.id, text: freeText, limit, cursor });
      return res.json({ type, query: q, ...r });
    }
    const [messages, users, channels, files] = await Promise.all([
      SearchService.searchMessages({ workspaceId, userId: req.user.id, parsed: resolved, limit, cursor }),
      SearchService.searchUsers({ workspaceId, text: resolved.from || freeText, limit, cursor }),
      SearchService.searchChannels({ workspaceId, userId: req.user.id, text: resolved.inChannel || freeText, limit, cursor }),
      SearchService.searchFiles({ workspaceId, userId: req.user.id, text: freeText, limit, cursor }),
    ]);
    res.json({ type, query: q, parsed: sanitizeParsed(resolved), messages, users, channels, files });
  } catch (e) {
    next(e);
  }
});

function sanitizeParsed(p) {
  return {
    text: p.text, phrases: p.phrases, from: p.from, inChannel: p.inChannel,
    hasFile: p.hasFile,
    before: p.before?.toISOString?.() || null,
    after: p.after?.toISOString?.() || null,
  };
}
