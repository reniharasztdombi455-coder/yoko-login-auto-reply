
'use strict';
const $=id=>document.getElementById(id),api=window.yokoAiAccounts;
let currentUser=null,revision=0;
let activeTab='inbox', refreshTimer=null, modeWriteBusy=new Set(), monitorBusy=false;
const modeRows=new Map();
const status=(message,error=false)=>{const e=$('status');e.textContent=String(message||'');e.classList.toggle('error',error);};
async function run(action,payload={}){try{return await api.run(action,payload);}catch(e){status(String(e.message||e),true);throw e;}}
function el(tag,text='',className=''){const e=document.createElement(tag);e.textContent=String(text);if(className)e.className=className;return e;}
function add(container,...nodes){for(const node of nodes)container.appendChild(node);}
function item(target,headline,body,buttonText,callback){const wrap=el('div','','item');add(wrap,el('strong',headline),el('div',body));if(buttonText){const b=el('button',buttonText);b.onclick=callback;wrap.appendChild(b);}target.appendChild(wrap);}
async function loadTab(name){activeTab=name;document.querySelectorAll('.tab').forEach(e=>e.hidden=e.id!==name);document.querySelectorAll('nav button').forEach(e=>e.classList.toggle('selected',e.dataset.tab===name));
if(name==='inbox'){await refreshPages();await refreshCustomers();await refreshInbox();}
if(name==='flows'){await loadReceptionFlow();}
if(name==='provider'){await loadProviderSettings();}
if(name==='simulator'){await loadSimulatorPages();}
if(name==='delivery'){if(currentUser?.role!=='super_admin'){status('仅超级管理员可以查看发送确认',true);return;}await refreshDeliveries();}
if(name==='monitor'){if(!['super_admin','admin'].includes(currentUser?.role)){status('仅管理员可查看监控',true);return;}await refreshDaemon();}
if(name==='staff'){
 const target=$('users');target.replaceChildren();
 try{
  const r=await run('users');
  for(const u of r.users||[]){
   const wrap=el('div','','item');add(wrap,el('strong',u.username),el('div',`${u.display_name||''} · ${u.role} · ${u.enabled?'启用':'禁用'}`));
   if(u.id!==currentUser?.id&&!(u.role==='super_admin'&&currentUser?.role!=='super_admin')){
    const toggle=el('button',u.enabled?'禁用账户':'启用账户');
    toggle.onclick=async()=>{if(!confirm(`确认${u.enabled?'禁用':'启用'}账号 ${u.username}？`))return;await run('manageUser',{userId:u.id,action:'set-enabled',fields:{enabled:!u.enabled}});status('账户状态已更新');await loadTab('staff');};
    const role=el('select');for(const [value,label] of [['staff','员工'],['admin','管理员'],...(currentUser?.role==='super_admin'?[['super_admin','超级管理员']]:[])]){const o=el('option',label);o.value=value;o.selected=value===u.role;role.appendChild(o);}
    const change=el('button','修改角色');change.onclick=async()=>{if(!confirm(`确认调整 ${u.username} 的角色？所有旧登录会话将失效。`))return;await run('manageUser',{userId:u.id,action:'set-role',fields:{role:role.value}});status('角色已更新');await loadTab('staff');};
    const reset=el('button','重置密码');reset.onclick=async()=>{const pass=prompt(`为 ${u.username} 设置至少12位的新密码（注意周围环境）`);if(pass===null)return;if(pass.length<12){status('密码不得少于12位',true);return;}if(!confirm(`确认重置 ${u.username} 的密码？旧会话将退出。`))return;await run('manageUser',{userId:u.id,action:'reset-password',fields:{password:pass}});status('密码已重置');await loadTab('staff');};
    add(wrap,toggle,role,change,reset);
   }
   target.appendChild(wrap);
  }
  const audit=$('accountAudit');if(audit){audit.replaceChildren();const logs=await run('accountAudit',{limit:30});for(const row of logs.items||[])item(audit,row.action,`${row.created_at} · 操作者 ${row.actor_id} · 目标 ${row.target_id} · ${row.old_value||''} → ${row.new_value||''}`);}
 }catch(e){status('账号管理读取失败：'+e.message,true);}
}
if(name==='qa'){
 const target=$('answers');target.replaceChildren();
 const r=await run('answers',{q:$('qaSearch').value.trim(),status:$('qaStatus').value,locale:$('qaLocale').value.trim(),limit:100});
 $('qaCount').textContent=`筛选结果 ${r.total??(r.items||[]).length} 条（当前展示 ${(r.items||[]).length} 条）`;
 const isManager=['super_admin','admin'].includes(currentUser?.role);
 $('qaApproveSelected').hidden=!isManager;$('qaRejectSelected').hidden=!isManager;
 for(const row of r.items||[]){const wrap=el('div','','item');
  if(isManager&&row.status==='pending'){const c=el('input');c.type='checkbox';c.className='qaCheck';c.value=row.id;wrap.appendChild(c);}
  add(wrap,el('strong',`${row.locale} · ${row.status} · ${row.question}`),el('div',row.answer),el('div',`命中 ${row.hits||0} 次 · ${row.updated_at||''}`));
  if(isManager&&row.status==='pending')for(const [action,label] of [['approve','通过'],['reject','拒绝']]){const b=el('button',label);b.onclick=async()=>{if(!confirm(`确认${label}这条答案？`))return;await run(action,{id:row.id});await loadTab('qa');};wrap.appendChild(b);}
  target.appendChild(wrap);
 }
 if(isManager){const logs=await run('qaAudit',{limit:30}),audit=$('qaAudit');audit.replaceChildren();for(const log of logs.items||[])item(audit,log.action,`${log.created_at} · ${log.prior_status} → ${log.new_status} · 条目 ${log.qa_id}`);}
} 
if(name==='handoff'){
 const target=$('handoffs');target.replaceChildren();const r=await run('handoffs');
 for(const row of r.items||[]){
  const wrap=el('div','','item'),mine=row.assigned_to===currentUser?.id,other=!!row.assigned_to&&!mine;
  add(wrap,el('strong',`客户 ${row.customer_id} · ${row.reason}`),el('div',`客户问题：${row.question||'无记录'}`),el('div',`草稿 / 标准答案：${row.answer||'暂无草稿'}`),el('div',`处理人：${row.assignee_name|| (mine?'我':'尚未领取')}`));
  if(!row.assigned_to){const claim=el('button','领取待办');claim.onclick=async()=>{await run('claimHandoff',{id:row.id,action:'claim'});await loadTab('handoff');};wrap.appendChild(claim);}
  if(mine){const release=el('button','释放待办');release.onclick=async()=>{await run('claimHandoff',{id:row.id,action:'release'});await loadTab('handoff');};wrap.appendChild(release);}
  if(!other){const area=el('textarea');area.placeholder='人工确认并发送给客户后的正确回答（可留空，仅关闭待办）';area.rows=3;wrap.appendChild(area);const button=el('button','标记已处理');button.onclick=async()=>{if(!confirm('确认已由人工处理？此操作不会实际发送消息。'))return;await run('resolve',{id:row.id,answer:area.value.trim()});await loadTab('handoff');};wrap.appendChild(button);}
  target.appendChild(wrap);
 }
 const history=$('handoffHistory');if(history){history.replaceChildren();const h=await run('handoffHistory',{limit:30});for(const row of h.items||[])item(history,`客户 ${row.customer_id}`,`${row.updated_at} · ${row.reason} · ${row.assignee_name||'已处理'} · ${row.question||''}`);}
}
if(name==='sync'){const r=await run('state',{key:'inbox'});revision=r.revision||0;$('sharedNote').value=r.value?.note||'';lastSyncedNote=$('sharedNote').value;$('revision').textContent=`服务器版本：${revision} · 更新时间：${r.updatedAt||'尚未保存'}`;}}
$('loginButton').onclick=async()=>{const b=$('loginButton');b.disabled=true;try{await run('connect',{url:$('serverUrl').value});currentUser=(await run('login',{username:$('username').value,password:$('password').value})).user;$('password').value='';$('who').textContent=`${currentUser.display_name||currentUser.username} · ${currentUser.role}`;$('loginPanel').hidden=true;$('dashboard').hidden=false;$('monitorNav').hidden=!['super_admin','admin'].includes(currentUser?.role);$('deliveryNav').hidden=currentUser?.role!=='super_admin';$('providerNav').hidden=currentUser?.role!=='super_admin';await loadTab('inbox');startRefresh();status('已安全连接');}catch(error){const msg=String(error?.message||'连接失败');status(msg==='invalid-credentials'?'账号或密码不正确，请检查后重试。':`登录失败：${msg}`,true);$('password').focus();}finally{b.disabled=false;}};
$('logout').onclick=async()=>{simTurns=[];stopAutoProcessing('已退出登录');stopRefresh();await run('logout');currentUser=null;$('monitorNav').hidden=true;$('deliveryNav').hidden=true;$('providerNav').hidden=true;$('dashboard').hidden=true;$('loginPanel').hidden=false;status('已退出登录');};
$('createUser').onclick=async()=>{await run('createUser',{username:$('newUsername').value,displayName:$('newDisplayName').value,password:$('newPassword').value,role:$('newRole').value});$('newPassword').value='';status('员工创建成功');await loadTab('staff');};
$('reload').onclick=()=>loadTab(document.querySelector('.tab:not([hidden])')?.id||'staff');
$('qaRefresh').onclick=()=>loadTab('qa');
for(const [id,statusName] of [['qaApproveSelected','approved'],['qaRejectSelected','rejected']])$(''+id).onclick=async()=>{
 const ids=[...document.querySelectorAll('#answers .qaCheck:checked')].map(x=>x.value);
 if(!ids.length){status('请先选择待审核答案',true);return;}
 if(!confirm(`确定批量${statusName==='approved'?'通过':'拒绝'} ${ids.length} 条答案？`))return;
 await run('batchReview',{ids,status:statusName});status(`已审核 ${ids.length} 条`);await loadTab('qa');
};

// Refresh shared state without overwriting a note currently being edited.
let lastSyncedNote='',syncRefreshBusy=false;
async function refreshSharedState(){
 if(syncRefreshBusy||!currentUser||activeTab!=='sync')return;
 syncRefreshBusy=true;
 try{
  const r=await run('state',{key:'inbox'});
  const remoteNote=String(r.value?.note||'');
  const editing=$('sharedNote').value!==lastSyncedNote;
  if(!editing){$('sharedNote').value=remoteNote;lastSyncedNote=remoteNote;revision=r.revision||0;
   $('revision').textContent=`服务器版本：${revision} · 更新时间：${r.updatedAt||'尚未保存'}`;}
  else if((r.revision||0)!==revision){$('revision').textContent=`服务器有新版本 ${r.revision}；当前内容未覆盖，请先备份编辑内容并刷新。`;}
 }finally{syncRefreshBusy=false;}
}
$('saveState').onclick=async()=>{
 try{const value=$('sharedNote').value;
  const r=await run('saveState',{key:'inbox',value:{note:value},expectedRevision:revision});
  revision=r.revision;lastSyncedNote=value;status('服务端已保存，其他电脑可自动读取最新版本');await loadTab('sync');
 }catch(error){if(String(error?.message||'').includes('revision-conflict'))status('另一台电脑已更新：请先复制当前备注，再刷新获取新版本，避免覆盖。',true);}
};
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>loadTab(b.dataset.tab));

// R41: live Page list from VPS; no fixed list or local configuration persistence.
let selectedPage='', selectedPageMode='off', selectedPageRevision=0,customerOffset=0;
async function refreshPages(){
 const r=await run('pages');const select=$('pageSelect'),prior=selectedPage;
 select.replaceChildren();for(const page of r.items||[]){const o=el('option',`${page.name||page.pageId} · ${page.conversations} 位客户${page.enabled?"":"（主页已停用）"}`);o.value=page.pageId;select.appendChild(o);}
 selectedPage=(r.items||[]).some(x=>x.pageId===prior)?prior:(r.items?.[0]?.pageId||'');
 select.value=selectedPage;
 const current=(r.items||[]).find(x=>x.pageId===selectedPage);
 selectedPageMode=current?.mode||'off';selectedPageRevision=current?.revision||0;
 $('pageMode').value=selectedPageMode;
 $('pageModeHint').textContent=`接待设置由 VPS 保存。当前：${selectedPageMode==='off'?'关闭':selectedPageMode==='draft'?'草稿辅助':'自动接待预设'}；真实发送仍需要服务器独立授权。`;
 $('savePageMode').disabled=!selectedPage||current?.enabled===false||!['super_admin','admin'].includes(currentUser?.role);
 $('pageMode').disabled=$('savePageMode').disabled;
 if(selectedPageMode==='auto'&&autoEnabled)stopAutoProcessing('该主页由 VPS 自动接待，已停止本地草稿批处理');
 $('processInbox').disabled=selectedPageMode!=='draft';
 $('autoProcessToggle').disabled=selectedPageMode!=='draft';
}
async function refreshCustomers(reset=true){
 if(reset){customerOffset=0;$('pageCustomers').replaceChildren();}
 if(!selectedPage)return;
 const r=await run('customers',{pageId:selectedPage,offset:customerOffset});
 for(const row of r.items||[]){
  const name=row.displayName||row.customerId;
  const wrap=el('div','','item');add(wrap,el('strong',name),el('div',`最近活动：${row.lastActivityMs?new Date(row.lastActivityMs).toLocaleString():'未知'} · ${row.mode==='human'?'人工':'AI'}接待`));
  const button=el('button',row.mode==='human'?'恢复 AI':'切换人工');
  button.onclick=async()=>{const target=row.mode==='human'?'ai':'human';if(!confirm(`确认将 ${name} 切换为${target==='ai'?'AI':'人工'}接待？`))return;await run('setCustomerMode',{customerId:row.customerId,mode:target,expectedRevision:row.revision});await refreshCustomers();};
  wrap.appendChild(button);$('pageCustomers').appendChild(wrap);
 }
 customerOffset+=(r.items||[]).length;
 $('nextCustomers').hidden=customerOffset>=Number(r.total||0);
}
$('pageSelect').onchange=async()=>{stopAutoProcessing('切换主页，自动处理已停止');selectedPage=$('pageSelect').value;inboxSignature='';await refreshPages();await refreshCustomers();await refreshInbox();};
$('savePageMode').onclick=async()=>{
 const mode=$('pageMode').value;
 if(!selectedPage||!confirm(`保存该主页为 ${mode}？其他主页不受影响。自动外发不会因此启用。`))return;
 try{await run('setPageMode',{pageId:selectedPage,mode,expectedRevision:selectedPageRevision});stopAutoProcessing('主页设置已更新');await refreshPages();await refreshInbox();status('该主页设置已保存至 VPS');}catch(e){status('保存失败：'+e.message,true);await refreshPages();}
};
$('nextCustomers').onclick=()=>refreshCustomers(false);
// R7: operator-controlled inbox, never a channel sender.
let inboxBusy=false, inboxRefreshing=false, inboxSignature='', inboxLastRenderAt=0;
// A preview is not a live inbox: retain rows while refreshing, group old backlog,
// and do not issue 30 serial status requests on every timer tick.
async function refreshInbox(){
 if(inboxRefreshing)return;inboxRefreshing=true;
 const target=$('inboxItems');
 try{
   const r=await run('inbox',{limit:30,pageId:selectedPage});
   const rows=Array.isArray(r.items)?r.items:[];
   const signature=JSON.stringify(rows.map(row=>[row.messageId,row.customerId,row.timestampMs]));
   const nowMs=Date.now();
   const recent=rows.filter(row=>Number(row.timestampMs)>=nowMs-72*3600*1000);
   const older=rows.filter(row=>Number(row.timestampMs)<nowMs-72*3600*1000);
   $('inboxSummary').textContent=r.available===false?'服务器尚未配置 Messenger 收件数据库':
     `预览 ${rows.length} 条：近72小时 ${recent.length} 条，历史未处理 ${older.length} 条（最多30条；不是实时收件统计）`;
   if(signature===inboxSignature && nowMs-inboxLastRenderAt<60000)return;
   const fragment=document.createDocumentFragment();
   const modeTargets=new Map();
   const appendRows=(arr,heading)=>{
     if(!arr.length)return;
     fragment.appendChild(el('h3',heading));
     for(const row of arr){
       const customerId=String(row.customerId||'').slice(0,150);
       const wrap=el('div','','item');
       add(wrap,el('strong',`客户 ${customerId} · ${new Date(row.timestampMs).toLocaleString()}`),el('div',row.question));
       const label=el('span','正在读取接待模式…','muted');
       const human=el('button','切换人工接管');const ai=el('button','恢复 AI 模式');
       human.disabled=true;ai.disabled=true;add(wrap,label,human,ai);fragment.appendChild(wrap);
       const display=(mode)=>{label.textContent=`当前模式：${mode.mode==='human'?'人工接管':'AI 接待'} · 版本 ${mode.revision}`;human.disabled=mode.mode==='human'||modeWriteBusy.has(customerId);ai.disabled=mode.mode==='ai'||modeWriteBusy.has(customerId);};
       const switchMode=async(next)=>{if(modeWriteBusy.has(customerId))return;modeWriteBusy.add(customerId);human.disabled=true;ai.disabled=true;try{const latest=await run('getCustomerMode',{customerId});modeRows.set(customerId,latest);if(latest.mode===next){display(latest);return;}const changed=await run('setCustomerMode',{customerId,mode:next,expectedRevision:latest.revision});modeRows.set(customerId,changed);status(`客户 ${customerId} 已切换${next==='human'?'人工接管':'AI 接待'}`);display(changed);}catch(error){label.textContent=`状态更新失败，请刷新：${error.message}`;status(`切换失败：${error.message}`,true);}finally{modeWriteBusy.delete(customerId);const latest=modeRows.get(customerId);if(latest)display(latest);}};
       human.onclick=()=>switchMode('human');ai.onclick=()=>switchMode('ai');
       if(!modeTargets.has(customerId))modeTargets.set(customerId,[]);
       modeTargets.get(customerId).push({label,display});
       const cached=modeRows.get(customerId);if(cached)display(cached);
     }
   };
   appendRows(recent,'近72小时待处理');
   appendRows(older,'历史未处理（请核对是否仍需处理）');
   if(!rows.length)fragment.appendChild(el('div','没有待处理文本消息','item'));
   target.replaceChildren(fragment);
   inboxSignature=signature;inboxLastRenderAt=nowMs;
   const ids=[...modeTargets.keys()];
   // At most four concurrent VPS mode lookups, one lookup per customer.
   for(let i=0;i<ids.length;i+=4){
     await Promise.all(ids.slice(i,i+4).map(async customerId=>{
       try{const mode=await run('getCustomerMode',{customerId});modeRows.set(customerId,mode);for(const t of modeTargets.get(customerId))t.display(mode);}
       catch(error){for(const t of modeTargets.get(customerId))t.label.textContent=`模式读取失败：${error.message}`;}
     }));
   }
 }catch(e){status(`读取收件队列失败：${e.message}`,true);}finally{inboxRefreshing=false;}
}
$('previewInbox').onclick=()=>refreshInbox();
$('processInbox').onclick=async()=>{
 if(inboxBusy)return;if(selectedPageMode!=='draft'){status('仅草稿模式允许手动批处理；Auto 主页由 VPS 自动回复',true);return;}inboxBusy=true;const button=$('processInbox');button.disabled=true;
 const useAi=$('useAi').checked;const limit=Number($('processLimit').value);
 try{const r=await run('processInbox',{limit,useAi,locale:'auto',pageId:selectedPage});const output=$('processResults');output.replaceChildren();
 for(const row of r.items||[])item(output,`消息 ${row.messageId} · ${row.status||'unknown'} · ${row.source||''}`,`${row.answer||'等待人工处理'}\n${row.requiresHuman?'需要人工审核或接管':'命中知识库；未发送'}`);
 status(`本批处理 ${r.processed||0} 条；外发消息 0 条`);await refreshInbox();
 }catch(e){status(`处理失败：${e.message}`,true);}finally{inboxBusy=false;button.disabled=false;}
};

// R9: read-only polling while the management window is visible; never sends to a channel.
function stopRefresh(){if(refreshTimer!==null){clearInterval(refreshTimer);refreshTimer=null;}}
function startRefresh(){stopRefresh();refreshTimer=setInterval(()=>{if(!currentUser||document.hidden||inboxBusy)return;if(activeTab==='inbox')refreshInbox().catch(()=>{});else if(activeTab==='handoff')loadTab('handoff').catch(()=>{});else if(activeTab==='monitor')refreshDaemon().catch(()=>{});else if(activeTab==='delivery')refreshDeliveries().catch(()=>{});else if(activeTab==='sync')refreshSharedState().catch(()=>{});},60000);}
// R10: explicit, locally owned inbox scheduler; no external sends, no saved credentials.
// The server's message deduplication remains authoritative across clients.
let autoTimer=null, autoBusy=false, autoFailures=0, autoEnabled=false;
const autoIntervalMs=20000;
function autoLabel(message){const label=$('autoStatus');if(label)label.textContent=message;}
function stopAutoProcessing(reason='已停止'){
 autoEnabled=false;
 if(autoTimer!==null){clearTimeout(autoTimer);autoTimer=null;}
 const toggle=$('autoProcessToggle');if(toggle)toggle.textContent='启动自动处理';
 autoLabel(reason);
}
async function autoTick(){
 if(!autoEnabled||autoBusy||inboxBusy||!currentUser)return;
 if(selectedPageMode!=='draft'){stopAutoProcessing('该主页由 VPS 自动接待，禁止本地批处理');return;}
 autoBusy=true;
 try{
  // AI provider use stays opt-in separately; never invoke delivery/claim/send endpoints.
  const limit=Math.min(5,Math.max(1,Number($('autoProcessLimit').value)||3));
  const result=await run('processInbox',{limit,useAi:$('autoUseAi').checked,locale:'auto',pageId:selectedPage});
  autoFailures=0;
  autoLabel(`运行中 · 本轮处理 ${Number(result.processed||0)} 条 · 不自动发送 · ${new Date().toLocaleTimeString()}`);
  if(activeTab==='inbox')await refreshInbox();
 }catch(error){
  autoFailures++;
  const message=String(error?.message||'unknown-error');
  if(/401|403|unauthori[sz]ed|session|token|登录/i.test(message)||autoFailures>=3){stopAutoProcessing(`已自动停止：${message.slice(0,120)}`);}
  else autoLabel(`请求失败 ${autoFailures}/3，将稍后重试：${message.slice(0,100)}`);
 }finally{
  autoBusy=false;
  if(autoEnabled){const delay=autoFailures?autoIntervalMs*Math.pow(2,autoFailures):autoIntervalMs;autoTimer=setTimeout(autoTick,delay);}
 }
}
$('autoProcessToggle').onclick=()=>{
 if(autoEnabled){stopAutoProcessing('已手动停止');return;}
 if(!currentUser){autoLabel('请先登录');return;}
 if(!selectedPage||selectedPageMode!=='draft'){autoLabel('仅草稿模式可以使用本地自动处理；Auto 主页由 VPS 负责');return;}
 autoEnabled=true;autoFailures=0;
 $('autoProcessToggle').textContent='停止自动处理';
 autoLabel('运行中 · 每 20 秒检查一次 · 只生成草稿，不发送');
 autoTick();
};
window.addEventListener('beforeunload',()=>{stopAutoProcessing('窗口关闭');stopRefresh();});

// R14: administrator-only, read-only VPS daemon telemetry. All data rendered using textContent.
const daemonWhen=value=>{if(!value)return '—';const d=new Date(value);return Number.isNaN(d.getTime())?String(value).slice(0,40):d.toLocaleString();};
function daemonMetric(name,value){const div=el('div','','monitor-metric');add(div,el('small',name),el('strong',String(value??'—')));$('daemonMetrics').appendChild(div);}
async function refreshDaemon(){
 if(monitorBusy||!currentUser||!['super_admin','admin'].includes(currentUser.role))return;
 monitorBusy=true;const button=$('refreshDaemon');button.disabled=true;
 try{
  const [state,history,usage,health]=await Promise.all([run('daemonStatus'),run('daemonHistory',{limit:Number($('daemonLimit').value)||25}),run('usageSummary',{limit:10}),run('healthSummary')]);
  if(!currentUser||activeTab!=='monitor')return;
  $('daemonStatus').textContent=`${state.enabled?'调度已配置启用':'调度默认关闭'} · ${state.running?'正在执行':'当前空闲'} · ${state.useAi?'允许生成 AI 草稿':'不调用 OpenAI'} · ${state.autoDispatch?.enabled===true?'知识库自动发送已授权':'知识库自动发送未启用'} · ${state.openAiAutoSendEnabled===true?'OpenAI 自动发送已授权':'OpenAI 自动发送未启用'} · 间隔 ${Math.round(Number(state.intervalMs||0)/1000)} 秒 · 每批 ${state.batchSize||0} 条`;
  $('healthSummary').textContent=`${health.health==='attention'?'需要关注':'无异常积压警报'} · 人工待办 ${health.counts.openHandoffs} · 未领取 ${health.counts.unassignedHandoffs} · 超时处理中 ${health.counts.staleProcessing} · 过期发送声明 ${health.counts.expiredClaims} · 回执异常 ${health.counts.uncertainDeliveries} · 待审核知识 ${health.counts.pendingKnowledgeReview}。未知回执禁止自动重发。`;
  $('daemonMetrics').replaceChildren();
  for(const [k,v] of [['累计轮次',state.runs],['已处理消息',state.processed],['重复消息',state.duplicates],['错误次数',state.errors],['知识库自动发送次数',state.autoDispatch?.sent??'—'],['外发异常待核对',state.autoDispatch?.unknown??'—'],['上次执行',daemonWhen(state.lastRunAt)],['上次成功',daemonWhen(state.lastSuccessAt)]])daemonMetric(k,v);
  $('apiUsageMetrics').replaceChildren();
  for(const [name,value] of [['API 请求次数',usage.requests],['成功次数',usage.successes],['失败次数',usage.failures],['输入 Tokens',usage.promptTokens],['输出 Tokens',usage.completionTokens],['合计 Tokens',usage.totalTokens]]){
    const div=el('div','','monitor-metric');add(div,el('small',name),el('strong',String(value??'—')));$('apiUsageMetrics').appendChild(div);
  }
  $('apiUsageStatus').textContent='仅统计 VPS 当前数据库中记录的 OpenAI 调用；不包含其他服务、未返回用量的请求或实际账单。';
  const tbody=$('daemonRows');tbody.replaceChildren();
  for(const record of history.items||[]){const tr=document.createElement('tr');for(const val of [daemonWhen(record.started_at),record.outcome||'—',record.processed??0,record.duplicates??0,`${record.duration_ms??0} ms`,record.error_code||'—']){const td=el('td',val);tr.appendChild(td);}tbody.appendChild(tr);}
  if(!(history.items||[]).length){const tr=document.createElement('tr'),td=el('td','暂无运行历史');td.colSpan=6;tr.appendChild(td);tbody.appendChild(tr);}
  $('daemonRefreshed').textContent=`已刷新：${new Date().toLocaleTimeString()} · 历史记录总数 ${history.total||0}`;
 }catch(error){$('daemonStatus').textContent=`监控读取失败：${String(error?.message||error).slice(0,160)}`;status('AI 监控读取失败，请检查管理员权限、VPS 版本和连接状态',true);}
 finally{monitorBusy=false;button.disabled=false;}
}
$('refreshDaemon').onclick=()=>refreshDaemon();
$('daemonLimit').onchange=()=>refreshDaemon();

// R21: human-confirmed send only. All checks are repeated on the server at dispatch time.
let deliveryBusy=false, dispatchBusy=new Set();
async function refreshDeliveries(){
 if(deliveryBusy||!currentUser||currentUser.role!=='super_admin')return;
 deliveryBusy=true;const button=$('refreshDelivery');button.disabled=true;
 try{
  const [ready,reconcile]=await Promise.all([run('readyDeliveries',{limit:30}),run('reconcileDeliveries',{limit:30})]);
  if(activeTab!=='delivery'||!currentUser)return;
  $('deliveryHint').textContent=ready.dispatchEnabled?'服务器外发开关已启用；仍需逐条确认':'服务器外发开关关闭，不允许发送';
  const target=$('readyDeliveries');target.replaceChildren();
  for(const row of ready.items||[]){
   const id=String(row.interaction_id||'');
   const wrap=el('div','','item');add(wrap,el('strong',`客户 ${row.customer_id}`),el('div',`问题：${row.question}`),el('div',`已审核回复：${row.answer}`),el('small',`消息 ID：${row.client_message_id}`));
   const sendButton=el('button','核对并确认发送');sendButton.disabled=!ready.dispatchEnabled||dispatchBusy.has(id);
   sendButton.onclick=async()=>{
    if(dispatchBusy.has(id))return;
    dispatchBusy.add(id);sendButton.disabled=true;
    try{
     const latest=await run('deliveryStatus',{interactionId:id});
     if(latest.status!=='pending'){status(`发送状态已变化：${latest.status}，已取消`,true);await refreshDeliveries();return;}
     if(!window.confirm(`请确认发送目标和内容。此操作将真实发送 Messenger 消息，不可撤销。\n\n客户：${row.customer_id}\n\n回复：${row.answer}`))return;
     const result=await run('dispatchApproved',{interactionId:id});
     status(result.status==='sent'?'官方网关已返回发送成功回执':'发送结果不明确，已进入人工核对，请勿重发',result.status!=='sent');
     await refreshDeliveries();
    }catch(error){status(`发送未确认：${error.message}。请刷新核对，不要直接重试。`,true);}
    finally{dispatchBusy.delete(id);sendButton.disabled=false;}
   };wrap.appendChild(sendButton);target.appendChild(wrap);
  }
  if(!ready.items?.length)item(target,'没有待发送的已审核答案','知识库未命中、人工已接管或已经发送的消息不会出现在这里。');
  const issues=$('reconcileDeliveries');issues.replaceChildren();
  for(const row of reconcile.items||[])item(issues,`消息 ${row.interaction_id} · ${row.status}`,`客户：${row.customer_id}\n问题：${row.question||''}\n最后错误：${row.last_error||'未知'}\n最后更新：${row.updated_at||''}`);
  if(!reconcile.items?.length)item(issues,'暂无异常回执','没有需要人工核对的发送记录。');
 }catch(error){status(`发送列表刷新失败：${error.message}`,true);}
 finally{deliveryBusy=false;button.disabled=false;}
}
$('refreshDelivery').onclick=()=>refreshDeliveries();

// R42: page-bound script editing; no local persistence and no automatic sending.
let flowRevision=0,flowPageId='';
async function loadReceptionFlow(){
 const pages=await run('pages'),sel=$('flowPage'),prior=sel.value;
 sel.replaceChildren();for(const page of pages.items||[]){const opt=el('option',page.name||page.pageId);opt.value=page.pageId;sel.appendChild(opt);}
 sel.value=(pages.items||[]).some(x=>x.pageId===prior)?prior:(selectedPage||pages.items?.[0]?.pageId||'');
 if(!sel.value)return;
 const r=await run('getReceptionFlow',{pageId:sel.value});flowPageId=sel.value;
 flowRevision=r.flow?.revision||0;$('flowTitle').value=r.flow?.title||'';$('flowContent').value=r.flow?.content||'';
 $('flowEnabled').checked=!!r.flow?.enabled;$('flowRevision').textContent=`版本 ${flowRevision}，最后更新 ${r.flow?.updated_at||'无'}`;
 const admin=['super_admin','admin'].includes(currentUser?.role);$('flowSave').disabled=!admin;
}
$('flowLoad').onclick=()=>loadReceptionFlow();
$('flowPage').onchange=()=>loadReceptionFlow();
$('flowSave').onclick=async()=>{
 if(!confirm('确认将当前话术保存到 VPS？这不会开启自动发送。'))return;
 try{const r=await run('saveReceptionFlow',{pageId:flowPageId,title:$('flowTitle').value,content:$('flowContent').value,enabled:$('flowEnabled').checked,expectedRevision:flowRevision});
 flowRevision=r.flow.revision;status('该主页话术已保存到 VPS');await loadReceptionFlow();}catch(e){status('保存失败：'+e.message,true);}
};

// R49: super-admin-only VPS OpenAI credentials configuration. Renderer never receives the key.
async function loadProviderSettings(){
 if(currentUser?.role!=='super_admin')return;
 try{const r=await run('providerSettings');$('providerModel').value=r.model||'gpt-4.1-mini';
 $('providerKey').value='';$('providerState').textContent=`${r.configured?'API Key 已配置':'尚未配置'} · 来源 ${r.source==='vps'?'VPS 加密保存':'服务环境'} · ${r.updatedAt||'尚无修改记录'}`;
 }catch(e){$('providerResult').textContent='读取失败：'+e.message;}
}
$('providerSave').onclick=async()=>{
 if(currentUser?.role!=='super_admin')return;
 if(!confirm('确定更新 VPS 的 OpenAI 配置？不会开启自动发送。'))return;
 try{const r=await run('saveProviderSettings',{model:$('providerModel').value.trim(),apiKey:$('providerKey').value.trim()});
 $('providerKey').value='';$('providerResult').textContent='保存成功，后续新请求立即生效。';await loadProviderSettings();
 }catch(e){$('providerKey').value='';$('providerResult').textContent='保存失败：'+e.message;}
};
$('providerTest').onclick=async()=>{
 if(currentUser?.role!=='super_admin')return;
 const b=$('providerTest');b.disabled=true;$('providerResult').textContent='正在测试 OpenAI；不会发送 Facebook 消息…';
 try{const r=await run('testProvider');$('providerResult').textContent=r.connected?'OpenAI 连接成功 (HTTP 200)':`连接失败：${r.errorCode||'unknown'} ${r.httpStatus||''}。请核对 API 项目、账单、模型权限或地区政策。`;
 }catch(e){$('providerResult').textContent='测试失败：'+e.message;}finally{b.disabled=false;}
};

// R51 sandbox. Conversation lives in renderer memory only and is discarded on logout/window close.
let simTurns=[],simPageId='';
async function loadSimulatorPages(){
 const r=await run('pages'),sel=$('simPage'),previous=simPageId||selectedPage;
 sel.replaceChildren();for(const p of r.items||[]){const opt=el('option',p.name||p.pageId);opt.value=p.pageId;sel.appendChild(opt);}
 sel.value=(r.items||[]).some(p=>p.pageId===previous)?previous:(r.items?.[0]?.pageId||'');
 if(simPageId!==sel.value){simTurns=[];renderSim();}simPageId=sel.value;
}
function renderSim(){const target=$('simHistory');target.replaceChildren();for(const turn of simTurns){const box=el('div','','item');add(box,el('strong',turn.role==='user'?'模拟客户':'AI 模拟回复'),el('div',turn.content));target.appendChild(box);}$('simState').textContent=`本地模拟 ${simTurns.length} 条 · 不发送 Messenger`; }
$('simPage').onchange=()=>{simPageId=$('simPage').value;simTurns=[];renderSim();};
$('simReset').onclick=()=>{simTurns=[];$('simInput').value='';renderSim();};
$('simSend').onclick=async()=>{const message=$('simInput').value.trim(),button=$('simSend');if(!simPageId||!message||button.disabled)return;
 const turns=[...simTurns,{role:'user',content:message}];if(turns.length>12){status('模拟最多保留12条对话，请点击清空重试',true);return;}
 button.disabled=true;$('simState').textContent='正在生成模拟回复，不会外发…';try{const r=await run('simulateReception',{pageId:simPageId,turns});if(!r.generated){$('simState').textContent='模型未生成回复：'+(r.errorCode||'empty-response');return;}simTurns.push({role:'user',content:message},{role:'assistant',content:r.reply});$('simInput').value='';renderSim();}catch(e){$('simState').textContent='模拟失败：'+e.message;}finally{button.disabled=false;}
};
