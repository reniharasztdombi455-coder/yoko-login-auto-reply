const api = window.historyApi;
const $ = s => document.querySelector(s);
let conversations = [];
let selectedId = '';
let records = [];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const platformLabel = p => ({line:'LINE',tiktok:'TikTok',facebook:'Facebook',instagram:'Instagram',whatsapp:'WhatsApp',telegram:'Telegram',metabusiness:'Meta Business'}[p] || p || '平台');
const fmtTime = v => { if (!v) return ''; const d = new Date(v); if (Number.isNaN(d.getTime())) return String(v); return d.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).replace(/\//g,'-'); };
const fmtDay = v => { const d = new Date(v); if (Number.isNaN(d.getTime())) return ''; return d.toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'}); };
function filters(){ return { query:$('#searchInput').value, platform:$('#platformFilter').value, accountId:$('#accountFilter').value }; }
function rebuildFilters(){
  const currentP=$('#platformFilter').value,currentA=$('#accountFilter').value;
  const ps=[...new Set(conversations.map(x=>x.platform).filter(Boolean))];
  $('#platformFilter').innerHTML='<option value="">全部平台</option>'+ps.map(p=>`<option value="${esc(p)}">${esc(platformLabel(p))}</option>`).join('');
  if(ps.includes(currentP)) $('#platformFilter').value=currentP;
  const ac=[...new Map(conversations.map(x=>[x.accountId,{id:x.accountId,name:x.accountName||x.accountId,platform:x.platform}])).values()].filter(x=>x.id&&(!$('#platformFilter').value||x.platform===$('#platformFilter').value));
  $('#accountFilter').innerHTML='<option value="">全部账号</option>'+ac.map(a=>`<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
  if(ac.some(x=>x.id===currentA)) $('#accountFilter').value=currentA;
}
async function loadList(keepSelection=true){
  const r=await api.list(filters()); conversations=Array.isArray(r?.conversations)?r.conversations:[]; rebuildFilters();
  $('#conversationCount').textContent=String(conversations.length);
  $('#conversationList').innerHTML=conversations.length?conversations.map(c=>`<button class="conversation-card ${c.id===selectedId?'active':''}" data-id="${esc(c.id)}"><div class="row"><strong>${esc(c.displayName||'客户')}</strong><time>${esc(fmtTime(c.updatedAt))}</time></div><small>${esc(platformLabel(c.platform))} · ${esc(c.accountName||'')}</small><small class="preview">${esc(c.lastPreview||'')}</small></button>`).join(''):'<div class="empty">还没有聊天归档。打开客户聊天后会自动记录。</div>';
  if(!keepSelection&&conversations[0]) await selectConversation(conversations[0].id);
  else if(selectedId&&!conversations.some(x=>x.id===selectedId)){ selectedId=''; records=[]; renderTimeline(); }
}
function renderTimeline(){
  const c=conversations.find(x=>x.id===selectedId);
  if(!c){ $('#timelineHead').innerHTML='<div><strong>请选择客户</strong><small>左侧选择客户后查看聊天轨迹</small></div><span id="timelineCount">0 条</span>'; $('#timeline').innerHTML='<div class="empty big">这里会按时间顺序显示文字、图片和音频。</div>'; return; }
  const filter=$('#typeFilter').value; const shown=records.filter(r=>!filter||r.type===filter);
  $('#timelineHead').innerHTML=`<div><strong>${esc(c.displayName||'客户')}</strong><small>${esc(platformLabel(c.platform))} · ${esc(c.accountName||'')}</small></div><span id="timelineCount">${shown.length} 条</span>`;
  let day=''; const html=[];
  for(const r of shown){
    const d=fmtDay(r.capturedAt); if(d&&d!==day){day=d;html.push(`<div class="day-separator">${esc(d)}</div>`)}
    const who=r.role==='me'?'我':'客户'; const t=esc(r.nativeTime||fmtTime(r.capturedAt)); let body='';
    if(r.type==='text') body=`<div class="message-text">${esc(r.text||'')}</div>`;
    else {
      const src=r.mediaUrl||r.mediaSource||'';
      if(r.type==='image'&&src) body=`<div class="media-card"><img data-full-src="${esc(src)}" data-meta="${esc(`${who} · ${t}`)}" src="${esc(src)}" alt="聊天图片" /></div>`;
      else if(r.type==='audio'&&src) body=`<div class="media-card"><audio controls preload="metadata" src="${esc(src)}"></audio></div>`;
      else if(r.type==='video'&&src) body=`<div class="media-card"><video controls preload="metadata" src="${esc(src)}"></video></div>`;
      else body='<div class="media-fallback">媒体已记录，但原始媒体当前不可读取。</div>';
    }
    const typeLabel=r.type==='text'?'文字':r.type==='image'?'图片':r.type==='audio'?'音频':'视频';
    html.push(`<div class="message-row ${r.role==='me'?'me':'customer'}"><article class="message-bubble"><div class="message-meta"><span>${who}</span><span>${t}</span><span>${esc(typeLabel)}</span></div>${body}</article></div>`);
  }
  $('#timeline').innerHTML=html.join('')||'<div class="empty big">这个筛选条件下没有内容。</div>';
  $('#timeline').scrollTop=$('#timeline').scrollHeight;
}
async function selectConversation(id){ selectedId=String(id||''); document.querySelectorAll('.conversation-card').forEach(b=>b.classList.toggle('active',b.dataset.id===selectedId)); const r=await api.get(selectedId,3000); records=Array.isArray(r?.records)?r.records:[]; renderTimeline(); }
$('#conversationList').addEventListener('click',e=>{const b=e.target.closest('[data-id]');if(b)selectConversation(b.dataset.id)});
$('#typeFilter').addEventListener('change',renderTimeline);
$('#searchInput').addEventListener('input',()=>{clearTimeout(window.__hs);window.__hs=setTimeout(()=>loadList(true),180)});
$('#platformFilter').addEventListener('change',()=>{rebuildFilters();loadList(true)});
$('#accountFilter').addEventListener('change',()=>loadList(true));
$('#captureBtn').addEventListener('click',async()=>{ $('#historyStatus').textContent='正在同步当前聊天…'; const r=await api.captureCurrent(); $('#historyStatus').textContent=r?.added?`已补录 ${r.added} 条当前聊天内容。`:(r?.target?.ok===false?r.target.error:'当前可见内容已经记录，无新增。'); await loadList(true); if(r?.conversationId) await selectConversation(r.conversationId); });
$('#timeline').addEventListener('click',e=>{const img=e.target.closest('img[data-full-src]');if(!img)return;$('#imageViewerImg').src=img.dataset.fullSrc;$('#imageViewerMeta').textContent=img.dataset.meta||'';$('#imageViewer').classList.remove('hidden')});
function closeViewer(){ $('#imageViewer').classList.add('hidden'); $('#imageViewerImg').src=''; }
$('#imageViewerClose').addEventListener('click',closeViewer); $('#imageViewer').addEventListener('click',e=>{if(e.target.id==='imageViewer')closeViewer()}); document.addEventListener('keydown',e=>{if(e.key==='Escape')closeViewer()});
api.onUpdated?.(async payload=>{const current=selectedId;await loadList(true);if(current&&(!payload.conversationId||payload.conversationId===current))await selectConversation(current)});
loadList(false);
