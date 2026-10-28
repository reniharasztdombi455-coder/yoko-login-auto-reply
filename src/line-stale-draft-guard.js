'use strict';

const GUARD_VERSION = 'v1.26.4';
const SEND_INTENT_MAX_AGE_MS = 4200;

function normalizeDraftText(value) {
  return String(value == null ? '' : value)
    .replace(/\u200b/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

function shouldWaitForDraftSettle(snapshot, now = Date.now(), maxAgeMs = SEND_INTENT_MAX_AGE_MS) {
  if (!snapshot || snapshot.ok === false) return false;
  const at = Number(snapshot.at || 0) || 0;
  if (!at || (Number(now) - at) < 0 || (Number(now) - at) > Math.max(250, Number(maxAgeMs) || SEND_INTENT_MAX_AGE_MS)) return false;
  const routeChatId = String(snapshot.routeChatId || '').trim();
  const sendChatId = String(snapshot.chatId || '').trim();
  if (!routeChatId || !sendChatId || routeChatId !== sendChatId) return false;
  const sentText = normalizeDraftText(snapshot.sentText);
  const composerText = normalizeDraftText(snapshot.composerText);
  if (!sentText || !composerText) return false;
  // Only hold the switch while LINE still exposes the exact text that was just
  // submitted. Empty means LINE settled; different text means the operator has
  // already started a new draft and the normal per-customer saver must preserve it.
  return sentText === composerText;
}

function buildLineStaleDraftGuardScript() {
  return `(() => {
    const VERSION=${JSON.stringify(GUARD_VERSION)};
    const existing=window.__yokoLineStaleDraftGuard;
    if(existing&&existing.version===VERSION)return {ok:true,alreadyInstalled:true,version:VERSION};
    const normalize=value=>String(value==null?'':value).replace(/\\u200b/g,'').replace(/\\r\\n/g,'\\n').trim();
    const currentChatId=()=>{try{const decoded=decodeURIComponent(String(location.hash||''));const m=decoded.match(/\\/chats\\/([^/?#]+)/);return m?String(m[1]||'').trim():''}catch{return ''}};
    const visible=el=>{try{if(!el)return false;const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>10&&r.height>10&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0}catch{return false}};
    const unwrap=raw=>{if(!raw)return null;try{if(String(raw.tagName||'').toLowerCase()==='textarea-ex')return raw.inputEl||raw.shadowRoot?.querySelector?.('textarea.input,textarea')||raw;return raw}catch{return raw}};
    const read=raw=>{const el=unwrap(raw);if(!el)return '';try{return String(('value' in el?el.value:(el.innerText||el.textContent||''))||'').replace(/\\u200b/g,'').replace(/\\r\\n/g,'\\n')}catch{return ''}};
    const fromEvent=event=>{try{for(const raw of event.composedPath?.()||[]){if(!(raw instanceof Element))continue;const tag=String(raw.tagName||'').toLowerCase();if(tag==='textarea-ex'||tag==='textarea'||tag==='input'||raw.isContentEditable||raw.getAttribute?.('role')==='textbox')return raw}}catch{}return null};
    const findComposer=()=>{
      try{
        const active=document.activeElement;
        if(active){const hit=unwrap(active);const tag=String(active.tagName||'').toLowerCase();if(tag==='textarea-ex'||tag==='textarea'||active.isContentEditable||active.getAttribute?.('role')==='textbox')return active;if(hit&&hit!==active)return active}
        const rows=[];
        for(const raw of document.querySelectorAll('textarea-ex,textarea,[contenteditable="true"],[role="textbox"]')){
          const el=unwrap(raw);if(!el||!visible(el))continue;let r;try{r=el.getBoundingClientRect()}catch{continue}if(r.bottom<innerHeight*.48)continue;rows.push({raw,r})
        }
        rows.sort((a,b)=>b.r.bottom-a.r.bottom||b.r.width-a.r.width);return rows[0]?.raw||null;
      }catch{return null}
    };
    const state={at:0,chatId:'',sentText:'',source:'',composer:null};
    const mark=(source,event)=>{
      const chatId=currentChatId();if(!chatId)return;
      const composer=fromEvent(event)||findComposer();const text=normalize(read(composer));if(!text)return;
      state.at=Date.now();state.chatId=chatId;state.sentText=text;state.source=source;state.composer=composer||null;
    };
    const keydown=event=>{try{if(event?.key!=='Enter'||event.shiftKey||event.isComposing)return;const composer=fromEvent(event);if(!composer)return;mark('enter',event)}catch{}};
    const click=event=>{try{const target=event.target instanceof Element?event.target:null;const button=target?.closest?.('button,[role="button"]');if(!button)return;const label=[button.getAttribute?.('aria-label'),button.getAttribute?.('title'),button.getAttribute?.('data-testid'),button.textContent].filter(Boolean).join(' ').trim();if(!/(^|\\s)(send|送信|发送|傳送)(\\s|$)/i.test(label)&&!/send/i.test(String(button.getAttribute?.('data-testid')||'')))return;mark('send-button',event)}catch{}};
    document.addEventListener('keydown',keydown,true);document.addEventListener('click',click,true);
    const api={
      version:VERSION,
      snapshot(){
        const routeChatId=currentChatId();let composer=state.composer;
        try{if(!composer||(!composer.isConnected&&String(composer.tagName||'').toLowerCase()!=='textarea-ex'))composer=findComposer()}catch{composer=findComposer()}
        return {ok:true,version:VERSION,at:Number(state.at||0)||0,chatId:String(state.chatId||''),routeChatId,source:String(state.source||''),sentText:String(state.sentText||''),composerText:read(composer)};
      },
      dispose(){try{document.removeEventListener('keydown',keydown,true);document.removeEventListener('click',click,true)}catch{};try{delete window.__yokoLineStaleDraftGuard}catch{};return true}
    };
    window.__yokoLineStaleDraftGuard=api;
    return {ok:true,installed:true,version:VERSION};
  })()`;
}

module.exports = {
  GUARD_VERSION,
  SEND_INTENT_MAX_AGE_MS,
  normalizeDraftText,
  shouldWaitForDraftSettle,
  buildLineStaleDraftGuardScript
};
