const { ipcRenderer, webFrame } = require('electron');

// V1.24.8 — IMPORTANT: this preload runs with sandbox:true.
// Electron sandboxed preloads must not depend on local relative CommonJS modules.
// Keep this tiny classifier inline so a conversion-only helper can never crash the
// shared TikTok preload (translation, native selection, CRM sync) at bootstrap.
function classifyTikTokLaneBubble({ lane = {}, bubble = {}, avatarSide = '', semanticRole = '' } = {}) {
  const n = (v, fallback = 0) => { const x = Number(v); return Number.isFinite(x) ? x : fallback; };
  const semantic = String(semanticRole || '').toLowerCase();
  if (semantic === 'customer' || semantic === 'me') return semantic;
  const side = String(avatarSide || '').toLowerCase();
  if (side === 'left') return 'customer';
  if (side === 'right') return 'me';
  const ll = n(lane.left), lr = n(lane.right);
  const bl = n(bubble.left), br = n(bubble.right);
  const width = Math.max(1, lr - ll);
  if (!(lr > ll) || !(br > bl)) return '';
  const leftRatio = (bl - ll) / width;
  const rightRatio = (br - ll) / width;
  const centerRatio = (((bl + br) / 2) - ll) / width;
  if (rightRatio >= 0.86 && leftRatio >= 0.10) return 'me';
  if (rightRatio <= 0.74 && centerRatio <= 0.50) return 'customer';
  if (centerRatio >= 0.60) return 'me';
  if (centerRatio <= 0.44) return 'customer';
  return '';
}

// Yoko SCRM V1.27.110 - bounded fast persistent newest-first translation
// Based on the sealed V1.23.9/V1.25.11 external preload; original sealed file remains untouched.
// Non-LINE translation adapter.
// Rule: translate ONLY real one-to-one chat bubbles. Login/home/settings pages are never translated.
// Both incoming and outgoing chat messages are translated to the configured target language.
// TikTok reuses the leaf-level message scan that worked before the V1.22.4 regression,
// but scopes it to the real conversation pane so sidebar/menu text is never translated.
// No navigation/reload is performed from this preload.

const HOST_CLASS = 'yoko-global-translated-host';
const SOURCE_ATTR = 'data-yoko-global-source';
const TRANSLATION_ATTR = 'data-yoko-global-translation';
const MODE_ATTR = 'data-yoko-global-translation-mode';
const TRANSLATING_ATTR = 'data-yoko-global-translating';
const ERROR_ATTR = 'data-yoko-global-translation-error';
const NOOP_ATTR = 'data-yoko-global-translation-noop';

let settings = { enabled:false, providerReady:false, source:'auto', target:'zh', displayMode:'bilingual', platform:'' };
let scanTimer = null;
let observer = null;
let crmExtractTimer = null;
let crmExtractRetryTimer = null;
let crmExtractLastSignature = '';
let lineAddedTerminalLastSignature = '';
let lineAddedTerminalPendingSignature = '';
let lineAddedTerminalPendingAt = 0;
let activeTranslations = 0;
function maxConcurrentTranslations() {
  // Local Ollama must remain single-flight; cloud/network providers can use a
  // small bounded fan-out for faster newest-first first paint.
  return String(settings.engine || '').toLowerCase() === 'ollama' ? 1 : 3;
}
let translationScanEpoch = 0;
const queue = [];
const queuedNodes = new WeakSet();
const retryAfter = new WeakMap();
const textCache = new Map();
const cacheOrder = [];
// V1.23.9: virtualized chat lists (TikTok/FB/IG etc.) can destroy and recreate
// the same message DOM node while the user scrolls. Keep one in-flight request
// per message text/settings key so recycled nodes never start duplicate API calls.
const inFlightTextTranslations = new Map();
// V1.23.64: provider-confirmed unchanged text (often a customer name such as
// 'yomi') must not enter an endless retry loop. Keep a bounded settings-aware
// no-op cache just like translated text so recycled TikTok DOM nodes stay quiet.
const noTranslationTextKeys = new Set();
const noTranslationKeyOrder = [];

function cleanText(value) {
  return String(value || '')
    .replace(/\u200b/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function platformFromHost() {
  const host = String(location.hostname || '').toLowerCase();
  if (host.includes('tiktok.com')) return 'tiktok';
  if (host.includes('instagram.com')) return 'instagram';
  if (host.includes('whatsapp.com')) return 'whatsapp';
  if (host.includes('telegram.org')) return 'telegram';
  if (host.includes('business.facebook.com')) return 'metabusiness';
  if (host.includes('messenger.com') || host.includes('facebook.com') || host.includes('meta.com')) return 'facebook';
  return '';
}

function isMetaPasskeyHost() {
  const host = String(location.hostname || '').toLowerCase();
  return host === 'meta.com' || host.endsWith('.meta.com') ||
    host === 'facebook.com' || host.endsWith('.facebook.com') ||
    host === 'instagram.com' || host.endsWith('.instagram.com');
}

function installMetaPasskeyGuard() {
  if (!isMetaPasskeyHost()) return;
  const source = `(() => { try {
    if(window.__YOKO_META_PASSKEY_GUARD__) return true;
    const host=String(location.hostname||'').toLowerCase();
    const allowed=host==='meta.com'||host.endsWith('.meta.com')||host==='facebook.com'||host.endsWith('.facebook.com')||host==='instagram.com'||host.endsWith('.instagram.com');
    if(!allowed) return false; window.__YOKO_META_PASSKEY_GUARD__=true;
    const blocked=()=>{try{return new DOMException('Passkey disabled in Yoko SCRM. Use password / verification code / 2FA.','NotAllowedError')}catch{const e=new Error('Passkey disabled');e.name='NotAllowedError';return e}};
    const isPk=o=>!!(o&&typeof o==='object'&&o.publicKey); const creds=navigator.credentials;
    if(creds){const proto=Object.getPrototypeOf(creds);if(proto&&!proto.__yokoPasskeyPatched){const g=typeof proto.get==='function'?proto.get:null,c=typeof proto.create==='function'?proto.create:null;
      if(g)Object.defineProperty(proto,'get',{configurable:true,writable:true,value:function(o){if(isPk(o))return Promise.reject(blocked());return g.call(this,o)}});
      if(c)Object.defineProperty(proto,'create',{configurable:true,writable:true,value:function(o){if(isPk(o))return Promise.reject(blocked());return c.call(this,o)}});
      try{Object.defineProperty(proto,'__yokoPasskeyPatched',{value:true})}catch{}}}
    const pk=window.PublicKeyCredential;if(pk){for(const k of ['isConditionalMediationAvailable','isUserVerifyingPlatformAuthenticatorAvailable'])try{if(typeof pk[k]==='function')Object.defineProperty(pk,k,{configurable:true,value:async()=>false})}catch{} }
    return true;
  } catch { return false; } })()`;
  try { webFrame.executeJavaScript(source).catch(() => {}); } catch {}
}

installMetaPasskeyGuard();
window.addEventListener('DOMContentLoaded', installMetaPasskeyGuard, { once:true });

function isVisible(el) {
  if (!el || !(el instanceof Element)) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 8) return false;
  const c = getComputedStyle(el);
  return c.display !== 'none' && c.visibility !== 'hidden' && Number(c.opacity || 1) > 0;
}

function hasVisibleLoginForm() {
  const selectors = [
    'input[type="password"]',
    'input[type="email"]',
    'input[name*="pass" i]',
    'input[name*="email" i]',
    'input[name*="username" i]'
  ];
  if (selectors.some(sel => Array.from(document.querySelectorAll(sel)).some(isVisible))) return true;
  const text = cleanText(document.body?.innerText || '').slice(0, 5000);
  // Authentication pages may retain a /messages or /inbox return URL. Never translate them.
  if (/(登录|登入|注册|创建新账户|创建新帐号|忘记密码|log\s*in|sign\s*in|sign\s*up|create new account|password|密码)/i.test(text)) {
    const editableCount = Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"]')).filter(isVisible).length;
    if (editableCount > 0) return true;
  }
  return false;
}


// V1.24.0 Hotfix5 — native TikTok customer selection signal.
// The outer Yoko renderer cannot receive clicks that happen inside the embedded
// TikTok WebContentsView.  Report the real chat-header identity from this
// preload after a native click so CRM binding does not depend only on polling.
let nativeChatSelectionSignature = '';
const nativeChatSelectionTimers = new Set();

function currentTikTokNativeChatIdentity() {
  if (platformFromHost() !== 'tiktok' || !/\/messages(?:\/|$)/i.test(String(location.pathname || ''))) return null;
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  let name = clean(document.querySelector('[data-e2e="dm-new-chat-nickname"]')?.textContent || '');
  let handle = clean(document.querySelector('[data-e2e="chat-uniqueid"]')?.textContent || '').replace(/^@/, '');
  let avatar = document.querySelector('[data-e2e="top-chat-avatar"] img');

  // TikTok frequently changes the data-e2e wrappers while leaving the visible
  // "@handle" in the real chat header. Use geometry as a stable fallback.
  let handleNode = null;
  if (!handle) {
    const candidates = Array.from(document.querySelectorAll('span,div,p,a,strong')).filter(el => {
      if (!isVisible(el)) return false;
      const text = clean(el.textContent || '');
      if (!/^@[A-Za-z0-9._-]{2,80}$/.test(text)) return false;
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.top < 190 && r.left > innerWidth * 0.28 && r.right < innerWidth * 0.98 && r.height < 80;
    }).sort((a,b) => {
      const ar=a.getBoundingClientRect(), br=b.getBoundingClientRect();
      return (ar.width*ar.height) - (br.width*br.height) || ar.top-br.top;
    });
    handleNode = candidates[0] || null;
    if (handleNode) handle = clean(handleNode.textContent).replace(/^@/, '');
  } else {
    handleNode = Array.from(document.querySelectorAll('span,div,p,a,strong')).find(el => {
      if (!isVisible(el)) return false;
      const r=el.getBoundingClientRect();
      return r.top < 190 && clean(el.textContent || '') === '@' + handle;
    }) || null;
  }

  const badName = text => !text || /^@/.test(text) || /^(?:TikTok|消息|訊息|Messages?|在线|在線|已读|已讀|未读|未讀|复制|複製|Copy|更多|More|搜索|Search)$/i.test(text) || /^\d{1,2}:\d{2}$/.test(text) || /^\d+$/.test(text);
  if ((!name || !avatar) && handleNode) {
    let node = handleNode;
    for (let i=0; node && i<7; i+=1, node=node.parentElement) {
      if (!(node instanceof Element) || !isVisible(node)) continue;
      const r=node.getBoundingClientRect();
      if (r.top > 200 || r.height > 190 || r.width > 720) continue;
      const lines=String(node.innerText || '').split(/\n+/).map(clean).filter(Boolean);
      if (!name) {
        const candidate=lines.find(v => v !== '@'+handle && !badName(v) && v.length <= 100);
        if (candidate) name=candidate;
      }
      if (!avatar) {
        const imgs=Array.from(node.querySelectorAll('img')).filter(isVisible);
        if (imgs.length) avatar=imgs.sort((a,b) => {
          const ar=a.getBoundingClientRect(), br=b.getBoundingClientRect();
          const hr=handleNode.getBoundingClientRect();
          const da=Math.hypot((ar.left+ar.width/2)-(hr.left+hr.width/2),(ar.top+ar.height/2)-(hr.top+hr.height/2));
          const db=Math.hypot((br.left+br.width/2)-(hr.left+hr.width/2),(br.top+br.height/2)-(hr.top+hr.height/2));
          return da-db;
        })[0];
      }
      if (name && avatar) break;
    }
  }

  const avatarUrl=String(avatar?.currentSrc || avatar?.src || '').trim();
  if (!name && !handle) return null;
  return { name, handle, avatarUrl, url:String(location.href || '') };
}

function emitTikTokNativeChatSelection(reason = 'click') {
  try {
    const identity=currentTikTokNativeChatIdentity();
    if (!identity || (!identity.name && !identity.handle)) return false;
    const signature=[identity.name,identity.handle,identity.avatarUrl.split('?')[0]].join('|');
    if (signature === nativeChatSelectionSignature) return true;
    nativeChatSelectionSignature=signature;
    ipcRenderer.send('external-native-chat-selected', { ...identity, reason, at:Date.now() });
    return true;
  } catch { return false; }
}

function scheduleTikTokNativeChatSelection(reason = 'click') {
  if (platformFromHost() !== 'tiktok') return;
  for (const delay of [80, 260, 700]) {
    const timer=setTimeout(() => {
      nativeChatSelectionTimers.delete(timer);
      emitTikTokNativeChatSelection(reason);
    }, delay);
    nativeChatSelectionTimers.add(timer);
  }
}

document.addEventListener('click', event => {
  if (!event?.isTrusted) return;
  scheduleTikTokNativeChatSelection('native-click');
}, true);
window.addEventListener('popstate', () => scheduleTikTokNativeChatSelection('popstate'));
window.addEventListener('DOMContentLoaded', () => scheduleTikTokNativeChatSelection('dom-ready'), { once:true });

function isMessagingUrl(platform = settings.platform || platformFromHost()) {
  const host = String(location.hostname || '').toLowerCase();
  const path = String(location.pathname || '').toLowerCase();
  if (platform === 'tiktok') return /\/messages(?:\/|$)/.test(path);
  if (platform === 'instagram') return /^\/direct(?:\/|$)/.test(path);
  if (platform === 'whatsapp') return host === 'web.whatsapp.com' || host.endsWith('.whatsapp.com');
  if (platform === 'telegram') return host === 'web.telegram.org' || host.endsWith('.telegram.org');
  if (platform === 'facebook') return host.includes('messenger.com') || /\/(messages|messenger)(?:\/|$)/.test(path);
  if (platform === 'metabusiness') {
    // Query strings containing a return URL are NOT enough; the actual path must be Inbox/Messages.
    return host.includes('business.facebook.com') && /\/(?:latest\/)?(?:inbox|messages|messenger)(?:\/|$)/.test(path);
  }
  return false;
}

function visibleComposer(platform = settings.platform || platformFromHost()) {
  const selectors = platform === 'tiktok'
    ? ['[contenteditable="true"][role="textbox"]','textarea','[data-e2e*="message-input" i]','[placeholder*="message" i]','[placeholder*="消息"]']
    : platform === 'instagram'
      ? ['textarea[placeholder]','[contenteditable="true"][role="textbox"]','[aria-label*="message" i]','[aria-label*="消息"]']
      : platform === 'whatsapp'
        ? ['footer [contenteditable="true"]','[contenteditable="true"][role="textbox"]','[data-tab][contenteditable="true"]']
        : platform === 'telegram'
          ? ['#editable-message-text','[contenteditable="true"].input-message-input','[contenteditable="true"][role="textbox"]']
          : ['[contenteditable="true"][role="textbox"]','textarea[placeholder]','[aria-label*="message" i]','[aria-label*="消息"]'];
  const candidates = [];
  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < innerHeight * .55) continue;
      if (r.right < innerWidth * .40) continue;
      candidates.push(el);
    }
  }
  return candidates.sort((a,b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0] || null;
}

function chatHeaderExists(platform = settings.platform || platformFromHost()) {
  // A composer is the strongest signal. Header check is intentionally permissive.
  if (platform === 'tiktok') {
    const candidates = Array.from(document.querySelectorAll('header,[role="banner"],h1,h2,strong'));
    return candidates.some(el => {
      if (!isVisible(el)) return false;
      const r = el.getBoundingClientRect();
      return r.top < 240 && r.left > innerWidth * .35 && cleanText(el.innerText || el.textContent || '').length > 0;
    });
  }
  return true;
}

function isConversationReady(platform = settings.platform || platformFromHost(), requireTranslation = true) {
  if (requireTranslation && (!settings.enabled || !settings.providerReady)) return false;
  if (!isMessagingUrl(platform)) return false;
  if (hasVisibleLoginForm()) return false;

  // V1.22.6 root-cause fix:
  // TikTok's current /messages page does not consistently expose a semantic
  // role="textbox" composer or header element. V1.22.5 therefore rejected
  // a valid conversation before candidate scanning even began. On TikTok the
  // /messages route itself is sufficiently specific; the scanner below is
  // scoped to the real message pane and translates both chat directions.
  if (platform === 'tiktok') return true;

  // Other platforms can have login/home pages whose URL still contains a
  // return-to-inbox value. Requiring a visible composer keeps translation out
  // of those non-chat surfaces.
  return !!visibleComposer(platform);
}

function ensureStyles() {
  if (!document?.documentElement || document.getElementById('yoko-global-translation-style')) return;
  const style = document.createElement('style');
  style.id = 'yoko-global-translation-style';
  style.textContent = `
    .${HOST_CLASS}{position:relative!important;overflow:visible!important;}
    .${HOST_CLASS}[${TRANSLATING_ATTR}="1"]::after,
    .${HOST_CLASS}[${ERROR_ATTR}]::after,
    .${HOST_CLASS}[${TRANSLATION_ATTR}]::after{
      display:block!important;box-sizing:border-box!important;width:fit-content!important;max-width:min(420px,70vw)!important;
      margin:4px 0 1px 0!important;padding:3px 7px!important;border-radius:6px!important;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;font-size:12px!important;
      font-weight:500!important;line-height:1.4!important;white-space:pre-wrap!important;word-break:break-word!important;
      pointer-events:none!important;
    }
    .${HOST_CLASS}[${TRANSLATING_ATTR}="1"]::after{content:"翻译中…";background:rgba(246,248,249,.96)!important;color:#73808a!important;border:1px solid rgba(120,130,138,.18)!important;}
    .${HOST_CLASS}[${ERROR_ATTR}]::after{content:attr(${ERROR_ATTR});background:rgba(255,244,244,.97)!important;color:#b33a3a!important;border:1px solid rgba(190,66,66,.20)!important;}
    .${HOST_CLASS}[${TRANSLATION_ATTR}]::after{content:attr(${TRANSLATION_ATTR});background:rgba(238,250,242,.96)!important;color:#236942!important;border:1px solid rgba(73,143,101,.22)!important;}
    .${HOST_CLASS}[${MODE_ATTR}="simple"][${TRANSLATION_ATTR}]::after{margin-top:3px!important;padding-top:3px!important;}
    .yoko-global-message-actions{display:flex!important;justify-content:flex-end!important;align-items:center!important;margin:3px 0 0!important;padding:0!important;pointer-events:auto!important;}
    .yoko-global-copy-message{appearance:none!important;border:0!important;border-radius:5px!important;background:rgba(255,255,255,.78)!important;color:#58666f!important;padding:1px 6px!important;height:19px!important;line-height:17px!important;font-size:10px!important;cursor:pointer!important;box-shadow:inset 0 0 0 1px rgba(120,130,138,.22)!important;}
    .yoko-global-copy-message:hover{background:rgba(255,255,255,.98)!important;color:#1f7a4d!important;}
    .yoko-global-copy-message[data-copied="1"]{color:#138a4b!important;font-weight:700!important;}
  `;
  (document.head || document.documentElement).appendChild(style);
}

function likelyUiText(text) {
  const v = cleanText(text);
  if (!v || v.length > 1200) return true;
  if (/^(?:消息|收件箱|主页|首页|搜索|设置|更多|通知|联系人|聊天室|新建消息|发送消息|输入消息|登录|注册|Messages?|Inbox|Home|Search|Settings?|Notifications?|Contacts?|Chats?|New message|Send message|Log in|Sign up)$/i.test(v)) return true;
  if (/^(?:\d{1,2}:\d{2}|\d{4}[\/年.-]\d{1,2}(?:[\/月.-]\d{1,2})?|今天|昨天|星期[一二三四五六日天]|周[一二三四五六日天]|Today|Yesterday|Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/i.test(v)) return true;
  if (/^[\s\d:./-]+$/.test(v)) return true;
  if (!/[A-Za-z\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(v)) return true;
  return false;
}

function sameText(a,b) { return cleanText(a) === cleanText(b); }

function bubbleHostForLeaf(el) {
  const text = messageText(el);
  if (!text) return null;
  let best = el;
  let node = el;
  for (let i=0; node && i<6; i++, node=node.parentElement) {
    if (!(node instanceof Element) || !isVisible(node)) continue;
    const r = node.getBoundingClientRect();
    const nt = messageText(node);
    if (!sameText(nt, text)) continue;
    if (r.width < 16 || r.width > 820 || r.height < 10 || r.height > 280) continue;
    best = node;
  }
  return best;
}


// V1.24.7 — TikTok conversation-lane fallback.
// Real-world diagnostics from V1.24.6 proved that the native chat identity
// could be resolved while TikTok's message-list/composer selectors returned no
// root at all.  Derive the active conversation lane from the *visible current
// @handle in the chat header* so message extraction does not depend on one
// volatile data-e2e selector.
function tiktokConversationLaneRect() {
  try {
    if (platformFromHost() !== 'tiktok' || !/\/messages(?:\/|$)/i.test(String(location.pathname || ''))) return null;
    const identity = currentTikTokNativeChatIdentity();
    const handle = String(identity?.handle || '').replace(/^@/, '').trim();
    if (!handle) return null;
    const exact = '@' + handle;
    const handleNodes = Array.from(document.querySelectorAll('span,div,p,a,strong')).filter(el => {
      if (!isVisible(el)) return false;
      const text = cleanText(el.textContent || '');
      if (text !== exact) return false;
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.top < Math.min(220, innerHeight * .28) && r.right > innerWidth * .36;
    }).sort((a,b) => {
      const ar=a.getBoundingClientRect(), br=b.getBoundingClientRect();
      // The real chat header is normally farther right than an inbox preview.
      return br.left-ar.left || ar.top-br.top || (ar.width*ar.height)-(br.width*br.height);
    });
    const handleNode = handleNodes[0] || null;
    if (!handleNode) return null;
    const hr = handleNode.getBoundingClientRect();

    let best = null;
    let node = handleNode.parentElement;
    for (let depth=0; node && depth<11; depth+=1, node=node.parentElement) {
      if (!(node instanceof Element) || !isVisible(node)) continue;
      const r=node.getBoundingClientRect();
      if (r.width < Math.max(280, innerWidth*.30) || r.height < innerHeight*.42) continue;
      if (r.right < innerWidth*.78 || r.left < innerWidth*.18 || r.left > hr.left+24) continue;
      const area=Math.max(1,r.width*r.height);
      if (!best || area < best.area) best={left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,area,source:'header-ancestor'};
    }

    const composer = visibleComposer('tiktok');
    const cr = composer?.getBoundingClientRect?.();
    if (best) {
      const top=Math.max(best.top, hr.bottom+10, 88);
      const bottom=Math.min(best.bottom, cr && cr.top>top ? cr.top-2 : innerHeight-6);
      if (bottom-top >= 140) return {...best,top,bottom,height:bottom-top};
    }

    // Conservative geometry fallback. The lane starts a little left of the
    // current header handle and extends to the right edge of TikTok's view.
    // The inbox list remains left of this boundary on current desktop layouts.
    const left=Math.max(innerWidth*.32, hr.left-Math.min(150, innerWidth*.19));
    const right=Math.min(innerWidth-2, Math.max(hr.right+260, innerWidth*.98));
    const top=Math.max(88,hr.bottom+10);
    const bottom=Math.min(innerHeight-6, cr && cr.top>top ? cr.top-2 : innerHeight-6);
    if (right-left < 260 || bottom-top < 140) return null;
    return {left,right,top,bottom,width:right-left,height:bottom-top,source:'header-geometry'};
  } catch { return null; }
}

function globalNearbyAvatarSide(host, lane = null) {
  try {
    if (!host?.getBoundingClientRect) return '';
    const hr=host.getBoundingClientRect();
    const cy=(hr.top+hr.bottom)/2;
    const scope=lane || tiktokConversationLaneRect();
    let best=null;
    for (const img of Array.from(document.querySelectorAll('img'))) {
      if (!isVisible(img)) continue;
      const r=img.getBoundingClientRect();
      if (r.width<18||r.width>86||r.height<18||r.height>86) continue;
      if (scope && (r.right<scope.left-40||r.left>scope.right+40||r.bottom<scope.top-40||r.top>scope.bottom+40)) continue;
      const icy=(r.top+r.bottom)/2;
      const vertical=Math.abs(icy-cy);
      if (vertical>46) continue;
      let side='', horizontal=Infinity;
      if (r.right<=hr.left+14 && hr.left-r.right<190) { side='left'; horizontal=Math.max(0,hr.left-r.right); }
      else if (r.left>=hr.right-14 && r.left-hr.right<190) { side='right'; horizontal=Math.max(0,r.left-hr.right); }
      if (!side) continue;
      const score=vertical*4+horizontal;
      if (!best||score<best.score) best={side,score};
    }
    return best?.side||'';
  } catch { return ''; }
}

function tiktokLooseLaneCandidates() {
  const lane=tiktokConversationLaneRect();
  if (!lane) return [];
  const raw=[];
  const all=Array.from(document.querySelectorAll('[dir="auto"],[dir="ltr"],p,span,div'));
  for (const el of all) {
    if (!isVisible(el)) continue;
    if (el.closest('input,textarea,[contenteditable="true"],[role="textbox"],button,nav,header')) continue;
    const r=el.getBoundingClientRect();
    if (r.top<lane.top||r.bottom>lane.bottom+3) continue;
    if (r.right<lane.left+18||r.left>lane.right-12) continue;
    if (r.width<8||r.width>Math.min(840,lane.width*.96)||r.height>520) continue;
    const text=messageText(el);
    if (likelyUiText(text)||nonTranslatableChatText(text)) continue;
    let sameChild=false;
    for (const child of Array.from(el.children||[])) {
      if (isVisible(child)&&sameText(messageText(child),text)) { sameChild=true; break; }
    }
    if (sameChild&&!el.classList.contains(HOST_CLASS)) continue;
    const host=bubbleHostForLeaf(el)||el;
    const h=host.getBoundingClientRect();
    raw.push({el:host,text,r:h,area:Math.max(1,h.width*h.height),cx:(h.left+h.right)/2,cy:(h.top+h.bottom)/2});
  }
  raw.sort((a,b)=>a.area-b.area);
  const chosen=[];
  for (const item of raw) {
    if (chosen.some(prev=>prev.text===item.text&&Math.abs(prev.cy-item.cy)<=14&&Math.abs(prev.cx-item.cx)<=90)) continue;
    chosen.push(item);
  }
  chosen.sort((a,b)=>a.r.top-b.r.top||a.r.left-b.r.left);
  return chosen.map(x=>x.el);
}

function nearbyAvatarSide(host) {
  const hr = host.getBoundingClientRect();
  const bubbleCy = (hr.top + hr.bottom) / 2;
  let node = host.parentElement;
  let best = null;
  for (let depth=0; node && depth<6; depth++, node=node.parentElement) {
    const nr = node.getBoundingClientRect();
    if (nr.height > 320 || nr.width > 1100) continue;
    const imgs = Array.from(node.querySelectorAll('img')).filter(isVisible);
    for (const img of imgs) {
      const ir = img.getBoundingClientRect();
      if (ir.width < 18 || ir.width > 80 || ir.height < 18 || ir.height > 80) continue;
      if (ir.bottom < hr.top-24 || ir.top > hr.bottom+24) continue;
      const imgCy = (ir.top + ir.bottom) / 2;
      const vertical = Math.abs(imgCy - bubbleCy);
      let side = '', horizontal = Infinity;
      if (ir.right <= hr.left+12 && hr.left-ir.right < 150) { side='left'; horizontal=Math.max(0,hr.left-ir.right); }
      else if (ir.left >= hr.right-12 && ir.left-hr.right < 150) { side='right'; horizontal=Math.max(0,ir.left-hr.right); }
      if (!side) continue;
      // V1.24.0 Hotfix2: choose the geometrically nearest avatar instead of
      // the first DOM image. TikTok can keep adjacent message avatars inside a
      // shared virtualized wrapper; DOM order is not a reliable sender signal.
      const score = vertical * 4 + horizontal + depth * 6;
      if (!best || score < best.score) best = { side, score };
    }
    if (best && best.score < 90) break;
  }
  return best?.side || '';
}

function isIncomingHost(host, platform) {
  const r = host.getBoundingClientRect();
  const side = nearbyAvatarSide(host);
  if (side === 'left') return true;
  if (side === 'right') return false;
  // TikTok: restore the geometry that worked in V1.22.4. Incoming bubbles
  // live left of the right-side outgoing lane; outgoing bubbles fail the right
  // boundary test even when no avatar is present.
  if (platform === 'tiktok') return r.left < innerWidth * .73 && r.right < innerWidth * .86;
  if (platform === 'instagram' || platform === 'facebook' || platform === 'metabusiness') return (r.left+r.right)/2 < innerWidth * .72;
  if (platform === 'whatsapp' || platform === 'telegram') return (r.left+r.right)/2 < innerWidth * .70;
  return true;
}

function tiktokChatRoot() {
  // Prefer TikTok's own message-list containers. This is the same family of
  // roots that worked in V1.22.3, before bubble-parent promotion started
  // filtering every real message out on some layouts.
  const selectors = [
    '[data-e2e="dm-new-message-list"]',
    '[data-e2e*="message-list" i]',
    '[role="log"]'
  ];
  for (const sel of selectors) {
    for (const node of document.querySelectorAll(sel)) {
      if (!isVisible(node)) continue;
      const r = node.getBoundingClientRect();
      if (r.width < 280 || r.height < 180) continue;
      if (r.right < innerWidth * .62) continue;
      // The real conversation pane is the large right-hand area, not the
      // account/sidebar list.
      if (r.left < innerWidth * .25 && r.width < innerWidth * .55) continue;
      return node;
    }
  }

  // DOM class names can change. Derive the pane from the visible composer when
  // possible instead of hard-coding a percentage boundary.
  const composer = visibleComposer('tiktok');
  if (composer) {
    let node = composer.parentElement;
    let best = null;
    for (let depth=0; node && depth<10; depth++, node=node.parentElement) {
      if (!(node instanceof Element) || !isVisible(node)) continue;
      const r = node.getBoundingClientRect();
      if (r.right < innerWidth * .75 || r.width < innerWidth * .40 || r.height < innerHeight * .45) continue;
      best = node;
      if (r.left > innerWidth * .25 && r.top < innerHeight * .35) break;
    }
    if (best) return best;
  }

  return null;
}

function nonTranslatableChatText(text) {
  const v = cleanText(text);
  if (!v) return true;
  // Keep links, handles/IDs and pure symbols untouched.
  if (/^(?:https?:\/\/|www\.)\S+$/i.test(v)) return true;
  if (/^@[A-Za-z0-9._-]+$/.test(v)) return true;
  if (/^[A-Za-z0-9._-]+$/.test(v) && /[0-9_.-]/.test(v)) return true;
  if (!/[A-Za-z\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(v)) return true;
  return false;
}

function tiktokCandidates() {
  const root = tiktokChatRoot();
  // V1.23.56: when no conversation is selected TikTok leaves the left inbox
  // list visible but has no real message pane/composer. Older fallback scanning
  // used the whole document and could translate a conversation row such as
  // "jack ? 2026/7/27" as if it were a chat bubble. In that state translate
  // nothing and remove any decoration left by a prior broad scan.
  if (!root) {
    try { document.querySelectorAll(`.${HOST_CLASS}`).forEach(clearNodeTranslation); } catch {}
    return [];
  }
  const scope = root;
  const rr = root.getBoundingClientRect();
  // V1.23.61: compute the lower message boundary once. The newest TikTok
  // bubble often sits only a few pixels above the composer; using rr.bottom - 18
  // dropped exactly that bubble until the operator scrolled upward.
  const composer = visibleComposer('tiktok');
  const composerRect = composer?.getBoundingClientRect?.();
  const bottomLimit = Math.min(
    innerHeight - 8,
    composerRect && composerRect.top > rr.top ? composerRect.top - 2 : rr.bottom + 2
  );
  // Also clean legacy translation attributes that may still be attached to the
  // inbox/sidebar after selecting a real conversation.
  try {
    document.querySelectorAll(`.${HOST_CLASS}`).forEach(node => {
      if (!root.contains(node)) clearNodeTranslation(node);
    });
  } catch {}

  // V1.22.8: keep the *smallest visible text element* for each real message.
  // TikTok often renders the exact same message text in 2-3 nested wrappers.
  // V1.22.7 translated every wrapper, which produced duplicate green rows and
  // sometimes attached the translation to a full-width message-row container.
  const raw = [];
  const all = Array.from(scope.querySelectorAll('[dir="auto"],[dir="ltr"],p,span,div'));
  for (const el of all) {
    if (!isVisible(el)) continue;
    if (el.closest('input,textarea,[contenteditable="true"],[role="textbox"],button,nav,header')) continue;
    const r = el.getBoundingClientRect();
    const text = messageText(el);
    if (likelyUiText(text) || nonTranslatableChatText(text)) continue;

    // V1.23.64: an attached ::after translation is part of the element's
    // visual box. On TikTok that extra height can push r.bottom below the
    // composer boundary (or above the old 260px height cap). V1.23.63 then
    // stopped selecting the very node it had just translated, cleared its
    // translation decoration, and the next scan selected it again. The visible
    // result was an endless "翻译中… ↔ 中文译文" flash.
    // Treat an element that already owns the translation for this exact source
    // as sticky and measure its *message lane* by the original top edge rather
    // than rejecting it because our own translation row enlarged its box.
    const ownsTranslation = el.classList.contains(HOST_CLASS) &&
      cleanText(el.getAttribute(SOURCE_ATTR) || '') === text;
    if (r.top < Math.max(105, rr.top + 36)) continue;
    if ((!ownsTranslation && r.bottom > bottomLimit) || (ownsTranslation && r.top >= bottomLimit - 4)) continue;
    if (r.right < rr.left + 30 || r.left > rr.right - 18) continue;
    if (r.width < 8 || r.width > Math.min(820, rr.width * .90) || r.height > (ownsTranslation ? 520 : 260)) continue;

    // If a visible descendant already carries exactly the same text, this node
    // is normally only a wrapper. Once this exact node already owns a completed
    // or pending translation, keep ownership stable instead of bouncing the
    // translation between nested TikTok wrappers on every hydration pass.
    let hasSameTextDescendant = false;
    for (const child of Array.from(el.children || [])) {
      if (!isVisible(child)) continue;
      const ct = messageText(child);
      if (ct === text) { hasSameTextDescendant = true; break; }
    }
    if (hasSameTextDescendant && !ownsTranslation) continue;

    raw.push({
      el, text, r, ownsTranslation,
      area: Math.max(1, r.width * r.height),
      cx: (r.left + r.right) / 2,
      cy: (r.top + r.bottom) / 2
    });
  }

  // Smallest node wins. Nested duplicate wrappers have almost identical center
  // coordinates but a larger area. The Y tolerance keeps two repeated messages
  // at different vertical positions independent.
  // V1.23.64: existing owner wins before geometric size. Translation pseudo
  // content changes the owner's area, so area-only sorting could alternate
  // between nested wrappers and repeatedly clear/recreate the translation.
  raw.sort((a,b) => Number(b.ownsTranslation) - Number(a.ownsTranslation) || a.area - b.area);
  const chosen = [];
  for (const item of raw) {
    const duplicate = chosen.some(prev =>
      prev.text === item.text &&
      Math.abs(prev.cy - item.cy) <= 14 &&
      Math.abs(prev.cx - item.cx) <= 90
    );
    if (!duplicate) chosen.push(item);
  }

  // Remove translation decorations left on wrappers selected by older scans.
  // This also collapses V1.22.7's already-created duplicate bars immediately.
  const selected = new Set(chosen.map(x => x.el));
  try {
    scope.querySelectorAll(`.${HOST_CLASS}`).forEach(node => {
      if (!selected.has(node)) clearNodeTranslation(node);
    });
  } catch {}

  chosen.sort((a,b) => a.r.top - b.r.top || a.r.left - b.r.left);
  return chosen.map(x => x.el);
}

function genericChatRoot(platform) {
  const selectors = platform === 'whatsapp'
    ? ['#main','[data-testid="conversation-panel-wrapper"]']
    : platform === 'telegram'
      ? ['#MiddleColumn','.messages-layout','.chat .messages-container','.chat']
      : platform === 'instagram'
        ? ['main [role="main"]','main','[role="main"]']
        : ['[role="main"]','main'];
  for (const sel of selectors) {
    for (const node of document.querySelectorAll(sel)) {
      if (!isVisible(node)) continue;
      const r = node.getBoundingClientRect();
      if (r.right < innerWidth*.50 || r.width < 260 || r.height < 180) continue;
      return node;
    }
  }
  return null;
}

function genericCandidates(platform) {
  const root = genericChatRoot(platform);
  if (!root) return [];
  let selector = '[dir="auto"],[dir="ltr"],p,span';
  if (platform === 'whatsapp') selector = 'span.selectable-text,[data-pre-plain-text] [dir="auto"],[data-pre-plain-text] span';
  else if (platform === 'telegram') selector = '.text-content,.translatable-message,[dir="auto"]';
  const out = [];
  const seen = new Set();
  for (const el of root.querySelectorAll(selector)) {
    if (!isVisible(el) || el.closest('input,textarea,[contenteditable="true"],[role="textbox"],button,nav,header')) continue;
    const r = el.getBoundingClientRect();
    if (r.top < 120 || r.bottom > innerHeight-50) continue;
    if (r.right < innerWidth*.48 || r.width > 780 || r.height > 260) continue;
    const text = messageText(el);
    if (likelyUiText(text)) continue;
    const host = bubbleHostForLeaf(el);
    if (!host || seen.has(host)) continue;
    const ht = messageText(host);
    if (!sameText(ht,text) || likelyUiText(ht)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

function candidateElements(requireTranslation = true) {
  const platform = settings.platform || platformFromHost();
  if (!isConversationReady(platform, requireTranslation)) return [];
  if (platform === 'tiktok') return tiktokCandidates();
  return genericCandidates(platform);
}

function messageText(node) {
  if (!node) return '';
  try {
    const clone = node.cloneNode(true);
    clone.querySelectorAll?.('.yoko-global-message-actions').forEach(el => el.remove());
    return cleanText(clone.innerText || clone.textContent || '');
  } catch { return cleanText(node?.innerText || node?.textContent || ''); }
}


function crmMessageRole(node) {
  if (!node) return '';
  const activePlatform = settings.platform || platformFromHost();
  const host = bubbleHostForLeaf(node) || node;

  // Strong semantic hints first. Inspect the promoted bubble host as well as
  // the original leaf because TikTok frequently places direction classes one
  // or two ancestors above the visible text node.
  let current = host;
  for (let i = 0; current && i < 8; i += 1, current = current.parentElement) {
    const hint = [
      current.getAttribute?.('data-e2e'), current.getAttribute?.('data-testid'),
      current.getAttribute?.('aria-label'), current.getAttribute?.('class'),
      current.getAttribute?.('data-message-author-role')
    ].filter(Boolean).join(' ').toLowerCase();
    if (/(?:outgoing|sent[-_ ]?message|message[-_ ]?out|from[-_ ]?me|own[-_ ]?message|is[-_ ]?self|self[-_ ]?message)/i.test(hint)) return 'me';
    if (/(?:incoming|received[-_ ]?message|message[-_ ]?in|from[-_ ]?them|other[-_ ]?message)/i.test(hint)) return 'customer';
  }

  try {
    // V1.24.0 Hotfix1: avatar side is the strongest visual signal on TikTok.
    // Long outgoing bubbles can extend left of the middle of the chat pane, so
    // classifying the text leaf by its center alone can incorrectly learn
    // Yoko's own family/pet/routine facts as customer memory.
    const side = nearbyAvatarSide(host);
    if (side === 'right') return 'me';
    if (side === 'left') return 'customer';

    const root = (activePlatform === 'tiktok' ? tiktokChatRoot() : genericChatRoot(activePlatform)) || document.documentElement;
    const rr = root.getBoundingClientRect();
    const r = host.getBoundingClientRect();
    const width = Math.max(1, rr.width || innerWidth || 1);
    const leftRatio = (r.left - rr.left) / width;
    const rightRatio = (r.right - rr.left) / width;
    const centerRatio = ((r.left + r.right) / 2 - rr.left) / width;

    if (activePlatform === 'tiktok') {
      // Use bubble lane edges instead of leaf center. Outgoing TikTok bubbles
      // hug the right lane; incoming bubbles hug the left lane. Leave the
      // middle intentionally unknown so CRM never guesses customer on weak
      // evidence.
      if (rightRatio >= 0.94 && leftRatio >= 0.30) return 'me';
      if (leftRatio <= 0.22 && rightRatio <= 0.84) return 'customer';
      if (centerRatio >= 0.73) return 'me';
      if (centerRatio <= 0.45) return 'customer';
      return '';
    }

    // Other platforms keep the same conservative ambiguity gap.
    if (centerRatio <= 0.48) return 'customer';
    if (centerRatio >= 0.70) return 'me';
  } catch {}
  return '';
}

let messageActionScanTimer = null;

function ensureCustomerCopyAction(node) {
  if (!node?.isConnected || crmMessageRole(node) !== 'customer') return false;
  const text = messageText(node);
  if (!text || likelyUiText(text)) return false;
  ensureStyles();
  let actions = node.querySelector(':scope > .yoko-global-message-actions');
  if (!actions) {
    actions = document.createElement('div');
    actions.className = 'yoko-global-message-actions';
    try { node.appendChild(actions); } catch { return false; }
  }
  let btn = actions.querySelector('.yoko-global-copy-message');
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'yoko-global-copy-message';
    btn.textContent = '⧉ 复制';
    btn.title = '复制这条客户消息';
    actions.appendChild(btn);
    btn.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      const current = messageText(node);
      if (!current || btn.disabled) return;
      btn.disabled = true;
      try {
        const result = await ipcRenderer.invoke('copy-text-to-clipboard', current);
        if (result?.ok === false) throw new Error(result.error || '复制失败');
        btn.dataset.copied = '1';
        btn.textContent = '✓ 已复制';
        setTimeout(() => { if (btn?.isConnected) { btn.dataset.copied='0'; btn.textContent='⧉ 复制'; } }, 900);
      } catch {
        btn.textContent = '复制失败';
        setTimeout(() => { if (btn?.isConnected) btn.textContent='⧉ 复制'; }, 1100);
      } finally { btn.disabled = false; }
    });
  }
  return true;
}

function scanCustomerCopyActions() {
  messageActionScanTimer = null;
  if (document.hidden || !isConversationReady(settings.platform || platformFromHost(), false)) return;
  try { candidateElements(false).slice(-80).forEach(ensureCustomerCopyAction); } catch {}
}

function scheduleCustomerCopyActions(delay = 180) {
  if (messageActionScanTimer) clearTimeout(messageActionScanTimer);
  messageActionScanTimer = setTimeout(scanCustomerCopyActions, Math.max(60, Number(delay) || 180));
}

function crmSignature(text) {
  let h = 2166136261;
  const value = String(text || '');
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function looksLikeExplicitLineAddedTerminal(text = '') {
  const value = cleanText(text).slice(0, 700);
  return /(?:\bLINE\b|ライン).{0,42}(?:追加しました|追加した|登録しました|登録した|友達追加しました|加了|添加了|加好了|添加好了|added)/iu.test(value)
    || /(?:追加しました|追加した|登録しました|登録した|加了|添加了|加好了|添加好了|added).{0,32}(?:\bLINE\b|ライン)/iu.test(value);
}

function looksLikeContextualLineAddedTerminal(text = '') {
  const value = cleanText(text).slice(0, 320);
  return /^(?:(?:私は|僕は|わたしは|こちらは)\s*)?(?:(?:もう|すでに|先ほど)\s*)?(?:(?:あなた|優子さん|Yoko)を\s*)?(?:友達追加しました|追加しました|追加したよ|登録しました|登録したよ|できました|加了|添加了|添加好了|加好了|added)(?:[。！!、,\s]|$)/iu.test(value);
}

function looksLikeOutgoingLineInviteForTerminal(text = '') {
  const value = cleanText(text).slice(0, 900);
  return /(?:\bLINE\b|ライン)/iu.test(value) && /(?:ID|アイディー|追加してください|追加して|友達追加|交換|QR|リンク|link|加我|添加我|add me)/iu.test(value);
}

function publishConfirmedLineAddedTerminal(messages = [], force = false) {
  try {
    const rows = Array.isArray(messages) ? messages : [];
    let hit = null;
    let hitIndex = -1;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i] || {};
      if (row.role !== 'customer') continue;
      const text = cleanText(row.text || '');
      if (!text) continue;
      let confirmed = looksLikeExplicitLineAddedTerminal(text);
      if (!confirmed && looksLikeContextualLineAddedTerminal(text)) {
        const prior = rows.slice(Math.max(0, i - 6), i).reverse().find(item => item?.role === 'me' && looksLikeOutgoingLineInviteForTerminal(item?.text || ''));
        confirmed = !!prior;
      }
      if (confirmed) { hit = row; hitIndex = i; break; }
    }
    if (!hit) return false;

    // V1.24.0 Hotfix8: do not permanently suppress a conversion-terminal event
    // before the main process confirms that it resolved a real customer.  The
    // previous fire-and-forget path remembered the signature immediately; when
    // TikTok emitted the bubble before its chat header hydrated, main rejected
    // the write and every later retry (and repeated identical customer message)
    // was silently deduped forever.
    // Include the visible ordinal/time in the fingerprint so two separate
    // identical "もうLINEを追加しました。" bubbles are not collapsed together.
    const signature = crmSignature(`${location.href}\u001fline-added\u001f${hitIndex}\u001f${hit.text}\u001f${hit.timeText || ''}\u001f${Number(hit.delivered || 0) || 0}`);
    const now = Date.now();
    if (!force && signature === lineAddedTerminalLastSignature) return false;
    if (signature === lineAddedTerminalPendingSignature && (now - lineAddedTerminalPendingAt) < 2200) return false;

    lineAddedTerminalPendingSignature = signature;
    lineAddedTerminalPendingAt = now;
    const nativeIdentity = platformFromHost() === 'tiktok' ? currentTikTokNativeChatIdentity() : null;
    const payload = {
      text:String(hit.text || '').slice(0,1200),
      delivered:Number(hit.delivered || 0) || 0,
      signature,
      ordinal:hitIndex,
      timeText:String(hit.timeText || '').slice(0,120),
      displayName:String(nativeIdentity?.name || '').slice(0,180),
      handle:String(nativeIdentity?.handle || '').replace(/^@/,'').slice(0,180),
      avatarUrl:String(nativeIdentity?.avatarUrl || '').slice(0,2400)
    };

    Promise.resolve(ipcRenderer.invoke('external-line-added-confirmed-sync', payload)).then(result => {
      if (result?.ok && result?.resolved !== false) {
        lineAddedTerminalLastSignature = signature;
      } else {
        // Keep it retryable.  The normal forced CRM retry 1.6s later will
        // republish this same terminal fact after the header/customer identity
        // has had time to hydrate.
        if (lineAddedTerminalLastSignature === signature) lineAddedTerminalLastSignature = '';
        setTimeout(() => scheduleCrmAutoExtract(260), 700);
      }
    }).catch(() => {
      // Compatibility fallback.  Do not mark success; allow a later retry.
      try { ipcRenderer.send('external-line-added-confirmed', payload); } catch {}
      setTimeout(() => scheduleCrmAutoExtract(260), 900);
    }).finally(() => {
      if (lineAddedTerminalPendingSignature === signature) {
        lineAddedTerminalPendingSignature = '';
        lineAddedTerminalPendingAt = 0;
      }
    });
    return true;
  } catch { return false; }
}

function publishCrmAutoExtract(force = false) {
  crmExtractTimer = null;
  try {
    if (!isConversationReady()) return;
    const messages = candidateElements(false)
      .map(node => { const timeText=yokoHistoryNativeTime(node); return { role:crmMessageRole(node), text:messageText(node), top:node.getBoundingClientRect().top, timeText, delivered:yokoExternalNativeTimeMs(timeText) }; })
      .filter(item => (item.role === 'customer' || item.role === 'me') && item.text && !likelyUiText(item.text))
      .sort((a,b) => a.top-b.top)
      .slice(-30)
      .map(item => ({ role:item.role, text:item.text.slice(0,1200), delivered:Number(item.delivered || 0) || 0, timeText:item.timeText || '' }));
    if (!messages.length) return;
    // V1.24.0 Hotfix7: LINE-added is a conversion terminal event. Publish it
    // independently from ordinary CRM snapshot dedupe so a previously-seen
    // message can self-heal stale CRM stage/LINE progress after app restart or
    // after TikTok virtual-DOM hydration dropped the normal extraction event.
    publishConfirmedLineAddedTerminal(messages, force);
    const signature = crmSignature(`${location.href}\u001f${messages.map(item => `${item.role}|${item.text}|${item.timeText || ''}|${Number(item.delivered || 0) || 0}`).join('\u001e')}`);
    if (!force && signature === crmExtractLastSignature) return;
    crmExtractLastSignature = signature;
    ipcRenderer.send('external-crm-auto-extract', { messages, signature });

    // V1.23.60: TikTok can add the message bubble before its selected-chat
    // header/identity has finished hydrating. The main process intentionally
    // rejects CRM writes without a stable customer identity. Re-publish the
    // same snapshot once after hydration; main-process signature dedupe makes
    // this a no-op when the first delivery already succeeded.
    if (!force) {
      if (crmExtractRetryTimer) clearTimeout(crmExtractRetryTimer);
      crmExtractRetryTimer = setTimeout(() => {
        crmExtractRetryTimer = null;
        publishCrmAutoExtract(true);
      }, 1600);
    }
  } catch {}
}

function scheduleCrmAutoExtract(delay = 750) {
  if (crmExtractTimer) clearTimeout(crmExtractTimer);
  crmExtractTimer = setTimeout(publishCrmAutoExtract, Math.max(150, Number(delay) || 750));
}

function looksLikeTargetLanguage(text, target = settings.target) {
  const v = cleanText(text);
  if (!v) return false;
  const t = String(target || '').toLowerCase();
  if (t === 'zh' || t === 'zh-cn' || t === 'zh-tw') {
    // Kana means this is Japanese even if it contains Han characters.
    if (/[ぁ-ゖァ-ヺー]/u.test(v)) return false;
    return /\p{Script=Han}/u.test(v);
  }
  if (t === 'ja') return /[ぁ-ゖァ-ヺー]/u.test(v);
  if (t === 'en') return /[A-Za-z]/.test(v) && !/[ぁ-ゖァ-ヺ\p{Script=Han}]/u.test(v);
  if (t === 'ko') return /[가-힣]/u.test(v);
  return false;
}

function clearNodeTranslation(node) {
  try {
    node.classList.remove(HOST_CLASS);
    node.removeAttribute(SOURCE_ATTR);
    node.removeAttribute(TRANSLATION_ATTR);
    node.removeAttribute(MODE_ATTR);
    node.removeAttribute(TRANSLATING_ATTR);
    node.removeAttribute(ERROR_ATTR);
    node.removeAttribute(NOOP_ATTR);
  } catch {}
}

function markNoTranslationNeeded(node,text,key='') {
  if (!node?.isConnected) return;
  ensureStyles();
  const source = cleanText(text);
  node.classList.add(HOST_CLASS);
  node.setAttribute(SOURCE_ATTR, source);
  node.setAttribute(MODE_ATTR, settings.displayMode === 'simple' ? 'simple' : 'bilingual');
  node.removeAttribute(TRANSLATING_ATTR);
  node.removeAttribute(TRANSLATION_ATTR);
  node.removeAttribute(ERROR_ATTR);
  node.setAttribute(NOOP_ATTR, '1');
  const cacheKey = key || translationTextCacheKey(source);
  if (cacheKey && !noTranslationTextKeys.has(cacheKey)) {
    noTranslationTextKeys.add(cacheKey);
    noTranslationKeyOrder.push(cacheKey);
    while (noTranslationKeyOrder.length > 2000) noTranslationTextKeys.delete(noTranslationKeyOrder.shift());
  }
}

function markPending(node,text) {
  if (!node?.isConnected) return;
  ensureStyles();
  node.classList.add(HOST_CLASS);
  node.setAttribute(SOURCE_ATTR, cleanText(text));
  node.setAttribute(MODE_ATTR, settings.displayMode === 'simple' ? 'simple' : 'bilingual');
  node.removeAttribute(TRANSLATION_ATTR);
  node.removeAttribute(ERROR_ATTR);
  node.removeAttribute(NOOP_ATTR);
  node.setAttribute(TRANSLATING_ATTR,'1');
}

function markError(node,text,message='翻译失败，稍后自动重试') {
  if (!node?.isConnected) return;
  ensureStyles();
  node.classList.add(HOST_CLASS);
  node.setAttribute(SOURCE_ATTR, cleanText(text));
  node.removeAttribute(TRANSLATING_ATTR);
  node.removeAttribute(TRANSLATION_ATTR);
  node.removeAttribute(NOOP_ATTR);
  node.setAttribute(ERROR_ATTR, message);
  retryAfter.set(node, Date.now()+8000);
}

function attachTranslation(node,original,translated) {
  const source = cleanText(original);
  const target = cleanText(translated);
  if (!node?.isConnected || !source) return;
  ensureStyles();
  node.classList.add(HOST_CLASS);
  node.setAttribute(SOURCE_ATTR, source);
  node.setAttribute(MODE_ATTR, settings.displayMode === 'simple' ? 'simple' : 'bilingual');
  node.removeAttribute(TRANSLATING_ATTR);
  node.removeAttribute(ERROR_ATTR);
  node.removeAttribute(NOOP_ATTR);
  if (looksLikeTargetLanguage(source, settings.target)) { clearNodeTranslation(node); return; }
  if (!target || target === source) {
    markError(node, source, '译文未变化，稍后自动重试');
    return;
  }
  node.setAttribute(TRANSLATION_ATTR, settings.displayMode === 'simple' ? target : `中文译文：${target}`);
}

function translationTextCacheKey(text) {
  // Engine is part of the local key so switching the global translator does not
  // accidentally reuse a renderer-memory result created by another provider.
  return `${settings.engine || 'none'}|${settings.source}|${settings.target}|${cleanText(text)}`;
}

function rememberCache(key,value) {
  if (!key || !value) return;
  if (!textCache.has(key)) cacheOrder.push(key);
  textCache.set(key,value);
  while (cacheOrder.length > 2000) textCache.delete(cacheOrder.shift());
}

function enqueueNode(node) {
  if (!node || queuedNodes.has(node)) return;
  const text = messageText(node);
  if (likelyUiText(text) || nonTranslatableChatText(text)) return;
  if (looksLikeTargetLanguage(text, settings.target)) {
    clearNodeTranslation(node);
    return;
  }
  if (node.getAttribute(SOURCE_ATTR) === text && (node.hasAttribute(TRANSLATION_ATTR) || node.hasAttribute(NOOP_ATTR))) return;

  // V1.23.9 scroll-cache fix: TikTok and other virtualized chat lists recreate
  // message elements while scrolling. Restore a translated message immediately
  // from memory BEFORE showing "翻译中…", so scrolling old history has no
  // translation flash and never spends another provider request for that text.
  const key = translationTextCacheKey(text);
  const cached = textCache.get(key);
  if (cached && cached !== text) {
    attachTranslation(node,text,cached);
    return;
  }
  if (noTranslationTextKeys.has(key)) {
    markNoTranslationNeeded(node,text,key);
    return;
  }

  const retry = Number(retryAfter.get(node) || 0);
  if (retry > Date.now()) return;
  markPending(node,text);
  queuedNodes.add(node);
  queue.push({node,text,key});
  pumpQueue();
}

function clearQueuedTranslationJobs() {
  while (queue.length) { const job=queue.shift(); try { queuedNodes.delete(job?.node); } catch {} }
}
function pumpQueue() {
  while (activeTranslations < maxConcurrentTranslations() && queue.length) {
    const job = queue.shift();
    if (!job?.node?.isConnected) { queuedNodes.delete(job?.node); continue; }
    activeTranslations++;
    translateJob(job).finally(() => {
      activeTranslations = Math.max(0,activeTranslations-1);
      pumpQueue();
    });
  }
}

async function requestTranslationForText(text,key) {
  const existing = inFlightTextTranslations.get(key);
  if (existing) return existing;

  const request = (async () => {
    let result = await ipcRenderer.invoke('external-inline-translate', {
      text, source:settings.source || 'auto', target:settings.target || 'zh', context:[],
      skipSharedCache:String(settings.engine || '').toLowerCase() !== 'ollama'
    });
    let translated = result?.ok && typeof result.translated === 'string' ? cleanText(result.translated) : '';

    // A stale/bad persistent cache may contain the original text. Force one
    // uncached retry before declaring failure.
    if (translated === text && !looksLikeTargetLanguage(text,settings.target)) {
      result = await ipcRenderer.invoke('external-inline-translate', {
        text, source:settings.source || 'auto', target:settings.target || 'zh', context:[], force:true,
        skipSharedCache:String(settings.engine || '').toLowerCase() !== 'ollama'
      });
      translated = result?.ok && typeof result.translated === 'string' ? cleanText(result.translated) : '';
    }

    // IMPORTANT: cache the completed result even if the original DOM node was
    // recycled while the request was running. This is the core scroll fix.
    if (translated && translated !== text) rememberCache(key,translated);
    return { result, translated };
  })();

  inFlightTextTranslations.set(key, request);
  try {
    return await request;
  } finally {
    if (inFlightTextTranslations.get(key) === request) inFlightTextTranslations.delete(key);
  }
}

async function translateJob({node,text,key}) {
  try {
    if (!node.isConnected || messageText(node) !== text) return;
    if (looksLikeTargetLanguage(text, settings.target)) { clearNodeTranslation(node); return; }
    key = key || translationTextCacheKey(text);
    const cached = textCache.get(key);
    if (cached && cached !== text) {
      attachTranslation(node,text,cached);
      return;
    }

    const { result, translated } = await requestTranslationForText(text,key);

    // The translation above has already been cached. Only DOM attachment is
    // conditional on this exact virtualized node still representing the text.
    if (!node.isConnected || messageText(node) !== text) return;
    if (translated && translated !== text) {
      attachTranslation(node,text,translated);
    } else if (result?.ok) {
      // V1.23.64: after the normal request plus one forced retry both return
      // unchanged text, treat it as a stable no-op instead of showing
      // '翻译中…' again every retry interval. This is common for names/IDs.
      markNoTranslationNeeded(node,text,key);
    } else {
      markError(node,text);
    }
  } catch {
    if (node?.isConnected && messageText(node) === text) markError(node,text);
  } finally {
    queuedNodes.delete(node);
  }
}

async function primePersistentTranslations(nodes=[], epoch=translationScanEpoch) {
  const rows=[];
  for (const node of nodes.slice(0,64)) {
    if (!node?.isConnected) continue;
    const text=messageText(node);
    if (likelyUiText(text) || nonTranslatableChatText(text) || looksLikeTargetLanguage(text,settings.target)) continue;
    const key=translationTextCacheKey(text);
    if (textCache.has(key) || node.getAttribute(SOURCE_ATTR) === text && node.hasAttribute(TRANSLATION_ATTR)) continue;
    rows.push({id:`r${rows.length}`,text,source:settings.source||'auto',target:settings.target||'zh',node,key});
  }
  if (!rows.length) return;
  try {
    const result=await ipcRenderer.invoke('external-inline-translation-cache-batch',{
      items:rows.map(({id,text,source,target})=>({id,text,source,target,context:[]})),
      preferSpeed:String(settings.engine||'').toLowerCase() !== 'ollama'
    });
    if (epoch !== translationScanEpoch) return;
    const byId=new Map((result?.items||[]).map(item=>[String(item?.id||''),item]));
    for (const row of rows) {
      const hit=byId.get(row.id); const translated=hit?.hit?cleanText(hit.translated||''):'';
      if (!translated || !row.node?.isConnected || messageText(row.node)!==row.text) continue;
      if (translated===row.text || looksLikeTargetLanguage(row.text,settings.target)) markNoTranslationNeeded(row.node,row.text,row.key);
      else { rememberCache(row.key,translated); attachTranslation(row.node,row.text,translated); }
    }
  } catch {}
}

async function scanVisibleMessages(epoch=translationScanEpoch) {
  scanTimer = null;
  if (document.hidden || !isConversationReady()) { clearTranslationsOutsideConversation(); return; }
  ensureStyles();
  const nodes = candidateElements();
  // One invariant on every non-LINE web app: newest/bottom text first.
  nodes.sort((a,b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
  await primePersistentTranslations(nodes,epoch);
  if (epoch !== translationScanEpoch) return;
  for (const node of nodes.slice(0,160)) enqueueNode(node);
}

function scheduleScan(delay=40,{preempt=false}={}) {
  if (!settings.enabled || !settings.providerReady) return;
  if (!isConversationReady()) { clearTranslationsOutsideConversation(); return; }
  if (preempt) { translationScanEpoch++; clearQueuedTranslationJobs(); }
  if (scanTimer) clearTimeout(scanTimer);
  const epoch=translationScanEpoch;
  scanTimer = setTimeout(()=>scanVisibleMessages(epoch), Math.max(12,Number(delay)||0));
}

function clearTranslations() {
  try { document.querySelectorAll(`.${HOST_CLASS}`).forEach(clearNodeTranslation); } catch {}
  clearQueuedTranslationJobs();
}

function clearTranslationsOutsideConversation() {
  if (isConversationReady()) return;
  clearTranslations();
}

function applySettings(next={}) {
  const old = {...settings};
  settings = {...settings,...next,platform:next.platform || platformFromHost() || settings.platform};
  if (!settings.enabled || !settings.providerReady || !isConversationReady()) {
    clearTranslations();
    return;
  }
  if (!old.enabled || old.target !== settings.target || old.displayMode !== settings.displayMode || old.source !== settings.source || old.engine !== settings.engine) {
    clearTranslations();
    if (old.target !== settings.target || old.source !== settings.source || old.engine !== settings.engine) {
      textCache.clear();
      cacheOrder.length = 0;
      noTranslationTextKeys.clear();
      noTranslationKeyOrder.length = 0;
    }
  }
  scheduleScan(20,{preempt:true});
}

async function refreshSettings() {
  try {
    const next = await ipcRenderer.invoke('get-external-translation-settings');
    if (next && typeof next === 'object') applySettings(next);
  } catch {}
}

function startObserver() {
  if (observer || !document?.documentElement) return;
  observer = new MutationObserver(mutations => {
    const meaningful = mutations.some(m => {
      if (m.type === 'characterData') return !m.target?.parentElement?.closest?.('.yoko-global-message-actions');
      return [...(m.addedNodes || [])].some(node => !(node instanceof Element) || !node.closest?.('.yoko-global-message-actions'));
    });
    if (meaningful) { scheduleCrmAutoExtract(320); scheduleCustomerCopyActions(180); }
    if (!settings.enabled || !settings.providerReady) return;
    if (!isConversationReady()) {
      clearTranslationsOutsideConversation();
      return;
    }
    if (mutations.some(m => m.type === 'childList' || m.type === 'characterData')) scheduleScan(28,{preempt:true});
  });
  observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:false});
  window.addEventListener('scroll',() => { scheduleScan(55,{preempt:true}); scheduleCustomerCopyActions(140); },true);
  document.addEventListener('visibilitychange',() => { if (!document.hidden) { scheduleScan(18,{preempt:true}); scheduleCustomerCopyActions(100); } });
  window.addEventListener('popstate',() => { crmExtractLastSignature=''; lineAddedTerminalLastSignature=''; lineAddedTerminalPendingSignature=''; lineAddedTerminalPendingAt=0; clearTranslations(); setTimeout(() => { refreshSettings(); scheduleScan(20,{preempt:true}); scheduleCrmAutoExtract(700); },0); });
  window.addEventListener('hashchange',() => { crmExtractLastSignature=''; lineAddedTerminalLastSignature=''; lineAddedTerminalPendingSignature=''; lineAddedTerminalPendingAt=0; clearTranslations(); setTimeout(() => { refreshSettings(); scheduleScan(20,{preempt:true}); scheduleCrmAutoExtract(700); },0); });
  window.addEventListener('pageshow',() => { installMetaPasskeyGuard(); crmExtractLastSignature=''; lineAddedTerminalLastSignature=''; lineAddedTerminalPendingSignature=''; lineAddedTerminalPendingAt=0; clearTranslations(); refreshSettings(); scheduleScan(20,{preempt:true}); scheduleCrmAutoExtract(850); });
}

ipcRenderer.on('external-translation-settings',(_e,next) => applySettings(next || {}));
window.addEventListener('DOMContentLoaded',() => { startObserver(); refreshSettings(); scheduleScan(18,{preempt:true}); scheduleCustomerCopyActions(300); scheduleCrmAutoExtract(1000); });
if (document.readyState !== 'loading') { startObserver(); refreshSettings(); scheduleScan(12,{preempt:true}); scheduleCustomerCopyActions(220); scheduleCrmAutoExtract(900); }


// V1.23.59: visible platform timestamps can hydrate after the message text and
// TikTok frequently renders the clock as a sibling/row label instead of a child
// of the bubble. Parse both clock-only and common date-qualified labels here.
function yokoExternalNativeTimeMs(raw,referenceMs=Date.now()){
  raw=String(raw||'').replace(/\s+/g,' ').trim();if(!raw)return 0;
  const ref=new Date(Number(referenceMs||Date.now())||Date.now());
  const make=(y,m,d,h=0,mi=0)=>{const v=new Date(y,Math.max(0,m-1),d,h,mi,0,0);return Number.isNaN(v.getTime())?0:v.getTime();};
  const clock=(h,mi,marker='')=>{h=Number(h);mi=Number(mi);const token=String(marker||'').toLowerCase();if(/(?:pm|下午|午後)/i.test(token)&&h<12)h+=12;if(/(?:am|上午|午前)/i.test(token)&&h===12)h=0;return {h,mi};};
  let m=raw.match(/^(上午|下午|午前|午後)?\s*(\d{1,2})[:：](\d{2})(?:\s*(AM|PM))?$/i);
  if(m){const c=clock(m[2],m[3],`${m[1]||''} ${m[4]||''}`);return make(ref.getFullYear(),ref.getMonth()+1,ref.getDate(),c.h,c.mi);}
  m=raw.match(/^(?:今天|今日|Today)\s*(上午|下午|午前|午後)?\s*(\d{1,2})[:：](\d{2})(?:\s*(AM|PM))?$/i);
  if(m){const c=clock(m[2],m[3],`${m[1]||''} ${m[4]||''}`);return make(ref.getFullYear(),ref.getMonth()+1,ref.getDate(),c.h,c.mi);}
  m=raw.match(/^(?:昨天|昨日|Yesterday)\s*(上午|下午|午前|午後)?\s*(\d{1,2})[:：](\d{2})(?:\s*(AM|PM))?$/i);
  if(m){const d=new Date(ref.getFullYear(),ref.getMonth(),ref.getDate()-1);const c=clock(m[2],m[3],`${m[1]||''} ${m[4]||''}`);return make(d.getFullYear(),d.getMonth()+1,d.getDate(),c.h,c.mi);}
  m=raw.match(/^(20\d{2})[\/年.-](\d{1,2})[\/月.-](\d{1,2})(?:日)?(?:\s+(上午|下午|午前|午後)?\s*(\d{1,2})[:：](\d{2})(?:\s*(AM|PM))?)?$/i);
  if(m){const c=clock(m[5]||0,m[6]||0,`${m[4]||''} ${m[7]||''}`);return make(Number(m[1]),Number(m[2]),Number(m[3]),c.h,c.mi);}
  m=raw.match(/^(\d{1,2})[\/月.-](\d{1,2})(?:日)?(?:\s+(上午|下午|午前|午後)?\s*(\d{1,2})[:：](\d{2})(?:\s*(AM|PM))?)?$/i);
  if(m){const c=clock(m[4]||0,m[5]||0,`${m[3]||''} ${m[6]||''}`);return make(ref.getFullYear(),Number(m[1]),Number(m[2]),c.h,c.mi);}
  return 0;
}


function tiktokDedicatedTerminalSnapshot() {
  try {
    if (platformFromHost() !== 'tiktok') return { rows:[], laneSource:'', rawCount:0 };
    const lane=tiktokConversationLaneRect();
    if (!lane) return { rows:[], laneSource:'', rawCount:0 };
    // Prefer the normal/lane candidate pipeline, but also inspect existing
    // translation hosts because they are definitive real-message nodes already
    // proven visible by Yoko's translator.
    const merged=[];
    const seen=new Set();
    // Keep the existing general translation/CRM candidate path untouched.
    // The broad header-lane fallback is used ONLY by this conversion-terminal
    // collector, preventing a TikTok selector change from causing unrelated UI
    // text to enter normal translation or customer-memory extraction.
    for (const node of [...candidateElements(false), ...tiktokLooseLaneCandidates(), ...Array.from(document.querySelectorAll(`.${HOST_CLASS}`))]) {
      if (!(node instanceof Element)||!isVisible(node)) continue;
      const r=node.getBoundingClientRect();
      if (r.top<lane.top||r.bottom>lane.bottom+4||r.right<lane.left+16||r.left>lane.right-10) continue;
      const text=messageText(node);
      if (!text||likelyUiText(text)) continue;
      const key=`${text}|${Math.round(r.top/8)}|${Math.round(r.left/12)}`;
      if (seen.has(key)) continue; seen.add(key);
      let role=crmMessageRole(node);
      if (!role) {
        const side=globalNearbyAvatarSide(node,lane);
        if (side==='left') role='customer'; else if (side==='right') role='me';
      }
      if (!role) role=classifyTikTokLaneBubble({lane,bubble:r});
      const timeText=yokoHistoryNativeTime(node);
      merged.push({role,text:text.slice(0,2000),top:r.top,timeText,delivered:yokoExternalNativeTimeMs(timeText)});
    }
    merged.sort((a,b)=>a.top-b.top);
    return { rows:merged.slice(-80), laneSource:String(lane.source||''), rawCount:merged.length };
  } catch { return { rows:[], laneSource:'', rawCount:0 }; }
}

// V1.23.24: provide the main process a bounded, read-only snapshot of visible
// one-to-one chat messages for the ChatGPT workbench. No page navigation and no
// DOM mutation are performed here.
ipcRenderer.on('yoko-gpt-request-recent-messages', (_event, payload = {}) => {
  try {
    const limit = Math.max(1, Math.min(80, Number(payload?.limit || 60) || 60));
    const messages = candidateElements(false)
      .map(node => {
        const timeText = yokoHistoryNativeTime(node);
        return { role:crmMessageRole(node), text:messageText(node), top:node.getBoundingClientRect().top, timeText, delivered:yokoExternalNativeTimeMs(timeText) };
      })
      .filter(item => (item.role === 'customer' || item.role === 'me') && item.text && !likelyUiText(item.text))
      .sort((a,b) => a.top-b.top)
      .slice(-limit)
      .map(item => ({ role:item.role, text:item.text.slice(0,2000), delivered:Number(item.delivered || 0) || 0, timeText:item.timeText || '' }));
    const identity = platformFromHost() === 'tiktok' ? currentTikTokNativeChatIdentity() : null;
    const terminalSnapshot = platformFromHost() === 'tiktok' ? tiktokDedicatedTerminalSnapshot() : {rows:[],laneSource:'',rawCount:0};
    ipcRenderer.send('yoko-gpt-recent-messages-response', {
      requestId:String(payload?.requestId || ''), messages,
      terminalRows:Array.isArray(terminalSnapshot.rows)?terminalSnapshot.rows:[],
      scanMeta:{laneSource:String(terminalSnapshot.laneSource||''),terminalRawCount:Number(terminalSnapshot.rawCount||0)},
      identity:identity ? { name:String(identity.name || ''), handle:String(identity.handle || '').replace(/^@/, '') } : null
    });
  } catch (error) {
    ipcRenderer.send('yoko-gpt-recent-messages-response', { requestId:String(payload?.requestId || ''), messages:[], identity:null, error:String(error?.message || error) });
  }
});
// V1.23.31 — independent chat-history snapshot (text + visible media).
function yokoHistoryNativeTime(root){
  if(!root)return '';
  const isTime=v=>/^(?:(?:今天|今日|Today|昨天|昨日|Yesterday)\s*)?(?:上午|下午|午前|午後)?\s*\d{1,2}[:：]\d{2}(?:\s*(?:AM|PM))?$|^(?:20\d{2}[\/年.-])?\d{1,2}[\/月.-]\d{1,2}(?:日)?\s+(?:上午|下午|午前|午後)?\s*\d{1,2}[:：]\d{2}(?:\s*(?:AM|PM))?$/i.test(v);
  const values=el=>[el?.getAttribute?.('title'),el?.getAttribute?.('aria-label'),el?.textContent].map(raw=>String(raw||'').replace(/\s+/g,' ').trim()).filter(Boolean);
  try{
    // Strongest signal: a time nested directly in the actual message node.
    const nodes=[root,...root.querySelectorAll('[title],[aria-label],time')].slice(0,32);
    for(const el of nodes){for(const v of values(el)){if(isTime(v))return v;}}

    // TikTok desktop often places "20:54" in a sibling/row element above the
    // bubble. Search visible clock labels around the bubble geometrically, but
    // keep the radius tight so inbox-list timestamps cannot leak into chat.
    const rr=root.getBoundingClientRect();
    const candidates=[];
    // One DOM scan is shared by every message inspected during the same CRM /
    // GPT snapshot. Without this tiny cache, 30-80 bubbles would each rescan
    // the whole TikTok document just to find the same handful of clock labels.
    const now=Date.now();
    let visibleTimes=Array.isArray(yokoHistoryNativeTime._cache)&&now-Number(yokoHistoryNativeTime._cacheAt||0)<180?yokoHistoryNativeTime._cache:null;
    if(!visibleTimes){
      visibleTimes=[];
      for(const el of Array.from(document.querySelectorAll('time,[title],[aria-label],span,div'))){
        if(!isVisible(el))continue;
        let v='';for(const raw of values(el)){if(isTime(raw)){v=raw;break;}}if(!v)continue;
        let tr;try{tr=el.getBoundingClientRect();}catch{continue}
        if(tr.width<1||tr.height<1||tr.width>260||tr.height>90)continue;
        visibleTimes.push({el,v,tr});
        if(visibleTimes.length>=180)break;
      }
      yokoHistoryNativeTime._cache=visibleTimes;yokoHistoryNativeTime._cacheAt=now;
    }
    for(const item of visibleTimes){
      const {el,v,tr}=item;if(el===root||root.contains?.(el))continue;
      const above=tr.bottom<=rr.top;
      const below=tr.top>=rr.bottom;
      const vgap=above?rr.top-tr.bottom:(below?tr.top-rr.bottom:0);
      if(vgap>92)continue;
      const hgap=tr.right<rr.left?rr.left-tr.right:(tr.left>rr.right?tr.left-rr.right:0);
      if(hgap>340)continue;
      const tcx=(tr.left+tr.right)/2,rcx=(rr.left+rr.right)/2;
      // A timestamp in the conversation lane is normally close vertically. A
      // label below the bubble is penalized because native platforms usually
      // render message time above/alongside the following message group.
      const score=vgap+(below?44:0)+Math.min(180,Math.abs(tcx-rcx))*.08+Math.max(0,tr.width-90)*.03;
      candidates.push({v,score,top:tr.top});
    }
    candidates.sort((a,b)=>a.score-b.score||b.top-a.top);
    return candidates[0]?.v||'';
  }catch{}
  return '';
}
function yokoHistoryNodeKey(root,signature=''){
  if(!root)return '';
  try{
    for(let node=root,depth=0;node&&depth<6;node=node.parentElement,depth++){
      for(const name of ['data-message-id','data-mid','data-id','data-testid','id']){const v=String(node.getAttribute?.(name)||'').trim();if(v&&v.length<180&&!/^(?:message|row|item)$/i.test(v))return `${name}:${v}`;}
    }
    const sig=String(signature||'').slice(0,500);
    if(root.dataset?.yokoHistorySig!==sig){root.dataset.yokoHistorySig=sig;root.dataset.yokoHistoryId=`dom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;}
    return String(root.dataset?.yokoHistoryId||'');
  }catch{return ''}
}
async function yokoHistoryDataUrl(src,maxBytes=12*1024*1024){
  src=String(src||'').trim();if(!src)return '';
  if(/^data:/i.test(src))return src.length<=Math.ceil(maxBytes*1.5)?src:'';
  try{const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),1400);const response=await fetch(src,{credentials:'include',signal:controller.signal});clearTimeout(timer);if(!response.ok)return '';const blob=await response.blob();if(!blob.size||blob.size>maxBytes)return '';return await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=()=>resolve('');reader.readAsDataURL(blob);});}catch{return ''}
}
function yokoHistoryMediaRole(el){
  let node=el;
  for(let depth=0;node&&depth<8;node=node.parentElement,depth++){const role=crmMessageRole(node);if(role==='me'||role==='customer')return role;}
  try{const r=el.getBoundingClientRect();return r.left+r.width/2>innerWidth*.56?'me':'customer';}catch{return ''}
}
async function yokoHistorySnapshot(limit=80){
  const max=Math.max(1,Math.min(120,Number(limit)||80));const rows=[];
  for(const node of candidateElements(false)){
    const role=crmMessageRole(node),text=messageText(node);if((role!=='customer'&&role!=='me')||!text||likelyUiText(text))continue;
    let rect;try{rect=node.getBoundingClientRect()}catch{continue}
    rows.push({role,type:'text',text:text.slice(0,12000),nativeTime:yokoHistoryNativeTime(node),sourceKey:yokoHistoryNodeKey(node,`${role}|text|${text}`),top:rect.top||0});
  }
  let ordinal=0;
  for(const el of document.querySelectorAll('img,video,audio')){
    if(!isVisible(el))continue;let rect;try{rect=el.getBoundingClientRect()}catch{continue}
    const tag=String(el.tagName||'').toLowerCase();if(tag==='img'&&(rect.width<72||rect.height<72))continue;if(tag==='video'&&(rect.width<90||rect.height<70))continue;if(tag==='audio'&&rect.width<80)continue;
    const role=yokoHistoryMediaRole(el);if(role!=='me'&&role!=='customer')continue;
    const src=String(el.currentSrc||el.src||el.getAttribute?.('src')||'').trim();if(!src)continue;
    const type=tag==='img'?'image':tag==='audio'?'audio':'video';const dataUrl=await yokoHistoryDataUrl(src,type==='image'?12*1024*1024:20*1024*1024);
    rows.push({role,type,src,dataUrl,mimeType:'',duration:Number(el.duration||0)||0,nativeTime:yokoHistoryNativeTime(el.parentElement),sourceKey:yokoHistoryNodeKey(el,`${role}|${type}|${src}`),top:(rect.top||0)+(++ordinal/1000)});
  }
  rows.sort((a,b)=>(a.top||0)-(b.top||0));return rows.slice(-max).map(({top,...row})=>row);
}
ipcRenderer.on('yoko-history-request-snapshot',async(_event,payload={})=>{
  const requestId=String(payload?.requestId||'');
  try{const entries=await yokoHistorySnapshot(payload?.limit||80);ipcRenderer.send('yoko-history-snapshot-response',{requestId,entries});}
  catch(error){ipcRenderer.send('yoko-history-snapshot-response',{requestId,entries:[],error:String(error?.message||error)});}
});
