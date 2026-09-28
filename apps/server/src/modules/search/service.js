import { find, count } from '../../database/db.js';

function decodeCursor(cursor) {
  const n = Number.parseInt(String(cursor || '0'), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const SearchService = {
  async searchMessages({ workspaceId, userId, parsed, limit = 20, cursor = '0' }) {
    const offset = decodeCursor(cursor);
    // Unknown refs (from:nobody, in:#missing) match nothing.
    if (parsed.fromUserId === '__unknown__' || parsed.inChannelId === '__unknown__') {
      return { items: [], nextCursor: null };
    }
    const hasText = Boolean(parsed.text || parsed.phrases.length);
    const filter = { workspace_id: workspaceId, deleted_at: null };
    if (parsed.inChannelId) filter.channel_id = parsed.inChannelId;
    if (parsed.fromUserId) filter.sender_id = parsed.fromUserId;
    const andClauses = [];
    if (parsed.text) andClauses.push({ content: { $regex: escapeRegex(parsed.text), $options: 'i' } });
    for (const p of parsed.phrases) andClauses.push({ content: { $regex: escapeRegex(p), $options: 'i' } });
    if (parsed.before) andClauses.push({ created_at: { $lt: parsed.before } });
    if (parsed.after) andClauses.push({ created_at: { $gt: parsed.after } });
    const query = andClauses.length ? { $and: [filter, ...andClauses] } : filter;
    const r = await find('messages', query, { limit: limit + 1, sort: { created_at: -1 } });
    // Slack privacy: hide private channels the user is not in.
    const channelIds = [...new Set(r.map((m) => m.channel_id).filter(Boolean))];
    let privateIds = new Set();
    if (channelIds.length) {
      const chans = await find('channels', { id: { $in: channelIds } });
      const privates = chans.filter((c) => c.is_private).map((c) => c.id);
      if (privates.length) {
        const mine = await find('channel_members', { channel_id: { $in: privates }, user_id: userId });
        const mineSet = new Set(mine.map((m) => m.channel_id));
        privateIds = new Set(privates.filter((id) => !mineSet.has(id)));
      }
    }
    let rows = r.filter((m) => !m.channel_id || !privateIds.has(m.channel_id));
    // has:file — keep only messages with an attachment row.
    let fileSet = null;
    if (parsed.hasFile) {
      const atts = await find('message_attachments', { message_id: { $in: rows.map((m) => m.id) } });
      fileSet = new Set(atts.map((a) => a.message_id));
      rows = rows.filter((m) => fileSet.has(m.id));
    }
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const senders = await find('users', { id: { $in: [...new Set(page.map((m) => m.sender_id))] } });
    const senderMap = Object.fromEntries(senders.map((u) => [u.id, u]));
    const chans = await find('channels', { id: { $in: [...new Set(page.map((m) => m.channel_id).filter(Boolean))] } });
    const chanMap = Object.fromEntries(chans.map((c) => [c.id, c]));
    let attachMap = {};
    if (!parsed.hasFile && page.length) {
      const atts = await find('message_attachments', { message_id: { $in: page.map((m) => m.id) } });
      for (const a of atts) attachMap[a.message_id] = true;
    } else if (fileSet) {
      for (const id of fileSet) attachMap[id] = true;
    }
    return {
      items: page.map((m) => ({
        id: m.id,
        workspaceId: m.workspace_id,
        channelId: m.channel_id,
        channelName: chanMap[m.channel_id]?.name,
        sender: { id: m.sender_id, displayName: senderMap[m.sender_id]?.display_name, avatarUrl: senderMap[m.sender_id]?.avatar_url },
        content: m.content,
        snippet: m.content?.slice(0, 200) || '',
        createdAt: m.created_at,
        rank: 1,
        hasFile: Boolean(attachMap[m.id]),
      })),
      nextCursor: hasMore ? String(offset + limit) : null,
    };
  },

  async searchUsers({ workspaceId, text, limit = 20, cursor = '0' }) {
    const offset = decodeCursor(cursor);
    const lower = text?.toLowerCase() || '';
    const wmMembers = await find('workspace_members', { workspace_id: workspaceId });
    const userIds = wmMembers.map((m) => m.user_id);
    if (!userIds.length) return { items: [], nextCursor: null };
    const r = await find('users', { id: { $in: userIds } }, { sort: { display_name: 1 }, limit: limit + 1 });
    const filtered = lower === '' ? r : r.filter((u) => u.display_name?.toLowerCase().includes(lower) || u.email?.toLowerCase().includes(lower));
    const hasMore = filtered.length > limit;
    const page = hasMore ? filtered.slice(0, limit) : filtered;
    return {
      items: page.map((u) => ({
        id: u.id, email: u.email, displayName: u.display_name,
        avatarUrl: u.avatar_url, status: u.status, customStatus: u.custom_status,
      })),
      nextCursor: hasMore ? String(offset + limit) : null,
    };
  },

  async searchChannels({ workspaceId, userId, text, limit = 20, cursor = '0' }) {
    const offset = decodeCursor(cursor);
    const lower = text?.toLowerCase() || '';
    const allChannels = await find('channels', { workspace_id: workspaceId }, { sort: { name: 1 }, limit: limit + 1 });
    const memberChannels = await find('channel_members', { channel_id: { $in: allChannels.map((c) => c.id) }, user_id: userId });
    const memberChannelIds = new Set(memberChannels.map((m) => m.channel_id));
    const filtered = allChannels.filter((c) => !c.is_private || memberChannelIds.has(c.id));
    const textFiltered = lower === '' ? filtered : filtered.filter((c) => c.name?.toLowerCase().includes(lower) || c.description?.toLowerCase().includes(lower) || c.topic?.toLowerCase().includes(lower));
    const hasMore = textFiltered.length > limit;
    const page = hasMore ? textFiltered.slice(0, limit) : textFiltered;
    const memberCounts = {};
    for (const c of page) {
      memberCounts[c.id] = await count('channel_members', { channel_id: c.id });
    }
    return {
      items: page.map((c) => ({
        id: c.id, workspaceId: c.workspace_id, name: c.name, slug: c.slug,
        description: c.description, topic: c.topic,
        isPrivate: c.is_private, isArchived: c.is_archived,
        memberCount: Number(memberCounts[c.id] || 0),
      })),
      nextCursor: hasMore ? String(offset + limit) : null,
    };
  },

  async searchFiles({ workspaceId, text, limit = 20, cursor = '0' }) {
    const offset = decodeCursor(cursor);
    const r = await find('files', { workspace_id: workspaceId }, { sort: { created_at: -1 }, limit: limit + 1 });
    const hasMore = r.length > limit;
    const page = hasMore ? r.slice(0, limit) : r;
    return {
      items: page.map((f) => ({
        id: f.id, workspaceId: f.workspace_id, uploaderId: f.uploader_id,
        messageId: f.message_id, filename: f.filename, mimeType: f.mime_type,
        size: Number(f.size), url: `/files/${f.id}`,
        thumbUrl: f.thumb_storage_key ? `/files/${f.id}/thumb` : null,
        createdAt: f.created_at,
      })),
      nextCursor: hasMore ? String(offset + limit) : null,
    };
  },
};
