'use strict';

const { metaBusinessCanonicalChatId, metaBusinessPlausibleCustomerName } = require('./metabusiness-inbox-acquisition');

function clean(value, max = 500) {
  return String(value ?? '').replace(/\u0000/g,'').replace(/\s+/g,' ').trim().slice(0,max);
}

function nameKey(row = {}) {
  const name = clean(row.displayName || row.name, 180).toLocaleLowerCase();
  return name ? `name:${name}` : '';
}

function canonicalKey(row = {}) {
  const canonical = metaBusinessCanonicalChatId(row.chatId || row.href || '');
  return canonical ? `chat:${canonical}` : '';
}

// Name-first is intentional for MB. Real Meta hydration can rotate thread aliases
// while the operator still sees the same person. Exact display name within one
// account proved more stable for the visual mirror than a transient thread token.
function stableRowKey(row = {}) {
  return nameKey(row) || canonicalKey(row);
}

function activityState(row = {}) {
  return {
    preview:clean(row.preview || row.lastMessage || '', 700),
    timeText:clean(row.timeText || '', 80),
    direction:clean(row.lastDirection || '', 20).toLowerCase(),
    unread:Math.max(0, Number(row.unreadCount || 0) || 0)
  };
}

function meaningfulActivityChanged(before, after) {
  if (!before) return false; // first observation is not a new-message event
  if (after.preview && after.preview !== before.preview) return true;
  if (after.unread > before.unread) return true;
  if (after.direction && before.direction && after.direction !== before.direction) return true;
  // Repeated identical messages can leave the same preview. Treat a changed
  // concrete clock label as activity, but ignore broad hydration labels such as
  // 周六/Yesterday which Meta may rewrite while scrolling.
  const clock = /^\d{1,2}:\d{2}$/;
  if (after.timeText !== before.timeText && clock.test(after.timeText) && before.timeText) return true;
  return false;
}

function insertUnknownByVisibleNeighbors(order, visibleKeys) {
  const out = Array.isArray(order) ? order.slice() : [];
  for (let i = 0; i < visibleKeys.length; i += 1) {
    const key = visibleKeys[i];
    if (!key || out.includes(key)) continue;
    let previousKnown = '';
    for (let p = i - 1; p >= 0; p -= 1) {
      if (out.includes(visibleKeys[p])) { previousKnown = visibleKeys[p]; break; }
    }
    let nextKnown = '';
    for (let n = i + 1; n < visibleKeys.length; n += 1) {
      if (out.includes(visibleKeys[n])) { nextKnown = visibleKeys[n]; break; }
    }
    if (previousKnown) {
      let pos = out.indexOf(previousKnown) + 1;
      while (pos < out.length && visibleKeys.includes(out[pos]) && visibleKeys.indexOf(out[pos]) < i) pos += 1;
      out.splice(pos, 0, key);
    } else if (nextKnown) {
      out.splice(Math.max(0, out.indexOf(nextKnown)), 0, key);
    } else {
      out.push(key);
    }
  }
  return out;
}

function updateStableMirrorState(previous = null, rows = [], now = Date.now()) {
  const state = previous && typeof previous === 'object'
    ? {
        order:Array.isArray(previous.order) ? previous.order.slice() : [],
        activity:{ ...(previous.activity || {}) },
        meta:{ ...(previous.meta || {}) },
        updatedAt:Number(previous.updatedAt || 0) || 0
      }
    : { order:[], activity:{}, meta:{}, updatedAt:0 };

  const visibleRows = (Array.isArray(rows) ? rows : [])
    .filter(row => metaBusinessPlausibleCustomerName(row?.displayName || row?.name || ''))
    .slice()
    .sort((a,b) => {
      const rank = row => {
        const raw=row?.nativeSnapshotRank;
        if (raw===null || raw===undefined || raw==='') return null;
        const n=Number(raw); return Number.isFinite(n) ? n : null;
      };
      const arn=rank(a), brn=rank(b);
      const ar = arn!==null ? arn : Number(a?.top || 0);
      const br = brn!==null ? brn : Number(b?.top || 0);
      return ar - br;
    });

  const seen = new Set();
  const visible = [];
  for (const row of visibleRows) {
    const key = stableRowKey(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    visible.push({ key, row });
  }
  const visibleKeys = visible.map(item => item.key);

  if (!state.order.length) state.order = visibleKeys.slice();
  else state.order = insertUnknownByVisibleNeighbors(state.order, visibleKeys);

  const promoted = [];
  for (const { key, row } of visible) {
    const next = activityState(row);
    const before = state.activity[key] || null;
    if (meaningfulActivityChanged(before, next)) promoted.push(key);
    state.activity[key] = next;
    state.meta[key] = {
      name:clean(row.displayName || row.name,180),
      chatId:clean(row.chatId || '',500),
      href:clean(row.href || '',1200)
    };
  }

  // A real message/reply changes Meta's recency order. Promote only rows with
  // activity deltas. Merely scrolling to another virtualized slice never moves
  // already-known customers, so MB and Yoko can scroll independently.
  if (promoted.length) {
    const promotedSet = new Set(promoted);
    state.order = [...promoted, ...state.order.filter(key => !promotedSet.has(key))];
  }

  // Keep bounded state. The aggregate itself holds the durable customer data;
  // this structure only owns the current visual order session.
  if (state.order.length > 1000) state.order = state.order.slice(0,1000);
  const allowed = new Set(state.order);
  for (const key of Object.keys(state.activity)) if (!allowed.has(key)) delete state.activity[key];
  for (const key of Object.keys(state.meta)) if (!allowed.has(key)) delete state.meta[key];
  state.updatedAt = Number(now || Date.now()) || Date.now();
  return state;
}

function rankMapFromState(state = {}) {
  const map = new Map();
  for (const [index,key] of (Array.isArray(state.order) ? state.order : []).entries()) if (key) map.set(key,index);
  return map;
}

function rankForRow(state = {}, row = {}) {
  const key = stableRowKey(row);
  if (!key) return null;
  const map = rankMapFromState(state);
  const rank = map.get(key);
  return Number.isInteger(rank) && rank >= 0 ? rank : null;
}

module.exports = {
  stableRowKey,
  activityState,
  meaningfulActivityChanged,
  updateStableMirrorState,
  rankMapFromState,
  rankForRow
};
