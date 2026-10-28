const { ipcRenderer, webFrame } = require('electron');
const crypto = require('node:crypto');
const { installChromeDownloadsCompat } = require('./line-download-compat');

installChromeDownloadsCompat();

// V1.15.26: LINE authentication storage is left entirely to the native
// persistent Chromium partition. Do not copy or inject LINE auth tokens.

// V1.10.18 LINE bootstrap guard.
// The bundled LINE 3.7.2 build contains SCRM instrumentation that exports
// internal functions through window.LineFetchApi very early during main.js
// evaluation. On a fresh account/login page the host object may not exist yet,
// which aborts LINE before the QR login UI can render. Create the export host
// before any extension page script executes. contextIsolation is intentionally
// disabled for the LINE view, so this is the same world used by main.js.
try {
  if (!window.LineFetchApi || typeof window.LineFetchApi !== 'object') {
    window.LineFetchApi = {};
  }
  if (!window.LineHook || typeof window.LineHook !== 'object') {
    window.LineHook = {};
  }
} catch {}

// V1.10.15 account overview bridge. The bundled LINE extension calls these
// main-world callbacks with its own exact unread total and authenticated profile.
// contextIsolation is disabled for the LINE view specifically, so these are
// available before the extension's deferred main.js starts.
window._onUnreadCount = count => {
  try {
    ipcRenderer.send('line-account-unread', { count: Math.max(0, Number(count) || 0) });
  } catch {}
};
window._onLineAccountProfile = profile => {
  try {
    ipcRenderer.send('line-account-profile', {
      mid: String(profile?.mid || ''),
      userId: String(profile?.userId || profile?.userid || ''),
      displayName: String(profile?.displayName || ''),
      pictureUrl: String(profile?.pictureUrl || '')
    });
  } catch {}
};


// V1.23.17: protect LINE's own transient action popovers (the menu shown by
// right-clicking a message: reply/copy/share/unsend). LINE 3.7.2 intentionally
// closes these popovers on *any* window resize or document scroll. Yoko's
// aggregate-focus observer used to see the popover portal mount as a generic
// DOM mutation, re-apply the aggregate layout ~160 ms later and dispatch a
// synthetic resize, which immediately dismissed the menu. Translation DOM
// writes could also shift the message surface and cause the same symptom.
//
// Keep a short interaction guard from the initial contextmenu event and also
// detect LINE's portal directly so the guard remains active for as long as the
// operator leaves the menu open.
let __yokoLineTransientUiUntil = 0;
let __yokoLineTransientUiReleaseTimer = null;
function __yokoLineActionPopoverElement() {
  try {
    const modalRoot = document.getElementById('modal-root');
    if (!modalRoot) return null;
    return modalRoot.querySelector(
      '[class*="actionPopoverLayout-module__popover_wrap__"], [aria-label="popover action list"], [role="menu"]'
    );
  } catch {
    return null;
  }
}
function __yokoLineTransientUiActive() {
  return Date.now() < __yokoLineTransientUiUntil || !!__yokoLineActionPopoverElement();
}
function __yokoHoldLineTransientUi(ms = 6000) {
  __yokoLineTransientUiUntil = Math.max(__yokoLineTransientUiUntil, Date.now() + Math.max(800, Number(ms) || 6000));
  if (__yokoLineTransientUiReleaseTimer) {
    clearTimeout(__yokoLineTransientUiReleaseTimer);
    __yokoLineTransientUiReleaseTimer = null;
  }
  // Cancel an aggregate-layout pass that may already have been queued by the
  // pointer/mutation immediately preceding LINE's portal mount.
  try {
    if (typeof __yokoAggregateFocusApplyTimer !== 'undefined' && __yokoAggregateFocusApplyTimer) {
      clearTimeout(__yokoAggregateFocusApplyTimer);
      __yokoAggregateFocusApplyTimer = null;
    }
  } catch {}
}
function __yokoReleaseLineTransientUi(delay = 320) {
  if (__yokoLineTransientUiReleaseTimer) clearTimeout(__yokoLineTransientUiReleaseTimer);
  __yokoLineTransientUiReleaseTimer = setTimeout(() => {
    __yokoLineTransientUiReleaseTimer = null;
    // A submenu or the original popover can still be mounted after a click.
    // Never resume Yoko layout work until LINE itself has actually removed it.
    if (__yokoLineActionPopoverElement()) {
      __yokoLineTransientUiUntil = Math.max(__yokoLineTransientUiUntil, Date.now() + 800);
      __yokoReleaseLineTransientUi(360);
      return;
    }
    __yokoLineTransientUiUntil = 0;
    try {
      if (typeof __yokoAggregateFocusEnabled !== 'undefined' && __yokoAggregateFocusEnabled) {
        __yokoScheduleAggregateFocusApply?.(80);
      }
    } catch {}
    try { yokoScheduleInlineScan?.(120); } catch {}
  }, Math.max(120, Number(delay) || 320));
}
document.addEventListener('contextmenu', event => {
  try {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest?.('.yoko-inline-actions,.yoko-ai-reply-dock,.yoko-line-paste-action')) return;
    __yokoHoldLineTransientUi(6000);
  } catch {}
}, true);
document.addEventListener('pointerdown', event => {
  try {
    if (event.button === 2) {
      __yokoHoldLineTransientUi(6000);
      return;
    }
    if (event.button === 0 && __yokoLineTransientUiActive()) {
      // Allow LINE's own click handler (including "撤回") to run first.
      __yokoReleaseLineTransientUi(420);
    }
  } catch {}
}, true);
document.addEventListener('keydown', event => {
  try {
    if (event.key === 'Escape' && __yokoLineTransientUiActive()) __yokoReleaseLineTransientUi(220);
  } catch {}
}, true);

// V1.10.19 robust own-profile synchronizer.
// The React profile hook above is the fastest path, but different LINE view
// states can mount/unmount that component. The bundled extension also exports
// its authenticated getProfile transport, so poll it lightly as a fallback.
// This never touches friend profiles: only auth/profile (the currently logged
// in LINE account) is forwarded to the Yoko account list.
let __yokoLastOwnProfileSignature = '';
let __yokoOwnProfileOnline = false;
let __yokoOwnProfileFailures = 0;
let __yokoLastLoginSurfaceState = '';
let __yokoLoginSurfaceTimer = null;

function __yokoPublishLoginSurfaceState(state) {
  const next = String(state || 'unknown');
  if (!next || next === __yokoLastLoginSurfaceState) return;
  __yokoLastLoginSurfaceState = next;
  try { ipcRenderer.send('line-account-login-state', { state:next, at:Date.now() }); } catch {}
}

function __yokoDetectLoginSurfaceState() {
  try {
    const body = String(document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 12000);
    const hasPassword = !!document.querySelector('input[type="password"]');
    const hasLoginButton = /(?:ログイン|登入|登录|Sign\s*in|Log\s*in)/i.test(body);
    const hasQrWords = /(?:QR\s*コード|QR\s*code|二维码|行動條碼|二維碼)/i.test(body);
    const hasQrVisual = !!document.querySelector('canvas, img[src*="qr" i], [class*="qr" i], [data-testid*="qr" i]');
    // A visible login/QR surface is stronger evidence than a stale profile
    // signature cached from a previous authenticated route.
    if (hasPassword || hasLoginButton || (hasQrWords && hasQrVisual)) return 'login-required';
    if (__yokoOwnProfileOnline || __yokoLastOwnProfileSignature) return 'authenticated';
  } catch {}
  return 'unknown';
}

function __yokoScheduleLoginSurfaceProbe(delay = 500) {
  if (__yokoLoginSurfaceTimer) clearTimeout(__yokoLoginSurfaceTimer);
  __yokoLoginSurfaceTimer = setTimeout(() => {
    __yokoLoginSurfaceTimer = null;
    const state = __yokoDetectLoginSurfaceState();
    if (state !== 'unknown') __yokoPublishLoginSurfaceState(state);
  }, Math.max(100, Number(delay) || 500));
}

function __yokoNormalizeOwnProfile(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const picturePath = String(p.picturePath || p.pictureUrl || '').trim();
  return {
    mid: String(p.mid || '').trim(),
    userId: String(p.userid || p.userId || '').trim(),
    displayName: String(p.displayName || '').trim(),
    pictureUrl: picturePath
      ? (/\/preview(?:\?|$)/.test(picturePath) ? picturePath : `${picturePath}/preview`)
      : ''
  };
}


let __yokoAvatarDataCacheUrl = '';
let __yokoAvatarDataCache = '';
async function __yokoAvatarToDataUrl(url, force = false) {
  const target = String(url || '').trim();
  if (!target) return '';
  if (!force && target === __yokoAvatarDataCacheUrl && __yokoAvatarDataCache) {
    return __yokoAvatarDataCache;
  }

  const base = target.replace(/\/preview(?:\?.*)?$/, '');
  const candidates = [target];
  if (base && base !== target) candidates.push(base);
  if (base && !/\/preview(?:\?|$)/.test(target)) candidates.push(`${base}/preview`);

  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    try {
      const response = await fetch(candidate, {
        credentials: 'include',
        cache: force ? 'reload' : 'force-cache'
      });
      if (!response.ok) continue;
      const blob = await response.blob();
      if (!blob?.size || blob.size > 2 * 1024 * 1024) continue;
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      if (dataUrl.startsWith('data:image/')) {
        __yokoAvatarDataCacheUrl = target;
        __yokoAvatarDataCache = dataUrl;
        return dataUrl;
      }
    } catch {}
  }
  return '';
}


let __yokoLastDomAvatarDataUrl = '';
let __yokoLastDomAvatarScanAt = 0;
let __yokoAvatarMutationObserver = null;

function __yokoIsVisibleElement(el) {
  try {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width >= 18 && rect.height >= 18 && rect.bottom > 0 && rect.right > 0 &&
      rect.top < innerHeight && rect.left < innerWidth && style.display !== 'none' &&
      style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  } catch {
    return false;
  }
}

function __yokoFindOwnAvatarElement(mid, displayName, userId) {
  const ownMid = String(mid || '').trim();
  const name = String(displayName || '').trim();
  const id = String(userId || '').trim();

  // V1.11.18 strongest path: LINE 3.7.2 puts the exact contact MID on every
  // rendered profile-image root (`data-profile-image` + `data-mid`). The old
  // name/ID heuristic could miss accounts whose auth.profile omits picturePath
  // even though q0 has already rendered the real avatar from its contact cache.
  // Matching MID is deterministic and cannot accidentally pick a friend's image.
  if (ownMid) {
    try {
      const roots = Array.from(document.querySelectorAll('[data-profile-image][data-mid]'));
      const exact = roots.filter(root => String(root.getAttribute('data-mid') || '') === ownMid);
      for (const root of exact) {
        const images = Array.from(root.querySelectorAll('img'));
        for (const img of images) {
          const src = String(img.currentSrc || img.src || '').trim();
          if (!src) continue;
          const r = img.getBoundingClientRect();
          // q0 can exist in both the visible profile row and transient UI. Prefer
          // a decoded visible image, but accept a loaded offscreen copy as backup.
          if (img.complete && (img.naturalWidth > 0 || r.width >= 18)) {
            return { type: 'img', element: img, src, exactMid: true };
          }
        }
      }
    } catch {}
  }

  if (!name && !id) return null;

  // Fast path: locate the visible text node that renders the logged-in user's
  // name/id, then search its nearby card/container for the corresponding image.
  const nodes = Array.from(document.querySelectorAll('span,div,p,strong,b'));
  const anchors = [];
  for (const el of nodes) {
    if (!__yokoIsVisibleElement(el)) continue;
    const text = String(el.textContent || '').trim();
    if (!text || text.length > 120) continue;
    let score = 0;
    if (name && text === name) score += 100;
    else if (name && text.includes(name)) score += 55;
    if (id && text === id) score += 95;
    else if (id && text.includes(id)) score += 45;
    if (!score) continue;
    const rect = el.getBoundingClientRect();
    if (rect.top < 320) score += 20;
    anchors.push({ el, score, top: rect.top });
  }
  anchors.sort((a, b) => b.score - a.score || a.top - b.top);

  for (const anchor of anchors.slice(0, 12)) {
    let container = anchor.el;
    for (let depth = 0; depth < 6 && container; depth += 1, container = container.parentElement) {
      const images = Array.from(container.querySelectorAll?.('img') || []);
      const visibleImages = images.filter(img => {
        if (!__yokoIsVisibleElement(img)) return false;
        const r = img.getBoundingClientRect();
        return r.width >= 24 && r.height >= 24 && r.width <= 160 && r.height <= 160 &&
          String(img.currentSrc || img.src || '').length > 0;
      });
      if (visibleImages.length) {
        visibleImages.sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return Math.abs(ar.top - anchor.top) - Math.abs(br.top - anchor.top);
        });
        return { type: 'img', element: visibleImages[0], src: String(visibleImages[0].currentSrc || visibleImages[0].src || '') };
      }

      // Some LINE builds render profile pictures as CSS backgrounds.
      const descendants = Array.from(container.querySelectorAll?.('*') || []).slice(0, 120);
      for (const child of descendants) {
        if (!__yokoIsVisibleElement(child)) continue;
        try {
          const bg = String(getComputedStyle(child).backgroundImage || '');
          const m = bg.match(/^url\(["']?(.*?)["']?\)$/);
          if (m && m[1] && !m[1].startsWith('data:image/svg')) {
            const r = child.getBoundingClientRect();
            if (r.width >= 24 && r.height >= 24 && r.width <= 160 && r.height <= 160) {
              return { type: 'background', element: child, src: m[1] };
            }
          }
        } catch {}
      }
    }
  }

  // Last resort: score visible images by alt/title and their nearby text.
  let best = null;
  let bestScore = 0;
  for (const img of Array.from(document.images || [])) {
    if (!__yokoIsVisibleElement(img)) continue;
    const r = img.getBoundingClientRect();
    if (r.width < 24 || r.height < 24 || r.width > 160 || r.height > 160) continue;
    const src = String(img.currentSrc || img.src || '');
    if (!src) continue;
    let score = 0;
    const label = `${img.alt || ''} ${img.title || ''}`;
    if (name && label.includes(name)) score += 80;
    if (id && label.includes(id)) score += 70;
    let parent = img.parentElement;
    for (let depth = 0; depth < 4 && parent; depth += 1, parent = parent.parentElement) {
      const text = String(parent.innerText || parent.textContent || '').slice(0, 260);
      if (name && text.includes(name)) score += 25 - depth * 3;
      if (id && text.includes(id)) score += 20 - depth * 3;
    }
    if (r.top < 320) score += 8;
    if (score > bestScore) {
      bestScore = score;
      best = { type: 'img', element: img, src };
    }
  }
  return bestScore >= 20 ? best : null;
}

async function __yokoDomAvatarToDataUrl(mid, displayName, userId) {
  try {
    const candidate = __yokoFindOwnAvatarElement(mid, displayName, userId);
    const src = String(candidate?.src || '').trim();
    if (!src) return '';
    if (src.startsWith('data:image/')) return src;

    // Fetch inside the authenticated LINE renderer. This supports https:, blob:
    // and extension-created object URLs and avoids exposing the user's proxy/cookie
    // state to the Yoko UI renderer.
    try {
      const response = await fetch(src, { credentials: 'include', cache: 'force-cache' });
      if (response.ok) {
        const blob = await response.blob();
        if (blob?.size && blob.size <= 2 * 1024 * 1024) {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          if (dataUrl.startsWith('data:image/')) return dataUrl;
        }
      }
    } catch {}

    // Canvas fallback for already-decoded <img> nodes with CORS-safe pixels.
    if (candidate?.type === 'img' && candidate.element?.complete) {
      try {
        const img = candidate.element;
        const w = Math.max(1, img.naturalWidth || img.width || 64);
        const h = Math.max(1, img.naturalHeight || img.height || 64);
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(w, 256);
        canvas.height = Math.min(h, 256);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/png');
        if (dataUrl.startsWith('data:image/')) return dataUrl;
      } catch {}
    }
  } catch {}
  return '';
}

async function __yokoPublishDomAvatar(normalized) {
  try {
    const dataUrl = await __yokoDomAvatarToDataUrl(normalized?.mid, normalized?.displayName, normalized?.userId);
    if (!dataUrl || dataUrl === __yokoLastDomAvatarDataUrl) return false;
    __yokoLastDomAvatarDataUrl = dataUrl;
    // Once the real own-account avatar is captured, the full-document observer
    // has no useful work left. Disconnect it to reduce background DOM churn.
    if (__yokoAvatarMutationObserver) {
      try { __yokoAvatarMutationObserver.disconnect(); } catch {}
      __yokoAvatarMutationObserver = null;
    }
    ipcRenderer.send('line-account-profile', {
      mid: normalized?.mid || '',
      userId: normalized?.userId || '',
      displayName: normalized?.displayName || '',
      avatarDataUrl: dataUrl
    });
    return true;
  } catch {
    return false;
  }
}

async function __yokoPublishOwnProfile(profile) {
  try {
    const normalized = __yokoNormalizeOwnProfile(profile);
    if (!normalized.mid && !normalized.displayName) return false;
    const signature = `${normalized.mid}\u001f${normalized.userId}\u001f${normalized.displayName}\u001f${normalized.pictureUrl}`;
    if (signature !== __yokoLastOwnProfileSignature) {
      __yokoLastOwnProfileSignature = signature;
      const avatarDataUrl = await __yokoAvatarToDataUrl(normalized.pictureUrl);
      ipcRenderer.send('line-account-profile', { ...normalized, avatarDataUrl });
    }
    // Independently recover the avatar from LINE's already-rendered own-profile
    // card. This is important when getProfile returns name/userid but picturePath
    // is empty or its CDN fetch is blocked by the current network.
    const now = Date.now();
    if (!__yokoLastDomAvatarDataUrl || now - __yokoLastDomAvatarScanAt >= 120000) {
      __yokoLastDomAvatarScanAt = now;
      await __yokoPublishDomAvatar(normalized);
    }
    if (!__yokoOwnProfileOnline) {
      __yokoOwnProfileOnline = true;
      ipcRenderer.send('line-account-presence', { online: true });
    }
    __yokoOwnProfileFailures = 0;
    return true;
  } catch {
    return false;
  }
}

async function __yokoForceOwnAvatarRefresh() {
  // Manual/forced refresh must not depend on the old renderer-side cache.
  __yokoAvatarDataCacheUrl = '';
  __yokoAvatarDataCache = '';
  __yokoLastDomAvatarDataUrl = '';
  __yokoLastDomAvatarScanAt = 0;
  if (__yokoAvatarMutationObserver) {
    try { __yokoAvatarMutationObserver.disconnect(); } catch {}
    __yokoAvatarMutationObserver = null;
  }
  __yokoInstallAvatarMutationObserver();

  let normalized = { mid: '', userId: '', displayName: '', pictureUrl: '' };
  try {
    const fn = window.LineFetchApi?.getOwnProfile;
    if (typeof fn === 'function') {
      const profile = await fn({ ignoreTalkAuthException: true }, 'YOKO_FORCE_AVATAR');
      normalized = __yokoNormalizeOwnProfile(profile);
    }
  } catch {}

  // Merge any missing fields from the last known identity. Some LINE states
  // return name/mid successfully but temporarily omit picturePath; keeping the
  // old picture URL gives the forced refresh another authenticated fetch path.
  if (__yokoLastOwnProfileSignature) {
    const [mid, userId, displayName, pictureUrl] = __yokoLastOwnProfileSignature.split('\u001f');
    normalized = {
      mid: normalized.mid || mid || '',
      userId: normalized.userId || userId || '',
      displayName: normalized.displayName || displayName || '',
      pictureUrl: normalized.pictureUrl || pictureUrl || ''
    };
  }

  let avatarDataUrl = '';
  if (normalized.pictureUrl) {
    avatarDataUrl = await __yokoAvatarToDataUrl(normalized.pictureUrl, true);
  }
  if (!avatarDataUrl) {
    avatarDataUrl = await __yokoDomAvatarToDataUrl(normalized.mid, normalized.displayName, normalized.userId);
  }

  if (normalized.mid || normalized.displayName || avatarDataUrl) {
    const signature = `${normalized.mid}\u001f${normalized.userId}\u001f${normalized.displayName}\u001f${normalized.pictureUrl}`;
    if (normalized.mid || normalized.displayName) __yokoLastOwnProfileSignature = signature;
    if (avatarDataUrl) __yokoLastDomAvatarDataUrl = avatarDataUrl;
    ipcRenderer.send('line-account-profile', { ...normalized, avatarDataUrl });
  }

  return { ...normalized, avatarDataUrl };
}

try {
  window.__yokoForceOwnAvatarRefresh = __yokoForceOwnAvatarRefresh;
} catch {}

// Wrap the existing React callback so a successful state-hook update also
// drives the online indicator immediately.
const __yokoOriginalProfileCallback = window._onLineAccountProfile;
window._onLineAccountProfile = profile => {
  try {
    const normalized = __yokoNormalizeOwnProfile(profile);
    ipcRenderer.send('line-account-profile', normalized);
    if (normalized.pictureUrl) {
      __yokoAvatarToDataUrl(normalized.pictureUrl).then(avatarDataUrl => {
        if (avatarDataUrl) ipcRenderer.send('line-account-profile', { ...normalized, avatarDataUrl });
      }).catch(() => {});
    }
    __yokoPublishDomAvatar(normalized).catch(() => {});
    if (normalized.mid || normalized.displayName) {
      __yokoOwnProfileOnline = true;
      __yokoOwnProfileFailures = 0;
      ipcRenderer.send('line-account-presence', { online: true });
      __yokoPublishLoginSurfaceState('authenticated');
      __yokoLastOwnProfileSignature = `${normalized.mid}\u001f${normalized.userId}\u001f${normalized.displayName}\u001f${normalized.pictureUrl}`;
    }
  } catch {
    try { __yokoOriginalProfileCallback?.(profile); } catch {}
  }
};

async function __yokoProbeOwnProfile() {
  try {
    const fn = window.LineFetchApi?.getOwnProfile;
    if (typeof fn !== 'function') return;
    const profile = await fn({ ignoreTalkAuthException: true });
    await __yokoPublishOwnProfile(profile);
  } catch {
    __yokoOwnProfileFailures += 1;
    // Profile API failures are frequently just transient network/React route
    // churn. Never infer logout from them. Ask the explicit login-surface
    // detector instead; only a confirmed login/QR screen may publish offline.
    if (__yokoOwnProfileFailures >= 2) __yokoScheduleLoginSurfaceProbe(180);
  }
}

// V1.15.36: restored sessions can become valid very quickly. Probe early so
// Yoko marks the account usable as soon as LINE exposes getOwnProfile instead
// of waiting for the old 1.8s/4.5s checkpoints. Later probes remain as fallback.
setTimeout(__yokoProbeOwnProfile, 320);
setTimeout(() => __yokoScheduleLoginSurfaceProbe(60), 520);
setTimeout(__yokoProbeOwnProfile, 780);
setTimeout(__yokoProbeOwnProfile, 1500);
setTimeout(__yokoProbeOwnProfile, 3200);
setTimeout(() => {
  if (__yokoLastOwnProfileSignature) {
    const [mid, userId, displayName] = __yokoLastOwnProfileSignature.split('\u001f');
    __yokoPublishDomAvatar({ mid, userId, displayName }).catch(() => {});
  }
}, 6500);
setTimeout(() => {
  if (__yokoLastOwnProfileSignature && !__yokoLastDomAvatarDataUrl) {
    const [mid, userId, displayName] = __yokoLastOwnProfileSignature.split('\u001f');
    __yokoPublishDomAvatar({ mid, userId, displayName }).catch(() => {});
  }
}, 11000);
setInterval(__yokoProbeOwnProfile, 30000);
setInterval(() => { if (!__yokoOwnProfileOnline) __yokoScheduleLoginSurfaceProbe(120); }, 3500);

// V1.11.16: when LINE mounts the profile row later than the initial profile
// transport, watch DOM changes lightly and retry only while this account still
// lacks a DOM-captured avatar. This avoids permanent initials on slow accounts.
let __yokoAvatarMutationTimer = null;
function __yokoScheduleDomAvatarRetry() {
  if (!__yokoLastOwnProfileSignature || __yokoLastDomAvatarDataUrl) return;
  if (__yokoAvatarMutationTimer) return;
  __yokoAvatarMutationTimer = setTimeout(() => {
    __yokoAvatarMutationTimer = null;
    if (!__yokoLastOwnProfileSignature || __yokoLastDomAvatarDataUrl) return;
    const [mid, userId, displayName] = __yokoLastOwnProfileSignature.split('\u001f');
    __yokoPublishDomAvatar({ mid, userId, displayName }).catch(() => {});
  }, 1400);
}

function __yokoInstallAvatarMutationObserver() {
  try {
    if (__yokoLastDomAvatarDataUrl || __yokoAvatarMutationObserver) return;
    const root = document.documentElement || document.body;
    if (!root || typeof MutationObserver !== 'function') return;
    __yokoAvatarMutationObserver = new MutationObserver(() => __yokoScheduleDomAvatarRetry());
    __yokoAvatarMutationObserver.observe(root, { childList: true, subtree: true });
  } catch {
    __yokoAvatarMutationObserver = null;
  }
}
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', __yokoInstallAvatarMutationObserver, { once: true });
} else {
  __yokoInstallAvatarMutationObserver();
}

// Normal LINE hash/React navigations can fire beforeunload while the account is
// still authenticated. Do not publish an offline state here; explicit login
// surface detection and render-process-gone are the authoritative paths.
window.addEventListener('beforeunload', () => {
  // Intentionally no presence mutation. The next loaded document will publish
  // authenticated/login-required after its own profile/login-surface probe.
});

/*
  Yoko SCRM LINE Compatibility Layer
  ----------------------------------
  Fresh implementation based only on the public API surface actually requested
  by LINE Chrome 3.7.2 at runtime. It does NOT copy LINE or QL implementation code.

  Why this is required:
  LINE checks window.chrome.runtime.id. Electron exposes a runtime id for a loaded
  extension, so LINE takes its "Chrome extension" branch. But Electron doesn't
  implement every Chrome extension namespace that LINE expects.
*/

(function installChromeCompat() {
  const c = (window.chrome = window.chrome || {});

  const ensure = (object, key, valueFactory) => {
    if (object[key] == null) {
      try {
        Object.defineProperty(object, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: valueFactory()
        });
      } catch {
        try { object[key] = valueFactory(); } catch {}
      }
    }
    return object[key];
  };

  const makeEvent = () => {
    const listeners = new Set();
    return {
      addListener(fn) {
        if (typeof fn === 'function') listeners.add(fn);
      },
      removeListener(fn) {
        listeners.delete(fn);
      },
      hasListener(fn) {
        return listeners.has(fn);
      },
      hasListeners() {
        return listeners.size > 0;
      },
      _emit(...args) {
        for (const fn of [...listeners]) {
          try { fn(...args); } catch (error) { console.error(error); }
        }
      }
    };
  };

  // ---- chrome.tabs ----
  const tabs = ensure(c, 'tabs', () => ({}));
  // Electron can expose a native chrome.tabs.getZoom(), but an embedded
  // WebContentsView is not represented as a normal Chrome tab and the native
  // implementation rejects with "No such tab". LINE calls getZoom() during
  // module initialization without a catch, so always replace it here.
  tabs.getZoom = async () => {
    try {
      const zoom = webFrame.getZoomFactor();
      return Number.isFinite(zoom) ? zoom : 1;
    } catch {
      return 1;
    }
  };

  // ---- chrome.notifications ----
  const notifications = ensure(c, 'notifications', () => ({}));
  notifications.onClicked = notifications.onClicked || makeEvent();
  notifications.onClosed = notifications.onClosed || makeEvent();

  if (typeof notifications.create !== 'function') {
    notifications.create = async (notificationId, options = {}) => {
      const id =
        typeof notificationId === 'string' && notificationId
          ? notificationId
          : `yoko-line-${Date.now()}`;

      try {
        if (typeof Notification === 'function') {
          const n = new Notification(options.title || 'LINE', {
            body: options.message || '',
            icon: options.iconUrl || undefined,
            silent: true
          });
          n.onclick = () => notifications.onClicked._emit(id);
          n.onclose = () => notifications.onClosed._emit(id, true);
        }
      } catch {}

      return id;
    };
  }

  if (typeof notifications.clear !== 'function') {
    notifications.clear = async () => true;
  }

  // ---- chrome.windows ----
  const windows = ensure(c, 'windows', () => ({}));
  windows.onRemoved = windows.onRemoved || makeEvent();

  if (typeof windows.getCurrent !== 'function') {
    windows.getCurrent = callback => {
      const result = { id: 1, focused: document.hasFocus() };
      if (typeof callback === 'function') {
        queueMicrotask(() => callback(result));
        return;
      }
      return Promise.resolve(result);
    };
  }

  if (typeof windows.update !== 'function') {
    windows.update = async (_windowId, updateInfo = {}) => {
      if (updateInfo.focused) {
        try { window.focus(); } catch {}
      }
      return { id: Number(_windowId) || 1, ...updateInfo };
    };
  }

  if (typeof windows.getAll !== 'function') {
    windows.getAll = async () => [{ id: 1, focused: document.hasFocus() }];
  }

  if (typeof windows.create !== 'function') {
    windows.create = async createData => {
      // LINE's background worker normally creates its main panel.
      // Yoko already owns the embedded view, so return a stable synthetic window.
      return {
        id: 1,
        focused: createData?.focused !== false,
        left: createData?.left || 0,
        top: createData?.top || 0,
        width: createData?.width || window.innerWidth,
        height: createData?.height || window.innerHeight
      };
    };
  }

  // ---- chrome.action ----
  const action = ensure(c, 'action', () => ({}));
  action.onClicked = action.onClicked || makeEvent();

  for (const method of [
    'setBadgeText',
    'setBadgeBackgroundColor',
    'setIcon',
    'setTitle',
    'enable',
    'disable'
  ]) {
    if (typeof action[method] !== 'function') {
      action[method] = async () => undefined;
    }
  }

  // ---- chrome.extension ----
  const extension = ensure(c, 'extension', () => ({}));
  if (typeof extension.getViews !== 'function') {
    extension.getViews = () => [window];
  }

  // ---- chrome.cookies ----
  const cookies = ensure(c, 'cookies', () => ({}));
  if (typeof cookies.remove !== 'function') {
    cookies.remove = async details => {
      try {
        return await ipcRenderer.invoke('line-compat-cookie-remove', {
          url: String(details?.url || ''),
          name: String(details?.name || '')
        });
      } catch {
        return null;
      }
    };
  }

  // ---- chrome.system.display ----
  const system = ensure(c, 'system', () => ({}));
  const display = ensure(system, 'display', () => ({}));
  if (typeof display.getInfo !== 'function') {
    display.getInfo = async () => [
      {
        id: 'yoko-primary',
        isPrimary: true,
        bounds: {
          left: 0,
          top: 0,
          width: screen.width || window.innerWidth || 1280,
          height: screen.height || window.innerHeight || 720
        },
        workArea: {
          left: 0,
          top: 0,
          width: screen.availWidth || screen.width || 1280,
          height: screen.availHeight || screen.height || 720
        }
      }
    ];
  }

  // ---- chrome.storage.local fallback ----
  // Use a small Promise/callback-compatible implementation only when Electron
  // hasn't supplied native extension storage.
  const storage = ensure(c, 'storage', () => ({}));
  const local = ensure(storage, 'local', () => ({}));
  const prefix = '__yoko_chrome_storage__:';

  const readAllStorage = () => {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(prefix)) continue;
        const real = k.slice(prefix.length);
        try { out[real] = JSON.parse(localStorage.getItem(k)); } catch {}
      }
    } catch {}
    return out;
  };

  if (typeof local.get !== 'function') {
    local.get = (keys, callback) => {
      const all = readAllStorage();
      let result = {};

      if (keys == null) {
        result = all;
      } else if (typeof keys === 'string') {
        if (Object.prototype.hasOwnProperty.call(all, keys)) result[keys] = all[keys];
      } else if (Array.isArray(keys)) {
        for (const key of keys) {
          if (Object.prototype.hasOwnProperty.call(all, key)) result[key] = all[key];
        }
      } else if (typeof keys === 'object') {
        result = { ...keys };
        for (const key of Object.keys(keys)) {
          if (Object.prototype.hasOwnProperty.call(all, key)) result[key] = all[key];
        }
      }

      if (typeof callback === 'function') {
        queueMicrotask(() => callback(result));
        return;
      }
      return Promise.resolve(result);
    };
  }

  if (typeof local.set !== 'function') {
    local.set = (items, callback) => {
      try {
        for (const [key, value] of Object.entries(items || {})) {
          localStorage.setItem(prefix + key, JSON.stringify(value));
        }
      } catch {}
      if (typeof callback === 'function') {
        queueMicrotask(callback);
        return;
      }
      return Promise.resolve();
    };
  }

  if (typeof local.remove !== 'function') {
    local.remove = (keys, callback) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        try { localStorage.removeItem(prefix + key); } catch {}
      }
      if (typeof callback === 'function') {
        queueMicrotask(callback);
        return;
      }
      return Promise.resolve();
    };
  }

  if (typeof local.clear !== 'function') {
    local.clear = callback => {
      try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key?.startsWith(prefix)) keys.push(key);
        }
        for (const key of keys) localStorage.removeItem(key);
      } catch {}
      if (typeof callback === 'function') {
        queueMicrotask(callback);
        return;
      }
      return Promise.resolve();
    };
  }

  // Useful diagnostic marker.
  window.__YOKO_LINE_COMPAT__ = {
    version: '1.1.1',
    installedAt: Date.now(),
    namespaces: [
      'tabs',
      'notifications',
      'windows',
      'action',
      'extension',
      'cookies',
      'system.display',
      'storage.local'
    ]
  };
})();



// ============================================================
// Inline bilingual translation — V1.27.110 bounded fast persistent newest-first lane
// Original sealed line-preload.js remains byte-identical; this runtime copy carries the unified translation scheduler.
// Translate incoming customer bubbles and, when explicitly enabled, outgoing bubbles through local Ollama only.
// ============================================================

let __yokoInlineSettings = {
  enabled: false,
  source: 'auto',
  target: 'zh',
  engine: 'none',
  providerReady: false,
  accountEnabled: true,
  displayMode: 'bilingual'
};

let __yokoTranslatedBubbles = new WeakMap();
let __yokoPendingBubbles = new WeakSet();
let __yokoInlineObserver = null;
let __yokoInlineTimer = null;
let __yokoScanScheduled = false;
let __yokoScanTimer = null;
let __yokoTranslationEpoch = 0;
let __yokoActiveTranslations = 0;
const __yokoTranslationSlotWaiters = [];
let __yokoForegroundMode = true;
// Shared layout flag: declared here so inline bubble detection can safely adapt
// as soon as aggregate focus mode is enabled.
let __yokoAggregateFocusEnabled = false;
// V1.15.13: monotonic switch generation. A late completion from an older
// customer click must never clear the guard/overlay for the newest target.
let __yokoAggregateSwitchSeq = 0;
let __yokoAggregateSwitchOverlay = null;
let __yokoAggregateSwitchingChatId = '';
// V1.15.18 soft prewarm cache. Hover/queue prediction may prepare metadata and
// aggregate layout for likely-next customers, but it never changes location.hash
// and therefore can never switch the visible conversation by itself.
const __yokoAggregatePrewarmCache = new Map(); // chatId -> { expectedName, targetHash, warmedAt }
const __yokoAggregatePrewarmTtlMs = 15000;
let __yokoAggregateFocusApplyTimer = null;
let __yokoAggregateFocusObserver = null;
let __yokoAggregateFocusHashBound = false;

// V1.15.21 native composer safety + per-customer drafts. Drafts live inside
// each LINE account's own persistent partition/localStorage and never leave the
// local machine. They are restored only into an empty composer for the exact MID.
const __yokoAggregateDraftPrefix = '__yoko_scrm_native_draft_v1__:';
let __yokoAggregateVerifiedChatId = '';
let __yokoAggregateSendGuardUntil = 0;

function __yokoCurrentRouteChatId() {
  try {
    const decoded = decodeURIComponent(String(location.hash || ''));
    const match = decoded.match(/\/chats\/([^/?#]+)/);
    return match ? String(match[1] || '').trim() : '';
  } catch {
    return '';
  }
}

function __yokoAggregateDraftKey(chatId) {
  return __yokoAggregateDraftPrefix + String(chatId || '').trim();
}

function __yokoSaveCurrentAggregateDraft() {
  try {
    const info = yokoGetCurrentChatInfo?.() || {};
    const chatId = String(info.chatId || __yokoCurrentRouteChatId() || '').trim();
    if (!chatId) return false;
    const composer = findComposer();
    if (!composer) return false;
    const text = readElement(composer);
    const key = __yokoAggregateDraftKey(chatId);
    if (String(text || '')) localStorage.setItem(key, String(text));
    else localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function __yokoClearAggregateDraft(chatId = '') {
  try {
    const id = String(chatId || __yokoCurrentRouteChatId() || '').trim();
    if (id) localStorage.removeItem(__yokoAggregateDraftKey(id));
  } catch {}
}

function __yokoRestoreAggregateDraftWhenReady(chatId, switchSeq) {
  const id = String(chatId || '').trim();
  if (!id) return;
  let attempts = 0;
  const restore = () => {
    if (switchSeq !== __yokoAggregateSwitchSeq || !__yokoAggregateFocusEnabled) return;
    if (__yokoCurrentRouteChatId() !== id) return;
    let saved = '';
    try { saved = String(localStorage.getItem(__yokoAggregateDraftKey(id)) || ''); } catch {}
    if (!saved) return;
    const composer = findComposer();
    if (composer) {
      const current = readElement(composer);
      // Never overwrite text LINE itself already restored or the operator typed.
      if (!String(current || '')) dispatchInput(composer, saved);
      return;
    }
    attempts += 1;
    if (attempts < 9) setTimeout(restore, 70 + attempts * 28);
  };
  setTimeout(restore, 35);
}

function __yokoAggregateCanSend() {
  if (!__yokoAggregateFocusEnabled) return true;
  if (__yokoAggregateSwitchingChatId) return false;
  if (Date.now() < __yokoAggregateSendGuardUntil) return false;
  const routeId = __yokoCurrentRouteChatId();
  return !!routeId && !!__yokoAggregateVerifiedChatId && routeId === __yokoAggregateVerifiedChatId;
}

function __yokoShowSendGuardToast() {
  try {
    let node = document.getElementById('__yoko_send_guard_toast');
    if (!node) {
      node = document.createElement('div');
      node.id = '__yoko_send_guard_toast';
      Object.assign(node.style, {
        position: 'fixed', left: '50%', bottom: '86px', transform: 'translateX(-50%)',
        zIndex: '2147483647', padding: '7px 12px', borderRadius: '8px',
        background: 'rgba(39,47,54,.92)', color: '#fff', fontSize: '12px',
        pointerEvents: 'none', boxShadow: '0 4px 18px rgba(0,0,0,.18)'
      });
      document.documentElement.appendChild(node);
    }
    node.textContent = '正在确认当前客户，已暂时阻止发送';
    node.style.display = 'block';
    clearTimeout(node.__yokoTimer);
    node.__yokoTimer = setTimeout(() => { if (node) node.style.display = 'none'; }, 900);
  } catch {}
}

// Capture native LINE sends only during Aggregate Mode. Typing remains enabled;
// just the tiny unverified switch window is protected.
document.addEventListener('keydown', event => {
  try {
    if (!__yokoAggregateFocusEnabled || event?.key !== 'Enter' || event.isComposing) return;
    if (event.shiftKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest?.('textarea,[contenteditable="true"],[role="textbox"]')) return;
    if (!__yokoAggregateCanSend()) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      __yokoShowSendGuardToast();
      return;
    }
    const chatId = __yokoCurrentRouteChatId();
    setTimeout(() => {
      try {
        const composer = findComposer();
        if (composer && !String(readElement(composer) || '').trim()) __yokoClearAggregateDraft(chatId);
      } catch {}
    }, 220);
  } catch {}
}, true);

document.addEventListener('click', event => {
  try {
    if (!__yokoAggregateFocusEnabled) return;
    const button = event.target instanceof Element ? event.target.closest('button,[role="button"]') : null;
    if (!button) return;
    const label = [button.getAttribute?.('aria-label'), button.getAttribute?.('title'), button.getAttribute?.('data-testid'), button.textContent]
      .filter(Boolean).join(' ').trim();
    if (!/(^|\s)(send|送信|发送|傳送)(\s|$)/i.test(label) && !/send/i.test(String(button.getAttribute?.('data-testid') || ''))) return;
    if (!__yokoAggregateCanSend()) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      __yokoShowSendGuardToast();
      return;
    }
    const chatId = __yokoCurrentRouteChatId();
    setTimeout(() => {
      try {
        const composer = findComposer();
        if (composer && !String(readElement(composer) || '').trim()) __yokoClearAggregateDraft(chatId);
      } catch {}
    }, 240);
  } catch {}
}, true);

// V1.15.20 aggregate keyboard routing. The operator normally keeps focus in
// LINE's native composer, so the shell never sees Tab. Capture only the two
// aggregate shortcuts here: Tab = next customer, Ctrl+Tab = previous customer.
// Shift+Tab is intentionally left untouched for LINE/native reverse focus.
// Normal LINE mode retains every original Tab behavior. A short throttle avoids
// key-repeat flooding while keeping customer switching instantaneous.
let __yokoAggregateTabNavAt = 0;
document.addEventListener('keydown', event => {
  try {
    if (!__yokoAggregateFocusEnabled || event?.key !== 'Tab') return;
    if (event.altKey || event.metaKey || event.isComposing) return;

    const isPrevious = !!event.ctrlKey;
    const isNext = !event.ctrlKey && !event.shiftKey;
    if (!isPrevious && !isNext) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    const now = Date.now();
    if (now - __yokoAggregateTabNavAt < 85) return;
    __yokoAggregateTabNavAt = now;
    ipcRenderer.send('line-aggregate-keyboard-nav', {
      direction: isPrevious ? -1 : 1,
      shortcut: isPrevious ? 'ctrl-tab' : 'tab'
    });
  } catch {}
}, true);

function yokoInjectTranslationStyle() {
  const oldStyle = document.getElementById('yoko-inline-translation-style');
  if (oldStyle) oldStyle.remove();

  const style = document.createElement('style');
  style.id = 'yoko-inline-translation-style';
  style.textContent = `
    .yoko-inline-translation {
      display: block !important;
      margin: 4px 0 0 0 !important;
      padding: 4px 0 0 0 !important;
      border-top: 1px dashed rgba(120, 120, 120, 0.42) !important;
      color: #53606a !important;
      font-size: 12px !important;
      line-height: 1.45 !important;
      white-space: pre-wrap !important;
      word-break: break-word !important;
      pointer-events: none !important;
      font-family: "Microsoft YaHei","Segoe UI",sans-serif !important;
      min-height: 0 !important;
      height: auto !important;
      max-height: none !important;
    }

    .yoko-inline-translation[data-mode="simple"] {
      margin-top: 3px !important;
      padding-top: 3px !important;
      border-top-color: rgba(120, 120, 120, 0.30) !important;
    }

    /* LINE sizes the original bubble from the source text. A short Japanese
       message followed by a longer Chinese translation could therefore clip
       the translated line. Let translated bubbles grow to a safe readable
       width while still wrapping inside the chat viewport. */
    .yoko-has-inline-translation {
      min-width: min(280px, calc(100vw - 110px)) !important;
      max-width: min(560px, calc(100vw - 90px)) !important;
      width: auto !important;
      overflow: visible !important;
    }
    .yoko-has-inline-translation > .yoko-inline-translation {
      width: auto !important;
      max-width: 100% !important;
      overflow: visible !important;
    }

    .yoko-inline-actions {
      display: flex !important;
      justify-content: flex-end !important;
      align-items: center !important;
      margin: 3px 0 0 !important;
      padding: 0 !important;
      min-height: 18px !important;
      pointer-events: auto !important;
      font-family: "Microsoft YaHei","Segoe UI",sans-serif !important;
    }
    .yoko-inline-retranslate {
      appearance: none !important;
      border: 0 !important;
      border-radius: 5px !important;
      background: rgba(255,255,255,.70) !important;
      color: #6b7880 !important;
      padding: 1px 6px !important;
      min-width: 0 !important;
      height: 18px !important;
      line-height: 16px !important;
      font-size: 10px !important;
      cursor: pointer !important;
      box-shadow: inset 0 0 0 1px rgba(120,130,138,.20) !important;
    }
    .yoko-inline-retranslate:hover {
      background: rgba(255,255,255,.96) !important;
      color: #238454 !important;
    }
    .yoko-inline-retranslate:disabled {
      opacity: .58 !important;
      cursor: wait !important;
    }
    .yoko-inline-copy {
      appearance: none !important;
      border: 0 !important;
      border-radius: 5px !important;
      background: rgba(255,255,255,.70) !important;
      color: #58666f !important;
      padding: 1px 6px !important;
      min-width: 0 !important;
      height: 18px !important;
      line-height: 16px !important;
      font-size: 10px !important;
      cursor: pointer !important;
      box-shadow: inset 0 0 0 1px rgba(120,130,138,.20) !important;
      margin-left: 4px !important;
    }
    .yoko-inline-copy:hover { background: rgba(255,255,255,.96) !important; color: #1f7a4d !important; }
    .yoko-inline-copy[data-copied="1"] { color: #138a4b !important; font-weight: 700 !important; }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function yokoInlineNormalizeText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function yokoStripLineUiMetadata(text) {
  let value = yokoInlineNormalizeText(text);
  if (!value) return '';

  const lines = value.split(/\n+/).map(x => x.trim()).filter(Boolean);

  const isUiMetaLine = line => {
    if (/^(已读|未读|既読|未読)$/i.test(line)) return true;
    if (/^(?:上午|下午|午前|午後)\s*\d{1,2}\s*[:：]\s*\d{2}$/.test(line)) return true;
    if (/^\d{1,2}\s*[:：]\s*\d{2}\s*(?:AM|PM|a\.m\.|p\.m\.)$/i.test(line)) return true;
    if (/^(?:上午|下午)\s*\d{1,2}\s*点\s*\d{1,2}\s*分$/.test(line)) return true;
    return false;
  };

  while (lines.length && isUiMetaLine(lines[lines.length - 1])) {
    lines.pop();
  }

  return lines.join('\n').trim();
}

function yokoEscapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function yokoTextLooksUseful(text) {
  const value = yokoInlineNormalizeText(text);
  if (!value || value.length < 1 || value.length > 900) return false;

  if (/^[\d\s:：./\-年月日APMapm]+$/.test(value)) return false;
  if (/^[\p{P}\p{S}\s]+$/u.test(value)) return false;

  if (
    /^(LINE|好友|官方账号|全部|开始新的对话|聊天|设置|今天|昨天)$/i.test(
      value
    )
  ) {
    return false;
  }

  // Ignore Yoko's own UI / previous translations.
  if (/^译[:：]/.test(value)) return false;
  if (/LibreTranslate|Google Translation API Key/i.test(value)) return false;

  return true;
}

function yokoIsInteractiveOrComposer(el) {
  return !!el.closest?.(
    'textarea,input,[contenteditable="true"],button,[role="button"],a'
  );
}

function yokoRgb(styleValue) {
  const match = String(styleValue || '').match(
    /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/
  );

  if (!match) return null;

  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3])
  };
}

function yokoLooksLikeOutgoingGreen(el) {
  let node = el;

  for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
    let style;
    try {
      style = getComputedStyle(node);
    } catch {
      continue;
    }

    const rgb = yokoRgb(style.backgroundColor);
    if (!rgb) continue;

    // LINE's own-message bubble is a light vivid green.
    // Incoming bubbles are gray / nearly neutral.
    const greenDominance =
      rgb.g - Math.max(rgb.r, rgb.b);

    if (
      rgb.g >= 170 &&
      greenDominance >= 18 &&
      rgb.r >= 110
    ) {
      return true;
    }
  }

  return false;
}

function yokoHasOwnDirectText(el) {
  for (const node of el.childNodes || []) {
    if (
      node.nodeType === Node.TEXT_NODE &&
      yokoInlineNormalizeText(node.textContent || '')
    ) {
      return true;
    }
  }
  return false;
}

function yokoFindBubbleForTextNode(el) {
  const width = Math.max(window.innerWidth || 1, 1);
  // LINE switches to a compact conversation layout when the view becomes
  // narrow and hides the conversation list. In that layout a normal message
  // bubble can occupy 60-80% of the view, so the old 55% cap rejected valid
  // customer messages before they ever reached the translator.
  const compactLayout = width < 980;
  const maxBubbleWidth = compactLayout
    ? Math.min(760, width * 0.84)
    : Math.min(720, width * 0.60);

  let node = el;

  for (let depth = 0; node && depth < 7; depth++, node = node.parentElement) {
    if (!(node instanceof Element) || !visible(node)) continue;
    if (node.classList.contains('yoko-inline-translation')) return null;
    if (node.closest?.('.yoko-inline-translation')) return null;

    const rect = node.getBoundingClientRect();
    if (
      rect.width < 15 ||
      rect.height < 12 ||
      rect.width > maxBubbleWidth ||
      rect.height > 300
    ) {
      continue;
    }

    const style = getComputedStyle(node);
    const radius = parseFloat(style.borderRadius || '0') || 0;
    const bg = style.backgroundColor || '';
    const rgb = yokoRgb(bg);
    const hasVisibleBackground = !!rgb && !/rgba\([^)]*,\s*0\s*\)/.test(bg);

    // First/innermost rounded or visibly filled ancestor is the real bubble.
    if (radius >= 6 || hasVisibleBackground) {
      return node;
    }
  }

  return null;
}


function yokoIsIncomingBubble(bubble) {
  if (!bubble || !visible(bubble)) return false;

  const width = Math.max(window.innerWidth || 1, 1);
  const height = Math.max(window.innerHeight || 1, 1);
  const rect = bubble.getBoundingClientRect();

  // Wide LINE layout has a conversation list on the left; compact layout
  // does not. Do not apply the wide-layout left boundary to compact chat,
  // otherwise every incoming bubble near x=40-80 is falsely rejected.
  // V1.13.1: aggregate focus stretches only the native chatroom across the
  // entire WebContentsView. In that mode incoming bubbles legitimately begin
  // near x=20-80 even on a wide window, so the normal wide-LINE left boundary
  // would reject every customer message and prevent automatic translation.
  const aggregateFocus = typeof __yokoAggregateFocusEnabled !== 'undefined' && __yokoAggregateFocusEnabled === true;
  const compactLayout = width < 980 || aggregateFocus;
  const chatLeft = compactLayout ? 6 : Math.max(245, width * 0.19);
  const incomingCenterLimit = aggregateFocus ? width * 0.82 : (compactLayout ? width * 0.80 : width * 0.72);
  const centerX = rect.left + rect.width / 2;

  if (rect.left < chatLeft) return false;
  if (centerX > incomingCenterLimit) return false;
  if (rect.top < 65 || rect.bottom > height - 55) return false;

  if (yokoLooksLikeOutgoingGreen(bubble)) return false;
  if (yokoIsInteractiveOrComposer(bubble)) return false;

  return true;
}

function yokoIsOutgoingBubble(bubble) {
  if (!bubble || !visible(bubble)) return false;

  const width = Math.max(window.innerWidth || 1, 1);
  const height = Math.max(window.innerHeight || 1, 1);
  const rect = bubble.getBoundingClientRect();
  const aggregateFocus = typeof __yokoAggregateFocusEnabled !== 'undefined' && __yokoAggregateFocusEnabled === true;
  const chatLeft = aggregateFocus ? 6 : Math.max(285, width * 0.24);
  const centerX = rect.left + rect.width / 2;

  if (rect.left < chatLeft) return false;
  if (rect.top < 65 || rect.bottom > height - 55) return false;
  if (centerX < width * 0.46) return false;
  if (!yokoLooksLikeOutgoingGreen(bubble)) return false;
  if (yokoIsInteractiveOrComposer(bubble)) return false;

  return true;
}

function yokoBubbleRole(bubble) {
  if (yokoIsOutgoingBubble(bubble)) return 'outgoing';
  if (yokoIsIncomingBubble(bubble)) return 'incoming';
  return null;
}

function yokoReadBubbleOriginalText(bubble) {
  if (!bubble) return '';

  let raw = '';
  try {
    const clone = bubble.cloneNode(true);
    clone.querySelectorAll('.yoko-inline-translation,.yoko-inline-actions,.yoko-line-paste-action').forEach(el => el.remove());
    raw = clone.innerText || clone.textContent || '';
  } catch {
    raw = bubble.innerText || bubble.textContent || '';
  }

  return yokoStripLineUiMetadata(raw);
}

function yokoTranslationScanRoot() {
  try {
    const composer = typeof yokoFindBottomComposer === 'function' ? yokoFindBottomComposer() : null;
    let node = composer;
    for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
      const rect = node.getBoundingClientRect?.();
      if (!rect) continue;
      if (rect.width >= window.innerWidth * 0.46 && rect.height >= window.innerHeight * 0.62) {
        return node;
      }
    }
  } catch {}
  return document.body || document.documentElement;
}

function yokoMessageBubbleCandidates() {
  const all = [];
  const seenBubbles = new Set();
  const root = yokoTranslationScanRoot();
  const elements = root.querySelectorAll('div,span,p');

  for (const el of elements) {
    if (!(el instanceof Element)) continue;
    if (!visible(el)) continue;
    if (el.closest?.('.yoko-ai-reply-dock')) continue;
    if (!yokoHasOwnDirectText(el)) continue;
    if (yokoIsInteractiveOrComposer(el)) continue;
    if (el.closest('.yoko-inline-translation')) continue;

    const directText = [...el.childNodes]
      .filter(n => n.nodeType === Node.TEXT_NODE)
      .map(n => n.textContent || '')
      .join(' ');

    const text = yokoInlineNormalizeText(directText);
    if (!yokoTextLooksUseful(text)) continue;

    const bubble = yokoFindBubbleForTextNode(el);
    if (!bubble) continue;
    if (seenBubbles.has(bubble)) continue;

    const role = yokoBubbleRole(bubble);
    if (!role) continue;

    const bubbleText = yokoReadBubbleOriginalText(bubble);
    if (!yokoTextLooksUseful(bubbleText)) continue;

    seenBubbles.add(bubble);
    all.push({
      bubble,
      text: bubbleText,
      role,
      rect: bubble.getBoundingClientRect()
    });
  }

  all.sort((a, b) => a.rect.top - b.rect.top);
  return all.slice(-80);
}

function yokoFindExistingTranslation(bubble, originalText) {
  const existing = bubble?.querySelector?.(':scope > .yoko-inline-translation');
  if (!existing) return null;
  // Pending/error rows are status placeholders, not completed translations.
  // Treating them as completed would strand a message forever if a context
  // menu opened while an async translation result was waiting to attach.
  if (['pending', 'error'].includes(String(existing.dataset?.status || ''))) return null;

  const cleaned = yokoStripLineUiMetadata(originalText);
  if (!cleaned) return existing;
  if (existing.dataset?.yokoOriginal === cleaned) return existing;
  return null;
}

function yokoBuildTranslationText(role, translatedText) {
  const cleaned = yokoStripLineUiMetadata(translatedText);
  const mode = __yokoInlineSettings.displayMode || 'bilingual';

  if (mode === 'simple') {
    return `译：${cleaned}`;
  }

  return `----------- 中文译文 -----------\n${cleaned}`;
}

function yokoAttachTranslation(bubble, originalText, translatedText, role) {
  if (!bubble?.isConnected) return false;
  if (__yokoLineTransientUiActive()) { yokoScheduleInlineScan(420); return false; }
  bubble.classList.add('yoko-has-inline-translation');

  // Remove legacy orphan translations next to old row-level containers.
  const parent = bubble.parentElement;
  for (const candidate of [bubble.nextElementSibling, parent?.nextElementSibling].filter(Boolean)) {
    if (candidate?.classList?.contains('yoko-inline-translation')) {
      candidate.remove();
    }
  }

  let translation = bubble.querySelector(':scope > .yoko-inline-translation');
  if (!translation) {
    translation = document.createElement('div');
    translation.className = 'yoko-inline-translation';
    try {
      bubble.appendChild(translation);
    } catch {
      return;
    }
  }

  const cleanedOriginal = yokoStripLineUiMetadata(originalText);
  const cleanedTranslation = yokoStripLineUiMetadata(translatedText);
  if (!cleanedOriginal || !cleanedTranslation) {
    translation.remove();
    return;
  }

  translation.dataset.yokoOriginal = cleanedOriginal;
  translation.dataset.mode = __yokoInlineSettings.displayMode || 'bilingual';
  translation.dataset.role = role || 'incoming';
  delete translation.dataset.status;
  translation.textContent = yokoBuildTranslationText(role, cleanedTranslation);
  return true;
}

function yokoAttachTranslationStatus(bubble, originalText, statusText, status = 'pending', role = 'incoming') {
  if (!bubble?.isConnected) return false;
  if (__yokoLineTransientUiActive()) { yokoScheduleInlineScan(420); return false; }
  bubble.classList.add('yoko-has-inline-translation');
  let translation = bubble.querySelector(':scope > .yoko-inline-translation');
  if (!translation) {
    translation = document.createElement('div');
    translation.className = 'yoko-inline-translation';
    try { bubble.appendChild(translation); } catch { return; }
  }
  translation.dataset.yokoOriginal = yokoStripLineUiMetadata(originalText);
  translation.dataset.mode = __yokoInlineSettings.displayMode || 'bilingual';
  translation.dataset.role = role || 'incoming';
  translation.dataset.status = status;
  translation.textContent = String(statusText || '翻译中…');
  return true;
}


function yokoEnsureTranslationAction(bubble, originalText, role) {
  // V1.23.25: every incoming/customer bubble gets a one-click Copy button.
  // Retranslate remains available when the translation provider is ready.
  if (!bubble?.isConnected || role !== 'incoming') return null;
  if (__yokoLineTransientUiActive()) return null;
  const cleanedOriginal = yokoStripLineUiMetadata(originalText);
  if (!cleanedOriginal) return null;

  let actions = bubble.querySelector(':scope > .yoko-inline-actions');
  if (!actions) {
    actions = document.createElement('div');
    actions.className = 'yoko-inline-actions';
    try { bubble.appendChild(actions); } catch { return null; }
  }

  let copyButton = actions.querySelector('.yoko-inline-copy');
  if (!copyButton) {
    copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'yoko-inline-copy';
    copyButton.textContent = '⧉ 复制';
    copyButton.title = '复制这条客户消息';
    actions.appendChild(copyButton);
    copyButton.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      const currentText = yokoReadBubbleOriginalText(bubble);
      if (!currentText || copyButton.disabled) return;
      copyButton.disabled = true;
      try {
        const result = await ipcRenderer.invoke('copy-text-to-clipboard', currentText);
        if (result?.ok === false) throw new Error(result.error || '复制失败');
        copyButton.dataset.copied = '1';
        copyButton.textContent = '✓ 已复制';
        setTimeout(() => {
          if (!copyButton?.isConnected) return;
          copyButton.dataset.copied = '0';
          copyButton.textContent = '⧉ 复制';
        }, 900);
      } catch {
        copyButton.textContent = '复制失败';
        setTimeout(() => { if (copyButton?.isConnected) copyButton.textContent = '⧉ 复制'; }, 1100);
      } finally {
        copyButton.disabled = false;
      }
    });
  }

  let button = actions.querySelector('.yoko-inline-retranslate');
  const shouldShowRetranslate = !!(__yokoInlineSettings.enabled && __yokoInlineSettings.providerReady);
  if (shouldShowRetranslate && !button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'yoko-inline-retranslate';
    button.textContent = '↻ 重译';
    button.title = '重新翻译这条客户消息';
    actions.insertBefore(button, copyButton);
    button.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      const currentText = yokoReadBubbleOriginalText(bubble);
      if (!currentText || button.disabled) return;
      button.disabled = true;
      button.textContent = '翻译中…';
      try {
        const old = bubble.querySelector(':scope > .yoko-inline-translation');
        if (old) old.remove();
        __yokoTranslatedBubbles.delete(bubble);
        await yokoTranslateBubble(bubble, currentText, 'incoming', { force: true });
        button.textContent = bubble.querySelector(':scope > .yoko-inline-translation') ? '↻ 重译' : '↻ 重试';
      } catch {
        button.textContent = '↻ 重试';
      } finally {
        button.disabled = false;
      }
    });
  } else if (!shouldShowRetranslate && button) {
    button.remove();
  }

  actions.dataset.yokoOriginal = cleanedOriginal;
  return actions;
}

const __yokoPendingOutgoingOriginals = [];

function yokoQueueOutgoingOriginal(original, translated) {
  const source = yokoInlineNormalizeText(original);
  const sent = yokoInlineNormalizeText(translated);
  if (!source || !sent) return false;
  __yokoPendingOutgoingOriginals.push({ original: source, translated: sent, createdAt: Date.now() });
  while (__yokoPendingOutgoingOriginals.length > 30) __yokoPendingOutgoingOriginals.shift();
  return true;
}

function yokoConsumeOutgoingOriginal(translatedText) {
  const value = yokoInlineNormalizeText(translatedText);
  const now = Date.now();
  for (let i = __yokoPendingOutgoingOriginals.length - 1; i >= 0; i--) {
    const item = __yokoPendingOutgoingOriginals[i];
    if (now - item.createdAt > 10 * 60 * 1000) {
      __yokoPendingOutgoingOriginals.splice(i, 1);
      continue;
    }
    if (item.translated === value) {
      __yokoPendingOutgoingOriginals.splice(i, 1);
      return item.original;
    }
  }
  return '';
}


function yokoRecentAiContext(currentBubble, limit = 4) {
  const candidates = yokoMessageBubbleCandidates();
  const max = Math.max(0, Math.min(12, Number(limit) || 6));
  if (!max) return [];

  const context = [];
  const currentTop = currentBubble?.getBoundingClientRect?.().top ?? Infinity;
  for (const item of candidates) {
    if (!item?.bubble || item.bubble === currentBubble) continue;

    // Context must be chronological: never use a message displayed after the
    // current bubble to interpret an earlier message during initial/backlog scan.
    if (Number.isFinite(currentTop) && item.rect?.top >= currentTop - 1) continue;

    const cleaned = yokoStripLineUiMetadata(item.text || '');
    if (!cleaned) continue;
    context.push({
      role: item.role === 'outgoing' ? 'me' : 'customer',
      text: cleaned.slice(0, 800)
    });
  }
  return context.slice(-max);
}

function yokoTranslationSlotLimit() { return String(__yokoInlineSettings.engine || '').toLowerCase() === 'ollama' ? 1 : 3; }
async function yokoAcquireTranslationSlot() {
  while (__yokoActiveTranslations >= yokoTranslationSlotLimit()) await new Promise(resolve => __yokoTranslationSlotWaiters.push(resolve));
  __yokoActiveTranslations++;return true;
}
function yokoReleaseTranslationSlot() {
  __yokoActiveTranslations=Math.max(0,__yokoActiveTranslations-1);
  while (__yokoTranslationSlotWaiters.length && __yokoActiveTranslations < yokoTranslationSlotLimit()) { const next=__yokoTranslationSlotWaiters.shift();try{next();}catch{} }
}

async function yokoTranslateBubble(bubble, text, role, { force = false } = {}) {

  // V1.23.25: both incoming and outgoing LINE bubbles are translated.
  if (role !== 'incoming' && role !== 'outgoing') return;
  if (__yokoLineTransientUiActive()) { yokoScheduleInlineScan(420); return false; }
  if (!__yokoInlineSettings.enabled) return;
  if (__yokoPendingBubbles.has(bubble)) return false;

  const previous = __yokoTranslatedBubbles.get(bubble);
  if (!force && previous === text) return true;

  if (!force && yokoFindExistingTranslation(bubble, text)) {
    __yokoTranslatedBubbles.set(bubble, text);
    return true;
  }
  if (force) {
    __yokoTranslatedBubbles.delete(bubble);
    bubble.querySelector?.(':scope > .yoko-inline-translation')?.remove?.();
  }

  __yokoPendingBubbles.add(bubble);
  let slotAcquired=false;

  try {
    // Let the native LINE send/render path finish before local Ollama starts
    // consuming CPU for our own outgoing bilingual copy. Incoming messages and
    // manual retranslation stay immediate.
    if (role === 'outgoing' && !force) {
      await new Promise(resolve => setTimeout(resolve, 700));
      if (!bubble?.isConnected) return false;
    }
    const cleanText = yokoStripLineUiMetadata(text);
    if (!cleanText) return;
    await yokoAcquireTranslationSlot();slotAcquired=true;
    if (!bubble?.isConnected) return false;

    // V1.22.4: every incoming message visibly enters a translation state so the
    // operator always knows it has been detected and queued.
    yokoAttachTranslationStatus(bubble, cleanText, '翻译中…', 'pending', role);

    const result = await ipcRenderer.invoke(
      'line-inline-translate',
      {
        text: cleanText,
        role,
        context: role === 'incoming' && ['groq','openrouter'].includes(__yokoInlineSettings.engine) ? yokoRecentAiContext(bubble, 3) : [],
        force: force === true
      }
    );

    if (!result?.ok) {
      yokoAttachTranslationStatus(bubble, cleanText, '翻译失败，稍后自动重试', 'error', role);
      if (result?.error) console.debug('[Yoko bilingual translate skipped]', result.error);
      return false;
    }

    const translated = yokoStripLineUiMetadata(
      result.translated || ''
    );

    if (!bubble.isConnected) return false;
    if (__yokoLineTransientUiActive()) { yokoScheduleInlineScan(420); return false; }
    if (!translated || translated === cleanText) {
      yokoAttachTranslationStatus(bubble, cleanText, __yokoInlineSettings.target === 'zh' ? '已是中文' : '已是目标语言', 'done', role);
      __yokoTranslatedBubbles.set(bubble, text);
      return true;
    }

    const attached = yokoAttachTranslation(
      bubble,
      text,
      translated,
      role
    );
    if (!attached) return false;
    __yokoTranslatedBubbles.set(bubble, text);
    return true;
  } catch (error) {
    try { yokoAttachTranslationStatus(bubble, text, '翻译失败，稍后自动重试', 'error', role); } catch {}
    console.debug('[Yoko bilingual translate failed]', error?.message || error);
    return false;
  } finally {
    if(slotAcquired)yokoReleaseTranslationSlot();
    __yokoPendingBubbles.delete(bubble);
  }
}

function yokoTranslationConcurrency() {
  return String(__yokoInlineSettings.engine || '').toLowerCase() === 'ollama' ? 1 : 3;
}
async function yokoPrimePersistentTranslationCache(candidates=[], epoch=__yokoTranslationEpoch) {
  const newest=[...candidates].reverse();
  const rows=[];
  for (const item of newest.slice(0,64)) {
    const bubble=item?.bubble, text=yokoStripLineUiMetadata(item?.text||'');
    if (!bubble?.isConnected || !text || yokoFindExistingTranslation(bubble,text)) continue;
    rows.push({id:`l${rows.length}`,bubble,text,role:item.role});
  }
  if (!rows.length) return;
  try {
    const result=await ipcRenderer.invoke('line-inline-translation-cache-batch',{
      items:rows.map(row=>({id:row.id,text:row.text,source:__yokoInlineSettings.source||'auto',target:__yokoInlineSettings.target||'zh',context:[]})),
      preferSpeed:String(__yokoInlineSettings.engine||'').toLowerCase() !== 'ollama'
    });
    if (epoch !== __yokoTranslationEpoch) return;
    const byId=new Map((result?.items||[]).map(row=>[String(row?.id||''),row]));
    for (const row of rows) {
      const hit=byId.get(row.id); const translated=yokoStripLineUiMetadata(hit?.hit?hit.translated||'':'');
      if (!translated || !row.bubble?.isConnected || yokoReadBubbleOriginalText(row.bubble)!==row.text) continue;
      if (translated===row.text) yokoAttachTranslationStatus(row.bubble,row.text,__yokoInlineSettings.target==='zh'?'已是中文':'已是目标语言','done',row.role);
      else yokoAttachTranslation(row.bubble,row.text,translated,row.role);
      __yokoTranslatedBubbles.set(row.bubble,row.text);
    }
  } catch {}
}

async function yokoScanIncomingMessages(epoch=__yokoTranslationEpoch) {
  __yokoScanScheduled = false;
  __yokoScanTimer = null;
  if (!__yokoForegroundMode) return;
  if (__yokoLineTransientUiActive()) { yokoScheduleInlineScan(120); return; }

  yokoInjectTranslationStyle();
  const candidates = yokoMessageBubbleCandidates();
  const canTranslate = !!(__yokoInlineSettings.enabled && __yokoInlineSettings.providerReady);
  for (const { bubble, text, role } of [...candidates].reverse()) if (role === 'incoming') yokoEnsureTranslationAction(bubble, text, role);
  if (!canTranslate) return;

  // Restore successful translations from the main-process durable display cache
  // before starting any provider work. Full app restarts therefore do not retranslate.
  await yokoPrimePersistentTranslationCache(candidates,epoch);
  if (epoch !== __yokoTranslationEpoch) return;

  const newest=[...candidates].reverse().filter(({bubble,text})=>!yokoFindExistingTranslation(bubble,text));
  let cursor=0;
  const worker=async()=>{
    while(cursor<newest.length && epoch===__yokoTranslationEpoch && __yokoForegroundMode){
      const item=newest[cursor++];
      await yokoTranslateBubble(item.bubble,item.text,item.role);
    }
  };
  await Promise.all(Array.from({length:Math.min(yokoTranslationConcurrency(),newest.length)},worker));
}

function yokoScheduleInlineScan(delay = 40,{preempt=false}={}) {
  if (!__yokoForegroundMode) return;
  if (preempt) __yokoTranslationEpoch++;
  if (__yokoScanTimer) clearTimeout(__yokoScanTimer);
  __yokoScanScheduled = true;
  const epoch=__yokoTranslationEpoch;
  __yokoScanTimer=setTimeout(()=>yokoScanIncomingMessages(epoch),Math.max(10,Number(delay)||0));
}

function yokoRemoveAllInlineTranslations() {
  document.querySelectorAll('.yoko-inline-translation').forEach(el => el.remove());
  document.querySelectorAll('.yoko-inline-retranslate').forEach(el => el.remove());
  document.querySelectorAll('.yoko-inline-actions').forEach(actions => {
    if (!actions.querySelector('.yoko-inline-copy')) actions.remove();
  });
  document.querySelectorAll('.yoko-has-inline-translation').forEach(el => el.classList.remove('yoko-has-inline-translation'));
}

async function yokoRefreshInlineSettings() {
  try {
    const settings = await ipcRenderer.invoke(
      'get-inline-translation-settings'
    );

    __yokoInlineSettings = {
      enabled: !!settings?.enabled,
      source: settings?.source || 'auto',
      target: settings?.target || 'zh',
      engine: settings?.engine || 'none',
      providerReady: !!settings?.providerReady,
      accountEnabled: settings?.accountEnabled !== false,
      displayMode: settings?.displayMode || 'bilingual',
      // V1.23.25: outgoing bubbles are translated after send as well.
      translateOutgoingLocal: true
    };

    if (
      __yokoInlineSettings.enabled &&
      __yokoInlineSettings.providerReady
    ) {
      yokoInjectTranslationStyle();
      yokoRemoveAllInlineTranslations();
      __yokoTranslatedBubbles = new WeakMap();
      __yokoPendingBubbles = new WeakSet();
      yokoScheduleInlineScan(20,{preempt:true});
    } else {
      yokoRemoveAllInlineTranslations();
      yokoScheduleInlineScan(20,{preempt:true});
    }
  } catch {
    __yokoInlineSettings.enabled = false;
    __yokoInlineSettings.providerReady = false;
    yokoScheduleInlineScan(40,{preempt:true});
  }
}

function yokoStartInlineTranslation() {
  yokoRefreshInlineSettings();
  yokoScheduleInlineScan(18,{preempt:true});

  if (!__yokoInlineObserver) {
    __yokoInlineObserver = new MutationObserver(
      mutations => {
        if (!__yokoForegroundMode) return;
        // Ignore mutations generated only by our own translation nodes.
        const meaningful = mutations.some(mutation => {
          // LINE sometimes creates the outgoing row first and fills its text
          // through a characterData update. Treat that as meaningful so a
          // newly sent message is translated immediately instead of waiting
          // for the periodic fallback scan.
          if (mutation.type === 'characterData') {
            return !mutation.target?.parentElement?.closest?.('.yoko-inline-translation');
          }

          return [...(mutation.addedNodes || [])].some(
            node =>
              !(
                node instanceof Element &&
                (
                  node.classList?.contains('yoko-inline-translation') ||
                  node.classList?.contains('yoko-inline-actions') ||
                  node.closest?.('.yoko-inline-translation,.yoko-inline-actions,.yoko-line-paste-action')
                )
              )
          );
        });

        if (meaningful) {
          yokoScheduleInlineScan(28,{preempt:true});
        }
      }
    );

    __yokoInlineObserver.observe(
      document.documentElement,
      {
        childList: true,
        subtree: true,
        characterData: true
      }
    );
  }

  if (!__yokoInlineTimer) {
    __yokoInlineTimer = setInterval(
      () => yokoScheduleInlineScan(0),
      10000
    );
  }
}

ipcRenderer.on(
  'inline-translation-settings',
  (_event, settings) => {
    yokoRemoveAllInlineTranslations();
    __yokoTranslatedBubbles = new WeakMap();
    __yokoPendingBubbles = new WeakSet();

    __yokoInlineSettings = {
      enabled: !!settings?.enabled,
      source: settings?.source || 'auto',
      target: settings?.target || 'zh',
      engine: settings?.engine || 'none',
      providerReady: !!settings?.providerReady,
      accountEnabled: settings?.accountEnabled !== false,
      displayMode: settings?.displayMode || 'bilingual',
      // V1.23.25: outgoing bubbles are translated after send as well.
      translateOutgoingLocal: true
    };

    if (
      __yokoInlineSettings.enabled &&
      __yokoInlineSettings.providerReady
    ) {
      yokoScheduleInlineScan(0);
    } else {
      yokoRemoveAllInlineTranslations();
      yokoScheduleInlineScan(0);
    }
  }
);

if (document.readyState === 'loading') {
  window.addEventListener(
    'DOMContentLoaded',
    yokoStartInlineTranslation,
    { once: true }
  );
} else {
  yokoStartInlineTranslation();
}


// ---------------- Yoko translation bridge ----------------

function visible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return (
    rect.width > 2 &&
    rect.height > 2 &&
    style.visibility !== 'hidden' &&
    style.display !== 'none'
  );
}

function __yokoIsTextareaEx(el) {
  if (!el) return false;
  try {
    if (String(el.tagName || '').toLowerCase() === 'textarea-ex') return true;
    if (window.HTMLTextAreaExElement && el instanceof window.HTMLTextAreaExElement) return true;
  } catch {}
  return false;
}

function __yokoTextareaExInput(el) {
  if (!__yokoIsTextareaEx(el)) return null;
  try {
    return el.inputEl || el.shadowRoot?.querySelector?.('textarea.input,textarea') || null;
  } catch { return null; }
}

function __yokoFocusEditable(el) {
  if (!el) return false;
  try {
    const inner = __yokoTextareaExInput(el);
    if (inner) {
      inner.focus({ preventScroll: true });
      return document.activeElement === el || el.shadowRoot?.activeElement === inner || inner.matches?.(':focus');
    }
    el.focus({ preventScroll: true });
    return document.activeElement === el || el.contains?.(document.activeElement);
  } catch { return false; }
}

function editableCandidates() {
  const selectors = [
    // LINE 3.7.x uses a custom <textarea-ex> web component whose real textarea
    // lives inside an OPEN shadow root. It must be selected by its host because
    // document.querySelector('textarea') cannot see through the shadow boundary.
    'textarea-ex',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    'textarea',
    'input[type="text"]'
  ];

  const out = [];
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (el.closest?.('.yoko-ai-reply-dock')) continue;
      if (visible(el) && !out.includes(el)) out.push(el);
    }
  }
  return out;
}

function findComposer() {
  const active = document.activeElement;
  if (
    active &&
    !active.closest?.('.yoko-ai-reply-dock') &&
    visible(active) &&
    (
      active.matches?.('textarea,input[type="text"],[contenteditable="true"]') ||
      active.isContentEditable
    )
  ) {
    return active;
  }

  const list = editableCandidates();
  if (!list.length) return null;

  list.sort(
    (a, b) =>
      b.getBoundingClientRect().bottom -
      a.getBoundingClientRect().bottom
  );
  return list[0];
}

// V1.23.15: direct-send must target LINE's real bottom message composer,
// never the chat-search box or another editable control. During a conversation
// switch LINE can mount the composer a little later than the header/route, so
// callers may also wait briefly instead of failing on the first lookup.
function findMessageComposer() {
  // V1.23.16: the bundled LINE 3.7.2 chat composer is <textarea-ex> with its
  // native textarea inside shadowRoot. Prefer that exact element first; this
  // avoids both the search box and the false "input not found" seen in 1.23.15.
  try {
    const custom = [...document.querySelectorAll('textarea-ex')]
      .filter(el => visible(el) && !!__yokoTextareaExInput(el))
      .map(el => ({ el, rect: el.getBoundingClientRect(), hint: [el.placeholder, el.getAttribute?.('placeholder'), el.getAttribute?.('aria-label'), String(el.className || '')].filter(Boolean).join(' ').toLowerCase() }))
      .filter(item => item.rect.width >= 120 && item.rect.height >= 8 && item.rect.bottom >= window.innerHeight * 0.58 && !/search|検索|搜索/.test(item.hint));
    custom.sort((a,b) => b.rect.bottom - a.rect.bottom || b.rect.width - a.rect.width);
    if (custom[0]?.el) return custom[0].el;
  } catch {}

  try {
    const bottom = typeof yokoFindBottomComposer === 'function' ? yokoFindBottomComposer() : null;
    if (bottom && visible(bottom)) return bottom;
  } catch {}

  const candidates = editableCandidates()
    .map(el => ({ el, rect: el.getBoundingClientRect() }))
    .filter(({ el, rect }) => {
      if (!rect || !visible(el) || el.closest?.('.yoko-ai-reply-dock')) return false;
      if (rect.width < 120 || rect.height < 8) return false;
      if (rect.bottom < window.innerHeight * 0.60) return false;
      const hint = [
        el.getAttribute?.('placeholder'),
        el.getAttribute?.('aria-label'),
        el.getAttribute?.('role'),
        String(el.className || '')
      ].filter(Boolean).join(' ').toLowerCase();
      if (/search|検索|搜索/.test(hint)) return false;
      return true;
    });
  candidates.sort((a,b) => {
    const bd=b.rect.bottom-a.rect.bottom;
    if(Math.abs(bd)>5)return bd;
    return b.rect.width-a.rect.width;
  });
  return candidates[0]?.el || null;
}

async function waitForMessageComposer(timeoutMs = 2600) {
  const timeout = Math.max(200, Math.min(6000, Number(timeoutMs) || 2600));
  const started = Date.now();
  while (Date.now() - started <= timeout) {
    const composer = findMessageComposer();
    if (composer) return composer;
    await new Promise(resolve => setTimeout(resolve, 70));
  }
  return null;
}

function readElement(el) {
  if (!el) return '';
  if (__yokoIsTextareaEx(el)) {
    try {
      const value = el.value;
      if (Array.isArray(value)) return value.map(part => typeof part === 'string' ? part : String(part?.altText || '')).join('');
      const inner = __yokoTextareaExInput(el);
      return String(inner?.value || el.rawValue || '');
    } catch { return ''; }
  }
  if ('value' in el) return el.value || '';
  return el.innerText || el.textContent || '';
}

function dispatchInput(el, text) {
  if (!el) return false;
  const nextText = String(text || '');

  // LINE 3.7.x: edit the native textarea inside <textarea-ex>. Dispatching a
  // composed input event makes the web component update rawValue AND lets
  // React's onInput handler on the host receive currentTarget.value correctly.
  if (__yokoIsTextareaEx(el)) {
    try {
      const inner = __yokoTextareaExInput(el);
      if (!inner) return false;
      __yokoFocusEditable(el);
      const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      if (descriptor?.set) descriptor.set.call(inner, nextText);
      else inner.value = nextText;
      try {
        inner.dispatchEvent(new InputEvent('input', { bubbles:true, composed:true, inputType:'insertText', data:nextText }));
      } catch {
        inner.dispatchEvent(new Event('input', { bubbles:true, composed:true }));
      }
      inner.dispatchEvent(new Event('change', { bubbles:true, composed:true }));
      return readElement(el) === nextText || String(inner.value || '') === nextText;
    } catch { return false; }
  }

  __yokoFocusEditable(el);

  if ('value' in el) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;

    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor?.set) descriptor.set.call(el, nextText);
    else el.value = nextText;

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  if (el.isContentEditable || el.getAttribute?.('contenteditable') === 'true') {
    el.textContent = text;
    try {
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: text
        })
      );
    } catch {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  }

  return false;
}


let __yokoLastClickedText = '';

function normalizeText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function captureClickedText(target) {
  const origin = target instanceof Element ? target : target?.parentElement;
  if (origin?.closest?.('.yoko-ai-reply-dock')) return;
  let el = origin;
  let best = '';

  for (let depth = 0; el && depth < 7; depth++, el = el.parentElement) {
    if (
      el.matches?.('textarea,input,[contenteditable="true"],button') ||
      el.isContentEditable
    ) {
      continue;
    }

    const text = normalizeText(el.innerText || el.textContent || '');
    if (!text || text.length > 1600) continue;

    // Prefer the smallest useful text block around the user's click.
    if (!best || text.length < best.length) best = text;

    const cls = String(el.className || '');
    if (/message|bubble|talk|chat/i.test(cls) && text.length <= 1200) {
      best = text;
      break;
    }
  }

  if (best) __yokoLastClickedText = best;
}

document.addEventListener(
  'click',
  event => captureClickedText(event.target),
  true
);

function recentMessageCandidates(limit = 8) {
  const selectors = [
    '[data-message-id]',
    '[data-local-id]',
    '[class*="message"]',
    '[class*="Message"]',
    '[class*="bubble"]',
    '[class*="Bubble"]',
    '[role="listitem"]'
  ];

  const found = [];
  const seen = new Set();

  for (const selector of selectors) {
    let nodes = [];
    try { nodes = [...document.querySelectorAll(selector)]; } catch {}

    for (const el of nodes) {
      if (!visible(el)) continue;
      if (el.closest?.('.yoko-ai-reply-dock')) continue;
      if (el.matches?.('textarea,input,[contenteditable="true"]') || el.isContentEditable) continue;

      const text = normalizeText(el.innerText || el.textContent || '');
      if (!text || text.length > 1200 || seen.has(text)) continue;

      seen.add(text);
      found.push({
        text,
        top: el.getBoundingClientRect().top
      });
    }
  }

  found.sort((a, b) => a.top - b.top);
  return found.slice(-Math.max(1, Math.min(30, Number(limit) || 8))).map(x => x.text);
}




// V1.23.48: route-independent LINE Redux reader. The shell already knows the
// exact customer MID/chatId when a row is selected, so do not wait for LINE's
// React hash route to finish changing before reading that customer's messages.
// This removes the main source of intermittent "no recent customer message"
// failures in aggregate/native mode.
function yokoReduxMessageRowsForChatId(explicitChatId, limit = 80) {
  const max = Math.max(1, Math.min(120, Number(limit) || 80));
  const chatId = String(explicitChatId || '').trim();
  if (!chatId) return [];
  try {
    const state = __yokoAggregateState();
    const ownMid = String(state?.auth?.profile?.mid || '').trim();
    const messages = state?.message?.entities?.messages || {};
    if (!ownMid || !messages || typeof messages !== 'object') return [];
    const rows = [];
    let storeOrder = 0;
    for (const candidate of Object.values(messages)) {
      if (!candidate || typeof candidate !== 'object') continue;
      const from = String(candidate.from || '').trim();
      const to = String(candidate.to || '').trim();
      let role = '';
      if (from === ownMid && to === chatId) role = 'me';
      else if (from === chatId && (to === ownMid || !to)) role = 'customer';
      if (!role) continue;
      const text = __yokoAggregateText(candidate.text).trim();
      if (!text) continue;
      const delivered = Number(candidate.deliveredTime || candidate.createdTime || candidate.timestamp || 0) || 0;
      const id = String(candidate.id || candidate.messageId || candidate.localId || '');
      rows.push({ role, text:text.slice(0,4000), delivered, id, storeOrder:storeOrder++ });
    }
    rows.sort((a,b) => {
      if (a.delivered && b.delivered && a.delivered !== b.delivered) return a.delivered-b.delivered;
      const ai = /^\d+$/.test(a.id) ? BigInt(a.id) : null;
      const bi = /^\d+$/.test(b.id) ? BigInt(b.id) : null;
      if (ai !== null && bi !== null && ai !== bi) return ai < bi ? -1 : 1;
      return a.storeOrder-b.storeOrder;
    });
    return rows.slice(-max).map(({role,text,delivered,id}) => ({role,text,delivered,id}));
  } catch (error) {
    console.debug('[Yoko explicit Redux message read skipped]', error?.message || error);
    return [];
  }
}

function yokoDomRecentMessageRows(limit = 80) {
  const max = Math.max(1, Math.min(120, Number(limit) || 80));
  try {
    return yokoMessageBubbleCandidates()
      .filter(item => item?.bubble && (item.role === 'incoming' || item.role === 'outgoing'))
      .sort((a,b) => Number(a.rect?.top || 0) - Number(b.rect?.top || 0))
      .map(item => ({
        role:item.role === 'outgoing' ? 'me' : 'customer',
        text:yokoStripLineUiMetadata(item.text || '').trim().slice(0,4000)
      }))
      .filter(item => item.text)
      .slice(-max);
  } catch { return []; }
}

function yokoReliableMessageBundle(explicitChatId = '', limit = 80) {
  const max = Math.max(1, Math.min(120, Number(limit) || 80));
  const info = yokoGetCurrentChatInfo();
  const chatId = String(explicitChatId || info?.chatId || '').trim();
  const routeChatId = String(info?.chatId || '').trim();
  const reduxRows = yokoReduxMessageRowsForChatId(chatId, max);
  const routeRows = routeChatId && routeChatId === chatId ? recentMessageCandidatesDetailed(max) : [];
  const domRows = routeChatId && routeChatId === chatId ? yokoDomRecentMessageRows(max) : [];
  const unreadMessages = routeChatId && routeChatId === chatId ? yokoUnreadCustomerMessagesFromDom(40) : [];
  let unreadCount = 0;
  try {
    const state = __yokoAggregateState();
    unreadCount = Math.max(0, Number(state?.messageBox?.entities?.messageBoxes?.[chatId]?.unreadCount || 0) || 0);
  } catch {}
  return { chatId, routeChatId, chatInfo:info || {}, unreadCount, unreadMessages, reduxRows, routeRows, domRows };
}

function recentMessageCandidatesDetailed(limit = 8) {
  const max = Math.max(1, Math.min(80, Number(limit) || 8));

  // V1.23.45: prefer LINE's Redux message store for the active 1:1 chat. DOM
  // rows are virtualized, so reading only mounted bubbles could miss the first
  // messages when a customer sent 10+ lines. Redux also gives us stable time
  // ordering and preserves repeated identical messages as separate events.
  try {
    const state = __yokoAggregateState();
    const chatId = yokoCurrentChatIdFromLocation();
    const ownMid = String(state?.auth?.profile?.mid || '').trim();
    const messages = state?.message?.entities?.messages || {};
    if (chatId && ownMid && messages && typeof messages === 'object') {
      const rows = [];
      let storeOrder = 0;
      for (const candidate of Object.values(messages)) {
        if (!candidate || typeof candidate !== 'object') continue;
        const from = String(candidate.from || '').trim();
        const to = String(candidate.to || '').trim();
        let role = '';
        if (from === ownMid && to === chatId) role = 'me';
        else if (from === chatId && (to === ownMid || !to)) role = 'customer';
        if (!role) continue;
        const text = __yokoAggregateText(candidate.text).trim();
        if (!text) continue;
        const delivered = Number(candidate.deliveredTime || candidate.createdTime || candidate.timestamp || 0) || 0;
        const id = String(candidate.id || candidate.messageId || candidate.localId || '');
        const numericId = Number(id) || 0;
        rows.push({ role, text:text.slice(0,4000), delivered, id, numericId, storeOrder:storeOrder++ });
      }
      rows.sort((a,b) => {
        if (a.delivered && b.delivered && a.delivered !== b.delivered) return a.delivered-b.delivered;
        const ai = /^\d+$/.test(a.id) ? BigInt(a.id) : null;
        const bi = /^\d+$/.test(b.id) ? BigInt(b.id) : null;
        if (ai !== null && bi !== null && ai !== bi) return ai < bi ? -1 : 1;
        return a.storeOrder-b.storeOrder;
      });
      if (rows.length) return rows.slice(-max).map(({role,text,delivered,id}) => ({role,text,delivered,id}));
    }
  } catch (error) {
    console.debug('[Yoko recent messages redux fallback]', error?.message || error);
  }

  // Compatibility fallback for LINE versions where the Redux store has not
  // hydrated yet. yokoMessageBubbleCandidates already de-duplicates by the
  // actual bubble element, so do not collapse equal text from two real messages.
  return yokoMessageBubbleCandidates()
    .filter(item => item?.bubble && (item.role === 'incoming' || item.role === 'outgoing'))
    .sort((a,b) => (a.rect?.top || 0) - (b.rect?.top || 0))
    .map(item => ({
      role:item.role === 'outgoing' ? 'me' : 'customer',
      text:yokoStripLineUiMetadata(item.text || '').trim().slice(0,4000)
    }))
    .filter(item => item.text)
    .slice(-max);
}

function yokoUnreadCustomerMessagesFromDom(limit = 40) {
  try {
    const labels = new Set(['未読メッセージ','未读消息','未讀消息','未讀訊息']);
    let markerTop = null;
    for (const el of document.querySelectorAll('div,span,p')) {
      if (!(el instanceof Element) || !visible(el)) continue;
      const text = normalizeText(el.innerText || el.textContent || '');
      if (!labels.has(text)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.top < 80 || rect.top > window.innerHeight - 80) continue;
      markerTop = rect.top;
      break;
    }
    if (markerTop === null) return [];
    const ordered = yokoMessageBubbleCandidates()
      .filter(item => item?.bubble && (item.role === 'incoming' || item.role === 'outgoing') && Number(item.rect?.top || 0) > markerTop + 2)
      .sort((a,b) => Number(a.rect?.top || 0) - Number(b.rect?.top || 0));
    const out = [];
    for (const item of ordered) {
      if (item.role === 'outgoing') { out.length = 0; continue; }
      const text = yokoStripLineUiMetadata(item.text || '').trim().slice(0,4000);
      if (text) out.push(text);
    }
    return out.slice(-Math.max(1, Math.min(40, Number(limit) || 40)));
  } catch { return []; }
}

function yokoCurrentChatNameCandidate() {
  const width = Math.max(window.innerWidth || 1, 1);
  const chatLeft = Math.max(285, width * 0.24);
  const generic = new Set([
    'すべて', '友だち', 'グループ', '公式アカウント',
    '全部', '好友', '群组', '官方群組', '官方账号',
    '未読メッセージ', '未读消息', '今天', '今日', '昨天', '昨日',
    'LINE', '聊天', 'トーク', '搜索', '検索'
  ]);

  const candidates = [];
  const elements = document.querySelectorAll('div,span,strong,b');

  for (const el of elements) {
    if (!(el instanceof Element) || !visible(el)) continue;
    if (el.closest('.yoko-ai-reply-dock')) continue;
    if (el.closest('.yoko-inline-translation')) continue;
    if (el.matches('button,input,textarea,[contenteditable="true"]')) continue;

    const rect = el.getBoundingClientRect();
    if (rect.left < chatLeft) continue;
    if (rect.top < 0 || rect.top > 125) continue;
    if (rect.height < 12 || rect.height > 52) continue;
    if (rect.width < 12 || rect.width > Math.min(520, width * 0.48)) continue;

    const text = normalizeText(el.innerText || el.textContent || '');
    if (!text || text.length > 90) continue;
    if (generic.has(text)) continue;
    if (/^[\d\s:：./\-年月日APMapm]+$/.test(text)) continue;
    if (/^[\p{P}\p{S}\s]+$/u.test(text)) continue;
    if (/^译[:：]/.test(text)) continue;

    const style = getComputedStyle(el);
    const fontSize = parseFloat(style.fontSize || '0') || 0;
    const weight = parseInt(style.fontWeight || '400', 10) || 400;

    let score = 0;
    if (rect.top <= 80) score += 38;
    else score += Math.max(0, 28 - (rect.top - 80));
    if (fontSize >= 14) score += 18;
    if (fontSize >= 16) score += 8;
    if (weight >= 500) score += 12;
    if (text.length >= 2 && text.length <= 40) score += 12;
    if (rect.left < width * 0.72) score += 8;

    // Header names generally don't contain whole-message line breaks.
    if (!text.includes('\n')) score += 8;

    candidates.push({ text, score, rect });
  }

  candidates.sort((a, b) => b.score - a.score || a.rect.top - b.rect.top);
  return candidates[0] || null;
}

function yokoCurrentChatIdFromLocation() {
  try {
    const hash = String(window.location.hash || '');
    const match = hash.match(/#\/chats\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

function yokoGetCurrentChatInfo() {
  const chatId = yokoCurrentChatIdFromLocation();
  let identity = null;
  if (chatId) {
    try {
      const state = __yokoAggregateState();
      if (state) identity = __yokoAggregateConversationIdentity(chatId, state);
    } catch {}
  }

  const candidate = yokoCurrentChatNameCandidate();
  const visibleDisplayName = normalizeText(candidate?.text || '');
  const routeDisplayName = normalizeText(identity?.displayName || '');
  const displayName = normalizeText(routeDisplayName || visibleDisplayName || '');
  const confidence = identity?.displayName
    ? 100
    : (candidate ? Math.max(0, Math.min(100, Math.round(candidate.score))) : 0);

  let unreadCount = 0;
  try {
    const state = __yokoAggregateState();
    unreadCount = Math.max(0, Number(state?.messageBox?.entities?.messageBoxes?.[chatId]?.unreadCount || 0) || 0);
  } catch {}

  return {
    chatId,
    displayName,
    unreadCount,
    visibleDisplayName,
    routeDisplayName,
    avatarDataUrl: String(identity?.avatarDataUrl || ''),
    avatarUrl: String(identity?.avatarUrl || ''),
    confidence,
    source: identity?.displayName ? 'route-redux' : 'header-heuristic'
  };
}


// V1.23.15: notify the shell whenever the native LINE route changes so a
// separately-open speech library follows customer clicks immediately.
let __yokoLastCurrentChatNoticeKey = '';
function __yokoNotifyCurrentChatChanged() {
  try {
    const info = yokoGetCurrentChatInfo();
    const key = [String(info?.chatId || ''), String(info?.displayName || '')].join('|');
    if (key === __yokoLastCurrentChatNoticeKey) return;
    __yokoLastCurrentChatNoticeKey = key;
    ipcRenderer.send('line-current-chat-changed', info || {});
  } catch {}
}
window.addEventListener('hashchange', () => {
  setTimeout(__yokoNotifyCurrentChatChanged, 20);
  setTimeout(__yokoNotifyCurrentChatChanged, 180);
  setTimeout(__yokoNotifyCurrentChatChanged, 520);
});
// V1.23.49: some LINE builds update the selected conversation through React
// state before/without a distinct hashchange. A capture-phase click wake-up is
// intentionally cheap because __yokoNotifyCurrentChatChanged de-duplicates the
// resolved chat identity before notifying the main process.
document.addEventListener('click', () => {
  setTimeout(__yokoNotifyCurrentChatChanged, 30);
  setTimeout(__yokoNotifyCurrentChatChanged, 140);
  setTimeout(__yokoNotifyCurrentChatChanged, 360);
  setTimeout(__yokoNotifyCurrentChatChanged, 760);
}, true);
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => setTimeout(__yokoNotifyCurrentChatChanged, 120), { once:true });
} else {
  setTimeout(__yokoNotifyCurrentChatChanged, 120);
}


// V1.23.45: notify the main process as soon as the active LINE message turn
// changes. The payload carries only identity/role/count/signature (no message
// body); the main process still re-reads the locked target before staging GPT.
let __yokoGptActivityTimer = null;
let __yokoGptActivitySignature = '';
function __yokoGptActivityHash(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i=0;i<text.length;i+=1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash,16777619); }
  return (hash>>>0).toString(16);
}
function __yokoPublishGptActivity() {
  __yokoGptActivityTimer = null;
  try {
    const info = yokoGetCurrentChatInfo();
    const chatId = String(info?.chatId || '').trim();
    if (!chatId) return;
    const rows = recentMessageCandidatesDetailed(60);
    const tail = rows.slice(-50);
    const latest = tail[tail.length-1] || null;
    const signature = __yokoGptActivityHash(`${chatId}\u001f${tail.map((r,i)=>`${i}:${r.role}:${r.text}`).join('\u001e')}`);
    if (!signature || signature === __yokoGptActivitySignature) return;
    __yokoGptActivitySignature = signature;
    const unreadMessages = yokoUnreadCustomerMessagesFromDom(40);
    ipcRenderer.send('line-gpt-message-activity', {
      chatId,
      displayName:String(info?.displayName || ''),
      signature,
      latestRole:String(latest?.role || ''),
      messageCount:tail.length,
      unreadMessages,
      // Internal renderer->main IPC only; diagnostics never persist message text.
      messages:tail.map(row => ({
        role:String(row.role || ''), text:String(row.text || '').slice(0,4000),
        delivered:Number(row.delivered || 0) || 0, id:String(row.id || '')
      }))
    });
  } catch (error) {
    console.debug('[Yoko GPT activity publish skipped]', error?.message || error);
  }
}
function __yokoScheduleGptActivity(delay = 120) {
  if (__yokoGptActivityTimer) clearTimeout(__yokoGptActivityTimer);
  __yokoGptActivityTimer = setTimeout(__yokoPublishGptActivity, Math.max(50, Number(delay) || 120));
}
try {
  const root = document.documentElement;
  if (root) {
    const observer = new MutationObserver(mutations => {
      if (mutations.some(m => m.type === 'childList' || m.type === 'characterData')) __yokoScheduleGptActivity(140);
    });
    observer.observe(root, { subtree:true, childList:true, characterData:true });
  }
} catch (error) {
  console.debug('[Yoko GPT activity observer unavailable]', error?.message || error);
}
window.addEventListener('hashchange', () => { __yokoGptActivitySignature=''; __yokoScheduleGptActivity(180); });
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', () => __yokoScheduleGptActivity(500), { once:true });
else __yokoScheduleGptActivity(500);

// V1.23.16: continuously extract customer facts from the active LINE chat.
// Only customer-side bubbles are submitted; the main process performs the
// conservative merge (manual fields win, interests append + de-duplicate).
let __yokoCrmExtractTimer = null;
let __yokoCrmExtractLastSignature = '';
function __yokoCrmExtractSignature(chatId, messages) {
  const value = `${String(chatId || '')}\u001f${(messages || []).map(item => `${item.role}:${item.text}`).join('\u001e')}`;
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
function __yokoPublishCrmAutoExtract() {
  __yokoCrmExtractTimer = null;
  try {
    const info = yokoGetCurrentChatInfo();
    const chatId = String(info?.chatId || '').trim();
    const displayName = String(info?.displayName || '').trim();
    if (!chatId && !displayName) return;
    const messages = recentMessageCandidatesDetailed(30)
      .filter(item => (item?.role === 'customer' || item?.role === 'me') && String(item?.text || '').trim())
      .slice(-30);
    if (!messages.length) return;
    const signature = __yokoCrmExtractSignature(chatId || displayName, messages);
    if (signature === __yokoCrmExtractLastSignature) return;
    __yokoCrmExtractLastSignature = signature;
    ipcRenderer.send('line-crm-auto-extract', { chatId, displayName, messages, signature });
  } catch {}
}
function __yokoScheduleCrmAutoExtract(delay = 650) {
  if (__yokoCrmExtractTimer) clearTimeout(__yokoCrmExtractTimer);
  __yokoCrmExtractTimer = setTimeout(__yokoPublishCrmAutoExtract, Math.max(120, Number(delay) || 650));
}
try {
  const root = document.documentElement;
  if (root) {
    const observer = new MutationObserver(mutations => {
      if (mutations.some(m => m.type === 'childList' || m.type === 'characterData')) __yokoScheduleCrmAutoExtract(700);
    });
    observer.observe(root, { subtree:true, childList:true, characterData:true });
  }
} catch {}
window.addEventListener('hashchange', () => {
  __yokoCrmExtractLastSignature = '';
  __yokoScheduleCrmAutoExtract(450);
});
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => __yokoScheduleCrmAutoExtract(900), { once:true });
} else {
  __yokoScheduleCrmAutoExtract(900);
}

// ---------------- Yoko Aggregate Inbox bridge (V1.12.0) ----------------
// LINE 3.7.2 already keeps the complete chat/message-box overview in its Redux
// store. The bundled extension exposes that store as window._getState after
// login. Reading the store is much more reliable than scraping whichever chat
// list happens to be visible on screen, and it does not change the user's LINE
// navigation state.
function __yokoAggregateState() {
  try {
    if (typeof window._getState === 'function') return window._getState();
    if (window._A && typeof window._A.getState === 'function') return window._A.getState();
  } catch {}
  return null;
}

function __yokoAggregateText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// V1.15.29: do not hard-code LINE's internal conversation ID format here.
// V1.15.28 assumed every live conversation was u/c/r + 32 hex characters and
// filtered legitimate rows on some LINE 3.7.2 stores. We only reject explicit
// presentation/system placeholders and obviously unusable keys. The actual row
// must still come from LINE's messageBox/contact stores below.
function __yokoIsRealChatId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > 160) return false;
  const lowered = id.toLowerCase();
  if (['line', 'null', 'undefined', 'none', 'unknown'].includes(lowered)) return false;
  if (/^https?:\/\//i.test(id)) return false;
  if (/\s/.test(id)) return false;
  return true;
}

function __yokoIsCanonicalLineMid(value) {
  return /^[ucr][0-9a-z]{32}$/i.test(String(value || '').trim());
}

function __yokoAggregatePictureUrl(path) {
  const value = String(path || '').trim();
  if (!value) return '';
  if (/\/preview(?:\?|$)/.test(value)) return value;
  return `${value.replace(/\/+$/, '')}/preview`;
}

// V1.20.3 avatar repair: LINE 3.7.2 renders several built-in profile placeholders
// while a real photo is loading or after the image loader fails. Older aggregate
// builds could accidentally cache one of those static placeholders as if it were
// the customer's real avatar. These are SHA-256 hashes of LINE's bundled default
// profile images (Fd / LG / z0 in the unchanged LINE 3.7.2 bundle).
const __YOKO_LINE_PLACEHOLDER_AVATAR_SHA256 = new Set([
  'ef1955ae757c8b966c83248350331bd3a30f658ced11f387f8ebf05ab3368629',
  '23712cd1aa8104a20d944360326fefd35ad991c999944eca653b91357383d39c',
  '1bd4508b6253066e9d0f5d7640f403cd788a4351c76a92eee21a206871185359',
  '66be02c9eb53693232ec18159063a04800ad80f376d2309d2fe28574c39d2601',
  '18f0a5892879406869f2f1dc083be265675cadb285a6b47ee92e8fa03d14ffb6',
  'a5d1728c3b8132bf2af74db7914eb0989b75a6ffa192f697f5e8c4af047a403b'
]);

function __yokoAggregateAvatarBinary(value) {
  const dataUrl = String(value || '').trim();
  const match = dataUrl.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
  if (!match) return null;
  try {
    const buffer = Buffer.from(match[1], 'base64');
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

function __yokoIsKnownLinePlaceholderAvatar(value) {
  const buffer = __yokoAggregateAvatarBinary(value);
  if (!buffer) return false;
  try {
    return __YOKO_LINE_PLACEHOLDER_AVATAR_SHA256.has(
      crypto.createHash('sha256').update(buffer).digest('hex')
    );
  } catch {
    return false;
  }
}

function __yokoContactEntity(value) {
  if (!value || typeof value !== 'object') return {};
  return value.contact && typeof value.contact === 'object' ? value.contact : value;
}

// V1.23.10: LINE's own chat-folder logic classifies contacts with type=8
// (PROMOTION_BOT) as Official Accounts. Aggregate Mode is a customer reply desk,
// so these accounts must stay out together with groups/rooms.
function __yokoIsOfficialAggregateContact(value) {
  const contact = __yokoContactEntity(value);
  const type = contact?.type;
  return Number(type) === 8 || String(type || '').trim().toUpperCase() === 'PROMOTION_BOT';
}

// V1.12.5: friend avatars usually live on LINE's authenticated CDN. The Yoko
// renderer is a different WebContents, so loading those URLs directly can lose
// cookies/CORS and fall back to initials. Resolve them inside the owning LINE
// session and publish compact data URLs to the aggregate sidebar instead.
const __yokoAggregateAvatarDataCache = new Map();
const __yokoAggregateAvatarRetryAfter = new Map();
const __yokoAggregateAvatarPending = new Set();
const __yokoAggregateAvatarQueue = [];
let __yokoAggregateAvatarWorkers = 0;

async function __yokoAggregateFetchAvatarDataUrl(url) {
  const target = String(url || '').trim();
  if (!target) return '';
  const cached = __yokoAggregateAvatarDataCache.get(target) || '';
  if (cached) return cached;

  const base = target.replace(/\/preview(?:\?.*)?$/, '');
  const candidates = [...new Set([target, base, base ? `${base}/preview` : ''].filter(Boolean))];
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, { credentials: 'include', cache: 'force-cache' });
      if (!response.ok) continue;
      const blob = await response.blob();
      if (!blob?.size || blob.size > 2 * 1024 * 1024) continue;
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      if (dataUrl.startsWith('data:image/')) {
        // Never promote LINE's built-in loading/error silhouette to a customer photo.
        if (__yokoIsKnownLinePlaceholderAvatar(dataUrl)) continue;
        __yokoAggregateAvatarDataCache.set(target, dataUrl);
        // V1.15.22: renderer avatar bytes are disposable acceleration data.
        // Keep only a bounded hot working set; persistent customer photos live
        // in the main-process disk cache and are not affected by this trim.
        while (__yokoAggregateAvatarDataCache.size > 260) {
          const oldest = __yokoAggregateAvatarDataCache.keys().next().value;
          if (!oldest) break;
          __yokoAggregateAvatarDataCache.delete(oldest);
        }
        __yokoAggregateAvatarRetryAfter.delete(target);
        return dataUrl;
      }
    } catch {}
  }
  // V1.13.2: an avatar request can fail for a few seconds immediately after
  // LINE starts, before its authenticated CDN/session is ready. Never cache an
  // empty failure permanently; allow the queue to retry after a short backoff.
  __yokoAggregateAvatarDataCache.delete(target);
  __yokoAggregateAvatarRetryAfter.set(target, Date.now() + 5000);
  return '';
}

function __yokoDrainAggregateAvatarQueue() {
  while (__yokoAggregateAvatarWorkers < 4 && __yokoAggregateAvatarQueue.length) {
    const url = __yokoAggregateAvatarQueue.shift();
    if (!url) continue;
    __yokoAggregateAvatarWorkers += 1;
    __yokoAggregateFetchAvatarDataUrl(url)
      .finally(() => {
        __yokoAggregateAvatarWorkers = Math.max(0, __yokoAggregateAvatarWorkers - 1);
        __yokoAggregateAvatarPending.delete(url);
        // Publish again so the renderer replaces initials with the real photo.
        __yokoScheduleAggregateSnapshot(80);
        __yokoDrainAggregateAvatarQueue();
      });
  }
}

function __yokoQueueAggregateAvatar(url) {
  const target = String(url || '').trim();
  if (!target || (__yokoAggregateAvatarDataCache.get(target) || '') || __yokoAggregateAvatarPending.has(target)) return;
  const retryAfter = Number(__yokoAggregateAvatarRetryAfter.get(target) || 0);
  if (retryAfter && Date.now() < retryAfter) return;
  if (__yokoAggregateAvatarQueue.length >= 320) return;
  __yokoAggregateAvatarPending.add(target);
  __yokoAggregateAvatarQueue.push(target);
  __yokoDrainAggregateAvatarQueue();
}

function __yokoAggregateAvatarDataUrl(url) {
  const target = String(url || '').trim();
  if (!target) return '';
  __yokoQueueAggregateAvatar(target);
  return __yokoAggregateAvatarDataCache.get(target) || '';
}

// V1.12.6 fallback: LINE 3.7.2 often already rendered the real contact avatar
// in a profile-image node even when Redux's picturePath is missing. Match the
// exact MID and copy that image inside the authenticated LINE renderer.
const __yokoAggregateDomAvatarCache = new Map();
const __yokoAggregateDomAvatarPending = new Set();

async function __yokoResolveAggregateDomAvatar(mid) {
  const key = String(mid || '').trim();
  if (!key) return '';
  if (__yokoAggregateDomAvatarCache.has(key)) return __yokoAggregateDomAvatarCache.get(key) || '';
  try {
    // V1.14.6: LINE does not always place data-mid on the same element as
    // data-profile-image. Collect the exact MID node plus nearby profile-image
    // descendants/ancestors so avatars can still be recovered after list/profile
    // React remounts and for contacts that have never opened a chat before.
    const roots = [];
    const seenRoots = new Set();
    const addRoot = node => {
      if (!node || seenRoots.has(node)) return;
      seenRoots.add(node);
      roots.push(node);
    };
    for (const midNode of Array.from(document.querySelectorAll('[data-mid]'))) {
      if (String(midNode.getAttribute?.('data-mid') || '') !== key) continue;
      addRoot(midNode);
      if (midNode.matches?.('[data-profile-image]')) addRoot(midNode);
      for (const profileNode of Array.from(midNode.querySelectorAll?.('[data-profile-image]') || [])) addRoot(profileNode);
      const closestProfile = midNode.closest?.('[data-profile-image]');
      if (closestProfile) addRoot(closestProfile);
      let parent = midNode.parentElement;
      for (let depth = 0; depth < 3 && parent; depth += 1, parent = parent.parentElement) {
        for (const profileNode of Array.from(parent.querySelectorAll?.('[data-profile-image]') || []).slice(0, 6)) addRoot(profileNode);
      }
    }

    const candidates = [];
    for (const root of roots) {
      if (root.matches?.('img')) {
        const src = String(root.currentSrc || root.src || '').trim();
        if (src && !root.classList?.contains('is_loading')) candidates.push(src);
      }
      for (const img of Array.from(root.querySelectorAll?.('img') || [])) {
        const src = String(img.currentSrc || img.src || '').trim();
        // LINE's ObsImage uses class "is_loading" while showing a bundled fallback.
        if (src && !img.classList?.contains('is_loading')) candidates.push(src);
      }
      for (const child of [root, ...Array.from(root.querySelectorAll?.('*') || []).slice(0, 45)]) {
        try {
          const bg = String(getComputedStyle(child).backgroundImage || '');
          const match = bg.match(/^url\(["']?(.*?)["']?\)$/);
          if (match?.[1] && !match[1].startsWith('data:image/svg')) candidates.push(match[1]);
        } catch {}
      }
    }
    for (const src of [...new Set(candidates)]) {
      if (src.startsWith('data:image/')) {
        if (__yokoIsKnownLinePlaceholderAvatar(src)) continue;
        __yokoAggregateDomAvatarCache.set(key, src);
        while (__yokoAggregateDomAvatarCache.size > 360) {
          const oldest = __yokoAggregateDomAvatarCache.keys().next().value;
          if (!oldest) break;
          __yokoAggregateDomAvatarCache.delete(oldest);
        }
        return src;
      }
      const dataUrl = await __yokoAggregateFetchAvatarDataUrl(src);
      if (dataUrl && !__yokoIsKnownLinePlaceholderAvatar(dataUrl)) {
        __yokoAggregateDomAvatarCache.set(key, dataUrl);
        while (__yokoAggregateDomAvatarCache.size > 360) {
          const oldest = __yokoAggregateDomAvatarCache.keys().next().value;
          if (!oldest) break;
          __yokoAggregateDomAvatarCache.delete(oldest);
        }
        return dataUrl;
      }
    }
  } catch {}
  return '';
}

function __yokoAggregateDomAvatarDataUrl(mid) {
  const key = String(mid || '').trim();
  if (!key) return '';
  const cached = __yokoAggregateDomAvatarCache.get(key) || '';
  if (cached || __yokoAggregateDomAvatarPending.has(key)) return cached;
  __yokoAggregateDomAvatarPending.add(key);
  setTimeout(async () => {
    try { await __yokoResolveAggregateDomAvatar(key); }
    finally {
      __yokoAggregateDomAvatarPending.delete(key);
      __yokoScheduleAggregateSnapshot(60);
    }
  }, 0);
  return '';
}

// V1.14.6 strongest missing-avatar fallback: ask LINE's own authenticated
// getContactsV2 transport for the exact contact MID. This avoids depending on
// the contact/profile row being mounted in the DOM and recovers picturePath for
// newly-added friends whose Redux contact entity is still partial.
const __yokoAggregateContactAvatarMetaCache = new Map();
const __yokoAggregateContactAvatarMetaPending = new Set();
const __yokoAggregateContactAvatarMetaRetryAfter = new Map();
const __yokoAggregateContactAvatarMetaQueue = [];
let __yokoAggregateContactAvatarMetaWorker = false;

function __yokoContactAvatarMetaFromResponse(response, mid) {
  try {
    const payload = response?.contacts
      ? response
      : response?.data?.contacts
        ? response.data
        : response?.result?.contacts
          ? response.result
          : response?.data?.result?.contacts
            ? response.data.result
            : response || {};
    const contacts = payload?.contacts && typeof payload.contacts === 'object' ? payload.contacts : {};
    const wrapped = contacts[mid] || Object.values(contacts).find(item => {
      const contact = __yokoContactEntity(item);
      return String(contact?.mid || '') === String(mid || '');
    });
    const contact = __yokoContactEntity(wrapped);
    const picturePath = String(
      contact.picturePath || contact.pictureUrl || contact.profileImagePath || contact.profileImageUrl || ''
    ).trim();
    return {
      avatarUrl: __yokoAggregatePictureUrl(picturePath),
      displayName: __yokoAggregateText(contact.displayNameOverridden || contact.displayName || contact.name || ''),
      contactType: contact.type ?? null,
      isOfficial: __yokoIsOfficialAggregateContact(contact)
    };
  } catch {
    return { avatarUrl: '', displayName: '', contactType: null, isOfficial: false };
  }
}

async function __yokoDrainAggregateContactAvatarMetaQueue() {
  if (__yokoAggregateContactAvatarMetaWorker || !__yokoAggregateContactAvatarMetaQueue.length) return;

  __yokoAggregateContactAvatarMetaWorker = true;
  const batch = [];
  while (__yokoAggregateContactAvatarMetaQueue.length && batch.length < 40) {
    const mid = String(__yokoAggregateContactAvatarMetaQueue.shift() || '').trim();
    if (mid && !batch.includes(mid)) batch.push(mid);
  }

  try {
    // First ask LINE's own contact Redux action to refresh the exact MIDs. This
    // follows the same internal path LINE uses for its friend list and is more
    // reliable than reading a partially-populated contact entity.
    const store = window._A;
    const fetchContacts = window.LineFetchApi?.contacts?.fetchContacts;
    if (store && typeof store.dispatch === 'function' && typeof fetchContacts === 'function' && batch.length) {
      try {
        await store.dispatch(fetchContacts({
          mids: batch,
          forcibly: true,
          syncReason: 5 // LINE ContactSyncReason.AUTO_REPAIR
        }));
      } catch {}
    }

    const refreshedContacts = __yokoAggregateState()?.contact?.entities?.contacts || {};
    const unresolved = [];
    for (const mid of batch) {
      const contact = __yokoContactEntity(refreshedContacts[mid]);
      const picturePath = String(
        contact.picturePath || contact.pictureUrl || contact.profileImagePath || contact.profileImageUrl || ''
      ).trim();
      const meta = {
        avatarUrl: __yokoAggregatePictureUrl(picturePath),
        displayName: __yokoAggregateText(contact.displayNameOverridden || contact.displayName || contact.name || ''),
        contactType: contact.type ?? null,
        isOfficial: __yokoIsOfficialAggregateContact(contact)
      };
      if (meta.displayName || meta.avatarUrl || meta.contactType !== null || meta.isOfficial === true) {
        __yokoAggregateContactAvatarMetaCache.set(mid, meta);
      }
      if (meta.avatarUrl) {
        __yokoAggregateContactAvatarMetaRetryAfter.delete(mid);
        __yokoQueueAggregateAvatar(meta.avatarUrl);
      } else {
        unresolved.push(mid);
      }
    }

    // Compatibility fallback: use the exported transport directly if the Redux
    // action has not mounted yet or returned a still-partial entity.
    const fn = window.LineFetchApi?.getContactsV2;
    if (unresolved.length && typeof fn === 'function') {
      try {
        const response = await fn(
          {},
          { targetUserMids: unresolved, neededContactCalendarEvents: [] },
          5 // LINE ContactSyncReason.AUTO_REPAIR
        );
        for (const mid of unresolved) {
          const meta = __yokoContactAvatarMetaFromResponse(response, mid);
          if (meta.avatarUrl || meta.displayName || meta.contactType !== null || meta.isOfficial === true) {
            const previous = __yokoAggregateContactAvatarMetaCache.get(mid) || {};
            __yokoAggregateContactAvatarMetaCache.set(mid, {
              avatarUrl: meta.avatarUrl || previous.avatarUrl || '',
              displayName: meta.displayName || previous.displayName || '',
              contactType: meta.contactType ?? previous.contactType ?? null,
              isOfficial: meta.isOfficial === true || previous.isOfficial === true
            });
          }
          if (meta.avatarUrl) {
            __yokoAggregateContactAvatarMetaRetryAfter.delete(mid);
            __yokoQueueAggregateAvatar(meta.avatarUrl);
          } else {
            __yokoAggregateContactAvatarMetaRetryAfter.set(mid, Date.now() + 8000);
          }
        }
      } catch {
        for (const mid of unresolved) __yokoAggregateContactAvatarMetaRetryAfter.set(mid, Date.now() + 8000);
      }
    } else {
      for (const mid of unresolved) __yokoAggregateContactAvatarMetaRetryAfter.set(mid, Date.now() + 8000);
    }

    while (__yokoAggregateContactAvatarMetaCache.size > 600) {
      const oldest = __yokoAggregateContactAvatarMetaCache.keys().next().value;
      if (!oldest) break;
      __yokoAggregateContactAvatarMetaCache.delete(oldest);
    }
  } finally {
    for (const mid of batch) __yokoAggregateContactAvatarMetaPending.delete(mid);
    __yokoAggregateContactAvatarMetaWorker = false;
    __yokoScheduleAggregateSnapshot(100);
    if (__yokoAggregateContactAvatarMetaQueue.length) setTimeout(__yokoDrainAggregateContactAvatarMetaQueue, 60);
  }
}

function __yokoAggregateContactAvatarMeta(mid) {
  const key = String(mid || '').trim();
  if (!key) return { avatarUrl: '', displayName: '', contactType: null, isOfficial: false };
  const cached = __yokoAggregateContactAvatarMetaCache.get(key) || null;
  if (cached?.avatarUrl) return cached;
  const retryAfter = Number(__yokoAggregateContactAvatarMetaRetryAfter.get(key) || 0);
  if (!__yokoAggregateContactAvatarMetaPending.has(key) && (!retryAfter || Date.now() >= retryAfter)) {
    if (__yokoAggregateContactAvatarMetaQueue.length < 480) {
      __yokoAggregateContactAvatarMetaPending.add(key);
      __yokoAggregateContactAvatarMetaQueue.push(key);
      setTimeout(__yokoDrainAggregateContactAvatarMetaQueue, 0);
    }
  }
  return cached || { avatarUrl: '', displayName: '', contactType: null, isOfficial: false };
}

function __yokoAggregateConversationIdentity(chatId, state) {
  const contacts = state?.contact?.entities?.contacts || {};
  const talkChats = state?.talkChat?.entities?.talkChats || {};
  const rooms = state?.room?.entities?.rooms || {};
  const ownMid = String(state?.auth?.profile?.mid || '');
  const normalizedId = String(chatId || '').trim();
  const contact = __yokoContactEntity(contacts[normalizedId]);
  if (Object.keys(contact).length) {
    const apiMeta = __yokoAggregateContactAvatarMeta(normalizedId);
    const avatarUrl = __yokoAggregatePictureUrl(
      contact.picturePath || contact.pictureUrl || contact.profileImagePath || contact.profileImageUrl
    ) || String(apiMeta.avatarUrl || '');
    return {
      displayName: __yokoAggregateText(contact.displayNameOverridden || contact.displayName || contact.name || apiMeta.displayName) || '未命名联系人',
      avatarUrl,
      avatarDataUrl: __yokoAggregateAvatarDataUrl(avatarUrl) || __yokoAggregateDomAvatarDataUrl(normalizedId),
      type: 'contact',
      contactType: contact.type ?? apiMeta.contactType ?? null,
      isOfficial: __yokoIsOfficialAggregateContact(contact) || apiMeta.isOfficial === true
    };
  }

  // V1.23.11 repair: a normal 1:1 LINE user MID starts with "u". During LINE
  // bootstrap/history virtualization its contact entity can be temporarily absent
  // while a talkChat/messageBox row already exists. V1.23.10 classified that
  // transient row as "group" and filtered the real customer out. Preserve a
  // canonical user MID as a contact first; authenticated contact metadata fills
  // name/avatar/type asynchronously and still removes Official Accounts once
  // type=8 becomes known.
  if (/^u/i.test(normalizedId)) {
    const apiMeta = __yokoAggregateContactAvatarMeta(normalizedId);
    const avatarUrl = String(apiMeta.avatarUrl || '');
    return {
      displayName: apiMeta.displayName || `联系人 ${normalizedId.slice(-6)}`,
      avatarUrl,
      avatarDataUrl: __yokoAggregateAvatarDataUrl(avatarUrl) || __yokoAggregateDomAvatarDataUrl(normalizedId),
      type: 'contact',
      contactType: apiMeta.contactType ?? null,
      isOfficial: apiMeta.isOfficial === true
    };
  }

  // Canonical c/r MIDs are group/room conversations and are intentionally
  // excluded from customer-only aggregate mode even if their Redux entities are
  // only partially hydrated.
  if (/^c/i.test(normalizedId)) {
    const talk = talkChats[normalizedId] || {};
    const groupExtra = talk?.extra?.groupExtra || {};
    const memberMids = Object.keys(groupExtra.memberMids || talk.memberMids || {}).filter(mid => mid && mid !== ownMid);
    const memberNames = memberMids
      .map(mid => { const c = __yokoContactEntity(contacts[mid]); return __yokoAggregateText(c.displayNameOverridden || c.displayName || c.name); })
      .filter(Boolean).slice(0, 4);
    const avatarUrl = __yokoAggregatePictureUrl(talk.picturePath || talk.pictureUrl || groupExtra.picturePath || groupExtra.pictureUrl);
    return {
      displayName: __yokoAggregateText(talk.displayName || talk.name || talk.chatName || groupExtra.displayName || groupExtra.name || groupExtra.groupName) || memberNames.join('、') || `群聊 ${normalizedId.slice(-6)}`,
      avatarUrl,
      avatarDataUrl: __yokoAggregateAvatarDataUrl(avatarUrl) || __yokoAggregateDomAvatarDataUrl(normalizedId),
      type: 'group', contactType: null, isOfficial: false
    };
  }
  if (/^r/i.test(normalizedId)) {
    const room = rooms[normalizedId] || {};
    const memberMids = Array.from(room.memberMids || []).filter(mid => mid && mid !== ownMid);
    const memberNames = memberMids
      .map(mid => { const c = __yokoContactEntity(contacts[mid]); return __yokoAggregateText(c.displayNameOverridden || c.displayName || c.name); })
      .filter(Boolean).slice(0, 4);
    return { displayName: memberNames.join('、') || `聊天室 ${normalizedId.slice(-6)}`, avatarUrl: '', avatarDataUrl: '', type: 'room', contactType: null, isOfficial: false };
  }

  const talk = talkChats[normalizedId];
  if (talk) {
    const groupExtra = talk?.extra?.groupExtra || {};
    const memberMids = Object.keys(groupExtra.memberMids || talk.memberMids || {}).filter(mid => mid && mid !== ownMid);
    const memberNames = memberMids
      .map(mid => { const c = __yokoContactEntity(contacts[mid]); return __yokoAggregateText(c.displayNameOverridden || c.displayName || c.name); })
      .filter(Boolean).slice(0, 4);
    const avatarUrl = __yokoAggregatePictureUrl(talk.picturePath || talk.pictureUrl || groupExtra.picturePath || groupExtra.pictureUrl);
    return {
      displayName: __yokoAggregateText(talk.displayName || talk.name || talk.chatName || groupExtra.displayName || groupExtra.name || groupExtra.groupName) || memberNames.join('、') || `群聊 ${normalizedId.slice(-6)}`,
      avatarUrl,
      avatarDataUrl: __yokoAggregateAvatarDataUrl(avatarUrl) || __yokoAggregateDomAvatarDataUrl(normalizedId),
      type: 'group', contactType: null, isOfficial: false
    };
  }

  const room = rooms[normalizedId];
  if (room) {
    const memberMids = Array.from(room.memberMids || []).filter(mid => mid && mid !== ownMid);
    const memberNames = memberMids
      .map(mid => { const c = __yokoContactEntity(contacts[mid]); return __yokoAggregateText(c.displayNameOverridden || c.displayName || c.name); })
      .filter(Boolean).slice(0, 4);
    return { displayName: memberNames.join('、') || `聊天室 ${normalizedId.slice(-6)}`, avatarUrl: '', avatarDataUrl: '', type: 'room', contactType: null, isOfficial: false };
  }

  const apiMeta = __yokoAggregateContactAvatarMeta(normalizedId);
  const apiAvatarUrl = String(apiMeta.avatarUrl || '');
  return {
    displayName: apiMeta.displayName || `聊天 ${normalizedId.slice(-8)}`,
    avatarUrl: apiAvatarUrl,
    avatarDataUrl: __yokoAggregateAvatarDataUrl(apiAvatarUrl) || __yokoAggregateDomAvatarDataUrl(normalizedId),
    type: apiMeta.displayName || apiAvatarUrl ? 'contact' : 'unknown',
    contactType: apiMeta.contactType ?? null,
    isOfficial: apiMeta.isOfficial === true
  };
}

function __yokoAggregateMessagePreview(message) {
  if (!message || typeof message !== 'object') return '';
  const text = __yokoAggregateText(message.text);
  if (text) return text.slice(0, 600);
  const meta = message.contentMetadata || {};
  if (meta.STKPKGID || meta.STKID) return '[贴图]';
  if (meta.FILE_NAME || meta.FILE_SIZE) return `[文件]${meta.FILE_NAME ? ' ' + meta.FILE_NAME : ''}`;
  if (meta.LOCATION_LATITUDE || meta.LOCATION_LONGITUDE) return '[位置]';
  const contentType = String(message.contentType ?? '');
  if (contentType) return '[非文字消息]';
  return '[消息]';
}

function __yokoBuildAggregateSnapshot(limit = 300) {
  const state = __yokoAggregateState();
  if (!state) return { updatedAt: new Date().toISOString(), ready: false, rawCandidateCount: 0, listedCount: 0, contactCount: 0, conversations: [] };

  const boxesState = state?.messageBox || {};
  const boxes = boxesState?.entities?.messageBoxes || {};
  const messages = state?.message?.entities?.messages || {};
  const contacts = state?.contact?.entities?.contacts || {};
  const ownMid = String(state?.auth?.profile?.mid || '');

  // V1.16.0: build a compact read-only message index while LINE's Redux
  // message store is already in memory. This powers global body search and the
  // CRM contact timeline without opening chats or touching Letter Sealing/E2EE.
  const lastIncomingByChat = new Map();
  const lastOutgoingByChat = new Map();
  const firstMessageByChat = new Map();
  const recentSearchByChat = new Map();
  for (const candidate of Object.values(messages)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const from = String(candidate.from || '').trim();
    const to = String(candidate.to || '').trim();
    if (!from) continue;

    let conversationId = '';
    if (from === ownMid) {
      if (to && to !== ownMid && __yokoIsRealChatId(to)) conversationId = to;
    } else if (to && to !== ownMid && __yokoIsRealChatId(to)) {
      // Group/room incoming messages target the conversation MID.
      conversationId = to;
    } else if (__yokoIsRealChatId(from)) {
      // 1:1 incoming messages target our MID, so the sender is the chat MID.
      conversationId = from;
    }
    if (!conversationId) continue;

    const delivered = Number(candidate.deliveredTime || candidate.createdTime || candidate.timestamp || 0) || 0;
    if (!delivered) continue;
    const first = Number(firstMessageByChat.get(conversationId) || 0);
    if (!first || delivered < first) firstMessageByChat.set(conversationId, delivered);
    if (from === ownMid) {
      if (delivered > Number(lastOutgoingByChat.get(conversationId) || 0)) lastOutgoingByChat.set(conversationId, delivered);
    } else if (delivered > Number(lastIncomingByChat.get(conversationId) || 0)) {
      lastIncomingByChat.set(conversationId, delivered);
    }

    const body = __yokoAggregateText(candidate.text);
    if (body) {
      const rows = recentSearchByChat.get(conversationId) || [];
      rows.push({ delivered, text: body.slice(0, 800) });
      // Bound memory even when LINE keeps a very large Redux message window.
      if (rows.length > 48) {
        rows.sort((a, b) => b.delivered - a.delivered);
        rows.length = 32;
      }
      recentSearchByChat.set(conversationId, rows);
    }
  }

  const listed = Array.isArray(boxesState?.list?.data) ? boxesState.list.data.map(String) : [];
  const listedOrder = new Map(listed.map((id, index) => [String(id), index]));
  const ids = [...new Set([...listed, ...Object.keys(boxes).map(String)])];
  const conversations = [];

  for (const chatIdRaw of ids) {
    const chatId = String(chatIdRaw || '').trim();
    if (!__yokoIsRealChatId(chatId) || chatId === ownMid) continue;
    const box = boxes[chatId] && typeof boxes[chatId] === 'object' ? boxes[chatId] : {};
    const lastIds = Array.isArray(box.lastMessages) ? box.lastMessages : [];
    const lastUser = boxesState?.lastUserMessage?.[chatId] || {};
    const lastMessageId = String(lastIds[0] || lastUser.messageId || lastUser.id || '');
    const message = lastMessageId ? messages[lastMessageId] : null;
    const fallbackMessage = message || lastUser?.message || lastUser || null;
    const timestamp = Number(
      message?.deliveredTime || message?.createdTime ||
      lastUser?.deliveredTime || lastUser?.createdTime || lastUser?.timestamp ||
      box?.updatedTime || box?.updatedAt || box?.lastMessageTime || box?.lastDeliveredTime ||
      box?.lastDeliveredMessageId?.deliveredTime || 0
    ) || 0;
    const unreadCount = Math.max(0, Number(box.unreadCount || 0) || 0);
    const identity = __yokoAggregateConversationIdentity(chatId, state);
    // V1.23.10 customer-only aggregate: exclude groups, rooms, unresolved/system
    // rows and LINE Official Accounts. Only real 1:1 personal contacts enter the
    // aggregate customer desk.
    if (identity.type !== 'contact' || identity.isOfficial === true) continue;
    // LINE's QR/login flow can expose a system message box named exactly LINE.
    // It belongs to the extension itself, not the user's customer list.
    if (String(identity.displayName || '').trim().toLowerCase() === 'line') continue;

    // V1.12.3: the aggregate sidebar represents LINE's conversation list, not
    // just unread/message entities currently loaded in memory. If a chat ID is
    // present in messageBox.list.data we keep it even when LINE has already
    // unloaded the last message object from Redux.
    const isListedConversation = listedOrder.has(chatId);
    const hasKnownIdentity = identity.type !== 'unknown';
    if (!isListedConversation && !hasKnownIdentity && !lastMessageId && !unreadCount) continue;

    let preview = __yokoAggregateMessagePreview(fallbackMessage);
    if (!message && (!fallbackMessage || typeof fallbackMessage !== 'object')) preview = '[会话]';
    if (preview === '[消息]' && !lastMessageId) preview = '[会话]';

    conversations.push({
      chatId,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      avatarDataUrl: identity.avatarDataUrl || '',
      type: identity.type,
      contactType: identity.contactType ?? null,
      isOfficial: identity.isOfficial === true,
      preview,
      unreadCount,
      timestamp,
      listOrder: listedOrder.has(chatId) ? listedOrder.get(chatId) : 999999,
      lastMessageId,
      lastDirection: fallbackMessage && String(fallbackMessage.from || '') === ownMid ? 'me' : 'customer',
      lastIncomingAt: Number(lastIncomingByChat.get(chatId) || 0) ||
        (fallbackMessage && String(fallbackMessage.from || '') !== ownMid ? timestamp : 0),
      lastOutgoingAt: Number(lastOutgoingByChat.get(chatId) || 0) ||
        (fallbackMessage && String(fallbackMessage.from || '') === ownMid ? timestamp : 0),
      firstMessageAt: Number(firstMessageByChat.get(chatId) || 0),
      searchText: (recentSearchByChat.get(chatId) || [])
        .sort((a, b) => a.delivered - b.delivered)
        .slice(-24)
        .map(row => row.text)
        .join('\n')
        .slice(0, 4000),
      hasConversation: true,
      source: 'line-store'
    });
  }

  // V1.12.4: the aggregate customer sidebar must also include friends who have
  // never had a message box. LINE keeps the actual friend list in
  // contact.contactList.data. Add those contacts after the conversation rows so
  // clicking them can open /chats/:mid and start a brand-new conversation.
  const knownIds = new Set(conversations.map(item => String(item.chatId || '')));
  const friendIds = Array.isArray(state?.contact?.contactList?.data)
    ? state.contact.contactList.data.map(String)
    : [];
  for (let index = 0; index < friendIds.length; index += 1) {
    const chatId = String(friendIds[index] || '').trim();
    if (!__yokoIsRealChatId(chatId) || chatId === ownMid || knownIds.has(chatId)) continue;
    const contact = __yokoContactEntity(contacts[chatId]);
    if (!contact || typeof contact !== 'object' || !Object.keys(contact).length) continue;
    const identity = __yokoAggregateConversationIdentity(chatId, state);
    if (identity.type !== 'contact' || identity.isOfficial === true) continue;
    if (String(identity.displayName || '').trim().toLowerCase() === 'line') continue;
    conversations.push({
      chatId,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      avatarDataUrl: identity.avatarDataUrl || '',
      type: 'contact',
      contactType: identity.contactType ?? null,
      isOfficial: false,
      preview: '[未开始聊天，可直接发消息]',
      unreadCount: 0,
      timestamp: 0,
      listOrder: 1000000 + index,
      lastMessageId: '',
      lastDirection: 'customer',
      lastIncomingAt: 0,
      lastOutgoingAt: 0,
      firstMessageAt: 0,
      searchText: '',
      hasConversation: false,
      source: 'line-contact'
    });
    knownIds.add(chatId);
  }

  conversations.sort((a, b) => {
    if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
    if (a.listOrder !== b.listOrder) return a.listOrder - b.listOrder;
    return b.unreadCount - a.unreadCount;
  });
  return {
    updatedAt: new Date().toISOString(),
    ready: true,
    ownMid,
    // V1.23.12 diagnostics let the main process distinguish a genuinely empty
    // account from a transiently unhydrated Redux snapshot without scraping UI.
    rawCandidateCount: ids.length + friendIds.length,
    listedCount: listed.length,
    contactCount: friendIds.length,
    conversations: conversations.slice(0, Math.max(20, Math.min(500, Number(limit) || 300)))
  };
}

let __yokoAggregatePublishTimer = null;
let __yokoAggregateLastSignature = '';
function __yokoPublishAggregateSnapshot(force = false) {
  try {
    const payload = __yokoBuildAggregateSnapshot(300);
    if (!payload.ready) return false;
    const signature = JSON.stringify(payload.conversations.map(item => [
      item.chatId, item.lastMessageId, item.unreadCount, item.timestamp, item.lastIncomingAt || 0,
      item.lastOutgoingAt || 0, item.type || '', item.contactType ?? '', item.isOfficial === true ? 1 : 0,
      item.displayName, item.avatarDataUrl || ''
    ]));
    if (!force && signature === __yokoAggregateLastSignature) return false;
    __yokoAggregateLastSignature = signature;
    ipcRenderer.send('line-aggregate-snapshot', payload);
    return true;
  } catch {
    return false;
  }
}

function __yokoScheduleAggregateSnapshot(delay = 350) {
  if (__yokoAggregatePublishTimer) clearTimeout(__yokoAggregatePublishTimer);
  __yokoAggregatePublishTimer = setTimeout(() => {
    __yokoAggregatePublishTimer = null;
    __yokoPublishAggregateSnapshot(false);
  }, Math.max(60, Number(delay) || 350));
}

try {
  const previousAfter = typeof window.LineHook?.after === 'function' ? window.LineHook.after : null;
  window.LineHook = window.LineHook || {};
  window.LineHook.after = action => {
    try { previousAfter?.(action); } catch {}
    const type = String(action?.type || '');
    if (!type || /message|messageBox|contact|talkChat|room|auth\//i.test(type)) {
      __yokoScheduleAggregateSnapshot(260);
    }
  };
} catch {}

// V1.15.22 adaptive aggregate heartbeat + disposable cache hygiene.
// Redux action hooks still publish message/contact changes immediately. This
// fallback heartbeat runs fast only for the visible/aggregate renderer and backs
// off for hidden accounts, reducing idle CPU on large multi-LINE installations.
let __yokoAggregateHeartbeatTimer = null;
function __yokoTrimOldestMap(map, maxSize) {
  while (map && map.size > maxSize) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
function __yokoCleanupDisposableCaches() {
  const now = Date.now();
  for (const [key, value] of __yokoAggregatePrewarmCache.entries()) {
    if (!value || now - Number(value.warmedAt || 0) > __yokoAggregatePrewarmTtlMs) {
      __yokoAggregatePrewarmCache.delete(key);
    }
  }
  for (const [key, until] of __yokoAggregateAvatarRetryAfter.entries()) {
    if (now >= Number(until || 0)) __yokoAggregateAvatarRetryAfter.delete(key);
  }
  for (const [key, until] of __yokoAggregateContactAvatarMetaRetryAfter.entries()) {
    if (now >= Number(until || 0)) __yokoAggregateContactAvatarMetaRetryAfter.delete(key);
  }
  __yokoTrimOldestMap(__yokoAggregateAvatarDataCache, 240);
  __yokoTrimOldestMap(__yokoAggregateDomAvatarCache, 320);
  __yokoTrimOldestMap(__yokoAggregateContactAvatarMetaCache, 520);
}
function __yokoScheduleAggregateHeartbeat(delay = 0) {
  if (__yokoAggregateHeartbeatTimer) clearTimeout(__yokoAggregateHeartbeatTimer);
  const base = __yokoForegroundMode || __yokoAggregateFocusEnabled ? 4500 : 14000;
  __yokoAggregateHeartbeatTimer = setTimeout(() => {
    __yokoAggregateHeartbeatTimer = null;
    __yokoPublishAggregateSnapshot(false);
    __yokoCleanupDisposableCaches();
    __yokoScheduleAggregateHeartbeat();
  }, Math.max(500, Number(delay || 0) || base));
}
__yokoScheduleAggregateHeartbeat(2200);
window.addEventListener('load', () => {
  setTimeout(() => __yokoPublishAggregateSnapshot(true), 520);
  setTimeout(() => __yokoPublishAggregateSnapshot(true), 1500);
}, { once: true });

function __yokoConversationRowsForMid(chatId) {
  const id = String(chatId || '');
  if (!id) return [];
  const nodes = Array.from(document.querySelectorAll('[data-mid],[data-chat-mid],[data-chat-id],[data-message-box-id]'));
  return nodes.filter(node => {
    for (const attr of ['data-mid', 'data-chat-mid', 'data-chat-id', 'data-message-box-id']) {
      if (String(node.getAttribute?.(attr) || '') === id) return true;
    }
    return false;
  });
}

function __yokoDispatchConversationClick(target) {
  if (!target) return false;
  try {
    target.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    // Use the native click method for the final event. React's delegated
    // onClick handler receives this reliably even when the row is visually
    // hidden by aggregate focus mode.
    if (typeof target.click === 'function') target.click();
    else target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  } catch {
    return false;
  }
}

function __yokoClickConversationRow(chatId) {
  const matches = __yokoConversationRowsForMid(chatId);

  // V1.14.6: LINE's friend/chat list puts data-mid on the row but the actual
  // navigation handler is an overlay CHILD button with aria-label="Go chatroom".
  // Clicking the row container itself often opens only the contact profile,
  // which forced the user to click the green Chat button and then the Yoko card
  // a second time. Always prefer LINE's real chatroom button first.
  for (const node of matches) {
    const direct = node.matches?.('button[aria-label="Go chatroom"],a[aria-label="Go chatroom"]')
      ? node
      : node.querySelector?.('button[aria-label="Go chatroom"],a[aria-label="Go chatroom"]');
    if (direct && __yokoDispatchConversationClick(direct)) return true;
  }

  for (const node of matches) {
    let target = node.closest?.('li,[role="listitem"],[role="button"],button,a') || null;
    if (!target) {
      let current = node;
      for (let depth = 0; depth < 7 && current; depth += 1, current = current.parentElement) {
        try {
          const rect = current.getBoundingClientRect();
          if (rect.width >= 180 && rect.height >= 38 && rect.height <= 150) {
            target = current;
            break;
          }
        } catch {}
      }
    }
    if (!target) target = node;
    if (__yokoDispatchConversationClick(target)) return true;
  }
  return false;
}

function __yokoProfileModalVisible() {
  try {
    const modal = document.querySelector(
      '[class*="profileModal-module__modal__"], [class*="profileModal-module__content__"]'
    );
    if (!modal) return false;
    const rect = modal.getBoundingClientRect?.();
    return !rect || (rect.width > 0 && rect.height > 0);
  } catch {
    return false;
  }
}

function __yokoProfileRowMidSet(root) {
  const mids = new Set();
  if (!(root instanceof Element)) return mids;
  const attrs = ['data-mid', 'data-chat-mid', 'data-chat-id', 'data-message-box-id'];
  const collect = node => {
    if (!(node instanceof Element)) return;
    for (const attr of attrs) {
      const value = String(node.getAttribute?.(attr) || '').trim();
      if (value) mids.add(value);
    }
  };
  collect(root);
  try {
    root.querySelectorAll?.('[data-mid],[data-chat-mid],[data-chat-id],[data-message-box-id]')
      ?.forEach(collect);
  } catch {}
  return mids;
}

function __yokoExactProfileRow(node, chatId) {
  const id = String(chatId || '').trim();
  if (!id || !(node instanceof Element)) return null;

  // Prefer the nearest actual LINE list row. The previous implementation walked
  // several broad ancestors and then collected every avatar below them; on a
  // contact list that could include avatars belonging to many different people.
  // Opening a profile therefore dispatched multiple unrelated clicks/popups.
  const directRow = node.closest?.('li,[role="listitem"]');
  if (directRow) {
    const mids = __yokoProfileRowMidSet(directRow);
    if (mids.size === 1 && mids.has(id)) return directRow;
  }

  // Some LINE 3.7.2 builds use div/button rows rather than LI. Only accept a
  // compact ancestor whose MID set contains exactly this one customer.
  let current = node;
  for (let depth = 0; depth < 6 && current; depth += 1, current = current.parentElement) {
    try {
      const rect = current.getBoundingClientRect?.();
      const mids = __yokoProfileRowMidSet(current);
      if (
        mids.size === 1 && mids.has(id) && rect &&
        rect.width >= 120 && rect.height >= 28 && rect.height <= 180
      ) {
        return current;
      }
    } catch {}
  }
  return null;
}

function __yokoProfileClickCandidates(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return [];
  const matches = __yokoConversationRowsForMid(id);
  const candidates = [];
  const seen = new Set();
  const profileSelector = '[data-profile-image], [class*="profileImage-module__button_profile__"], [class*="profileImage-module__thumbnail__"]';

  const add = (node, priority = 50) => {
    if (!(node instanceof Element) || seen.has(node)) return;
    try {
      if (node.matches?.('[aria-label="Go chatroom"]') || node.closest?.('[aria-label="Go chatroom"]')) return;
    } catch {}
    seen.add(node);
    candidates.push({ node, priority });
  };

  for (const match of matches) {
    const row = __yokoExactProfileRow(match, id);
    if (!row) continue;

    // The exact MID element itself can be the avatar/profile control.
    try {
      if (match.matches?.(profileSelector)) add(match, 0);
    } catch {}

    // Only inspect the exact customer's own row. Never search a shared parent
    // containing sibling contacts.
    try {
      row.querySelectorAll?.(profileSelector)?.forEach(node => add(node, 10));
    } catch {}

    // Last-resort compatibility fallback: LINE builds where clicking the exact
    // contact row opens the profile. Since the row is MID-validated above, this
    // still cannot target a neighboring customer.
    add(row, 90);
  }

  candidates.sort((a, b) => a.priority - b.priority);
  return candidates.map(item => item.node);
}

async function __yokoOpenProfileCard(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return { ok: false, error: '缺少客户 MID。' };

  // V1.14.10: Prefer LINE's own React profile opener exported from the bundled
  // 3.7.2 build. DOM clicking was inherently brittle in aggregate mode because
  // the native friend/chat list is visually hidden/virtualized. It could either
  // hit a neighboring row or find no clickable avatar at all. The native opener
  // accepts the exact MID and routes to the same WJ profile modal LINE itself uses.
  try {
    const nativeOpen = window.LineFetchApi?.openProfileCardByMid;
    if (typeof nativeOpen === 'function') {
      if (__yokoProfileModalVisible()) {
        try {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
          await new Promise(resolve => setTimeout(resolve, 120));
        } catch {}
      }

      nativeOpen(id);
      for (const wait of [80, 140, 220, 360]) {
        await new Promise(resolve => setTimeout(resolve, wait));
        if (__yokoProfileModalVisible()) {
          return { ok: true, method: 'native-react-profile-by-mid', exactMid: id };
        }
      }

      // Some LINE builds render the profile in another window. The React opener
      // has already been invoked with the exact MID, so never fall through to a
      // second customer's DOM avatar merely because the popup lives elsewhere.
      return { ok: true, method: 'native-react-profile-dispatched', exactMid: id };
    }
  } catch (error) {
    console.warn('[Yoko] native profile opener failed', error);
  }

  // Compatibility fallback for builds where the native bridge has not mounted
  // yet. Only the exact MID's own row is eligible, and exactly one click is sent.
  let candidates = __yokoProfileClickCandidates(id);
  if (!candidates.length) {
    try { __yokoPublishAggregateSnapshot(true); } catch {}
    await new Promise(resolve => setTimeout(resolve, 260));
    candidates = __yokoProfileClickCandidates(id);
  }

  const target = candidates[0];
  if (!target) {
    return {
      ok: false,
      error: 'LINE 个人名片组件还没有准备好，请等待 1～2 秒后再试。'
    };
  }

  if (!__yokoDispatchConversationClick(target)) {
    return { ok: false, error: 'LINE 个人名片点击失败，请稍后重试。' };
  }
  return { ok: true, method: 'exact-mid-dom-fallback', exactMid: id, dispatchedOnce: true };
}

function __yokoComparableChatName(value) {
  return normalizeText(value || '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, '')
    .toLocaleLowerCase();
}

function __yokoChatNamesMatch(a, b) {
  const left = __yokoComparableChatName(a);
  const right = __yokoComparableChatName(b);
  if (!left || !right) return false;
  return left === right;
}

function __yokoShowAggregateSwitchOverlay(name = '') {
  try {
    if (!__yokoAggregateSwitchOverlay || !__yokoAggregateSwitchOverlay.isConnected) {
      const overlay = document.createElement('div');
      overlay.id = '__yoko_chat_switch_overlay';
      Object.assign(overlay.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '2147483000',
        background: '#ffffff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, sans-serif',
        color: '#637083',
        fontSize: '14px',
        pointerEvents: 'auto'
      });
      document.documentElement.appendChild(overlay);
      __yokoAggregateSwitchOverlay = overlay;
    }
    __yokoAggregateSwitchOverlay.textContent = name ? `正在打开 ${name}…` : '正在切换聊天…';
  } catch {}
}

function __yokoHideAggregateSwitchOverlay() {
  try {
    __yokoAggregateSwitchOverlay?.remove?.();
  } catch {}
  __yokoAggregateSwitchOverlay = null;
}

function __yokoAggregateRoomVisualSignature(room = null) {
  try {
    const target = room || __yokoFindActiveAggregateChatroom();
    if (!(target instanceof Element)) return '';
    const text = normalizeText(target.innerText || target.textContent || '');
    // Header + tail of recent messages is enough to detect that React replaced
    // the previous customer's visible room without hashing a huge DOM tree.
    return `${text.slice(0, 220)}\u001f${text.slice(-700)}`;
  } catch {
    return '';
  }
}

function __yokoAggregateRoomHasTargetMarker(room, chatId) {
  if (!(room instanceof Element) || !chatId) return false;
  const id = String(chatId);
  try {
    const escaped = (globalThis.CSS?.escape ? CSS.escape(id) : id.replace(/[\"\\]/g, '\\$&'));
    const selectors = [
      `[data-mid="${escaped}"]`,
      `[data-chat-id="${escaped}"]`,
      `[data-chatid="${escaped}"]`,
      `[href*="/chats/${escaped}"]`
    ];
    return selectors.some(selector => {
      try { return !!room.querySelector(selector); } catch { return false; }
    });
  } catch {
    return false;
  }
}

function __yokoPrewarmConversation(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return { ok: false, error: '缺少聊天ID' };
  const startedAt = Date.now();
  let expectedName = '';
  try {
    const state = __yokoAggregateState();
    const identity = __yokoAggregateConversationIdentity(id, state);
    expectedName = normalizeText(identity?.displayName || '');

    // Touch the exact entities LINE will read on navigation so their proxies /
    // selector paths are hot in V8. This is deliberately read-only.
    void state?.messageBox?.entities?.messageBoxes?.[id];
    void state?.contact?.entities?.contacts?.[id];

    // If the selected contact is missing a resolved avatar/profile entry, queue
    // that authenticated lookup before the operator clicks. It runs in the
    // background and is not part of the navigation critical path.
    try { __yokoAggregateContactAvatarMeta(id); } catch {}
  } catch {}

  const entry = {
    expectedName,
    targetHash: `#/chats/${encodeURIComponent(id)}`,
    warmedAt: Date.now()
  };
  __yokoAggregatePrewarmCache.set(id, entry);
  if (__yokoAggregatePrewarmCache.size > 48) {
    const oldest = [...__yokoAggregatePrewarmCache.entries()]
      .sort((a, b) => Number(a[1]?.warmedAt || 0) - Number(b[1]?.warmedAt || 0))
      .slice(0, __yokoAggregatePrewarmCache.size - 48);
    for (const [key] of oldest) __yokoAggregatePrewarmCache.delete(key);
  }

  // Aggregate layout can be repaired while this renderer is still off-screen.
  // Do not perform it in LINE mode and never navigate during prewarm.
  if (__yokoAggregateFocusEnabled && !__yokoAggregateSwitchingChatId) {
    try { __yokoApplyAggregateFocusLayout(); } catch {}
  }
  return { ok: true, chatId: id, expectedName, latencyMs: Date.now() - startedAt };
}

async function __yokoOpenConversation(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return { ok: false, error: '缺少聊天ID' };

  __yokoSaveCurrentAggregateDraft();
  __yokoAggregateVerifiedChatId = '';
  __yokoAggregateSendGuardUntil = Date.now() + 320;
  const switchSeq = ++__yokoAggregateSwitchSeq;
  const startedAt = Date.now();
  const warmed = __yokoAggregatePrewarmCache.get(id);
  const warmFresh = warmed && (Date.now() - Number(warmed.warmedAt || 0) <= __yokoAggregatePrewarmTtlMs);
  let expectedName = warmFresh ? normalizeText(warmed.expectedName || '') : '';
  if (!expectedName) {
    try {
      const state = __yokoAggregateState();
      expectedName = normalizeText(__yokoAggregateConversationIdentity(id, state)?.displayName || '');
    } catch {}
  }

  const currentDecodedHash = () => {
    try { return decodeURIComponent(String(location.hash || '')); } catch { return String(location.hash || ''); }
  };
  const initialHash = currentDecodedHash();
  const initialRoom = __yokoFindActiveAggregateChatroom();
  const initialSignature = __yokoAggregateRoomVisualSignature(initialRoom);
  const targetHash = warmFresh && String(warmed.targetHash || '').trim()
    ? String(warmed.targetHash)
    : `#/chats/${encodeURIComponent(id)}`;
  __yokoAggregatePrewarmCache.delete(id);

  const isTargetRoute = () => {
    try {
      const current = decodeURIComponent(String(location.hash || ''));
      return current === `#/chats/${id}` || current.endsWith(`/chats/${id}`);
    } catch {
      return false;
    }
  };
  const activeRoom = () => __yokoFindActiveAggregateChatroom();
  const hasComposer = () => {
    const room = activeRoom();
    return !!(room?.querySelector?.('textarea,[contenteditable="true"],[role="textbox"]') || document.querySelector(
      '[class*="chatroom-module__chatroom__"] textarea, [class*="chatroom-module__chatroom__"] [contenteditable="true"], [class*="chatroom-module__chatroom__"] [role="textbox"]'
    ));
  };
  const visibleName = () => normalizeText(yokoCurrentChatNameCandidate()?.text || '');
  const roomChangedFromPrevious = () => {
    const room = activeRoom();
    if (!room) return false;
    if (initialRoom && room !== initialRoom) return true;
    const signature = __yokoAggregateRoomVisualSignature(room);
    return !!(signature && initialSignature && signature !== initialSignature);
  };

  // V1.15.17: visual reveal no longer waits for LINE's composer to mount.
  // Exact MID route + replacement of the previous React room is already strong
  // evidence that the selected customer is on screen. Waiting for the input box
  // caused healthy chats to remain behind the white overlay for 6-8 seconds on
  // low-spec PCs even though the messages were already visible underneath.
  const visuallyMatchesTarget = () => {
    if (!isTargetRoute()) return false;
    const room = activeRoom();
    if (!room) return false;
    if (expectedName && __yokoChatNamesMatch(visibleName(), expectedName)) return true;
    if (__yokoAggregateRoomHasTargetMarker(room, id)) return true;
    if (initialHash !== currentDecodedHash() && roomChangedFromPrevious()) return true;
    // If this exact route was already active, a matching visible title or a
    // mounted composer is enough to treat it as already-open.
    if (initialHash === currentDecodedHash() && hasComposer()) return true;
    return !expectedName && roomChangedFromPrevious();
  };

  const waitUntilVisual = async budgetMs => {
    const deadline = Date.now() + Math.max(60, Number(budgetMs) || 260);
    let delay = 22;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, delay));
      if (switchSeq !== __yokoAggregateSwitchSeq) return false;
      if (visuallyMatchesTarget()) return true;
      delay = Math.min(58, delay + 6);
    }
    return false;
  };

  const navigateDirect = () => {
    try {
      const currentDecoded = decodeURIComponent(String(location.hash || ''));
      const targetDecoded = decodeURIComponent(targetHash);
      if (currentDecoded !== targetDecoded) location.hash = targetHash;
      else window.dispatchEvent(new HashChangeEvent('hashchange'));
      return true;
    } catch {
      try { location.hash = targetHash; return true; } catch { return false; }
    }
  };

  const dispatchNative = () => {
    try {
      const nativeOpen = window.LineFetchApi?.openChatByMid;
      if (typeof nativeOpen !== 'function') return false;
      Promise.resolve(nativeOpen(id)).catch(() => {});
      return true;
    } catch {
      return false;
    }
  };

  if (visuallyMatchesTarget()) {
    __yokoAggregateSwitchingChatId = '';
    __yokoAggregateVerifiedChatId = id;
    __yokoAggregateSendGuardUntil = Date.now() + 90;
    __yokoRestoreAggregateDraftWhenReady(id, switchSeq);
    __yokoHideAggregateSwitchOverlay();
    if (__yokoAggregateFocusEnabled) __yokoApplyAggregateFocusLayout();
    return {
      ok: true,
      method: 'already-open',
      ready: true,
      visualReady: true,
      interactiveReady: hasComposer(),
      expectedName,
      visibleName: visibleName(),
      latencyMs: Date.now() - startedAt
    };
  }

  __yokoAggregateSwitchingChatId = id;
  // V1.15.17: keep the current aggregate isolation marks during the first fast
  // route attempt. LINE usually reuses the same chatroom element and only swaps
  // its contents; tearing the layout down on every click forced an unnecessary
  // full reflow. If React mounts a sibling room instead, we clear the marks after
  // the first short attempt and continue with the compatibility path.
  __yokoShowAggregateSwitchOverlay(expectedName);
  try { document.activeElement?.blur?.(); } catch {}

  let keepPendingGuard = false;
  const finishReady = (method = 'guard-ready') => {
    if (switchSeq !== __yokoAggregateSwitchSeq) return false;
    __yokoAggregateSwitchingChatId = '';
    __yokoAggregateVerifiedChatId = id;
    __yokoAggregateSendGuardUntil = Date.now() + 140;
    __yokoRestoreAggregateDraftWhenReady(id, switchSeq);
    __yokoHideAggregateSwitchOverlay();
    if (__yokoAggregateFocusEnabled) {
      __yokoApplyAggregateFocusLayout();
      // One quick correction after React finishes its current paint. These are
      // background-only and never delay the customer becoming visible.
      setTimeout(() => {
        if (switchSeq === __yokoAggregateSwitchSeq && __yokoAggregateFocusEnabled) __yokoApplyAggregateFocusLayout();
      }, 70);
      setTimeout(() => {
        if (switchSeq === __yokoAggregateSwitchSeq && __yokoAggregateFocusEnabled) __yokoApplyAggregateFocusLayout();
      }, 180);
    }
    try {
      ipcRenderer.send('line-aggregate-chat-ready', {
        chatId: id,
        displayName: expectedName,
        method,
        interactiveReady: hasComposer(),
        latencyMs: Date.now() - startedAt
      });
    } catch {}
    return true;
  };

  const armPendingGuard = () => {
    keepPendingGuard = true;
    const guardStartedAt = Date.now();
    const deadline = guardStartedAt + 5000;
    let nudge1 = false;
    let nudge2 = false;
    let nudge3 = false;

    const poll = () => {
      if (switchSeq !== __yokoAggregateSwitchSeq) return;
      if (!__yokoAggregateFocusEnabled) {
        __yokoAggregateSwitchingChatId = '';
        __yokoHideAggregateSwitchOverlay();
        return;
      }
      if (visuallyMatchesTarget()) {
        finishReady('progressive-visual-ready');
        return;
      }

      const elapsed = Date.now() - guardStartedAt;
      if (!nudge1 && elapsed >= 420) {
        nudge1 = true;
        try {
          if (__yokoAggregateSwitchOverlay?.isConnected) {
            __yokoAggregateSwitchOverlay.textContent = expectedName
              ? `正在加载 ${expectedName}…`
              : '正在加载聊天…';
          }
        } catch {}
        // Direct exact-MID hash is the cheapest retry and does not depend on
        // virtualized rows being mounted.
        if (!isTargetRoute()) navigateDirect();
        dispatchNative();
      }
      if (!nudge2 && elapsed >= 1150) {
        nudge2 = true;
        try {
          if (__yokoAggregateSwitchOverlay?.isConnected) {
            __yokoAggregateSwitchOverlay.textContent = expectedName
              ? `${expectedName} 加载较慢，正在快速重试…`
              : '聊天加载较慢，正在快速重试…';
          }
        } catch {}
        navigateDirect();
        setTimeout(() => {
          if (switchSeq === __yokoAggregateSwitchSeq) dispatchNative();
        }, 25);
      }
      if (!nudge3 && elapsed >= 2450) {
        nudge3 = true;
        try {
          if (__yokoAggregateSwitchOverlay?.isConnected) {
            __yokoAggregateSwitchOverlay.textContent = expectedName
              ? `正在重新确认 ${expectedName}…`
              : '正在重新确认聊天…';
          }
        } catch {}
        // Final compatibility fallback: exact MID row only. It is never used on
        // the normal fast path, so virtualized-list scanning cannot slow every click.
        try { __yokoClickConversationRow(id); } catch {}
        setTimeout(() => {
          if (switchSeq === __yokoAggregateSwitchSeq) navigateDirect();
        }, 40);
      }

      if (Date.now() >= deadline) {
        __yokoAggregateSwitchingChatId = '';
        __yokoAggregateVerifiedChatId = '';
        __yokoAggregateSendGuardUntil = Date.now() + 250;
        __yokoHideAggregateSwitchOverlay();
        if (__yokoAggregateFocusEnabled) __yokoApplyAggregateFocusLayout();
        try {
          ipcRenderer.send('line-aggregate-chat-failed', {
            chatId: id,
            displayName: expectedName,
            latencyMs: Date.now() - startedAt,
            error: expectedName
              ? `打开「${expectedName}」超时，已停止等待，可直接再点一次重试。`
              : '聊天加载超时，已停止等待，可直接再点一次重试。'
          });
        } catch {}
        return;
      }
      setTimeout(poll, 58);
    };
    setTimeout(poll, 45);
  };

  try {
    // V1.15.17 fast route: commit the exact MID hash immediately and dispatch
    // LINE's own React opener in the same turn. The previous version waited
    // between the two operations and then spent up to 1.38 s in foreground
    // verification before even entering the background guard.
    navigateDirect();
    dispatchNative();

    if (await waitUntilVisual(180)) {
      finishReady('fast-progressive-ready');
      return {
        ok: true,
        method: 'fast-progressive-ready',
        ready: true,
        visualReady: true,
        interactiveReady: hasComposer(),
        expectedName,
        visibleName: visibleName(),
        latencyMs: Date.now() - startedAt
      };
    }

    if (switchSeq !== __yokoAggregateSwitchSeq) {
      return { ok: false, canceled: true, latencyMs: Date.now() - startedAt };
    }

    // The normal in-place React swap did not become visible immediately. Remove
    // old isolation marks once so a newly mounted sibling chatroom cannot be
    // hidden by the previous customer's aggregate layout, then give it one very
    // short paint window.
    __yokoClearAggregateFocusMarks();
    if (await waitUntilVisual(170)) {
      finishReady('fast-remount-ready');
      return {
        ok: true,
        method: 'fast-remount-ready',
        ready: true,
        visualReady: true,
        interactiveReady: hasComposer(),
        expectedName,
        visibleName: visibleName(),
        latencyMs: Date.now() - startedAt
      };
    }

    if (switchSeq !== __yokoAggregateSwitchSeq) {
      return { ok: false, canceled: true, latencyMs: Date.now() - startedAt };
    }

    // If LINE accepted the exact route but React has not painted enough DOM yet,
    // return to the SCRM UI immediately. The preload keeps the safety guard and
    // overlay locally and removes it as soon as the new room starts rendering.
    if (isTargetRoute()) {
      armPendingGuard();
      return {
        ok: true,
        pending: true,
        ready: false,
        visualReady: false,
        routeMatched: true,
        method: 'exact-route-progressive-pending',
        expectedName,
        visibleName: visibleName(),
        latencyMs: Date.now() - startedAt
      };
    }

    // Route was not accepted during the first 300 ms. Give the exact MID row one
    // short compatibility nudge instead of the old additional 760 ms wait loop.
    try { __yokoClickConversationRow(id); } catch {}
    navigateDirect();
    dispatchNative();

    if (await waitUntilVisual(260)) {
      finishReady('quick-nudge-ready');
      return {
        ok: true,
        method: 'quick-nudge-ready',
        ready: true,
        visualReady: true,
        interactiveReady: hasComposer(),
        expectedName,
        visibleName: visibleName(),
        latencyMs: Date.now() - startedAt
      };
    }

    if (isTargetRoute()) {
      armPendingGuard();
      return {
        ok: true,
        pending: true,
        ready: false,
        visualReady: false,
        routeMatched: true,
        method: 'nudge-progressive-pending',
        expectedName,
        visibleName: visibleName(),
        latencyMs: Date.now() - startedAt
      };
    }

    return {
      ok: false,
      ready: false,
      visualReady: false,
      routeMatched: false,
      expectedName,
      visibleName: visibleName(),
      latencyMs: Date.now() - startedAt,
      error: expectedName
        ? `LINE 没有接受切换到「${expectedName}」，请再点一次。`
        : 'LINE 没有接受所选客户的聊天切换，请再点一次。'
    };
  } finally {
    if (!keepPendingGuard && switchSeq === __yokoAggregateSwitchSeq) {
      __yokoAggregateSwitchingChatId = '';
      __yokoHideAggregateSwitchOverlay();
      if (__yokoAggregateFocusEnabled) {
        __yokoApplyAggregateFocusLayout();
        setTimeout(() => {
          if (switchSeq === __yokoAggregateSwitchSeq && __yokoAggregateFocusEnabled) __yokoApplyAggregateFocusLayout();
        }, 80);
      }
    }
  }
}

function __yokoEnsureAggregateFocusStyle() {
  const styleId = '__yoko_aggregate_focus_style';
  let style = document.getElementById(styleId);
  if (style) return style;
  style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    html[data-yoko-aggregate-focus="1"] [data-yoko-aggregate-hidden="1"] {
      display: none !important;
    }
    html[data-yoko-aggregate-focus="1"] [data-yoko-aggregate-layout="1"] {
      position: relative !important;
      display: block !important;
      grid-template: none !important;
      width: 100% !important;
      height: 100% !important;
      min-width: 0 !important;
      max-width: none !important;
      overflow: hidden !important;
    }
    html[data-yoko-aggregate-focus="1"] [data-yoko-aggregate-room="1"] {
      position: absolute !important;
      inset: 0 !important;
      display: flex !important;
      width: 100% !important;
      height: 100% !important;
      min-width: 0 !important;
      max-width: none !important;
      margin: 0 !important;
      border-left: 0 !important;
      transform: none !important;
      overflow: hidden !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
  return style;
}

function __yokoClearAggregateFocusMarks() {
  try {
    document.querySelectorAll('[data-yoko-aggregate-hidden="1"]').forEach(el => el.removeAttribute('data-yoko-aggregate-hidden'));
    document.querySelectorAll('[data-yoko-aggregate-layout="1"]').forEach(el => el.removeAttribute('data-yoko-aggregate-layout'));
    document.querySelectorAll('[data-yoko-aggregate-room="1"]').forEach(el => el.removeAttribute('data-yoko-aggregate-room'));
  } catch {}
}

function __yokoElementActuallyVisible(el) {
  if (!(el instanceof Element) || !el.isConnected) return false;
  try {
    const style = getComputedStyle(el);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 220 && rect.height >= 220 && rect.bottom > 0 && rect.right > 0;
  } catch {
    return false;
  }
}

function __yokoFindActiveAggregateChatroom() {
  const rooms = Array.from(document.querySelectorAll('[class*="chatroom-module__chatroom__"]'));
  if (!rooms.length) return null;

  // LINE can keep an old chatroom mounted for route transitions/history cache.
  // Aggregate focus previously picked document.querySelector(...), i.e. the
  // first room, and a later DOM mutation could therefore isolate a stale room
  // and hide the real current conversation. Score only visible/current rooms.
  let best = null;
  let bestScore = -Infinity;
  for (const room of rooms) {
    if (!__yokoElementActuallyVisible(room)) continue;
    try {
      const rect = room.getBoundingClientRect();
      const hasComposer = !!room.querySelector(
        'textarea,[contenteditable="true"],[role="textbox"]'
      );
      const hasMessageSurface = !!room.querySelector(
        '[class*="message"],[class*="chat"],[data-mid],[data-message-id]'
      );
      let score = Math.min(rect.width * rect.height, 2_000_000) / 10_000;
      if (hasComposer) score += 1000;
      if (hasMessageSurface) score += 80;
      // Prefer a room that occupies the useful center/right workspace.
      if (rect.left < window.innerWidth && rect.right > window.innerWidth * 0.35) score += 40;
      if (score > bestScore) {
        best = room;
        bestScore = score;
      }
    } catch {}
  }

  // During a short React transition dimensions can momentarily be zero. Keep
  // the currently isolated room instead of clearing/hiding everything.
  if (!best) {
    const marked = document.querySelector('[data-yoko-aggregate-room="1"]');
    if (marked?.isConnected) return marked;
  }
  return best;
}

function __yokoApplyAggregateFocusLayout() {
  if (!__yokoAggregateFocusEnabled || __yokoAggregateSwitchingChatId) return false;
  // LINE closes message action popovers on resize. Never reflow the aggregate
  // layout while reply/copy/share/unsend is open.
  if (__yokoLineTransientUiActive()) return true;
  __yokoEnsureAggregateFocusStyle();

  const room = __yokoFindActiveAggregateChatroom();
  if (!room) return false;
  const layout = room.closest?.('[class*="pageLayout-module__wrap__"]');
  if (!layout) return false;

  // Important: validate the new active room BEFORE removing existing marks.
  // This avoids the V1.15.2 blank-chat race where a transient/hidden chatroom
  // was selected after a translation/message DOM update.
  __yokoClearAggregateFocusMarks();
  layout.setAttribute('data-yoko-aggregate-layout', '1');
  room.setAttribute('data-yoko-aggregate-room', '1');

  // Hide all top-level LINE panels except the branch containing the *active*
  // chatroom. The native conversation list remains mounted, merely invisible.
  for (const child of Array.from(layout.children || [])) {
    if (child === room || child.contains?.(room)) continue;
    child.setAttribute('data-yoko-aggregate-hidden', '1');
  }

  // If chatroom is wrapped one level deeper, hide only sibling panels on the
  // exact branch to the selected room.
  let branch = room;
  while (branch?.parentElement && branch.parentElement !== layout) {
    const parent = branch.parentElement;
    for (const sibling of Array.from(parent.children || [])) {
      if (sibling === branch || sibling.contains?.(room)) continue;
      sibling.setAttribute('data-yoko-aggregate-hidden', '1');
    }
    branch = parent;
  }

  window.dispatchEvent(new Event('resize'));
  return true;
}

function __yokoScheduleAggregateFocusApply(delay = 0) {
  if (!__yokoAggregateFocusEnabled) return;
  if (__yokoAggregateFocusApplyTimer) clearTimeout(__yokoAggregateFocusApplyTimer);
  __yokoAggregateFocusApplyTimer = setTimeout(() => {
    __yokoAggregateFocusApplyTimer = null;
    __yokoApplyAggregateFocusLayout();
  }, Math.max(0, Number(delay) || 0));
}

function __yokoSetAggregateFocusMode(enabled) {
  try {
    __yokoEnsureAggregateFocusStyle();
    __yokoAggregateFocusEnabled = !!enabled;
    if (__yokoAggregateFocusEnabled) {
      document.documentElement.setAttribute('data-yoko-aggregate-focus', '1');
      // The chat already visible when Aggregate Mode is entered is a valid,
      // verified starting point. Do not block normal sending until the first
      // sidebar click.
      __yokoAggregateVerifiedChatId = __yokoCurrentRouteChatId();
      __yokoAggregateSendGuardUntil = Date.now() + 80;
      if (!__yokoAggregateFocusHashBound) {
        __yokoAggregateFocusHashBound = true;
        window.addEventListener('hashchange', () => {
          if (__yokoAggregateFocusEnabled) __yokoScheduleAggregateFocusApply(90);
        });
      }
      if (!__yokoAggregateFocusObserver) {
        __yokoAggregateFocusObserver = new MutationObserver(mutations => {
          // Translation/retranslate controls are Yoko-owned DOM. They must not
          // trigger a focus-layout recalculation; doing so was the main reason
          // the visible chat could disappear a moment after opening it.
          const meaningful = mutations.some(mutation => {
            // LINE renders the message right-click action menu through a React
            // portal under #modal-root. It is not a chat-layout mutation and
            // must never trigger our aggregate reflow/resize.
            const mutationTarget = mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement;
            if (mutationTarget?.closest?.('#modal-root')) return false;
            const nodes = [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])];
            if (!nodes.length) return false;
            return nodes.some(node => {
              if (!(node instanceof Element)) return true;
              if (node.id === 'modal-root' || node.closest?.('#modal-root')) return false;
              return !(
                node.matches?.('.yoko-inline-translation,.yoko-inline-actions,.yoko-line-paste-action') ||
                node.closest?.('.yoko-inline-translation,.yoko-inline-actions,.yoko-line-paste-action')
              );
            });
          });
          if (meaningful && !__yokoAggregateSwitchingChatId) __yokoScheduleAggregateFocusApply(160);
        });
        __yokoAggregateFocusObserver.observe(document.documentElement, { childList: true, subtree: true });
      }
      __yokoApplyAggregateFocusLayout();
      yokoScheduleInlineScan(40);
      setTimeout(() => { __yokoApplyAggregateFocusLayout(); yokoScheduleInlineScan(0); }, 120);
      setTimeout(() => { __yokoApplyAggregateFocusLayout(); yokoScheduleInlineScan(0); }, 420);
    } else {
      // V1.15.15: leaving aggregate mode is a hard cancellation boundary.
      // Invalidate every pending customer-switch poll and remove its overlay
      // immediately so LINE mode can never inherit “正在打开/仍在打开”.
      ++__yokoAggregateSwitchSeq;
      __yokoAggregateSwitchingChatId = '';
      __yokoAggregateVerifiedChatId = '';
      __yokoAggregateSendGuardUntil = 0;
      __yokoHideAggregateSwitchOverlay();
      document.documentElement.removeAttribute('data-yoko-aggregate-focus');
      if (__yokoAggregateFocusObserver) {
        __yokoAggregateFocusObserver.disconnect();
        __yokoAggregateFocusObserver = null;
      }
      if (__yokoAggregateFocusApplyTimer) {
        clearTimeout(__yokoAggregateFocusApplyTimer);
        __yokoAggregateFocusApplyTimer = null;
      }
      __yokoClearAggregateFocusMarks();
      window.dispatchEvent(new Event('resize'));
      yokoScheduleInlineScan(20,{preempt:true});
    }
    return { ok: true, enabled: __yokoAggregateFocusEnabled, isolated: __yokoAggregateFocusEnabled ? __yokoApplyAggregateFocusLayout() : false };
  } catch (error) {
    return { ok: false, enabled: !!enabled, error: String(error?.message || error) };
  }
}


function __yokoRefreshAggregateAvatars(limit = 180, options = {}) {
  try {
    const state = __yokoAggregateState();
    if (!state) return { ok: false, queued: 0, attempted: 0, error: 'LINE state not ready' };

    const opts = typeof options === 'boolean' ? { force: options } : (options || {});
    const force = opts.force === true;
    const contacts = state?.contact?.entities?.contacts || {};
    const boxesState = state?.messageBox || {};
    const listed = Array.isArray(boxesState?.list?.data) ? boxesState.list.data.map(String) : [];
    const friends = Array.isArray(state?.contact?.contactList?.data) ? state.contact.contactList.data.map(String) : [];
    const requestedMids = Array.isArray(opts.mids)
      ? new Set(opts.mids.map(String).map(v => v.trim()).filter(Boolean))
      : null;
    const max = Math.max(20, Math.min(800, Number(limit) || 180));
    const ids = [...new Set([...listed, ...friends, ...Object.keys(contacts).map(String)])]
      .filter(mid => __yokoIsCanonicalLineMid(mid) && (!requestedMids || requestedMids.has(mid)))
      .slice(0, max);

    let queued = 0;
    let attempted = 0;
    for (const mid of ids) {
      const contact = __yokoContactEntity(contacts[mid]);
      const picturePath = String(
        contact?.picturePath || contact?.pictureUrl || contact?.profileImagePath || contact?.profileImageUrl || ''
      ).trim();
      const avatarUrl = __yokoAggregatePictureUrl(picturePath);
      const hasData = avatarUrl && (__yokoAggregateAvatarDataCache.get(avatarUrl) || '');
      const hasDomData = __yokoAggregateDomAvatarCache.get(mid) || '';
      const hasMeta = __yokoAggregateContactAvatarMetaCache.get(mid) || null;

      // Manual "重抓头像" must be able to repair stale/missing aggregate photos,
      // including contacts whose previous successful bytes live only in the LINE
      // renderer cache. Clear only Yoko's temporary caches; LINE account/session
      // data is never touched.
      if (force) {
        if (avatarUrl) {
          __yokoAggregateAvatarDataCache.delete(avatarUrl);
          __yokoAggregateAvatarRetryAfter.delete(avatarUrl);
        }
        __yokoAggregateDomAvatarCache.delete(mid);
        __yokoAggregateContactAvatarMetaCache.delete(mid);
        __yokoAggregateContactAvatarMetaRetryAfter.delete(mid);
      } else if (hasData || hasDomData || (hasMeta && hasMeta.avatarUrl)) {
        continue;
      }

      attempted += 1;
      if (avatarUrl) {
        __yokoAggregateAvatarRetryAfter.delete(avatarUrl);
        __yokoQueueAggregateAvatar(avatarUrl);
      }

      // Ask LINE's authenticated contact API again for the exact MID. This is
      // the strongest fallback when Redux has no picturePath and the hidden
      // native conversation list is not mounted in Aggregate Mode.
      __yokoAggregateContactAvatarMetaRetryAfter.delete(mid);
      __yokoAggregateContactAvatarMeta(mid);

      // Also inspect any currently mounted exact-MID DOM nodes (chat header,
      // message avatar, contact row). This often repairs the selected customer
      // immediately even before the contact API finishes.
      if (!__yokoAggregateDomAvatarPending.has(mid)) {
        __yokoAggregateDomAvatarDataUrl(mid);
      }
      queued += 1;
    }

    // Republish while the authenticated CDN/API jobs finish. These are one-shot
    // recovery timers and do not add permanent polling load on low-spec PCs.
    __yokoScheduleAggregateSnapshot(120);
    setTimeout(() => __yokoPublishAggregateSnapshot(true), 650);
    setTimeout(() => __yokoPublishAggregateSnapshot(true), 1600);
    setTimeout(() => __yokoPublishAggregateSnapshot(true), 3400);
    setTimeout(() => __yokoPublishAggregateSnapshot(true), 7000);
    return { ok: true, queued, attempted, force };
  } catch (error) {
    return { ok: false, queued: 0, attempted: 0, error: String(error?.message || error) };
  }
}


function __yokoExportAggregateDrafts() {
  const drafts = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = String(localStorage.key(i) || '');
      if (!key.startsWith(__yokoAggregateDraftPrefix)) continue;
      const chatId = key.slice(__yokoAggregateDraftPrefix.length);
      const value = String(localStorage.getItem(key) || '');
      if (chatId && value) drafts[chatId] = value.slice(0, 20000);
    }
  } catch {}
  return drafts;
}

function __yokoImportAggregateDrafts(drafts = {}) {
  let restored = 0;
  if (!drafts || typeof drafts !== 'object') return { ok: true, restored };
  try {
    for (const [chatId, raw] of Object.entries(drafts)) {
      const id = String(chatId || '').trim();
      const value = String(raw || '').slice(0, 20000);
      if (!id || !value) continue;
      localStorage.setItem(__yokoAggregateDraftKey(id), value);
      restored += 1;
    }
  } catch (error) {
    return { ok: false, restored, error: String(error?.message || error) };
  }
  return { ok: true, restored };
}

// V1.23.31 — bounded chat-history snapshot for the independent archive center.
function __yokoHistoryNativeTime(root) {
  if (!root) return '';
  const values = [];
  try {
    for (const el of [root, ...root.querySelectorAll('[title],[aria-label],time')].slice(0,24)) {
      for (const raw of [el.getAttribute?.('title'), el.getAttribute?.('aria-label'), el.textContent]) {
        const v = String(raw || '').replace(/\s+/g,' ').trim();
        if (/^(?:上午|下午|午前|午後)?\s*\d{1,2}[:：]\d{2}(?:\s*(?:AM|PM))?$/i.test(v)) values.push(v);
      }
    }
  } catch {}
  return values[0] || '';
}
function __yokoHistoryNodeKey(root, signature='') {
  if (!root) return '';
  try {
    const attrs = ['data-message-id','data-mid','data-id','data-local-id','id'];
    for (let node=root, depth=0; node && depth<6; node=node.parentElement,depth++) {
      for (const name of attrs) {
        const v=String(node.getAttribute?.(name)||'').trim();
        if (v && v.length < 180) return `${name}:${v}`;
      }
    }
    const sig=String(signature||'').slice(0,500);
    if (root.dataset?.yokoHistorySig !== sig) {
      root.dataset.yokoHistorySig=sig;
      root.dataset.yokoHistoryId=`dom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
    }
    return String(root.dataset?.yokoHistoryId || '');
  } catch { return ''; }
}
async function __yokoHistoryDataUrl(src, maxBytes=12*1024*1024) {
  src=String(src||'').trim(); if(!src)return '';
  if(/^data:/i.test(src)) return src.length <= Math.ceil(maxBytes*1.5) ? src : '';
  try {
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),1400);
    const response=await fetch(src,{credentials:'include',signal:controller.signal}); clearTimeout(timer);
    if(!response.ok)return '';
    const blob=await response.blob(); if(!blob.size||blob.size>maxBytes)return '';
    return await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=()=>resolve('');reader.readAsDataURL(blob);});
  } catch { return ''; }
}
function __yokoHistoryMediaRole(el) {
  let node=el;
  for(let depth=0;node&&depth<8;node=node.parentElement,depth++) {
    const role=yokoBubbleRole(node); if(role)return role==='outgoing'?'me':'customer';
  }
  try {
    const r=el.getBoundingClientRect(); const center=r.left+r.width/2;
    if(r.left < (window.innerWidth<980?6:Math.max(245,window.innerWidth*.19))) return '';
    return center > window.innerWidth*.56 ? 'me' : 'customer';
  } catch { return ''; }
}
async function __yokoRecentArchiveEntries(limit=80) {
  const max=Math.max(1,Math.min(120,Number(limit)||80));
  const rows=[]; const seenNodes=new Set();
  const textCandidates=yokoMessageBubbleCandidates();
  for(const item of textCandidates) {
    const text=yokoStripLineUiMetadata(item?.text||'').trim(); if(!text)continue;
    const role=item.role==='outgoing'?'me':'customer';
    const sourceKey=__yokoHistoryNodeKey(item.bubble,`${role}|text|${text}`);
    rows.push({role,type:'text',text:text.slice(0,12000),nativeTime:__yokoHistoryNativeTime(item.bubble),sourceKey,top:item.rect?.top||0});
    seenNodes.add(item.bubble);
  }
  const root=yokoTranslationScanRoot();
  const mediaEls=[...root.querySelectorAll('img,video,audio')].filter(el=>visible(el));
  let mediaOrdinal=0;
  for(const el of mediaEls) {
    let rect; try{rect=el.getBoundingClientRect()}catch{continue}
    const tag=String(el.tagName||'').toLowerCase();
    if(tag==='img' && (rect.width<72 || rect.height<72)) continue; // skip avatars/icons
    if(tag==='video' && (rect.width<90 || rect.height<70)) continue;
    if(tag==='audio' && rect.width<80) continue;
    const role=__yokoHistoryMediaRole(el); if(!role)continue;
    const src=String(el.currentSrc||el.src||el.getAttribute?.('src')||'').trim(); if(!src)continue;
    const type=tag==='img'?'image':tag==='audio'?'audio':'video';
    const sourceKey=__yokoHistoryNodeKey(el,`${role}|${type}|${src}`);
    const dataUrl=await __yokoHistoryDataUrl(src,type==='image'?12*1024*1024:20*1024*1024);
    rows.push({role,type,src,dataUrl,mimeType:'',duration:Number(el.duration||0)||0,nativeTime:__yokoHistoryNativeTime(el.parentElement),sourceKey,top:(rect.top||0)+(++mediaOrdinal/1000)});
  }
  rows.sort((a,b)=>(a.top||0)-(b.top||0));
  return rows.slice(-max).map(({top,...row})=>row);
}


window.yokoLine = {
  async setForegroundMode(enabled) {
    __yokoForegroundMode = !!enabled;
    if (__yokoForegroundMode) yokoScheduleInlineScan(60);
    try { __yokoScheduleAggregateHeartbeat(__yokoForegroundMode ? 900 : 3500); } catch {}
    return { ok: true, foreground: __yokoForegroundMode };
  },

  async getCurrentChatInfo() {
    return yokoGetCurrentChatInfo();
  },

  async getAggregateConversations(limit = 300) {
    return __yokoBuildAggregateSnapshot(limit);
  },

  async exportAggregateDrafts() {
    return __yokoExportAggregateDrafts();
  },

  async importAggregateDrafts(drafts = {}) {
    return __yokoImportAggregateDrafts(drafts);
  },

  async refreshAggregateAvatars(limit = 180, options = {}) {
    // V1.15.28: keep the options object. Older bridge code accidentally dropped
    // force/mids, so manual and targeted repairs looked successful but actually
    // performed only a generic first-N sweep.
    return __yokoRefreshAggregateAvatars(limit, options);
  },

  async setAggregateFocusMode(enabled) {
    return __yokoSetAggregateFocusMode(!!enabled);
  },

  async openProfileCard(chatId) {
    return __yokoOpenProfileCard(chatId);
  },

  async prewarmConversation(chatId) {
    return __yokoPrewarmConversation(chatId);
  },

  async openConversation(chatId) {
    return __yokoOpenConversation(chatId);
  },

  async getSelectionText() {
    return window.getSelection?.()?.toString?.().trim?.() || '';
  },

  async getLastClickedText() {
    return __yokoLastClickedText;
  },

  async getRecentMessages(limit = 8) {
    return recentMessageCandidates(limit);
  },

  async getRecentMessagesDetailed(limit = 8) {
    return recentMessageCandidatesDetailed(limit);
  },

  async getMessagesForChatId(chatId, limit = 80) {
    return yokoReduxMessageRowsForChatId(chatId, limit);
  },

  async getReliableMessageBundle(chatId, limit = 80) {
    return yokoReliableMessageBundle(chatId, limit);
  },

  async getRecentArchiveEntries(limit = 80) {
    return __yokoRecentArchiveEntries(limit);
  },

  async getInputText() {
    const el = await waitForMessageComposer(1400);
    return readElement(el).trim();
  },

  async waitForComposer(timeoutMs = 2600) {
    const el = await waitForMessageComposer(timeoutMs);
    return {
      ok: !!el,
      chatId: __yokoCurrentRouteChatId(),
      error: el ? '' : '当前 LINE 聊天仍在加载，暂时没有找到消息输入框。'
    };
  },

  async focusComposer() {
    const el = await waitForMessageComposer(2200);
    if (!el) return { ok: false, error: '当前 LINE 聊天仍在加载，暂时没有找到消息输入框。' };
    try {
      const ok = __yokoFocusEditable(el);
      return { ok };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  },

  async setInputText(text) {
    const el = await waitForMessageComposer(3000);
    if (!el) return { ok: false, error: '当前 LINE 聊天仍在加载，暂时没有找到消息输入框。' };
    const ok = dispatchInput(el, String(text || ''));
    // Let LINE/React finish its input-state commit before a caller immediately
    // follows with sendCurrent(). This is especially important for textarea-ex.
    if (ok) await new Promise(resolve => setTimeout(resolve, 36));
    return { ok, chatId: __yokoCurrentRouteChatId() };
  },

  async queueOutgoingOriginal(original, translated) {
    return { ok: yokoQueueOutgoingOriginal(original, translated) };
  },

  async sendCurrent() {
    const el = await waitForMessageComposer(3000);
    if (!el) return { ok: false, error: '当前 LINE 聊天仍在加载，暂时没有找到消息输入框。' };
    if (!__yokoAggregateCanSend()) {
      __yokoShowSendGuardToast();
      return { ok: false, guarded: true, error: '正在确认当前客户，已阻止发送以避免串会话。' };
    }

    const currentChatId = __yokoCurrentRouteChatId();
    const before = readElement(el).trim();
    if (!before) return { ok: false, error: '当前 LINE 输入框为空' };

    __yokoFocusEditable(el);
    const keyTarget = __yokoTextareaExInput(el) || el;
    const options = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true
    };
    keyTarget.dispatchEvent(new KeyboardEvent('keydown', options));
    keyTarget.dispatchEvent(new KeyboardEvent('keypress', options));
    keyTarget.dispatchEvent(new KeyboardEvent('keyup', options));

    await new Promise(resolve => setTimeout(resolve, 90));
    let after = readElement(el).trim();
    if (!after || after !== before) {
      __yokoClearAggregateDraft(currentChatId);
      return { ok: true, method: 'enter' };
    }

    // Some LINE builds/settings treat Enter as a newline. In that case, only
    // click a button whose own accessibility metadata clearly identifies it as
    // Send; never guess among emoji/attachment buttons.
    const scopes = [];
    let node = el;
    for (let i = 0; node && i < 6; i += 1, node = node.parentElement) scopes.push(node);
    const seen = new Set();
    for (const scope of scopes) {
      let buttons = [];
      try { buttons = [...scope.querySelectorAll('button,[role="button"]')]; } catch {}
      for (const button of buttons) {
        if (seen.has(button) || !visible(button)) continue;
        seen.add(button);
        const label = [
          button.getAttribute?.('aria-label'),
          button.getAttribute?.('title'),
          button.getAttribute?.('data-testid'),
          button.textContent
        ].filter(Boolean).join(' ').trim();
        if (!/(^|\s)(send|送信|发送|傳送)(\s|$)/i.test(label) && !/send/i.test(String(button.getAttribute?.('data-testid') || ''))) continue;
        try {
          button.click();
          await new Promise(resolve => setTimeout(resolve, 100));
          after = readElement(el).trim();
          if (!after || after !== before) {
            __yokoClearAggregateDraft(currentChatId);
            return { ok: true, method: 'send-button' };
          }
        } catch {}
      }
    }

    return { ok: false, error: 'LINE 输入框内容仍未发送；请确认当前聊天已完全加载。' };
  }
};


// V1.23.45: legacy inline AI Reply Dock removed; ChatGPT sidecar is the supported AI workflow.

function yokoFindBottomComposer() {
  // Do not trust document.activeElement here. LINE often leaves focus on the
  // chat-search box or another textbox, which caused the AI bar to disappear.
  // The real message composer is normally the widest editable element in the
  // lower part of the current LINE view.
  const candidates = editableCandidates()
    .map(el => ({ el, rect: el.getBoundingClientRect() }))
    .filter(({ el, rect }) => {
      if (!rect || el.closest?.('.yoko-ai-reply-dock')) return false;
      if (rect.width < 120 || rect.height < 10) return false;
      if (rect.bottom < window.innerHeight * 0.68) return false;
      if (rect.top >= window.innerHeight - 4) return false;
      return true;
    });

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    // Prefer elements nearest the bottom, then the widest one. This reliably
    // chooses LINE's message composer instead of the chat search field.
    const bottomDelta = b.rect.bottom - a.rect.bottom;
    if (Math.abs(bottomDelta) > 6) return bottomDelta;
    return b.rect.width - a.rect.width;
  });
  return candidates[0].el;
}

// Legacy dock positioning/settings/create/start code removed in V1.23.45.



// V1.23.54: native clipboard paste affordance anchored to the current LINE composer.
// It deliberately lives outside LINE's React tree and follows the composer rect,
// so LINE updates cannot destroy the control and the control never replaces a draft.
let __yokoLinePasteButton = null;
let __yokoLinePasteBusy = false;
function __yokoEnsureLinePasteButton() {
  try {
    if (__yokoLinePasteButton?.isConnected) return __yokoLinePasteButton;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'yoko-line-paste-action';
    button.textContent = '粘贴';
    button.title = '把 Windows 剪贴板文字粘贴到当前 LINE 输入框（不会自动发送）';
    Object.assign(button.style, {
      position: 'fixed', zIndex: '2147482500', display: 'none', minWidth: '58px', height: '28px',
      padding: '0 12px', border: '1px solid rgba(15,23,42,.16)', borderRadius: '8px',
      background: 'rgba(255,255,255,.97)', color: '#172033', fontSize: '12px', fontWeight: '600',
      boxShadow: '0 1px 4px rgba(15,23,42,.08)', cursor: 'pointer', lineHeight: '26px'
    });
    button.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); });
    button.addEventListener('click', async event => {
      event.preventDefault(); event.stopPropagation();
      if (__yokoLinePasteBusy) return;
      __yokoLinePasteBusy = true;
      button.disabled = true;
      const original = '粘贴';
      button.textContent = '粘贴中…';
      try {
        const result = await ipcRenderer.invoke('line-paste-clipboard-to-composer');
        if (!result?.ok) throw new Error(result?.error || '粘贴失败');
        button.textContent = '✓ 已粘贴';
        button.title = `已粘贴 ${Number(result?.length || 0)} 个字符，不会自动发送`;
      } catch (error) {
        button.textContent = '粘贴失败';
        button.title = String(error?.message || error || '粘贴失败');
      } finally {
        setTimeout(() => {
          if (button?.isConnected) {
            button.textContent = original;
            button.disabled = false;
            button.title = '把 Windows 剪贴板文字粘贴到当前 LINE 输入框（不会自动发送）';
          }
          __yokoLinePasteBusy = false;
          __yokoPositionLinePasteButton();
        }, 900);
      }
    });
    document.documentElement.appendChild(button);
    __yokoLinePasteButton = button;
    return button;
  } catch { return null; }
}

function __yokoPositionLinePasteButton() {
  try {
    const button = __yokoEnsureLinePasteButton();
    if (!button) return;
    const composer = yokoFindBottomComposer();
    const chatId = __yokoCurrentRouteChatId();
    if (!composer || !chatId) {
      button.style.display = 'none';
      return;
    }
    const rect = composer.getBoundingClientRect();
    if (!rect || rect.width < 120 || rect.top <= 0 || rect.top >= window.innerHeight) {
      button.style.display = 'none';
      return;
    }
    button.style.display = 'block';
    // Keep it just above the input border and near the left side, matching the
    // ChatGPT sidecar action style without covering the editable text.
    const width = Math.max(58, button.offsetWidth || 58);
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + 8));
    const top = Math.max(8, rect.top - 32);
    button.style.left = `${Math.round(left)}px`;
    button.style.top = `${Math.round(top)}px`;
  } catch {}
}

setInterval(__yokoPositionLinePasteButton, 320);
window.addEventListener('resize', __yokoPositionLinePasteButton, { passive:true });
window.addEventListener('scroll', __yokoPositionLinePasteButton, { passive:true, capture:true });
setTimeout(__yokoPositionLinePasteButton, 500);
