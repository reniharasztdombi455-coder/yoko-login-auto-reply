'use strict';

// V1.27.196 — active-chat authoritative LINE writeback + professional native-web translation fallback.
// This path deliberately does NOT depend on renderer preload message scanning.
// It operates only on the currently active LINE / Telegram renderer and only on
// incoming/customer text that has no completed translation already rendered.
// Main owns provider selection, so this fallback uses the exact same translation
// lane as the Official API inbox.

const LINE_SNAPSHOT_SCRIPT = `(() => {
  const clean = value => String(value || '').replace(/\\u200b/g,'').replace(/[ \\t]+/g,' ').replace(/\\n{3,}/g,'\\n\\n').trim();
  const visible = el => { try { if(!el || !(el instanceof Element)) return false; const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0; } catch { return false; } };
  const useful = text => { const v=clean(text); if(!v||v.length>12000)return false; if(/^[\\d\\s:：./\\-年月日APMapm]+$/.test(v))return false; if(/^[\\p{P}\\p{S}\\s]+$/u.test(v))return false; return true; };
  // V1.27.195: scope LINE translation strictly to the active conversation pane.
  // LINE's left conversation list can also expose data-message-id previews; translating
  // those previews creates duplicate translation cards in the sidebar.
  const activeChatRoot = (() => {
    try {
      const candidates=[...document.querySelectorAll('textarea,input[type=\"text\"],[contenteditable=\"true\"]')].filter(visible).map(el=>({el,r:el.getBoundingClientRect()})).filter(x=>x.r.bottom>window.innerHeight*0.68);
      candidates.sort((a,b)=>b.r.bottom-a.r.bottom || b.r.left-a.r.left);
      const composer=candidates[0]?.el||null;
      let node=composer;
      for(let depth=0;node&&depth<12;depth++,node=node.parentElement){
        const r=node.getBoundingClientRect?.(); if(!r)continue;
        if(r.width>=window.innerWidth*0.42&&r.height>=window.innerHeight*0.55&&r.left>=window.innerWidth*0.18)return node;
      }
    } catch {}
    return document.body||document.documentElement;
  })();
  // Clean translation rows left in the sidebar by older builds.
  try {
    document.querySelectorAll('.yoko-main-fallback-translation').forEach(row=>{
      if(activeChatRoot?.contains?.(row))return;
      const host=row.parentElement; row.remove?.();
      if(host){
        for(const name of ['data-yoko-global-source','data-yoko-global-translation','data-yoko-global-translation-mode','data-yoko-global-translating','data-yoko-global-translation-error','data-yoko-global-translation-noop','data-yoko-main-fallback-render']){try{host.removeAttribute?.(name);}catch{}}
        try{host.classList?.remove?.('yoko-global-translated-host');}catch{}
      }
    });
  } catch {}
  const envelopeOf = messageNode => {
    let node=messageNode;
    for(let depth=0;node&&depth<12;depth++,node=node.parentElement){
      try{
        const hasDirection=node.hasAttribute?.('data-direction') || Object.prototype.hasOwnProperty.call(node.dataset||{},'direction');
        if(!hasDirection)continue;
        const direction=String(node.getAttribute?.('data-direction') ?? node.dataset?.direction ?? '').trim().toLowerCase();
        if(direction!==''&&direction!=='reverse')continue;
        return {layout:node,direction,role:direction==='reverse'?'me':'customer'};
      }catch{}
    }
    return null;
  };
  const textOf = (messageNode,envelope) => {
    const readAttr = node => clean(node?.getAttribute?.('data-message-content') ?? node?.dataset?.messageContent ?? '');
    let node=messageNode;
    for(let depth=0;node&&depth<10;depth++,node=node.parentElement){
      const value=readAttr(node); if(useful(value))return value;
      if(envelope?.layout && node===envelope.layout)break;
    }
    try{
      const nested=messageNode.matches?.('[data-message-content]')?messageNode:messageNode.querySelector?.('[data-message-content]');
      const nestedValue=readAttr(nested); if(useful(nestedValue))return nestedValue;
    }catch{}
    try{
      const semantic=messageNode.matches?.('[data-is-message-text]')?messageNode:messageNode.querySelector?.('[data-is-message-text]');
      const semanticValue=clean(semantic?.innerText||semantic?.textContent||''); if(useful(semanticValue))return semanticValue;
    }catch{}
    try{
      const clone=messageNode.cloneNode(true);
      clone.querySelectorAll?.('.yoko-inline-translation,.yoko-main-fallback-translation,.yoko-inline-actions,.yoko-line-paste-action,[data-yoko-ui="1"]').forEach(el=>el.remove());
      const value=clean(clone.innerText||clone.textContent||''); if(useful(value))return value;
    }catch{}
    return '';
  };
  const out=[]; const seen=new Set();
  let nodes=[]; try { nodes=[...activeChatRoot.querySelectorAll('[data-message-id]')]; } catch {}
  for(const messageNode of nodes){
    if(!visible(messageNode))continue;
    if(messageNode.closest?.('.yoko-inline-translation,.yoko-main-fallback-translation,.yoko-inline-actions,.yoko-ai-reply-dock'))continue;
    const envelope=envelopeOf(messageNode); if(!envelope||envelope.role!=='customer'||!visible(envelope.layout))continue;
    const id=String(messageNode.getAttribute?.('data-message-id')||messageNode.dataset?.messageId||'').trim();
    if(!id||seen.has(id))continue;
    const text=textOf(messageNode,envelope); if(!useful(text))continue;
    seen.add(id);
    // V1.27.194: LINE 3.7.x can reuse/remount a message-content DOM node when
    // the newest message arrives. React does not know about our custom data-*
    // attributes, so an old data-yoko-global-translation can survive while the
    // node now represents a different source message. Never treat translation
    // state as complete unless it belongs to the CURRENT source text. Otherwise
    // the newest message is permanently skipped even though no Chinese row is
    // visible. Clear stale metadata/rows immediately and let this snapshot enter
    // the provider lane again.
    const globalSource=clean(messageNode.getAttribute?.('data-yoko-global-source')||'');
    const sourceMatches=!!globalSource && globalSource===text;
    let mainRow=messageNode.querySelector?.(':scope > .yoko-main-fallback-translation') || messageNode.querySelector?.('.yoko-main-fallback-translation');
    if(globalSource && !sourceMatches){
      for(const name of ['data-yoko-global-source','data-yoko-global-translation','data-yoko-global-translation-mode','data-yoko-global-translating','data-yoko-global-translation-error','data-yoko-global-translation-noop','data-yoko-main-fallback-render']){
        try{messageNode.removeAttribute?.(name);}catch{}
      }
      try{messageNode.classList?.remove?.('yoko-global-translated-host');}catch{}
      try{mainRow?.remove?.();}catch{}
      mainRow=null;
    }
    const finalGlobal=sourceMatches ? clean(messageNode.getAttribute?.('data-yoko-global-translation')||'') : '';
    const inline=messageNode.querySelector?.(':scope > .yoko-inline-translation');
    const inlineStatus=String(inline?.dataset?.status||'');
    const inlineSource=clean(inline?.dataset?.yokoOriginal||'');
    const inlineMatches=!!inline && !!inlineSource && inlineSource===text;
    if(inline && inlineSource && !inlineMatches){ try{inline.remove?.();}catch{} }
    const finalInline=inlineMatches && inlineStatus!=='pending' && inlineStatus!=='error' && clean(inline.textContent||'').length>0;
    const finalMain=sourceMatches && !!mainRow && String(mainRow?.dataset?.state||'')==='ok' && clean(mainRow.textContent||'').length>0;
    const r=messageNode.getBoundingClientRect();
    out.push({id,text,role:'customer',top:Number(r.top||0),translated:!!finalGlobal||finalInline||finalMain});
  }
  out.sort((a,b)=>a.top-b.top); return out.slice(-30);
})()`;

const TELEGRAM_SNAPSHOT_SCRIPT = `(() => {
  const clean = value => String(value || '').replace(/\\u200b/g,'').replace(/[ \\t]+/g,' ').replace(/\\n{3,}/g,'\\n\\n').trim();
  const visible = el => { try { if(!el || !(el instanceof Element)) return false; const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0; } catch { return false; } };
  const useful = text => { const v=clean(text); if(!v||v.length>12000)return false; if(/^(?:\\d{1,2}:\\d{2}|Today|Yesterday|今天|昨天)$/i.test(v))return false; if(/^[\\s\\d:./-]+$/.test(v))return false; if(!/[A-Za-zぁ-ゖァ-ヺ\\u3400-\\u9fff가-힣]/u.test(v))return false; return true; };
  const textOf = bubble => {
    let host=null; try { host=bubble.querySelector('.message') || bubble.querySelector('.text-content,.translatable-message,[dir="auto"]') || bubble; } catch { host=bubble; }
    try {
      const clone=host.cloneNode(true);
      clone.querySelectorAll?.('.time,.replies,.reactions,.reply,.peer-title,.yoko-global-message-actions,.yoko-inline-translation,.yoko-main-fallback-translation,button,[data-yoko-global-translation]').forEach(el=>el.remove());
      return {host,text:clean(clone.innerText||clone.textContent||'')};
    } catch { return {host,text:clean(host?.innerText||host?.textContent||'')}; }
  };
  const root=document.querySelector('#MiddleColumn')||document;
  let bubbles=[]; try { bubbles=[...root.querySelectorAll('.bubble[data-mid]:not(.service):not(.is-date)')]; } catch {}
  const out=[]; const seen=new Set();
  for(const bubble of bubbles){
    if(!visible(bubble)||bubble.classList.contains('is-out')) continue;
    const id=String(bubble.getAttribute('data-mid')||bubble.dataset?.mid||'').trim();
    if(!id||seen.has(id)) continue;
    const picked=textOf(bubble); const host=picked.host; const text=picked.text;
    if(!host||!visible(host)||!useful(text)) continue;
    seen.add(id);
    const finalGlobal=clean(host.getAttribute?.('data-yoko-global-translation')||'');
    const r=host.getBoundingClientRect();
    out.push({id,text,role:'customer',top:Number(r.top||0),translated:!!finalGlobal});
  }
  out.sort((a,b)=>a.top-b.top); return out.slice(-30);
})()`;

function scriptForSnapshot(platform) {
  return platform === 'line' ? LINE_SNAPSHOT_SCRIPT : platform === 'telegram' ? TELEGRAM_SNAPSHOT_SCRIPT : '';
}

function hostLookupExpression(platform, id, text='') {
  const raw=JSON.stringify(String(id||''));
  const rawText=JSON.stringify(String(text||''));
  if(platform==='line') return String.raw`(()=>{
    const id=${raw},source=${rawText};
    const clean=v=>String(v||'').replace(/\u200b/g,'').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
    const visible=el=>{try{if(!el||!(el instanceof Element))return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0}catch{return false}};
    const activeChatRoot=(()=>{try{const candidates=[...document.querySelectorAll('textarea,input[type=\"text\"],[contenteditable=\"true\"]')].filter(visible).map(el=>({el,r:el.getBoundingClientRect()})).filter(x=>x.r.bottom>window.innerHeight*.68);candidates.sort((a,b)=>b.r.bottom-a.r.bottom||b.r.left-a.r.left);const composer=candidates[0]?.el||null;let node=composer;for(let depth=0;node&&depth<12;depth++,node=node.parentElement){const r=node.getBoundingClientRect?.();if(!r)continue;if(r.width>=window.innerWidth*.42&&r.height>=window.innerHeight*.55&&r.left>=window.innerWidth*.18)return node}}catch{}return null})();
    const textOf=n=>{try{const direct=clean(n.getAttribute?.('data-message-content')||n.dataset?.messageContent||'');if(direct)return direct;const nested=n.querySelector?.('[data-message-content]');const nv=clean(nested?.getAttribute?.('data-message-content')||nested?.dataset?.messageContent||'');if(nv)return nv;const semantic=n.querySelector?.('[data-is-message-text]');return clean(semantic?.innerText||semantic?.textContent||n.innerText||n.textContent||'')}catch{return ''}};
    const matches=[...document.querySelectorAll('[data-message-id]')].filter(n=>String(n.getAttribute('data-message-id')||n.dataset?.messageId||'')===id);
    if(!matches.length)return null;
    const ranked=matches.map(n=>{const r=n.getBoundingClientRect?.()||{left:0,top:0};const inActive=!!activeChatRoot&&activeChatRoot.contains?.(n);const sameText=!source||clean(textOf(n))===clean(source);return{n,inActive,sameText,visible:visible(n),left:Number(r.left||0),top:Number(r.top||0)}}).sort((a,b)=>Number(b.inActive)-Number(a.inActive)||Number(b.sameText)-Number(a.sameText)||Number(b.visible)-Number(a.visible)||b.left-a.left||b.top-a.top);
    return ranked[0]?.n||null;
  })()`;
  return `(()=>{const id=${raw};for(const b of document.querySelectorAll('.bubble[data-mid]')){if(String(b.getAttribute('data-mid')||b.dataset?.mid||'')!==id)continue;return b.querySelector('.message')||b.querySelector('.text-content,.translatable-message,[dir="auto"]')||b;}return null;})()`;
}

function buildMarkScript(platform,id,text,state,value='') {
  const lookup=hostLookupExpression(platform,id,text);
  const source=JSON.stringify(String(text||''));
  const payload=JSON.stringify(String(value||''));
  const visualText = state === 'pending' ? '翻译中…' : state === 'ok' ? String(value||'') : state === 'error' ? String(value||'翻译失败，稍后自动重试') : '';
  const visualPayload = JSON.stringify(visualText);
  const visualState = JSON.stringify(String(state||''));
  return `(()=>{try{const host=${lookup};if(!host)return false;
`+
    `const STYLE_ID='yoko-main-fallback-translation-style';if(!document.getElementById?.(STYLE_ID)){const st=document.createElement?.('style');if(st){st.id=STYLE_ID;st.textContent='[data-yoko-main-fallback-render="1"]::after{content:none!important;display:none!important}.yoko-main-fallback-translation{display:block!important;box-sizing:border-box!important;width:auto!important;max-width:100%!important;margin:5px 1px 0!important;padding:5px 1px 0!important;border-radius:0!important;white-space:pre-wrap!important;word-break:break-word!important;font:12px/1.5 "Microsoft YaHei",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;background:transparent!important;color:#3f6659!important;border:0!important;border-top:1px solid rgba(64,91,82,.14)!important;box-shadow:none!important;pointer-events:none!important}.yoko-main-fallback-translation[data-state="pending"]{background:transparent!important;color:#8a9490!important;border-top-color:rgba(90,100,96,.10)!important;font-style:italic!important}.yoko-main-fallback-translation[data-state="error"]{background:transparent!important;color:#b05b5b!important;border-top-color:rgba(176,91,91,.14)!important}';(document.head||document.documentElement||document.body)?.appendChild?.(st);}}
`+
    `host.classList.add('yoko-global-translated-host');host.setAttribute('data-yoko-main-fallback-render','1');host.setAttribute('data-yoko-global-source',${source});host.setAttribute('data-yoko-global-translation-mode','bilingual');host.removeAttribute('data-yoko-global-translating');host.removeAttribute('data-yoko-global-translation-error');host.removeAttribute('data-yoko-global-translation');host.removeAttribute('data-yoko-global-translation-noop');
`+
    `let row=host.querySelector?.(':scope > .yoko-main-fallback-translation')||host.querySelector?.('.yoko-main-fallback-translation');`+
    `${state==='noop'?`if(row)row.remove?.();host.removeAttribute('data-yoko-main-fallback-render');host.setAttribute('data-yoko-global-translation-noop','1');`:state==='pending'?`host.setAttribute('data-yoko-global-translating','1');if(!row&&document.createElement){row=document.createElement('div');row.className='yoko-main-fallback-translation';row.setAttribute('aria-live','polite');host.appendChild(row);}if(row){row.dataset.state=${visualState};row.dataset.yokoOriginal=${source};row.textContent=${visualPayload};}`:state==='ok'?`host.setAttribute('data-yoko-global-translation',${payload});if(!row&&document.createElement){row=document.createElement('div');row.className='yoko-main-fallback-translation';row.setAttribute('aria-live','polite');host.appendChild(row);}if(row){row.dataset.state=${visualState};row.dataset.yokoOriginal=${source};row.textContent=${visualPayload};}`:state==='error'?`host.setAttribute('data-yoko-global-translation-error',${payload});if(!row&&document.createElement){row=document.createElement('div');row.className='yoko-main-fallback-translation';row.setAttribute('aria-live','polite');host.appendChild(row);}if(row){row.dataset.state=${visualState};row.dataset.yokoOriginal=${source};row.textContent=${visualPayload};}`:''}`+
    `return true;}catch{return false;}})()`;
}

function createNativeWebTranslationFallback({getSettings,translateIncoming,intervalMs=900}={}) {
  if(typeof getSettings!=='function'||typeof translateIncoming!=='function') throw new TypeError('native fallback requires getSettings + translateIncoming');
  const entries=new Map();
  const state=new Map();
  const completed=new Map();
  const inFlight=new Set();
  const tickBusy=new Set();
  const retryAfter=new Map();
  const MAX_COMPLETED=2500;
  const diagFor=(key,entry)=>{
    let d=state.get(key); if(!d){d={version:'v127196-main-native-web-translation-fallback',platform:entry.platform,accountId:entry.accountId,ticks:0,lastTickAt:0,lastStage:'idle',snapshotCount:0,customerCount:0,translatedCount:0,errorCount:0,busySkipCount:0,lastSuccessAt:0,lastErrorAt:0,lastError:''};state.set(key,d);} return d;
  };
  const trimCompleted=()=>{while(completed.size>MAX_COMPLETED)completed.delete(completed.keys().next().value);};
  async function tick(key){
    const entry=entries.get(key); if(!entry)return false; const d=diagFor(key,entry); d.ticks++; d.lastTickAt=Date.now();
    // V1.27.192: executeJavaScript waits on the LINE/TG renderer. If a renderer
    // is temporarily unresponsive, never stack another 900ms snapshot request
    // behind the still-pending one; that queue can make recovery progressively
    // worse. One in-flight snapshot per account is the hard upper bound.
    if(tickBusy.has(key)){d.busySkipCount=Number(d.busySkipCount||0)+1;d.lastStage='tick-busy';return false;}
    tickBusy.add(key);
    try{
      if(entry.webContents?.isDestroyed?.()||!entry.isActive?.()){d.lastStage='inactive';return false;}
      const settings=getSettings({platform:entry.platform,accountId:entry.accountId})||{};
      if(!settings.enabled||!settings.providerReady){d.lastStage='provider-not-ready';return false;}
      const script=scriptForSnapshot(entry.platform); if(!script){d.lastStage='unsupported';return false;}
      d.lastStage='snapshot';
      const rows=await entry.webContents.executeJavaScript(script,true);
      const list=Array.isArray(rows)?rows.filter(row=>row&&row.role==='customer'&&String(row.text||'').trim()):[];
      d.snapshotCount=Array.isArray(rows)?rows.length:0; d.customerCount=list.length;
      let started=0;
      for(const row of list.slice(-10).reverse()){
        if(row.translated)continue;
        const fingerprint=`${entry.platform}|${entry.accountId}|${String(row.id||'')}|${String(row.text||'')}`;
        const done=completed.get(fingerprint);
        // V1.27.193: LINE/Telegram React can remount an already translated row.
        // Rehydrate the visible Chinese from our completed cache instead of
        // permanently skipping the same fingerprint after its DOM was replaced.
        if(done&&typeof done==='object'){
          if(done.kind==='ok'&&done.value){
            await entry.webContents.executeJavaScript(buildMarkScript(entry.platform,row.id,row.text,'ok',done.value),true).catch(()=>false);
            d.lastStage='rehydrated'; d.lastSuccessAt=Date.now();
          }else if(done.kind==='noop'){
            await entry.webContents.executeJavaScript(buildMarkScript(entry.platform,row.id,row.text,'noop'),true).catch(()=>false);
            d.lastStage='noop-rehydrated';
          }
          continue;
        }
        if(inFlight.has(fingerprint)||Number(retryAfter.get(fingerprint)||0)>Date.now())continue;
        inFlight.add(fingerprint); started++;
        await entry.webContents.executeJavaScript(buildMarkScript(entry.platform,row.id,row.text,'pending'),true).catch(()=>false);
        (async()=>{
          try{
            d.lastStage='provider';
            const translated=String(await translateIncoming({platform:entry.platform,accountId:entry.accountId,text:String(row.text||''),source:settings.source||'auto',target:settings.target||'zh'})||'').trim();
            if(translated&&translated!==String(row.text||'').trim()){
              const visibleTranslation=translated;
              await entry.webContents.executeJavaScript(buildMarkScript(entry.platform,row.id,row.text,'ok',visibleTranslation),true).catch(()=>false);
              completed.set(fingerprint,{at:Date.now(),kind:'ok',value:visibleTranslation});trimCompleted();d.translatedCount++;d.lastSuccessAt=Date.now();d.lastError='';d.lastStage='translated';
            }else{
              await entry.webContents.executeJavaScript(buildMarkScript(entry.platform,row.id,row.text,'noop'),true).catch(()=>false);
              completed.set(fingerprint,{at:Date.now(),kind:'noop',value:''});trimCompleted();d.lastStage='noop';
            }
          }catch(error){
            retryAfter.set(fingerprint,Date.now()+8000);d.errorCount++;d.lastErrorAt=Date.now();d.lastError=String(error?.message||error).slice(0,240);d.lastStage='error';
            await entry.webContents.executeJavaScript(buildMarkScript(entry.platform,row.id,row.text,'error','翻译失败，稍后自动重试'),true).catch(()=>false);
          }finally{inFlight.delete(fingerprint);}
        })();
        if(started>=3)break;
      }
      if(!started)d.lastStage=list.length?'idle-caught-up':'no-customer-candidates';
      return true;
    }catch(error){d.errorCount++;d.lastErrorAt=Date.now();d.lastError=String(error?.message||error).slice(0,240);d.lastStage='snapshot-error';return false;}
    finally{tickBusy.delete(key);}
  }
  function register({key,platform,accountId,webContents,isActive}){
    key=String(key||`${platform}:${accountId}`);unregister(key);
    const entry={key,platform:String(platform||''),accountId:String(accountId||''),webContents,isActive:typeof isActive==='function'?isActive:()=>true,timer:null};
    entries.set(key,entry);diagFor(key,entry);
    entry.timer=setInterval(()=>tick(key).catch(()=>false),Math.max(500,Number(intervalMs)||900));entry.timer.unref?.();
    setTimeout(()=>tick(key).catch(()=>false),250);return key;
  }
  function unregister(key){key=String(key||'');const entry=entries.get(key);if(entry?.timer)clearInterval(entry.timer);entries.delete(key);tickBusy.delete(key);}
  function diagnostics(){return [...state.values()].map(v=>({...v}));}
  function stopAll(){for(const key of [...entries.keys()])unregister(key);}
  return {register,unregister,tick,diagnostics,stopAll,_scripts:{LINE_SNAPSHOT_SCRIPT,TELEGRAM_SNAPSHOT_SCRIPT,buildMarkScript}};
}

module.exports={LINE_SNAPSHOT_SCRIPT,TELEGRAM_SNAPSHOT_SCRIPT,buildMarkScript,createNativeWebTranslationFallback};
