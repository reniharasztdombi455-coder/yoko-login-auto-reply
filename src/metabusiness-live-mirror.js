'use strict';

const { metaBusinessCanonicalChatId, metaBusinessPlausibleCustomerName } = require('./metabusiness-inbox-acquisition');

function clean(value, max = 500) {
  return String(value ?? '').replace(/\u0000/g,'').replace(/\s+/g,' ').trim().slice(0,max);
}

function nameKey(row = {}) {
  return clean(row.displayName || row.name, 180).toLocaleLowerCase();
}

function canonicalKey(row = {}) {
  return metaBusinessCanonicalChatId(row.chatId || row.href || '');
}

function overlayMetaBusinessLiveRows(cachedRows = [], liveRows = [], now = Date.now()) {
  const cached = Array.isArray(cachedRows) ? cachedRows.filter(Boolean) : [];
  const live = Array.isArray(liveRows) ? liveRows.filter(Boolean) : [];
  if (!live.length) return cached.slice();

  const cachedByName = new Map();
  const cachedByCanonical = new Map();
  for (const row of cached) {
    const n=nameKey(row), c=canonicalKey(row);
    if (n && !cachedByName.has(n)) cachedByName.set(n,row);
    if (c && !cachedByCanonical.has(c)) cachedByCanonical.set(c,row);
  }

  const used = new Set();
  const out = [];
  const seenLiveNames = new Set();
  for (const liveRow of live) {
    if (!metaBusinessPlausibleCustomerName(liveRow.displayName || liveRow.name || '')) continue;
    const n=nameKey(liveRow), c=canonicalKey(liveRow);
    if (n && seenLiveNames.has(n)) continue;
    if (n) seenLiveNames.add(n);
    // Name-first is intentional. A stale Meta thread alias was one of the real
    // failure modes that hid visible customers such as 金子周平/Steve Arai.
    const old=(n && cachedByName.get(n)) || (c && cachedByCanonical.get(c)) || null;
    if (old) used.add(old);
    out.push({
      ...(old || {}),
      ...liveRow,
      aggregateUiKey:clean(old?.aggregateUiKey,520) || clean(liveRow?.aggregateUiKey,520) || (n ? `mb-ui:name:${n}` : ''),
      firstSeenAt:Number(old?.firstSeenAt || 0) || Number(now || Date.now()),
      aggregateDisplayOrder:Number(old?.aggregateDisplayOrder || 0) || 0
    });
  }
  for (const row of cached) if (!used.has(row)) out.push(row);
  return out;
}

module.exports = { overlayMetaBusinessLiveRows };
