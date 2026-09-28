import { findOne, find } from '../../database/db.js';

export function parseSearchQuery(raw) {
  const out = { text: '', phrases: [], from: null, inChannel: null, hasFile: false, before: null, after: null };
  if (!raw || typeof raw !== 'string') return out;
  let s = raw;

  const phrases = [];
  s = s.replace(/"([^"]{1,200})"/g, (_m, p) => {
    phrases.push(p.trim());
    return ' ';
  });
  out.phrases = phrases.filter(Boolean);

  const tokens = s.split(/\s+/).filter(Boolean);
  const textTokens = [];
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    if (low.startsWith('from:') && tok.length > 5) {
      out.from = tok.slice(5).replace(/^@/, '');
    } else if (low.startsWith('in:') && tok.length > 3) {
      out.inChannel = tok.slice(3).replace(/^#/, '');
    } else if (low === 'has:file' || low === 'has:files') {
      out.hasFile = true;
    } else if (low.startsWith('before:')) {
      const d = new Date(tok.slice(7));
      if (!Number.isNaN(d.getTime())) out.before = d;
    } else if (low.startsWith('after:')) {
      const d = new Date(tok.slice(6));
      if (!Number.isNaN(d.getTime())) out.after = d;
    } else {
      textTokens.push(tok);
    }
  }
  out.text = textTokens.join(' ').trim();
  return out;
}

export async function resolveSearchRefs(workspaceId, parsed) {
  const resolved = { ...parsed, fromUserId: null, inChannelId: null };
  if (parsed.from) {
    const key = parsed.from.toLowerCase();
    const memberships = await find('workspace_members', { workspace_id: workspaceId });
    const users = await find('users', { id: { $in: memberships.map((m) => m.user_id) } });
    const match = users.find((u) => u.email?.toLowerCase() === key || u.email?.toLowerCase().startsWith(key) || u.display_name?.toLowerCase() === key || u.display_name?.toLowerCase().startsWith(key));
    resolved.fromUserId = match?.id || '__unknown__';
  }
  if (parsed.inChannel) {
    const key = parsed.inChannel.toLowerCase();
    const ch = await findOne('channels', { workspace_id: workspaceId, $or: [{ name: key }, { slug: key }] });
    resolved.inChannelId = ch?.id || '__unknown__';
  }
  return resolved;
}
