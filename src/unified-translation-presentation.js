'use strict';

// V1.27.50 — one translation presentation across every embedded messenger.
// Keep platform extraction/translation logic untouched; this module only owns
// presentation. That lets the V1.25.11 sealed LINE/external preloads stay byte-
// identical while Meta Business, LINE and every external-preload platform all
// render the same compact native-bubble translation card.

const UNIFIED_TRANSLATION_CSS = `
/* YokoSCRM V1.27.50 universal native-bubble translation card */
.yoko-global-translated-host {
  position: relative !important;
  overflow: visible !important;
}
.yoko-global-translated-host[data-yoko-global-translating="1"]::after,
.yoko-global-translated-host[data-yoko-global-translation-error]::after,
.yoko-global-translated-host[data-yoko-global-translation]::after,
.yoko-inline-translation {
  display: block !important;
  box-sizing: border-box !important;
  width: fit-content !important;
  max-width: min(420px, 70vw) !important;
  margin: 4px 0 1px 0 !important;
  padding: 3px 7px !important;
  border-radius: 6px !important;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif !important;
  font-size: 12px !important;
  font-weight: 500 !important;
  line-height: 1.4 !important;
  white-space: pre-wrap !important;
  word-break: break-word !important;
  box-shadow: none !important;
  text-decoration: none !important;
}
.yoko-global-translated-host[data-yoko-global-translation]::after,
.yoko-inline-translation:not([data-status="pending"]):not([data-status="error"]) {
  background: rgba(238,250,242,.96) !important;
  color: #236942 !important;
  border: 1px solid rgba(73,143,101,.22) !important;
}
.yoko-global-translated-host[data-yoko-global-translating="1"]::after,
.yoko-inline-translation[data-status="pending"] {
  background: rgba(246,248,249,.96) !important;
  color: #73808a !important;
  border: 1px solid rgba(120,130,138,.18) !important;
}
.yoko-global-translated-host[data-yoko-global-translation-error]::after,
.yoko-inline-translation[data-status="error"] {
  background: rgba(255,244,244,.97) !important;
  color: #b33a3a !important;
  border: 1px solid rgba(190,66,66,.20) !important;
}
.yoko-inline-translation {
  padding-top: 3px !important;
  border-top-style: solid !important;
  min-height: 0 !important;
  height: auto !important;
  max-height: none !important;
  pointer-events: none !important;
}
.yoko-has-inline-translation > .yoko-inline-translation {
  width: fit-content !important;
  max-width: 100% !important;
  overflow: visible !important;
}
.yoko-global-translated-host[data-yoko-global-translation-mode="simple"][data-yoko-global-translation]::after,
.yoko-inline-translation[data-mode="simple"] {
  margin-top: 3px !important;
}
`;

const LINE_TRANSLATION_TEXT_NORMALIZER = `(() => {
  if (window.__yokoUnifiedTranslationPresentationV12750) {
    try { window.__yokoUnifiedTranslationPresentationV12750.scan(); } catch {}
    return true;
  }
  const stripLegacyLabel = value => String(value || '')
    .replace(/^\\s*-{3,}\\s*中文译文\\s*-{3,}\\s*(?:\\n|$)/u, '')
    .replace(/^\\s*译[:：]\\s*/u, '')
    .trim();
  const normalize = el => {
    if (!(el instanceof Element) || !el.classList.contains('yoko-inline-translation')) return;
    const status = String(el.dataset?.status || '');
    if (status === 'pending' || status === 'error') return;
    const cleaned = stripLegacyLabel(el.textContent || '');
    if (!cleaned) return;
    const wanted = String(el.dataset?.mode || 'bilingual') === 'simple' ? cleaned : ('中文译文：' + cleaned);
    if (el.textContent !== wanted) el.textContent = wanted;
    el.setAttribute('data-yoko-unified-translation-ui', '1');
  };
  let queued = false;
  const scan = () => {
    queued = false;
    try { document.querySelectorAll('.yoko-inline-translation').forEach(normalize); } catch {}
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(scan);
  };
  const observer = new MutationObserver(mutations => {
    let relevant = false;
    for (const mutation of mutations) {
      const target = mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement;
      if (target?.closest?.('.yoko-inline-translation')) { relevant = true; break; }
      for (const node of mutation.addedNodes || []) {
        if (!(node instanceof Element)) continue;
        if (node.matches?.('.yoko-inline-translation') || node.querySelector?.('.yoko-inline-translation')) { relevant = true; break; }
      }
      if (relevant) break;
    }
    if (relevant) schedule();
  });
  try { observer.observe(document.documentElement, {subtree:true, childList:true, characterData:true}); } catch {}
  const api = {scan, observer};
  window.__yokoUnifiedTranslationPresentationV12750 = api;
  scan();
  return true;
})()`;

async function installUnifiedTranslationPresentation(webContents, { normalizeLineText = false } = {}) {
  if (!webContents || webContents.isDestroyed?.()) return false;
  try { await webContents.insertCSS(UNIFIED_TRANSLATION_CSS, { cssOrigin: 'author' }); } catch { return false; }
  if (normalizeLineText) {
    try { await webContents.executeJavaScript(LINE_TRANSLATION_TEXT_NORMALIZER, true); } catch {}
  }
  return true;
}

module.exports = {
  UNIFIED_TRANSLATION_CSS,
  LINE_TRANSLATION_TEXT_NORMALIZER,
  installUnifiedTranslationPresentation
};
