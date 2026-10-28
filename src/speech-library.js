const $ = selector => document.querySelector(selector);
const api = window.speechLibraryApi;

let library = {version:2,groups:[]};
let target = null;
let activeGroupId = '';
let saveTimer = null;
let saving = false;
let targetRefreshBusy = false;
let targetPollTimer = null;
let sending = false;
let pickingImages = false;
let editRevision = 0;

function esc(value) {
  return String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function id(prefix='item') {
  try { return `${prefix}-${crypto.randomUUID()}`; }
  catch { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,10)}`; }
}
function dayTitle(index) {
  const names=['第一天','第二天','第三天','第四天','第五天','第六天','第七天','第八天','第九天','第十天'];
  return names[index] || `第${index+1}天`;
}
function subjectFromText(text='', index=0) {
  const line=String(text||'').split(/\r?\n/).map(x=>x.trim()).find(Boolean)||'';
  if(line)return line.replace(/\{\{?\s*(?:称呼|名字|name)\s*\}?\}/gi,'').trim().slice(0,28)||`话术 ${index+1}`;
  return `话术 ${index+1}`;
}
function normalizeImage(raw={}) {
  const fileName=String(raw?.fileName||'').trim();
  if(!/^[a-f0-9]{64}\.(?:jpg|jpeg|png|webp|gif|bmp)$/i.test(fileName))return null;
  return {
    id:String(raw?.id||id('image')).slice(0,100),
    fileName,
    originalName:String(raw?.originalName||fileName).slice(0,240),
    size:Math.max(0,Number(raw?.size||0)||0),
    url:String(raw?.url||`yoko-speech://asset/${encodeURIComponent(fileName)}`)
  };
}
function normalize(raw={}) {
  const groups=(Array.isArray(raw?.groups)?raw.groups:[]).slice(0,80).map((g,i)=>({
    id:String(g?.id||id('group')),
    title:String(g?.title||'').trim()||dayTitle(i),
    // V1.27.9: an empty item is an editable draft, not a deleted item.
    // Keep it across autosave so the live card never becomes detached from
    // library state while the operator is clearing/retyping a script.
    items:(Array.isArray(g?.items)?g.items:[]).slice(0,500).filter(row=>row!=null&&(typeof row==='object'||(typeof row==='string'&&row.trim()))).map((row,ii)=>{
      const text=String(row?.text??(typeof row==='string'?row:'')).replace(/\r\n/g,'\n');
      const images=(Array.isArray(row?.images)?row.images:[]).map(normalizeImage).filter(Boolean).slice(0,12);
      return {
        id:String(row?.id||id('item')),
        subject:String(row?.subject||row?.topic||'').trim().slice(0,80)||subjectFromText(text,ii),
        text,
        salutationEnabled:row?.salutationEnabled!==false,
        images
      };
    })
  }));
  if(!groups.length)groups.push({id:'day-1',title:'第一天',items:[]});
  return {version:2,groups};
}
function findGroup(groupId){return library.groups.find(g=>String(g.id)===String(groupId))||null;}
function findItem(groupId,itemId){const g=findGroup(groupId);return g?.items.find(x=>String(x.id)===String(itemId))||null;}
function itemHasContent(item){return !!(String(item?.text||'').trim()||(Array.isArray(item?.images)&&item.images.length));}
function activeGroup(){return findGroup(activeGroupId)||library.groups[0]||null;}
function markEdited(){editRevision+=1;}
function cssEsc(value){
  const raw=String(value??'');
  try{if(globalThis.CSS&&typeof CSS.escape==='function')return CSS.escape(raw);}catch{}
  return raw.replace(/[^a-zA-Z0-9_-]/g,ch=>`\\${ch}`);
}
function setStatus(text,kind=''){
  const node=$('#status');node.textContent=String(text||'');node.className='status'+(kind?` ${kind}`:'');
}
function imageSizeLabel(bytes=0){
  const n=Math.max(0,Number(bytes)||0);
  if(n>=1024*1024)return `${(n/(1024*1024)).toFixed(n>=10*1024*1024?0:1)} MB`;
  if(n>=1024)return `${Math.round(n/1024)} KB`;
  return n?`${n} B`:'';
}
function safeTargetName(){
  if(target?.ok!==true)return '';
  const preferred=String(target.salutationName||'').trim();
  if(preferred)return preferred.slice(0,60);
  const raw=String(target.crmName||target.displayName||target.handle||'').trim().replace(/^@/,'');
  if(!raw||/^(当前客户|客户|unknown|未知)$/i.test(raw)||/^https?:\/\//i.test(raw))return '';
  const parts=raw.split(/\s*[-‐‑‒–—―_|｜/／]+\s*/).map(x=>x.trim()).filter(Boolean);
  if(parts.length>=2&&!/\d/.test(parts[0])&&parts.slice(1).some(x=>/\d/.test(x)))return parts[0].slice(0,60);
  if(/\d/.test(raw)||/[-_]{2,}/.test(raw))return '';
  return raw.slice(0,60);
}
function addressFor(text='', name=safeTargetName()){
  if(!name)return '';
  const body=String(text||'');
  const japanese=/[\u3040-\u30ff]/.test(body);
  const chinese=/[\u3400-\u9fff]/.test(body);
  if(japanese){
    if(/(?:さん|様|さま|くん|君|ちゃん|先生|氏)$/.test(name))return name;
    return `${name}さん`;
  }
  if(chinese)return name;
  return `Hi ${name}`;
}
function salutationExample(item){
  if(item?.salutationEnabled===false)return '自动称呼已关闭';
  const address=addressFor(item?.text||'');
  if(!address)return target?.ok?'暂时无法读取客户称呼':'选择客户后显示实际称呼';
  if(/[\u3040-\u30ff]/.test(String(item?.text||'')))return `发送时：${address}、…`;
  if(/[\u3400-\u9fff]/.test(String(item?.text||'')))return `发送时：${address}，…`;
  return `发送时：${address}, …`;
}
function renderTarget(){
  const ok=target?.ok===true;
  $('#targetCard').classList.toggle('unavailable',!ok);
  $('#targetName').textContent=ok?(target.displayName||'当前客户'):(target?.error||'未选择客户');
  const handle=target?.handle?` · @${String(target.handle).replace(/^@/,'')}`:'';
  $('#targetMeta').textContent=ok?`${target.platformName||target.platform||'平台'} · ${target.accountName||'当前账号'}${handle}`:'仍可编辑话术；选择客户后再发送';
  $('#targetState').textContent=ok?'已锁定':'未选择';
  $('#targetSalutation').textContent=ok?(addressFor('おはようございます')||'已识别客户'):'—';
  document.querySelectorAll('.send-btn').forEach(btn=>{
    const item=findItem(btn.dataset.groupId,btn.dataset.itemId);
    btn.disabled=!(ok&&itemHasContent(item))||sending;
  });
  document.querySelectorAll('[data-salutation-preview]').forEach(node=>{
    const item=findItem(node.dataset.groupId,node.dataset.salutationPreview);
    if(item)node.textContent=salutationExample(item);
  });
}
function renderStageList(){
  const list=$('#stageList');
  list.innerHTML=library.groups.map((g,i)=>`<button type="button" class="stage-item ${String(g.id)===String(activeGroupId)?'active':''}" data-stage-select="${esc(g.id)}" title="${esc(g.title||dayTitle(i))}">
    <strong>${esc(g.title||dayTitle(i))}</strong><span class="stage-count">${Array.isArray(g.items)?g.items.length:0}</span>
  </button>`).join('');
}
function renderImageStrip(groupId,item){
  const images=Array.isArray(item?.images)?item.images:[];
  const thumbs=images.map((img,index)=>`<figure class="preset-image" title="${esc(img.originalName||img.fileName)}">
    <button type="button" class="preset-image-preview" data-image-preview="${esc(img.url)}" title="放大预览"><img src="${esc(img.url)}" alt="${esc(img.originalName||`图片${index+1}`)}" loading="lazy" /></button>
    <figcaption><span>${esc(img.originalName||`图片${index+1}`)}</span><small>${esc(imageSizeLabel(img.size))}</small></figcaption>
    <button type="button" class="preset-image-remove" data-image-remove="${esc(img.id)}" data-group-id="${esc(groupId)}" data-item-id="${esc(item.id)}" title="移除图片">×</button>
  </figure>`).join('');
  return `<div class="image-row"><div class="image-list">${thumbs||'<span class="image-empty">还没有预设图片</span>'}</div>
    <button type="button" class="add-image-btn" data-image-add="${esc(item.id)}" data-group-id="${esc(groupId)}" ${images.length>=12?'disabled':''}>＋ 图片</button></div>`;
}
function renderEditor(){
  const panel=$('#stageEditor');
  const g=activeGroup();
  if(!g){panel.innerHTML='<div class="empty">还没有聊天阶段。</div>';return;}
  const gi=library.groups.findIndex(x=>String(x.id)===String(g.id));
  const items=Array.isArray(g.items)?g.items:[];
  const rows=items.length?items.map((item,ii)=>`<article class="script-card" data-row="${esc(item.id)}">
    <div class="script-card-head">
      <span class="script-index">${ii+1}</span>
      <div class="subject-wrap"><label>主题</label><input class="subject-input" data-item-subject="${esc(item.id)}" data-group-id="${esc(g.id)}" maxlength="80" value="${esc(item.subject||subjectFromText(item.text,ii))}" placeholder="例如：早上问候 / 兴趣延伸 / 引导LINE" /></div>
      <div class="script-card-actions">
        <button type="button" data-item-up="${esc(item.id)}" data-group-id="${esc(g.id)}" title="上移" ${ii===0?'disabled':''}>↑</button>
        <button type="button" data-item-down="${esc(item.id)}" data-group-id="${esc(g.id)}" title="下移" ${ii===items.length-1?'disabled':''}>↓</button>
        <button type="button" class="danger" data-item-delete="${esc(item.id)}" data-group-id="${esc(g.id)}">删除</button>
      </div>
    </div>
    <div class="script-body">
      <div class="content-label"><span>内容</span><small>主题不会发送；正文和图片才会发送。</small></div>
      <textarea class="content-input" data-item-text="${esc(item.id)}" data-group-id="${esc(g.id)}" placeholder="输入话术内容。可使用 {{称呼}} 指定称呼出现位置。">${esc(item.text||'')}</textarea>
      <div class="personalize-row">
        <label class="auto-salutation"><input type="checkbox" data-item-salutation="${esc(item.id)}" data-group-id="${esc(g.id)}" ${item.salutationEnabled!==false?'checked':''}/> 发送时自动加称呼</label>
        <button type="button" class="insert-token" data-insert-token="${esc(item.id)}" data-group-id="${esc(g.id)}">插入 {{称呼}}</button>
        <span class="salutation-preview" data-salutation-preview="${esc(item.id)}" data-group-id="${esc(g.id)}">${esc(salutationExample(item))}</span>
      </div>
    </div>
    <div class="script-footer">${renderImageStrip(g.id,item)}
      <button type="button" class="send-btn" data-item-send="${esc(item.id)}" data-item-id="${esc(item.id)}" data-group-id="${esc(g.id)}" ${target?.ok&&itemHasContent(item)&&!sending?'':'disabled'}>发送</button>
    </div>
  </article>`).join(''):'<div class="empty">这个阶段还没有话术。点击下方“新增话术”开始整理。</div>';
  panel.innerHTML=`<div class="stage-editor-head">
    <div class="stage-title-wrap"><label>阶段名称</label><input class="stage-title" data-group-title="${esc(g.id)}" maxlength="80" value="${esc(g.title||dayTitle(gi))}" /></div>
    <div class="stage-actions">
      <button type="button" data-group-up="${esc(g.id)}" ${gi===0?'disabled':''} title="阶段上移">↑</button>
      <button type="button" data-group-down="${esc(g.id)}" ${gi===library.groups.length-1?'disabled':''} title="阶段下移">↓</button>
      <button type="button" class="danger" data-group-delete="${esc(g.id)}">删除阶段</button>
    </div>
  </div><div class="scripts">${rows}</div><button type="button" class="add-item" data-add-item="${esc(g.id)}">＋ 新增话术</button>`;
}
function renderAll(){
  if(!findGroup(activeGroupId))activeGroupId=library.groups[0]?.id||'';
  renderStageList();renderEditor();renderTarget();
}
async function saveNow(quiet=true){
  if(saveTimer){clearTimeout(saveTimer);saveTimer=null;}
  if(saving){
    // A save is already in flight. Schedule one more pass instead of silently
    // dropping edits made while the previous IPC request is pending.
    saveTimer=setTimeout(()=>saveNow(quiet),120);
    return;
  }
  const revisionAtStart=editRevision;
  saving=true;const n=$('#saveState');n.textContent='正在保存…';n.className='saving';
  try{
    const r=await api.saveLibrary(library);if(!r?.ok)throw new Error(r?.error||'保存失败');
    // Never let an older save response overwrite text typed after that save
    // started. If nothing changed, accepting the normalized response is safe.
    if(r?.library&&editRevision===revisionAtStart)library=normalize(r.library);
    n.textContent='已自动保存';n.className='saved';if(!quiet)setStatus('话术库已保存。','ok');
  }catch(e){n.textContent='保存失败';n.className='';setStatus('保存失败：'+(e?.message||e),'error');}
  finally{saving=false;}
}
function scheduleSave(){
  if(saveTimer)clearTimeout(saveTimer);const n=$('#saveState');n.textContent='等待保存…';n.className='';saveTimer=setTimeout(()=>saveNow(true),450);
}
async function refreshTarget(showStatus=true){
  if(targetRefreshBusy)return target;
  targetRefreshBusy=true;const previousKey=String(target?.targetKey||'');const previousOk=target?.ok===true;
  try{target=await api.getTarget();}catch(e){target={ok:false,error:e?.message||String(e)};}finally{targetRefreshBusy=false;}
  const nextKey=String(target?.targetKey||'');renderTarget();
  if(showStatus){
    setStatus(target?.ok?`当前发送目标：${target.displayName||'当前客户'}。开启“自动称呼”后，发送时会动态加入这个客户的称呼。`:(target?.error||'请选择客户聊天。'),target?.ok?'ok':'');
  }else if((previousKey!==nextKey||previousOk!==(target?.ok===true))&&target?.ok){
    setStatus(`已自动切换发送目标：${target.displayName||'当前客户'}。`,'ok');
  }
  return target;
}
function startTargetAutoSync(){
  if(targetPollTimer)clearInterval(targetPollTimer);
  targetPollTimer=setInterval(()=>{if(document.visibilityState==='hidden'||sending||pickingImages)return;refreshTarget(false);},900);
}
async function load(){
  try{library=normalize(await api.getLibrary());}catch{library=normalize({});}
  activeGroupId=library.groups[0]?.id||'';renderAll();await refreshTarget(true);
}
async function addImages(groupId,itemId){
  if(pickingImages)return;const item=findItem(groupId,itemId);if(!item)return;
  if((item.images||[]).length>=12)return setStatus('每条话术最多预设 12 张图片。','error');
  pickingImages=true;
  try{
    const r=await api.pickImages();if(!r?.ok)throw new Error(r?.error||'选择图片失败。');if(r?.canceled)return;
    const incoming=(Array.isArray(r.images)?r.images:[]).map(normalizeImage).filter(Boolean);
    if(!incoming.length)return setStatus('没有可用的图片。支持 JPG、PNG、WebP、GIF、BMP。','error');
    const existing=new Set((item.images||[]).map(x=>x.fileName));let added=0;
    for(const img of incoming){if(existing.has(img.fileName))continue;if(item.images.length>=12)break;item.images.push(img);existing.add(img.fileName);added+=1;markEdited();}
    renderEditor();scheduleSave();setStatus(`已加入 ${added} 张预设图片。`,'ok');
  }catch(e){setStatus(e?.message||String(e),'error');}finally{pickingImages=false;}
}
async function sendItem(groupId,itemId,button){
  const item=findItem(groupId,itemId);const text=String(item?.text||'').trim();const images=Array.isArray(item?.images)?item.images:[];
  if(!text&&!images.length)return setStatus('这条话术没有文字或图片，请先添加内容。','error');
  await refreshTarget(false);if(!target?.ok)return setStatus(target?.error||'请先选择客户聊天。','error');
  const sendTarget={...target};await saveNow(true);
  const old=button.textContent;button.disabled=true;button.textContent='发送中…';button.classList.remove('sent');sending=true;renderTarget();
  const address=item.salutationEnabled!==false?addressFor(text):'';
  setStatus(`正在发送「${item.subject||'未命名话术'}」给 ${sendTarget.displayName||'当前客户'}${address?`（称呼：${address}）`:''}…`);
  try{
    const r=await api.sendMessage({text,images,targetKey:sendTarget.targetKey,groupId,itemId,subject:item.subject||'',salutationEnabled:item.salutationEnabled!==false});
    if(!r?.ok){if(r?.targetChanged&&r?.target){target=r.target;renderTarget();}throw new Error(r?.error||'平台没有确认发送。');}
    button.textContent='已发送 ✓';button.classList.add('sent');
    const detail=[r.imagesSent?`${r.imagesSent} 张图片`:null,text?'文字':null,r.personalized&&r.salutation?`已加称呼 ${r.salutation}`:null].filter(Boolean).join(' + ');
    setStatus(`已发送「${item.subject||'话术'}」给 ${sendTarget.displayName||'当前客户'}${detail?`：${detail}`:''}。`,'ok');
    setTimeout(()=>{if(!button.isConnected)return;button.textContent=old;button.classList.remove('sent');button.disabled=!(target?.ok&&itemHasContent(item));},1100);
  }catch(e){button.textContent=old;button.disabled=false;setStatus(e?.message||String(e),'error');}
  finally{sending=false;renderTarget();setTimeout(()=>refreshTarget(false),80);}
}
function insertToken(groupId,itemId){
  const item=findItem(groupId,itemId);if(!item)return;
  const textarea=document.querySelector(`[data-item-text="${cssEsc(itemId)}"]`);if(!textarea)return;
  const token='{{称呼}}';const start=Number.isFinite(textarea.selectionStart)?textarea.selectionStart:textarea.value.length;const end=Number.isFinite(textarea.selectionEnd)?textarea.selectionEnd:start;
  const next=textarea.value.slice(0,start)+token+textarea.value.slice(end);textarea.value=next.slice(0,12000);item.text=textarea.value;markEdited();
  const pos=Math.min(textarea.value.length,start+token.length);textarea.focus();textarea.setSelectionRange(pos,pos);scheduleSave();
  const preview=document.querySelector(`[data-salutation-preview="${cssEsc(itemId)}"]`);if(preview)preview.textContent=salutationExample(item);
}
function openPreview(url){const modal=$('#imagePreviewModal'),img=$('#imagePreviewImage');if(!modal||!img||!url)return;img.src=url;modal.hidden=false;}
function closePreview(){const modal=$('#imagePreviewModal'),img=$('#imagePreviewImage');if(modal)modal.hidden=true;if(img)img.src='';}

$('#refreshTargetBtn').addEventListener('click',()=>refreshTarget(true));
$('#addGroupBtn').addEventListener('click',()=>{
  const g={id:id('group'),title:dayTitle(library.groups.length),items:[]};library.groups.push(g);markEdited();activeGroupId=g.id;renderAll();scheduleSave();setTimeout(()=>document.querySelector('[data-group-title]')?.focus(),0);
});
$('#stageList').addEventListener('click',e=>{const btn=e.target.closest?.('[data-stage-select]');if(!btn)return;activeGroupId=String(btn.dataset.stageSelect||'');renderAll();});
$('#stageEditor').addEventListener('input',e=>{
  const gt=e.target.closest?.('[data-group-title]');if(gt){const g=findGroup(gt.dataset.groupTitle);if(g){g.title=String(gt.value||'').slice(0,80);markEdited();const stage=document.querySelector(`[data-stage-select="${cssEsc(g.id)}"] strong`);if(stage)stage.textContent=g.title||'未命名阶段';}scheduleSave();return;}
  const subject=e.target.closest?.('[data-item-subject]');if(subject){const item=findItem(subject.dataset.groupId,subject.dataset.itemSubject);if(item){item.subject=String(subject.value||'').slice(0,80);markEdited();}scheduleSave();return;}
  const input=e.target.closest?.('[data-item-text]');if(!input)return;const item=findItem(input.dataset.groupId,input.dataset.itemText);if(item){item.text=String(input.value||'').replace(/\r\n/g,'\n').slice(0,12000);markEdited();}
  const send=input.closest('.script-card')?.querySelector('.send-btn');if(send)send.disabled=!(target?.ok&&itemHasContent(item));
  const preview=input.closest('.script-card')?.querySelector('[data-salutation-preview]');if(preview&&item)preview.textContent=salutationExample(item);scheduleSave();
});
$('#stageEditor').addEventListener('change',e=>{
  const check=e.target.closest?.('[data-item-salutation]');if(!check)return;const item=findItem(check.dataset.groupId,check.dataset.itemSalutation);if(!item)return;item.salutationEnabled=!!check.checked;markEdited();
  const preview=check.closest('.script-card')?.querySelector('[data-salutation-preview]');if(preview)preview.textContent=salutationExample(item);scheduleSave();
});
$('#stageEditor').addEventListener('click',e=>{
  const preview=e.target.closest?.('[data-image-preview]');if(preview){openPreview(preview.dataset.imagePreview);return;}
  const imageAdd=e.target.closest?.('[data-image-add]');if(imageAdd){addImages(imageAdd.dataset.groupId,imageAdd.dataset.imageAdd);return;}
  const imageRemove=e.target.closest?.('[data-image-remove]');if(imageRemove){const item=findItem(imageRemove.dataset.groupId,imageRemove.dataset.itemId);if(!item)return;item.images=(item.images||[]).filter(x=>String(x.id)!==String(imageRemove.dataset.imageRemove));markEdited();renderEditor();scheduleSave();return;}
  const token=e.target.closest?.('[data-insert-token]');if(token){insertToken(token.dataset.groupId,token.dataset.insertToken);return;}
  const add=e.target.closest?.('[data-add-item]');if(add){const g=findGroup(add.dataset.addItem);if(!g)return;const item={id:id('item'),subject:'',text:'',salutationEnabled:true,images:[]};g.items.push(item);markEdited();renderStageList();renderEditor();scheduleSave();setTimeout(()=>document.querySelector(`[data-item-subject="${cssEsc(item.id)}"]`)?.focus(),0);return;}
  const gu=e.target.closest?.('[data-group-up]'),gd=e.target.closest?.('[data-group-down]'),gx=e.target.closest?.('[data-group-delete]');
  if(gu||gd||gx){
    const gid=String(gu?.dataset.groupUp||gd?.dataset.groupDown||gx?.dataset.groupDelete||'');const i=library.groups.findIndex(g=>String(g.id)===gid);if(i<0)return;
    if(gx){if(library.groups.length<=1)return setStatus('至少保留一个聊天阶段。','error');if(!confirm(`确定删除「${library.groups[i].title||'未命名阶段'}」以及里面的全部话术和图片引用吗？`))return;library.groups.splice(i,1);markEdited();activeGroupId=library.groups[Math.max(0,i-1)]?.id||library.groups[0]?.id||'';}
    else if(gu&&i>0){[library.groups[i-1],library.groups[i]]=[library.groups[i],library.groups[i-1]];markEdited();}
    else if(gd&&i<library.groups.length-1){[library.groups[i+1],library.groups[i]]=[library.groups[i],library.groups[i+1]];markEdited();}
    renderAll();scheduleSave();return;
  }
  const iu=e.target.closest?.('[data-item-up]'),idn=e.target.closest?.('[data-item-down]'),ix=e.target.closest?.('[data-item-delete]'),is=e.target.closest?.('[data-item-send]');const btn=iu||idn||ix||is;if(!btn)return;
  const g=findGroup(btn.dataset.groupId);if(!g)return;const itemId=String(iu?.dataset.itemUp||idn?.dataset.itemDown||ix?.dataset.itemDelete||is?.dataset.itemSend||'');const i=g.items.findIndex(x=>String(x.id)===itemId);if(i<0)return;
  if(is){sendItem(g.id,itemId,is);return;}
  if(ix){g.items.splice(i,1);markEdited();}else if(iu&&i>0){[g.items[i-1],g.items[i]]=[g.items[i],g.items[i-1]];markEdited();}else if(idn&&i<g.items.length-1){[g.items[i+1],g.items[i]]=[g.items[i],g.items[i+1]];markEdited();}
  renderStageList();renderEditor();scheduleSave();
});
$('#imagePreviewModal')?.addEventListener('click',e=>{if(e.target.id==='imagePreviewModal'||e.target.closest?.('#closeImagePreviewBtn'))closePreview();});
window.addEventListener('keydown',e=>{if(e.key==='Escape')closePreview();});
window.addEventListener('focus',()=>refreshTarget(false));
document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='hidden')refreshTarget(false);});
window.addEventListener('beforeunload',()=>{if(targetPollTimer)clearInterval(targetPollTimer);if(saveTimer)saveNow(true);});
api.onRefreshTarget?.(()=>refreshTarget(false));
load().then(()=>startTargetAutoSync());
