'use strict';

function clean(value, max = 1600) {
  return String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function facebookThreadIdFromUrl(value = '') {
  const raw = clean(value, 2400);
  if (!raw) return '';
  let path = raw;
  try {
    const u = new URL(raw, 'https://www.facebook.com/');
    const host = String(u.hostname || '').toLowerCase();
    if (!(host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'messenger.com' || host.endsWith('.messenger.com'))) return '';
    path = String(u.pathname || '');
  } catch {}
  const patterns = [
    /\/messages\/e2ee\/t\/([^/?#]+)/i,
    /\/messages\/t\/([^/?#]+)/i,
    /\/t\/([^/?#]+)/i
  ];
  for (const re of patterns) {
    const match = path.match(re);
    if (!match) continue;
    const id = clean(decodeURIComponent(match[1] || ''), 300);
    if (id) return id;
  }
  return '';
}

function facebookCanonicalChatId(value = '') {
  const raw = clean(value, 2400);
  if (!raw) return '';
  if (/^fb-thread:/i.test(raw)) return `fb-thread:${clean(raw.replace(/^fb-thread:/i, ''), 300)}`;
  const threadId = facebookThreadIdFromUrl(raw);
  return threadId ? `fb-thread:${threadId}` : '';
}

function facebookConversationIdentity(row = {}) {
  const canonical = facebookCanonicalChatId(row.chatId || row.href || '');
  if (canonical) return canonical.toLowerCase();
  const handle = clean(row.handle, 180).replace(/^@+/, '').toLowerCase();
  if (handle) return `handle:${handle}`;
  const name = clean(row.displayName || row.name, 180).toLocaleLowerCase();
  return name ? `name:${name}` : '';
}

function mergeFacebookConversationRows(primary = {}, alias = {}) {
  const canonical = facebookCanonicalChatId(primary.chatId || primary.href || alias.chatId || alias.href || '');
  const newest = (a, b) => {
    const aa = Number(a || 0) || 0;
    const bb = Number(b || 0) || 0;
    return Math.max(aa, bb);
  };
  const first = (a, b) => {
    const vals = [Number(a || 0), Number(b || 0)].filter(v => Number.isFinite(v) && v > 1).sort((x,y)=>x-y);
    return vals[0] || 0;
  };
  const lastIncomingAt = newest(primary.lastIncomingAt, alias.lastIncomingAt);
  const lastReplyAt = newest(primary.lastReplyAt, alias.lastReplyAt);
  const unreadCount = Math.max(0, Number(primary.unreadCount || 0) || 0, Number(alias.unreadCount || 0) || 0);
  const awaitingReply = unreadCount > 0 || lastIncomingAt > lastReplyAt || primary.awaitingReply === true || alias.awaitingReply === true;
  return {
    ...alias,
    ...primary,
    chatId: canonical || clean(primary.chatId || alias.chatId, 300),
    href: clean(primary.href || alias.href, 1600),
    displayName: clean(primary.displayName || primary.name || alias.displayName || alias.name, 180),
    handle: clean(primary.handle || alias.handle, 180).replace(/^@+/, ''),
    avatarUrl: clean(primary.avatarUrl || alias.avatarUrl, 2400),
    preview: clean(primary.preview || primary.lastMessage || alias.preview || alias.lastMessage, 800),
    lastMessage: clean(primary.lastMessage || primary.preview || alias.lastMessage || alias.preview, 800),
    unreadCount,
    awaitingReply,
    lastIncomingAt,
    lastReplyAt,
    lastDirection:lastIncomingAt > lastReplyAt ? 'customer' : (lastReplyAt > lastIncomingAt ? 'me' : clean(primary.lastDirection || alias.lastDirection, 20)),
    firstSeenAt:first(primary.firstSeenAt, alias.firstSeenAt) || 1,
    firstMessageAt:first(primary.firstMessageAt, alias.firstMessageAt),
    newCustomerAt:first(primary.newCustomerAt, alias.newCustomerAt) || (Number(primary.newCustomerAt || alias.newCustomerAt || 0) === 1 ? 1 : 0),
    leadFunnelAt:first(primary.leadFunnelAt, alias.leadFunnelAt),
    leadFunnelTracked:primary.leadFunnelTracked === true || alias.leadFunnelTracked === true
  };
}

function dedupeFacebookConversations(rows = []) {
  const out = [];
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const key = facebookConversationIdentity(row);
    if (!key) { out.push(row); continue; }
    const index = byKey.get(key);
    if (index === undefined) {
      byKey.set(key, out.length);
      out.push(row);
    } else {
      out[index] = mergeFacebookConversationRows(row, out[index]);
    }
  }
  return out;
}

function facebookMessengerConversationScanScript() {
  return `(() => {
    const clean=v=>String(v||'').replace(/\\s+/g,' ').trim();
    const visible=el=>{try{if(!el||!(el instanceof Element))return false;const r=el.getBoundingClientRect();const c=getComputedStyle(el);return r.width>2&&r.height>2&&c.display!=='none'&&c.visibility!=='hidden'&&Number(c.opacity||1)>0}catch{return false}};
    const threadId=value=>{try{const u=new URL(String(value||''),location.href);const p=u.pathname||'';for(const re of [/\\/messages\\/e2ee\\/t\\/([^/?#]+)/i,/\\/messages\\/t\\/([^/?#]+)/i,/\\/t\\/([^/?#]+)/i]){const m=p.match(re);if(m&&m[1])return decodeURIComponent(m[1])}}catch{}return ''};
    const isTime=t=>/^(?:\\d{1,2}:\\d{2}|今天|今日|昨天|昨日|Today|Yesterday|\\d+\\s*(?:分钟|分鐘|分钟前|分前|小时|小時|小时前|時間|minutes?|mins?|hours?|hrs?)|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?)/i.test(clean(t));
    const excluded=new Set(['Facebook','Messenger','消息','收件箱','主页','首页','搜索','设置','通知','联系人','Messages','Inbox','Home','Search','Settings','Notifications','Contacts','Chats']);
    const rowFor=seed=>{let n=seed;for(let i=0;n&&i<10;i++,n=n.parentElement){if(!(n instanceof Element)||!visible(n))continue;const r=n.getBoundingClientRect();if(r.top<40||r.left<0||r.left>620||r.width<150||r.width>700||r.height<36||r.height>170)continue;const txt=clean(n.innerText||'');if(!txt||txt.length>1200)continue;if(n.matches('[role="row"],[role="listitem"],a[href]')||n.querySelector('img'))return n}return null};
    const anchors=Array.from(document.querySelectorAll('a[href*="/messages/t/"],a[href*="/messages/e2ee/t/"],a[href^="/t/"],a[href*="messenger.com/t/"]'));
    const rows=[];const seen=new Set();const seenNodes=new Set();
    for(const a of anchors){if(!visible(a))continue;const ar=a.getBoundingClientRect();if(ar.top<38||ar.left>650)continue;const row=rowFor(a)||a;if(seenNodes.has(row))continue;seenNodes.add(row);const href=String(a.getAttribute('href')||a.href||'');const tid=threadId(href);if(!tid)continue;const lines=String(row.innerText||'').split(/\\n+/).map(clean).filter(Boolean);const aria=clean(a.getAttribute('aria-label')||row.getAttribute?.('aria-label')||'');let name='';
      const ariaName=aria.replace(/(?:,?\\s*)?(?:unread|未读|未讀|active now|在线|上線).*$/i,'').trim();
      if(ariaName&&!excluded.has(ariaName)&&!isTime(ariaName)&&ariaName.length<=180)name=ariaName;
      if(!name)name=lines.find(x=>x&&!excluded.has(x)&&!isTime(x)&&!/^(?:\\d+|unread|未读|未讀)$/i.test(x)&&x.length<=180)||'';
      if(!name)continue;const timeText=lines.find((x,i)=>i>0&&isTime(x))||'';const preview=lines.find((x,i)=>i>0&&x!==timeText&&x!==name&&!excluded.has(x)&&x.length<=600)||'';const img=row.querySelector('img');const avatarUrl=String(img?.currentSrc||img?.src||'').trim();let unreadCount=0;const badge=row.querySelector('[aria-label*="unread" i],[aria-label*="未读"],[aria-label*="未讀"],[data-testid*="unread" i],[class*="unread" i],[class*="badge" i]');if(badge){const n=parseInt(clean(badge.textContent),10);unreadCount=Number.isFinite(n)?Math.max(1,n):1}else if(/(?:unread|未读|未讀)/i.test(aria)){unreadCount=1}
      const key='fb-thread:'+tid;if(seen.has(key))continue;seen.add(key);rows.push({chatId:key,name,handle:'',avatarUrl,preview,timeText,unreadCount,href,top:Math.round(row.getBoundingClientRect().top)});
    }
    rows.sort((a,b)=>a.top-b.top);
    const currentTid=threadId(location.href);let headerName='';let headerNode=null;const selectors=['[role="main"] h2 a','[role="main"] h2','[role="main"] header a','[role="main"] header [dir="auto"]','[role="main"] [data-testid*="header" i] [dir="auto"]'];
    for(const sel of selectors){for(const el of document.querySelectorAll(sel)){if(!visible(el))continue;const r=el.getBoundingClientRect();if(r.top>230||r.left<260)continue;const v=clean(el.getAttribute?.('aria-label')||el.textContent||'');if(v&&!excluded.has(v)&&!isTime(v)&&v.length<=180){headerName=v;headerNode=el;break}}if(headerName)break}
    if(!headerName&&currentTid){const row=rows.find(x=>x.chatId==='fb-thread:'+currentTid);if(row)headerName=row.name}
    let root=headerNode;for(let i=0;root&&i<6;i++,root=root.parentElement){const r=root.getBoundingClientRect();if(r.height>=40&&r.height<=190&&r.width>=240)break}const img=root?.querySelector?.('img')||document.querySelector('[role="main"] header img');const avatarUrl=String(img?.currentSrc||img?.src||'').trim();
    return {rows:rows.slice(0,800),selected:{chatId:currentTid?'fb-thread:'+currentTid:'',name:headerName,handle:'',avatarUrl},url:location.href};
  })()`;
}

function facebookMessengerCurrentChatScript() {
  return `(() => {
    const clean=v=>String(v||'').replace(/\\s+/g,' ').trim();
    const visible=el=>{try{if(!el||!(el instanceof Element))return false;const r=el.getBoundingClientRect();const c=getComputedStyle(el);return r.width>2&&r.height>2&&c.display!=='none'&&c.visibility!=='hidden'&&Number(c.opacity||1)>0}catch{return false}};
    const threadId=value=>{try{const u=new URL(String(value||''),location.href);const p=u.pathname||'';for(const re of [/\\/messages\\/e2ee\\/t\\/([^/?#]+)/i,/\\/messages\\/t\\/([^/?#]+)/i,/\\/t\\/([^/?#]+)/i]){const m=p.match(re);if(m&&m[1])return decodeURIComponent(m[1])}}catch{}return ''};
    const tid=threadId(location.href);const excluded=new Set(['Facebook','Messenger','消息','收件箱','主页','首页','搜索','设置','Messages','Inbox','Home','Search','Settings']);let node=null,name='';
    const selectors=['[role="main"] h2 a','[role="main"] h2','[role="main"] header a','[role="main"] header [dir="auto"]','[role="main"] [data-testid*="header" i] [dir="auto"]'];
    for(const sel of selectors){for(const el of document.querySelectorAll(sel)){if(!visible(el))continue;const r=el.getBoundingClientRect();if(r.top>230||r.left<240)continue;const v=clean(el.getAttribute?.('aria-label')||el.textContent||'');if(v&&!excluded.has(v)&&v.length<=180){node=el;name=v;break}}if(name)break}
    if(!name&&tid){const a=Array.from(document.querySelectorAll('a[href]')).find(el=>visible(el)&&threadId(el.getAttribute('href')||el.href)===tid);if(a){let row=a;for(let i=0;row&&i<8;i++,row=row.parentElement){const r=row.getBoundingClientRect();if(r.left<650&&r.height>=36&&r.height<=170){const lines=String(row.innerText||'').split(/\\n+/).map(clean).filter(Boolean);name=lines.find(x=>x&&!excluded.has(x)&&x.length<=180)||'';if(name){node=row;break}}}}}
    let root=node;for(let i=0;root&&i<6;i++,root=root.parentElement){const r=root.getBoundingClientRect();if(r.height>=40&&r.height<=190&&r.width>=240)break}const img=root?.querySelector?.('img')||document.querySelector('[role="main"] header img');const avatarUrl=String(img?.currentSrc||img?.src||'').trim();return {chatId:tid?'fb-thread:'+tid:'',name,handle:'',avatarUrl,url:location.href};
  })()`;
}

module.exports = {
  facebookThreadIdFromUrl,
  facebookCanonicalChatId,
  facebookConversationIdentity,
  mergeFacebookConversationRows,
  dedupeFacebookConversations,
  facebookMessengerConversationScanScript,
  facebookMessengerCurrentChatScript
};
