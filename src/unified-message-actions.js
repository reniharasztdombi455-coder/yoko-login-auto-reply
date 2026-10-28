'use strict';

// V1.27.68 — Meta customer-switch wake + guaranteed hidden message signal; keeps V1.27.64 sticky toolbar stability.
// Keeps V1.27.61 strict normalization and additionally removes any legacy copy-only
// control that survives beside the unified toolbar after React hydration.
//
// Important design rule: platform preloads remain the authority for deciding
// which DOM nodes are genuine incoming/customer messages. Those preloads may
// expose more than one nested candidate while Meta/React hydrates the same
// bubble. V1.27.51 enhanced every candidate and could therefore render many
// duplicate action rows. V1.27.53 treats those rows only as signals, clusters
// signals that belong to the same visible message, hides the raw signal rows,
// and renders exactly ONE delegated action bar per customer message.
//
// The action bridge is dual-path: console-message remains the fast path while a
// tiny active-view queue is a fallback for Electron/Chromium builds that drop
// console events. Buttons use document-level event delegation so React DOM
// cloning cannot produce visually-correct but dead controls.

const UNIFIED_MESSAGE_ACTION_PREFIX = '__YOKO_UNIFIED_ACTION_V12754__:';

const UNIFIED_MESSAGE_ACTION_CSS = `
.yoko-v12754-actionbar {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: flex-end !important;
  gap: 4px !important;
  width: max-content !important;
  max-width: 100% !important;
  margin: 2px 2px 0 auto !important;
  padding: 0 !important;
  min-height: 20px !important;
  overflow: hidden !important;
  white-space: nowrap !important;
  pointer-events: auto !important;
  position: relative !important;
  z-index: 2147482000 !important;
  vertical-align: top !important;
}
.yoko-v12754-actionbar button,
.yoko-v12754-message-action {
  appearance: none !important;
  border: 0 !important;
  border-radius: 5px !important;
  background: rgba(255,255,255,.92) !important;
  color: #58666f !important;
  box-shadow: inset 0 0 0 1px rgba(120,130,138,.22) !important;
  padding: 0 !important;
  min-width: 19px !important;
  width: 19px !important;
  height: 19px !important;
  line-height: 19px !important;
  text-align: center !important;
  font: 600 12px/19px -apple-system,BlinkMacSystemFont,"Segoe UI Symbol","Microsoft YaHei",sans-serif !important;
  white-space: nowrap !important;
  cursor: pointer !important;
  pointer-events: auto !important;
  flex: 0 0 auto !important;
}
.yoko-v12754-actionbar button:hover,
.yoko-v12754-message-action:hover {
  background: #fff !important;
  color: #16764a !important;
}
.yoko-v12754-actionbar button:disabled,
.yoko-v12754-message-action:disabled {
  opacity: .58 !important;
  cursor: default !important;
}
#yoko-v12754-composer-paste,
#yoko-v12765-composer-clear {
  position: fixed !important;
  z-index: 2147483000 !important;
  appearance: none !important;
  border: 1px solid rgba(96,112,126,.26) !important;
  border-radius: 7px !important;
  background: rgba(255,255,255,.97) !important;
  color: #43515b !important;
  box-shadow: 0 1px 5px rgba(0,0,0,.08) !important;
  height: 27px !important;
  min-width: 52px !important;
  padding: 0 10px !important;
  font: 600 11px/25px -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif !important;
  cursor: pointer !important;
  pointer-events: auto !important;
}
#yoko-v12754-composer-paste:hover,
#yoko-v12765-composer-clear:hover { color:#16764a !important; border-color:rgba(22,118,74,.38) !important; }
#yoko-v12754-composer-paste[data-busy="1"],
#yoko-v12765-composer-clear[data-busy="1"] { opacity:.65 !important; cursor:default !important; }
`;

const UNIFIED_MESSAGE_ACTION_SCRIPT = String.raw`(() => {
  const ROOT_MARKER='data-yoko-unified-message-actions';
  const markOwner=()=>{try{document.documentElement?.setAttribute(ROOT_MARKER,'v12765')}catch{}};
  markOwner();
  if (window.__yokoUnifiedMessageActionsV12754) {
    try { window.__yokoUnifiedMessageActionsV12754.scan(); } catch {}
    return true;
  }
  const PREFIX='__YOKO_UNIFIED_ACTION_V12754__:';
  const clean=value=>String(value||'').replace(/\u200b/g,'').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
  const toolbarOnly=value=>/^(?:(?:⧉|↻|↗)?\s*(?:复制|重译|GPT)\s*){1,6}$/i.test(clean(value).replace(/\s+/g,''));
  const stripToolbarLeak=value=>{const tail=/\s*(?:⧉\s*)?复制\s*(?:↻\s*)?重译\s*(?:↗\s*)?GPT\s*$/i;return clean(value).split('\n').map(line=>toolbarOnly(line)?'':String(line||'').replace(tail,'').trimEnd()).filter(line=>!toolbarOnly(line)).join('\n').trim()};
  const visible=el=>{if(!el||!(el instanceof Element))return false;const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>8&&r.height>8&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0};
  const queue=[];
  const barSeenAt=new WeakMap();
  const emit=(action,payload={})=>{try{const request={rid:'ua-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10),action,...payload,at:Date.now()};queue.push(request);while(queue.length>24)queue.shift();console.info(PREFIX+JSON.stringify(request));return request.rid}catch{return ''}};
  const drain=()=>queue.splice(0,queue.length);
  const tokenFor=host=>{if(!host)return '';let token=String(host.getAttribute('data-yoko-v12754-action-token')||'');if(!token){token='ya-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);try{host.setAttribute('data-yoko-v12754-action-token',token)}catch{}}return token};
  const sourceFromSingleHost=host=>{if(!host)return '';const attr=stripToolbarLeak(host.getAttribute?.('data-yoko-global-source')||'');if(attr&&!toolbarOnly(attr))return attr;const line=host.querySelector?.(':scope > .yoko-inline-translation');const original=stripToolbarLeak(line?.dataset?.yokoOriginal||'');if(original&&!toolbarOnly(original))return original;try{const clone=host.cloneNode(true);clone.querySelectorAll?.('.yoko-global-message-actions,.yoko-inline-actions,.yoko-inline-translation,.yoko-v12754-actionbar,[data-yoko-ui="1"]').forEach(el=>el.remove());const text=stripToolbarLeak(clone.innerText||clone.textContent||'');return text&&!toolbarOnly(text)?text:''}catch{return ''}};
  const sourceFromHost=host=>{if(!host)return '';let node=host;let baseRect=null;try{baseRect=host.getBoundingClientRect()}catch{}for(let depth=0;node&&depth<5;depth+=1,node=node.parentElement){if(depth>=1&&baseRect){try{const r=node.getBoundingClientRect();if(r.height>Math.max(360,baseRect.height+220)||r.width>Math.max(960,baseRect.width*3.2))break}catch{}}const text=sourceFromSingleHost(node);if(text)return text}return ''};
  const sourceNearBar=bar=>{try{if(!(bar instanceof Element))return '';const br=bar.getBoundingClientRect(),candidates=[];const add=(el,bonus=0)=>{if(!(el instanceof Element)||el===bar||el.contains?.(bar))return;let text=sourceFromSingleHost(el);text=stripToolbarLeak(text);if(!text||toolbarOnly(text))return;let r;try{r=el.getBoundingClientRect()}catch{return}if(r.width<8||r.height<8)return;const vgap=r.bottom<=br.top+8?Math.max(0,br.top-r.bottom):Math.max(0,r.top-br.bottom);const hover=Math.max(0,Math.min(r.right,br.right)-Math.max(r.left,br.left));const hratio=hover/Math.max(1,Math.min(r.width,br.width));if(vgap>180||hratio<.08)return;const score=vgap*4+Math.abs(((r.left+r.right)-(br.left+br.right))/2)*.08-Math.min(120,bonus);candidates.push({text,score,r})};let prev=bar.previousElementSibling;for(let i=0;prev&&i<6;i++,prev=prev.previousElementSibling)add(prev,140-i*12);let parent=bar.parentElement;for(let d=0;parent&&d<5;d++,parent=parent.parentElement){for(const child of Array.from(parent.children||[]))if(child!==bar&&!child.contains?.(bar))add(child,90-d*10)}for(const el of Array.from(document.querySelectorAll('[data-yoko-global-source],.yoko-global-translated-host')).slice(-220))add(el,40);candidates.sort((a,b)=>a.score-b.score);return candidates[0]?.text||''}catch{return ''}};
  const sourceForToken=token=>{try{const bar=document.querySelector('.yoko-v12754-actionbar[data-token="'+CSS.escape(String(token||''))+'"]');if(!bar)return '';const direct=sourceFromHost(bar.parentElement);if(direct&&!toolbarOnly(direct))return direct;const stored=stripToolbarLeak(bar.dataset.source||'');if(stored&&!toolbarOnly(stored))return stored;return sourceNearBar(bar)}catch{return ''}};
  const setHiddenSignal=actions=>{try{actions.setAttribute('data-yoko-v12754-signal','1');actions.style.setProperty('display','none','important');actions.style.setProperty('width','0','important');actions.style.setProperty('height','0','important');actions.style.setProperty('min-height','0','important');actions.style.setProperty('margin','0','important');actions.style.setProperty('padding','0','important');actions.style.setProperty('overflow','hidden','important')}catch{}};
  const overlapRatio=(a,b)=>{const overlap=Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));return overlap/Math.max(1,Math.min(a.height,b.height))};
  const horizontalOverlapRatio=(a,b)=>{const overlap=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left));return overlap/Math.max(1,Math.min(a.width,b.width))};
  const visualCenterY=r=>(Number(r?.top||0)+Number(r?.bottom||0))/2;
  const domNested=(a,b)=>{try{return a?.host===b?.host||a?.host?.contains?.(b?.host)||b?.host?.contains?.(a?.host)}catch{return false}};
  // V1.27.58: source text is NOT a valid message identity. Meta can stamp the
  // same physical bubble on several nested React nodes with slightly different
  // text snapshots (reply context / translation hydration / inline controls).
  // Canonicalize by the physical bubble first. This is the actual invariant:
  // nested/overlapping nodes in the same visual row are one message root.
  const sameVisualMessage=(a,b)=>{
    if(!a?.rect||!b?.rect)return false;
    const vo=overlapRatio(a.rect,b.rect),ho=horizontalOverlapRatio(a.rect,b.rect),dy=Math.abs(visualCenterY(a.rect)-visualCenterY(b.rect));
    if(domNested(a,b)&&vo>=.38&&ho>=.30)return true;
    if(vo>=.72&&ho>=.58&&dy<=18)return true;
    return false;
  };
  const collectClusters=()=>{
    const signals=[];
    for(const actions of document.querySelectorAll('.yoko-global-message-actions,.yoko-inline-actions')){
      if(!(actions instanceof Element)||!actions.isConnected)continue;
      // Our visible toolbar deliberately carries yoko-global-message-actions so
      // every sealed platform text extractor strips it before translation. It
      // must never be re-consumed as a native signal.
      if(actions.classList.contains('yoko-v12754-actionbar'))continue;
      const host=actions.parentElement;if(!host)continue;
      const source=sourceFromHost(host);if(!source)continue;
      const rect=host.getBoundingClientRect();if(rect.width<20||rect.height<12||rect.bottom<0||rect.top>innerHeight)continue;
      setHiddenSignal(actions);
      // V1.27.62: signal rows are evidence only; they must never retain a
      // clickable legacy Copy child beside the unified three-button toolbar.
      try{actions.querySelectorAll('button,.yoko-global-copy-message').forEach(btn=>btn.remove())}catch{}
      signals.push({actions,host,source,rect,area:Math.max(1,rect.width*rect.height)});
    }
    const clusters=[];
    for(const item of signals){let cluster=clusters.find(c=>c.items.some(prev=>sameVisualMessage(prev,item)));if(!cluster){cluster={items:[]};clusters.push(cluster)}cluster.items.push(item)}
    return clusters;
  };
  const ensureActionBar=(host,source)=>{
    source=stripToolbarLeak(source);if(!host?.isConnected||!source||toolbarOnly(source))return null;
    markOwner();
    try{
      host.querySelectorAll('.yoko-global-message-actions:not(.yoko-v12754-actionbar),.yoko-inline-actions:not(.yoko-v12754-actionbar)').forEach(row=>{setHiddenSignal(row);row.querySelectorAll('button,.yoko-global-copy-message').forEach(btn=>btn.remove())});
      host.querySelectorAll(':scope > .yoko-global-copy-message').forEach(btn=>btn.remove());
    }catch{}
    let bars=[];try{bars=[...host.children].filter(el=>el?.classList?.contains('yoko-v12754-actionbar'))}catch{}
    let bar=bars.shift()||null;for(const extra of bars)try{extra.remove()}catch{}
    // V1.27.78: per-message GPT was removed by product decision. Keep only two
    // compact icon actions on the lower-right of each customer message.
    const defs=[['copy','⧉','复制这条客户消息原文'],['retranslate','↻','重新翻译这条客户消息']];
    const exactStable=()=>{
      try{
        if(!bar||!bar.isConnected||bar.parentElement!==host)return false;
        if(!bar.classList.contains('yoko-global-message-actions')||!bar.classList.contains('yoko-v12754-actionbar'))return false;
        if(String(bar.dataset.source||'')!==source)return false;
        const children=[...bar.children];
        if(children.length!==2)return false;
        for(let i=0;i<defs.length;i++){
          const [action,label,title]=defs[i],btn=children[i];
          if(!(btn instanceof HTMLButtonElement))return false;
          if(String(btn.dataset.yokoV12754Action||'')!==action)return false;
          if(!btn.classList.contains('yoko-v12754-message-action'))return false;
          if(btn.dataset.busy!=='1'&&btn.textContent!==label)return false;
          if(btn.title!==title)return false;
        }
        return true;
      }catch{return false}
    };
    if(exactStable()){
      barSeenAt.set(bar,Date.now());
      return bar;
    }
    if(!bar){bar=document.createElement('div');bar.className='yoko-global-message-actions yoko-v12754-actionbar';bar.dataset.yokoUi='1';try{host.appendChild(bar)}catch{return null}}
    else {
      if(!bar.classList.contains('yoko-global-message-actions'))bar.classList.add('yoko-global-message-actions');
      if(bar.dataset.yokoUi!=='1')bar.dataset.yokoUi='1';
    }
    const token=tokenFor(host);
    if(bar.dataset.token!==token)bar.dataset.token=token;
    if(bar.dataset.source!==source)bar.dataset.source=source;
    barSeenAt.set(bar,Date.now());
    bar.querySelectorAll('.yoko-global-copy-message').forEach(btn=>btn.remove());
    const valid=new Set(defs.map(d=>d[0]));
    const slots=new Map();
    for(const child of [...bar.children]){
      if(!(child instanceof Element))continue;
      const action=String(child.getAttribute('data-yoko-v12754-action')||'');
      if(child.tagName!=='BUTTON'||!valid.has(action)||slots.has(action)){try{child.remove()}catch{};continue}
      slots.set(action,child);
    }
    for(let i=0;i<defs.length;i++){
      const [action,label,title]=defs[i];
      let btn=slots.get(action)||null;
      if(!btn){btn=document.createElement('button');btn.type='button';btn.className='yoko-v12754-message-action';btn.dataset.yokoV12754Action=action;slots.set(action,btn)}
      if(!btn.classList.contains('yoko-v12754-message-action'))btn.classList.add('yoko-v12754-message-action');
      if(btn.dataset.busy!=='1'&&btn.textContent!==label)btn.textContent=label;
      if(btn.title!==title)btn.title=title;
      const expected=bar.children[i]||null;
      if(expected!==btn){try{bar.insertBefore(btn,expected)}catch{}}
    }
    for(const child of [...bar.children]){
      if(!(child instanceof Element))continue;
      const action=String(child.getAttribute('data-yoko-v12754-action')||'');
      if(child.tagName!=='BUTTON'||!valid.has(action)||slots.get(action)!==child)try{child.remove()}catch{}
    }
    return bar;
  };
  const canonicalizeActions=()=>{
    // V1.27.56: ONE authority creates the visible toolbar. Legacy preload rows
    // and translated-lane rows are evidence only. In V1.27.54/55 these two
    // evidence paths each called ensureActionBar(), so the same Meta bubble
    // could receive two complete Copy/Retranslate/GPT toolbars. Merge every
    // evidence source first, then create exactly one toolbar per visual message.
    const candidates=[];
    for(const cluster of collectClusters()){
      cluster.items.sort((a,b)=>a.area-b.area);
      const chosen=cluster.items[0];if(!chosen)continue;
      candidates.push({...chosen,evidence:'platform-signal'});
    }
    try{
      for(const row of directTranslatedRows()){
        if(row.role!=='customer'||!row.host?.isConnected||!row.text)continue;
        const candidate={host:row.host,source:row.text,rect:{top:row.top,bottom:row.bottom,left:row.left,right:row.right,width:Math.max(1,row.right-row.left),height:Math.max(1,row.bottom-row.top)},area:row.area,evidence:'translated-lane'};
        const duplicate=candidates.some(prev=>sameVisualMessage(prev,candidate));
        if(!duplicate)candidates.push(candidate);
      }
    }catch{}
    const clusters=[];
    for(const item of candidates){
      let cluster=clusters.find(c=>c.items.some(prev=>sameVisualMessage(prev,item)));
      if(!cluster){cluster={items:[]};clusters.push(cluster)}
      cluster.items.push(item);
    }
    // V1.27.64: a toolbar is a STICKY visual child of the first stable message
    // host that received it. Meta frequently exposes the same bubble through a
    // different nested React wrapper on the next hydration pass. Reparenting or
    // removing the toolbar changes bubble height and makes the virtual scroller
    // jump. Therefore: prefer an already-live toolbar that visually matches this
    // message and NEVER remove a toolbar merely because one evidence pass missed
    // it. When Meta removes the message DOM, the toolbar disappears with it.
    const liveBars=[...document.querySelectorAll('.yoko-v12754-actionbar')]
      .filter(bar=>bar instanceof Element&&bar.isConnected&&bar.parentElement)
      .map(bar=>{const host=bar.parentElement,r=host.getBoundingClientRect();return {bar,host,source:sourceFromHost(host)||stripToolbarLeak(bar.dataset.source||''),rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:Math.max(1,r.width),height:Math.max(1,r.height)},area:Math.max(1,r.width*r.height)}});
    const usedBars=new Set();
    for(const cluster of clusters){
      cluster.items.sort((a,b)=>{const as=a.host?.hasAttribute?.('data-yoko-global-source')?0:1,bs=b.host?.hasAttribute?.('data-yoko-global-source')?0:1;const ap=a.evidence==='platform-signal'?0:1,bp=b.evidence==='platform-signal'?0:1;return as-bs||ap-bp||a.area-b.area});
      const chosen=cluster.items[0];if(!chosen)continue;
      const sticky=liveBars.find(x=>!usedBars.has(x.bar)&&sameVisualMessage(x,chosen));
      if(sticky){
        usedBars.add(sticky.bar);
        ensureActionBar(sticky.host,chosen.source||sticky.source);
        continue;
      }
      const bar=ensureActionBar(chosen.host,chosen.source);if(bar)usedBars.add(bar);
    }
    // Deliberately no visible-toolbar cleanup here. A connected toolbar may be
    // temporarily absent from evidence while Meta hydrates/recycles wrappers.
    // Removing it would shrink the bubble and move scrollTop. One-host duplicate
    // normalization is already enforced inside ensureActionBar().
  };
  const editorCandidates=()=>{
    const selectors=['textarea','[contenteditable="true"][role="textbox"]','[contenteditable="true"]','input[type="text"]'];
    const out=[],seen=new Set();
    for(const sel of selectors){for(const el of document.querySelectorAll(sel)){if(seen.has(el)||!visible(el))continue;seen.add(el);const r=el.getBoundingClientRect();if(r.bottom<innerHeight*.55||r.width<180)continue;const meta=[el.getAttribute('placeholder'),el.getAttribute('aria-label'),el.getAttribute('name'),el.getAttribute('role')].filter(Boolean).join(' ').toLowerCase();if(/search|搜索|查找|filter|筛选|comment search/i.test(meta))continue;if(el.closest('header,nav,[role="navigation"],[data-yoko-ui="1"]'))continue;out.push({el,r})}}
    out.sort((a,b)=>{const ab=Math.abs(innerHeight-a.r.bottom),bb=Math.abs(innerHeight-b.r.bottom);if(ab!==bb)return ab-bb;return b.r.width-a.r.width});
    return out;
  };
  const currentEditor=()=>editorCandidates()[0]?.el||null;
  const readEditor=el=>String((el&&'value'in el?el.value:(el?.innerText||el?.textContent||''))||'').replace(/\u200b/g,'');
  const appendComposerDirect=(incoming='',expectedBefore='')=>{const el=document.querySelector('[data-yoko-v12754-composer-target="1"]')||currentEditor();if(!el)return {ok:false,error:'没有找到当前聊天发送框'};const before=readEditor(el);if(String(before)!==String(expectedBefore||''))return {ok:false,conflict:true,before};const text=String(incoming||'');if(!text)return {ok:false,error:'没有要粘贴的文字'};try{el.focus({preventScroll:true})}catch{try{el.focus()}catch{}};try{
    if('value'in el){const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const desc=Object.getOwnPropertyDescriptor(proto,'value');const next=before+text;try{desc?.set?.call(el,next)}catch{el.value=next}try{el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}))}catch{try{el.dispatchEvent(new Event('input',{bubbles:true}))}catch{}}}
    else{let inserted=false;try{const sel=getSelection();const range=document.createRange();range.selectNodeContents(el);range.collapse(false);sel.removeAllRanges();sel.addRange(range);inserted=document.execCommand('insertText',false,text)===true}catch{}if(!inserted||readEditor(el)===before){try{const sel=getSelection();const range=document.createRange();range.selectNodeContents(el);range.collapse(false);const node=document.createTextNode(text);range.insertNode(node);range.setStartAfter(node);range.collapse(true);sel.removeAllRanges();sel.addRange(range)}catch{}try{el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}))}catch{try{el.dispatchEvent(new Event('input',{bubbles:true}))}catch{}}}}
    const after=readEditor(el);return {ok:after!==before&&after.length>before.length,before,after};
  }catch(e){return {ok:false,error:String(e?.message||e),before,after:readEditor(el)}}};
  const composerShellRect=el=>{
    const er=el?.getBoundingClientRect?.();if(!er)return null;let best=er,p=el.parentElement;
    for(let depth=0;p&&depth<7;depth+=1,p=p.parentElement){if(!(p instanceof Element)||!visible(p))continue;const r=p.getBoundingClientRect();if(r.width<er.width*.82||r.width>Math.min(innerWidth*.98,er.width*1.48))continue;if(r.height<er.height||r.height>230)continue;if(r.bottom<er.bottom-28||r.bottom>innerHeight+12)continue;if(r.top<best.top)best=r}
    return best;
  };
  const translatedLaneRole=(r,lane)=>{
    if(!r||!lane)return '';const width=Math.max(1,lane.width||1);const leftGap=Math.max(0,r.left-lane.left),rightGap=Math.max(0,lane.right-r.right);const center=(((r.left+r.right)/2)-lane.left)/width;const edge=Math.max(54,Math.min(108,width*.22));const nearLeft=leftGap<=edge,nearRight=rightGap<=edge;
    if(nearLeft&&!nearRight)return 'customer';if(nearRight&&!nearLeft)return 'me';if(nearLeft&&nearRight){if(center<=.47)return 'customer';if(center>=.61)return 'me'}
    if(leftGap+18<rightGap*.58)return 'customer';if(rightGap+18<leftGap*.58)return 'me';if(center<=.43)return 'customer';if(center>=.68)return 'me';return '';
  };
  const directTranslatedRows=()=>{
    const editor=currentEditor();if(!editor)return [];const lane=composerShellRect(editor)||editor.getBoundingClientRect();const topFloor=Math.max(50,lane.top-innerHeight*.86);const bottomCeil=lane.top-2;const raw=[];
    const nodes=[...document.querySelectorAll('[data-yoko-global-source],.yoko-global-translated-host')].slice(-220);
    for(const host of nodes){if(!(host instanceof Element)||!host.isConnected||!visible(host))continue;const text=clean(host.getAttribute?.('data-yoko-global-source')||sourceFromHost(host));if(!text)continue;const r=host.getBoundingClientRect();if(r.width<20||r.height<10||r.bottom<topFloor||r.top>bottomCeil)continue;if(r.right<lane.left-12||r.left>lane.right+12)continue;let role='';if(host.querySelector?.(':scope > .yoko-global-message-actions,:scope > .yoko-inline-actions'))role='customer';if(!role)role=translatedLaneRole(r,lane);raw.push({host,text,role,top:r.top,bottom:r.bottom,left:r.left,right:r.right,area:Math.max(1,r.width*r.height)})}
    raw.sort((a,b)=>a.bottom-b.bottom||a.area-b.area);const out=[];
    for(const item of raw){const dup=out.find(prev=>prev.text===item.text&&(Math.min(prev.bottom,item.bottom)-Math.max(prev.top,item.top)>-8));if(!dup){out.push(item);continue}if(item.area<dup.area){const i=out.indexOf(dup);if(i>=0)out[i]=item}}
    return out.slice(-100);
  };
  const prepareComposerPaste=()=>{const el=currentEditor();if(!el)return {ok:false,error:'没有找到当前聊天发送框'};try{document.querySelectorAll('[data-yoko-v12754-composer-target="1"]').forEach(node=>node.removeAttribute('data-yoko-v12754-composer-target'))}catch{}try{el.focus({preventScroll:true})}catch{try{el.focus()}catch{}}if(el.isContentEditable){try{const sel=getSelection();const range=document.createRange();range.selectNodeContents(el);range.collapse(false);sel.removeAllRanges();sel.addRange(range)}catch{}}else if(typeof el.setSelectionRange==='function'){try{const n=String(el.value||'').length;el.setSelectionRange(n,n)}catch{}}try{el.setAttribute('data-yoko-v12754-composer-target','1')}catch{}return {ok:true,before:readEditor(el),tag:String(el.tagName||''),contenteditable:!!el.isContentEditable}};
  const prepareComposerClear=()=>{const el=currentEditor();if(!el)return {ok:false,error:'没有找到当前聊天发送框'};try{document.querySelectorAll('[data-yoko-v12754-composer-target="1"]').forEach(node=>node.removeAttribute('data-yoko-v12754-composer-target'))}catch{}try{el.focus({preventScroll:true})}catch{try{el.focus()}catch{}}try{el.setAttribute('data-yoko-v12754-composer-target','1')}catch{}if(el.isContentEditable){try{const sel=getSelection();const range=document.createRange();range.selectNodeContents(el);sel.removeAllRanges();sel.addRange(range)}catch{}}else if(typeof el.select==='function'){try{el.select()}catch{}}else if(typeof el.setSelectionRange==='function'){try{el.setSelectionRange(0,String(el.value||'').length)}catch{}}return {ok:true,before:readEditor(el),tag:String(el.tagName||''),contenteditable:!!el.isContentEditable}};
  const clearComposerDirect=()=>{const el=document.querySelector('[data-yoko-v12754-composer-target="1"]')||currentEditor();if(!el)return {ok:false,error:'没有找到当前聊天发送框'};try{el.focus({preventScroll:true})}catch{try{el.focus()}catch{}}try{
    if('value' in el){const proto=Object.getPrototypeOf(el);const desc=Object.getOwnPropertyDescriptor(proto,'value')||Object.getOwnPropertyDescriptor(HTMLTextAreaElement?.prototype||{},'value')||Object.getOwnPropertyDescriptor(HTMLInputElement?.prototype||{},'value');if(desc?.set)desc.set.call(el,'');else el.value=''}
    else if(el.isContentEditable){try{document.execCommand('selectAll',false,null);document.execCommand('delete',false,null)}catch{}if(readEditor(el))el.textContent=''}
    else el.textContent='';
    try{el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward',data:null}))}catch{try{el.dispatchEvent(new Event('input',{bubbles:true}))}catch{}}
    try{el.dispatchEvent(new Event('change',{bubbles:true}))}catch{}
    return {ok:!readEditor(el),text:readEditor(el)}
  }catch(e){return {ok:false,error:String(e?.message||e),text:readEditor(el)}}};
  const readComposer=()=>{const el=document.querySelector('[data-yoko-v12754-composer-target="1"]')||currentEditor();return {ok:!!el,text:el?readEditor(el):''}};
  const ensureComposerButtons=()=>{
    let paste=document.getElementById('yoko-v12754-composer-paste');
    let clear=document.getElementById('yoko-v12765-composer-clear');
    // LINE uses its sealed paste control and receives a separate non-sealed Clear companion.
    if(document.querySelector('.yoko-line-paste-action')){if(paste)paste.style.display='none';if(clear)clear.style.display='none';return}
    const row=editorCandidates()[0]||null;if(!row){if(paste)paste.style.display='none';if(clear)clear.style.display='none';return}
    if(!paste){paste=document.createElement('button');paste.id='yoko-v12754-composer-paste';paste.type='button';paste.dataset.yokoUi='1';paste.dataset.anchor='top-line';paste.textContent='粘贴';paste.title='把 Windows 剪贴板文字粘贴到当前客户发送框（不会自动发送）';document.documentElement.appendChild(paste)}
    if(!clear){clear=document.createElement('button');clear.id='yoko-v12765-composer-clear';clear.type='button';clear.dataset.yokoUi='1';clear.dataset.anchor='top-line';clear.textContent='清空';clear.title='清空当前客户发送框里的全部文字（不会自动发送）';document.documentElement.appendChild(clear)}
    const editorRect=row.el.getBoundingClientRect();const r=composerShellRect(row.el)||editorRect;const buttonW=58,buttonH=27,gap=6,total=buttonW*2+gap;
    // V1.27.65: align the BOTTOM edge of Paste/Clear exactly on the composer top border.
    const left=Math.max(8,Math.min(innerWidth-total-8,r.right-total-8));
    let top=r.top-buttonH;
    if(top<8) top=Math.min(innerHeight-buttonH-8,r.bottom+4);
    for(const [btn,x] of [[paste,left],[clear,left+buttonW+gap]]){btn.style.display='block';btn.style.left=Math.round(x)+'px';btn.style.top=Math.round(top)+'px'}
  };
  const latestCustomerMessage=()=>{
    try{canonicalizeActions()}catch{}
    const rows=[];
    for(const bar of document.querySelectorAll('.yoko-v12754-actionbar')){
      if(!(bar instanceof Element)||!bar.isConnected)continue;
      const text=clean(bar.dataset.source||sourceFromHost(bar.parentElement));if(!text)continue;
      const host=bar.parentElement;const r=(host||bar).getBoundingClientRect();
      if(r.width<20||r.height<10||r.bottom<0||r.top>innerHeight)continue;
      rows.push({text,top:r.top,bottom:r.bottom,left:r.left,right:r.right,detection:'actionbar'});
    }
    const direct=directTranslatedRows();
    for(const item of direct){if(item.role!=='customer'||!item.text)continue;if(rows.some(row=>row.text===item.text&&Math.abs(row.bottom-item.bottom)<=14))continue;rows.push({text:item.text,top:item.top,bottom:item.bottom,left:item.left,right:item.right,detection:'translated-lane'})}
    rows.sort((a,b)=>a.bottom-b.bottom||a.top-b.top);
    const last=rows[rows.length-1];
    return last?{ok:true,...last,count:rows.length,directCount:direct.length,customerDirectCount:direct.filter(x=>x.role==='customer').length}:{ok:false,error:'当前页面没有识别到客户文字气泡',count:0,directCount:direct.length,roles:direct.slice(-8).map(x=>x.role||'?').join(',')};
  };
  const retranslateContextForHost=host=>{try{if(!(host instanceof Element))return[];const hr=host.getBoundingClientRect();const rows=directTranslatedRows().filter(item=>item&&item.text&&item.bottom<=hr.top+2&&(item.role==='customer'||item.role==='me')).sort((a,b)=>a.bottom-b.bottom).slice(-3);return rows.map(item=>({role:item.role==='me'?'me':'customer',text:clean(item.text).slice(0,500)}))}catch{return[]}};
  const labels={copy:'⧉',retranslate:'↻'};
  const setBusy=(btn,action)=>{btn.disabled=true;btn.dataset.busy='1';btn.textContent='…'};
  const restore=(btn,action)=>{if(!btn)return;btn.disabled=false;btn.dataset.busy='0';btn.textContent=labels[action]||'操作'};
  const clickHandler=event=>{
    const paste=event.target?.closest?.('#yoko-v12754-composer-paste');
    if(paste){event.preventDefault();event.stopPropagation();if(paste.dataset.busy==='1')return;paste.dataset.busy='1';paste.textContent='粘贴中…';emit('paste-composer',{token:'composer'});setTimeout(()=>{if(paste?.isConnected&&paste.dataset.busy==='1'){paste.dataset.busy='0';paste.textContent='粘贴';paste.title='粘贴超时，请重试；不会自动发送'}},4500);return}
    const clear=event.target?.closest?.('#yoko-v12765-composer-clear');
    if(clear){event.preventDefault();event.stopPropagation();if(clear.dataset.busy==='1')return;clear.dataset.busy='1';clear.textContent='清空中…';emit('clear-composer',{token:'composer'});return}
    const btn=event.target?.closest?.('[data-yoko-v12754-action]');if(!btn)return;
    const bar=btn.closest('.yoko-v12754-actionbar');if(!bar)return;
    const action=String(btn.dataset.yokoV12754Action||'');if(!['copy','retranslate'].includes(action)||btn.dataset.busy==='1')return;
    const source=sourceForToken(String(bar.dataset.token||''))||sourceFromHost(bar.parentElement)||stripToolbarLeak(bar.dataset.source||'');if(!source||toolbarOnly(source))return;
    event.preventDefault();event.stopPropagation();setBusy(btn,action);emit(action,{token:String(bar.dataset.token||''),text:source,context:action==='retranslate'?retranslateContextForHost(bar.parentElement):[]});
  };
  document.addEventListener('click',clickHandler,true);
  const findBar=token=>{try{return document.querySelector('.yoko-v12754-actionbar[data-token="'+CSS.escape(String(token||''))+'"]')}catch{return null}};
  const resolve=(token,result={})=>{
    const action=String(result.action||'');
    if(action==='paste-composer'){
      const btn=document.getElementById('yoko-v12754-composer-paste');if(!btn)return;
      btn.dataset.busy='0';btn.textContent=result.ok?'✓ 已粘贴':'粘贴失败';btn.title=result.ok?('已粘贴 '+Number(result.length||0)+' 个字符，不会自动发送'):String(result.error||'粘贴失败');setTimeout(()=>{if(!btn.isConnected)return;btn.textContent='粘贴';btn.title='把 Windows 剪贴板文字粘贴到当前客户发送框（不会自动发送）'},1050);return;
    }
    if(action==='clear-composer'){
      const btn=document.getElementById('yoko-v12765-composer-clear');if(!btn)return;
      btn.dataset.busy='0';btn.textContent=result.ok?'✓ 已清空':'清空失败';btn.title=result.ok?String(result.message||'当前发送框已清空，不会自动发送'):String(result.error||'清空失败');setTimeout(()=>{if(!btn.isConnected)return;btn.textContent='清空';btn.title='清空当前客户发送框里的全部文字（不会自动发送）'},1050);return;
    }
    const bar=findBar(token);const btn=bar?.querySelector?.('[data-yoko-v12754-action="'+action+'"]');if(!bar||!btn)return;
    const host=bar.parentElement;
    if(action==='retranslate'&&result.ok&&clean(result.translated)&&host){
      const translated=clean(result.translated);const mode=String(host.getAttribute('data-yoko-global-translation-mode')||host.querySelector?.(':scope > .yoko-inline-translation')?.dataset?.mode||'bilingual');
      if(host.hasAttribute('data-yoko-global-source')){host.removeAttribute('data-yoko-global-translating');host.removeAttribute('data-yoko-global-translation-error');host.removeAttribute('data-yoko-global-translation-noop');host.setAttribute('data-yoko-global-translation',mode==='simple'?translated:'中文译文：'+translated)}
      const line=host.querySelector?.(':scope > .yoko-inline-translation');if(line){delete line.dataset.status;line.dataset.mode=mode;line.textContent=mode==='simple'?translated:'中文译文：'+translated}
    }
    if(result.ok){btn.textContent='✓';btn.title=String(result.message||'操作成功')}else{btn.textContent='!';btn.title=String(result.error||'操作失败')}
    btn.disabled=false;btn.dataset.busy='0';setTimeout(()=>restore(btn,action),1150);
  };
  let queued=false;
  let actionScrollActiveUntil=0;
  let actionScrollIdleTimer=null;
  const scan=()=>{queued=false;if(Date.now()<actionScrollActiveUntil){schedule(180);return}markOwner();try{canonicalizeActions()}catch{}try{ensureComposerButtons()}catch{}};
  const schedule=(delay=80)=>{if(queued)return;queued=true;setTimeout(scan,Math.max(60,Number(delay||0)))};
  const mutationIsYokoOnly=mutation=>{
    try{
      const target=mutation.target instanceof Element?mutation.target:mutation.target?.parentElement;
      if(target?.closest?.('.yoko-v12754-actionbar,#yoko-v12754-composer-paste,#yoko-v12765-composer-clear,[data-yoko-ui="1"]'))return true;
      const nodes=[...(mutation.addedNodes||[]),...(mutation.removedNodes||[])];
      return !!nodes.length&&nodes.every(node=>{const el=node instanceof Element?node:node?.parentElement;return el instanceof Element&&!!(el.matches?.('.yoko-v12754-actionbar,#yoko-v12754-composer-paste,#yoko-v12765-composer-clear,[data-yoko-ui="1"]')||el.closest?.('.yoko-v12754-actionbar,#yoko-v12754-composer-paste,#yoko-v12765-composer-clear,[data-yoko-ui="1"]'))});
    }catch{return false}
  };
  const observer=new MutationObserver(mutations=>{if(mutations?.length&&mutations.every(mutationIsYokoOnly))return;schedule(100)});try{observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['data-yoko-global-source','data-yoko-global-translation']})}catch{}
  addEventListener('resize',()=>schedule(120),{passive:true});
  addEventListener('scroll',()=>{actionScrollActiveUntil=Date.now()+430;if(actionScrollIdleTimer)clearTimeout(actionScrollIdleTimer);actionScrollIdleTimer=setTimeout(()=>{actionScrollIdleTimer=null;actionScrollActiveUntil=0;schedule(60)},440)},{passive:true,capture:true});
  const timer=setInterval(()=>{if(!document.hidden&&Date.now()>=actionScrollActiveUntil)scan()},1800);
  const api={scan,resolve,prepareComposerPaste,prepareComposerClear,clearComposerDirect,appendComposerDirect,readComposer,latestCustomerMessage,sourceForToken,sourceNearBar,drain,observer,timer};
  window.__yokoUnifiedMessageActionsV12754=api;
  // Read-only compatibility aliases for in-place renderer upgrades.
  window.__yokoUnifiedMessageActionsV12753=api;
  window.__yokoUnifiedMessageActionsV12752=api;
  window.__yokoUnifiedMessageActionsV12751=api;
  scan();return true;
})()`;

function normalizeUnifiedMessageActionRequest(parsed = {}) {
  if (!parsed || typeof parsed !== 'object') return null;
  const action = String(parsed.action || '').trim();
  if (!['copy','retranslate','gpt','paste-composer','clear-composer'].includes(action)) return null;
  return {
    rid:String(parsed.rid || '').slice(0,180),
    action,
    token:String(parsed.token || '').slice(0,180),
    text:String(parsed.text || '').replace(/\u0000/g,'').trim().slice(0,12000),
    context:(Array.isArray(parsed.context)?parsed.context:[]).slice(-3).map(item=>({role:String(item?.role||'context').slice(0,20),text:String(item?.text||'').replace(/\u0000/g,'').trim().slice(0,500)})).filter(item=>item.text),
    at:Number(parsed.at || 0) || 0
  };
}

function parseUnifiedMessageAction(message = '') {
  const raw = String(message || '');
  if (!raw.startsWith(UNIFIED_MESSAGE_ACTION_PREFIX)) return null;
  try { return normalizeUnifiedMessageActionRequest(JSON.parse(raw.slice(UNIFIED_MESSAGE_ACTION_PREFIX.length))); }
  catch { return null; }
}

function resolveUnifiedMessageActionScript(token, result = {}) {
  return `(()=>{try{return window.__yokoUnifiedMessageActionsV12754?.resolve(${JSON.stringify(String(token || ''))},${JSON.stringify(result || {})})??window.__yokoUnifiedMessageActionsV12753?.resolve(${JSON.stringify(String(token || ''))},${JSON.stringify(result || {})})??window.__yokoUnifiedMessageActionsV12751?.resolve(${JSON.stringify(String(token || ''))},${JSON.stringify(result || {})})??false}catch{return false}})()`;
}

async function installUnifiedMessageActions(webContents) {
  if (!webContents || webContents.isDestroyed?.()) return false;
  try { await webContents.insertCSS(UNIFIED_MESSAGE_ACTION_CSS, { cssOrigin:'author' }); } catch {}
  try { await webContents.executeJavaScript(UNIFIED_MESSAGE_ACTION_SCRIPT, true); return true; } catch { return false; }
}

module.exports = {
  UNIFIED_MESSAGE_ACTION_PREFIX,
  UNIFIED_MESSAGE_ACTION_CSS,
  UNIFIED_MESSAGE_ACTION_SCRIPT,
  normalizeUnifiedMessageActionRequest,
  parseUnifiedMessageAction,
  resolveUnifiedMessageActionScript,
  installUnifiedMessageActions
};
