'use strict';

function clean(value, max = 1800) {
  return String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const META_THREAD_PARAMS = Object.freeze([
  'selected_item_id','selected_thread_id','thread_id','conversation_id','conversationId','threadId','item_id'
]);

function metaBusinessThreadToken(value = '') {
  const raw = clean(value, 2600);
  if (!raw) return '';
  if (/^mb-thread:/i.test(raw)) return clean(raw.replace(/^mb-thread:/i, ''), 500);
  try {
    const u = new URL(raw, 'https://business.facebook.com/latest/inbox/');
    const host = String(u.hostname || '').toLowerCase();
    if (!(host === 'business.facebook.com' || host.endsWith('.business.facebook.com') || host === 'facebook.com' || host.endsWith('.facebook.com'))) return '';
    for (const key of META_THREAD_PARAMS) {
      const val = clean(u.searchParams.get(key), 500);
      if (val) return val;
    }
    const pathPatterns = [
      /\/(?:conversation|thread|message-thread)\/([^/?#]+)/i,
      /\/inbox\/(?:all|messenger|instagram)?\/?([^/?#]+)?$/i
    ];
    for (const re of pathPatterns) {
      const m = String(u.pathname || '').match(re);
      const token = clean(m?.[1], 500);
      if (token && !/^(?:all|messenger|instagram|whatsapp)$/i.test(token)) return token;
    }
  } catch {}
  return '';
}

function metaBusinessCanonicalChatId(value = '') {
  const token = metaBusinessThreadToken(value);
  return token ? `mb-thread:${token}` : '';
}

// Empty previews are normal in Meta Business (for example emoji/media-only rows).
// V1.27.4/5 treated an empty preview as "system text", which silently deleted
// perfectly real customers during dedupe.  Empty is therefore explicitly safe.
function metaBusinessSystemOrAdText(value = '') {
  const v = clean(value, 1200);
  if (!v) return false;
  return /(?:这个聊天包含对以下广告的回复|此聊天包含.*广告.*回复|包含对以下广告|查看广告|查看廣告|广告回复|廣告回覆|创建消息类广告|建立訊息廣告|Sponsored|sponsored|ad reply|replied to (?:your |an )?ad|responded to (?:your |an )?ad)/i.test(v);
}

function metaBusinessPlausibleCustomerName(value = '') {
  const v = clean(value, 220);
  if (!v || v.length > 140) return false;
  if (metaBusinessSystemOrAdText(v)) return false;
  if (/^(?:https?:\/\/|www\.|line\.me\/)/i.test(v)) return false;
  if (/^(?:你|您|You)\s*[:：]/i.test(v)) return false;
  if (/(?:^|\s)(?:复制|複製|Copy)(?:\s|$)/i.test(v)) return false;
  if (/^(?:Instagram|Facebook)\s*(?:评论|評論|评论区|評論區|コメント|Comments?)/i.test(v)) return false;
  // V1.27.35: Meta inserts account/setup actions into the same virtual list
  // geometry as real conversations. These are navigation actions, never people.
  // Drop them here so old cached bogus rows self-heal on the next dedupe too.
  if (/^(?:(?:绑定|綁定|关联|關聯|连接|連接|连结|連結|打开|開啟|新增|添加|管理)\s*(?:Instagram|Facebook|Messenger|WhatsApp|主页|主頁|公共主页|公共主頁|粉丝专页|粉絲專頁|Page|账号|帳號)|(?:关联|關聯|绑定|綁定)\s*(?:主页|主頁))$/iu.test(v)) return false;
  if (/^(?:打开|打開|开启|開啟|关联|關聯|绑定|綁定|连接|連接|管理|新增|添加|关闭|關閉)$/u.test(v)) return false;
  if (/^(?:打开|打開|开启|開啟|关联|關聯|绑定|綁定|连接|連接|管理|新增|添加).{0,48}(?:Instagram|Facebook|Messenger|WhatsApp|主页|主頁|公共主页|公共主頁|粉丝专页|粉絲專頁|Page|账号|帳號)/iu.test(v)) return false;
  if (/^(?:Facebook|Messenger|Meta Business Suite|Meta Business|收件箱|所有消息|Instagram|WhatsApp|搜索|管理|未读|优先级|广告回复|后续跟进|在线|Inbox|All messages|Search|Manage)$/i.test(v)) return false;
  // V1.27.85 defense-in-depth: a native virtual-row ancestor may collapse the
  // customer's name, latest preview and relative timestamp into one text node.
  // Do not let that synthetic row string become a CRM/GPT customer identity.
  if (/(?:今天|今日|昨天|昨日|Today|Yesterday)\s*\d{1,2}:\d{2}\s*$/iu.test(v)) return false;
  if (/\d{1,2}:\d{2}\s*$/u.test(v) && v.length > 32) return false;
  return true;
}

function metaBusinessConversationIdentity(row = {}) {
  const canonical = metaBusinessCanonicalChatId(row.chatId || row.href || '');
  if (canonical) return canonical.toLowerCase();
  const handle = clean(row.handle, 180).replace(/^@+/, '').toLowerCase();
  if (handle) return `handle:${handle}`;
  const name = clean(row.displayName || row.name, 180).toLocaleLowerCase();
  return name ? `name:${name}` : '';
}

function metaBusinessUiKey(row = {}) {
  const existing = clean(row.aggregateUiKey || row.uiKey, 520);
  if (existing) return existing;
  const canonical = metaBusinessCanonicalChatId(row.chatId || row.href || '');
  if (canonical) return `mb-ui:${canonical.toLowerCase()}`;
  const handle = clean(row.handle, 180).replace(/^@+/, '').toLowerCase();
  if (handle) return `mb-ui:handle:${handle}`;
  const name = clean(row.displayName || row.name, 180).toLocaleLowerCase();
  return name ? `mb-ui:name:${name}` : '';
}

function mergeMetaBusinessConversationRows(primary = {}, alias = {}) {
  const canonical = metaBusinessCanonicalChatId(primary.chatId || primary.href || alias.chatId || alias.href || '');
  const firstPositive = (...values) => values.map(Number).filter(v => Number.isFinite(v) && v > 1).sort((a,b)=>a-b)[0] || 0;
  const maxTs = (...values) => Math.max(0, ...values.map(v => Number(v || 0) || 0));
  const rawUnreadCount = Math.max(0, Number(primary.unreadCount || 0) || 0, Number(alias.unreadCount || 0) || 0);
  const lastIncomingAt = maxTs(primary.lastIncomingAt, alias.lastIncomingAt);
  const lastReplyAt = maxTs(primary.lastReplyAt, alias.lastReplyAt);
  const manualReadAt = Math.max(0, Number(primary.manualReadAt || 0) || 0, Number(alias.manualReadAt || 0) || 0);
  const manualReadIncomingAt = Math.max(0, Number(primary.manualReadIncomingAt || 0) || 0, Number(alias.manualReadIncomingAt || 0) || 0);
  // V1.27.19: Meta can keep a stale native unread badge on an alias after the
  // operator manually closes the round.  Never OR that stale alias back into
  // awaitingReply.  A genuinely newer customer turn is identified by a newer
  // incoming boundary and is allowed to reopen the round.
  const manualReadCovers = manualReadAt > 0 && (manualReadIncomingAt <= 0 || lastIncomingAt <= manualReadIncomingAt);
  const unreadCount = manualReadCovers ? 0 : rawUnreadCount;
  const name = clean(primary.displayName || primary.name || alias.displayName || alias.name, 180);
  // Preserve the pre-hydration name:* UI key when a durable thread id later
  // appears. This is what keeps the selected aggregate card stable.
  const uiKey = clean(alias.aggregateUiKey || primary.aggregateUiKey, 520) || metaBusinessUiKey(alias) || metaBusinessUiKey(primary);
  const primarySnapshotAt=Math.max(0,Number(primary.nativeSnapshotAt||0)||0);
  const aliasSnapshotAt=Math.max(0,Number(alias.nativeSnapshotAt||0)||0);
  // With V1.27.30 metadata the newest coherent snapshot wins. For legacy rows
  // that have no snapshot timestamp at all, retain the historical alias geometry
  // so identity hydration itself still does not invent a reorder event; in other
  // words, identity hydration must not become a reorder event by itself.
  const nativeGeometrySource=(primarySnapshotAt||aliasSnapshotAt) ? (primarySnapshotAt>=aliasSnapshotAt?primary:alias) : alias;
  return {
    ...alias,
    ...primary,
    chatId: canonical || clean(primary.chatId || alias.chatId, 500) || `name:${name}`,
    aggregateUiKey: uiKey,
    href: clean(primary.href || alias.href, 1800),
    displayName: name,
    handle: clean(primary.handle || alias.handle, 180).replace(/^@+/, ''),
    avatarUrl: clean(primary.avatarUrl || alias.avatarUrl, 2600),
    preview: clean(primary.preview || primary.lastMessage || alias.preview || alias.lastMessage, 900),
    lastMessage: clean(primary.lastMessage || primary.preview || alias.lastMessage || alias.preview, 900),
    unreadCount,
    awaitingReply: manualReadCovers ? false : (primary.awaitingReply === true || alias.awaitingReply === true || unreadCount > 0 || lastIncomingAt > lastReplyAt),
    lastIncomingAt,
    lastReplyAt,
    manualReadAt,
    manualReadIncomingAt,
    manualReadSnapshotSignature:clean(primary.manualReadSnapshotSignature || alias.manualReadSnapshotSignature, 180),
    manualReadPreview:clean(primary.manualReadPreview || alias.manualReadPreview, 900),
    manualReadLastMessageAt:clean(primary.manualReadLastMessageAt || alias.manualReadLastMessageAt, 160),
    manualReadNativeUnreadCount:Math.max(0, Number(primary.manualReadNativeUnreadCount || 0) || 0, Number(alias.manualReadNativeUnreadCount || 0) || 0),
    firstSeenAt: firstPositive(primary.firstSeenAt, alias.firstSeenAt) || 1,
    firstMessageAt: firstPositive(primary.firstMessageAt, alias.firstMessageAt),
    newCustomerAt: firstPositive(primary.newCustomerAt, alias.newCustomerAt) || (Number(primary.newCustomerAt || alias.newCustomerAt || 0) === 1 ? 1 : 0),
    leadFunnelAt: firstPositive(primary.leadFunnelAt, alias.leadFunnelAt),
    leadFunnelTracked: primary.leadFunnelTracked === true || alias.leadFunnelTracked === true,
    // V1.27.15: aggregateDisplayOrder is the persistent Yoko sidebar slot.
    // It is independent from Meta's virtual-list geometry/order and therefore
    // survives clicks, unread changes and name:* -> mb-thread:* hydration.
    aggregateDisplayOrder: firstPositive(alias.aggregateDisplayOrder, primary.aggregateDisplayOrder),
    // V1.27.16: only a transaction that verified the real MB header/thread may
    // install a durable name<->thread binding. Preserve that proof through alias
    // merges so later passive scans cannot rename/re-key the customer.
    identityVerifiedAt: Math.max(0, Number(primary.identityVerifiedAt || 0) || 0, Number(alias.identityVerifiedAt || 0) || 0),
    identityVerifiedName: clean(
      (Number(primary.identityVerifiedAt || 0) >= Number(alias.identityVerifiedAt || 0) ? primary.identityVerifiedName : alias.identityVerifiedName) ||
      primary.identityVerifiedName || alias.identityVerifiedName,
      180
    ),
    identityVerifiedChatId: clean(
      (Number(primary.identityVerifiedAt || 0) >= Number(alias.identityVerifiedAt || 0) ? primary.identityVerifiedChatId : alias.identityVerifiedChatId) ||
      primary.identityVerifiedChatId || alias.identityVerifiedChatId,
      500
    ),
    identityQuarantinedChatId: clean(primary.identityQuarantinedChatId || alias.identityQuarantinedChatId, 500),
    lastDirection:lastIncomingAt > lastReplyAt ? 'customer' : (lastReplyAt > lastIncomingAt ? 'me' : clean(primary.lastDirection || alias.lastDirection, 20)),
    // V1.27.30: identity aliases may carry geometry from different native
    // snapshots.  Never let an older name:* alias overwrite the visual rank
    // that was just observed for the durable row.  The newest snapshot wins;
    // V1.27.29's old `alias.nativeOffset` preference was one reason the Yoko
    // sidebar could appear in the reverse/stale order even though preload had
    // already captured the correct Meta list.
    nativeSnapshotRank: (() => { const n=Number(nativeGeometrySource.nativeSnapshotRank); return Number.isFinite(n)&&n>=0?n:null; })(),
    nativeSnapshotAt: Math.max(primarySnapshotAt,aliasSnapshotAt),
    nativeTopSnapshotAt: Math.max(0,Number(nativeGeometrySource.nativeTopSnapshotAt||0)||0),
    nativeVisualTop: Number(nativeGeometrySource.nativeVisualTop||0)||0,
    nativeOffset: (() => { const n=Number(nativeGeometrySource.nativeOffset??nativeGeometrySource.order); return Number.isFinite(n)&&n>=0?n:0; })(),
    order: (() => { const n=Number(nativeGeometrySource.order??nativeGeometrySource.nativeOffset); return Number.isFinite(n)&&n>=0?n:0; })()

  };
}

function metaBusinessRowHasVerifiedIdentity(row = {}, canonical = '', name = '') {
  const verifiedAt = Math.max(0, Number(row?.identityVerifiedAt || 0) || 0);
  const verifiedCanonical = metaBusinessCanonicalChatId(row?.identityVerifiedChatId || '');
  const verifiedName = clean(row?.identityVerifiedName, 180).toLocaleLowerCase();
  const observedCanonical = canonical || metaBusinessCanonicalChatId(row?.chatId || row?.href || '');
  const observedName = clean(name || row?.displayName || row?.name, 180).toLocaleLowerCase();
  return verifiedAt > 0 && !!verifiedCanonical && !!verifiedName &&
    verifiedCanonical.toLowerCase() === String(observedCanonical || '').toLowerCase() &&
    verifiedName === observedName;
}

function dedupeMetaBusinessConversations(rows = []) {
  const input = (Array.isArray(rows) ? rows : []).filter(raw => raw && typeof raw === 'object');

  // V1.27.16 identity quarantine: a healthy durable mb-thread may belong to one
  // name only. If the same thread is observed with multiple distinct customer
  // names (the real-world V1.27.14/15 corruption), that thread is treated as
  // contaminated. Unverified rows are downgraded to name:* identities instead
  // of being merged together. A row that was explicitly verified by the
  // deterministic aggregate-open transaction may keep the durable thread id.
  const strongNames = new Map();
  const historicallyQuarantined = new Set(input.map(raw => metaBusinessCanonicalChatId(raw?.identityQuarantinedChatId || '')).filter(Boolean).map(v=>v.toLowerCase()));
  for (const raw of input) {
    const name = clean(raw.displayName || raw.name, 180);
    const preview = clean(raw.preview || raw.lastMessage, 900);
    if (!metaBusinessPlausibleCustomerName(name) || metaBusinessSystemOrAdText(preview)) continue;
    const canonical = metaBusinessCanonicalChatId(raw.chatId || raw.href || '');
    if (!canonical) continue;
    const key = canonical.toLowerCase();
    if (!strongNames.has(key)) strongNames.set(key, new Set());
    strongNames.get(key).add(name.toLocaleLowerCase());
  }

  const out = [];
  const byIdentity = new Map();
  for (const raw of input) {
    const name = clean(raw.displayName || raw.name, 180);
    const preview = clean(raw.preview || raw.lastMessage, 900);
    if (!metaBusinessPlausibleCustomerName(name) || metaBusinessSystemOrAdText(preview)) continue;
    const canonical = metaBusinessCanonicalChatId(raw.chatId || raw.href || '');
    const contaminated = !!canonical && (((strongNames.get(canonical.toLowerCase())?.size || 0) > 1) || historicallyQuarantined.has(canonical.toLowerCase()));
    const verified = !!canonical && metaBusinessRowHasVerifiedIdentity(raw, canonical, name);
    const safeCanonical = canonical && (!contaminated || verified) ? canonical : '';
    const row = {
      ...raw,
      displayName:name,
      chatId:safeCanonical || (/^name:/i.test(String(raw.chatId || '')) ? clean(raw.chatId,500) : `name:${name}`),
      aggregateUiKey:clean(raw.aggregateUiKey,520) || `mb-ui:name:${name.toLocaleLowerCase()}`,
      identityQuarantinedChatId:contaminated && !verified ? canonical : clean(raw.identityQuarantinedChatId,500)
    };
    const key = metaBusinessConversationIdentity(row);
    if (!key) continue;
    const index = byIdentity.get(key);
    if (index === undefined) {
      byIdentity.set(key, out.length);
      out.push(row);
    } else {
      out[index] = mergeMetaBusinessConversationRows(row, out[index]);
    }
  }

  // Alias upgrade: merge a name-only alias into a durable row only when the
  // normalized name maps to exactly one durable row. Contaminated thread/name
  // pairs above have already been quarantined, so this cannot cross-bind names.
  const groups = new Map();
  out.forEach((row,index) => {
    const name = clean(row.displayName,180).toLocaleLowerCase();
    if (!name) return;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({ index, row, strong:!!metaBusinessCanonicalChatId(row.chatId || row.href || '') });
  });
  const removed = new Set();
  for (const entries of groups.values()) {
    const strong = entries.filter(entry => entry.strong);
    const weak = entries.filter(entry => !entry.strong);
    if (strong.length !== 1 || !weak.length) continue;
    let merged = strong[0].row;
    for (const alias of weak) {
      merged = mergeMetaBusinessConversationRows(merged, alias.row);
      removed.add(alias.index);
    }
    out[strong[0].index] = merged;
  }
  let compact = out.filter((_,index) => !removed.has(index));

  // V1.27.12 compatibility: exact same normalized name AND exact same non-placeholder
  // avatar is a strict alias signal.
  // signal. This keeps the V1.27.12 hydration cleanup while never merging the
  // different-name contamination case that caused sidebar jumps.
  const avatarGroups = new Map();
  const avatarBase = value => {
    const v=String(value || '').trim().split('?')[0].toLowerCase();
    return !v || /(?:default|placeholder|anonymous|profile[_-]?pic[_-]?default)/i.test(v) ? '' : v;
  };
  compact.forEach((row,index) => {
    const name=clean(row.displayName,180).toLocaleLowerCase();
    const avatar=avatarBase(row.avatarUrl);
    if (!name || !avatar) return;
    const key=`${name}|${avatar}`;
    if (!avatarGroups.has(key)) avatarGroups.set(key,[]);
    avatarGroups.get(key).push({index,row});
  });
  const avatarRemoved = new Set();
  for (const entries of avatarGroups.values()) {
    if (entries.length < 2) continue;
    entries.sort((a,b) => Number(!!metaBusinessCanonicalChatId(b.row.chatId || b.row.href || '')) - Number(!!metaBusinessCanonicalChatId(a.row.chatId || a.row.href || '')));
    let merged=entries[0].row;
    for (const entry of entries.slice(1)) { merged=mergeMetaBusinessConversationRows(merged,entry.row); avatarRemoved.add(entry.index); }
    compact[entries[0].index]=merged;
  }
  return compact.filter((_,index) => !avatarRemoved.has(index));
}

// V1.27.6: deterministic MB inbox model.  The old V1.27.5 document-wide div
// fallback could promote navigation tabs and chat-message wrappers into fake
// customers.  This scanner first finds the real search/list column and then only
// accepts row-sized wrappers inside that column.
function metaBusinessConversationScanScript(options = {}) {
  const deepHarvest = options?.deepHarvest === true;
  return `(async() => {
    const DEEP=${deepHarvest ? 'true' : 'false'};
    const clean=v=>String(v||'').replace(/\\s+/g,' ').trim();
    const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const visible=el=>{try{if(!el||!(el instanceof Element))return false;const r=el.getBoundingClientRect(),c=getComputedStyle(el);return r.width>2&&r.height>2&&c.display!=='none'&&c.visibility!=='hidden'&&Number(c.opacity||1)>0}catch{return false}};
    const adText=t=>/(?:这个聊天包含对以下广告的回复|此聊天包含.*广告.*回复|包含对以下广告|查看广告|查看廣告|广告回复|廣告回覆|创建消息类广告|建立訊息廣告|Sponsored|ad reply|replied to (?:your |an )?ad|responded to (?:your |an )?ad)/i.test(clean(t));
    const excluded=new Set(['Facebook','Messenger','Meta Business Suite','Meta Business','收件箱','所有消息','Instagram','WhatsApp','Facebook评论','Facebook 评论','Instagram评论','Instagram 评论','搜索','管理','未读','优先级','广告回复','后续跟进','在线','Inbox','All messages','Search','Manage','复制','複製','Copy','查看联系方式','查看聯絡方式','分配这个对话','分配此對話']);
    const isTime=t=>/^(?:\\d{1,2}:\\d{2}|今天|今日|昨天|昨日|Today|Yesterday|周[一二三四五六日天](?:\\s*\\d{1,2}:\\d{2})?|星期[一二三四五六日天]|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?|\\d+\\s*(?:分钟|分鐘|分钟前|分前|小时|小時|小时前|minutes?|mins?|hours?|hrs?))/i.test(clean(t));
    const plausibleName=t=>{const v=clean(t);if(!v||v.length>140||excluded.has(v)||isTime(v)||adText(v))return false;if(/^(?:https?:\\/\\/|www\\.|line\\.me\\/)/i.test(v)||/^(?:你|您|You)\\s*[:：]/i.test(v)||/(?:^|\\s)(?:复制|複製|Copy)(?:\\s|$)/i.test(v)||/^(?:Instagram|Facebook)\\s*(?:评论|評論|评论区|評論區|コメント|Comments?)/i.test(v))return false;return true};
    const ownPreview=t=>{const v=clean(t);return /^(?:你|您|You|あなた)\s*[:：]/iu.test(v)||/^(?:你|您)\s*(?:发送了|發送了|传送了|傳送了|已发送|已發送|回复了|回覆了)/u.test(v)||/^You\s+(?:sent|replied|shared|responded)\b/iu.test(v)||/^(?:(?:あなた|自分)が\s*)?(?:送信しました|送信した|返信しました|返信した|送った|送りました)(?:[：:\s]|$)/u.test(v)};
    const strongToken=value=>{try{const u=new URL(String(value||''),location.href);for(const k of ['selected_item_id','selected_thread_id','thread_id','conversation_id','conversationId','threadId','item_id']){const v=clean(u.searchParams.get(k));if(v)return v}const m=(u.pathname||'').match(/\\/(?:conversation|thread|message-thread)\\/([^/?#]+)/i);if(m&&m[1])return decodeURIComponent(m[1])}catch{}return ''};
    const composers=Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"],textarea,[aria-label*="message" i],[aria-label*="消息"],[aria-label*="回复"],[aria-label*="回覆"]')).filter(visible).filter(el=>{const r=el.getBoundingClientRect();return r.bottom>innerHeight*.55&&r.left>innerWidth*.24&&r.width>120});
    const composer=composers.sort((a,b)=>b.getBoundingClientRect().bottom-a.getBoundingClientRect().bottom)[0]||null,cr=composer?.getBoundingClientRect?.();
    const chatLeft=cr&&cr.left>innerWidth*.24?cr.left:innerWidth*.56;
    const searches=Array.from(document.querySelectorAll('input,[role="searchbox"],[aria-label*="搜索"],[placeholder*="搜索"],[placeholder*="Search" i]')).filter(visible).filter(el=>{const r=el.getBoundingClientRect();return r.left<chatLeft-100&&r.right<chatLeft+12&&r.width>140&&r.top>35&&r.top<360});
    const search=searches.sort((a,b)=>b.getBoundingClientRect().width-a.getBoundingClientRect().width||a.getBoundingClientRect().top-b.getBoundingClientRect().top)[0]||null,sr=search?.getBoundingClientRect?.();
    const listRight=chatLeft-5,listLeft=sr?Math.max(0,sr.left-24):Math.max(0,listRight-Math.min(430,innerWidth*.36)),listWidth=Math.max(220,listRight-listLeft),topLimit=sr?sr.bottom+38:Math.max(90,innerHeight*.12);
    // V1.27.11: do not trust the first geometry-matching scrollable div. Meta
    // often nests a short-lived inner scroller inside the real virtual inbox. A
    // wrong root exposes only the first ~8-12 rows even though the native inbox
    // contains many more. Score candidates by BOTH lane geometry and how many
    // row-like avatar/time seeds they actually contain, then prefer the deepest
    // useful scroller when scores are close.
    const rootCandidates=Array.from(document.querySelectorAll('[role="list"],[role="grid"],[role="feed"],div')).filter(visible).map(node=>{const r=node.getBoundingClientRect();let seedCount=0;try{seedCount=Array.from(node.querySelectorAll('img,[role="listitem"],[role="row"]')).filter(visible).filter(seed=>{const q=seed.getBoundingClientRect();return q.left>=listLeft-30&&q.right<=listRight+24&&q.top<innerHeight+80&&q.bottom>topLimit-30}).length}catch{}const depth=(()=>{let d=0,n=node;while(n&&n.parentElement){d++;n=n.parentElement}return d})();const overflow=(()=>{try{return getComputedStyle(node).overflowY||''}catch{return ''}})();return {node,r,seedCount,depth,overflow}}).filter(x=>x.r.left>=listLeft-32&&x.r.right<=listRight+26&&x.r.width>=listWidth*.66&&x.r.height>=180&&x.r.bottom>topLimit+140&&x.node.scrollHeight>x.node.clientHeight+18).sort((a,b)=>{const score=x=>x.seedCount*44+(x.overflow==='auto'||x.overflow==='scroll'?28:0)+Math.min(80,Math.max(0,(x.node.scrollHeight-x.node.clientHeight)/12))-Math.abs(x.r.right-listRight)*1.15-Math.abs(x.r.left-listLeft)*.85-Math.abs(x.r.top-topLimit)*.16+x.depth*.08;return score(b)-score(a)});
    const listRoot=rootCandidates[0]?.node||null,lr=listRoot?.getBoundingClientRect?.();
    const inLane=n=>{const r=n.getBoundingClientRect();if(r.left<listLeft-28||r.right>listRight+22||r.width<listWidth*.58||r.width>listWidth*1.10||r.height<43||r.height>128)return false;if(listRoot&&!listRoot.contains(n))return false;if(!listRoot&&(r.bottom<topLimit-12||r.top>innerHeight+800))return false;return true};
    const rowShape=n=>{if(!(n instanceof Element)||!visible(n)||!inLane(n))return false;const raw=String(n.innerText||'').trim();if(!raw||raw.length>1000||adText(raw))return false;const lines=raw.split(/\\n+/).map(clean).filter(Boolean);if(!lines.length||lines.length>10||!lines.some(plausibleName))return false;const avatar=Array.from(n.querySelectorAll('img')).some(img=>{if(!visible(img))return false;const r=img.getBoundingClientRect();return r.width>=20&&r.width<=88&&r.height>=20&&r.height<=88});const time=lines.some(isTime);return avatar||time||n.matches('[role="listitem"],[role="row"]')};
    const score=n=>{const r=n.getBoundingClientRect(),lines=String(n.innerText||'').split(/\\n+/).map(clean).filter(Boolean);let s=0;s+=Math.max(0,90-Math.abs(r.width-listWidth)*.35);s+=Math.max(0,45-Math.abs(r.height-72)*.7);if(n.matches('[role="listitem"],[role="row"]'))s+=38;if(lines.some(isTime))s+=22;if(n.querySelector('img'))s+=18;return s};
    const rowFor=seed=>{let n=seed,best=null;for(let i=0;n&&i<9;i++,n=n.parentElement){if(listRoot&&n===listRoot)break;if(!rowShape(n))continue;const s=score(n);if(!best||s>best.s)best={node:n,s}}return best?.node||null};
    const parse=row=>{const r=row.getBoundingClientRect(),lines=String(row.innerText||'').split(/\\n+/).map(clean).filter(Boolean);const name=lines.find(plausibleName)||'';if(!name)return null;const timeText=lines.find((x,i)=>i>0&&isTime(x))||'';const handle=(lines.find(x=>/^@[A-Za-z0-9_.-]{2,}$/.test(x))||'').replace(/^@/,'');const preview=lines.find((x,i)=>i>0&&x!==name&&x!==timeText&&x!==('@'+handle)&&!excluded.has(x)&&!isTime(x)&&!adText(x)&&!/^已读$|^已讀$|^Read$/i.test(x)&&x.length<=650)||'';let href='',token='';for(const a of row.querySelectorAll('a[href]')){const h=String(a.getAttribute('href')||a.href||'');const t=strongToken(h);if(t){href=h;token=t;break}if(!href)href=h}const img=Array.from(row.querySelectorAll('img')).filter(visible).sort((a,b)=>{const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();return Math.abs(ar.width-ar.height)-Math.abs(br.width-br.height)})[0]||null;const avatarUrl=String(img?.currentSrc||img?.src||'').trim();let unreadCount=0;const badge=row.querySelector('[aria-label*="unread" i],[aria-label*="未读"],[aria-label*="未讀"],[data-testid*="unread" i],[class*="unread" i],[class*="badge" i]');if(badge){const n=parseInt(clean(badge.textContent),10);unreadCount=Number.isFinite(n)?Math.max(1,n):1}const nativeOffset=listRoot&&lr?Math.max(0,Math.round((r.top-lr.top)+Number(listRoot.scrollTop||0))):Math.max(0,Math.round(r.top-topLimit));const lastDirection=preview?(ownPreview(preview)?'me':'customer'):'';return {chatId:token?'mb-thread:'+token:'',name,handle,avatarUrl,preview,timeText,lastDirection,unreadCount,href,top:Math.round(r.top),nativeOffset,order:nativeOffset}};
    const harvest=new Map();
    const rowKey=d=>{const direct=clean(d.chatId||'').replace(/^mb-thread:/i,'');const token=direct||strongToken(d.href||'');if(token)return 'thread:'+token;const avatar=String(d.avatarUrl||'').split('?')[0].toLowerCase();return 'name:'+String(d.name||'').toLocaleLowerCase()+'|avatar:'+avatar};
    const mergeHarvest=d=>{if(!d||!plausibleName(d.name))return;const key=rowKey(d);const old=harvest.get(key);if(!old){harvest.set(key,d);return}harvest.set(key,{...old,...d,preview:d.preview||old.preview,lastDirection:d.preview?(d.lastDirection||old.lastDirection):old.lastDirection,avatarUrl:d.avatarUrl||old.avatarUrl,href:d.href||old.href,chatId:d.chatId||old.chatId,unreadCount:Math.max(Number(old.unreadCount||0),Number(d.unreadCount||0)),nativeOffset:Math.min(Number(old.nativeOffset||0),Number(d.nativeOffset||0)),order:Math.min(Number(old.order||0),Number(d.order||0))})};
    const collectCurrentRows=()=>{const scope=listRoot||document,seedSelector='[role="listitem"],[role="row"],[role="button"],button,a[href],img,[tabindex]';const seeds=Array.from(scope.querySelectorAll(seedSelector));const candidates=[],seenNodes=new Set();for(const seed of seeds){if(!visible(seed))continue;const row=rowFor(seed);if(row&&!seenNodes.has(row)){seenNodes.add(row);candidates.push(row)}}if(listRoot){for(const node of listRoot.querySelectorAll('div,li')){if(seenNodes.has(node)||!rowShape(node))continue;seenNodes.add(node);candidates.push(node)}}const parsed=candidates.map(row=>({row,data:parse(row),s:score(row)})).filter(x=>x.data).sort((a,b)=>a.data.nativeOffset-b.data.nativeOffset||b.s-a.s);const pageRows=[],seenBand=[];for(const item of parsed){const d=item.data;const same=seenBand.find(x=>Math.abs(x.nativeOffset-d.nativeOffset)<=8);if(same)continue;seenBand.push(d);pageRows.push(d);mergeHarvest(d)}return pageRows};
    collectCurrentRows();
    const originalScroll=listRoot?Number(listRoot.scrollTop||0):0;
    const totalScrollHeight=listRoot?Number(listRoot.scrollHeight||0):0,viewportHeight=listRoot?Number(listRoot.clientHeight||0):0;
    let deepHarvested=false;
    // V1.27.10: Meta virtualizes the inbox. On an occasional deep pass, walk
    // the native list page-by-page, collect every rendered customer, then restore
    // the exact original scroll offset. Main throttles this pass so the list does
    // not continuously jump every 8-second aggregate refresh.
    if(DEEP&&listRoot&&totalScrollHeight>viewportHeight+40){
      const oldBehavior=listRoot.style.scrollBehavior;try{listRoot.style.scrollBehavior='auto'}catch{}
      // V1.27.12 foreground safety: a deep pass is only started by an explicit
      // manual refresh. If the operator touches the mouse/wheel/keyboard while
      // it is running, abort immediately and never restore over their position.
      let userInterrupted=false;
      const interrupt=()=>{userInterrupted=true};
      const interruptEvents=['wheel','pointerdown','touchstart','keydown'];
      for(const type of interruptEvents)window.addEventListener(type,interrupt,true);
      const waitForVirtualSwap=async(beforeSig,beforeHeight)=>{let stable=0,lastSig=beforeSig,lastHeight=beforeHeight;for(let i=0;i<9&&!userInterrupted;i++){await sleep(i<2?90:135);const page=collectCurrentRows();const sig=page.map(x=>String(x.chatId||x.name||'')+'@'+String(x.nativeOffset||0)).join('|');const h=Number(listRoot.scrollHeight||0);if(sig!==lastSig||h!==lastHeight){lastSig=sig;lastHeight=h;stable=0}else stable++;if(stable>=2)break}return {sig:lastSig,height:lastHeight}};
      let passes=0,noGrowthRounds=0,lastHarvestSize=harvest.size,lastHeight=Number(listRoot.scrollHeight||0),lastTop=-1;
      // Start from the very top so customers above the operator's current native
      // position are not missed, then chase the moving bottom. scrollHeight is
      // intentionally re-read after EVERY step because Meta may append another
      // virtual page only after the previous bottom is reached.
      try{listRoot.scrollTop=0;listRoot.dispatchEvent(new Event('scroll',{bubbles:true}))}catch{}
      await waitForVirtualSwap('',lastHeight);
      collectCurrentRows();
      while(passes<96&&noGrowthRounds<4&&!userInterrupted){
        passes++;
        const vh=Math.max(120,Number(listRoot.clientHeight||viewportHeight||0));
        const heightBefore=Math.max(vh,Number(listRoot.scrollHeight||0));
        const maxBefore=Math.max(0,heightBefore-vh);
        const current=Math.max(0,Number(listRoot.scrollTop||0));
        const step=Math.max(180,Math.floor(vh*.78));
        let target=Math.min(maxBefore,current+step);
        if(maxBefore-current<Math.max(72,step*.36))target=maxBefore;
        const beforePage=collectCurrentRows();
        const beforeSig=beforePage.map(x=>String(x.chatId||x.name||'')+'@'+String(x.nativeOffset||0)).join('|');
        if(Math.abs(target-current)>2){try{listRoot.scrollTop=target;listRoot.dispatchEvent(new Event('scroll',{bubbles:true}))}catch{}}
        const settled=await waitForVirtualSwap(beforeSig,heightBefore);
        collectCurrentRows();
        const heightAfter=Math.max(vh,Number(listRoot.scrollHeight||0));
        const topAfter=Math.max(0,Number(listRoot.scrollTop||0));
        const harvestGrew=harvest.size>lastHarvestSize;
        const heightGrew=heightAfter>lastHeight+8;
        const moved=Math.abs(topAfter-lastTop)>2;
        const atBottom=topAfter>=Math.max(0,heightAfter-vh)-6;
        if(harvestGrew||heightGrew){noGrowthRounds=0}else if(atBottom||!moved)noGrowthRounds++;else noGrowthRounds=Math.max(0,noGrowthRounds-1);
        lastHarvestSize=harvest.size;lastHeight=heightAfter;lastTop=topAfter;
        // At the apparent bottom Meta may still be fetching another page. Give
        // it a longer chance, and if scrollHeight grows the next iteration will
        // continue into that new range instead of stopping at the old bottom.
        if(atBottom&&!harvestGrew&&!heightGrew){await sleep(320);collectCurrentRows();const lateHeight=Number(listRoot.scrollHeight||0);if(harvest.size>lastHarvestSize||lateHeight>lastHeight+8){noGrowthRounds=0;lastHarvestSize=harvest.size;lastHeight=lateHeight}}
        if(settled.height>lastHeight)lastHeight=settled.height;
      }
      if(!userInterrupted&&Math.abs(Number(listRoot.scrollTop||0)-originalScroll)>3){try{listRoot.scrollTop=Math.min(originalScroll,Math.max(0,Number(listRoot.scrollHeight||0)-Number(listRoot.clientHeight||0)));listRoot.dispatchEvent(new Event('scroll',{bubbles:true}))}catch{}await sleep(100)}
      collectCurrentRows();
      for(const type of interruptEvents)window.removeEventListener(type,interrupt,true);
      try{listRoot.style.scrollBehavior=oldBehavior}catch{}
      deepHarvested=!userInterrupted;
    }
    const rows=Array.from(harvest.values()).sort((a,b)=>Number(a.nativeOffset||0)-Number(b.nativeOffset||0));
    const currentToken=strongToken(location.href);let selectedRow=null;const scope=listRoot||document;
    for(const el of scope.querySelectorAll('[aria-selected="true"],[aria-current="true"],[data-state="selected"],[data-state="active"]')){const row=rowFor(el);if(row){selectedRow=row;break}}
    const selectedData=selectedRow?parse(selectedRow):null;
    let headerName='',headerAvatar='';const headerTop=sr?Math.max(30,sr.top-35):35,headerBottom=Math.min(topLimit+35,280),chatWidth=Math.max(260,innerWidth-chatLeft);
    const headerImgs=Array.from(document.querySelectorAll('img')).filter(visible).filter(img=>{const r=img.getBoundingClientRect();return r.left>=chatLeft+6&&r.left<chatLeft+Math.min(180,chatWidth*.42)&&r.top>=headerTop&&r.bottom<=headerBottom&&r.width>=24&&r.width<=86&&r.height>=24&&r.height<=86}).sort((a,b)=>a.getBoundingClientRect().left-b.getBoundingClientRect().left||a.getBoundingClientRect().top-b.getBoundingClientRect().top);
    const hi=headerImgs[0]||null;if(hi){headerAvatar=String(hi.currentSrc||hi.src||'').trim();let root=hi.parentElement;for(let depth=0;root&&depth<6;depth++,root=root.parentElement){const rr=root.getBoundingClientRect();if(rr.left<chatLeft-8||rr.right>innerWidth+8||rr.height>155)continue;const texts=Array.from(root.querySelectorAll('strong,h1,h2,h3,span,[dir="auto"]')).filter(visible).map(n=>({t:clean(n.textContent||''),r:n.getBoundingClientRect()})).filter(x=>x.r.top>=headerTop&&x.r.bottom<=headerBottom+12&&x.r.left>hi.getBoundingClientRect().right-8&&plausibleName(x.t));if(texts.length){headerName=texts.sort((a,b)=>a.r.top-b.r.top||a.r.left-b.r.left)[0].t;break}}}
    if(!headerName&&selectedData)headerName=selectedData.name;
    if(!headerName&&currentToken){const hit=rows.find(x=>x.chatId==='mb-thread:'+currentToken);if(hit){headerName=hit.name;headerAvatar=headerAvatar||hit.avatarUrl}}
    return {rows:rows.slice(0,800),selected:{chatId:currentToken?'mb-thread:'+currentToken:(selectedData?.chatId||''),name:headerName||(selectedData?.name||''),handle:selectedData?.handle||'',avatarUrl:headerAvatar||(selectedData?.avatarUrl||'')},url:location.href,chatLeft,listLeft,listRight,listTop:topLimit,rowCount:rows.length,hasListRoot:!!listRoot,deepHarvested,totalScrollHeight,viewportHeight,originalScroll};
  })()`;
}

function metaBusinessCurrentChatScript() {
  return `(() => {
    const clean=v=>String(v||'').replace(/\\s+/g,' ').trim();
    const visible=el=>{try{if(!el||!(el instanceof Element))return false;const r=el.getBoundingClientRect(),c=getComputedStyle(el);return r.width>2&&r.height>2&&c.display!=='none'&&c.visibility!=='hidden'&&Number(c.opacity||1)>0}catch{return false}};
    const excluded=new Set(['Facebook','Messenger','Meta Business Suite','Meta Business','收件箱','所有消息','Instagram','WhatsApp','Facebook评论','Facebook 评论','Instagram评论','Instagram 评论','搜索','管理','未读','优先级','广告回复','后续跟进','在线','Inbox','All messages','Search','Manage','复制','複製','Copy','查看联系方式','查看聯絡方式','分配这个对话','分配此對話']);
    const bad=t=>{const v=clean(t);return !v||v.length>140||excluded.has(v)||/^(?:https?:\\/\\/|www\\.|line\\.me\\/)/i.test(v)||/^(?:你|您|You)\\s*[:：]/i.test(v)||/(?:^|\\s)(?:复制|複製|Copy)(?:\\s|$)/i.test(v)||/^(?:Instagram|Facebook)\\s*(?:评论|評論|评论区|評論區|コメント|Comments?)/i.test(v)||/(?:这个聊天包含对以下广告的回复|查看广告|Sponsored|ad reply)/i.test(v)};
    const headerBad=t=>{const v=clean(t);return bad(v)||(v.length>72)||(/[。！？!?]/u.test(v)&&v.length>8)||(v.length>9&&/(?:です|ます|ですよ|ですね|だよ|だね|でした|ました|ません|でしょう|ください|ありがとう(?:ございます)?|おはようございます|よろしく(?:お願い)?します)[〜~ー…\\s]*$/u.test(v))||(v.length>10&&/^(?:俺|私|僕|わたし|あなた|優子|Yoko).{3,}(?:です|ます|ですよ|ですね|だよ|だね)$/iu.test(v))};
    const strongToken=value=>{try{const u=new URL(String(value||''),location.href);for(const k of ['selected_item_id','selected_thread_id','thread_id','conversation_id','conversationId','threadId','item_id']){const v=clean(u.searchParams.get(k));if(v)return v}const m=(u.pathname||'').match(/\\/(?:conversation|thread|message-thread)\\/([^/?#]+)/i);if(m&&m[1])return decodeURIComponent(m[1])}catch{}return ''};
    const composers=Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"],textarea,[aria-label*="message" i],[aria-label*="消息"],[aria-label*="回复"],[aria-label*="回覆"]')).filter(visible).filter(el=>{const r=el.getBoundingClientRect();return r.bottom>innerHeight*.55&&r.left>innerWidth*.28&&r.width>120});const composer=composers.sort((a,b)=>b.getBoundingClientRect().bottom-a.getBoundingClientRect().bottom)[0]||null,cr=composer?.getBoundingClientRect?.(),chatLeft=cr&&cr.left>innerWidth*.28?cr.left:innerWidth*.56;
    const searches=Array.from(document.querySelectorAll('input,[role="searchbox"],[aria-label*="搜索"],[placeholder*="搜索"],[placeholder*="Search" i]')).filter(visible).filter(el=>{const r=el.getBoundingClientRect();return r.left<chatLeft-100&&r.right<chatLeft+12&&r.width>140&&r.top>35&&r.top<360});const search=searches.sort((a,b)=>b.getBoundingClientRect().width-a.getBoundingClientRect().width)[0]||null,sr=search?.getBoundingClientRect?.();
    const listRight=chatLeft-5,listLeft=sr?Math.max(0,sr.left-24):Math.max(0,listRight-Math.min(430,innerWidth*.36)),listWidth=Math.max(220,listRight-listLeft),topLimit=sr?sr.bottom+38:Math.max(90,innerHeight*.12);
    const rowIdentityFrom=seed=>{let n=seed;for(let depth=0;n&&depth<9;depth++,n=n.parentElement){if(!(n instanceof Element)||!visible(n))continue;const r=n.getBoundingClientRect();if(r.left<listLeft-40||r.right>listRight+40||r.width<listWidth*.42||r.width>listWidth*1.28||r.height<34||r.height>158)continue;const parts=Array.from(n.querySelectorAll('strong,[dir="auto"],span,a')).filter(visible).map(el=>({t:clean(el.textContent||''),r:el.getBoundingClientRect(),el})).filter(x=>x.t&&!bad(x.t)&&x.r.top>=r.top-2&&x.r.bottom<=r.bottom+2&&x.r.left>=r.left-2&&x.r.right<=r.right+4).sort((a,b)=>a.r.top-b.r.top||a.r.left-b.r.left);const name=parts[0]?.t||String(n.innerText||'').split(/\\n+/).map(clean).find(v=>!bad(v))||'';if(name)return {name,row:n}}return null};
    let selectedRowName='';
    const selectedEls=Array.from(document.querySelectorAll('[aria-selected="true"],[aria-current="true"],[data-state="selected"],[data-state="active"]')).filter(visible);
    for(const el of selectedEls){const hit=rowIdentityFrom(el);if(hit){selectedRowName=hit.name;break}}
    if(!selectedRowName&&document.activeElement instanceof Element){const hit=rowIdentityFrom(document.activeElement);if(hit)selectedRowName=hit.name}
    const headerTop=sr?Math.max(30,sr.top-35):35,headerBottom=sr?Math.min(sr.bottom+78,285):210,chatWidth=Math.max(260,innerWidth-chatLeft);
    let headerName='',avatarUrl='';
    const imgs=Array.from(document.querySelectorAll('img')).filter(visible).filter(img=>{const r=img.getBoundingClientRect();return r.left>=chatLeft+6&&r.left<chatLeft+Math.min(180,chatWidth*.42)&&r.top>=headerTop&&r.bottom<=headerBottom&&r.width>=24&&r.width<=86&&r.height>=24&&r.height<=86&&!img.closest?.('[data-yoko-global-source]')}).sort((a,b)=>a.getBoundingClientRect().left-b.getBoundingClientRect().left||a.getBoundingClientRect().top-b.getBoundingClientRect().top);
    const avatar=imgs[0]||null;if(avatar){avatarUrl=String(avatar.currentSrc||avatar.src||'').trim();const ar=avatar.getBoundingClientRect();let root=avatar.parentElement;for(let depth=0;root&&depth<7;depth++,root=root.parentElement){const rr=root.getBoundingClientRect();if(rr.left<chatLeft-8||rr.height>160||rr.width>Math.min(760,chatWidth*.85)||root.closest?.('[data-yoko-global-source]'))continue;const texts=Array.from(root.querySelectorAll('strong,h1,h2,h3,span,[dir="auto"]')).filter(visible).map(n=>({t:clean(n.textContent||''),r:n.getBoundingClientRect(),n})).filter(x=>x.r.left>ar.right-10&&x.r.top>=headerTop&&x.r.bottom<=headerBottom+12&&!x.n.closest?.('[data-yoko-global-source]')&&!headerBad(x.t));if(texts.length){headerName=texts.sort((a,b)=>a.r.top-b.r.top||a.r.left-b.r.left)[0].t;break}}}
    if(!headerName){const labels=Array.from(document.querySelectorAll('h1,h2,h3,strong')).filter(visible).map(n=>({t:clean(n.textContent||''),r:n.getBoundingClientRect(),n})).filter(x=>x.r.left>=chatLeft+12&&x.r.left<chatLeft+Math.min(330,chatWidth*.65)&&x.r.top>=headerTop&&x.r.bottom<=headerBottom&&!x.n.closest?.('[data-yoko-global-source]')&&!headerBad(x.t));if(labels.length)headerName=labels.sort((a,b)=>a.r.top-b.r.top||a.r.left-b.r.left)[0].t}
    const name=selectedRowName||headerName||'';
    const nameSource=selectedRowName?'selected-row':(headerName?'header':'');
    const token=strongToken(location.href);return {chatId:token?'mb-thread:'+token:'',name,selectedRowName,handle:'',avatarUrl,url:location.href,chatLeft,headerTop,headerBottom,composerFound:!!composer,conversationShellFound:!!composer||!!name||!!token,nameSource};
  })()`;
}

// V1.27.6 returns native client coordinates. main.js turns them into a real
// WebContents input event (isTrusted), which is substantially more reliable on
// Meta's React inbox than synthetic element.click()/MouseEvent dispatches.
function metaBusinessOpenConversationScript(displayName = '', chatId = '', nativeOffset = 0, requestId = '') {
  const targetName = clean(displayName, 180);
  const targetToken = metaBusinessThreadToken(chatId);
  const targetOffset = Math.max(0, Number(nativeOffset || 0) || 0);
  const openRequestId = clean(requestId, 160);
  return `(async() => {
    const target=${JSON.stringify(targetName)},token=${JSON.stringify(targetToken)},wantedOffset=${JSON.stringify(targetOffset)},requestId=${JSON.stringify(openRequestId)};
    const clean=v=>String(v||'').replace(/\\s+/g,' ').trim();
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const visible=el=>{try{if(!el||!(el instanceof Element))return false;const r=el.getBoundingClientRect(),c=getComputedStyle(el);return r.width>2&&r.height>2&&c.display!=='none'&&c.visibility!=='hidden'&&Number(c.opacity||1)>0}catch{return false}};
    const isTime=t=>/^(?:\\d{1,2}:\\d{2}|今天|今日|昨天|昨日|Today|Yesterday|周[一二三四五六日天]|星期[一二三四五六日天]|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?)/i.test(clean(t));
    const excluded=new Set(['Facebook','Messenger','Meta Business Suite','Meta Business','收件箱','所有消息','Instagram','WhatsApp','Facebook评论','Facebook 评论','Instagram评论','Instagram 评论','搜索','管理','未读','优先级','广告回复','后续跟进','在线','Inbox','All messages','Search','Manage','复制','複製','Copy','查看联系方式','查看聯絡方式','分配这个对话','分配此對話']);
    const plausible=t=>{const v=clean(t);return !!v&&v.length<=140&&!excluded.has(v)&&!isTime(v)&&!/^(?:https?:\\/\\/|www\\.|line\\.me\\/)/i.test(v)&&!/^(?:你|您|You)\\s*[:：]/i.test(v)&&!/(?:^|\\s)(?:复制|複製|Copy)(?:\\s|$)/i.test(v)&&!/^(?:Instagram|Facebook)\\s*(?:评论|評論|评论区|評論區|コメント|Comments?)/i.test(v)};
    const strongToken=value=>{try{const u=new URL(String(value||''),location.href);for(const k of ['selected_item_id','selected_thread_id','thread_id','conversation_id','conversationId','threadId','item_id']){const v=clean(u.searchParams.get(k));if(v)return v}const m=(u.pathname||'').match(/\\/(?:conversation|thread|message-thread)\\/([^/?#]+)/i);if(m&&m[1])return decodeURIComponent(m[1])}catch{}return ''};
    const composers=Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"],textarea,[aria-label*="message" i],[aria-label*="消息"],[aria-label*="回复"],[aria-label*="回覆"]')).filter(visible).filter(el=>{const r=el.getBoundingClientRect();return r.bottom>innerHeight*.55&&r.left>innerWidth*.28&&r.width>120});
    const composer=composers.sort((a,b)=>b.getBoundingClientRect().bottom-a.getBoundingClientRect().bottom)[0]||null,cr=composer?.getBoundingClientRect?.(),chatLeft=cr&&cr.left>innerWidth*.28?cr.left:innerWidth*.56;
    const searches=Array.from(document.querySelectorAll('input,[role="searchbox"],[aria-label*="搜索"],[placeholder*="搜索"],[placeholder*="Search" i]')).filter(visible).filter(el=>{const r=el.getBoundingClientRect();return r.left<chatLeft-100&&r.right<chatLeft+12&&r.width>140&&r.top>35&&r.top<360});
    const search=searches.sort((a,b)=>b.getBoundingClientRect().width-a.getBoundingClientRect().width)[0]||null,sr=search?.getBoundingClientRect?.();
    const listRight=chatLeft-5,listLeft=sr?Math.max(0,sr.left-24):Math.max(0,listRight-Math.min(430,innerWidth*.36)),listWidth=Math.max(220,listRight-listLeft),topLimit=sr?sr.bottom+38:Math.max(90,innerHeight*.12);
    const rootCandidates=Array.from(document.querySelectorAll('[role="list"],[role="grid"],[role="feed"],div')).filter(visible).map(node=>{const r=node.getBoundingClientRect();let seedCount=0;try{seedCount=Array.from(node.querySelectorAll('img,[role="listitem"],[role="row"]')).filter(visible).filter(seed=>{const q=seed.getBoundingClientRect();return q.left>=listLeft-30&&q.right<=listRight+24&&q.bottom>topLimit-30&&q.top<innerHeight+80}).length}catch{}const depth=(()=>{let d=0,n=node;while(n&&n.parentElement){d++;n=n.parentElement}return d})();const overflow=(()=>{try{return getComputedStyle(node).overflowY||''}catch{return ''}})();return {node,r,seedCount,depth,overflow,range:Math.max(0,Number(node.scrollHeight||0)-Number(node.clientHeight||0))}}).filter(x=>x.r.left>=listLeft-28&&x.r.right<=listRight+22&&x.r.width>=listWidth*.70&&x.r.height>=220&&x.r.bottom>topLimit+160&&x.range>24).sort((a,b)=>{const sa=(a.seedCount*18)+Math.min(100,a.range/18)+(a.overflow==='auto'||a.overflow==='scroll'?30:0)-Math.abs(a.r.right-listRight)-Math.abs(a.r.left-listLeft)+a.depth*.25;const sb=(b.seedCount*18)+Math.min(100,b.range/18)+(b.overflow==='auto'||b.overflow==='scroll'?30:0)-Math.abs(b.r.right-listRight)-Math.abs(b.r.left-listLeft)+b.depth*.25;return sb-sa});
    const listRoot=rootCandidates[0]?.node||null;
    const originalScroll=listRoot?Math.max(0,Number(listRoot.scrollTop||0)):0;
    const rowShape=n=>{if(!(n instanceof Element)||!visible(n))return false;const r=n.getBoundingClientRect();if(listRoot&&!listRoot.contains(n))return false;if(r.left<listLeft-28||r.right>listRight+22||r.width<listWidth*.58||r.width>listWidth*1.10||r.height<43||r.height>128)return false;const lines=String(n.innerText||'').split(/\\n+/).map(clean).filter(Boolean);return lines.length>0&&lines.length<=10&&lines.some(plausible)};
    const rowName=row=>String(row.innerText||'').split(/\\n+/).map(clean).filter(Boolean).find(plausible)||'';
    const rowToken=row=>{for(const a of row.querySelectorAll('a[href]')){const t=strongToken(a.getAttribute('href')||a.href||'');if(t)return t}return ''};
    const matches=row=>{const rt=rowToken(row);if(token&&rt&&rt===token)return true;return !!target&&rowName(row)===target};
    const locate=()=>{const scope=listRoot||document,seeds=Array.from(scope.querySelectorAll('[role="listitem"],[role="row"],[role="button"],button,a[href],img,[tabindex],div,li'));let best=null;const seen=new Set();for(const seed of seeds){if(!visible(seed))continue;let n=seed;for(let depth=0;n&&depth<9;depth++,n=n.parentElement){if(listRoot&&n===listRoot)break;if(seen.has(n))continue;if(!rowShape(n)||!matches(n))continue;seen.add(n);const r=n.getBoundingClientRect(),exactToken=token&&rowToken(n)===token,s=Math.max(0,90-Math.abs(r.width-listWidth)*.3)+Math.max(0,45-Math.abs(r.height-72)*.6)+(n.matches('[role="listitem"],[role="row"]')?40:0)+(exactToken?120:0);if(!best||s>best.s)best={node:n,s};break}}return best?.node||null};
    const pageSig=()=>{if(!listRoot)return '';const rows=[];for(const n of listRoot.querySelectorAll('[role="listitem"],[role="row"],div,li')){if(!rowShape(n))continue;const r=n.getBoundingClientRect();if(r.bottom<topLimit||r.top>innerHeight)continue;rows.push(rowName(n)+'@'+Math.round(r.top))}return rows.slice(0,24).join('|')};
    const settle=async()=>{let last=pageSig(),stable=0;for(let i=0;i<7;i++){await sleep(i<2?75:110);const now=pageSig();if(now===last)stable++;else{last=now;stable=0}if(stable>=2)break}};
    const seek=async(pos)=>{if(!listRoot)return locate();const max=Math.max(0,Number(listRoot.scrollHeight||0)-Number(listRoot.clientHeight||0));const next=Math.max(0,Math.min(max,Number(pos||0)));if(Math.abs(Number(listRoot.scrollTop||0)-next)>2){listRoot.scrollTop=next;listRoot.dispatchEvent(new Event('scroll',{bubbles:true}))}await settle();return locate()};
    let row=locate(),searched=false;
    if(!row&&listRoot){searched=true;const vh=Math.max(180,Number(listRoot.clientHeight||0));const max=Math.max(0,Number(listRoot.scrollHeight||0)-vh);const anchor=wantedOffset>0?Math.max(0,wantedOffset-vh*.34):originalScroll;const positions=[anchor,anchor-vh*.72,anchor+vh*.72,anchor-vh*1.45,anchor+vh*1.45].map(v=>Math.max(0,Math.min(max,v)));const uniq=[];for(const v of positions)if(!uniq.some(x=>Math.abs(x-v)<24))uniq.push(v);for(const pos of uniq){row=await seek(pos);if(row)break}
      if(!row){const step=Math.max(220,Math.floor(vh*.82));for(let pos=0,guard=0;pos<=max+4&&guard<48;pos+=step,guard++){row=await seek(pos);if(row)break}if(!row&&max>0)row=await seek(max)}
    }
    if(!row){if(listRoot&&searched&&Math.abs(Number(listRoot.scrollTop||0)-originalScroll)>2){listRoot.scrollTop=Math.min(originalScroll,Math.max(0,Number(listRoot.scrollHeight||0)-Number(listRoot.clientHeight||0)));listRoot.dispatchEvent(new Event('scroll',{bubbles:true}))}return {ok:false,reason:'row-not-found',target,token,chatLeft,listLeft,listRight,hasListRoot:!!listRoot};}
    try{row.scrollIntoView({block:'nearest'});await settle()}catch{}
    // React virtual rows can be recycled while scrolling. Re-resolve the exact
    // target AFTER settling and refuse to click if the visible row identity no
    // longer matches the requested customer.
    row=locate()||row;
    if(!matches(row)){return {ok:false,reason:'row-recycled-before-click',target,token,rowName:rowName(row)}};
    const r=row.getBoundingClientRect();
    // Click the safe center-right body of the conversation row, away from the
    // avatar/profile target and away from trailing star/menu controls.
    const x=Math.round(Math.max(r.left+88,Math.min(r.right-72,r.left+r.width*.56))),y=Math.round(Math.max(r.top+10,Math.min(r.bottom-10,(r.top+r.bottom)/2)));
    if(listRoot&&searched){window.__yokoMbAggregateOpenRestore={root:listRoot,scrollTop:originalScroll,requestId,target,at:Date.now()};}
    return {ok:true,located:true,target,token,rowName:rowName(row),rowToken:rowToken(row),rowText:clean(row.innerText||'').slice(0,500),x,y,left:Math.round(r.left),top:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height),hasListRoot:!!listRoot,searched,originalScroll,currentScroll:listRoot?Number(listRoot.scrollTop||0):0,requestId};
  })()`;
}

module.exports = {
  metaBusinessThreadToken,
  metaBusinessCanonicalChatId,
  metaBusinessSystemOrAdText,
  metaBusinessPlausibleCustomerName,
  metaBusinessConversationIdentity,
  mergeMetaBusinessConversationRows,
  dedupeMetaBusinessConversations,
  metaBusinessConversationScanScript,
  metaBusinessCurrentChatScript,
  metaBusinessOpenConversationScript
};
