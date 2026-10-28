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

// Yoko SCRM V1.23.9
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
const PINNED_ATTR = 'data-yoko-global-translation-pinned';

let settings = { enabled:false, providerReady:false, source:'auto', target:'zh', displayMode:'bilingual', platform:'', translateOutgoingLocal:false };

// V1.27.133: Meta Business background server pretranslation. This does not
// wait for the operator to click the customer; once a complete incoming bubble
// reaches the preload it is queued to VPS/DeepL + shared SQLite.
const metaServerPreSeen = new Map();
const metaServerPreBuffer = new Map();
let metaServerPreTimer = null;
function queueMetaServerPretranslation(text) {
  if(!settings.enabled || settings.serverPreTranslation===false)return false;
  const clean=cleanText(text);if(!clean)return false;
  const key=`${settings.source||'auto'}\u001f${settings.target||'zh'}\u001f${clean}`;
  const now=Date.now(),prior=Number(metaServerPreSeen.get(key)||0);if(prior&&now-prior<10*60*1000)return false;
  metaServerPreSeen.set(key,now);metaServerPreBuffer.set(key,{id:`meta-${now}-${metaServerPreBuffer.size}`,text:clean,source:settings.source||'auto',target:settings.target||'zh',timestampMs:now});
  while(metaServerPreSeen.size>3000)metaServerPreSeen.delete(metaServerPreSeen.keys().next().value);
  if(metaServerPreTimer)return true;
  metaServerPreTimer=setTimeout(()=>{
    metaServerPreTimer=null;const items=[...metaServerPreBuffer.values()].slice(0,64);metaServerPreBuffer.clear();if(!items.length)return;
    ipcRenderer.invoke('server-pretranslate-incoming-batch',{platform:'metabusiness',items}).then(result=>{
      if(result?.ok===false)for(const item of items){const k=`${settings.source||'auto'}\u001f${settings.target||'zh'}\u001f${cleanText(item.text)}`;metaServerPreSeen.delete(k);}
    }).catch(()=>{for(const item of items){const k=`${settings.source||'auto'}\u001f${settings.target||'zh'}\u001f${cleanText(item.text)}`;metaServerPreSeen.delete(k);}});
  },35);return true;
}
let scanTimer = null;
let observer = null;
let crmExtractTimer = null;
let crmExtractRetryTimer = null;
let crmExtractLastSignature = '';
const crmTranslationBackfillSeen = new WeakMap();
let crmExtractHeartbeatTimer = null;
let metaBusinessInboxHeartbeatTimer = null;
let metaBusinessInboxSnapshotTimer = null;
let metaBusinessInboxLastSignature = '';
let metaBusinessAvatarMirrorTimer = null;
let metaBusinessAvatarMirrorLastSignature = '';
let metaBusinessAvatarMirrorHeartbeatLastAt = 0;
// V1.27.40: Meta virtual lists mutate aggressively while the operator scrolls.
// Expensive whole-pane scans during active wheel/touch scrolling were the main
// source of visible jank.  Keep scroll itself paint-only, then do one coalesced
// acquisition/translation/CRM pass shortly after scrolling stops.
let metaBusinessScrollActiveUntil = 0;
let metaBusinessScrollIdleTimer = null;
// V1.27.59: translation DOM decorations change bubble height. Meta's virtual
// scroller then tries to compensate and can move the viewport even though the
// operator never touched the wheel. Keep an explicit user-scroll generation so
// translation attachment may restore the visual anchor only when the user has
// NOT moved since the decoration began.
let metaBusinessUserScrollGeneration = 0;
let metaBusinessLastExplicitScrollIntentAt = 0;
let metaBusinessProgrammaticScrollUntil = 0;
let metaBusinessLastConversationScroller = null;
let metaBusinessTranslationViewportMutationDepth = 0;
// V1.27.63: atomic viewport batches own translation UI commits; no persistent scroll fight.
// translation batch. A per-DOM-write anchor was not enough at the bottom of
// Meta's virtual list because React may perform a delayed auto-follow scroll
// hundreds of milliseconds after the translation height changed. The session
// is captured after the operator stops scrolling and stays authoritative until
// the visible translation batch settles. Any real user wheel/touch/pointer/
// keyboard scroll invalidates it immediately.
let metaBusinessTranslationViewportSession = null;
let metaBusinessTranslationViewportRestoreTimer = null;
const META_TRANSLATION_VIEWPORT_LOCK_MS = 700;
function metaBusinessUserIsScrolling() {
  return Date.now() < Number(metaBusinessScrollActiveUntil || 0);
}
function metaBusinessMarkScrollActivity(explicit = false) {
  const now = Date.now();
  if (explicit) {
    metaBusinessUserScrollGeneration += 1;
    metaBusinessLastExplicitScrollIntentAt = now;
    metaBusinessProgrammaticScrollUntil = 0;
    metaBusinessTranslationViewportSession = null;
    if (metaBusinessTranslationViewportRestoreTimer) { clearTimeout(metaBusinessTranslationViewportRestoreTimer); metaBusinessTranslationViewportRestoreTimer = null; }
  } else if (now >= Number(metaBusinessProgrammaticScrollUntil || 0) && now - Number(metaBusinessLastExplicitScrollIntentAt || 0) > 120) {
    // Scrollbar dragging / keyboard scrolling may not emit wheel/touch events.
    metaBusinessUserScrollGeneration += 1;
  }
  // V1.27.41 native-only: scrolling must stay paint-only. There is no software
  // MB inbox mirror anymore, so no list acquisition belongs on this path.
  metaBusinessScrollActiveUntil = now + 110;
  if (metaBusinessScrollIdleTimer) clearTimeout(metaBusinessScrollIdleTimer);
  metaBusinessScrollIdleTimer = setTimeout(() => {
    metaBusinessScrollIdleTimer = null;
    metaBusinessScrollActiveUntil = 0;
    if (document.hidden) return;
    // V1.27.63: scroll stops -> read current viewport -> one atomic translation batch.
    // Never pre-lock/follow scrollTop while the operator is moving.
    scheduleScan(20);
    scheduleCustomerCopyActions(260);
    scheduleCrmAutoExtract(420);
  }, 340);
}

function metaBusinessRememberConversationScroller(target) {
  try {
    if (!(target instanceof Element)) return;
    if (target.scrollHeight <= target.clientHeight + 16 || target.clientHeight < 120) return;
    const root = metaBusinessChatRoot();
    if (!root || !(target === root || root.contains(target))) return;
    metaBusinessLastConversationScroller = target;
  } catch {}
}

function metaBusinessDisableNativeScrollAnchoring(scroller) {
  try {
    if (!(scroller instanceof Element) || !scroller.isConnected) return;
    if (scroller.getAttribute('data-yoko-meta-scroll-anchor') === 'off') return;
    scroller.setAttribute('data-yoko-meta-scroll-anchor','off');
    scroller.style.setProperty('overflow-anchor','none','important');
  } catch {}
}

function metaBusinessTranslationScrollRoot(preferredNode = null) {
  try {
    const root = metaBusinessChatRoot();
    const composer = metaBusinessComposer();
    if (!root) return null;
    const usable = el => {
      if (!(el instanceof Element) || !el.isConnected) return false;
      if (!(el === root || root.contains(el))) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 220 && r.height >= 140 && el.scrollHeight > el.clientHeight + 16;
    };
    if (usable(metaBusinessLastConversationScroller)) { metaBusinessDisableNativeScrollAnchoring(metaBusinessLastConversationScroller); return metaBusinessLastConversationScroller; }
    let cur = preferredNode instanceof Element ? preferredNode.parentElement : null;
    for (let depth = 0; cur && depth < 12; depth += 1, cur = cur.parentElement) {
      if (usable(cur)) { metaBusinessDisableNativeScrollAnchoring(cur); return cur; }
      if (cur === root) break;
    }
    const rr = root.getBoundingClientRect();
    const cr = composer?.getBoundingClientRect?.() || { top:rr.bottom, bottom:rr.bottom, left:rr.left, right:rr.right, width:rr.width, height:0 };
    const pool = [root, ...Array.from(root.querySelectorAll('div,[role="log"],[role="main"],[role="region"]'))]
      .filter(usable)
      .map(el => {
        const r = el.getBoundingClientRect();
        const lanePenalty = Math.abs(r.left - rr.left) + Math.abs(r.right - rr.right);
        const composerPenalty = r.bottom <= cr.top + 32 ? Math.abs(r.bottom - cr.top) : 120 + Math.abs(r.bottom - cr.bottom);
        return {el, score:lanePenalty + composerPenalty + Math.abs(r.width - rr.width) * .35};
      })
      .sort((a,b)=>a.score-b.score);
    const picked=pool[0]?.el || null; metaBusinessDisableNativeScrollAnchoring(picked); return picked;
  } catch { return null; }
}

function metaBusinessCaptureTranslationViewportAnchor(preferredNode = null) {
  try {
    if (platformFromHost() !== 'metabusiness' || metaBusinessUserIsScrolling()) return null;
    const scroller = metaBusinessTranslationScrollRoot(preferredNode);
    if (!scroller) return null;
    const sr = scroller.getBoundingClientRect();
    const merged = [];
    const seen = new Set();
    const add = node => {
      if (!(node instanceof Element) || seen.has(node) || !node.isConnected || !scroller.contains(node) || !isVisible(node)) return;
      seen.add(node);
      const r = node.getBoundingClientRect();
      if (r.bottom <= sr.top + 2 || r.top >= sr.bottom - 2) return;
      const text = cleanText(node.getAttribute?.(SOURCE_ATTR) || messageText(node));
      if (!text || likelyUiText(text)) return;
      merged.push({node,r,text});
    };
    try { candidateElements(false).slice(-90).forEach(add); } catch {}
    try { Array.from(scroller.querySelectorAll(`[${SOURCE_ATTR}]`)).slice(-120).forEach(add); } catch {}
    if (preferredNode instanceof Element) add(preferredNode);
    if (!merged.length) return null;
    const targetTop = sr.top + 6;
    merged.sort((a,b) => {
      const aBelow = a.r.top >= targetTop ? 0 : 1;
      const bBelow = b.r.top >= targetTop ? 0 : 1;
      if (aBelow !== bBelow) return aBelow - bBelow;
      return Math.abs(a.r.top - targetTop) - Math.abs(b.r.top - targetTop);
    });
    const chosen = merged[0];
    return {
      scroller,
      anchor:chosen.node,
      source:chosen.text,
      top:chosen.r.top,
      scrollTop:Number(scroller.scrollTop || 0),
      generation:metaBusinessUserScrollGeneration,
      capturedAt:Date.now()
    };
  } catch { return null; }
}

function metaBusinessResolveTranslationAnchor(snapshot) {
  try {
    const {scroller,anchor,source,top} = snapshot || {};
    if (!(scroller instanceof Element) || !scroller.isConnected) return null;
    if (anchor instanceof Element && anchor.isConnected && scroller.contains(anchor)) return anchor;
    if (!source) return null;
    let best = null, bestDistance = Number.POSITIVE_INFINITY;
    const candidates = [];
    try { candidates.push(...candidateElements(false).slice(-100)); } catch {}
    try { candidates.push(...Array.from(scroller.querySelectorAll(`[${SOURCE_ATTR}]`)).slice(-140)); } catch {}
    const seen = new Set();
    for (const node of candidates) {
      if (!(node instanceof Element) || seen.has(node) || !node.isConnected || !scroller.contains(node)) continue;
      seen.add(node);
      const text = cleanText(node.getAttribute?.(SOURCE_ATTR) || messageText(node));
      if (text !== source) continue;
      const distance = Math.abs(node.getBoundingClientRect().top - Number(top || 0));
      if (distance < bestDistance) { best = node; bestDistance = distance; }
    }
    return best;
  } catch { return null; }
}

function metaBusinessBeginTranslationViewportSession(preferredNode = null, duration = META_TRANSLATION_VIEWPORT_LOCK_MS) {
  try {
    if (platformFromHost() !== 'metabusiness' || metaBusinessUserIsScrolling()) return null;
    const now = Date.now();
    let snapshot = metaBusinessTranslationViewportSession;
    const reusable = snapshot &&
      snapshot.generation === metaBusinessUserScrollGeneration &&
      snapshot.scroller instanceof Element && snapshot.scroller.isConnected &&
      now < Number(snapshot.lockUntil || 0) + 350;
    if (!reusable) snapshot = metaBusinessCaptureTranslationViewportAnchor(preferredNode);
    if (!snapshot) return null;
    snapshot.lockUntil = Math.max(Number(snapshot.lockUntil || 0), now + Math.max(500, Number(duration || 0)));
    snapshot.lastMutationAt = now;
    metaBusinessTranslationViewportSession = snapshot;
    return snapshot;
  } catch { return null; }
}

function metaBusinessTranslationViewportSessionActive() {
  const s = metaBusinessTranslationViewportSession;
  if (!s) return false;
  if (s.generation !== metaBusinessUserScrollGeneration) { metaBusinessTranslationViewportSession = null; return false; }
  if (!(s.scroller instanceof Element) || !s.scroller.isConnected) { metaBusinessTranslationViewportSession = null; return false; }
  if (Date.now() > Number(s.lockUntil || 0)) {
    // Keep ownership for as long as the current visible translation batch is
    // actually running. Real user intent still cancels immediately via the
    // generation guard above.
    const busy = Number(activeTranslations || 0) > 0 || queue.length > 0;
    if (busy) s.lockUntil = Date.now() + 900;
    else { metaBusinessTranslationViewportSession = null; return false; }
  }
  return true;
}

function metaBusinessRestoreTranslationViewportAnchor(snapshot, settle = true) {
  if (!snapshot) return;
  const restoreOnce = () => {
    try {
      if (snapshot.generation !== metaBusinessUserScrollGeneration) return false;
      const scroller = snapshot.scroller;
      if (!(scroller instanceof Element) || !scroller.isConnected) return false;
      const anchor = metaBusinessResolveTranslationAnchor(snapshot);
      if (!(anchor instanceof Element)) return false;
      const nowTop = anchor.getBoundingClientRect().top;
      const delta = nowTop - Number(snapshot.top || 0);
      if (!Number.isFinite(delta) || Math.abs(delta) > 1600) return false;
      if (Math.abs(delta) >= .35) {
        metaBusinessProgrammaticScrollUntil = Date.now() + 120;
        scroller.scrollTop = Number(scroller.scrollTop || 0) + delta;
      }
      return true;
    } catch { return false; }
  };
  restoreOnce();
  if (!settle) return;
  // V1.27.63: no delayed 60/150/300/520/860ms scrollTop chase. One next-frame
  // correction is the absolute maximum; real user generation cancels it.
  try { requestAnimationFrame(() => restoreOnce()); } catch {}
}

function metaBusinessScheduleViewportSessionRestore(delay = 0) {
  if (!metaBusinessTranslationViewportSessionActive()) return;
  if (metaBusinessTranslationViewportRestoreTimer) clearTimeout(metaBusinessTranslationViewportRestoreTimer);
  metaBusinessTranslationViewportRestoreTimer = setTimeout(() => {
    metaBusinessTranslationViewportRestoreTimer = null;
    if (!metaBusinessTranslationViewportSessionActive()) return;
    metaBusinessRestoreTranslationViewportAnchor(metaBusinessTranslationViewportSession, false);
  }, Math.max(0, Number(delay || 0)));
}

function withMetaBusinessTranslationViewportAnchor(preferredNode, mutate) {
  if (typeof mutate !== 'function') return undefined;
  if (platformFromHost() !== 'metabusiness' || metaBusinessTranslationViewportMutationDepth > 0) return mutate();
  // Reuse one post-scroll snapshot for the whole visible batch. Per-message
  // snapshots can themselves drift as earlier translated bubbles change height.
  const snapshot = metaBusinessBeginTranslationViewportSession(preferredNode, META_TRANSLATION_VIEWPORT_LOCK_MS) || metaBusinessCaptureTranslationViewportAnchor(preferredNode);
  metaBusinessTranslationViewportMutationDepth += 1;
  try {
    metaBusinessProgrammaticScrollUntil = Date.now() + 180;
    return mutate();
  } finally {
    metaBusinessTranslationViewportMutationDepth = Math.max(0, metaBusinessTranslationViewportMutationDepth - 1);
    if (snapshot) {
      snapshot.lockUntil = Math.max(Number(snapshot.lockUntil || 0), Date.now() + META_TRANSLATION_VIEWPORT_LOCK_MS);
      snapshot.lastMutationAt = Date.now();
      metaBusinessTranslationViewportSession = snapshot;
    }
    metaBusinessRestoreTranslationViewportAnchor(snapshot);
  }
}
let lineAddedTerminalLastSignature = '';
let lineAddedTerminalPendingSignature = '';
let lineAddedTerminalPendingAt = 0;
let activeTranslations = 0;
const MAX_CONCURRENT_TRANSLATIONS = 1; // V1.27.57: one local translation at a time avoids Ollama self-contention.
const queue = [];
const queuedNodes = new WeakSet();
const retryAfter = new WeakMap();
// V1.27.63 Meta atomic viewport translation. Only one viewport batch may own UI
// commits at a time. A user scroll invalidates the generation; completed provider
// results still enter cache but are never written into the abandoned viewport.
let metaBusinessViewportBatchSeq = 0;
let metaBusinessViewportBatchRunning = false;
let metaBusinessViewportBatchRescan = false;
// V1.27.79 translation-only startup/customer-switch wake lane. Meta can keep
// the inbox URL while temporarily removing/rebuilding the composer during React
// hydration. Older builds treated that transient as "not a conversation",
// cleared translations, and then waited for a later mutation/12s heartbeat.
// Keep a bounded fast-wake window so cache restoration starts as soon as the
// real composer/chat root appears, without touching GPT/CRM/customer logic.
let metaTranslationFastWakeUntil = 0;
const metaTranslationFastWakeTimers = new Set();
function kickMetaTranslationFastWake(reason = 'wake', durationMs = 9000) {
  if (platformFromHost() !== 'metabusiness') return false;
  if (!isMessagingUrl('metabusiness') || hasVisibleLoginForm()) return false;
  metaTranslationFastWakeUntil = Math.max(metaTranslationFastWakeUntil, Date.now() + Math.max(1500, Number(durationMs) || 9000));
  // A React hydration burst can emit dozens of mutations. Keep exactly one
  // bounded timer ladder instead of stacking another ladder per mutation.
  for (const timer of metaTranslationFastWakeTimers) { try { clearTimeout(timer); } catch {} }
  metaTranslationFastWakeTimers.clear();
  const delays = [0,60,140,260,450,750,1150,1700,2500,3600,5200,7600];
  for (const delay of delays) {
    const timer = setTimeout(() => {
      metaTranslationFastWakeTimers.delete(timer);
      if (document.hidden || !settings.enabled || Date.now() > metaTranslationFastWakeUntil) return;
      scheduleScan(20);
    }, delay);
    metaTranslationFastWakeTimers.add(timer);
  }
  return true;
}
// V1.27.36: delay the visible 'translating' state briefly. The main process
// already owns a persistent on-disk translation cache; a recycled/history DOM
// node can therefore get its completed translation back over IPC in a few ms.
// Showing a pending row before that cache lookup is what caused the green
// translation block to flash while scrolling.
const translationPendingTimers = new WeakMap();
const textCache = new Map();
const cacheOrder = [];
// V1.27.37: preload-owned persistent render cache. Meta virtualizes history and
// can destroy/recreate the exact bubble while scrolling. Waiting for an IPC
// round-trip to main's disk cache still leaves a visible blank/pending frame.
// Keep the completed translations in this account Profile's localStorage too,
// so a recycled bubble can restore its Chinese text synchronously before paint.
const PRELOAD_TRANSLATION_CACHE_KEY = '__yoko_translation_render_cache_v12737';
const PRELOAD_TRANSLATION_RENDER_CACHE_KEY = '__yoko_translation_render_cache_v12780';
let preloadTranslationCacheSaveTimer = null;
// V1.27.80: completed green rows are a render fact, not an engine fact. Keep a
// second engine-agnostic cache so switching Ollama/Google Web (or reopening a
// recycled Meta bubble) does not make an already-known Chinese translation
// disappear. The provider cache remains engine-aware for retranslation quality.
const renderTextCache = new Map();
const renderCacheOrder = [];
function translationRenderCacheKey(text, source=settings.source, target=settings.target) {
  const stableSource = cleanText(text).replace(/\s+/g,' ').trim();
  return `${String(source||'auto')}|${String(target||'zh')}|${stableSource}`;
}
function rememberRenderCache(key,value) {
  const k=String(key||''), v=cleanText(value||'');
  if(!k||!v)return;
  if(!renderTextCache.has(k)) renderCacheOrder.push(k);
  renderTextCache.set(k,v);
  while(renderCacheOrder.length>9000) renderTextCache.delete(renderCacheOrder.shift());
}
function hydratePreloadTranslationCache() {
  try {
    const raw = localStorage.getItem(PRELOAD_TRANSLATION_CACHE_KEY);
    const rows = raw ? JSON.parse(raw) : [];
    if (Array.isArray(rows)) {
      for (const pair of rows.slice(-6000)) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const key=String(pair[0]||''), value=cleanText(pair[1]||'');
        if (!key || !value) continue;
        textCache.set(key,value); cacheOrder.push(key);
        const parts=key.split('|');
        if(parts.length>=4){ const source=parts[1]||'auto', target=parts[2]||'zh', text=parts.slice(3).join('|'); rememberRenderCache(translationRenderCacheKey(text,source,target),value); }
      }
    }
  } catch {}
  try {
    const raw = localStorage.getItem(PRELOAD_TRANSLATION_RENDER_CACHE_KEY);
    const rows = raw ? JSON.parse(raw) : [];
    if(Array.isArray(rows)) for(const pair of rows.slice(-9000)){
      if(!Array.isArray(pair)||pair.length!==2)continue;
      rememberRenderCache(String(pair[0]||''),String(pair[1]||''));
    }
  } catch {}
}
function persistPreloadTranslationCacheSoon() {
  if (preloadTranslationCacheSaveTimer) clearTimeout(preloadTranslationCacheSaveTimer);
  preloadTranslationCacheSaveTimer=setTimeout(()=>{
    preloadTranslationCacheSaveTimer=null;
    try {
      const keys=cacheOrder.slice(-5000);
      const rows=keys.map(key=>[key,textCache.get(key)]).filter(pair=>pair[0]&&pair[1]);
      localStorage.setItem(PRELOAD_TRANSLATION_CACHE_KEY,JSON.stringify(rows));
      const renderKeys=renderCacheOrder.slice(-8000);
      const renderRows=renderKeys.map(key=>[key,renderTextCache.get(key)]).filter(pair=>pair[0]&&pair[1]);
      localStorage.setItem(PRELOAD_TRANSLATION_RENDER_CACHE_KEY,JSON.stringify(renderRows));
    } catch {}
  },120);
}
hydratePreloadTranslationCache();
// V1.23.9: virtualized chat lists (TikTok/FB/IG etc.) can destroy and recreate
// the same message DOM node while the user scrolls. Keep one in-flight request
// per message text/settings key so recycled nodes never start duplicate API calls.
const inFlightTextTranslations = new Map();
// V1.23.64: provider-confirmed unchanged text (often a customer name such as
// 'yomi') must not enter an endless retry loop. Keep a bounded settings-aware
// no-op cache just like translated text so recycled TikTok DOM nodes stay quiet.
const noTranslationTextKeys = new Set();
const noTranslationKeyOrder = [];
const failedTextRetryUntil = new Map();
const failedTextRetryOrder = [];
// V1.27.71: startup warm-up can run several times while Meta hydrates. Remember
// recent exact-cache misses briefly so those retries do not repeat the same VPS
// round-trip before Ollama becomes ready.
const exactCacheMissUntil = new Map();
const exactCacheMissOrder = [];
function rememberExactCacheMiss(key, delayMs=3500) {
  if (!key) return;
  if (!exactCacheMissUntil.has(key)) exactCacheMissOrder.push(key);
  exactCacheMissUntil.set(key,Date.now()+Math.max(1000,Number(delayMs)||3500));
  while (exactCacheMissOrder.length>1600) exactCacheMissUntil.delete(exactCacheMissOrder.shift());
}
function clearExactCacheMiss(key) { if (key) exactCacheMissUntil.delete(key); }
function rememberTranslationFailureBackoff(key, delayMs = 45000) {
  if (!key) return;
  if (!failedTextRetryUntil.has(key)) failedTextRetryOrder.push(key);
  failedTextRetryUntil.set(key, Date.now() + Math.max(10000, Number(delayMs) || 45000));
  while (failedTextRetryOrder.length > 1600) failedTextRetryUntil.delete(failedTextRetryOrder.shift());
}
function clearTranslationFailureBackoff(key) {
  if (key) failedTextRetryUntil.delete(key);
}

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


// V1.27.6 — Meta Business native selection identity.  MB does not expose a
// reliable per-row URL on every inbox build, so capture the exact customer row
// from the trusted native click before React replaces/re-hydrates the DOM.
let metaBusinessNativeSelectionHint = null;
let metaBusinessNativeSelectionSignature = '';
// V1.27.68: Meta SPA customer switches can briefly remove the old chat root and
// mount the new one after the trusted inbox click. If the only MutationObserver
// burst lands inside that gap, translation/actions never get another wake edge.
// Keep a short, bounded settle burst tied to the latest real customer click.
let metaBusinessConversationWakeEpoch = 0;
const metaBusinessConversationWakeTimers = new Set();
// V1.27.16: Meta may change the URL thread token before React finishes changing
// the visible header/selected row. Never combine an old name with a new token.
// A header-name + URL-token pair becomes durable only after two consecutive
// coherent observations; trusted row identities stay name-only unless the row
// itself exposes the same strong token.
let metaBusinessStrongPairObservation = { key:'', count:0, at:0 };

function metaBusinessStableStrongPair(name = '', token = '') {
  const n=cleanText(name).toLocaleLowerCase(), t=cleanText(token);
  if (!n || !t) return '';
  const now=Date.now(), key=`${t}|${n}`;
  if (metaBusinessStrongPairObservation.key === key && now - Number(metaBusinessStrongPairObservation.at || 0) < 5000) {
    metaBusinessStrongPairObservation={key,count:Math.min(8,Number(metaBusinessStrongPairObservation.count || 0)+1),at:now};
  } else {
    metaBusinessStrongPairObservation={key,count:1,at:now};
  }
  return metaBusinessStrongPairObservation.count >= 2 ? `mb-thread:${t}` : '';
}

function metaBusinessFreshCoherentHint(token = '') {
  const hint=metaBusinessNativeSelectionHint;
  if (!hint || Date.now() - Number(hint.at || 0) >= 8000 || !metaBusinessPlausibleNativeName(hint.name || '')) return null;
  const hintToken=metaBusinessThreadTokenFromValue(hint.chatId || hint.url || '');
  // If navigation has already moved to a different durable thread, the hint is
  // stale. Drop it instead of manufacturing {old name + new thread}.
  if (token && hintToken && token !== hintToken) {
    metaBusinessNativeSelectionHint=null;
    return null;
  }
  return { ...hint, chatId:hintToken ? `mb-thread:${hintToken}` : `name:${cleanText(hint.name)}`, url:String(location.href || '') };
}

function metaBusinessThreadTokenFromValue(value = '') {
  try {
    const u = new URL(String(value || ''), location.href);
    for (const key of ['selected_item_id','selected_thread_id','thread_id','conversation_id','conversationId','threadId','item_id']) {
      const v = cleanText(u.searchParams.get(key) || '');
      if (v) return v;
    }
    const match = String(u.pathname || '').match(/\/(?:conversation|thread|message-thread)\/([^/?#]+)/i);
    return match?.[1] ? decodeURIComponent(match[1]) : '';
  } catch { return ''; }
}

function metaBusinessNativeListGeometry() {
  if (platformFromHost() !== 'metabusiness') return null;
  const composer = metaBusinessComposer();
  const cr = composer?.getBoundingClientRect?.();
  // V1.27.28: the inbox list must remain scannable even while Meta temporarily
  // remounts/hides the composer.  Derive a conservative chat divider from the
  // visible Inbox search box when the composer is unavailable.
  const allSearches = Array.from(document.querySelectorAll('input,[role="searchbox"],[aria-label*="搜索"],[placeholder*="搜索"],[placeholder*="Search" i]'))
    .filter(isVisible)
    .filter(el => { const r=el.getBoundingClientRect(); return r.width > 140 && r.top > 35 && r.top < 360 && r.left < innerWidth * .68; });
  const searchSeed = allSearches.sort((a,b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0] || null;
  const seedRect = searchSeed?.getBoundingClientRect?.();
  const fallbackChatLeft = seedRect
    ? Math.max(seedRect.right + 72, Math.min(innerWidth * .72, seedRect.right + Math.max(86, innerWidth * .12)))
    : innerWidth * .62;
  const chatLeft = cr && cr.left > innerWidth * .28 ? cr.left : fallbackChatLeft;
  const searches = allSearches
    .filter(el => { const r=el.getBoundingClientRect(); return r.left < chatLeft - 46 && r.right < chatLeft + 12; })
    .sort((a,b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
  const search = searches[0] || searchSeed || null;
  const sr = search?.getBoundingClientRect?.();
  const listRight = chatLeft - 5;
  const listLeft = sr ? Math.max(0, sr.left - 24) : Math.max(0, listRight - Math.min(430, innerWidth * .36));
  const listWidth = Math.max(220, listRight - listLeft);
  const topLimit = sr ? sr.bottom + 38 : Math.max(90, innerHeight * .12);
  const roots = Array.from(document.querySelectorAll('[role="list"],[role="grid"],[role="feed"],div'))
    .filter(isVisible)
    .map(node => ({ node, r:node.getBoundingClientRect() }))
    .filter(x => x.r.left >= listLeft - 28 && x.r.right <= listRight + 22 && x.r.width >= listWidth * .70 && x.r.height >= 220 && x.r.bottom > topLimit + 160 && x.node.scrollHeight > x.node.clientHeight + 24)
    .sort((a,b) => (Math.abs(a.r.right-listRight)+Math.abs(a.r.left-listLeft)) - (Math.abs(b.r.right-listRight)+Math.abs(b.r.left-listLeft)));
  return { composer, chatLeft, listLeft, listRight, listWidth, topLimit, listRoot:roots[0]?.node || null };
}

function metaBusinessPlausibleNativeName(value = '') {
  const v = cleanText(value);
  if (!v || v.length > 140) return false;
  if (/^(?:Facebook|Messenger|Meta Business Suite|Meta Business|收件箱|所有消息|Instagram|WhatsApp|Facebook评论|Facebook 评论|Instagram评论|Instagram 评论|搜索|管理|未读|优先级|广告回复|后续跟进|在线|Inbox|All messages|Search|Manage|复制|複製|Copy|查看联系方式|查看聯絡方式|分配这个对话|分配此對話)$/i.test(v)) return false;
  if (/^(?:\d{1,2}:\d{2}|今天|今日|昨天|昨日|Today|Yesterday|周[一二三四五六日天]|星期[一二三四五六日天])$/i.test(v)) return false;
  if (/^(?:https?:\/\/|www\.|line\.me\/)/i.test(v) || /^(?:你|您|You)\s*[:：]/i.test(v)) return false;
  if (/(?:^|\s)(?:复制|複製|Copy)(?:\s|$)/i.test(v)) return false;
  if (/^(?:Instagram|Facebook)\s*(?:评论|評論|评论区|評論區|コメント|Comments?)/i.test(v)) return false;
  // V1.27.35: setup/navigation actions can be rendered as list rows beside
  // customer conversations (e.g. “绑定 Instagram”, “关联主页”). Never publish
  // them as customer snapshots.
  if (/^(?:(?:绑定|綁定|关联|關聯|连接|連接|连结|連結|打开|開啟|新增|添加|管理)\s*(?:Instagram|Facebook|Messenger|WhatsApp|主页|主頁|公共主页|公共主頁|粉丝专页|粉絲專頁|Page|账号|帳號)|(?:关联|關聯|绑定|綁定)\s*(?:主页|主頁))$/iu.test(v)) return false;
  if (/^(?:打开|打開|开启|開啟|关联|關聯|绑定|綁定|连接|連接|管理|新增|添加|关闭|關閉)$/u.test(v)) return false;
  if (/^(?:打开|打開|开启|開啟|关联|關聯|绑定|綁定|连接|連接|管理|新增|添加).{0,48}(?:Instagram|Facebook|Messenger|WhatsApp|主页|主頁|公共主页|公共主頁|粉丝专页|粉絲專頁|Page|账号|帳號)/iu.test(v)) return false;
  if (/(?:这个聊天包含对以下广告的回复|查看广告|Sponsored|ad reply)/i.test(v)) return false;
  return true;
}

// V1.27.77: the center header is a low-confidence identity source. Meta can
// temporarily mount the first visible chat message in the same React shell
// while switching conversations. Reject obvious sentence-shaped chat text here
// without applying the stricter rule to real left-side customer rows.
function metaBusinessPlausibleHeaderName(value = '') {
  const v=cleanText(value);
  if (!metaBusinessPlausibleNativeName(v) || v.length > 72) return false;
  if (/[。！？!?]/u.test(v) && v.length > 8) return false;
  if (v.length > 9 && /(?:です|ます|ですよ|ですね|だよ|だね|でした|ました|ません|でしょう|ください|ありがとう(?:ございます)?|おはようございます|よろしく(?:お願い)?します)[〜~ー…\s]*$/u.test(v)) return false;
  if (v.length > 10 && /^(?:俺|私|僕|わたし|あなた|優子|Yoko).{3,}(?:です|ます|ですよ|ですね|だよ|だね)$/iu.test(v)) return false;
  return true;
}

function metaBusinessNativeRowFromSeed(seed, geometry = null) {
  const g = geometry || metaBusinessNativeListGeometry();
  if (!g || !(seed instanceof Element)) return null;
  const rowShape = node => {
    if (!(node instanceof Element) || !isVisible(node)) return false;
    if (g.listRoot && !g.listRoot.contains(node)) return false;
    const r=node.getBoundingClientRect();
    if (r.left < g.listLeft - 28 || r.right > g.listRight + 22 || r.width < g.listWidth * .58 || r.width > g.listWidth * 1.10 || r.height < 43 || r.height > 128) return false;
    const lines=String(node.innerText || '').split(/\n+/).map(cleanText).filter(Boolean);
    return lines.length > 0 && lines.length <= 10 && lines.some(metaBusinessPlausibleNativeName);
  };
  let node=seed,best=null;
  for (let depth=0; node && depth<9; depth+=1,node=node.parentElement) {
    if (g.listRoot && node === g.listRoot) break;
    if (!rowShape(node)) continue;
    const r=node.getBoundingClientRect();
    const score=Math.max(0,90-Math.abs(r.width-g.listWidth)*.3)+Math.max(0,45-Math.abs(r.height-72)*.6)+(node.matches('[role="listitem"],[role="row"]')?40:0);
    if (!best || score > best.score) best={node,score};
  }
  return best?.node || null;
}

function metaBusinessNativeRowNameLooksComposite(value = '') {
  const v=cleanText(value);
  if (!v) return false;
  // V1.27.85: Meta occasionally exposes a parent node whose textContent is
  // customer-name + preview + relative timestamp without line breaks. That is
  // never a real customer name. Reject it before it can become a GPT target.
  if (/(?:今天|今日|昨天|昨日|Today|Yesterday)\s*\d{1,2}:\d{2}\s*$/iu.test(v)) return true;
  if (/\d{1,2}:\d{2}\s*$/u.test(v) && v.length > 32) return true;
  return false;
}

function metaBusinessIdentityFromNativeRow(row) {
  if (!row) return null;
  const rr=row.getBoundingClientRect();
  const candidates=Array.from(row.querySelectorAll('strong,[dir="auto"],span,a,div')).filter(isVisible).map(el=>{
    const t=cleanText(el.textContent || '');
    const r=el.getBoundingClientRect();
    let weight=400;try{weight=parseInt(getComputedStyle(el).fontWeight,10)||400}catch{}
    const childTexts=Array.from(el.children || []).filter(isVisible).map(child=>cleanText(child.textContent || '')).filter(Boolean);
    const compositeChildren=childTexts.length >= 2 && childTexts.some(text=>text !== t);
    const rowHeightLike=r.height > Math.max(44,rr.height*.68);
    return {el,t,r,weight,compositeChildren,rowHeightLike};
  }).filter(x=>x.t && !x.t.includes('\n') && metaBusinessPlausibleNativeName(x.t) && !metaBusinessNativeRowNameLooksComposite(x.t) && !x.compositeChildren && !x.rowHeightLike && x.r.top>=rr.top-2 && x.r.bottom<=rr.bottom+2 && x.r.left>=rr.left-2 && x.r.right<=rr.right+4)
    .map(x=>{
      const relTop=Math.max(0,x.r.top-rr.top);
      const relLeft=Math.max(0,x.r.left-rr.left);
      const score=(x.weight>=600?70:0)+(x.el.matches('strong')?55:0)+Math.max(0,90-relTop*2.1)+Math.max(0,38-Math.abs(relLeft-Math.min(72,rr.width*.24))*.35)-Math.max(0,x.t.length-48)*.7;
      return {...x,score};
    }).sort((a,b)=>b.score-a.score||a.r.top-b.r.top||a.r.left-b.r.left);
  const lines=String(row.innerText || '').split(/\n+/).map(cleanText).filter(Boolean);
  const cleanLine=lines.find(value=>metaBusinessPlausibleNativeName(value) && !metaBusinessNativeRowNameLooksComposite(value)) || '';
  // Prefer a compact leaf/near-leaf text node. The full-row ancestor often
  // concatenates name + preview + time and was the root cause of V1.27.84's
  // Yamlal/田中 identity pollution.
  const name=candidates[0]?.t || cleanLine || '';
  if (!name) return null;
  // V1.27.84: Meta's virtual inbox can recycle an old row href while the
  // visible name has already changed. The trusted pointer click therefore owns
  // a NAME identity first; the row href is only retained as a diagnostic hint.
  // A strong thread id may be adopted later only from coherent/hydrated state.
  let token='';
  for (const a of row.querySelectorAll('a[href]')) {
    token=metaBusinessThreadTokenFromValue(a.getAttribute('href') || a.href || '');
    if (token) break;
  }
  const imgs=Array.from(row.querySelectorAll('img')).filter(isVisible).sort((a,b) => {
    const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();
    return Math.abs(ar.width-ar.height)-Math.abs(br.width-br.height);
  });
  const avatar=imgs[0] || null;
  return { name, handle:'', chatId:`name:${name}`, rowThreadHint:token ? `mb-thread:${token}` : '', avatarUrl, url:String(location.href || ''), at:Date.now() };
}

// V1.27.77: resolve a conversation row from the trusted pointer coordinates,
// not only from Meta's current wrapper ancestry. React can recycle the clicked
// wrapper between pointerdown/click while its visual row is still under the same
// Y coordinate.
function metaBusinessNativeRowFromPoint(x = 0, y = 0, geometry = null) {
  const g=geometry || metaBusinessNativeListGeometry();
  if (!g) return null;
  const px=Number(x||0), py=Number(y||0);
  if (px < g.listLeft-26 || px > g.listRight+26 || py < g.topLimit-58 || py > innerHeight-10) return null;
  const direct=document.elementFromPoint(px,py);
  const directRow=metaBusinessNativeRowFromSeed(direct,g);
  if (directRow) return directRow;
  const scope=g.listRoot || document;
  const rows=[];
  for (const node of scope.querySelectorAll('[role="listitem"],[role="row"],li,div')) {
    if (!(node instanceof Element) || !isVisible(node)) continue;
    const r=node.getBoundingClientRect();
    if (py < r.top-1 || py > r.bottom+1 || px < r.left-18 || px > r.right+18) continue;
    if (r.left < g.listLeft-40 || r.right > g.listRight+40 || r.width < g.listWidth*.42 || r.width > g.listWidth*1.28 || r.height < 34 || r.height > 158) continue;
    const identity=metaBusinessIdentityFromNativeRow(node);
    if (!identity?.name) continue;
    const score=(node.matches('[role="listitem"],[role="row"]')?90:0)+Math.max(0,90-Math.abs(r.height-72)*1.2)+Math.max(0,60-Math.abs(r.width-g.listWidth)*.25)-Math.max(0,r.height-100)*2;
    rows.push({node,score,area:r.width*r.height});
  }
  rows.sort((a,b)=>b.score-a.score||a.area-b.area);
  return rows[0]?.node || null;
}

function metaBusinessSelectedNativeRowIdentity() {
  try {
    const g=metaBusinessNativeListGeometry();
    if (!g) return null;
    const scope=g.listRoot || document;
    const selected=Array.from(scope.querySelectorAll('[aria-selected="true"],[aria-current="true"],[data-state="selected"],[data-state="active"]')).filter(isVisible);
    for (const el of selected) {
      const er=el.getBoundingClientRect();
      const row=metaBusinessNativeRowFromSeed(el,g) || metaBusinessNativeRowFromPoint((er.left+er.right)/2,(er.top+er.bottom)/2,g);
      const identity=metaBusinessIdentityFromNativeRow(row);
      if (identity?.name) return {...identity,identitySource:'selected-row'};
    }
    const active=document.activeElement;
    if (active instanceof Element && scope.contains(active)) {
      const row=metaBusinessNativeRowFromSeed(active,g);
      const identity=metaBusinessIdentityFromNativeRow(row);
      if (identity?.name) return {...identity,identitySource:'selected-row'};
    }
  } catch {}
  return null;
}

// V1.27.39: Meta sometimes renders the active/selected conversation row with a
// slightly different wrapper shape than ordinary rows. The generic inbox row
// scanner can therefore miss the exact customer that is visibly open in the
// native inbox (real case: 金子周平). Resolve the active row again by its exact
// visible name so a selected customer can never disappear from Yoko's mirror.
function metaBusinessNativeRowByExactName(name = '') {
  const wanted=cleanText(name);
  if (!wanted || !metaBusinessPlausibleNativeName(wanted)) return null;
  const g=metaBusinessNativeListGeometry();
  if (!g) return null;
  const scope=g.listRoot || document;
  const nodes=Array.from(scope.querySelectorAll('strong,span,[dir="auto"],[role="gridcell"],[role="cell"]'));
  for (const node of nodes) {
    if (!isVisible(node) || cleanText(node.textContent || '') !== wanted) continue;
    const row=metaBusinessNativeRowFromSeed(node, g);
    if (row) return row;
    // Selected rows can be a few pixels wider/taller than the generic shape
    // gate. Fall back to the nearest visible list child with sane geometry.
    let cur=node;
    for (let depth=0; cur && depth<8; depth+=1,cur=cur.parentElement) {
      if (!(cur instanceof Element) || (g.listRoot && !g.listRoot.contains(cur))) continue;
      const r=cur.getBoundingClientRect();
      if (r.left < g.listLeft-38 || r.right > g.listRight+38 || r.width < g.listWidth*.45 || r.width > g.listWidth*1.24 || r.height < 34 || r.height > 154) continue;
      const lines=String(cur.innerText || '').split(/\n+/).map(cleanText).filter(Boolean);
      if (lines.includes(wanted)) return cur;
    }
  }
  return null;
}

function metaBusinessNativeInboxOwnPreview(value = '') {
  const v = cleanText(value);
  if (!v) return false;
  return /^(?:你|您|You|あなた)\s*[:：]/iu.test(v) ||
    /^(?:你|您)\s*(?:发送了|發送了|传送了|傳送了|已发送|已發送|回复了|回覆了)/u.test(v) ||
    /^You\s+(?:sent|replied|shared|responded)\b/iu.test(v) ||
    /^(?:(?:あなた|自分)が\s*)?(?:送信しました|送信した|返信しました|返信した|送った|送りました)(?:[：:\s]|$)/u.test(v);
}

function metaBusinessNativeInboxTime(value = '') {
  const v = cleanText(value);
  return /^(?:\d{1,2}:\d{2}|今天|今日|昨天|昨日|Today|Yesterday|周[一二三四五六日天](?:\s*\d{1,2}:\d{2})?|星期[一二三四五六日天]|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?|\d+\s*(?:分钟|分鐘|分钟前|分前|小时|小時|小时前|minutes?|mins?|hours?|hrs?))/i.test(v);
}

function metaBusinessNativeAvatarSource(row) {
  try {
    if (!(row instanceof Element)) return '';
    const rr = row.getBoundingClientRect();
    const found = [];
    const add = (el, raw, kind = 'img') => {
      const src = String(raw || '').trim();
      if (!/^https:\/\//i.test(src) || !(el instanceof Element) || !isVisible(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width < 18 || r.height < 18 || r.width > 110 || r.height > 110) return;
      const ratio = r.width / Math.max(1, r.height);
      if (ratio < .62 || ratio > 1.62) return;
      if (r.right < rr.left - 4 || r.left > rr.right + 4 || r.bottom < rr.top - 4 || r.top > rr.bottom + 4) return;
      // Real Meta inbox avatars sit near the left edge and are roughly 32–56px.
      // SVG <image> and CSS background images are common in newer Meta builds,
      // so do not assume an <img> node exists just because the operator sees a photo.
      const centerX = r.left + r.width / 2;
      const expectedX = rr.left + Math.min(34, Math.max(22, rr.height * .34));
      const squarePenalty = Math.abs(r.width - r.height) * 2.4;
      const sizePenalty = Math.abs(Math.max(r.width, r.height) - 40) * .7;
      const leftPenalty = Math.abs(centerX - expectedX) * .55;
      const kindBonus = kind === 'img' ? 0 : (kind === 'svg' ? 3 : 7);
      found.push({ src, score:squarePenalty + sizePenalty + leftPenalty + kindBonus, left:r.left });
    };
    for (const img of row.querySelectorAll('img')) add(img, img.currentSrc || img.src || img.getAttribute('src'), 'img');
    for (const image of row.querySelectorAll('svg image,image')) {
      add(image,
        image.getAttribute('href') ||
        image.getAttribute('xlink:href') ||
        image.getAttributeNS?.('http://www.w3.org/1999/xlink','href') || '',
        'svg');
    }
    // Meta sometimes paints the avatar as a CSS background rather than an img.
    // Bound the scan so this read-only fallback cannot become a heavy DOM walk.
    const bgNodes = Array.from(row.querySelectorAll('div,span,i')).slice(0, 90);
    for (const el of bgNodes) {
      if (!isVisible(el)) continue;
      let bg = '';
      try { bg = String(getComputedStyle(el).backgroundImage || ''); } catch {}
      const m = bg.match(/url\(["']?(https:\/\/[^"')]+)["']?\)/i);
      if (m) add(el, m[1], 'css');
    }
    found.sort((a,b)=>a.score-b.score || a.left-b.left);
    return String(found[0]?.src || '').trim();
  } catch { return ''; }
}

function metaBusinessNativeInboxSnapshot() {
  try {
    if (platformFromHost() !== 'metabusiness') return { rows:[], selected:null, url:String(location.href || ''), at:Date.now() };
    const g = metaBusinessNativeListGeometry();
    if (!g) return { rows:[], selected:currentMetaBusinessNativeChatIdentity(), url:String(location.href || ''), at:Date.now() };
    const scope = g.listRoot || document;
    const seeds = Array.from(scope.querySelectorAll('[role="listitem"],[role="row"],[role="button"],button,a[href],img,[tabindex],li'));
    const seenRows = new Set();
    const out = [];
    const parse = row => {
      if (!(row instanceof Element) || !isVisible(row)) return null;
      const r = row.getBoundingClientRect();
      if (r.left < g.listLeft - 34 || r.right > g.listRight + 28 || r.width < g.listWidth * .50 || r.width > g.listWidth * 1.16 || r.height < 40 || r.height > 136) return null;
      const lines = String(row.innerText || '').split(/\n+/).map(cleanText).filter(Boolean);
      const name = lines.find(metaBusinessPlausibleNativeName) || '';
      if (!name) return null;
      const timeText = lines.find((x,i) => i > 0 && metaBusinessNativeInboxTime(x)) || '';
      const handle = (lines.find(x => /^@[A-Za-z0-9_.-]{2,}$/.test(x)) || '').replace(/^@/, '');
      const preview = lines.find((x,i) => i > 0 && x !== name && x !== timeText && x !== ('@'+handle) && !metaBusinessNativeInboxTime(x) && !/^已读$|^已讀$|^Read$|^未读$|^未讀$|^Unread$/i.test(x) && !metaBusinessExcludedUiText(x) && x.length <= 650) || '';
      let href='', token='';
      for (const a of row.querySelectorAll('a[href]')) {
        const h=String(a.getAttribute('href') || a.href || '');
        const t=metaBusinessThreadTokenFromValue(h);
        if (t) { href=h; token=t; break; }
        if (!href) href=h;
      }
      const avatarUrl=metaBusinessNativeAvatarSource(row);
      let unreadCount=0;
      const badge=row.querySelector('[aria-label*="unread" i],[aria-label*="未读"],[aria-label*="未讀"],[data-testid*="unread" i],[class*="unread" i],[class*="badge" i]');
      if (badge) { const n=parseInt(cleanText(badge.textContent || ''),10); unreadCount=Number.isFinite(n)?Math.max(1,n):1; }
      const rootRect=g.listRoot?.getBoundingClientRect?.();
      const nativeOffset=g.listRoot && rootRect ? Math.max(0,Math.round((r.top-rootRect.top)+Number(g.listRoot.scrollTop||0))) : Math.max(0,Math.round(r.top-g.topLimit));
      return {
        chatId:token ? `mb-thread:${token}` : '', name, handle,
        avatarUrl:String(avatar?.currentSrc || avatar?.src || '').trim(),
        preview, timeText, lastDirection:preview ? (metaBusinessNativeInboxOwnPreview(preview) ? 'me' : 'customer') : '',
        unreadCount, href, top:Math.round(r.top), nativeOffset, order:nativeOffset
      };
    };
    for (const seed of seeds) {
      if (!isVisible(seed)) continue;
      const row = metaBusinessNativeRowFromSeed(seed, g);
      if (!row || seenRows.has(row)) continue;
      seenRows.add(row);
      const parsed = parse(row);
      if (parsed) out.push(parsed);
    }
    if (g.listRoot) {
      for (const row of g.listRoot.querySelectorAll('div,li,[role="listitem"],[role="row"]')) {
        if (seenRows.has(row)) continue;
        const parsed=parse(row);
        if (!parsed) continue;
        seenRows.add(row); out.push(parsed);
      }
    }

    // V1.27.39: hard-include the currently open native customer when the
    // generic scanner missed the selected row wrapper. This does NOT couple
    // scroll positions; it only guarantees row existence/order facts.
    const selected=currentMetaBusinessNativeChatIdentity();
    if (selected?.name && metaBusinessPlausibleNativeName(selected.name)) {
      const selectedName=cleanText(selected.name);
      const selectedCanonical=metaBusinessThreadTokenFromValue(selected.chatId || selected.url || '');
      const already=out.some(row => {
        const rowCanonical=metaBusinessThreadTokenFromValue(row.chatId || row.href || '');
        return cleanText(row.name) === selectedName || (!!selectedCanonical && !!rowCanonical && selectedCanonical === rowCanonical);
      });
      if (!already) {
        const selectedRow=metaBusinessNativeRowByExactName(selectedName);
        let forced=selectedRow ? parse(selectedRow) : null;
        if (!forced && selectedRow) {
          const r=selectedRow.getBoundingClientRect();
          const lines=String(selectedRow.innerText || '').split(/\n+/).map(cleanText).filter(Boolean);
          const timeText=lines.find((x,i)=>i>0&&metaBusinessNativeInboxTime(x)) || '';
          const preview=lines.find((x,i)=>i>0&&x!==selectedName&&x!==timeText&&!metaBusinessNativeInboxTime(x)&&!/^已读$|^已讀$|^Read$|^未读$|^未讀$|^Unread$/i.test(x)&&!metaBusinessExcludedUiText(x)&&x.length<=650) || '';
          const rootRect=g.listRoot?.getBoundingClientRect?.();
          const nativeOffset=g.listRoot&&rootRect?Math.max(0,Math.round((r.top-rootRect.top)+Number(g.listRoot.scrollTop||0))):Math.max(0,Math.round(r.top-g.topLimit));
          forced={
            chatId:String(selected.chatId||''), name:selectedName, handle:String(selected.handle||''), avatarUrl:String(selected.avatarUrl||''),
            preview,timeText,lastDirection:preview?(metaBusinessNativeInboxOwnPreview(preview)?'me':'customer'):'',unreadCount:0,
            href:String(selected.url||''),top:Math.round(r.top),nativeOffset,order:nativeOffset,selectedFallback:true
          };
        }
        // If the list row is virtualized away we don't invent a visual rank.
        // The trusted selection IPC still keeps the customer identity alive in
        // main; once the row becomes visible, this branch gains exact geometry.
        if (forced) out.push(forced);
      }
    }
    const byKey=new Map();
    for (const row of out) {
      // V1.27.40: NEVER collapse two different visible people merely because
      // Meta exposed the same stale/generic thread token on both rows.  That
      // happened in the real inbox and made 金子周平 disappear before main ever
      // saw him. Exact display name is the primary live-row identity; thread is
      // only a fallback when no usable name exists.
      const nameKey=cleanText(row.name || '').toLocaleLowerCase();
      const threadKey=String(row.chatId || '').toLowerCase();
      const key=nameKey ? `name:${nameKey}` : (threadKey || `avatar:${String(row.avatarUrl || '').split('?')[0].toLowerCase()}`);
      const old=byKey.get(key);
      if (!old) { byKey.set(key,row); continue; }
      const oldOffset=Number(old.nativeOffset), rowOffset=Number(row.nativeOffset);
      const mergedOffset=Number.isFinite(oldOffset) && Number.isFinite(rowOffset) ? Math.min(oldOffset,rowOffset) : (Number.isFinite(rowOffset)?rowOffset:(Number.isFinite(oldOffset)?oldOffset:0));
      byKey.set(key,{...old,...row,preview:row.preview||old.preview,lastDirection:row.preview?(row.lastDirection||old.lastDirection):old.lastDirection,unreadCount:Math.max(Number(old.unreadCount||0),Number(row.unreadCount||0)),nativeOffset:mergedOffset,order:mergedOffset,top:Math.min(Number(old.top||row.top||0),Number(row.top||old.top||0))});
    }
    // V1.27.30: visual top-to-bottom geometry is the only reliable live order.
    // Meta's virtual scroller may report a transformed/negative scrollTop and an
    // absolute offset that does not correspond to what the operator sees.  The
    // previous build sorted by nativeOffset and could therefore mirror the inbox
    // backwards.  Sort the currently rendered native rows by their real screen
    // top, then attach an explicit snapshot rank for main/renderer ordering.
    const listScrollTop=Number(g.listRoot?.scrollTop || 0) || 0;
    const topTolerance=Math.max(24,Number(g.listRoot?.clientHeight||0)*.05);
    const atTop=!g.listRoot || Math.max(0,listScrollTop) <= topTolerance;
    const rows=[...byKey.values()]
      .sort((a,b)=>Number(a.top||0)-Number(b.top||0) || Number(a.nativeOffset||0)-Number(b.nativeOffset||0))
      .slice(0,180)
      .map((row,index)=>({...row,nativeVisualTop:Number(row.top||0)||0,nativeSnapshotRank:index}));
    return { rows, selected:selected || currentMetaBusinessNativeChatIdentity(), url:String(location.href || ''), at:Date.now(), listScrollTop, atTop };
  } catch (error) {
    return { rows:[], selected:null, url:String(location.href || ''), at:Date.now(), error:String(error?.message || error) };
  }
}

function publishMetaBusinessInboxSnapshot(force = false) {
  try {
    if (platformFromHost() !== 'metabusiness' || document.hidden) return false;
    const snapshot=metaBusinessNativeInboxSnapshot();
    if (!snapshot.rows.length) return false;
    const selectedSig=snapshot.selected?`${snapshot.selected.chatId||''}|${snapshot.selected.name||''}`:'';
    const signature=crmSignature(`${selectedSig}\u001d${snapshot.rows.slice(0,80).map(row=>`${row.chatId||row.name}|${row.preview||''}|${row.timeText||''}|${row.lastDirection||''}|${Number(row.unreadCount||0)}`).join('\u001e')}`);
    if (!force && signature === metaBusinessInboxLastSignature) return false;
    metaBusinessInboxLastSignature=signature;
    ipcRenderer.send('external-metabusiness-inbox-snapshot', snapshot);
    return true;
  } catch { return false; }
}


function publishMetaBusinessAvatarMirror(force = false) {
  try {
    if (platformFromHost() !== 'metabusiness' || document.hidden) return false;
    const snapshot = metaBusinessNativeInboxSnapshot();
    const raw = [];
    if (snapshot?.selected?.name && snapshot?.selected?.avatarUrl) raw.push({ ...snapshot.selected, preview:'' , timeText:'' });
    for (const row of Array.isArray(snapshot?.rows) ? snapshot.rows : []) raw.push(row);
    const byKey = new Map();
    for (const row of raw) {
      const name=cleanText(row?.name || row?.displayName || '').slice(0,180);
      const avatarUrl=String(row?.avatarUrl || '').trim().slice(0,4000);
      if(!name || !/^https:\/\//i.test(avatarUrl)) continue;
      let base=avatarUrl;try{const u=new URL(avatarUrl);u.search='';u.hash='';base=u.toString();}catch{}
      const key=`${name.toLocaleLowerCase()}|${base}`;
      const old=byKey.get(key);
      const next={name,preview:cleanText(row?.preview||'').slice(0,1200),timeText:cleanText(row?.timeText||'').slice(0,120),avatarUrl};
      byKey.set(key,old?{...old,...next,preview:next.preview||old.preview,timeText:next.timeText||old.timeText}:next);
    }
    const rows=[...byKey.values()].slice(0,80);
    if(!rows.length)return false;
    const signature=crmSignature(rows.map(row=>`${row.name}\u001f${row.preview}\u001f${String(row.avatarUrl||'').split('?')[0]}`).join('\u001e'));
    if(!force&&signature===metaBusinessAvatarMirrorLastSignature)return false;
    metaBusinessAvatarMirrorLastSignature=signature;
    ipcRenderer.send('external-metabusiness-avatar-mirror',{rows,at:Date.now(),url:String(location.href||'').slice(0,1800)});
    return true;
  } catch { return false; }
}

function scheduleMetaBusinessAvatarMirror(delay = 160, force = false) {
  if(platformFromHost()!=='metabusiness')return;
  if(metaBusinessAvatarMirrorTimer)clearTimeout(metaBusinessAvatarMirrorTimer);
  metaBusinessAvatarMirrorTimer=setTimeout(()=>{metaBusinessAvatarMirrorTimer=null;publishMetaBusinessAvatarMirror(force);},Math.max(40,Number(delay)||160));
}

function scheduleMetaBusinessInboxSnapshot(_delay = 180) {
  // V1.27.41: MB aggregate/list mirroring was removed. Keep this compatibility
  // function as a no-op so old callers cannot accidentally restart list scans.
  if (metaBusinessInboxSnapshotTimer) { clearTimeout(metaBusinessInboxSnapshotTimer); metaBusinessInboxSnapshotTimer = null; }
}

function startMetaBusinessInboxHeartbeat() {
  // V1.27.41 native-only: never scan the official MB customer list in the
  // background. Translation/CRM read only the currently open native chat.
  if (metaBusinessInboxHeartbeatTimer) clearInterval(metaBusinessInboxHeartbeatTimer);
  metaBusinessInboxHeartbeatTimer = null;
}

function metaBusinessCurrentHeaderIdentity() {
  try {
    if (platformFromHost() !== 'metabusiness') return null;
    const root = metaBusinessChatRoot();
    const composer = metaBusinessComposer();
    if (!root || !composer) return null;
    const rr = root.getBoundingClientRect();
    const cr = composer.getBoundingClientRect();
    const headerTop = Math.max(28, rr.top - 10);
    const headerBottom = Math.min(cr.top - 100, rr.top + Math.max(120, Math.min(230, rr.height * .24)));
    if (headerBottom <= headerTop + 24) return null;

    const avatars = Array.from(root.querySelectorAll('img')).filter(isVisible).filter(img => {
      const r = img.getBoundingClientRect();
      return r.top >= headerTop - 8 && r.bottom <= headerBottom + 20 &&
        r.left >= rr.left - 8 && r.left <= rr.left + Math.min(190, rr.width * .34) &&
        r.width >= 24 && r.width <= 88 && r.height >= 24 && r.height <= 88;
    }).sort((a,b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left);

    const findNameNear = (avatar) => {
      if (!avatar) return '';
      const ar = avatar.getBoundingClientRect();
      let node = avatar.parentElement;
      for (let depth=0; node && depth<7; depth+=1, node=node.parentElement) {
        if (!(node instanceof Element) || !root.contains(node)) continue;
        const nr=node.getBoundingClientRect();
        if (nr.height > 170 || nr.width > Math.min(860,rr.width*.96)) continue;
        const texts=Array.from(node.querySelectorAll('strong,h1,h2,h3,[dir="auto"],span')).filter(isVisible).map(el=>({
          t:cleanText(el.textContent||''), r:el.getBoundingClientRect(), el
        })).filter(x => x.r.top >= headerTop-8 && x.r.bottom <= headerBottom+24 && x.r.left >= ar.right-12 && !x.el.closest?.(`[${SOURCE_ATTR}]`) && metaBusinessPlausibleHeaderName(x.t));
        if (texts.length) return texts.sort((a,b)=>a.r.top-b.r.top||a.r.left-b.r.left)[0].t;
      }
      return '';
    };

    let avatar = avatars[0] || null;
    let name = findNameNear(avatar);
    if (!name) {
      const candidates = Array.from(root.querySelectorAll('strong,h1,h2,h3,[dir="auto"]')).filter(isVisible).map(el=>({
        t:cleanText(el.textContent||''), r:el.getBoundingClientRect(), el
      })).filter(x => x.r.top >= headerTop-8 && x.r.bottom <= headerBottom+24 && x.r.left >= rr.left && x.r.left <= rr.left + rr.width*.62 && !x.el.closest?.(`[${SOURCE_ATTR}]`) && metaBusinessPlausibleHeaderName(x.t));
      if (candidates.length) name = candidates.sort((a,b)=>a.r.top-b.r.top||a.r.left-b.r.left)[0].t;
    }
    if (!name) return null;
    if (!avatar) avatar = avatars.find(img => Math.abs(img.getBoundingClientRect().top-headerTop) < 120) || null;
    return { name, handle:'', avatarUrl:String(avatar?.currentSrc || avatar?.src || '').trim() };
  } catch { return null; }
}

function currentMetaBusinessNativeChatIdentity() {
  if (platformFromHost() !== 'metabusiness') return null;
  const token=metaBusinessThreadTokenFromValue(location.href);

  // V1.27.77: the left selected row / trusted row click owns the switch. Meta's
  // center header can remain on the previous customer for hydration frames and
  // can even expose a visible message where the customer name normally lives.
  const selectedRow=metaBusinessSelectedNativeRowIdentity();
  if (selectedRow?.name) {
    // Keep the trusted selected-row identity name-first. The virtual row href
    // is not authoritative enough to route GPT history by itself.
    const rowToken=metaBusinessThreadTokenFromValue(selectedRow.rowThreadHint || selectedRow.chatId || selectedRow.url || '');
    const chatId=`name:${selectedRow.name}`;
    return {...selectedRow,chatId,rowThreadHint:rowToken ? `mb-thread:${rowToken}` : String(selectedRow.rowThreadHint || ''),url:String(location.href||''),at:Date.now(),identitySource:'selected-row'};
  }

  const coherentHint=metaBusinessFreshCoherentHint(token);
  const hintAge=metaBusinessNativeSelectionHint ? Date.now()-Number(metaBusinessNativeSelectionHint.at||0) : Infinity;
  if (coherentHint && hintAge < 5000) return {...coherentHint,identitySource:'trusted-row-click'};

  const header = metaBusinessCurrentHeaderIdentity();
  if (header?.name) {
    const stableStrong=metaBusinessStableStrongPair(header.name,token);
    return { ...header, chatId:stableStrong || `name:${header.name}`, url:String(location.href||''), at:Date.now(), identitySource:'header' };
  }

  if (coherentHint) return {...coherentHint,identitySource:'trusted-selection-hint'};
  return token ? { name:'', handle:'', chatId:`mb-thread:${token}`, avatarUrl:'', url:String(location.href || ''), at:Date.now(), identitySource:'thread-only' } : null;
}

function emitMetaBusinessNativeChatSelection(identity, reason='native-click') {
  try {
    if (!identity || !identity.name) return false;
    if (reason === 'native-row-click') metaBusinessNativeSelectionHint={...identity,reason,at:Date.now()};
    const signature=[identity.chatId||'',identity.name,identity.avatarUrl||'',reason].join('|');
    if (signature === metaBusinessNativeSelectionSignature) return true;
    metaBusinessNativeSelectionSignature=signature;
    ipcRenderer.send('external-native-chat-selected',{...identity,reason,at:Date.now()});
    return true;
  } catch { return false; }
}

function scheduleMetaBusinessConversationWake(reason='native-row-click') {
  if (platformFromHost() !== 'metabusiness') return false;
  const epoch=++metaBusinessConversationWakeEpoch;
  // Customer-specific CRM de-dupe must not suppress the first extraction from
  // the newly mounted conversation. Translation text caches remain intact.
  crmExtractLastSignature='';
  const delays=[45,140,320,650,1100,1800,2800];
  delays.forEach((delay,index) => {
    const timer=setTimeout(() => {
      metaBusinessConversationWakeTimers.delete(timer);
      if (epoch !== metaBusinessConversationWakeEpoch || document.hidden) return;
      try {
        if (index===0 || index===3) void refreshSettings();
        scheduleScan(index < 3 ? 70 : 120);
        scheduleCustomerCopyActions(index < 3 ? 55 : 100);
        scheduleCrmAutoExtract(index < 3 ? 130 : 220);
        const identity=currentMetaBusinessNativeChatIdentity();
        if (identity?.name) emitMetaBusinessNativeChatSelection(identity,index < 2 ? 'native-header-settle' : 'native-header-hydrated');
      } catch {}
    },delay);
    metaBusinessConversationWakeTimers.add(timer);
  });
  return true;
}

function captureMetaBusinessTrustedInboxSelection(event, phase='click') {
  if (!event?.isTrusted || platformFromHost() !== 'metabusiness') return false;
  try {
    const g=metaBusinessNativeListGeometry();
    if (!g) return false;
    const x=Number(event.clientX||0), y=Number(event.clientY||0);
    const inboxIntent=x >= g.listLeft-24 && x <= g.listRight+28 && y >= g.topLimit-58 && y <= innerHeight-10;
    if (!inboxIntent) return false;
    const row=metaBusinessNativeRowFromSeed(event.target,g) || metaBusinessNativeRowFromPoint(x,y,g);
    const identity=metaBusinessIdentityFromNativeRow(row);
    if (identity?.name) {
      emitMetaBusinessNativeChatSelection(identity,'native-row-click');
      scheduleCrmAutoExtract(phase==='pointerdown'?120:180);
    } else if (phase === 'pointerdown') {
      // The click is unquestionably in the inbox, even if Meta changed the row
      // wrapper. Fence the previous customer now; never keep showing/using it.
      metaBusinessNativeSelectionHint=null;
      metaBusinessNativeSelectionSignature='';
      ipcRenderer.send('external-native-chat-selection-pending',{reason:'native-inbox-click-pending',at:Date.now(),x:Math.round(x),y:Math.round(y)});
    }
    scheduleMetaBusinessConversationWake(identity ? 'native-row-click' : 'native-inbox-click');
    return true;
  } catch { return false; }
}

document.addEventListener('pointerdown', event => {
  if (!event?.isTrusted || platformFromHost() !== 'metabusiness') return;
  captureMetaBusinessTrustedInboxSelection(event,'pointerdown');
}, true);

document.addEventListener('click', event => {
  if (!event?.isTrusted) return;
  const platform=platformFromHost();
  if (platform === 'tiktok') scheduleTikTokNativeChatSelection('native-click');
  if (platform === 'metabusiness') { captureMetaBusinessTrustedInboxSelection(event,'click'); scheduleMetaBusinessAvatarMirror(120); }
}, true);

function metaBusinessComposerValue(composer) {
  if (!composer) return '';
  try {
    if ('value' in composer) return cleanText(composer.value || '');
    return cleanText(composer.innerText || composer.textContent || '');
  } catch { return ''; }
}

let metaBusinessOutgoingConfirmTimer = null;
let metaBusinessOutgoingConfirmSequence = 0;
function metaBusinessLatestOwnBubbleSnapshot() {
  try {
    const rows = candidateElements(false).map(node => {
      if (!(node instanceof Element) || metaBusinessReplyQuotePreview(node)) return null;
      const role = metaBusinessMessageRoleByLane(node) || crmMessageRole(node);
      if (role !== 'me') return null;
      const r = node.getBoundingClientRect();
      const source = cleanText(node.getAttribute?.(SOURCE_ATTR) || '') || messageText(node);
      if (!source) return null;
      return { source, top:Math.round(r.top), left:Math.round(r.left), width:Math.round(r.width) };
    }).filter(Boolean).sort((a,b) => a.top-b.top || a.left-b.left);
    const latest = rows[rows.length - 1] || null;
    if (!latest) return null;
    return { ...latest, signature:`${latest.source}|${latest.top}|${latest.left}|${latest.width}` };
  } catch { return null; }
}
function scheduleMetaBusinessOutgoingConfirmation(reason = 'native-send') {
  if (platformFromHost() !== 'metabusiness') return;
  const composer = metaBusinessComposer();
  const before = metaBusinessComposerValue(composer);
  if (!composer || !before) return;
  const identity = currentMetaBusinessNativeChatIdentity();
  if (!identity || (!identity.name && !identity.chatId)) return;
  const beforeOwnBubble = metaBusinessLatestOwnBubbleSnapshot();
  if (metaBusinessOutgoingConfirmTimer) clearTimeout(metaBusinessOutgoingConfirmTimer);
  const sequence = ++metaBusinessOutgoingConfirmSequence;
  const startedAt = Date.now();
  const confirm = () => {
    if (sequence !== metaBusinessOutgoingConfirmSequence) return;
    try {
      const current = metaBusinessComposerValue(metaBusinessComposer());
      // V1.27.21: Meta can consume/send the editor several hundred ms after the
      // key/click event. Poll for a short bounded window instead of checking only
      // once at 420 ms; otherwise a real successful reply can be missed and the
      // aggregate card remains incorrectly in 待回复.
      const latestOwnBubble = metaBusinessLatestOwnBubbleSnapshot();
      const bubbleConfirmed = !!latestOwnBubble && latestOwnBubble.signature !== String(beforeOwnBubble?.signature || '') &&
        (sameText(latestOwnBubble.source, before) || cleanText(latestOwnBubble.source).includes(before) || before.includes(cleanText(latestOwnBubble.source)));
      // V1.27.35: Meta sometimes remounts the composer without exposing a clean
      // value transition, so V1.27.21's editor-only confirmation can miss a real
      // native reply. A newly rendered right-lane bubble containing the submitted
      // source is equally strong confirmation and closes the waiting turn.
      if (current !== before || bubbleConfirmed) {
        metaBusinessOutgoingConfirmTimer = null;
        ipcRenderer.send('external-native-outgoing-sent', {
          name:String(identity.name || '').slice(0,180),
          handle:String(identity.handle || '').replace(/^@/,'').slice(0,180),
          chatId:String(identity.chatId || '').slice(0,500),
          avatarUrl:String(identity.avatarUrl || '').slice(0,2400),
          url:String(identity.url || location.href || '').slice(0,1800),
          text:String(before || '').slice(0,4000),
          // V1.27.151: only a newly rendered own-side bubble is hard delivery
          // proof for Day start/end. Composer consumption alone stays unconfirmed.
          deliveryConfirmed:!!bubbleConfirmed,
          reason:String(reason || 'native-send'), at:Date.now()
        });
        scheduleCrmAutoExtract(260);
        return;
      }
      if (Date.now() - startedAt >= 2600) {
        metaBusinessOutgoingConfirmTimer = null;
        return;
      }
      metaBusinessOutgoingConfirmTimer = setTimeout(confirm, 180);
    } catch {
      metaBusinessOutgoingConfirmTimer = null;
    }
  };
  metaBusinessOutgoingConfirmTimer = setTimeout(confirm, 220);
}

document.addEventListener('keydown', event => {
  if (!event?.isTrusted || platformFromHost() !== 'metabusiness') return;
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  const composer = metaBusinessComposer();
  if (!composer) return;
  const target = event.target;
  if (target !== composer && !composer.contains?.(target)) return;
  scheduleMetaBusinessOutgoingConfirmation('enter-send');
}, true);

document.addEventListener('click', event => {
  if (!event?.isTrusted || platformFromHost() !== 'metabusiness') return;
  const button = event.target?.closest?.('button,[role="button"]');
  const composer = metaBusinessComposer();
  if (!button || !composer) return;
  const br = button.getBoundingClientRect(), cr = composer.getBoundingClientRect();
  if (br.bottom < cr.top - 60 || br.top > cr.bottom + 60 || br.left < cr.left - 40) return;
  const label = cleanText(`${button.getAttribute?.('aria-label') || ''} ${button.getAttribute?.('title') || ''} ${button.textContent || ''}`);
  if (!/(?:发送|傳送|送信|Send|Reply|回复|回覆)/i.test(label)) return;
  scheduleMetaBusinessOutgoingConfirmation('button-send');
}, true);
window.addEventListener('popstate', () => {
  scheduleTikTokNativeChatSelection('popstate');
  if (platformFromHost()==='metabusiness') {
    const identity=currentMetaBusinessNativeChatIdentity();
    if (identity?.name) emitMetaBusinessNativeChatSelection(identity,'popstate');
  }
});
window.addEventListener('DOMContentLoaded', () => {
  scheduleTikTokNativeChatSelection('dom-ready');
  if (platformFromHost()==='metabusiness') setTimeout(()=>{const identity=currentMetaBusinessNativeChatIdentity();if(identity?.name)emitMetaBusinessNativeChatSelection(identity,'dom-ready')},500);
}, { once:true });

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

  // Meta Business can expose a valid read-only conversation after messaging
  // is closed/blocked. History still needs translation even though Meta removes
  // the composer, so Meta uses the tightly scoped message-lane root instead.
  if (platform === 'metabusiness') return !!metaBusinessChatRoot();

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
    .yoko-global-copy-message{appearance:none!important;border:0!important;border-radius:999px!important;background:rgba(255,255,255,.78)!important;color:#58666f!important;padding:0!important;width:19px!important;min-width:19px!important;height:19px!important;line-height:19px!important;text-align:center!important;font-size:12px!important;cursor:pointer!important;box-shadow:inset 0 0 0 1px rgba(120,130,138,.22)!important;}
    .yoko-global-copy-message:hover{background:rgba(255,255,255,.98)!important;color:#1f7a4d!important;}
    .yoko-global-copy-message[data-copied="1"]{color:#138a4b!important;font-weight:700!important;}
  `;
  (document.head || document.documentElement).appendChild(style);
}

function likelyUiText(text) {
  const v = cleanText(text);
  if (!v || v.length > 6000) return true;
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
  // V1.27.63 read-only discovery: candidate enumeration never mutates translation DOM.

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


function metaBusinessExcludedUiText(text) {
  const v = cleanText(text);
  if (!v) return true;
  if (/(?:这个聊天包含对以下广告的回复|此聊天包含.*广告.*回复|包含对以下广告|查看广告|查看廣告|广告回复|廣告回覆|创建消息类广告|建立訊息廣告|Sponsored|ad reply|replied to (?:your |an )?ad|responded to (?:your |an )?ad)/i.test(v)) return true;
  if (/^(?:所有消息|Messenger|Instagram|WhatsApp|Facebook评论|Instagram评论|未读|优先级|广告回复|后续跟进|管理|在线|通过 Messenger 回复.*|All messages|Manage)$/i.test(v)) return true;
  if (/^(?:(?:绑定|綁定|关联|關聯|连接|連接|连结|連結|打开|開啟|新增|添加|管理)\s*(?:Instagram|Facebook|Messenger|WhatsApp|主页|主頁|公共主页|公共主頁|粉丝专页|粉絲專頁|Page|账号|帳號)|(?:关联|關聯|绑定|綁定)\s*(?:主页|主頁))$/iu.test(v)) return true;
  if (/^(?:打开|打開|开启|開啟|关联|關聯|绑定|綁定|连接|連接|管理|新增|添加|关闭|關閉)$/u.test(v)) return true;
  if (/^(?:打开|打開|开启|開啟|关联|關聯|绑定|綁定|连接|連接|管理|新增|添加).{0,48}(?:Instagram|Facebook|Messenger|WhatsApp|主页|主頁|公共主页|公共主頁|粉丝专页|粉絲專頁|Page|账号|帳號)/iu.test(v)) return true;
  return false;
}

function metaBusinessComposer() {
  const candidates = Array.from(document.querySelectorAll(
    '[contenteditable="true"][role="textbox"],textarea,[aria-label*="message" i],[aria-label*="消息"],[aria-label*="回复"],[aria-label*="回覆"]'
  )).filter(isVisible).filter(el => {
    const r = el.getBoundingClientRect();
    return r.bottom > innerHeight * .58 && r.left > innerWidth * .34 && r.width > 140;
  });
  return candidates.sort((a,b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0] || null;
}

let metaBusinessLastChatRoot = null;
let metaBusinessLastChatRootRect = null;
function metaBusinessRememberChatRoot(root) {
  try {
    if(!(root instanceof Element)||!root.isConnected||!isVisible(root))return root||null;
    metaBusinessLastChatRoot=root;
    const r=root.getBoundingClientRect();
    metaBusinessLastChatRootRect={left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};
  } catch {}
  return root||null;
}
function metaBusinessReadOnlyChatRoot() {
  try {
    if(metaBusinessLastChatRoot instanceof Element && metaBusinessLastChatRoot.isConnected && isVisible(metaBusinessLastChatRoot)) return metaBusinessLastChatRoot;
    const seeds=[];
    for(const el of Array.from(document.querySelectorAll('div,[dir="auto"],[dir="ltr"],p,span'))){
      if(!(el instanceof Element)||!isVisible(el)||el.closest('nav,header,aside,button,input,textarea,[contenteditable="true"],[role="textbox"]'))continue;
      const r=el.getBoundingClientRect();
      if(r.top<90||r.bottom>innerHeight-20||r.width<28||r.width>760||r.height<18||r.height>900)continue;
      if(((r.left+r.right)/2)<innerWidth*.30)continue;
      const text=messageText(el);
      if(!text||likelyUiText(text)||nonTranslatableChatText(text)||metaBusinessExcludedUiText(text))continue;
      if(!metaBusinessElementHasBubbleVisual(el))continue;
      seeds.push(el); if(seeds.length>=48)break;
    }
    if(!seeds.length)return null;
    const scores=new Map();
    for(const seed of seeds){
      let cur=seed.parentElement;
      for(let depth=0;cur&&depth<10;depth+=1,cur=cur.parentElement){
        if(!(cur instanceof Element)||!isVisible(cur))continue;
        const r=cur.getBoundingClientRect();
        if(r.width<300||r.height<260||r.right<innerWidth*.55||r.width>innerWidth*.88)continue;
        if(r.left<Math.max(120,innerWidth*.18))continue;
        const prior=scores.get(cur)||{count:0,area:r.width*r.height,edge:Math.abs(r.top-120)+Math.abs(r.bottom-innerHeight)};
        prior.count+=1; scores.set(cur,prior);
      }
    }
    const ranked=[...scores.entries()].filter(([,x])=>x.count>=Math.min(2,seeds.length)).sort((a,b)=>b[1].count-a[1].count || a[1].area-b[1].area || a[1].edge-b[1].edge);
    const picked=ranked[0]?.[0]||null;
    return metaBusinessRememberChatRoot(picked);
  } catch { return null; }
}

function metaBusinessChatRoot() {
  const composer = metaBusinessComposer();
  if (!composer) return metaBusinessReadOnlyChatRoot();
  const cr = composer.getBoundingClientRect();
  let node = composer.parentElement;
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;

  // V1.27.10: derive the chat pane from the composer itself, never from a fixed
  // percentage of the whole browser width. Meta Business can open the contact
  // details drawer on the right, shrinking the conversation lane by hundreds of
  // pixels. The old innerWidth*.78 / *.34 gates then rejected the real chat root
  // and translation appeared to "stop" until the drawer was collapsed.
  for (let depth = 0; node && depth < 14; depth += 1, node = node.parentElement) {
    if (!(node instanceof Element) || !isVisible(node)) continue;
    const r = node.getBoundingClientRect();
    const containsComposer = r.left <= cr.left + 30 && r.right >= cr.right - 30 && r.bottom >= cr.bottom - 8;
    if (!containsComposer || r.width < Math.max(260, cr.width * .78) || r.height < innerHeight * .42) continue;
    // Prefer an ancestor whose left/right edges closely match the composer lane.
    // A higher ancestor that also contains the right contact drawer is penalised.
    const edgePenalty = Math.abs(r.left - cr.left) * 1.15 + Math.abs(r.right - cr.right) * 1.8;
    const topPenalty = Math.max(0, r.top - innerHeight * .28) * 2.5;
    const oversizePenalty = Math.max(0, r.width - Math.max(cr.width + 180, cr.width * 1.45)) * 1.4;
    const score = edgePenalty + topPenalty + oversizePenalty + depth * 2;
    if (score < bestScore) { best = node; bestScore = score; }
  }
  return metaBusinessRememberChatRoot(best || composer.parentElement);
}

function metaBusinessElementHasBubbleVisual(el) {
  if (!(el instanceof Element) || !isVisible(el)) return false;
  try {
    const cs = getComputedStyle(el);
    const bg = String(cs.backgroundColor || '').replace(/\s+/g, '').toLowerCase();
    const transparent = !bg || bg === 'transparent' || bg === 'rgba(0,0,0,0)' || bg === 'rgba(0, 0, 0, 0)';
    const radius = Math.max(
      parseFloat(cs.borderTopLeftRadius) || 0,
      parseFloat(cs.borderTopRightRadius) || 0,
      parseFloat(cs.borderBottomLeftRadius) || 0,
      parseFloat(cs.borderBottomRightRadius) || 0
    );
    return !transparent && radius >= 5;
  } catch { return false; }
}

function metaBusinessBubbleHostForLeaf(el, root) {
  const leafText = messageText(el);
  if (!leafText) return null;

  // Reuse an already-stable translated host first.
  let node = el;
  for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
    if (!(node instanceof Element) || !root.contains(node)) continue;
    if (node.classList.contains(HOST_CLASS)) {
      const source = cleanText(node.getAttribute(SOURCE_ATTR) || '');
      const current = messageText(node);
      if (source && source === current && current.includes(leafText)) return node;
    }
  }

  // V1.27.10 message-group ownership: Meta often renders one real blue/grey
  // message bubble as several nested text div/span nodes. Translating each leaf
  // produced 3 separate Chinese rows plus one final merged row. Ascend to the
  // nearest visual bubble (solid background + rounded corners) and translate the
  // complete bubble text exactly once.
  let visualHost = null;
  node = el;
  const rr = root.getBoundingClientRect();
  for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
    if (!(node instanceof Element) || !root.contains(node) || !isVisible(node)) continue;
    const r = node.getBoundingClientRect();
    if (r.width < 12 || r.width > rr.width * .90 || r.height < 10 || r.height > 1200) continue;
    const text = messageText(node);
    if (!text || !text.includes(leafText) || text.length > 6000 || metaBusinessExcludedUiText(text)) continue;
    if (metaBusinessElementHasBubbleVisual(node)) { visualHost = node; break; }
  }
  if (visualHost) return visualHost;
  return el;
}

function metaBusinessCandidates() {
  const root = metaBusinessChatRoot();
  const composer = metaBusinessComposer();
  if (!root) return [];
  const rr = root.getBoundingClientRect();
  const cr = composer?.getBoundingClientRect?.() || null;
  const topLimit = Math.max(rr.top + 68, 82);
  const bottomLimit = Math.min(innerHeight - 8, cr && cr.top > rr.top ? cr.top - 3 : rr.bottom - 3);

  // V1.27.63 read-only discovery: candidate enumeration never mutates translation DOM.

  const raw = [];
  const all = Array.from(root.querySelectorAll('[dir="auto"],[dir="ltr"],p,span,div'));
  for (const el of all) {
    if (!isVisible(el)) continue;
    if (el.closest('input,textarea,[contenteditable="true"],[role="textbox"],button,nav,header')) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < topLimit || r.top > bottomLimit) continue;
    if (r.left < rr.left + 8 || r.right > rr.right - 4) continue;
    if (r.width < 10 || r.width > rr.width * .92 || r.height < 10 || r.height > 1200) continue;
    const text = messageText(el);
    if (likelyUiText(text) || nonTranslatableChatText(text) || metaBusinessExcludedUiText(text)) continue;

    // Reject nearly full-width banners/notice strips even when their inner leaf
    // happens to be narrow. Message bubbles live in one side of the chat lane.
    let bannerLike = false;
    let parent = el.parentElement;
    for (let depth=0; parent && depth<3; depth+=1, parent=parent.parentElement) {
      if (!(parent instanceof Element) || !isVisible(parent) || !root.contains(parent)) continue;
      const pr = parent.getBoundingClientRect();
      const pt = messageText(parent);
      if (metaBusinessExcludedUiText(pt)) { bannerLike = true; break; }
      if (pr.width > rr.width * .90 && pr.height < 170 && pr.top < rr.top + 240) { bannerLike = true; break; }
    }
    if (bannerLike) continue;

    let hasSameTextDescendant = false;
    for (const child of Array.from(el.children || [])) {
      if (!isVisible(child)) continue;
      if (messageText(child) === text) { hasSameTextDescendant = true; break; }
    }
    const ownsTranslation = el.classList.contains(HOST_CLASS) && cleanText(el.getAttribute(SOURCE_ATTR) || '') === text;
    if (hasSameTextDescendant && !ownsTranslation) continue;

    const host = metaBusinessBubbleHostForLeaf(el, root) || el;
    if (metaBusinessReplyQuotePreview(host, root)) continue;
    const hr = host.getBoundingClientRect();
    const hostText = messageText(host) || text;
    raw.push({
      el:host, text:hostText, r:hr, area:Math.max(1, hr.width*hr.height),
      cx:(hr.left+hr.right)/2, cy:(hr.top+hr.bottom)/2,
      ownsTranslation:host.classList.contains(HOST_CLASS),
      visualBubble:metaBusinessElementHasBubbleVisual(host),
      role:crmMessageRole(host)
    });
  }

  // Prefer one actual rounded blue/grey bubble over all of its nested text
  // leaves.  A leaf may be tiny, so the old area-first sort selected it before
  // its real bubble and produced multiple translations inside one outgoing post.
  raw.sort((a,b) => Number(b.ownsTranslation)-Number(a.ownsTranslation) || Number(b.visualBubble)-Number(a.visualBubble) || b.area-a.area);
  const chosen = [];
  for (const item of raw) {
    if (chosen.some(prev => prev.el === item.el)) continue;
    if (chosen.some(prev => prev.text === item.text && Math.abs(prev.cy-item.cy) <= 14 && Math.abs(prev.cx-item.cx) <= 90)) continue;
    if (chosen.some(prev => {
      if (!prev.el?.contains?.(item.el)) return false;
      if (prev.role && item.role && prev.role !== item.role) return false;
      return prev.visualBubble && prev.text.includes(item.text);
    })) continue;
    chosen.push(item);
  }
  // V1.27.63: do not prune/move translation hosts during discovery. Recycled/stale
  // hosts are reconciled only by the explicit atomic commit path.
  chosen.sort((a,b)=>a.r.top-b.r.top||a.r.left-b.r.left);
  return chosen.map(x=>x.el);
}

function genericChatRoot(platform) {
  if (platform === 'metabusiness') return metaBusinessChatRoot();
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
  if (platform === 'metabusiness') return metaBusinessCandidates();
  return genericCandidates(platform);
}

function yokoActionToolbarOnlyText(value) {
  const text=cleanText(value || '');
  if(!text)return false;
  const compact=text.replace(/\s+/g,'');
  return /^(?:(?:⧉|↻|↗)?(?:复制|重译|GPT)){1,6}$/i.test(compact);
}

function stripYokoActionToolbarLeak(value) {
  let text=String(value || '').replace(/\r\n/g,'\n');
  if(!text)return '';
  const toolbarTail=/\s*(?:⧉\s*)?复制\s*(?:↻\s*)?重译\s*(?:↗\s*)?GPT\s*$/i;
  text=text.split('\n').map(line=>{
    const raw=String(line || '');
    if(yokoActionToolbarOnlyText(raw))return '';
    return raw.replace(toolbarTail,'').trimEnd();
  }).filter(line=>!yokoActionToolbarOnlyText(line)).join('\n');
  return cleanText(text);
}

function messageText(node) {
  if (!node) return '';
  try {
    const clone = node.cloneNode(true);
    clone.querySelectorAll?.('.yoko-global-message-actions,.yoko-inline-actions,.yoko-inline-translation,#yoko-v12765-composer-clear,.yoko-v12754-actionbar,#yoko-v12754-composer-paste,[data-yoko-ui="1"]').forEach(el => el.remove());
    return stripYokoActionToolbarLeak(clone.innerText || clone.textContent || '');
  } catch { return stripYokoActionToolbarLeak(node?.innerText || node?.textContent || ''); }
}

function messageSourceText(node) {
  const attr=stripYokoActionToolbarLeak(node?.getAttribute?.(SOURCE_ATTR) || '');
  if(attr && !yokoActionToolbarOnlyText(attr))return attr;
  return messageText(node);
}

// V1.27.41 native-only performance: quote detection is called for every visible
// candidate during translation AND CRM extraction. Meta can expose hundreds of
// span/div nodes, so rescanning the entire chat root for reply labels for every
// candidate made scrolling disproportionately expensive. Cache the small set of
// visible reply-label rectangles for one paint burst.
let metaBusinessReplyLabelCacheAt = 0;
let metaBusinessReplyLabelCacheRoot = null;
let metaBusinessReplyLabelCache = [];
function metaBusinessReplyLabelRects(root, replyLabel) {
  const now = Date.now();
  if (root === metaBusinessReplyLabelCacheRoot && now - metaBusinessReplyLabelCacheAt < 180) return metaBusinessReplyLabelCache;
  const rows=[];
  try {
    for (const el of Array.from(root.querySelectorAll('span,p,[role="button"],[aria-label],div'))) {
      if (!(el instanceof Element) || !isVisible(el)) continue;
      const text=cleanText(el.innerText || el.textContent || '');
      if (!text || text.length>180 || !replyLabel.test(text)) continue;
      const r=el.getBoundingClientRect();
      if (r.width<2 || r.height<2 || r.height>90) continue;
      rows.push({el,text,r});
      if (rows.length>=24) break;
    }
  } catch {}
  metaBusinessReplyLabelCacheAt=now;
  metaBusinessReplyLabelCacheRoot=root;
  metaBusinessReplyLabelCache=rows;
  return rows;
}

let metaBusinessOutgoingSourceCacheAt = 0;
let metaBusinessOutgoingSourceCacheRoot = null;
let metaBusinessOutgoingSourceCache = new Set();
function metaBusinessVisibleOutgoingSourceSet(root) {
  const now=Date.now();
  if (root===metaBusinessOutgoingSourceCacheRoot && now-metaBusinessOutgoingSourceCacheAt<180) return metaBusinessOutgoingSourceCache;
  const set=new Set();
  try {
    for (const el of Array.from(root.querySelectorAll(`[${SOURCE_ATTR}]`))) {
      if (!(el instanceof Element) || !el.isConnected) continue;
      if (metaBusinessMessageRoleByLane(el)!=='me') continue;
      const source=cleanText(el.getAttribute(SOURCE_ATTR) || messageText(el));
      if (source) set.add(source);
    }
  } catch {}
  metaBusinessOutgoingSourceCacheAt=now;
  metaBusinessOutgoingSourceCacheRoot=root;
  metaBusinessOutgoingSourceCache=set;
  return set;
}

function metaBusinessReplyLabelPrecedesRect(root, replyLabel, nr, maxGap = 320) {
  if (!root || !nr) return false;
  for (const item of metaBusinessReplyLabelRects(root, replyLabel)) {
    const lr = item.r;
    const gap = nr.top - lr.bottom;
    if (gap >= -4 && gap <= maxGap && Math.abs(((lr.left + lr.right) / 2) - ((nr.left + nr.right) / 2)) <= Math.max(360, nr.width * 1.8)) return true;
  }
  return false;
}

function metaBusinessReplyLabelFollowsRect(root, replyLabel, nr, maxGap = 320) {
  if (!root || !nr) return false;
  for (const item of metaBusinessReplyLabelRects(root, replyLabel)) {
    const lr = item.r;
    const gap = lr.top - nr.bottom;
    if (gap >= -4 && gap <= maxGap && Math.abs(((lr.left + lr.right) / 2) - ((nr.left + nr.right) / 2)) <= Math.max(360, nr.width * 1.8)) return true;
  }
  return false;
}

// V1.27.31: Meta renders a replied-to/quoted copy of the operator's old message
// inside the customer's reply group (screenshot: "Steve回复了 You"). That quoted
// blue preview is context, not a new customer message. It must never enter the
// translation queue or CRM extraction, otherwise Yoko translates its own old
// sentence again and can learn the operator's age/job as customer facts.
function metaBusinessReplyQuotePreview(node, rootHint = null) {
  try {
    if (!node || platformFromHost() !== 'metabusiness') return false;
    const root = rootHint || metaBusinessChatRoot();
    if (!root || !root.contains(node)) return false;
    const replyLabel = /(?:回复了\s*(?:You|你)|回覆了\s*(?:You|你)|replied\s+to\s+(?:you|your\s+message)|返信(?:しました|した)?\s*(?:You|あなた)?|(?:You|あなた)\s*に返信)/iu;
    const ownText = cleanText(node.innerText || node.textContent || '').slice(0,2400);
    if (ownText && replyLabel.test(ownText)) return true; // the label/wrapper itself is never a message
    const nr = node.getBoundingClientRect?.();
    const role = metaBusinessMessageRoleByLane(node);
    const candidateSource = cleanText(node.getAttribute?.(SOURCE_ATTR) || messageText(node));

    // V1.27.44 pinned-original rule: in Meta the `X replied to You` label is
    // rendered BELOW the original outgoing bubble and ABOVE the quoted copy.
    // A real right-lane message with the label below it is the source message,
    // never the quote. This is the exact screenshot case that caused a completed
    // translation to be cleared/reattached on every observer pass.
    if (nr && role === 'me' && metaBusinessReplyLabelFollowsRect(root, replyLabel, nr, 320)) return false;

    let replyContext = false;
    let semanticReplyHint = false;
    let current = node;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      if (!(current instanceof Element) || !root.contains(current)) continue;
      const hint = [current.getAttribute?.('data-testid'), current.getAttribute?.('aria-label'), current.getAttribute?.('class')].filter(Boolean).join(' ');
      if (/(?:quoted|quote[-_ ]?message|reply[-_ ]?(?:preview|context|reference)|replied[-_ ]?to|referenced[-_ ]?message)/i.test(hint)) {
        semanticReplyHint = true;
        replyContext = true;
      }
      const text = cleanText(current.innerText || current.textContent || '').slice(0,2200);
      // Broad ancestors often contain the original message, reply label AND the
      // new customer answer. Geometry must prove the label is above this
      // candidate; ancestor text alone is not enough to classify it as quote.
      if (replyLabel.test(text) && nr && metaBusinessReplyLabelPrecedesRect(root, replyLabel, nr, 260)) {
        replyContext = true;
        break;
      }
    }
    const labelPrecedes = !!(nr && metaBusinessReplyLabelPrecedesRect(root, replyLabel, nr, 280));
    if (!replyContext && labelPrecedes) replyContext = true;
    if (!replyContext) return false;

    const exactOutgoing = !!candidateSource && metaBusinessVisibleOutgoingSourceSet(root).has(candidateSource);
    let blueLike = false;
    current = node;
    for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
      if (!(current instanceof Element) || !root.contains(current)) continue;
      const cs = getComputedStyle(current);
      const bg = String(cs.backgroundColor || '');
      const m = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
      if (m) {
        const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
        if (b >= 150 && b >= r + 6 && b >= g + 3) { blueLike = true; break; }
      }
      const styleHint = `${current.getAttribute?.('style') || ''} ${current.getAttribute?.('class') || ''}`;
      if (/(?:blue|primary|accent|quoted|reply-preview|reply_context)/i.test(styleHint) && metaBusinessMessageRoleByLane(current) !== 'customer') { blueLike = true; break; }
    }

    // CRITICAL: never reject a normal customer-lane bubble just because it is
    // close to a reply label or sits inside a generic reply-group ancestor. The
    // quote must look like the old outgoing source (exact text / outgoing lane /
    // blue preview) AND be geometrically after the label. This fixes both
    // "有的消息不翻译" and the original-message flashing loop.
    if (!labelPrecedes && !semanticReplyHint) return false;
    if (exactOutgoing && labelPrecedes) return true;
    if (role === 'me' && labelPrecedes) return true;
    if (blueLike && labelPrecedes) return true;
    return false;
  } catch { return false; }
}

function metaBusinessMessageRoleByLane(node) {
  try {
    if (!node || platformFromHost() !== 'metabusiness') return '';
    const root=metaBusinessChatRoot();
    if (!root) return '';
    const rr=root.getBoundingClientRect(), r=node.getBoundingClientRect();
    const width=Math.max(1,rr.width||1);
    const leftGap=Math.max(0,r.left-rr.left), rightGap=Math.max(0,rr.right-r.right);
    const leftRatio=leftGap/width, rightRatio=Math.max(0,(r.right-rr.left)/width), centerRatio=(((r.left+r.right)/2)-rr.left)/width;
    // V1.27.28 screenshot-derived fix: when the right CRM panel narrows Meta's
    // native chat lane, incoming grey bubbles can occupy 80-90% of the lane.
    // Their RIGHT edge is no longer a useful incoming test; the stable signal is
    // which side the bubble is anchored to.  Outgoing bubbles hug the right edge,
    // incoming bubbles hug the left edge.  Keep a small ambiguity band only when
    // a bubble spans almost the full lane.
    const nearRight=rightGap <= Math.max(18,Math.min(46,width*.11));
    const nearLeft=leftGap <= Math.max(18,Math.min(72,width*.28));
    if (nearRight && !nearLeft) return 'me';
    if (nearLeft && !nearRight) return 'customer';
    if (nearRight && nearLeft) {
      if (centerRatio >= .58) return 'me';
      if (centerRatio <= .48) return 'customer';
      return '';
    }
    if (rightRatio >= .92 && leftRatio >= .18) return 'me';
    if (leftRatio <= .30 && centerRatio <= .58) return 'customer';
    if (centerRatio >= .70) return 'me';
    if (centerRatio <= .50) return 'customer';
  } catch {}
  return '';
}

function crmMessageRole(node) {
  if (!node) return '';
  const activePlatform = settings.platform || platformFromHost();
  if (activePlatform === 'metabusiness' && metaBusinessReplyQuotePreview(node)) return '';
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

    if (activePlatform === 'metabusiness') {
      return metaBusinessMessageRoleByLane(host);
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
  // V1.27.63: contextIsolation means page-world window.__yokoUnified... is NOT
  // visible inside this sandboxed preload. DOM is shared across worlds, so the
  // page-world unified toolbar publishes ownership on documentElement instead.
  const unifiedMarker = String(document.documentElement?.getAttribute('data-yoko-unified-message-actions') || '');
  const unifiedOwned = /^v127\d+$/.test(unifiedMarker) ||
    !!document.querySelector('.yoko-v12754-actionbar[data-yoko-ui="1"]');
  let actions = node.querySelector(':scope > .yoko-global-message-actions:not(.yoko-v12754-actionbar)');
  if (unifiedOwned) {
    // V1.27.68: unified ownership used to return early when no legacy row was
    // present. That removed the only DOM evidence consumed by the page-world
    // toolbar until translation happened, so a freshly switched Meta customer
    // could have no Copy / Retranslate / GPT controls and the top
    // "客户消息→GPT" helper had no latest-customer message either. Always keep
    // one zero-height signal row; it contains no clickable legacy button.
    if (!actions) {
      actions=document.createElement('div');
      actions.className='yoko-global-message-actions';
      try { node.appendChild(actions); } catch { return false; }
    }
    actions.querySelectorAll('.yoko-global-copy-message,button').forEach(btn=>btn.remove());
    actions.setAttribute('data-yoko-legacy-copy-signal','1');
    actions.style.setProperty('display','none','important');
    actions.style.setProperty('width','0','important');
    actions.style.setProperty('height','0','important');
    actions.style.setProperty('min-height','0','important');
    actions.style.setProperty('overflow','hidden','important');
    actions.style.setProperty('margin','0','important');
    actions.style.setProperty('padding','0','important');
    return true;
  }
  if (!actions) {
    actions = document.createElement('div');
    actions.className = 'yoko-global-message-actions';
    actions.setAttribute('data-yoko-legacy-copy-signal','1');
    try { node.appendChild(actions); } catch { return false; }
  }
  let btn = actions.querySelector('.yoko-global-copy-message');
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'yoko-global-copy-message';
    btn.textContent = '⧉';
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
        btn.textContent = '✓';
        setTimeout(() => { if (btn?.isConnected) { btn.dataset.copied='0'; btn.textContent='⧉'; } }, 900);
      } catch {
        btn.textContent = '!';
        setTimeout(() => { if (btn?.isConnected) btn.textContent='⧉'; }, 1100);
      } finally { btn.disabled = false; }
    });
  }
  return true;
}

function scanCustomerCopyActions() {
  messageActionScanTimer = null;
  const platform=settings.platform || platformFromHost();
  if (document.hidden || !isConversationReady(platform, false)) return;
  try {
    const nodes=candidateElements(false).slice(-80);
    if(platform==='metabusiness'){
      const root=metaBusinessChatRoot();
      if(root){
        for(const node of Array.from(root.querySelectorAll(`[${SOURCE_ATTR}]`)).slice(-120)){
          if(!nodes.includes(node))nodes.push(node);
        }
      }
    }
    nodes.slice(-140).forEach(ensureCustomerCopyAction);
  } catch {}
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
    const nativeIdentity = platformFromHost() === 'tiktok' ? currentTikTokNativeChatIdentity() : (platformFromHost() === 'metabusiness' ? currentMetaBusinessNativeChatIdentity() : null);
    const identitySignature = `${String(nativeIdentity?.chatId || '')}|${String(nativeIdentity?.name || '')}|${String(nativeIdentity?.handle || '')}`;
    const signature = crmSignature(`${location.href}\u001f${identitySignature}\u001fline-added\u001f${hitIndex}\u001f${hit.text}\u001f${hit.timeText || ''}\u001f${Number(hit.delivered || 0) || 0}`);
    const now = Date.now();
    if (!force && signature === lineAddedTerminalLastSignature) return false;
    if (signature === lineAddedTerminalPendingSignature && (now - lineAddedTerminalPendingAt) < 2200) return false;

    lineAddedTerminalPendingSignature = signature;
    lineAddedTerminalPendingAt = now;
    const payload = {
      text:String(hit.text || '').slice(0,1200),
      delivered:Number(hit.delivered || 0) || 0,
      signature,
      ordinal:hitIndex,
      timeText:String(hit.timeText || '').slice(0,120),
      displayName:String(nativeIdentity?.name || '').slice(0,180),
      handle:String(nativeIdentity?.handle || '').replace(/^@/,'').slice(0,180),
      chatId:String(nativeIdentity?.chatId || '').slice(0,500),
      avatarUrl:String(nativeIdentity?.avatarUrl || '').slice(0,2400),
      url:String(nativeIdentity?.url || location.href || '').slice(0,1800)
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

function metaBusinessProfileFactLike(text = '') {
  const source = cleanText(text || '');
  return /(?:\d{2,3}\s*(?:歳|才|岁)|(?:私は|わたしは|僕は|ぼくは|俺は)\s*\d{2,3}\s*(?:です|ですよ|ですね)|名前|本名|住んで|在住|住在|生まれ|出生|育ち|長大|成长|仕事|職業|勤務|働いて|趣味|興味|兴趣)/iu.test(source);
}

function metaBusinessConfirmedOutgoingSourceTexts(messages = []) {
  const out = new Set();
  const add = value => { const text=cleanText(value || ''); if (text) out.add(text.toLocaleLowerCase()); };
  for (const row of Array.isArray(messages) ? messages : []) {
    if (String(row?.role || '').toLowerCase() === 'me') add(row?.text);
  }
  try {
    const root=metaBusinessChatRoot();
    for (const node of Array.from((root || document).querySelectorAll(`[${SOURCE_ATTR}]`)).slice(-180)) {
      if (!(node instanceof Element) || !isVisible(node)) continue;
      const host=bubbleHostForLeaf(node) || node;
      if (metaBusinessMessageRoleByLane(host) !== 'me') continue;
      add(node.getAttribute?.(SOURCE_ATTR) || host.getAttribute?.(SOURCE_ATTR) || messageText(host));
    }
  } catch {}
  return out;
}

function metaBusinessExplicitCustomerFactsHint(messages = []) {
  if (platformFromHost() !== 'metabusiness') return null;
  const facts = {};
  const parseAge = raw => {
    const text = cleanText(raw || '').slice(0, 1200);
    if (!text) return null;
    let match = text.match(/(?:^|[。！？!?、,\s])(?:私は|わたしは|僕は|ぼくは|俺は)\s*(\d{2,3})\s*(?:歳|才|です|ですよ|ですね)(?=[。！？!?、,\s]|$)/u);
    if (!match) match = text.match(/(?:^|[。！？!?、,\s])(\d{2,3})\s*(?:歳|才)(?:です|ですよ|ですね)?(?=[。！？!?、,\s]|$)/u);
    if (!match) match = text.match(/(?:^|[。！？!?、,\s])(?:我(?:今年|的年龄是|的年齡是)?\s*)?(\d{2,3})\s*(?:岁|歲)(?=[。！？!?、,\s]|$)/u);
    const age = Number(match?.[1] || 0);
    return age >= 15 && age <= 100 ? { age:String(age), ageEvidence:text } : null;
  };
  const parseRegion = raw => {
    const text=cleanText(raw || '').slice(0,1200);
    if (!text) return null;
    let match=text.match(/(?:私は|わたしは|僕は|ぼくは|俺は)?\s*([^。！？!?、,]{1,40}?)\s*(?:に住んでいます|に住んでる|に住んでます|在住です|在住)(?=[。！？!?、,\s]|$)/u);
    if (!match) match=text.match(/(?:住まい|住居|住所|居住地|地域|お住まい)(?:は|が|：|:)?\s*([^。！？!?、,]{1,40})/u);
    if (!match) match=text.match(/(?:我(?:现在|現在|目前)?住在|目前在|现在在|現在在|居住在)\s*([^。！？!?、,]{1,40})/u);
    if (!match) match=text.match(/(?:来自|來自|老家在|出生在)\s*([^。！？!?、,]{1,40})/u);
    // Birthplace is a useful geographic fallback when current residence is not
    // stated. A later explicit residence remains auto-owned and can overwrite it.
    if (!match) match=text.match(/([^。！？!?、,\s]{1,28}?)\s*(?:生まれ|出生|出生です)(?=[。！？!?、,\s]|$)/u);
    const region=cleanText(match?.[1] || '',80).replace(/^(?:私は|わたしは|僕は|ぼくは|俺は)\s*/u,'').trim();
    return region ? { region, regionEvidence:text } : null;
  };
  const outgoing = metaBusinessConfirmedOutgoingSourceTexts(messages);
  const evidence=[];
  const collect = raw => {
    const text=cleanText(raw || '').slice(0,1200);
    if (!text || (outgoing.has(text.toLocaleLowerCase()) && metaBusinessProfileFactLike(text))) return;
    const age=parseAge(text); if (age && !facts.age) Object.assign(facts,age);
    const region=parseRegion(text); if (region && !facts.region) Object.assign(facts,region);
    if (/(?:生まれ|生れ|出生|生于|生於|出生于|出生於|育ち|育った|育ちです|長大|长大|成長|成长|grew\s+up|born\s+in)/iu.test(text)) {
      if (!facts.originGrowthEvidence) facts.originGrowthEvidence=text;
    }
    if ((age || region || facts.originGrowthEvidence === text) && !evidence.includes(text)) evidence.push(text);
  };
  const collectTranslated = (raw, delivered = 0) => {
    const text=cleanText(raw || '').replace(/^中文译文[：:]\s*/u,'').replace(/^译[：:]\s*/u,'').slice(0,1200);
    if (!text) return;
    const age=parseAge(text);
    const region=parseRegion(text);
    const sourceDelivered=Number(delivered || 0) || 0;
    if(age && !facts.translatedAge){facts.translatedAge=age.age;facts.translatedAgeEvidence=text;facts.translatedAgeDelivered=sourceDelivered;}
    if(region && !facts.translatedRegion){facts.translatedRegion=region.region;facts.translatedRegionEvidence=text;facts.translatedRegionDelivered=sourceDelivered;}
    if ((age || region) && !evidence.includes(text)) evidence.push(text);
  };

  const rows = Array.isArray(messages) ? messages : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i] || {};
    if (String(row.role || '') !== 'customer') continue;
    collect(row.text || '');
    collectTranslated(row.translatedText || '', row.delivered || 0);
  }
  try {
    const root = metaBusinessChatRoot();
    const translatedHosts = Array.from((root || document).querySelectorAll(`[${SOURCE_ATTR}]`)).filter(isVisible).slice(-160);
    for (let i = translatedHosts.length - 1; i >= 0; i -= 1) {
      const node = translatedHosts[i];
      if (!(node instanceof Element) || metaBusinessReplyQuotePreview(node)) continue;
      const host = bubbleHostForLeaf(node) || node;
      if (metaBusinessMessageRoleByLane(host) !== 'customer') continue;
      collect(node.getAttribute?.(SOURCE_ATTR) || host.getAttribute?.(SOURCE_ATTR) || '');
      const factTimeText=yokoHistoryNativeTime(host);
      collectTranslated(node.getAttribute?.(TRANSLATION_ATTR) || host.getAttribute?.(TRANSLATION_ATTR) || '', yokoExternalNativeTimeMs(factTimeText));
    }
  } catch {}
  try {
    const candidates = metaBusinessCandidates().slice(-100);
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const node = candidates[i];
      if (!(node instanceof Element) || metaBusinessReplyQuotePreview(node)) continue;
      if (metaBusinessMessageRoleByLane(node) !== 'customer') continue;
      collect(cleanText(node.getAttribute?.(SOURCE_ATTR) || '') || messageText(node));
      collectTranslated(node.getAttribute?.(TRANSLATION_ATTR) || '');
    }
  } catch {}
  if (evidence.length) facts.profileEvidence=evidence.slice(-8);
  return Object.keys(facts).length ? facts : null;
}

function crmTranslatedTextForNode(node, originalText) {
  const wanted=cleanText(originalText);
  if(!wanted||!node)return '';
  const candidates=[]; const seen=new Set();
  const add=el=>{if(el instanceof Element&&!seen.has(el)){seen.add(el);candidates.push(el);}};
  add(node);
  try{add(bubbleHostForLeaf(node));}catch{}
  let current=node;
  for(let i=0;current&&i<8;i+=1,current=current.parentElement)add(current);
  try{node.querySelectorAll?.(`[${SOURCE_ATTR}]`).forEach(add);}catch{}
  for(const el of candidates){
    const source=cleanText(el.getAttribute?.(SOURCE_ATTR)||'');
    const translated=cleanText(el.getAttribute?.(TRANSLATION_ATTR)||'');
    if(source&&source!==wanted)continue;
    if(!translated)continue;
    const value=translated.replace(/^中文译文[：:]\s*/u,'').replace(/^译[：:]\s*/u,'').trim();
    if(value)return value;
  }
  return '';
}

function publishCrmAutoExtract(force = false) {
  crmExtractTimer = null;
  try {
    if (!isConversationReady()) return;
    const activePlatform = platformFromHost();
    let messages = candidateElements(false)
      .filter(node => !(activePlatform === 'metabusiness' && metaBusinessReplyQuotePreview(node)))
      .map(node => { const timeText=yokoHistoryNativeTime(node); const role=activePlatform === 'metabusiness' ? (metaBusinessMessageRoleByLane(node) || crmMessageRole(node)) : crmMessageRole(node); const text=messageText(node); return { node, role, text, translatedText:crmTranslatedTextForNode(node,text), top:node.getBoundingClientRect().top, timeText, delivered:yokoExternalNativeTimeMs(timeText) }; })
      .filter(item => (item.role === 'customer' || item.role === 'me') && item.text && !likelyUiText(item.text))
      .sort((a,b) => a.top-b.top)
      .slice(-30)
      .map(item => ({ role:item.role, text:item.text.slice(0,1200), translatedText:String(item.translatedText||'').slice(0,1200), delivered:Number(item.delivered || 0) || 0, timeText:item.timeText || '' }));
    if (platformFromHost() === 'metabusiness') {
      const outgoingSources=metaBusinessConfirmedOutgoingSourceTexts(messages);
      messages=messages.filter(row => !(String(row?.role||'') === 'customer' && metaBusinessProfileFactLike(row?.text||'') && outgoingSources.has(cleanText(row?.text||'').toLocaleLowerCase())));
    }
    const nativeIdentity = platformFromHost() === 'metabusiness' ? currentMetaBusinessNativeChatIdentity() : (platformFromHost() === 'tiktok' ? currentTikTokNativeChatIdentity() : null);
    // V1.27.35: explicit facts MUST be discovered before snapshot dedupe. In the
    // real Meta page the ordinary CRM role list can stay byte-identical while a
    // translated SOURCE_ATTR host later proves `私は44です` is a customer fact.
    // Older code returned on the unchanged messages signature before it ever
    // computed explicitFacts, so the 44 repair was never sent. Include strong
    // explicit fact evidence in the signature and allow a fact-only packet even
    // if ordinary normalized messages are temporarily empty.
    const explicitFacts = platformFromHost() === 'metabusiness' ? metaBusinessExplicitCustomerFactsHint(messages) : null;
    if (!messages.length && !explicitFacts) return;
    // V1.24.0 Hotfix7: LINE-added is a conversion terminal event. Publish it
    // independently from ordinary CRM snapshot dedupe so a previously-seen
    // message can self-heal stale CRM stage/LINE progress after app restart or
    // after TikTok virtual-DOM hydration dropped the normal extraction event.
    if (messages.length) publishConfirmedLineAddedTerminal(messages, force);
    const identitySignature = `${String(nativeIdentity?.chatId || '')}|${String(nativeIdentity?.name || '')}|${String(nativeIdentity?.handle || '')}`;
    const explicitSignature = explicitFacts ? `${String(explicitFacts.age || '')}|${String(explicitFacts.ageEvidence || '')}|${String(explicitFacts.region || '')}|${String(explicitFacts.regionEvidence || '')}|${String(explicitFacts.originGrowthEvidence || '')}|${Number(explicitFacts.translatedAgeDelivered || 0) || 0}|${Number(explicitFacts.translatedRegionDelivered || 0) || 0}` : '';
    const signature = crmSignature(`${location.href}${identitySignature}${explicitSignature}${messages.map(item => `${item.role}|${item.text}|${item.translatedText || ''}|${item.timeText || ''}|${Number(item.delivered || 0) || 0}`).join('')}`);
    if (!force && signature === crmExtractLastSignature) return;
    crmExtractLastSignature = signature;
    ipcRenderer.send('external-crm-auto-extract', { messages, signature, explicitFacts, identity:nativeIdentity ? { name:String(nativeIdentity.name || '').slice(0,180), handle:String(nativeIdentity.handle || '').replace(/^@/,'').slice(0,180), chatId:String(nativeIdentity.chatId || '').slice(0,500), avatarUrl:String(nativeIdentity.avatarUrl || '').slice(0,2400), url:String(nativeIdentity.url || location.href || '').slice(0,1800) } : null });

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

function scheduleCrmBackfillAfterTranslation(node, original, translated, delay = 90) {
  try {
    const role = platformFromHost() === 'metabusiness' ? metaBusinessMessageRoleByLane(node) : crmMessageRole(node);
    if (!node?.isConnected || role !== 'customer') return;
    const signature = crmSignature(`${cleanText(original)}${cleanText(translated)}`);
    if (!signature || crmTranslationBackfillSeen.get(node) === signature) return;
    crmTranslationBackfillSeen.set(node, signature);
    scheduleCrmAutoExtract(delay);
  } catch {}
}

function startCrmAutoExtractHeartbeat() {
  if (crmExtractHeartbeatTimer) clearInterval(crmExtractHeartbeatTimer);
  // V1.27.26: React subtree swaps may miss the normal MutationObserver. The
  // existing publish signature makes this heartbeat cheap and duplicate-safe.
  crmExtractHeartbeatTimer = setInterval(() => {
    if (!document.hidden && !metaBusinessUserIsScrolling()) publishCrmAutoExtract(false);
  }, platformFromHost() === 'metabusiness' ? 6000 : 3500);
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

// V1.27.60: completed Meta translations are immutable at the physical-message
// level, not merely at one volatile React node. Meta may alternate between a
// leaf and an outer wrapper for the same bubble while hydrating. Moving the
// completed translation decoration between those nodes caused the green card
// (and sometimes the whole row) to blink. Reuse the already-pinned host instead.
function metaBusinessSamePhysicalTranslationMessage(a,b) {
  try {
    if (!(a instanceof Element) || !(b instanceof Element) || a === b) return a === b;
    if (a.contains(b) || b.contains(a)) return true;
    const ar=a.getBoundingClientRect(), br=b.getBoundingClientRect();
    const v=Math.max(0,Math.min(ar.bottom,br.bottom)-Math.max(ar.top,br.top));
    const h=Math.max(0,Math.min(ar.right,br.right)-Math.max(ar.left,br.left));
    const vr=v/Math.max(1,Math.min(ar.height,br.height));
    const hr=h/Math.max(1,Math.min(ar.width,br.width));
    const cy=Math.abs(((ar.top+ar.bottom)/2)-((br.top+br.bottom)/2));
    return vr>=.72 && hr>=.45 && cy<=18;
  } catch { return false; }
}

function metaBusinessPinnedTranslationHost(node, source='', rootHint = null) {
  try {
    if (platformFromHost() !== 'metabusiness' || !(node instanceof Element)) return null;
    const wanted=cleanText(source || messageText(node));
    if (!wanted) return null;
    if (node.hasAttribute?.(PINNED_ATTR) && node.hasAttribute?.(TRANSLATION_ATTR) && cleanText(node.getAttribute(SOURCE_ATTR)||'')===wanted) return node;
    const root=rootHint || metaBusinessChatRoot();
    if (!root) return null;
    const candidates=[];
    let parent=node.parentElement;
    for(let depth=0; parent && depth<7; depth+=1,parent=parent.parentElement){
      if(parent.hasAttribute?.(PINNED_ATTR) && parent.hasAttribute?.(TRANSLATION_ATTR)) candidates.push(parent);
      if(parent===root) break;
    }
    try { node.querySelectorAll?.(`[${PINNED_ATTR}][${TRANSLATION_ATTR}]`).forEach(el=>candidates.push(el)); } catch {}
    // Geometry fallback covers React wrapper replacement where the old/new host
    // are siblings in the same physical row. Exact source text is still required,
    // so adjacent different messages are never merged.
    try {
      for(const el of Array.from(root.querySelectorAll(`[${PINNED_ATTR}][${TRANSLATION_ATTR}][${SOURCE_ATTR}]`)).slice(-120)){
        if(candidates.includes(el)) continue;
        if(cleanText(el.getAttribute(SOURCE_ATTR)||'')!==wanted) continue;
        candidates.push(el);
      }
    } catch {}
    return candidates.find(el=>el instanceof Element && el.isConnected && cleanText(el.getAttribute(SOURCE_ATTR)||'')===wanted && metaBusinessSamePhysicalTranslationMessage(node,el)) || null;
  } catch { return null; }
}

function clearNodeTranslationUnsafe(node, force = false) {
  clearDelayedTranslationPending(node);
  try {
    // V1.27.44: a completed Meta translation is a pinned render state. Generic
    // hydration cleanup must not remove it while the same real bubble/source is
    // still connected. Quote/settings/navigation paths pass force=true.
    if (!force && platformFromHost() === 'metabusiness' && node?.hasAttribute?.(PINNED_ATTR) && node.hasAttribute(TRANSLATION_ATTR)) {
      const source = cleanText(node.getAttribute(SOURCE_ATTR) || '');
      const current = messageText(node);
      const root = metaBusinessChatRoot();
      if (source && source === current && node.isConnected && root?.contains(node)) return false;
    }
    node.classList.remove(HOST_CLASS);
    node.removeAttribute(SOURCE_ATTR);
    node.removeAttribute(TRANSLATION_ATTR);
    node.removeAttribute(MODE_ATTR);
    node.removeAttribute(TRANSLATING_ATTR);
    node.removeAttribute(ERROR_ATTR);
    node.removeAttribute(NOOP_ATTR);
    node.removeAttribute(PINNED_ATTR);
  } catch {}
  return true;
}

function markNoTranslationNeededUnsafe(node,text,key='') {
  if (!node?.isConnected) return;
  if (platformFromHost() === 'metabusiness') { const pinned=metaBusinessPinnedTranslationHost(node,text); if (pinned && pinned !== node) return; }
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

function markPendingUnsafe(node,text) {
  if (!node?.isConnected) return;
  if (platformFromHost() === 'metabusiness') {
    const pinned=metaBusinessPinnedTranslationHost(node,text);
    if (pinned) return;
  }
  ensureStyles();
  node.classList.add(HOST_CLASS);
  node.setAttribute(SOURCE_ATTR, cleanText(text));
  node.setAttribute(MODE_ATTR, settings.displayMode === 'simple' ? 'simple' : 'bilingual');
  node.removeAttribute(TRANSLATION_ATTR);
  node.removeAttribute(ERROR_ATTR);
  node.removeAttribute(NOOP_ATTR);
  node.setAttribute(TRANSLATING_ATTR,'1');
}

function markErrorUnsafe(node,text,message='翻译失败，稍后自动重试') {
  if (!node?.isConnected) return;
  if (platformFromHost() === 'metabusiness') {
    const pinned=metaBusinessPinnedTranslationHost(node,text);
    if (pinned) return;
  }
  ensureStyles();
  node.classList.add(HOST_CLASS);
  node.setAttribute(SOURCE_ATTR, cleanText(text));
  node.removeAttribute(TRANSLATING_ATTR);
  node.removeAttribute(TRANSLATION_ATTR);
  node.removeAttribute(NOOP_ATTR);
  node.setAttribute(ERROR_ATTR, message);
  // V1.27.57: do not flip error -> pending -> error every 8 seconds. The
  // text-key backoff is owned by translateJob so virtualized DOM recreation
  // cannot bypass it and make the Meta conversation jump vertically.
  retryAfter.set(node, Date.now()+45000);
}

function attachTranslationUnsafe(node,original,translated) {
  const source = cleanText(original);
  let target = cleanText(translated);
  // V1.27.10: one Meta Business message bubble gets one final Chinese block.
  // Preserve the complete Japanese source above it, but collapse provider line
  // breaks so three source paragraphs do not become three independent Chinese
  // translation rows. CSS may still wrap the single paragraph naturally.
  if ((settings.platform || platformFromHost()) === 'metabusiness') target = target.replace(/\s*\n+\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
  if (!node?.isConnected || !source) return;
  if ((settings.platform || platformFromHost()) === 'metabusiness') {
    const pinned=metaBusinessPinnedTranslationHost(node,source);
    if (pinned && pinned !== node) {
      // A completed translation already exists on the same physical bubble.
      // Do not clear/move/re-attach it merely because React exposed another
      // nested candidate on this scan. That DOM migration was the blink source.
      return;
    }
    if (pinned === node && node.hasAttribute(TRANSLATION_ATTR)) {
      const wanted=settings.displayMode === 'simple' ? target : `中文译文：${target}`;
      if (cleanText(node.getAttribute(TRANSLATION_ATTR)||'') === cleanText(wanted)) return;
    }
    // One real MB bubble owns exactly one translation decoration. Remove any
    // legacy leaf/outer host from the same message group before attaching the
    // final full-bubble translation. This is intentionally local to the
    // ancestor/descendant chain so adjacent repeated messages remain separate.
    try {
      node.querySelectorAll?.(`.${HOST_CLASS}`).forEach(other => {
        if (other !== node) clearNodeTranslation(other, true);
      });
      let parent = node.parentElement;
      for (let depth = 0; parent && depth < 5; depth += 1, parent = parent.parentElement) {
        if (!parent.classList?.contains(HOST_CLASS)) continue;
        const parentSource = cleanText(parent.getAttribute(SOURCE_ATTR) || '');
        if (parentSource && (parentSource === source || parentSource.includes(source) || source.includes(parentSource))) clearNodeTranslation(parent, true);
      }
    } catch {}
  }
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
  if ((settings.platform || platformFromHost()) === 'metabusiness') node.setAttribute(PINNED_ATTR, '1');
  scheduleCrmBackfillAfterTranslation(node, source, target, 90);
  rememberRenderCache(translationRenderCacheKey(source),target);
  persistPreloadTranslationCacheSoon();
  // V1.27.35: translation has just proven that this exact source host exists in
  // the live DOM. If it is an explicit customer-age statement, trigger CRM fact
  // extraction immediately instead of waiting up to the 3.5s heartbeat. The
  // normal fact/signature dedupe keeps repeated scroll hydration cheap.
  if ((settings.platform || platformFromHost()) === 'metabusiness' && metaBusinessMessageRoleByLane(node) === 'customer') {
    if (/(?:^|[。！？!?、,\s])(?:私は|わたしは|僕は|ぼくは|俺は)\s*\d{2,3}\s*(?:歳|才|です|ですよ|ですね)(?=[。！？!?、,\s]|$)/u.test(source)) {
      scheduleCrmAutoExtract(160);
    }
  }
}


// V1.27.59: every visible translation state mutation is viewport-anchored on
// Meta Business. The wrapper is intentionally outside the translation/provider
// logic: it only neutralizes layout-induced scrollTop drift and never changes
// message selection, cache keys, translation text, or retry semantics.
function clearNodeTranslation(node, force = false) {
  return withMetaBusinessTranslationViewportAnchor(node, () => clearNodeTranslationUnsafe(node, force));
}
function markNoTranslationNeeded(node,text,key='') {
  return withMetaBusinessTranslationViewportAnchor(node, () => markNoTranslationNeededUnsafe(node,text,key));
}
function markPending(node,text) {
  return withMetaBusinessTranslationViewportAnchor(node, () => markPendingUnsafe(node,text));
}
function markError(node,text,message='翻译失败，稍后自动重试') {
  return withMetaBusinessTranslationViewportAnchor(node, () => markErrorUnsafe(node,text,message));
}
function attachTranslation(node,original,translated) {
  return withMetaBusinessTranslationViewportAnchor(node, () => attachTranslationUnsafe(node,original,translated));
}

function translationTextCacheKey(text, lane='incoming') {
  // V1.27.29: Meta can rebuild the same history bubble with different DOM line
  // breaks while scrolling. Cache by semantic source text, not those volatile
  // layout newlines, so recycled old messages restore their existing Chinese
  // translation immediately and never start another provider request.
  const stableSource = cleanText(text).replace(/\s+/g, ' ').trim();
  // Engine is part of the local key so switching the global translator does not
  // accidentally reuse a renderer-memory result created by another provider.
  return `${lane}|${settings.engine || 'none'}|${settings.source}|${settings.target}|${stableSource}`;
}

function cachedTranslationForText(text,lane='incoming') {
  const key=translationTextCacheKey(text,lane);
  const direct=cleanText(textCache.get(key)||'');
  if(direct && direct!==cleanText(text) && !invalidTranslationPlaceholder(text,direct)) return {key,translated:direct,tier:'engine'};
  if(lane!=='outgoing-local'){
    const renderKey=translationRenderCacheKey(text);
    const rendered=cleanText(renderTextCache.get(renderKey)||'');
    if(rendered && rendered!==cleanText(text) && !invalidTranslationPlaceholder(text,rendered)) return {key,translated:rendered,tier:'render'};
  }
  return {key,translated:'',tier:''};
}
function rememberCache(key,value,sourceText='') {
  if (!key || !value) return;
  if (!textCache.has(key)) cacheOrder.push(key);
  textCache.set(key,value);
  while (cacheOrder.length > 5200) textCache.delete(cacheOrder.shift());
  const original=cleanText(sourceText||'') || (()=>{ const parts=String(key).split('|'); return parts.length>=4?parts.slice(3).join('|'):''; })();
  if(original) rememberRenderCache(translationRenderCacheKey(original),value);
  persistPreloadTranslationCacheSoon();
}

function clearDelayedTranslationPending(node) {
  try {
    const timer = translationPendingTimers.get(node);
    if (timer) clearTimeout(timer);
    translationPendingTimers.delete(node);
  } catch {}
}

function scheduleDelayedTranslationPending(node,text,delay=900) {
  clearDelayedTranslationPending(node);
  // V1.27.62 Meta viewport mode: never insert a temporary '翻译中…' row.
  // A pending pseudo-row changes message height once before the final Chinese
  // result changes it again, which is unnecessary layout churn in a virtual list.
  // Meta now changes height at most once: when the final translation/error lands.
  if (platformFromHost() === 'metabusiness') return;
  const timer=setTimeout(()=>{
    translationPendingTimers.delete(node);
    if (!node?.isConnected || messageText(node)!==text) return;
    if (node.hasAttribute(TRANSLATION_ATTR) || node.hasAttribute(NOOP_ATTR)) return;
    markPending(node,text);
  },Math.max(80,Number(delay)||140));
  translationPendingTimers.set(node,timer);
}

function enqueueNode(node) {
  if (!node || queuedNodes.has(node)) return;
  const messageRole = platformFromHost() === 'metabusiness' ? metaBusinessMessageRoleByLane(node) : crmMessageRole(node);
  const outgoingLocal = messageRole === 'me' && settings.translateOutgoingLocal === true;
  // V1.27.170: incoming remains provider/DeepL-owned; our own Japanese lane is
  // allowed only through the main-process local-only Ollama route.
  if (messageRole !== 'customer' && !outgoingLocal) {
    clearNodeTranslation(node, true);
    return;
  }
  if (platformFromHost() === 'metabusiness' && metaBusinessReplyQuotePreview(node)) {
    clearNodeTranslation(node, true);
    return;
  }
  const text = messageText(node);
  if (likelyUiText(text) || nonTranslatableChatText(text)) return;
  // V1.27.60: candidate identity can hop between nested Meta React nodes. If
  // this physical message already owns a final pinned translation, the scan is
  // complete even when the current candidate is a different wrapper. Zero DOM
  // writes here means completed translations stay visually immutable.
  if (platformFromHost() === 'metabusiness' && metaBusinessPinnedTranslationHost(node,text)) {
    clearDelayedTranslationPending(node);
    return;
  }
  if (looksLikeTargetLanguage(text, settings.target)) {
    clearNodeTranslation(node);
    return;
  }
  if (node.getAttribute(SOURCE_ATTR) === text && (node.hasAttribute(TRANSLATION_ATTR) || node.hasAttribute(NOOP_ATTR))) return;

  // V1.23.9 scroll-cache fix: TikTok and other virtualized chat lists recreate
  // message elements while scrolling. Restore a translated message immediately
  // from memory BEFORE showing "翻译中…", so scrolling old history has no
  // translation flash and never spends another provider request for that text.
  const localHit = cachedTranslationForText(text, messageRole === 'me' ? 'outgoing-local' : 'incoming');
  const key = localHit.key;
  const cached = localHit.translated;
  if (cached) {
    clearDelayedTranslationPending(node);
    attachTranslation(node,text,cached);
    return;
  }
  if (cached && invalidTranslationPlaceholder(text,cached)) textCache.delete(key);
  if (noTranslationTextKeys.has(key)) {
    markNoTranslationNeeded(node,text,key);
    return;
  }

  const failedUntil = Number(failedTextRetryUntil.get(key) || 0);
  if (failedUntil > Date.now()) return;
  if (failedUntil && failedUntil <= Date.now()) failedTextRetryUntil.delete(key);
  const retry = Number(retryAfter.get(node) || 0);
  if (retry > Date.now()) return;
  // Do not flash '翻译中…' for history nodes whose translation is already in
  // main's persistent cache. Give the cache-hit IPC one paint window first.
  scheduleDelayedTranslationPending(node,text,900);
  queuedNodes.add(node);
  queue.push({node,text,key,role:messageRole});
  pumpQueue();
}

function pumpQueue() {
  // A VPS cache hit is just one HTTPS round-trip, so parallelize visible bubble
  // lookups aggressively. Direct/local model translation stays capped at 2.
  const maxConcurrent = MAX_CONCURRENT_TRANSLATIONS; // V1.27.46 cache misses still use the local model; do not overload Ollama.
  while (activeTranslations < maxConcurrent && queue.length) {
    const job = queue.shift();
    if (!job?.node?.isConnected) { queuedNodes.delete(job?.node); continue; }
    activeTranslations++;
    translateJob(job).finally(() => {
      activeTranslations = Math.max(0,activeTranslations-1);
      pumpQueue();
    });
  }
}

function metaBusinessShortContextNeeded(text='') {
  const raw=cleanText(text||'');
  if(!raw)return false;
  const length=[...raw].length;
  if(length>90)return false;
  // Exact self-contained greetings/acks do not need context and stay on the
  // fastest path. Ambiguous particles, omitted subjects and mixed JA/English do.
  const trivial=raw.replace(/[\s。！？!?、,.，…~〜～❤️❤😊☺️🙂😄😂🤣🥰😍✨🌸👍🙏]/g,'');
  if(/^(?:はい|うん|ううん|そうです|そうだね|そうですね|そうなんだ|そうなんですね|了解|わかった|分かった|ありがとう|ありがとうございます|おはよう|おはようございます|こんにちは|こんばんは|おやすみ|おやすみなさい|さようなら|またね|いいね|頑張って|がんばって|頑張ろう|がんばろう)$/i.test(trivial))return false;
  if(length<=34)return /[ぁ-んァ-ヶ一-龯]/u.test(raw);
  return /(?:これ|それ|あれ|そう|そんな|こんな|その人|あの人|彼|彼女|さっき|前に|だから|でも|けど|けれど|かな|かも|んです|んだけど|って|という|わけ|ところ|みたい|らしい|っぽい|やっぱり|別に|どうせ|一応|むしろ)|(?:[A-Za-z]{2,}.*[ぁ-んァ-ヶ一-龯]|[ぁ-んァ-ヶ一-龯].*[A-Za-z]{2,})/i.test(raw);
}
function metaBusinessTranslationContext(node,text,candidatePool=null) {
  try {
    if(platformFromHost()!=='metabusiness'||!metaBusinessShortContextNeeded(text))return [];
    const root=metaBusinessChatRoot();
    if(!root||!(node instanceof Element))return [];
    const pool=Array.isArray(candidatePool)&&candidatePool.length?candidatePool:metaBusinessCandidates();
    const targetRect=node.getBoundingClientRect();
    const rows=[];
    for(const candidate of pool){
      if(!(candidate instanceof Element)||candidate===node||!candidate.isConnected||!root.contains(candidate))continue;
      const r=candidate.getBoundingClientRect();
      if(r.top>=targetRect.top-2)continue;
      const value=messageText(candidate);
      if(!value||likelyUiText(value)||nonTranslatableChatText(value)||metaBusinessReplyQuotePreview(candidate,root))continue;
      const role=metaBusinessMessageRoleByLane(candidate);
      if(role!=='me'&&role!=='customer')continue;
      rows.push({top:r.top,role:role==='me'?'me':'customer',text:value.slice(0,500)});
    }
    rows.sort((a,b)=>a.top-b.top);
    return rows.slice(-3).map(({role,text})=>({role,text}));
  } catch { return []; }
}
function translationContextFingerprint(context=[]) {
  return (Array.isArray(context)?context:[]).slice(-3).map(item=>`${String(item?.role||'')}\u001e${cleanText(item?.text||'').replace(/\s+/g,' ')}`).join('\u001f');
}

function invalidTranslationPlaceholder(source = '', translated = '') {
  const t=cleanText(translated), s=cleanText(source);
  if (!t) return true;
  if (/^(?:user\s+safety\s*:\s*safe|safety\s*:\s*safe|safe)$/i.test(t) && !/(?:user\s+safety|safety)/i.test(s)) return true;
  if (/^(?:content\s+policy|policy\s*:\s*(?:safe|allowed)|moderation\s*:\s*safe)$/i.test(t)) return true;
  return false;
}

async function requestTranslationForText(text,key,options={}) {
  const context=Array.isArray(options?.context)?options.context:[];
  const direction=options?.direction==='outgoing'?'outgoing':'incoming';
  const requestKey=`${key}|ctx:${translationContextFingerprint(context)}`;
  const existing = inFlightTextTranslations.get(requestKey);
  if (existing) return existing;

  const request = (async () => {
    // V1.27.57: do not race ipcRenderer.invoke() against a renderer timer.
    // Promise.race cannot cancel the main-process/Ollama request, so V1.27.55
    // could declare a timeout while the original job kept running, then enqueue
    // another retry behind it. That produced a self-amplifying failure queue.
    let result = await ipcRenderer.invoke('external-inline-translate', {
      text, source:direction==='outgoing'?'ja':(settings.source || 'auto'), target:settings.target || 'zh', direction, context, skipSharedCache:options?.skipSharedCache === true
    });
    let translated = result?.ok && typeof result.translated === 'string' ? cleanText(result.translated) : '';

    // Only retry when the provider returned successfully but the payload itself
    // was unusable/unchanged. Transport/provider failures enter a quiet text-key
    // backoff and are never hammered by the recovery heartbeat.
    const invalid = !translated || translated === text || invalidTranslationPlaceholder(text, translated);
    if (result?.ok && invalid && !looksLikeTargetLanguage(text, settings.target)) {
      await new Promise(resolve => setTimeout(resolve, 180));
      result = await ipcRenderer.invoke('external-inline-translate', {
        text, source:direction==='outgoing'?'ja':(settings.source || 'auto'), target:settings.target || 'zh', direction, context, force:true, skipSharedCache:options?.skipSharedCache === true
      });
      translated = result?.ok && typeof result.translated === 'string' ? cleanText(result.translated) : '';
    }
    if (invalidTranslationPlaceholder(text,translated)) translated = '';
    if (translated && translated !== text) {
      rememberCache(key,translated,text);
      clearTranslationFailureBackoff(key);
    }
    return { result, translated };
  })();

  inFlightTextTranslations.set(requestKey, request);
  try {
    return await request;
  } finally {
    if (inFlightTextTranslations.get(requestKey) === request) inFlightTextTranslations.delete(requestKey);
  }
}

async function translateJob({node,text,key,role='customer'}) {
  try {
    if (!node.isConnected || messageText(node) !== text) return;
    if (looksLikeTargetLanguage(text, settings.target)) { clearNodeTranslation(node); return; }
    key = key || translationTextCacheKey(text, role === 'me' ? 'outgoing-local' : 'incoming');
    const cached = textCache.get(key);
    if (cached && cached !== text) {
      attachTranslation(node,text,cached);
      return;
    }

    const { result, translated } = await requestTranslationForText(text,key,{direction:role === 'me' ? 'outgoing' : 'incoming'});

    // The translation above has already been cached. Only DOM attachment is
    // conditional on this exact virtualized node still representing the text.
    if (!node.isConnected || messageText(node) !== text) return;
    if (translated && translated !== text) {
      clearDelayedTranslationPending(node);
      attachTranslation(node,text,translated);
    } else if (result?.ok) {
      clearDelayedTranslationPending(node);
      // V1.27.42: never permanently classify real Japanese/English chat as a
      // no-op merely because Qwen returned the source unchanged once. Names,
      // IDs and already-target-language text are filtered before the request.
      // A real source sentence gets a bounded retry instead of disappearing.
      rememberTranslationFailureBackoff(key, 30000);
      markError(node,text,'译文未返回 · 可点重译');
    } else {
      clearDelayedTranslationPending(node);
      rememberTranslationFailureBackoff(key, 45000);
      markError(node,text,'翻译暂不可用 · 可点重译');
    }
  } catch {
    clearDelayedTranslationPending(node);
    rememberTranslationFailureBackoff(key || translationTextCacheKey(text), 45000);
    if (node?.isConnected && messageText(node) === text) markError(node,text,'翻译暂不可用 · 可点重译');
  } finally {
    clearDelayedTranslationPending(node);
    queuedNodes.delete(node);
  }
}


function commitMetaBusinessTranslationJobs(jobs, scroller, snapshot, stillCurrent) {
  // Atomic DOM commit: one bounded completed group is written in one JS task,
  // preserving the V1.27.63 viewport anchor invariant while allowing cache hits
  // and fast cloud groups to appear without waiting for unrelated slow misses.
  if (!stillCurrent()) return 0;
  const commit = (jobs || []).filter(job => {
    if (job.committed || job.state === 'request') return false;
    if (!(job.node instanceof Element) || !job.node.isConnected || messageText(job.node)!==job.text) return false;
    if (!scroller || !scroller.isConnected || !scroller.contains(job.node)) return false;
    const r=job.node.getBoundingClientRect(), vr=scroller.getBoundingClientRect();
    return r.bottom>vr.top+2 && r.top<vr.bottom-2;
  });
  if (!commit.length) return 0;
  metaBusinessTranslationViewportMutationDepth += 1;
  try {
    for (const job of commit) {
      clearDelayedTranslationPending(job.node);
      if (job.state==='translated' && job.translated) attachTranslationUnsafe(job.node,job.text,job.translated);
      else if (job.state==='noop') markNoTranslationNeededUnsafe(job.node,job.text,job.key);
      else if (job.state==='error') markErrorUnsafe(job.node,job.text,job.error||'翻译暂不可用 · 可点重译');
      job.committed = true;
    }
  } finally { metaBusinessTranslationViewportMutationDepth=Math.max(0,metaBusinessTranslationViewportMutationDepth-1); }
  if (snapshot && stillCurrent()) {
    metaBusinessRestoreTranslationViewportAnchor(snapshot,false);
    try { requestAnimationFrame(()=>{ if(stillCurrent()) metaBusinessRestoreTranslationViewportAnchor(snapshot,false); }); } catch {}
  }
  return commit.length;
}

function metaBusinessProviderConcurrency() {
  // Local Ollama benefits from strict single-flight. Cloud translation engines
  // are latency-bound, so a small bounded lane makes the visible viewport feel
  // immediate without creating an uncontrolled request burst.
  return String(settings.engine || '').toLowerCase() === 'ollama' ? 1 : 3;
}

// V1.27.81: new-message first-paint lane. The ordinary viewport batch is ideal
// for history/cache restoration, but it can already be translating older misses
// when a fresh customer bubble arrives. A new message must not wait behind that
// historical batch. Coalesce Meta's React mutation burst, inspect only the newest
// visible untranslated bubble, and let latency-bound cloud engines go directly
// to the provider after renderer/main local-cache checks. This lane never bypasses
// the persistent local cache; it only skips the optional VPS miss round-trip for
// cloud engines where the provider is normally faster than a remote cache miss.
let metaBusinessUrgentTranslationTimer = null;
let metaBusinessUrgentTranslationSeq = 0;
function metaBusinessCloudFastLaneEngine() {
  return ['googleweb','google','deepl','mymemory','libre'].includes(String(settings.engine || '').toLowerCase());
}
function scheduleMetaBusinessUrgentTranslation(delay = 28) {
  if (platformFromHost() !== 'metabusiness' || !settings.enabled || document.hidden) return false;
  if (metaBusinessUrgentTranslationTimer) clearTimeout(metaBusinessUrgentTranslationTimer);
  metaBusinessUrgentTranslationTimer = setTimeout(() => {
    metaBusinessUrgentTranslationTimer = null;
    void translateMetaBusinessUrgentNewest();
  }, Math.max(16, Math.min(90, Number(delay) || 28)));
  return true;
}
async function translateMetaBusinessUrgentNewest() {
  const seq = ++metaBusinessUrgentTranslationSeq;
  try {
    if (document.hidden || !settings.enabled || !settings.providerReady || metaBusinessUserIsScrolling()) return false;
    if (!isConversationReady(undefined,false)) return false;
    const root = metaBusinessChatRoot();
    if (!root) return false;
    const scroller = metaBusinessTranslationScrollRoot() || root;
    const vr = scroller.getBoundingClientRect?.();
    if (!vr) return false;

    const candidates = metaBusinessCandidates();
    const eligible = [];
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const node = candidates[index];
      if (!(node instanceof Element) || !node.isConnected || !scroller.contains(node)) continue;
      const r = node.getBoundingClientRect();
      if (!(r.bottom > vr.top + 2 && r.top < vr.bottom - 2)) continue;
      if (metaBusinessReplyQuotePreview(node,root)) continue;
      const role = metaBusinessMessageRoleByLane(node);
      if (role !== 'customer') { clearNodeTranslation(node, true); continue; }
      const text = messageText(node);
      if (!text || likelyUiText(text) || nonTranslatableChatText(text)) continue;
      if(role==='customer') queueMetaServerPretranslation(text);
      if (metaBusinessPinnedTranslationHost(node,text,root)) continue;
      if (node.getAttribute(SOURCE_ATTR) === text && (node.hasAttribute(TRANSLATION_ATTR) || node.hasAttribute(NOOP_ATTR))) continue;
      const localHit = cachedTranslationForText(text);
      if (localHit.translated) {
        attachTranslation(node,text,localHit.translated);
        return true;
      }
      if (looksLikeTargetLanguage(text,settings.target) || noTranslationTextKeys.has(localHit.key)) continue;
      if (Number(failedTextRetryUntil.get(localHit.key) || 0) > Date.now()) continue;
      eligible.push({node,text,key:localHit.key,role,top:r.top,context:metaBusinessTranslationContext(node,text,candidates)});
      if (eligible.length >= 8) break;
    }
    if (!eligible.length) return false;
    // V1.27.130: eligible rows are customer-only; never fall back to our own bubble.
    const job = eligible[0];

    // A running history batch may otherwise hold a newly-arrived message behind
    // many older misses. Invalidate that batch's DOM generation so it finishes
    // only its current bounded group, then rescan newest-first. For Ollama we do
    // not start a second model request in parallel; this prevents self-contention.
    if (metaBusinessViewportBatchRunning) {
      metaBusinessViewportBatchSeq += 1;
      metaBusinessViewportBatchRescan = true;
      if (!metaBusinessCloudFastLaneEngine()) return false;
    }
    if (!metaBusinessCloudFastLaneEngine()) {
      scheduleScan(35);
      return false;
    }

    const {result,translated} = await requestTranslationForText(job.text,job.key,{skipSharedCache:true,context:job.context,direction:job.role==='me'?'outgoing':'incoming'});
    if (seq !== metaBusinessUrgentTranslationSeq && (!job.node?.isConnected || messageText(job.node)!==job.text)) return false;
    if (!job.node?.isConnected || messageText(job.node)!==job.text) return false;
    if (translated && translated !== job.text) {
      clearDelayedTranslationPending(job.node);
      attachTranslation(job.node,job.text,translated);
      return true;
    }
    // Do not paint an early error from the low-latency lane. The ordinary batch
    // keeps its existing fallback/backoff semantics and can retry safely.
    if (!result?.ok) scheduleScan(90);
    return false;
  } catch {
    scheduleScan(90);
    return false;
  }
}

async function translateMetaBusinessViewportBatch(nodes) {
  if (metaBusinessViewportBatchRunning) { metaBusinessViewportBatchRescan = true; return; }
  // V1.27.72: filter translated/quote rows before limiting provider work.
  // Keeping the bottom 60 guarantees that newest customer text cannot be hidden
  // behind already-translated history occupying the first eighteen DOM rows.
  const list = Array.from(nodes || []).filter(node => node instanceof Element && node.isConnected).slice(-60);
  if (!list.length) return;
  metaBusinessViewportBatchRunning = true;
  metaBusinessViewportBatchRescan = false;
  const batchId = ++metaBusinessViewportBatchSeq;
  const generation = metaBusinessUserScrollGeneration;
  const chatRoot = metaBusinessChatRoot();
  // V1.27.80: short/read-only chats may have no overflowing scroll container at
  // all. The conversation root itself is still a valid viewport for translation.
  const scroller = metaBusinessTranslationScrollRoot(list[0]) || chatRoot;
  const snapshot = metaBusinessTranslationScrollRoot(list[0]) ? metaBusinessCaptureTranslationViewportAnchor(list[0]) : null;
  const sr = scroller?.getBoundingClientRect?.();
  const jobs = [];
  const stillCurrent = () => batchId === metaBusinessViewportBatchSeq && generation === metaBusinessUserScrollGeneration && !metaBusinessUserIsScrolling();
  try {
    for (const node of list) {
      if (!(node instanceof Element) || !node.isConnected) continue;
      const role=metaBusinessMessageRoleByLane(node);
      const outgoingLocal=role==='me' && settings.translateOutgoingLocal===true;
      if (role !== 'customer' && !outgoingLocal) { clearNodeTranslation(node, true); continue; }
      const r = node.getBoundingClientRect();
      if (sr && !(r.bottom > sr.top + 2 && r.top < sr.bottom - 2)) continue;
      if (metaBusinessReplyQuotePreview(node, chatRoot)) continue;
      const text = messageText(node);
      if (!text || likelyUiText(text) || nonTranslatableChatText(text)) continue;
      if(role==='customer') queueMetaServerPretranslation(text);
      if (metaBusinessPinnedTranslationHost(node,text,chatRoot)) continue;
      if (node.getAttribute(SOURCE_ATTR) === text && (node.hasAttribute(TRANSLATION_ATTR) || node.hasAttribute(NOOP_ATTR))) continue;
      const qualityContext=role==='customer'?metaBusinessTranslationContext(node,text,list):[];
      const localHit = cachedTranslationForText(text, role==='me'?'outgoing-local':'incoming');
      const key = localHit.key;
      if (localHit.translated) {
        jobs.push({node,text,key,role,context:qualityContext,translated:localHit.translated,state:'translated',cacheTier:localHit.tier});
        continue;
      }
      if (looksLikeTargetLanguage(text, settings.target) || noTranslationTextKeys.has(key)) {
        jobs.push({node,text,key,role,context:qualityContext,state:'noop'});
        continue;
      }
      const failedUntil = Number(failedTextRetryUntil.get(key) || 0);
      if (failedUntil > Date.now()) continue;
      jobs.push({node,text,key,role,context:qualityContext,state:'request'});
    }

    // V1.27.70: restore all visible exact cache hits in ONE IPC + ONE VPS
    // request before touching the local model. Previously the viewport loop did
    // one 0.9s VPS lookup per bubble, so ten cached messages could still feel
    // slow after a local profile/cache folder had been cleared.
    const cacheCandidates = jobs
      .filter(job => job.state === 'request' && job.role === 'customer' && Number(exactCacheMissUntil.get(job.key) || 0) <= Date.now())
      .sort((a,b) => b.node.getBoundingClientRect().top - a.node.getBoundingClientRect().top);
    if (cacheCandidates.length && stillCurrent()) {
      try {
        const batch = await ipcRenderer.invoke('external-inline-translation-cache-batch', {
          items:cacheCandidates.map((job,index)=>({ id:`m${index}`, text:job.text, source:settings.source || 'auto', target:settings.target || 'zh', context:job.context || [] })),
          preferSpeed:metaBusinessCloudFastLaneEngine()
        });
        const rows = Array.isArray(batch?.items) ? batch.items : [];
        for (let index=0; index<cacheCandidates.length; index++) {
          const job=cacheCandidates[index], row=rows[index];
          const translated=row?.hit ? cleanText(row.translated || '') : '';
          if (!translated || translated === job.text || invalidTranslationPlaceholder(job.text,translated)) {
            if (batch?.ok && row && !row.hit) rememberExactCacheMiss(job.key);
            continue;
          }
          clearExactCacheMiss(job.key);
          rememberCache(job.key,translated,job.text);
          job.translated=translated; job.state='translated'; job.cacheTier=String(row?.tier || 'cache');
        }
      } catch {}
    }

    // V1.27.71: cache hits are UI-ready now. Do not hold them behind genuine
    // provider misses. This is the main reason history used to look "slow" even
    // when local/VPS cache already contained most translations.
    commitMetaBusinessTranslationJobs(jobs,scroller,snapshot,stillCurrent);

    // Cache restoration is independent from provider startup. If Ollama is still
    // booting, keep real misses untouched; the provider-ready settings broadcast
    // will wake another scan without erasing the cache translations already shown.
    if (!settings.providerReady) return;

    let pendingJobs = jobs.filter(job => job.state === 'request').sort((a,b) => b.node.getBoundingClientRect().top - a.node.getBoundingClientRect().top);
    if (pendingJobs.length > 24) {
      pendingJobs = pendingJobs.slice(0,24);
      metaBusinessViewportBatchRescan = true;
    }
    const concurrency = Math.max(1, Math.min(3, metaBusinessProviderConcurrency()));
    for (let offset=0; offset<pendingJobs.length; offset+=concurrency) {
      if (!stillCurrent()) break;
      const group=pendingJobs.slice(offset,offset+concurrency);
      await Promise.all(group.map(async job => {
        activeTranslations += 1;
        try {
          // The viewport already performed one local+VPS batch probe. Do not pay
          // a second VPS round trip for every cache miss before invoking provider.
          const {result,translated} = await requestTranslationForText(job.text,job.key,{skipSharedCache:true,context:job.context});
          if (translated && translated !== job.text) {
            job.translated=translated; job.state='translated';
          } else if (result?.ok) {
            rememberTranslationFailureBackoff(job.key,30000); job.state='error'; job.error='译文未返回 · 可点重译';
          } else {
            rememberTranslationFailureBackoff(job.key,45000); job.state='error'; job.error='翻译暂不可用 · 可点重译';
          }
        } catch {
          rememberTranslationFailureBackoff(job.key,45000); job.state='error'; job.error='翻译暂不可用 · 可点重译';
        } finally { activeTranslations=Math.max(0,activeTranslations-1); }
      }));
      if (!stillCurrent()) break;
      // Progressive bounded commits: cloud engines show each small completed
      // group immediately; Ollama still commits one-at-a-time after its result.
      commitMetaBusinessTranslationJobs(group,scroller,snapshot,stillCurrent);
    }

    // User moved while translation was running: keep cache only, do not mutate
    // the old virtualized viewport at all.
    if (!stillCurrent()) return;
    commitMetaBusinessTranslationJobs(jobs,scroller,snapshot,stillCurrent);
  } finally {
    metaBusinessViewportBatchRunning=false;
    if (metaBusinessViewportBatchRescan && !document.hidden && !metaBusinessUserIsScrolling()) {
      metaBusinessViewportBatchRescan=false;
      scheduleScan(90);
    }
  }
}

let metaCachedRestoreRaf = 0;
function restoreCachedMetaTranslationsNow() {
  metaCachedRestoreRaf=0;
  try {
    if(document.hidden||!settings.enabled||platformFromHost()!=='metabusiness'||hasVisibleLoginForm()||!isMessagingUrl('metabusiness'))return 0;
    ensureStyles();
    const nodes=metaBusinessCandidates();
    let restored=0;
    for(const node of nodes){
      if(!(node instanceof Element)||!node.isConnected)continue;
      const role=metaBusinessMessageRoleByLane(node);
      if(role!=='customer' && !(role==='me' && settings.translateOutgoingLocal===true)){clearNodeTranslation(node,true);continue;}
      const text=messageText(node);
      if(!text||likelyUiText(text)||nonTranslatableChatText(text)||metaBusinessReplyQuotePreview(node))continue;
      if(node.getAttribute(SOURCE_ATTR)===text&&node.hasAttribute(TRANSLATION_ATTR))continue;
      const hit=cachedTranslationForText(text,role==='me'?'outgoing-local':'incoming');
      if(!hit.translated)continue;
      attachTranslationUnsafe(node,text,hit.translated); restored+=1;
    }
    return restored;
  } catch { return 0; }
}
function scheduleMetaCachedTranslationRestore() {
  if(metaCachedRestoreRaf||platformFromHost()!=='metabusiness'||!settings.enabled)return;
  try { metaCachedRestoreRaf=requestAnimationFrame(()=>restoreCachedMetaTranslationsNow()); }
  catch { metaCachedRestoreRaf=setTimeout(()=>restoreCachedMetaTranslationsNow(),0); }
}

function scanVisibleMessages() {
  scanTimer = null;
  if (document.hidden) return;
  if (!isConversationReady(undefined,false)) {
    clearTranslationsOutsideConversation();
    if (platformFromHost() === 'metabusiness' && Date.now() <= metaTranslationFastWakeUntil && isMessagingUrl('metabusiness') && !hasVisibleLoginForm()) scheduleScan(120);
    return;
  }
  if (platformFromHost() === 'metabusiness' && metaBusinessUserIsScrolling()) return;
  ensureStyles();
  let nodes = candidateElements();
  if (platformFromHost() === 'metabusiness') {
    const scroller = metaBusinessTranslationScrollRoot() || metaBusinessChatRoot();
    const sr = scroller?.getBoundingClientRect?.();
    if (!sr) return;
    nodes = nodes.filter(node => {
      if (!(node instanceof Element) || !node.isConnected || !scroller.contains(node)) return false;
      const r = node.getBoundingClientRect();
      return r.bottom > sr.top + 2 && r.top < sr.bottom - 2;
    });
    nodes.sort((a,b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    void translateMetaBusinessViewportBatch(nodes);
    return;
  }
  nodes.sort((a,b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
  for (const node of nodes.slice(0,18)) enqueueNode(node);
}

function scheduleScan(delay=250) {
  if (!settings.enabled) return;
  const ready = isConversationReady(undefined,false);
  if (!ready) {
    clearTranslationsOutsideConversation();
    // V1.27.79: during a bounded Meta hydration wake window, keep polling the
    // actual page every ~120ms instead of dropping the request and waiting for
    // an unrelated future mutation. This is what removes the "open app and
    // wait many seconds before translation starts" failure mode.
    if (platformFromHost() === 'metabusiness' && Date.now() <= metaTranslationFastWakeUntil && isMessagingUrl('metabusiness') && !hasVisibleLoginForm()) {
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = setTimeout(scanVisibleMessages, Math.max(90, Math.min(180, Number(delay) || 120)));
    }
    return;
  }
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = setTimeout(scanVisibleMessages, Math.max(60,delay));
}

function clearTranslationsUnsafe() {
  try { document.querySelectorAll(`.${HOST_CLASS}`).forEach(node => clearNodeTranslation(node, true)); } catch {}
  // V1.27.55: queue reset must release WeakSet ownership. Previously the array
  // was truncated while queuedNodes still remembered those DOM nodes forever,
  // so some visible messages could never be enqueued again after navigation or
  // a settings refresh.
  for (const job of queue) { try { if (job?.node) queuedNodes.delete(job.node); } catch {} }
  queue.length = 0;
}


function clearTranslations() {
  return withMetaBusinessTranslationViewportAnchor(metaBusinessChatRoot(), () => clearTranslationsUnsafe());
}

function clearTranslationsOutsideConversation() {
  if (isConversationReady(undefined,false)) return;
  // V1.27.79: Meta briefly removes the composer while the same inbox/chat
  // route hydrates or switches customer. That is not a real navigation away
  // from messaging, so never erase completed/cache-rendered translations here.
  if (platformFromHost() === 'metabusiness' && isMessagingUrl('metabusiness') && !hasVisibleLoginForm()) return;
  clearTranslations();
}

function applySettings(next={}) {
  const old = {...settings};
  settings = {...settings,...next,platform:next.platform || platformFromHost() || settings.platform};
  if (!settings.enabled) {
    clearTranslations();
    return;
  }
  if (!isConversationReady(undefined,false)) {
    clearTranslationsOutsideConversation();
    if (platformFromHost() === 'metabusiness') kickMetaTranslationFastWake('settings');
    return;
  }
  if (!old.enabled || old.target !== settings.target || old.displayMode !== settings.displayMode || old.source !== settings.source || old.engine !== settings.engine || old.translateOutgoingLocal !== settings.translateOutgoingLocal) {
    clearTranslations();
    if (old.target !== settings.target || old.source !== settings.source || old.engine !== settings.engine) {
      textCache.clear();
      cacheOrder.length = 0;
      noTranslationTextKeys.clear();
      noTranslationKeyOrder.length = 0;
      failedTextRetryUntil.clear();
      failedTextRetryOrder.length = 0;
      exactCacheMissUntil.clear();
      exactCacheMissOrder.length = 0;
    }
  }
  scheduleScan(120);
}

async function refreshSettings() {
  try {
    const next = await ipcRenderer.invoke('get-external-translation-settings');
    if (next && typeof next === 'object') applySettings(next);
  } catch {}
}

function metaBusinessMutationTouchesConversation(mutations = []) {
  if (platformFromHost() !== 'metabusiness') return true;
  const root = metaBusinessChatRoot();
  if (!root) return false;
  const intersects = node => {
    const el = node instanceof Element ? node : node?.parentElement;
    if (!el) return false;
    return el === root || root.contains(el) || el.contains?.(root);
  };
  return mutations.some(m => {
    if (intersects(m.target)) return true;
    return [...(m.addedNodes || []), ...(m.removedNodes || [])].some(intersects);
  });
}

function metaBusinessScrollTouchesConversation(event) {
  if (platformFromHost() !== 'metabusiness') return true;
  const root = metaBusinessChatRoot();
  if (!root) return false;
  const target = event?.target;
  if (target === root) return true;
  if (target instanceof Element && root.contains(target)) return true;
  try { return (event?.composedPath?.() || []).some(node => node === root || (node instanceof Element && root.contains(node))); } catch {}
  return false;
}

function metaBusinessMutationNodeIsYokoUi(node) {
  try {
    const el = node instanceof Element ? node : (node?.parentElement || node?.parentNode);
    if (!(el instanceof Element)) return false;
    return !!(el.matches?.('.yoko-global-message-actions,.yoko-v12754-actionbar,[data-yoko-ui="1"]') ||
      el.closest?.('.yoko-global-message-actions,.yoko-v12754-actionbar,[data-yoko-ui="1"]'));
  } catch { return false; }
}

function startObserver() {
  if (observer || !document?.documentElement) return;
  observer = new MutationObserver(mutations => {
    const meaningful = mutations.some(m => {
      if (m.type === 'characterData') return !metaBusinessMutationNodeIsYokoUi(m.target);
      return [...(m.addedNodes || []), ...(m.removedNodes || [])].some(node => !metaBusinessMutationNodeIsYokoUi(node));
    });
    // V1.27.41 native-direct performance rule: Meta's official contact list is
    // owned entirely by Meta. Its virtualization/mutations must not wake Yoko's
    // chat translator or CRM scanner. Only mutations intersecting the current
    // native conversation pane are eligible for chat work.
    const touchesConversation = platformFromHost() !== 'metabusiness' || metaBusinessMutationTouchesConversation(mutations);
    if(platformFromHost()==='metabusiness' && touchesConversation && meaningful) {
      scheduleMetaCachedTranslationRestore();
      // V1.27.81: a fresh message gets a dedicated first-paint lane instead of
      // waiting for the 260ms whole-viewport debounce/history queue.
      if (!metaBusinessUserIsScrolling()) scheduleMetaBusinessUrgentTranslation(28);
    }
    if (touchesConversation && !metaBusinessUserIsScrolling() && meaningful) {
      scheduleCrmAutoExtract(platformFromHost() === 'metabusiness' ? 360 : 220);
      scheduleCustomerCopyActions(platformFromHost() === 'metabusiness' ? 320 : 180);
    }
    if (!settings.enabled) return;
    if (!isConversationReady(undefined,false)) {
      clearTranslationsOutsideConversation();
      if (platformFromHost() === 'metabusiness' && touchesConversation) kickMetaTranslationFastWake('conversation-mutation', 5000);
      return;
    }
    if (touchesConversation && !metaBusinessUserIsScrolling() && mutations.some(m => m.type === 'childList' || m.type === 'characterData')) scheduleScan(95);
  });
  observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:false});
  window.addEventListener('scroll',(event) => {
    if (platformFromHost() === 'metabusiness') {
      // V1.27.92 avatar mirror is read-only: a native inbox scroll only harvests
      // avatars currently rendered by Meta; it never scrolls or mutates Meta's list.
      if (!metaBusinessScrollTouchesConversation(event)) scheduleMetaBusinessAvatarMirror(180);
      // Scrolling Meta's official inbox/customer list stays completely native.
      // Only the chat pane engages Yoko's scroll-idle translation/CRM pass.
      if (metaBusinessScrollTouchesConversation(event)) {
        metaBusinessRememberConversationScroller(event?.target);
        scheduleMetaCachedTranslationRestore();
        // V1.27.63: never fight Meta with a persistent scrollTop lock. Ignore the
        // one synthetic scroll emitted by our atomic anchor correction; every real
        // wheel/touch/pointer/key intent starts a new 340ms idle viewport cycle.
        if (Date.now() >= Number(metaBusinessProgrammaticScrollUntil || 0)) metaBusinessMarkScrollActivity(false);
      }
    } else { scheduleScan(220); scheduleCustomerCopyActions(140); }
  },true);
  const noteExplicitMetaScrollIntent = event => {
    if (platformFromHost() !== 'metabusiness' || !metaBusinessScrollTouchesConversation(event)) return;
    metaBusinessRememberConversationScroller(event?.target);
    metaBusinessMarkScrollActivity(true);
  };
  window.addEventListener('wheel', noteExplicitMetaScrollIntent, {capture:true, passive:true});
  window.addEventListener('touchmove', noteExplicitMetaScrollIntent, {capture:true, passive:true});
  // V1.27.79: clicking another Meta inbox customer can transiently remove the
  // composer before the new chat hydrates. Wake translation immediately on any
  // trusted click outside the current chat pane; identity/CRM routing is not
  // touched here.
  window.addEventListener('pointerdown', event => {
    if (platformFromHost() !== 'metabusiness' || !event?.isTrusted || metaBusinessScrollTouchesConversation(event)) return;
    scheduleMetaBusinessAvatarMirror(90);
    kickMetaTranslationFastWake('native-pointer', 6500);
  }, {capture:true, passive:true});

  // Scrollbar dragging does not necessarily emit wheel/touch events. Pointer
  // intent inside the chat pane cancels the viewport lock before the native
  // scrollbar moves so Yoko never fights the operator.
  window.addEventListener('pointerdown', event => {
    if (platformFromHost() !== 'metabusiness' || !metaBusinessScrollTouchesConversation(event)) return;
    const scroller = metaBusinessTranslationScrollRoot(event?.target instanceof Element ? event.target : null);
    const r = scroller?.getBoundingClientRect?.();
    // Only scrollbar-track intent belongs here. Ordinary clicks inside a bubble
    // must not cancel a stable translation viewport.
    if (!r || Number(event?.clientX || 0) < r.right - 22) return;
    metaBusinessRememberConversationScroller(scroller);
    metaBusinessMarkScrollActivity(true);
  }, {capture:true, passive:true});
  // Keyboard navigation (PageUp/PageDown/Home/End/arrows/Space) is user scroll
  // intent too. Do not restore an old translation anchor over it.
  window.addEventListener('keydown', event => {
    if (platformFromHost() !== 'metabusiness') return;
    if (event?.target?.closest?.('input,textarea,[contenteditable="true"],[role="textbox"]')) return;
    if (!['PageUp','PageDown','Home','End','ArrowUp','ArrowDown',' '].includes(String(event?.key || ''))) return;
    const root = metaBusinessChatRoot();
    if (!root) return;
    metaBusinessMarkScrollActivity(true);
  }, true);
  document.addEventListener('visibilitychange',() => { if (!document.hidden) { if(platformFromHost()==='metabusiness')scheduleMetaBusinessAvatarMirror(180,true); kickMetaTranslationFastWake('visible'); scheduleScan(60); scheduleCustomerCopyActions(100); } });
  window.addEventListener('popstate',() => { crmExtractLastSignature=''; lineAddedTerminalLastSignature=''; lineAddedTerminalPendingSignature=''; lineAddedTerminalPendingAt=0; clearTranslations(); kickMetaTranslationFastWake('popstate'); setTimeout(() => { refreshSettings(); scheduleScan(80); scheduleCrmAutoExtract(700); },0); });
  window.addEventListener('hashchange',() => { crmExtractLastSignature=''; lineAddedTerminalLastSignature=''; lineAddedTerminalPendingSignature=''; lineAddedTerminalPendingAt=0; clearTranslations(); kickMetaTranslationFastWake('hashchange'); setTimeout(() => { refreshSettings(); scheduleScan(80); scheduleCrmAutoExtract(700); },0); });
  window.addEventListener('pageshow',() => { installMetaPasskeyGuard(); crmExtractLastSignature=''; lineAddedTerminalLastSignature=''; lineAddedTerminalPendingSignature=''; lineAddedTerminalPendingAt=0; clearTranslations(); if(platformFromHost()==='metabusiness')scheduleMetaBusinessAvatarMirror(220,true); kickMetaTranslationFastWake('pageshow'); refreshSettings(); scheduleScan(60); scheduleCrmAutoExtract(850); });
}

// V1.27.57 quiet recovery heartbeat. V1.27.79 shortens Meta recovery to
// 2.5s while keeping the old ~12s cadence for other shared-preload platforms.
// Failed text keys stay in backoff and an active queue is never disturbed.
let translationRecoveryHeartbeatLastAt = 0;
setInterval(() => {
  try {
    const platform = platformFromHost();
    const cadence = platform === 'metabusiness' ? 2500 : 12000;
    if (Date.now() - translationRecoveryHeartbeatLastAt < cadence - 100) return;
    translationRecoveryHeartbeatLastAt = Date.now();
    if (platform === 'metabusiness' && !document.hidden && Date.now() - Number(metaBusinessAvatarMirrorHeartbeatLastAt || 0) >= 5000) {
      metaBusinessAvatarMirrorHeartbeatLastAt = Date.now();
      scheduleMetaBusinessAvatarMirror(120, false);
    }
    if (!document.hidden && settings.enabled && isConversationReady(undefined,false) && activeTranslations === 0 && queue.length === 0 && !metaBusinessViewportBatchRunning) scheduleScan(80);
  } catch {}
}, 2500);


// V1.27.92: while Meta Business is actually visible, quietly snapshot only
// the currently rendered native rows. Hidden/off-screen Meta views do no avatar work.
setInterval(() => {
  try {
    if(platformFromHost()!=='metabusiness'||document.hidden)return;
    const now=Date.now();if(now-metaBusinessAvatarMirrorHeartbeatLastAt<4400)return;
    metaBusinessAvatarMirrorHeartbeatLastAt=now;publishMetaBusinessAvatarMirror(false);
  } catch {}
}, 1500);

async function warmTranslationStartup() {
  await refreshSettings();
  // V1.27.79: Meta can take several seconds to expose the real composer/chat
  // root on a cold Electron launch. Keep a bounded 9s wake lane instead of only
  // trying for 1.4s and then falling back to a long heartbeat.
  kickMetaTranslationFastWake('startup', 9000);
  for (const delay of [20,80,180,360,700,1200,2000,3200,5000,7600]) {
    setTimeout(() => { if (!document.hidden && settings.enabled) scheduleScan(20); }, delay);
  }
}

ipcRenderer.on('external-translation-settings',(_e,next) => { applySettings(next || {}); kickMetaTranslationFastWake('settings-broadcast', 6000); });
window.addEventListener('DOMContentLoaded',() => { startObserver(); startCrmAutoExtractHeartbeat(); void warmTranslationStartup(); if(platformFromHost()==='metabusiness'){scheduleMetaBusinessAvatarMirror(320,true);setTimeout(()=>scheduleMetaBusinessAvatarMirror(80,true),1400);} scheduleCustomerCopyActions(180); scheduleCrmAutoExtract(480); });
if (document.readyState !== 'loading') { startObserver(); startCrmAutoExtractHeartbeat(); void warmTranslationStartup(); if(platformFromHost()==='metabusiness'){scheduleMetaBusinessAvatarMirror(260,true);setTimeout(()=>scheduleMetaBusinessAvatarMirror(80,true),1300);} scheduleCustomerCopyActions(140); scheduleCrmAutoExtract(420); }


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

function metaBusinessGptSnapshotRows(limit = 60) {
  try {
    const root=metaBusinessChatRoot();
    const composer=metaBusinessComposer();
    if(!root||!composer)return [];
    const rr=root.getBoundingClientRect(),cr=composer.getBoundingClientRect();
    const topLimit=Math.max(rr.top+54,72),bottomLimit=Math.min(innerHeight-6,cr.top-2);
    const nodes=[];const seenNode=new Set();
    const addNode=node=>{if(!(node instanceof Element)||seenNode.has(node))return;seenNode.add(node);nodes.push(node)};
    try{for(const node of candidateElements(false).slice(-100))addNode(node)}catch{}
    // Translation hosts are already vetted message bubbles and survive the
    // exact React hydration window where candidateElements can briefly be empty.
    for(const node of Array.from(root.querySelectorAll(`[${SOURCE_ATTR}]`)).slice(-180))addNode(node);
    const rows=[];const seenRow=new Set();let latestOwnBoundaryTop=-Infinity;
    for(const node of nodes){
      if(!node.isConnected||!isVisible(node))continue;
      const r=node.getBoundingClientRect();
      if(r.bottom<topLimit||r.top>bottomLimit||r.right<rr.left+6||r.left>rr.right-4)continue;
      const role=metaBusinessMessageRoleByLane(node)||crmMessageRole(node);
      if(role!=='customer'&&role!=='me')continue;
      // V1.27.78: the most recent visible outgoing bubble is an authoritative
      // reply boundary even when React temporarily hides/rebuilds its text leaf.
      if(role==='me') latestOwnBoundaryTop=Math.max(latestOwnBoundaryTop,Number(r.top||0));
      const text=messageSourceText(node);
      if(!text||likelyUiText(text)||metaBusinessExcludedUiText(text)||yokoActionToolbarOnlyText(text))continue;
      const key=`${role}|${text}|${Math.round(r.top/6)}`;if(seenRow.has(key))continue;seenRow.add(key);
      const timeText=yokoHistoryNativeTime(node);
      rows.push({role,text:text.slice(0,2000),top:r.top,timeText,delivered:yokoExternalNativeTimeMs(timeText),boundary:false});
    }
    if(Number.isFinite(latestOwnBoundaryTop)){
      const alreadyHasOwnAtOrBelow=rows.some(row=>row.role==='me'&&Number(row.top||0)>=latestOwnBoundaryTop-8);
      if(!alreadyHasOwnAtOrBelow) rows.push({role:'me',text:'',top:latestOwnBoundaryTop,timeText:'',delivered:0,boundary:true});
    }
    rows.sort((a,b)=>a.top-b.top);
    return rows.slice(-Math.max(1,Math.min(80,Number(limit)||60))).map(item=>({role:item.role,text:item.text,top:Number(item.top||0),delivered:Number(item.delivered||0)||0,timeText:item.timeText||'',boundary:!!item.boundary}));
  } catch { return []; }
}

// V1.23.24: provide the main process a bounded, read-only snapshot of visible
// one-to-one chat messages for the ChatGPT workbench. No page navigation and no
// DOM mutation are performed here.
ipcRenderer.on('yoko-gpt-request-recent-messages', (_event, payload = {}) => {
  try {
    const limit = Math.max(1, Math.min(80, Number(payload?.limit || 60) || 60));
    const currentPlatform=platformFromHost();
    const messages = currentPlatform === 'metabusiness'
      ? metaBusinessGptSnapshotRows(limit)
      : candidateElements(false)
        .map(node => {
          const timeText = yokoHistoryNativeTime(node);
          return { role:crmMessageRole(node), text:messageText(node), top:node.getBoundingClientRect().top, timeText, delivered:yokoExternalNativeTimeMs(timeText) };
        })
        .filter(item => (item.role === 'customer' || item.role === 'me') && item.text && !likelyUiText(item.text))
        .sort((a,b) => a.top-b.top)
        .slice(-limit)
        .map(item => ({ role:item.role, text:item.text.slice(0,2000), top:Number(item.top || 0), delivered:Number(item.delivered || 0) || 0, timeText:item.timeText || '' }));
    const identity = currentPlatform === 'tiktok' ? currentTikTokNativeChatIdentity() : (currentPlatform === 'metabusiness' ? currentMetaBusinessNativeChatIdentity() : null);
    const terminalSnapshot = platformFromHost() === 'tiktok' ? tiktokDedicatedTerminalSnapshot() : {rows:[],laneSource:'',rawCount:0};
    const explicitFacts = platformFromHost() === 'metabusiness' ? metaBusinessExplicitCustomerFactsHint(messages) : null;
    ipcRenderer.send('yoko-gpt-recent-messages-response', {
      requestId:String(payload?.requestId || ''), messages, explicitFacts,
      terminalRows:Array.isArray(terminalSnapshot.rows)?terminalSnapshot.rows:[],
      scanMeta:{laneSource:String(terminalSnapshot.laneSource||''),terminalRawCount:Number(terminalSnapshot.rawCount||0),metaDirectCount:currentPlatform==='metabusiness'?messages.length:0},
      identity:identity ? { name:String(identity.name || ''), handle:String(identity.handle || '').replace(/^@/, ''), chatId:String(identity.chatId || ''), avatarUrl:String(identity.avatarUrl || '') } : null
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
    const nativeTime=yokoHistoryNativeTime(node);rows.push({role,type:'text',text:text.slice(0,12000),translatedText:String(crmTranslatedTextForNode(node,text)||'').slice(0,12000),nativeTime,delivered:yokoExternalNativeTimeMs(nativeTime),sourceKey:yokoHistoryNodeKey(node,`${role}|text|${text}`),top:rect.top||0});
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
