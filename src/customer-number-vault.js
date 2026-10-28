'use strict';

// A small, dependency-free phone/contact ledger. It intentionally stores only
// operator-provided or officially exposed records; it does not scrape hidden
// WhatsApp/community membership data.

const MAX_TEXT = 240;
const MAX_SOURCES_PER_CONTACT = 80;
const MAX_EVENTS = 20000;

function text(value, max = MAX_TEXT) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function iso(value, fallback = new Date().toISOString()) {
  const raw = String(value || '').trim();
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function normalizePhoneNumber(value, defaultCountryCode = '') {
  const raw = text(value, 80);
  if (!raw) return '';
  let compact = raw.replace(/\u00a0/g, ' ').replace(/[^0-9+]/g, '');
  if (compact.startsWith('00')) compact = `+${compact.slice(2)}`;
  const country = text(defaultCountryCode, 8).replace(/[^0-9]/g, '');
  if (!compact.startsWith('+') && country && compact.length >= 6 && compact.length <= 14) {
    compact = `+${country}${compact.replace(/^0+/, '')}`;
  }
  const digits = compact.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return '';
  return `+${digits}`;
}

function sourceKey(source = {}) {
  const type = text(source.type || source.sourceType || 'import', 40).toLowerCase() || 'import';
  const account = text(source.accountId || source.accountName, 100);
  const group = text(source.groupId || source.groupName, 160);
  return `${type}|${account}|${group}`;
}

function emptyState() {
  return { version: 1, updatedAt: '', contacts: {}, groups: {}, events: [] };
}

function normalizeState(raw = {}) {
  const out = emptyState();
  if (!raw || typeof raw !== 'object') return out;
  out.version = 1;
  out.updatedAt = String(raw.updatedAt || '');
  const contacts = raw.contacts && typeof raw.contacts === 'object' ? raw.contacts : {};
  for (const [key, value] of Object.entries(contacts)) {
    const phone = normalizePhoneNumber(value?.phone || key);
    if (!phone) continue;
    const sources = Array.isArray(value?.sources) ? value.sources : [];
    out.contacts[phone] = {
      phone,
      rawPhones: Array.from(new Set([...(Array.isArray(value?.rawPhones) ? value.rawPhones : []), text(value?.phone || key, 80)].filter(Boolean))).slice(0, 20),
      firstSeenAt: iso(value?.firstSeenAt, out.updatedAt || new Date().toISOString()),
      lastSeenAt: iso(value?.lastSeenAt, out.updatedAt || new Date().toISOString()),
      status: ['active', 'inactive', 'needs_review'].includes(String(value?.status || '')) ? String(value.status) : 'active',
      note: text(value?.note, 500),
      sources: sources.map(normalizeSource).filter(Boolean).slice(0, MAX_SOURCES_PER_CONTACT)
    };
  }
  const groups = raw.groups && typeof raw.groups === 'object' ? raw.groups : {};
  for (const [key, value] of Object.entries(groups)) {
    const groupKey = text(value?.key || key, 240);
    if (!groupKey) continue;
    out.groups[groupKey] = normalizeGroup({ ...value, key: groupKey });
  }
  out.events = Array.isArray(raw.events) ? raw.events.filter(item => item && typeof item === 'object').slice(-MAX_EVENTS) : [];
  return out;
}

function normalizeSource(source = {}) {
  if (!source || typeof source !== 'object') return null;
  const type = text(source.type || source.sourceType || 'import', 40).toLowerCase() || 'import';
  const accountId = text(source.accountId, 120);
  const accountName = text(source.accountName, 160);
  const groupId = text(source.groupId, 180);
  const groupName = text(source.groupName, 220);
  const groupType = text(source.groupType || (type === 'community' ? 'community' : 'group'), 40).toLowerCase();
  const at = iso(source.lastSeenAt || source.seenAt || source.timestamp);
  return {
    key: sourceKey({ type, accountId, accountName, groupId, groupName }),
    type,
    accountId,
    accountName,
    groupId,
    groupName,
    groupType,
    firstSeenAt: iso(source.firstSeenAt || source.seenAt || source.timestamp, at),
    lastSeenAt: at,
    status: text(source.status || 'active', 40).toLowerCase() || 'active'
  };
}

function normalizeGroup(group = {}) {
  const key = text(group.key || group.id || group.name, 240);
  const type = text(group.type || group.groupType || 'group', 40).toLowerCase() || 'group';
  return {
    key,
    id: text(group.id, 180),
    name: text(group.name || group.id, 220),
    type,
    status: text(group.status || 'active', 40).toLowerCase() || 'active',
    firstSeenAt: iso(group.firstSeenAt),
    lastSeenAt: iso(group.lastSeenAt),
    lastSyncAt: iso(group.lastSyncAt || group.lastSeenAt),
    memberCount: Math.max(0, Number(group.memberCount || 0) || 0)
  };
}

function writableState(state) {
  return state && state.version === 1 && state.contacts && typeof state.contacts === 'object' && state.groups && typeof state.groups === 'object' && Array.isArray(state.events)
    ? state
    : normalizeState(state);
}

function upsertPhone(state, payload = {}) {
  const out = writableState(state);
  const phone = normalizePhoneNumber(payload.phone || payload.phoneNumber, payload.defaultCountryCode);
  if (!phone) return { state: out, ok: false, reason: 'invalid_phone' };
  const now = iso(payload.timestamp || payload.seenAt);
  const existing = out.contacts[phone];
  const source = normalizeSource({ ...payload, timestamp: now });
  const contact = existing || {
    phone,
    rawPhones: [],
    firstSeenAt: now,
    lastSeenAt: now,
    status: 'active',
    note: '',
    sources: []
  };
  contact.rawPhones = Array.from(new Set([...contact.rawPhones, text(payload.phone || payload.phoneNumber, 80)].filter(Boolean))).slice(0, 20);
  contact.firstSeenAt = contact.firstSeenAt && Date.parse(contact.firstSeenAt) <= Date.parse(now) ? contact.firstSeenAt : now;
  contact.lastSeenAt = Date.parse(contact.lastSeenAt) >= Date.parse(now) ? contact.lastSeenAt : now;
  if (payload.status && ['active', 'inactive', 'needs_review'].includes(String(payload.status))) contact.status = String(payload.status);
  if (payload.note) contact.note = text(payload.note, 500);
  if (source) {
    const index = contact.sources.findIndex(item => item.key === source.key);
    if (index < 0) contact.sources.unshift(source);
    else {
      const merged = { ...contact.sources[index], ...source, firstSeenAt: contact.sources[index].firstSeenAt < source.firstSeenAt ? contact.sources[index].firstSeenAt : source.firstSeenAt, lastSeenAt: contact.sources[index].lastSeenAt > source.lastSeenAt ? contact.sources[index].lastSeenAt : source.lastSeenAt };
      contact.sources[index] = merged;
    }
    contact.sources = contact.sources.slice(0, MAX_SOURCES_PER_CONTACT);
    if (source.groupId || source.groupName) {
      const groupKey = text(source.groupId || source.groupName, 240);
      out.groups[groupKey] = normalizeGroup({
        ...(out.groups[groupKey] || {}), key: groupKey, id: source.groupId, name: source.groupName || source.groupId,
        type: source.groupType, lastSeenAt: now, lastSyncAt: now, status: 'active'
      });
      out.groups[groupKey].memberCount = Math.max(out.groups[groupKey].memberCount, Object.values(out.contacts).filter(row => row.sources.some(item => (item.groupId || item.groupName) === groupKey)).length + 1);
    }
  }
  out.contacts[phone] = contact;
  out.updatedAt = now;
  out.events.push({ at: now, action: existing ? 'updated' : 'added', phone, source: source ? { type: source.type, accountId: source.accountId, groupId: source.groupId, groupName: source.groupName } : null });
  if (out.events.length > MAX_EVENTS) out.events = out.events.slice(-MAX_EVENTS);
  return { state: out, ok: true, inserted: !existing, contact };
}

function markGroupDeleted(state, payload = {}) {
  const out = writableState(state);
  const key = text(payload.groupId || payload.groupName || payload.key, 240);
  if (!key) return { state: out, ok: false, reason: 'missing_group' };
  const now = iso(payload.timestamp);
  out.groups[key] = normalizeGroup({ ...(out.groups[key] || {}), key, id: payload.groupId, name: payload.groupName || payload.groupId, type: payload.groupType, status: 'deleted', lastSeenAt: now, lastSyncAt: now });
  for (const contact of Object.values(out.contacts)) for (const source of contact.sources) if ((source.groupId || source.groupName) === key) source.status = 'deleted';
  out.updatedAt = now;
  out.events.push({ at: now, action: 'group_deleted', group: key });
  if (out.events.length > MAX_EVENTS) out.events = out.events.slice(-MAX_EVENTS);
  return { state: out, ok: true, group: out.groups[key] };
}

function listContacts(state, filter = {}) {
  const out = normalizeState(state);
  const query = text(filter.query, 120).toLowerCase();
  const rows = Object.values(out.contacts).filter(row => {
    if (filter.status && row.status !== filter.status) return false;
    if (filter.sourceType && !row.sources.some(source => source.type === filter.sourceType)) return false;
    if (filter.group && !row.sources.some(source => `${source.groupId} ${source.groupName}`.toLowerCase().includes(String(filter.group).toLowerCase()))) return false;
    if (!query) return true;
    return `${row.phone} ${row.rawPhones.join(' ')} ${row.sources.map(source => `${source.accountName} ${source.groupName}`).join(' ')}`.toLowerCase().includes(query);
  });
  return rows.sort((a, b) => Date.parse(b.lastSeenAt || 0) - Date.parse(a.lastSeenAt || 0)).slice(0, Math.max(1, Math.min(5000, Number(filter.limit || 500) || 500)));
}

function stats(state, now = Date.now()) {
  const out = normalizeState(state);
  const contacts = Object.values(out.contacts);
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const week = now - 7 * 86400000;
  const month = now - 30 * 86400000;
  const bySource = {}, byAccount = {}, byGroup = {};
  for (const contact of contacts) {
    const sources = contact.sources.length ? contact.sources : [{ type: 'import', accountName: '', groupName: '' }];
    for (const source of sources) {
      bySource[source.type] = (bySource[source.type] || 0) + 1;
      const account = source.accountName || source.accountId || '未标记账号';
      byAccount[account] = (byAccount[account] || 0) + 1;
      const group = source.groupName || source.groupId;
      if (group) byGroup[group] = (byGroup[group] || 0) + 1;
    }
  }
  const firstTimes = contacts.map(row => Date.parse(row.firstSeenAt || 0)).filter(Number.isFinite);
  return {
    total: contacts.length,
    active: contacts.filter(row => row.status === 'active').length,
    needsReview: contacts.filter(row => row.status === 'needs_review').length,
    todayNew: contacts.filter(row => Date.parse(row.firstSeenAt || 0) >= start.getTime()).length,
    last7DaysNew: contacts.filter(row => Date.parse(row.firstSeenAt || 0) >= week).length,
    last30DaysNew: contacts.filter(row => Date.parse(row.firstSeenAt || 0) >= month).length,
    groups: Object.keys(out.groups).length,
    activeGroups: Object.values(out.groups).filter(group => group.status === 'active').length,
    deletedGroups: Object.values(out.groups).filter(group => group.status === 'deleted').length,
    bySource, byAccount, byGroup,
    oldest: firstTimes.length ? new Date(Math.min(...firstTimes)).toISOString() : '',
    updatedAt: out.updatedAt
  };
}

function csvEscape(value) {
  const raw = String(value == null ? '' : value);
  return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function toCsv(state, filter = {}) {
  const rows = listContacts(state, { ...filter, limit: 50000 });
  const header = ['phone', 'status', 'firstSeenAt', 'lastSeenAt', 'accounts', 'groups', 'sources', 'note'];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push([
      row.phone, row.status, row.firstSeenAt, row.lastSeenAt,
      Array.from(new Set(row.sources.map(source => source.accountName || source.accountId).filter(Boolean))).join(' | '),
      Array.from(new Set(row.sources.map(source => source.groupName || source.groupId).filter(Boolean))).join(' | '),
      Array.from(new Set(row.sources.map(source => source.type).filter(Boolean))).join(' | '), row.note
    ].map(csvEscape).join(','));
  }
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

module.exports = { emptyState, normalizeState, normalizePhoneNumber, upsertPhone, markGroupDeleted, listContacts, stats, toCsv };
