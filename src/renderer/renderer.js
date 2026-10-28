const $ = selector => document.querySelector(selector);

let state = null;

const ACCOUNT_SIDEBAR_STORAGE_KEY = 'yoko.accountSidebarCollapsed';
let accountSidebarCollapsed = localStorage.getItem(ACCOUNT_SIDEBAR_STORAGE_KEY) === '1';

const EXTERNAL_ACCOUNT_SIDEBAR_STORAGE_KEY = 'yoko.externalAccountSidebarCollapsed.v1';
let externalAccountSidebarCollapsed = localStorage.getItem(EXTERNAL_ACCOUNT_SIDEBAR_STORAGE_KEY) === '1';

let draggedAccountId = '';
let accountDragMoved = false;
let suppressAccountClickUntil = 0;

const CRM_PANEL_COLLAPSED_STORAGE_KEY = 'yoko.crmPanelCollapsed.v1';
let crmPanelCollapsed = localStorage.getItem(CRM_PANEL_COLLAPSED_STORAGE_KEY) === '1';
let workspaceMetricsTimer = null;

function workspaceLayoutMetrics() {
  const width = Math.max(760, Number(window.innerWidth || 0));
  let aggregateSidebarWidth = 310;
  let crmPanelWidth = 352;
  let platformRailWidth = 62;
  let externalToolbarHeight = 92;
  let externalSidebarWidth = 228;
  let externalSidebarCollapsedWidth = 86;
  let externalAggregateSidebarWidth = 310;
  let externalAggregateSidebarCollapsedWidth = 132;
  let externalCrmTargetWidth = 320;
  if (width <= 980) {
    aggregateSidebarWidth = 230; crmPanelWidth = 250;
    platformRailWidth = 46; externalToolbarHeight = 72; externalSidebarWidth = 190;
    externalSidebarCollapsedWidth = 68; externalAggregateSidebarWidth = 228; externalAggregateSidebarCollapsedWidth = 102; externalCrmTargetWidth = 248;
  } else if (width <= 1120) {
    aggregateSidebarWidth = 238; crmPanelWidth = 262;
    platformRailWidth = 50; externalToolbarHeight = 76; externalSidebarWidth = 198;
    externalSidebarCollapsedWidth = 72; externalAggregateSidebarWidth = 246; externalAggregateSidebarCollapsedWidth = 108; externalCrmTargetWidth = 264;
  } else if (width <= 1300) {
    aggregateSidebarWidth = 252; crmPanelWidth = 280;
    platformRailWidth = 54; externalToolbarHeight = 82; externalSidebarWidth = 206;
    externalSidebarCollapsedWidth = 76; externalAggregateSidebarWidth = 268; externalAggregateSidebarCollapsedWidth = 116; externalCrmTargetWidth = 282;
  } else if (width <= 1500) {
    aggregateSidebarWidth = 274; crmPanelWidth = 306;
    platformRailWidth = 58; externalToolbarHeight = 88; externalSidebarWidth = 218;
    externalSidebarCollapsedWidth = 82; externalAggregateSidebarWidth = 292; externalAggregateSidebarCollapsedWidth = 124; externalCrmTargetWidth = 302;
  } else if (width <= 1580) {
    aggregateSidebarWidth = 286; crmPanelWidth = 320;
  }
  // Keep a narrow renderer strip when collapsed so the persistent CRM edge
  // handle stays above/clickable beside the native LINE WebContentsView.
  if (crmPanelCollapsed) crmPanelWidth = 42;
  const externalCrmVisible = shellSurface === 'external' && externalPlatformHasCrm(activeExternalPlatform) && !externalCrmCollapsedFor(activeExternalPlatform);
  return { aggregateSidebarWidth, crmPanelWidth, compact: width <= 1400, platformRailWidth, externalToolbarHeight, externalSidebarWidth, externalSidebarCollapsedWidth, externalAggregateSidebarWidth, externalAggregateSidebarCollapsedWidth, externalCrmTargetWidth, externalCrmWidth: externalCrmVisible ? externalCrmTargetWidth : 0 };
}

function applyWorkspaceLayoutCss() {
  const metrics = workspaceLayoutMetrics();
  document.documentElement.style.setProperty('--aggregate-sidebar-width', `${metrics.aggregateSidebarWidth}px`);
  document.documentElement.style.setProperty('--crm-panel-width', `${metrics.crmPanelWidth}px`);
  document.documentElement.style.setProperty('--global-app-rail-width', `${metrics.platformRailWidth}px`);
  document.documentElement.style.setProperty('--external-toolbar-height', `${metrics.externalToolbarHeight}px`);
  document.documentElement.style.setProperty('--external-account-sidebar-width', `${metrics.externalSidebarWidth}px`);
  document.documentElement.style.setProperty('--external-aggregate-sidebar-width', `${metrics.externalAggregateSidebarWidth}px`);
  document.documentElement.style.setProperty('--external-sidebar-collapsed-width', `${metrics.externalSidebarCollapsedWidth}px`);
  document.documentElement.style.setProperty('--external-aggregate-sidebar-collapsed-width', `${metrics.externalAggregateSidebarCollapsedWidth}px`);
  document.documentElement.style.setProperty('--external-crm-width', `${metrics.externalCrmTargetWidth}px`);
  document.body.classList.toggle('layout-compact', metrics.compact);
  document.body.classList.toggle('crm-panel-collapsed', crmPanelCollapsed);
  for (const id of ['crmSideCollapseBtn','crmSideEdgeToggleBtn']) {
    const btn = $('#' + id);
    if (!btn) continue;
    btn.textContent = crmPanelCollapsed ? '‹' : '›';
    btn.title = crmPanelCollapsed ? '展开客户资料' : '收起客户资料';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-expanded', crmPanelCollapsed ? 'false' : 'true');
  }
  $('#contactBtn')?.classList.toggle('active', !crmPanelCollapsed);
  if ($('#contactBtn')) $('#contactBtn').title = crmPanelCollapsed ? '打开客户资料' : '关闭客户资料';
  return metrics;
}

async function syncWorkspaceLayoutMetrics() {
  const metrics = applyWorkspaceLayoutCss();
  try { await window.yoko.setLayoutMetrics?.(metrics); } catch {}
  return metrics;
}

function scheduleWorkspaceLayoutMetrics() {
  if (workspaceMetricsTimer) clearTimeout(workspaceMetricsTimer);
  workspaceMetricsTimer = setTimeout(() => {
    workspaceMetricsTimer = null;
    syncWorkspaceLayoutMetrics().catch(() => {});
  }, 120);
}

function setCrmPanelCollapsed(collapsed, persist = true) {
  crmPanelCollapsed = !!collapsed;
  if (persist) {
    try { localStorage.setItem(CRM_PANEL_COLLAPSED_STORAGE_KEY, crmPanelCollapsed ? '1' : '0'); } catch {}
  }
  return syncWorkspaceLayoutMetrics();
}

async function applyAccountSidebarState(collapsed, persist = true) {
  accountSidebarCollapsed = !!collapsed;
  document.body.classList.toggle('accounts-collapsed', accountSidebarCollapsed);

  const toggle = $('#accountSidebarToggle');
  if (toggle) {
    toggle.textContent = accountSidebarCollapsed ? '▶' : '◀';
    toggle.title = accountSidebarCollapsed ? '展开账号栏' : '收起账号栏';
    toggle.setAttribute('aria-label', toggle.title);
  }

  if (persist) {
    localStorage.setItem(ACCOUNT_SIDEBAR_STORAGE_KEY, accountSidebarCollapsed ? '1' : '0');
  }

  try {
    await window.yoko.setAccountSidebarCollapsed(accountSidebarCollapsed);
  } catch (error) {
    setStatus('账号栏布局同步失败：' + (error?.message || error));
  }
}

async function applyExternalAccountSidebarState(collapsed, persist = true) {
  // V1.23.11: the same arrow now collapses the left rail in BOTH native account
  // mode and aggregate customer mode (including the all-platform aggregate desk).
  // Previously aggregate mode forced the IPC value back to false, so only the
  // arrow glyph changed while the native WebContentsView bounds stayed put.
  externalAccountSidebarCollapsed = !!collapsed;
  const page = $('#externalWorkspacePage');
  page?.classList.toggle('external-sidebar-collapsed', externalAccountSidebarCollapsed);
  const toggle = $('#externalAccountSidebarToggle');
  if (toggle) {
    toggle.textContent = externalAccountSidebarCollapsed ? '▶' : '◀';
    toggle.title = externalAccountSidebarCollapsed ? '展开左侧栏' : '收起左侧栏';
    toggle.setAttribute('aria-label', toggle.title);
  }
  if (persist) {
    try { localStorage.setItem(EXTERNAL_ACCOUNT_SIDEBAR_STORAGE_KEY, externalAccountSidebarCollapsed ? '1' : '0'); } catch {}
  }
  try { await window.yoko.setExternalAccountSidebarCollapsed?.(externalAccountSidebarCollapsed); }
  catch (error) { setExternalStatus?.('左侧栏布局同步失败：' + (error?.message || error)); }
}

function setStatus(text) {
  const value = text || '';
  const global = $('#globalStatus');
  if (global) global.textContent = value;
  // V1.27.86: mirror status into the official API workspace while its legacy
  // top bar is hidden. Use the body class here because shellSurface is declared
  // later in this file.
  if (document.body?.classList?.contains('shell-native-api')) {
    const node = $('#nativeApiStatus');
    if (node) node.textContent = String(value || '');
  }
}

// V1.15.22 lightweight performance telemetry. It is intentionally polled on a
// slow timer and never participates in the customer-open critical path.
let runtimePerformanceTimer = null;
async function refreshRuntimePerformance() {
  const node = $('#performanceStatus');
  if (!node || typeof window.yoko?.getRuntimePerformance !== 'function') return;
  try {
    const perf = await window.yoko.getRuntimePerformance();
    const memory = Math.max(0, Number(perf?.memoryMb || 0) || 0);
    const cpu = Math.max(0, Number(perf?.cpuPercent || 0) || 0);
    const running = Math.max(0, Number(perf?.runtimeAccounts || 0) || 0);
    const open = Math.max(0, Number(perf?.openAccounts || 0) || 0);
    node.textContent = `CPU ${cpu.toFixed(0)}% · ${memory}MB`;
    node.title = `点击打开性能诊断 · CPU ${cpu.toFixed(1)}% · 内存 ${memory}MB · LINE运行 ${running}/${open} · 客户缓存 ${perf?.conversationCache || 0} · 头像缓存 ${perf?.avatarCache || 0}`;
    node.classList.toggle('hot', memory >= 1800 || cpu >= 80);
    node.classList.toggle('warn', !node.classList.contains('hot') && (memory >= 1200 || cpu >= 55));
  } catch {
    node.textContent = '性能 --';
    node.classList.remove('warn', 'hot');
  }
}
function startRuntimePerformanceMonitor() {
  if (runtimePerformanceTimer) clearInterval(runtimePerformanceTimer);
  refreshRuntimePerformance().catch(() => {});
  runtimePerformanceTimer = setInterval(() => refreshRuntimePerformance().catch(() => {}), 6500);
}

// V1.27.218 renderer smoothness sampler. requestAnimationFrame measures only the
// Yoko shell renderer; native Facebook/TikTok/LINE processes are measured by
// Electron app metrics in main.js. The sampler stores counters only.
const rendererPerformanceState = {
  startedAt:performance.now(), fps:0, lastFrameAt:0, frames:0, windowStartedAt:performance.now(),
  maxFrameGapMs:0, jankFrames:0, longTasks:0, longTaskMs:0, lastLongTaskMs:0
};
function startRendererPerformanceSampler() {
  const tick=now=>{
    if(rendererPerformanceState.lastFrameAt){
      const gap=Math.max(0,now-rendererPerformanceState.lastFrameAt);
      rendererPerformanceState.maxFrameGapMs=Math.max(rendererPerformanceState.maxFrameGapMs,gap);
      if(gap>=50)rendererPerformanceState.jankFrames+=1;
    }
    rendererPerformanceState.lastFrameAt=now;
    rendererPerformanceState.frames+=1;
    const elapsed=now-rendererPerformanceState.windowStartedAt;
    if(elapsed>=1000){
      rendererPerformanceState.fps=Math.round((rendererPerformanceState.frames*1000/elapsed)*10)/10;
      rendererPerformanceState.frames=0;
      rendererPerformanceState.windowStartedAt=now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    if(typeof PerformanceObserver==='function'){
      const obs=new PerformanceObserver(list=>{
        for(const entry of list.getEntries()){
          const duration=Math.max(0,Number(entry.duration||0)||0);
          rendererPerformanceState.longTasks+=1;
          rendererPerformanceState.longTaskMs+=duration;
          rendererPerformanceState.lastLongTaskMs=duration;
        }
      });
      obs.observe({entryTypes:['longtask']});
    }
  } catch {}
}
startRendererPerformanceSampler();

let performanceDiagnosticsTimer = null;
let performanceDiagnosticsLastPayload = null;
function performanceSeverity(perf, renderer=rendererPerformanceState) {
  const memory=Number(perf?.memoryMb||0), cpu=Number(perf?.cpuPercent||0), fps=Number(renderer?.fps||0);
  const loop=perf?.performanceDiagnostics?.mainLoop||{};
  if(cpu>=80||memory>=1800||(fps>0&&fps<30)||Number(loop.lastDriftMs||0)>=300)return 'hot';
  if(cpu>=55||memory>=1200||(fps>0&&fps<48)||Number(loop.lastDriftMs||0)>=100)return 'warn';
  return 'ok';
}
function performanceFormatMb(value){const n=Math.max(0,Number(value||0)||0);return n>=1024?`${(n/1024).toFixed(1)}GB`:`${Math.round(n)}MB`;}
function performancePlatformLabel(row={}){
  const p=String(row.platform||row.kind||'').toLowerCase();
  return ({line:'LINE',facebook:'Facebook',metabusiness:'Meta Business',tiktok:'TikTok',telegram:'Telegram',instagram:'Instagram',whatsapp:'WhatsApp',chatgpt:'ChatGPT',yoko:'Yoko'})[p]||p||'Web';
}
function performanceRowSeverity(row={}){
  const cpu=Number(row.cpuPercent||0),memory=Number(row.memoryMb||0);
  if(cpu>=45||memory>=900||row.crashed||row.renderProcessGone)return 'hot';
  if(cpu>=20||memory>=500||row.loading)return 'warn';
  return '';
}
function renderPerformanceDiagnostics(perf={}) {
  performanceDiagnosticsLastPayload=perf;
  const detail=perf?.performanceDiagnostics||{};
  const queues=detail?.queues||{};
  const renderer={...rendererPerformanceState};
  const severity=performanceSeverity(perf,renderer);
  const badge=$('#performanceDiagOverall');
  if(badge){badge.className=`performance-diag-badge ${severity}`;badge.textContent=severity==='hot'?'高负载 / 明显卡顿':severity==='warn'?'有性能压力':'运行正常';}
  if($('#performanceDiagCheckedAt'))$('#performanceDiagCheckedAt').textContent=`采样 ${new Date(perf?.generatedAt||Date.now()).toLocaleTimeString()}`;
  if($('#performanceDiagCpu'))$('#performanceDiagCpu').textContent=`${Number(perf?.cpuPercent||0).toFixed(1)}%`;
  if($('#performanceDiagCpuHint'))$('#performanceDiagCpuHint').textContent=`${Number(perf?.processCount||0)} 个 Electron 进程 · ${Number(detail?.system?.cpuCount||0)} 核 CPU`;
  if($('#performanceDiagMemory'))$('#performanceDiagMemory').textContent=performanceFormatMb(perf?.memoryMb);
  if($('#performanceDiagMemoryHint'))$('#performanceDiagMemoryHint').textContent=`系统已用 ${Number(detail?.system?.usedMemoryPercent||0).toFixed(1)}% · 空闲 ${performanceFormatMb(detail?.system?.freeMemoryMb)}`;
  if($('#performanceDiagFps'))$('#performanceDiagFps').textContent=renderer.fps?`${Number(renderer.fps).toFixed(1)} FPS`:'采样中';
  if($('#performanceDiagFpsHint'))$('#performanceDiagFpsHint').textContent=`卡帧 ${renderer.jankFrames} · Long Task ${renderer.longTasks}`;
  if($('#performanceDiagJank'))$('#performanceDiagJank').textContent=`${Math.round(Number(detail?.mainLoop?.lastDriftMs||0))}ms`;
  if($('#performanceDiagJankHint'))$('#performanceDiagJankHint').textContent=`最大 ${Math.round(Number(detail?.mainLoop?.maxDriftMs||0))}ms · >150ms ${Number(detail?.mainLoop?.over150ms||0)} 次`;
  const storage=detail?.storage?.nativeApi||{};
  if($('#performanceDiagSqlite'))$('#performanceDiagSqlite').textContent=Number(storage.sqliteReadSamples||0)?`${Math.round(Number(storage.sqliteReadAvgMs||0))}ms`:'暂无样本';
  if($('#performanceDiagSqliteHint'))$('#performanceDiagSqliteHint').textContent=Number(storage.sqliteReadSamples||0)?`P95 ${Math.round(Number(storage.sqliteReadP95Ms||0))}ms · ${Number(storage.sqliteReadSamples||0)} 次 SQLite/API 读取`:`打开官方 API 客户后自动采样`;
  const autoPending=Number(queues?.automation?.pending||0),autoRunning=Number(queues?.automation?.running||0);
  const gptQueued=Number(queues?.gpt?.queuedJapanese||0)+Number(queues?.gpt?.deferredGeneration||0);
  const transPending=Number(queues?.translation?.inFlight||0);
  if($('#performanceDiagQueue'))$('#performanceDiagQueue').textContent=String(autoPending+autoRunning+gptQueued+transPending);
  if($('#performanceDiagQueueHint'))$('#performanceDiagQueueHint').textContent=`发送 ${autoPending}/${autoRunning} · GPT ${gptQueued} · 翻译 ${transPending}`;

  const body=$('#performanceDiagProcessBody');
  const rows=Array.isArray(detail?.webContents)?detail.webContents:[];
  if(body){
    body.innerHTML=rows.length?rows.map(row=>{
      const sev=performanceRowSeverity(row);const status=row.crashed||row.renderProcessGone?'异常':row.loading?'加载中':row.active?'当前':'后台';
      return `<tr class="${row.active?'active ':''}${sev}"><td><div class="performance-process-name"><strong>${escapeHtml(row.name||performancePlatformLabel(row))}</strong><small>${escapeHtml(performancePlatformLabel(row))}${row.warmStandby?' · 预热':''}${Number(row.childWindows||0)?` · 子窗口 ${Number(row.childWindows||0)}`:''}</small></div></td><td>${escapeHtml(status)}</td><td>${Number(row.cpuPercent||0).toFixed(1)}%</td><td>${performanceFormatMb(row.memoryMb)}</td><td>${Number(row.pid||0)||'-'}</td><td>${escapeHtml(row.host||'-')}</td></tr>`;
    }).join(''):'<tr><td colspan="6">当前没有运行中的聊天网页进程。</td></tr>';
  }
  const qlist=$('#performanceDiagQueueList');
  if(qlist){
    const trans=queues?.translation||{}, shared=trans?.shared||{}, gpt=queues?.gpt||{};
    qlist.innerHTML=[
      ['自动发送队列',`等待 ${autoPending} · 执行 ${autoRunning} · 队列 ${Number(queues?.automation?.queues||0)}`],
      ['GPT 队列',`待发送 ${Number(gpt.queuedJapanese||0)} · 生成等待 ${Number(gpt.deferredGeneration||0)} · 监控${gpt?.monitor?.busy?'忙':'空闲'}`],
      ['翻译任务',`执行 ${Number(trans.inFlight||0)} · Busy账号 ${Number(trans.busyAccounts||0)} · ${Number(trans.fallbackAccounts||0)} 个扫描器`],
      ['DOM 翻译扫描',`${Number(trans.scanRatePerMinute||0).toFixed(1)} 次/分钟 · 缓存 ${Number(perf.translationDisplayCache||0)}`],
      ['VPS / DeepL',shared.lastProviderAt?`${shared.lastProviderOk===false?'最近失败':'最近正常'} · ${Math.round(Number(shared.lastProviderElapsedMs||0))}ms`:'暂无 Provider 样本'],
      ['官方 API 请求',`${Number(storage.inFlight||0)} 执行中 · 平均 ${Math.round(Number(storage.avgLatencyMs||0))}ms · P95 ${Math.round(Number(storage.p95LatencyMs||0))}ms`],
      ['切客户',`${Number(nativeApiV254Perf.customerSwitch.lastMs||0)}ms · 首屏 ${Number(nativeApiV254Perf.customerSwitch.firstPaintLastMs||0)}ms · 取消旧任务 ${Number(nativeApiV254Perf.customerSwitch.staleCancelled||0)}`],
      ['IPC 合并',`调用 ${Number(nativeApiV254Perf.ipc.calls||0)} · 实际 ${Number(nativeApiV254Perf.ipc.invoked||0)} · 合并 ${Number(nativeApiV254Perf.ipc.joined||0)}`],
      ['UI 渲染',`客户全刷 ${Number(nativeApiV254Perf.render.customerFull||0)} · 行补丁 ${Number(nativeApiV254Perf.render.customerRowPatch||0)} · 消息全刷 ${Number(nativeApiV254Perf.render.messageFull||0)}`],
      ['GPT 导航',`${Number(perf?.gptStability?.workbench?.navigationCount||0)} 次 · 合并 ${Number(perf?.gptStability?.workbench?.routeCoalesce?.joins||0)} · 冷却跳过 ${Number(perf?.gptStability?.workbench?.routeCoalesce?.cooldownSkips||0)}`]
    ].map(([k,v])=>`<div><span>${escapeHtml(k)}</span><strong>${escapeHtml(v)}</strong></div>`).join('');
  }
  const advice=[];
  const topCpu=[...rows].sort((a,b)=>Number(b.cpuPercent||0)-Number(a.cpuPercent||0))[0];
  const topMem=[...rows].sort((a,b)=>Number(b.memoryMb||0)-Number(a.memoryMb||0))[0];
  if(Number(perf.cpuPercent||0)>=55&&topCpu)advice.push(['warn',`CPU 当前 ${Number(perf.cpuPercent||0).toFixed(1)}%，最高网页进程是 ${topCpu.name}（${Number(topCpu.cpuPercent||0).toFixed(1)}%）。如果持续升高，优先检查这个账号页面。`]);
  if(Number(perf.memoryMb||0)>=1200&&topMem)advice.push([Number(perf.memoryMb||0)>=1800?'hot':'warn',`Yoko 当前使用 ${performanceFormatMb(perf.memoryMb)}，占用最高的是 ${topMem.name}（${performanceFormatMb(topMem.memoryMb)}）。关闭不用的网页账号后观察是否明显下降。`]);
  if(renderer.fps>0&&renderer.fps<48)advice.push([renderer.fps<30?'hot':'warn',`Yoko 主界面只有 ${Number(renderer.fps).toFixed(1)} FPS，说明卡顿至少有一部分发生在界面渲染层。Long Task ${renderer.longTasks} 次。`]);
  if(Number(detail?.mainLoop?.lastDriftMs||0)>=100||Number(detail?.mainLoop?.over150ms||0)>0)advice.push(['warn',`主进程出现事件循环延迟：当前 ${Math.round(Number(detail?.mainLoop?.lastDriftMs||0))}ms，历史 >150ms ${Number(detail?.mainLoop?.over150ms||0)} 次。发送、数据库/文件写入或同步任务可能在抢主线程。`]);
  if(autoPending>=3||gptQueued>=2)advice.push(['warn',`后台任务有积压：自动发送等待 ${autoPending}，GPT 等待 ${gptQueued}。如果数字持续增长而不下降，卡顿来源更偏后台队列。`]);
  if(Number(trans.busyAccounts||0)>0||Number(trans.inFlight||0)>=3)advice.push(['warn',`翻译扫描正在繁忙：${Number(trans.inFlight||0)} 个翻译执行中、${Number(trans.busyAccounts||0)} 个账号扫描 Busy。切客户卡顿时可重点看这里是否同步升高。`]);
  if(Number(storage.sqliteReadP95Ms||0)>=800)advice.push(['warn',`SQLite/API 读取 P95 已到 ${Math.round(Number(storage.sqliteReadP95Ms||0))}ms。客户历史打开慢更可能来自 VPS/SQLite/网络，而不是本机网页渲染。`]);
  const recentSlow=(perf?.uiLatency?.slowEvents||[]).slice(-10);
  if(recentSlow.length)advice.push(['warn',`最近卡顿：${recentSlow.map(row=>`${String(row.operation||row.type||'任务')} ${Math.round(Number(row.elapsedMs||0))}ms`).join(' · ')}`]);
  if(!advice.length)advice.push(['ok','当前采样没有发现明显瓶颈。保持这个窗口打开 5～10 分钟，并在发生卡顿时看哪个指标同时变黄/变红。']);
  const adviceNode=$('#performanceDiagAdvice');if(adviceNode)adviceNode.innerHTML=advice.slice(0,6).map(([cls,msg])=>`<div class="${cls}">${escapeHtml(msg)}</div>`).join('');
  const raw={runtime:perf,renderer:{...rendererPerformanceState,startedAt:Math.round(rendererPerformanceState.startedAt),lastFrameAt:Math.round(rendererPerformanceState.lastFrameAt),windowStartedAt:Math.round(rendererPerformanceState.windowStartedAt)},nativeApiV127254:nativeApiV254Snapshot(),recentSlow};
  if($('#performanceDiagRaw'))$('#performanceDiagRaw').textContent=JSON.stringify(raw,null,2);
}
async function refreshPerformanceDiagnostics({quiet=false}={}) {
  try{
    const perf=await window.yoko.getRuntimePerformance?.();
    if(perf)renderPerformanceDiagnostics(perf);
    return perf;
  }catch(error){
    if(!quiet){const badge=$('#performanceDiagOverall');if(badge){badge.className='performance-diag-badge hot';badge.textContent='读取失败';}setStatus('性能诊断读取失败：'+(error?.message||error));}
    return null;
  }
}
async function openPerformanceDiagnostics(){
  await openModal('performanceDiagnosticsModal');
  await refreshPerformanceDiagnostics({quiet:false});
  if(performanceDiagnosticsTimer)clearInterval(performanceDiagnosticsTimer);
  performanceDiagnosticsTimer=setInterval(()=>refreshPerformanceDiagnostics({quiet:true}).catch(()=>{}),2200);
}
$('#performanceStatus')?.addEventListener('click',()=>openPerformanceDiagnostics().catch(error=>setStatus('打开性能诊断失败：'+(error?.message||error))));
$('#performanceDiagRefreshBtn')?.addEventListener('click',()=>refreshPerformanceDiagnostics({quiet:false}));
$('#performanceDiagCopyBtn')?.addEventListener('click',async()=>{
  const payload={runtime:performanceDiagnosticsLastPayload||{},renderer:{...rendererPerformanceState}};
  const copied=await copyTextWithFallback(JSON.stringify(payload,null,2));
  setStatus(copied?'性能诊断已复制，可以直接发给我分析':'复制性能诊断失败');
});

// V1.15.23 Operations Center. This monitor is intentionally idle while the
// modal is closed and never touches the aggregate customer-open path.
let opsHealthTimer = null;
let opsHealthRefreshBusy = false;

function opsStatusLabel(status) {
  return ({
    online: '在线', loading: '加载中', starting: '启动中',
    unresponsive: '无响应', error: '异常', offline: '离线', closed: '已关闭'
  })[String(status || '')] || '未知';
}

function opsFormatTimestamp(raw) {
  let value = Number(raw || 0) || 0;
  if (!value) return '暂无';
  if (value < 1e12) value *= 1000;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '暂无';
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function renderOpsHealth(snapshot) {
  const counts = snapshot?.counts || {};
  const set = (id, value) => { const node = $(id); if (node) node.textContent = String(value ?? 0); };
  set('#opsHealthTotal', counts.total || 0);
  set('#opsHealthRunning', counts.running || 0);
  set('#opsHealthHealthy', counts.healthy || 0);
  set('#opsHealthProblem', counts.problem || 0);
  const generated = $('#opsHealthGenerated');
  if (generated) generated.textContent = snapshot?.generatedAt ? `更新 ${opsFormatTimestamp(snapshot.generatedAt)}` : '尚未读取';

  const list = $('#opsHealthList');
  if (!list) return;
  const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
  if (!accounts.length) {
    list.innerHTML = '<div class="ops-health-empty">当前还没有 LINE 账号</div>';
    return;
  }
  list.innerHTML = accounts.map(item => {
    const status = String(item.status || 'closed');
    const problem = ['error','unresponsive','offline'].includes(status);
    const pending = ['loading','starting'].includes(status);
    const canStart = status === 'closed';
    const lastMsg = item.lastMessageAt ? `最近消息 ${opsFormatTimestamp(item.lastMessageAt)}` : '暂无消息时间';
    const error = String(item.lastError || '').trim();
    const network = item.proxyEnabled
      ? `${item.proxyLabel || '代理'}${item.lastLatencyMs != null ? ` · ${item.lastLatencyMs}ms` : ''}`
      : `直连${item.lastLatencyMs != null ? ` · ${item.lastLatencyMs}ms` : ''}`;
    return `
      <div class="ops-health-row${problem ? ' problem' : ''}${pending ? ' pending' : ''}" data-account-id="${escapeHtml(item.accountId)}">
        <div class="ops-health-name">
          <strong>${escapeHtml(item.name || item.accountName || 'LINE')}</strong>
          <small>${escapeHtml(lastMsg)}</small>
        </div>
        <div class="ops-health-meta">
          <span class="ops-health-status ${escapeHtml(status)}">${escapeHtml(opsStatusLabel(status))}</span>
          <small>${error ? escapeHtml(error.slice(0, 90)) : (item.online ? 'LINE 会话正常' : '等待状态更新')}</small>
        </div>
        <div class="ops-health-memory">
          <strong>${Math.max(0, Number(item.memoryMb || 0))}MB</strong>
          <small>CPU ${Math.max(0, Number(item.cpuPercent || 0)).toFixed(1)}%</small>
        </div>
        <div class="ops-health-network">
          <div>${escapeHtml(network)}</div>
          <small>${item.lastPublicIp ? `IP ${escapeHtml(item.lastPublicIp)}` : '未测速'}</small>
        </div>
        <div class="ops-health-action">
          ${canStart ? `<button type="button" data-ops-start="${escapeHtml(item.accountId)}">启动</button>` : '<span class="ops-monitor-only">仅监控</span>'}
        </div>
      </div>`;
  }).join('');
}

async function refreshOpsHealth({ quiet = false } = {}) {
  if (opsHealthRefreshBusy || typeof window.yoko?.getAccountHealthCenter !== 'function') return;
  opsHealthRefreshBusy = true;
  try {
    const snapshot = await window.yoko.getAccountHealthCenter();
    renderOpsHealth(snapshot);
  } catch (error) {
    if (!quiet) setStatus('读取账号健康状态失败：' + (error?.message || error));
  } finally {
    opsHealthRefreshBusy = false;
  }
}

function collectOperationsWorkspaceBackup() {
  const shellLocalStorage = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = String(localStorage.key(i) || '');
      if (!key.startsWith('yoko.')) continue;
      shellLocalStorage[key] = String(localStorage.getItem(key) ?? '');
    }
  } catch {}
  return { shellLocalStorage };
}

function applyOperationsWorkspaceBackup(workspace = {}) {
  const values = workspace?.shellLocalStorage;
  if (!values || typeof values !== 'object') return 0;
  let restored = 0;
  try {
    for (const [key, value] of Object.entries(values)) {
      if (!String(key).startsWith('yoko.')) continue;
      localStorage.setItem(String(key), String(value ?? ''));
      restored += 1;
    }
  } catch {}
  return restored;
}

function startOpsHealthMonitor() {
  if (opsHealthTimer) clearInterval(opsHealthTimer);
  refreshOpsHealth().catch(() => {});
  opsHealthTimer = setInterval(() => {
    if ($('#opsModal')?.classList.contains('hidden')) return;
    refreshOpsHealth({ quiet: true }).catch(() => {});
  }, 5000);
}

let workspaceMode = 'line';
let workspaceModeSwitchToken = 0;
let aggregateInbox = { accounts: [], conversations: [], unreadCount: 0 };
let aggregateUnreadOnly = false;
let aggregateCustomerFilter = 'all';
let aggregateLineLifecycleFilter = 'all';
let aggregateCustomerAccountFilter = '';
const LINE_LIFECYCLE_GROUPS = [
  {id:'new',label:'新客户'},
  {id:'day1',label:'第1天'},{id:'day2',label:'第2天'},{id:'day3',label:'第3天'},{id:'day4',label:'第4天'},{id:'day5',label:'第5天'},
  {id:'day6',label:'第6天'},{id:'day7',label:'第7天'},{id:'day8',label:'第8天'},{id:'day9',label:'第9天'},{id:'day10',label:'第10天+'}
];
// V1.27.276: operator day calibration is a moving anchor, not a permanent lock.
// If the operator sets a customer to Day 7 today, the effective day becomes Day 8
// after the next 05:00 JST boundary, Day 9 after the following boundary, etc.
const CUSTOMER_DAY_CALIBRATION_STORAGE_KEY='yoko.customerDayCalibration.v127276';
let customerDayCalibrationCache=null;
function customerDayCalibrationState(){
  if(customerDayCalibrationCache&&typeof customerDayCalibrationCache==='object')return customerDayCalibrationCache;
  try{const raw=JSON.parse(localStorage.getItem(CUSTOMER_DAY_CALIBRATION_STORAGE_KEY)||'{}');customerDayCalibrationCache=raw&&typeof raw==='object'?raw:{};}catch{customerDayCalibrationCache={};}
  return customerDayCalibrationCache;
}
function customerDayCalibrationPersist(){try{localStorage.setItem(CUSTOMER_DAY_CALIBRATION_STORAGE_KEY,JSON.stringify(customerDayCalibrationState()));}catch{}}
function customerDayCalibrationKey(item={},scope='line'){
  if(scope==='native')return `native:${nativeApiKey(item)}`;
  return `line:${aggregateConversationKey(item)}`;
}
function customerDayCalibrationRecord(item={},scope='line'){
  const key=customerDayCalibrationKey(item,scope);if(!key||/:$/.test(key))return null;
  const row=customerDayCalibrationState()[key];
  return row&&Number(row.day)>0&&Number.isFinite(Number(row.anchorOrdinal))?row:null;
}
function customerDayCalibrationEffective(item={},scope='line',now=Date.now()){
  const row=customerDayCalibrationRecord(item,scope);if(!row)return 0;
  const current=nativeApiBusinessDayOrdinalJst(now),anchor=Number(row.anchorOrdinal);
  if(!Number.isFinite(current)||!Number.isFinite(anchor))return Math.max(1,Number(row.day)||1);
  return Math.max(1,(Number(row.day)||1)+(current-anchor));
}
function customerDayCalibrationSet(item={},scope='line',day=0){
  const key=customerDayCalibrationKey(item,scope);if(!key||/:$/.test(key))return false;
  const state=customerDayCalibrationState();const value=Math.max(0,Math.min(10,Number(day)||0));
  if(!value)delete state[key];
  else state[key]={day:value,anchorOrdinal:nativeApiBusinessDayOrdinalJst(Date.now()),updatedAt:Date.now()};
  customerDayCalibrationPersist();return true;
}
function customerDayLabel(day=0){day=Math.max(0,Number(day)||0);return day>10?'第10天+':(day>=1?`第${day}天`:'核对中');}
function lineLifecycleBlocked(item={}) {
  const status=String(item?.crmProfile?.serviceStatus||item?.crmServiceStatus||'').trim().toLowerCase();
  const stage=String(item?.crmProfile?.stage||item?.crmStage||'').trim();
  return item?.lineLifecycleBlocked===true || status==='blacklist' || /^(?:黑名单|blacklist|ブラックリスト)$/i.test(stage);
}
function lineLifecycleGroupId(item={}) {
  if(lineLifecycleBlocked(item))return '';
  const calibrated=customerDayCalibrationEffective(item,'line');
  if(calibrated>0)return `day${Math.min(10,calibrated)}`;
  const raw=String(item?.lineLifecycleGroup||'').trim();
  if(raw==='new'||/^day(?:[1-9]|10)$/.test(raw))return raw;
  const day=Math.max(0,Math.min(10,Number(item?.lineLifecycleDay||0)||0));
  return day>0?`day${day}`:(Number(item?.lineLifecycleArrivalAt||0)>0?'new':'');
}
function lineLifecycleGroupLabel(id='') { return LINE_LIFECYCLE_GROUPS.find(group=>group.id===String(id||''))?.label||''; }
function lineLifecycleEffectiveDay(item={}){
  const calibrated=customerDayCalibrationEffective(item,'line');
  return calibrated>0?calibrated:Math.max(0,Number(item?.lineLifecycleRawDay||item?.lineLifecycleDay||0)||0);
}
function lineLifecycleDayBadgeHtml(item={}){
  if(lineLifecycleBlocked(item))return '';
  const effective=lineLifecycleEffectiveDay(item),label=effective>0?customerDayLabel(effective):(Number(item?.lineLifecycleArrivalAt||0)>0?'新客户':'未归类');
  return `<span class="aggregate-customer-lifecycle-badge ${escapeHtml(lineLifecycleGroupId(item))}" data-line-day-calibration="1" data-line-day-key="${escapeHtml(aggregateConversationKey(item))}" title="点击校准当前第几天；之后按日本时间05:00自动进入下一天">${escapeHtml(label)}</span>`;
}
function closeCustomerDayCalibrationPicker(){const old=document.querySelector('.customer-day-calibration-picker');if(old)old.remove();}
function openCustomerDayCalibrationPicker(item={},anchor=null){
  closeCustomerDayCalibrationPicker();if(!item||!anchor)return;
  const manual=customerDayCalibrationRecord(item,'line'),effective=lineLifecycleEffectiveDay(item),automatic=Math.max(0,Number(item?.lineLifecycleRawDay||item?.lineLifecycleDay||0)||0);
  const select=document.createElement('select');select.className='customer-day-calibration-picker';
  const selected=manual?String(Math.min(10,Math.max(1,effective))):'';
  const auto=document.createElement('option');auto.value='';auto.textContent=`自动 · ${automatic>0?customerDayLabel(automatic):'按首次聊天时间'}`;select.appendChild(auto);
  for(let day=1;day<=10;day++){const option=document.createElement('option');option.value=String(day);option.textContent=day===10?'第10天':`第${day}天`;select.appendChild(option);}
  select.value=selected;
  const r=anchor.getBoundingClientRect();select.style.left=`${Math.max(8,Math.min(window.innerWidth-150,r.left))}px`;select.style.top=`${Math.min(window.innerHeight-240,r.bottom+4)}px`;document.body.appendChild(select);
  const done=()=>setTimeout(()=>closeCustomerDayCalibrationPicker(),30);
  select.addEventListener('change',()=>{const day=Math.max(0,Math.min(10,Number(select.value||0)||0));customerDayCalibrationSet(item,'line',day);aggregateCustomerRenderSignature='';renderAggregateCustomerSidebar();setStatus(day?`${item.displayName||'客户'} · 已校准为第${day}天；下一个日本时间05:00自动进入下一天`:`${item.displayName||'客户'} · 已恢复自动判断客户天数`);done();},{once:true});
  select.addEventListener('blur',done,{once:true});select.focus();
}

let aggregateRefreshTimer = null;
let aggregateUiRenderTimer = null;
let aggregateCustomerRenderSignature = '';
let aggregateLastRenderedCustomerKeys = [];
let aggregateSelectedConversationKey = '';
let aggregateSelectedConversation = null;
let aggregateConversationOpenToken = 0;
// V1.15.18: hover/queue prediction prewarms only the latest likely target. A
// short debounce prevents sweeping the whole list when the mouse moves quickly.
let aggregateConversationPrewarmTimer = null;
let aggregateConversationPrewarmKey = '';
let aggregateReplyBusy = false;
let aggregateCrmPanelContext = null;
let aggregateCrmPanelHydrating = false;
let aggregateCrmPanelSaveTimer = null;
let aggregateCrmPanelDirty = false;
let lineCrmSyncTimer = null;
let lineCrmSyncInFlight = false;
let lineCrmLastConversationKey = '';
let lineCrmMissCount = 0;

// V1.15.21 operational state. These are intentionally renderer-local so they
// never slow the already-stable exact-MID customer switch path.
const accountHealthState = new Map();
const AGGREGATE_WORKSPACE_STORAGE_KEY = 'yoko.aggregateWorkspace.v1';
const AGGREGATE_RECENT_STORAGE_KEY = 'yoko.aggregateRecentCustomers.v1';
let aggregateWorkspaceSaveTimer = null;
let aggregateRecentConversationKeys = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(AGGREGATE_RECENT_STORAGE_KEY) || '[]');
    return Array.isArray(raw) ? raw.map(String).filter(Boolean).slice(0, 10) : [];
  } catch {
    return [];
  }
})();
let aggregateWorkspaceRestoreState = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(AGGREGATE_WORKSPACE_STORAGE_KEY) || 'null');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
})();
// V1.15.31 startup gate: never restore Aggregate Mode while LINE is still
// restoring its authenticated session. Aggregate focus manipulates LINE's chat
// layout; doing that on the login/bootstrap route can make LINE invalidate the
// just-restored session with a temporary-error logout.
let aggregateStartupRestorePending = false;
let aggregateStartupRestoreInFlight = false;
let aggregateStartupRestoreReadySince = 0;
let aggregateStartupRestoreTimer = null;

const AGGREGATE_HIDDEN_STORAGE_KEY = 'yoko.aggregateHiddenConversations.v1';
const AGGREGATE_ROUND_ROBIN_STORAGE_KEY = 'yoko.aggregateRoundRobin.v2';
const AGGREGATE_VIEWED_STORAGE_KEY = 'yoko.aggregateViewed.v1';
const AGGREGATE_MANUAL_READ_STORAGE_KEY = 'yoko.aggregateManualRead.v1';
const AGGREGATE_PINNED_STORAGE_KEY = 'yoko.aggregatePinnedCustomers.v1';
const AGGREGATE_OPENED_STORAGE_KEY = 'yoko.aggregateOpenedAt.v1';
const AGGREGATE_NOTIFICATIONS_STORAGE_KEY = 'yoko.aggregateNotifications.v1';
let aggregatePinnedConversationKeys = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(AGGREGATE_PINNED_STORAGE_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.map(String).filter(Boolean).slice(0, 1000) : []);
  } catch {
    return new Set();
  }
})();
let aggregateOpenedAt = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(AGGREGATE_OPENED_STORAGE_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
})();
let aggregateNotificationState = (() => {
  const fallback = { initialized: false, accounts: {}, observed: {}, items: [] };
  try {
    const raw = JSON.parse(localStorage.getItem(AGGREGATE_NOTIFICATIONS_STORAGE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return fallback;
    return {
      initialized: raw.initialized === true,
      accounts: raw.accounts && typeof raw.accounts === 'object' ? raw.accounts : {},
      observed: raw.observed && typeof raw.observed === 'object' ? raw.observed : {},
      items: Array.isArray(raw.items) ? raw.items.slice(0, 200) : []
    };
  } catch {
    return fallback;
  }
})();
let aggregateViewedState = (() => {
  const fallback = { versions: {} };
  try {
    const raw = JSON.parse(localStorage.getItem(AGGREGATE_VIEWED_STORAGE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return fallback;
    return { versions: raw.versions && typeof raw.versions === 'object' ? raw.versions : {} };
  } catch {
    return fallback;
  }
})();

// V1.23.18: manual read is an operator-level round-robin completion marker.
// It does not send a message or mutate LINE history. The marker is bound to
// the customer's newest incoming timestamp/message; a later incoming message
// automatically invalidates it and returns the customer to the waiting queue.
let aggregateManualReadState = (() => {
  const fallback = { records: {} };
  try {
    const raw = JSON.parse(localStorage.getItem(AGGREGATE_MANUAL_READ_STORAGE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return fallback;
    return { records: raw.records && typeof raw.records === 'object' ? raw.records : {} };
  } catch {
    return fallback;
  }
})();

function saveAggregateManualReadState() {
  try {
    const entries = Object.entries(aggregateManualReadState.records || {});
    if (entries.length > 3500) {
      entries.sort((a, b) => Number(b[1]?.markedAt || 0) - Number(a[1]?.markedAt || 0));
      aggregateManualReadState.records = Object.fromEntries(entries.slice(0, 3000));
    }
    localStorage.setItem(AGGREGATE_MANUAL_READ_STORAGE_KEY, JSON.stringify(aggregateManualReadState));
  } catch {}
}

function aggregateManualReadAt(item) {
  if (!item || typeof item !== 'object') return 0;
  const key = aggregateConversationKey(item);
  const record = key ? aggregateManualReadState.records?.[key] : null;
  if (!record) return 0;
  const incomingAt = aggregateCustomerIncomingAt(item);
  const recordedIncomingAt = Math.max(0, Number(record.incomingAt || 0) || 0);
  if (incomingAt <= 0 || recordedIncomingAt <= 0 || incomingAt > recordedIncomingAt) return 0;
  const currentMessageId = String(item?.lastDirection || '') === 'customer' ? String(item?.lastMessageId || '').trim() : '';
  const recordedMessageId = String(record.lastMessageId || '').trim();
  if (currentMessageId && recordedMessageId && currentMessageId !== recordedMessageId) return 0;
  return Math.max(0, Number(record.markedAt || 0) || 0);
}

function markAggregateConversationManualRead(item) {
  if (!item || typeof item !== 'object') return false;
  const key = aggregateConversationKey(item);
  const incomingAt = aggregateCustomerIncomingAt(item);
  if (!key || incomingAt <= 0) return false;
  aggregateManualReadState.records[key] = {
    incomingAt,
    lastMessageId: String(item?.lastDirection || '') === 'customer' ? String(item?.lastMessageId || '').trim() : '',
    markedAt: Date.now()
  };
  saveAggregateManualReadState();
  markAggregateConversationViewed(item, { quiet: true });
  aggregateCustomerRenderSignature = '';
  return true;
}

function aggregateConversationMessageVersion(item) {
  if (!item || typeof item !== 'object') return '';
  const messageId = String(item.lastMessageId || '').trim();
  const timestamp = Math.max(0, Number(item.timestamp || 0) || 0);
  const direction = String(item.lastDirection || 'customer');
  return `${messageId}|${timestamp}|${direction}`;
}

function saveAggregateViewedState() {
  try {
    const entries = Object.entries(aggregateViewedState.versions || {});
    if (entries.length > 3500) {
      entries.sort((a, b) => Number(b[1]?.viewedAt || 0) - Number(a[1]?.viewedAt || 0));
      aggregateViewedState.versions = Object.fromEntries(entries.slice(0, 3000));
    }
    localStorage.setItem(AGGREGATE_VIEWED_STORAGE_KEY, JSON.stringify(aggregateViewedState));
  } catch {}
}

function markAggregateConversationViewed(item, { quiet = false } = {}) {
  if (!item || typeof item !== 'object') return false;
  const key = aggregateConversationKey(item);
  if (!key) return false;
  const version = aggregateConversationMessageVersion(item);
  if (!version) return false;
  const previous = aggregateViewedState.versions[key];
  if (previous?.version === version) return false;
  aggregateViewedState.versions[key] = { version, viewedAt: Date.now() };
  saveAggregateViewedState();
  aggregateCustomerRenderSignature = '';
  if (!quiet) {
    renderAggregateCustomerSidebar();
    renderAggregateUnreadBadge();
  }
  return true;
}

function aggregateCustomerIncomingAt(item) {
  const direct = Math.max(0, Number(item?.lastIncomingAt || 0) || 0);
  if (direct > 0) return direct;
  return String(item?.lastDirection || '') === 'customer'
    ? Math.max(0, Number(item?.timestamp || 0) || 0)
    : 0;
}

function aggregateCustomerOutgoingAt(item) {
  const direct = Math.max(0, Number(item?.lastOutgoingAt || 0) || 0);
  if (direct > 0) return direct;
  return String(item?.lastDirection || '') === 'me'
    ? Math.max(0, Number(item?.timestamp || 0) || 0)
    : 0;
}

// V1.23.18 round-robin rule: simply opening a chat never completes a turn.
// A turn completes after a real outgoing reply OR an explicit right-click
// "标记已读" action for the customer's current newest incoming message.
// A later incoming message invalidates the manual marker and re-enters the queue.
function aggregateCustomerAwaitingReply(item) {
  if (!item || item.hasConversation === false) return false;
  if (aggregateManualReadAt(item) > 0) return false;
  const incoming = aggregateCustomerIncomingAt(item);
  const outgoing = aggregateCustomerOutgoingAt(item);
  if (incoming > 0) return incoming > outgoing;
  return String(item?.lastDirection || '') === 'customer' && Math.max(0, Number(item?.unreadCount || 0) || 0) > 0;
}

function aggregateRoundRobinOrderAt(item) {
  return Math.max(
    aggregateCustomerOutgoingAt(item),
    aggregateManualReadAt(item),
    Math.max(0, Number(item?.timestamp || 0) || 0),
    aggregateCustomerIncomingAt(item),
    Math.max(0, Number(item?.firstMessageAt || 0) || 0)
  );
}

function aggregateEffectiveUnreadCount(item) {
  if (aggregateManualReadAt(item) > 0) return 0;
  const raw = Math.max(0, Number(item?.unreadCount || 0) || 0);
  // In round-robin mode the unread tab is an actionable "待回复" queue. Keep
  // at least one badge after the operator opens the chat; only a real reply
  // removes it from this queue.
  if (aggregateRoundRobinState?.enabled !== false && aggregateCustomerAwaitingReply(item)) {
    return Math.max(1, raw);
  }
  if (raw <= 0) return 0;
  if (String(item?.lastDirection || '') === 'me') return 0;
  const key = aggregateConversationKey(item);
  const viewed = aggregateViewedState.versions?.[key];
  if (!viewed) return raw;
  return viewed.version === aggregateConversationMessageVersion(item) ? 0 : raw;
}

let aggregateRoundRobinState = (() => {
  const fallback = { enabled: true, initialized: false, queue: [], observed: {}, handledAt: {} };
  try {
    const raw = JSON.parse(localStorage.getItem(AGGREGATE_ROUND_ROBIN_STORAGE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return fallback;
    return {
      enabled: raw.enabled !== false,
      initialized: raw.initialized === true,
      queue: Array.isArray(raw.queue) ? raw.queue.map(String).filter(Boolean) : [],
      observed: raw.observed && typeof raw.observed === 'object' ? raw.observed : {},
      handledAt: raw.handledAt && typeof raw.handledAt === 'object' ? raw.handledAt : {}
    };
  } catch {
    return fallback;
  }
})();

function saveAggregateRoundRobinState() {
  try {
    const compact = {
      enabled: aggregateRoundRobinState.enabled !== false,
      initialized: aggregateRoundRobinState.initialized === true,
      queue: aggregateRoundRobinState.queue.slice(0, 3000),
      observed: aggregateRoundRobinState.observed,
      handledAt: aggregateRoundRobinState.handledAt
    };
    localStorage.setItem(AGGREGATE_ROUND_ROBIN_STORAGE_KEY, JSON.stringify(compact));
  } catch {}
}

function syncAggregateRoundRobin(source) {
  const conversations = Array.isArray(source) ? source : [];
  const previousQueue = Array.isArray(aggregateRoundRobinState.queue) ? aggregateRoundRobinState.queue : [];
  const nextRows = conversations
    .filter(item => item && !isAggregateConversationHidden(item) && aggregateCustomerAwaitingReply(item))
    .map(item => ({
      key: aggregateConversationKey(item),
      incomingAt: aggregateCustomerIncomingAt(item),
      timestamp: Math.max(0, Number(item?.timestamp || 0) || 0)
    }))
    .filter(row => row.key)
    .sort((a, b) => a.incomingAt - b.incomingAt || a.timestamp - b.timestamp || a.key.localeCompare(b.key));
  const nextQueue = nextRows.map(row => row.key);
  const changed =
    aggregateRoundRobinState.initialized !== true ||
    nextQueue.length !== previousQueue.length ||
    nextQueue.some((key, index) => key !== previousQueue[index]);

  aggregateRoundRobinState.initialized = true;
  aggregateRoundRobinState.queue = nextQueue;

  // Keep compact timestamps for upgrade/debug visibility, but queue membership
  // no longer depends on click/view state or the old append-once algorithm.
  const nextObserved = {};
  const nextHandledAt = {};
  for (const item of conversations) {
    const key = aggregateConversationKey(item);
    if (!key) continue;
    const incomingAt = aggregateCustomerIncomingAt(item);
    const outgoingAt = aggregateCustomerOutgoingAt(item);
    const manualReadAt = aggregateManualReadAt(item);
    if (incomingAt > 0) nextObserved[key] = incomingAt;
    if (Math.max(outgoingAt, manualReadAt) > 0) nextHandledAt[key] = Math.max(outgoingAt, manualReadAt);
  }
  aggregateRoundRobinState.observed = nextObserved;
  aggregateRoundRobinState.handledAt = nextHandledAt;

  if (changed) saveAggregateRoundRobinState();
  return aggregateRoundRobinState.queue;
}

function aggregateRoundRobinRank(item) {
  if (aggregateRoundRobinState.enabled === false) return -1;
  return aggregateRoundRobinState.queue.indexOf(aggregateConversationKey(item));
}

function aggregateServiceStatus(item) {
  const explicit = String(item?.crmProfile?.serviceStatus || 'auto').trim();
  if (['waiting', 'active', 'done', 'paused', 'blacklist'].includes(explicit)) return explicit;
  return aggregateCustomerAwaitingReply(item) ? 'waiting' : 'active';
}

function aggregateServiceStatusLabel(status) {
  return ({ waiting: '待回复', active: '跟进中', done: '已完成', paused: '暂停', blacklist: '黑名单' })[status] || '跟进中';
}

function aggregateCustomerWaitMs(item) {
  if (aggregateServiceStatus(item) !== 'waiting') return 0;
  const timestamp = aggregateCustomerIncomingAt(item);
  return timestamp ? Math.max(0, Date.now() - timestamp) : 0;
}

function formatAggregateWait(ms) {
  const minutes = Math.max(0, Math.round(Number(ms || 0) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return hours < 24 ? `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
}

function renderAggregateOpsSummary(source = []) {
  const rows = Array.isArray(source) ? source : [];
  const waiting = rows.filter(item => aggregateServiceStatus(item) === 'waiting');
  const active = rows.filter(item => aggregateServiceStatus(item) === 'active').length;
  const done = rows.filter(item => aggregateServiceStatus(item) === 'done').length;
  const waits = waiting.map(aggregateCustomerWaitMs).filter(ms => ms > 0);
  const avg = waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0;
  if ($('#aggregateOpsWaiting')) $('#aggregateOpsWaiting').textContent = String(waiting.length);
  if ($('#aggregateOpsActive')) $('#aggregateOpsActive').textContent = String(active);
  if ($('#aggregateOpsDone')) $('#aggregateOpsDone').textContent = String(done);
  if ($('#aggregateOpsWait')) $('#aggregateOpsWait').textContent = waits.length ? formatAggregateWait(avg) : '0m';
}

function aggregateSmartNextCandidates() {
  return (aggregateInbox?.conversations || [])
    .filter(item => item && !isAggregateConversationHidden(item) && item.accountIsOpen !== false)
    .filter(item => !['done', 'paused', 'blacklist'].includes(aggregateServiceStatus(item)))
    .sort((a, b) => {
      const as = aggregateServiceStatus(a);
      const bs = aggregateServiceStatus(b);
      if ((as === 'waiting') !== (bs === 'waiting')) return as === 'waiting' ? -1 : 1;
      const ar = aggregateRoundRobinRank(a);
      const br = aggregateRoundRobinRank(b);
      if ((ar >= 0) !== (br >= 0)) return ar >= 0 ? -1 : 1;
      if (ar >= 0 && br >= 0 && ar !== br) return ar - br;
      const au = aggregateEffectiveUnreadCount(a);
      const bu = aggregateEffectiveUnreadCount(b);
      if ((au > 0) !== (bu > 0)) return au > 0 ? -1 : 1;
      if (as === 'waiting' && bs === 'waiting') return Number(a?.timestamp || 0) - Number(b?.timestamp || 0);
      return Number(b?.timestamp || 0) - Number(a?.timestamp || 0);
    });
}

function rememberAggregateRecentConversation(item) {
  const key = aggregateConversationKey(item);
  if (!key) return;
  aggregateRecentConversationKeys = [key, ...aggregateRecentConversationKeys.filter(x => x !== key)].slice(0, 10);
  try { localStorage.setItem(AGGREGATE_RECENT_STORAGE_KEY, JSON.stringify(aggregateRecentConversationKeys)); } catch {}
}

function prewarmRecentAggregateConversations(currentKey = '') {
  if (workspaceMode !== 'aggregate') return;
  const map = new Map((aggregateInbox?.conversations || []).map(item => [aggregateConversationKey(item), item]));
  let delay = 210;
  for (const key of aggregateRecentConversationKeys) {
    if (!key || key === currentKey) continue;
    const item = map.get(key);
    if (!item || item.accountIsOpen === false) continue;
    setTimeout(() => {
      if (workspaceMode === 'aggregate' && aggregateSelectedConversationKey === currentKey) {
        window.yoko.prewarmAggregateConversation?.(item.accountId, item.chatId).catch(() => null);
      }
    }, delay);
    delay += 160;
  }
}

function scheduleAggregateWorkspaceSave() {
  if (aggregateWorkspaceSaveTimer) clearTimeout(aggregateWorkspaceSaveTimer);
  aggregateWorkspaceSaveTimer = setTimeout(() => {
    aggregateWorkspaceSaveTimer = null;
    const list = $('#aggregateCustomerList');
    const payload = {
      mode: workspaceMode,
      selectedKey: aggregateSelectedConversationKey,
      filter: aggregateCustomerFilter,
      lineLifecycleFilter: aggregateLineLifecycleFilter,
      accountFilter: aggregateCustomerAccountFilter,
      search: String($('#aggregateCustomerSearch')?.value || ''),
      scrollTop: Math.max(0, Number(list?.scrollTop || 0) || 0),
      savedAt: Date.now()
    };
    aggregateWorkspaceRestoreState = payload;
    try { localStorage.setItem(AGGREGATE_WORKSPACE_STORAGE_KEY, JSON.stringify(payload)); } catch {}
  }, 120);
}

function aggregateStartupHasOnlineLine() {
  const accounts = Array.isArray(state?.config?.accounts) ? state.config.accounts : [];
  const activeId = String(state?.config?.activeAccountId || '');
  const active = accounts.find(account => String(account?.id || '') === activeId && account?.isOpen !== false);
  if (active?.live?.online === true) return true;
  return accounts.some(account => account?.isOpen !== false && account?.live?.online === true);
}

function cancelAggregateStartupRestore() {
  aggregateStartupRestorePending = false;
  aggregateStartupRestoreReadySince = 0;
  if (aggregateStartupRestoreTimer) clearTimeout(aggregateStartupRestoreTimer);
  aggregateStartupRestoreTimer = null;
}

function scheduleAggregateStartupRestoreAttempt(delay = 350) {
  if (!aggregateStartupRestorePending || aggregateStartupRestoreInFlight) return;
  if (aggregateStartupRestoreTimer) clearTimeout(aggregateStartupRestoreTimer);
  aggregateStartupRestoreTimer = setTimeout(() => {
    aggregateStartupRestoreTimer = null;
    tryAggregateStartupRestore().catch(() => {});
  }, Math.max(120, Number(delay) || 350));
}

async function finishAggregateWorkspaceRestore(saved) {
  await setWorkspaceMode('aggregate', { startupRestore: true });
  const item = (aggregateInbox?.conversations || []).find(row => aggregateConversationKey(row) === aggregateSelectedConversationKey);
  if (!item) {
    aggregateSelectedConversationKey = '';
    renderAggregateCustomerSidebar();
    setStatus(`聚合模式 · 当前显示 ${aggregateInbox?.conversations?.length || 0} 个个人客户`);
    return;
  }
  aggregateSelectedConversation = item;
  renderAggregateCustomerSidebar();
  renderAggregateReplyDock();
  loadAggregateCrmPanel(item, { quiet: true }).catch(() => {});
  requestAnimationFrame(() => {
    const list = $('#aggregateCustomerList');
    if (list) list.scrollTop = Math.max(0, Number(saved.scrollTop || 0) || 0);
    const node = [...document.querySelectorAll('#aggregateCustomerList .aggregate-customer-item')]
      .find(row => String(row.dataset.conversationKey || '') === aggregateSelectedConversationKey);
    // Give LINE a little extra time after the online signal. This click is no
    // longer allowed to race the login/bootstrap route.
    if (node && item.accountIsOpen !== false) {
      setTimeout(() => {
        if (workspaceMode === 'aggregate' && aggregateSelectedConversationKey === aggregateConversationKey(item)) node.click();
      }, 420);
    } else if (item.accountIsOpen === false) {
      setStatus('已安全恢复上次聚合工作现场；所选客户所属 LINE 当前已关闭');
    }
  });
}

async function tryAggregateStartupRestore() {
  if (!aggregateStartupRestorePending || aggregateStartupRestoreInFlight) return;
  if (!aggregateStartupHasOnlineLine()) {
    aggregateStartupRestoreReadySince = 0;
    setStatus('正在等待 LINE 完成登录初始化，完成后自动恢复聚合模式…');
    scheduleAggregateStartupRestoreAttempt(450);
    return;
  }
  const now = Date.now();
  if (!aggregateStartupRestoreReadySince) aggregateStartupRestoreReadySince = now;
  if (now - aggregateStartupRestoreReadySince < 950) {
    scheduleAggregateStartupRestoreAttempt(260);
    return;
  }

  aggregateStartupRestoreInFlight = true;
  const saved = { ...(aggregateWorkspaceRestoreState || {}) };
  aggregateStartupRestorePending = false;
  try {
    // Refresh the already-authenticated LINE snapshot first while still in safe
    // LINE mode. Aggregate focus is applied only after this completes/returns.
    await refreshAggregateInbox({ remote: true, quiet: true }).catch(() => {});
    await finishAggregateWorkspaceRestore(saved);
  } finally {
    aggregateStartupRestoreInFlight = false;
    aggregateStartupRestoreReadySince = 0;
  }
}

async function restoreAggregateWorkspaceAfterStartup() {
  const saved = aggregateWorkspaceRestoreState || {};
  if (Date.now() - Number(saved.savedAt || 0) > 14 * 24 * 60 * 60 * 1000) return;
  if (['all', 'unread', 'read'].includes(String(saved.filter || ''))) aggregateCustomerFilter = String(saved.filter);
  if (['all', ...LINE_LIFECYCLE_GROUPS.map(group=>group.id)].includes(String(saved.lineLifecycleFilter || ''))) aggregateLineLifecycleFilter = String(saved.lineLifecycleFilter || 'all');
  aggregateCustomerAccountFilter = String(saved.accountFilter || '');
  if ($('#aggregateCustomerSearch')) $('#aggregateCustomerSearch').value = String(saved.search || '');
  aggregateSelectedConversationKey = String(saved.selectedKey || '');

  // V1.15.31: never auto-enter Aggregate Mode during application startup.
  // LINE's Chrome extension can briefly report a cached/online profile before
  // its authentication bootstrap is fully stable. Automatically applying the
  // aggregate DOM/focus layer during that window can make LINE invalidate its
  // own session and show the QR login again. We therefore restore only the
  // operator's filter/search/selection memory; the application always starts
  // in normal LINE mode and Aggregate Mode is entered explicitly after LINE is
  // visibly ready.
  cancelAggregateStartupRestore();
  if (String(saved.mode || '') === 'aggregate') {
    setStatus('为保护 LINE 登录，启动固定进入 LINE模式；登录完成后可手动进入聚合模式');
  }
}

function updateAggregateRoundRobinControls() {
  const toggle = $('#aggregateRoundRobinBtn');
  const next = $('#aggregateRoundRobinNextBtn');
  const count = aggregateRoundRobinState.queue.length;
  if (toggle) {
    const enabled = aggregateRoundRobinState.enabled !== false;
    toggle.classList.toggle('active', enabled);
    toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    toggle.textContent = enabled ? `轮回 ${count}` : '轮回关';
    toggle.title = enabled
      ? '轮回回复已开启：同一客户连续来消息不会插队；回复后再次来消息会排到队尾'
      : '开启轮回回复';
  }
  if (next) {
    const smartCount = typeof aggregateSmartNextCandidates === 'function' ? aggregateSmartNextCandidates().length : count;
    next.disabled = smartCount <= 0;
    next.title = smartCount > 0 ? `智能打开下一位需要处理的客户（${smartCount} 位）` : '当前没有需要处理的客户';
  }
}

let aggregateHiddenConversationKeys = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(AGGREGATE_HIDDEN_STORAGE_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.map(String).filter(Boolean) : []);
  } catch {
    return new Set();
  }
})();

function saveAggregateHiddenConversations() {
  try {
    localStorage.setItem(AGGREGATE_HIDDEN_STORAGE_KEY, JSON.stringify([...aggregateHiddenConversationKeys]));
  } catch {}
}

function isAggregateConversationHidden(item) {
  return aggregateHiddenConversationKeys.has(aggregateConversationKey(item));
}

function closeAggregateCustomerContextMenu() {
  document.querySelectorAll('.aggregate-customer-context-menu').forEach(node => node.remove());
}

function showAggregateCustomerContextMenu(event, item, displayName, accountLabel) {
  event.preventDefault();
  event.stopPropagation();
  closeAggregateCustomerContextMenu();

  const menu = document.createElement('div');
  menu.className = 'aggregate-customer-context-menu';
  menu.setAttribute('role', 'menu');
  const pinned = isAggregateCustomerPinned(item);
  menu.innerHTML = `
    <button type="button" class="pin" role="menuitem">${pinned ? '取消置顶' : '置顶客户'}</button>
    <button type="button" class="mark-read" role="menuitem">标记已读</button>
    <button type="button" class="profile" role="menuitem">查看 LINE 个人名片</button>
    <button type="button" class="danger" role="menuitem">删除此会话</button>
    <div class="aggregate-customer-context-hint">标记已读 = 手动完成当前轮回；客户再次来消息会自动重新进入待回复。置顶始终优先。</div>
  `;
  document.body.appendChild(menu);

  const margin = 8;
  const rect = menu.getBoundingClientRect();
  const left = Math.max(margin, Math.min(event.clientX, window.innerWidth - rect.width - margin));
  const top = Math.max(margin, Math.min(event.clientY, window.innerHeight - rect.height - margin));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;


  menu.querySelector('button.pin')?.addEventListener('click', () => {
    const key = aggregateConversationKey(item);
    if (aggregatePinnedConversationKeys.has(key)) aggregatePinnedConversationKeys.delete(key);
    else aggregatePinnedConversationKeys.add(key);
    saveAggregatePinnedCustomers();
    aggregateCustomerRenderSignature = '';
    closeAggregateCustomerContextMenu();
    renderAggregateCustomerSidebar();
    setStatus(`${aggregatePinnedConversationKeys.has(key) ? '已置顶' : '已取消置顶'}：${accountLabel} · ${displayName}`);
  });

  menu.querySelector('button.mark-read')?.addEventListener('click', () => {
    const marked = markAggregateConversationManualRead(item);
    closeAggregateCustomerContextMenu();
    if (!marked) {
      setStatus(`无法标记已读：${accountLabel} · ${displayName} 当前没有可处理的客户来信`);
      return;
    }
    syncAggregateRoundRobin((aggregateInbox?.conversations || []).filter(row => !isAggregateConversationHidden(row)));
    renderAggregateCustomerSidebar();
    renderAggregateUnreadBadge();
    renderAggregateReplyDock();
    setStatus(`已标记已读：${accountLabel} · ${displayName} · 已按新的轮回顺序重新排序`);
  });

  menu.querySelector('button.profile')?.addEventListener('click', async () => {
    closeAggregateCustomerContextMenu();
    try {
      if (!item?.accountId || !item?.chatId) throw new Error('这个客户缺少 LINE 身份信息。');
      const result = await window.yoko.openLineProfileCard(item.accountId, item.chatId);
      if (result?.ok === false) throw new Error(result?.error || 'LINE 没有打开个人名片。');
      setStatus(`已打开 LINE 个人名片：${accountLabel} · ${displayName}`);
    } catch (error) {
      setStatus('打开 LINE 个人名片失败：' + (error?.message || error));
    }
  });

  menu.querySelector('button.danger')?.addEventListener('click', () => {
    const ok = window.confirm(`确定从聚合列表删除「${displayName}」吗？\n\n这只会隐藏 ${accountLabel} 中的这个客户，不会删除 LINE 里的聊天记录。`);
    if (!ok) return;
    aggregateHiddenConversationKeys.add(aggregateConversationKey(item));
    saveAggregateHiddenConversations();
    if (aggregateSelectedConversationKey === aggregateConversationKey(item)) {
      aggregateSelectedConversationKey = '';
      aggregateSelectedConversation = null;
      renderAggregateReplyDock({ clearLatest: true });
    }
    closeAggregateCustomerContextMenu();
    renderAggregateCustomerSidebar();
    setStatus(`已从聚合列表删除：${accountLabel} · ${displayName}`);
  });

  setTimeout(() => {
    const close = ev => {
      if (!menu.contains(ev.target)) closeAggregateCustomerContextMenu();
    };
    document.addEventListener('pointerdown', close, { once: true, capture: true });
  }, 0);
}

function aggregateTimeLabel(value) {
  const time = Number(value || 0);
  if (!time) return '';
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return date.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
}

function aggregateDisplayAccount(account) {
  return String(account?.accountRemark || account?.accountName || 'LINE').trim() || 'LINE';
}


function aggregateConversationKey(item) {
  return `${String(item?.accountId || '')}::${String(item?.chatId || '')}`;
}


function saveAggregatePinnedCustomers() {
  try { localStorage.setItem(AGGREGATE_PINNED_STORAGE_KEY, JSON.stringify([...aggregatePinnedConversationKeys].slice(0, 1000))); } catch {}
}

function isAggregateCustomerPinned(item) {
  return aggregatePinnedConversationKeys.has(aggregateConversationKey(item));
}

function saveAggregateOpenedAt() {
  try {
    const entries = Object.entries(aggregateOpenedAt || {});
    if (entries.length > 3500) {
      entries.sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0));
      aggregateOpenedAt = Object.fromEntries(entries.slice(0, 3000));
    }
    localStorage.setItem(AGGREGATE_OPENED_STORAGE_KEY, JSON.stringify(aggregateOpenedAt));
  } catch {}
}

function markAggregateCustomerOpened(item) {
  const key = aggregateConversationKey(item);
  if (!key) return;
  aggregateOpenedAt[key] = Date.now();
  saveAggregateOpenedAt();
}

function formatAggregateTimelineTime(value) {
  let time = Number(value || 0) || 0;
  if (time > 0 && time < 1e12) time *= 1000;
  if (!time) return '—';
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function aggregateDateGroupLabel(value) {
  let time = Number(value || 0) || 0;
  if (time > 0 && time < 1e12) time *= 1000;
  if (!time) return '';
  const now = new Date();
  const date = new Date(time);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff >= 2 && diff <= 3) return '3天内';
  return '';
}

function saveAggregateNotificationState() {
  try {
    aggregateNotificationState.items = (aggregateNotificationState.items || []).slice(0, 200);
    const observedEntries = Object.entries(aggregateNotificationState.observed || {});
    if (observedEntries.length > 4000) {
      observedEntries.sort((a, b) => Number(b[1]?.timestamp || 0) - Number(a[1]?.timestamp || 0));
      aggregateNotificationState.observed = Object.fromEntries(observedEntries.slice(0, 3500));
    }
    localStorage.setItem(AGGREGATE_NOTIFICATIONS_STORAGE_KEY, JSON.stringify(aggregateNotificationState));
  } catch {}
}

function aggregateNotificationVersion(item) {
  return `${String(item?.lastMessageId || '')}|${Number(item?.timestamp || 0) || 0}|${String(item?.lastDirection || '')}`;
}

function renderAggregateNotificationBadge() {
  const badge = $('#aggregateNotificationBadge');
  const button = $('#aggregateNotificationBtn');
  const count = (aggregateNotificationState.items || []).filter(item => !item.read).length;
  if (badge) {
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.toggle('hidden', count <= 0);
  }
  if (button) button.title = count ? `${count} 条未读客服提醒` : '消息中心';
}

function markAggregateNotificationsRead(conversationKey = '') {
  let changed = false;
  for (const row of aggregateNotificationState.items || []) {
    if (row.read) continue;
    if (!conversationKey || String(row.key || '') === String(conversationKey)) {
      row.read = true;
      changed = true;
    }
  }
  if (changed) saveAggregateNotificationState();
  renderAggregateNotificationBadge();
  renderAggregateNotificationCenter();
}

function observeAggregateNotifications(payload) {
  const rows = Array.isArray(payload?.conversations) ? payload.conversations : [];
  const byAccount = new Map();
  for (const row of rows) {
    const accountId = String(row?.accountId || '');
    if (!byAccount.has(accountId)) byAccount.set(accountId, []);
    byAccount.get(accountId).push(row);
  }
  let changed = false;
  for (const [accountId, accountRows] of byAccount) {
    const accountSeeded = aggregateNotificationState.accounts?.[accountId] === true;
    for (const row of accountRows) {
      const key = aggregateConversationKey(row);
      if (!key) continue;
      const version = aggregateNotificationVersion(row);
      const timestamp = Math.max(0, Number(row?.timestamp || 0) || 0);
      const previous = aggregateNotificationState.observed?.[key];
      const isNewVersion = !previous || previous.version !== version;
      if (accountSeeded && isNewVersion && row?.hasConversation !== false && String(row?.lastDirection || '') === 'customer' && timestamp > Number(previous?.timestamp || 0)) {
        const id = `${key}|${version}`;
        if (!(aggregateNotificationState.items || []).some(item => item.id === id)) {
          aggregateNotificationState.items.unshift({
            id,
            key,
            accountId: row.accountId,
            chatId: row.chatId,
            displayName: String(row?.crmProfile?.name || row?.displayName || '客户'),
            accountLabel: String(row?.accountRemark || row?.accountName || 'LINE'),
            preview: String(row?.preview || '[新消息]').slice(0, 300),
            timestamp,
            read: key === aggregateSelectedConversationKey
          });
        }
      }
      if (!previous || previous.version !== version || previous.timestamp !== timestamp) {
        aggregateNotificationState.observed[key] = { version, timestamp };
        changed = true;
      }
    }
    if (!accountSeeded) {
      aggregateNotificationState.accounts[accountId] = true;
      changed = true;
    }
  }
  for (const account of Array.isArray(payload?.accounts) ? payload.accounts : []) {
    const accountId = String(account?.accountId || '');
    if (accountId && aggregateNotificationState.accounts[accountId] !== true) {
      aggregateNotificationState.accounts[accountId] = true;
      changed = true;
    }
  }
  if (!aggregateNotificationState.initialized) {
    aggregateNotificationState.initialized = true;
    changed = true;
  }
  if (changed) saveAggregateNotificationState();
  renderAggregateNotificationBadge();
  renderAggregateNotificationCenter();
}

function renderAggregateNotificationCenter() {
  const list = $('#aggregateNotificationList');
  const modal = $('#aggregateNotificationModal');
  if (!list || modal?.classList.contains('hidden')) return;
  const rows = aggregateNotificationState.items || [];
  if (!rows.length) {
    list.innerHTML = '<div class="aggregate-notification-empty">暂时没有新的客户消息提醒</div>';
    return;
  }
  list.innerHTML = rows.map(row => `
    <button type="button" class="aggregate-notification-item${row.read ? '' : ' unread'}" data-notification-id="${escapeHtml(row.id)}" data-conversation-key="${escapeHtml(row.key)}">
      <span class="aggregate-notification-head"><strong>${escapeHtml(row.displayName || '客户')}</strong><small>${escapeHtml(row.accountLabel || 'LINE')} · ${escapeHtml(aggregateTimeLabel(row.timestamp))}</small></span>
      <span>${escapeHtml(row.preview || '[新消息]')}</span>
    </button>
  `).join('');
}

function renderAggregateAccountControls() {
  const select = $('#aggregateCustomerAccountFilter');
  const recent = $('#aggregateRecentCustomerSelect');
  const stats = $('#aggregateAccountStats');
  const accounts = Array.isArray(aggregateInbox?.accounts) ? aggregateInbox.accounts : [];
  if (select) {
    const valid = !aggregateCustomerAccountFilter || accounts.some(a => String(a.accountId) === aggregateCustomerAccountFilter);
    if (accounts.length && !valid) aggregateCustomerAccountFilter = '';
    select.innerHTML = '<option value="">全部账号</option>' + accounts.map(account => {
      const label = String(account.accountRemark || account.accountName || 'LINE');
      return `<option value="${escapeHtml(account.accountId)}">${escapeHtml(label)}</option>`;
    }).join('');
    select.value = aggregateCustomerAccountFilter;
  }
  if (recent) {
    const map = new Map((aggregateInbox?.conversations || []).map(item => [aggregateConversationKey(item), item]));
    const rows = aggregateRecentConversationKeys.map(key => map.get(key)).filter(Boolean);
    recent.innerHTML = '<option value="">最近10位</option>' + rows.map(item => {
      const label = String(item?.crmProfile?.name || item?.displayName || '客户');
      const account = String(item?.accountRemark || item?.accountName || 'LINE');
      return `<option value="${escapeHtml(aggregateConversationKey(item))}">${escapeHtml(label)} · ${escapeHtml(account)}</option>`;
    }).join('');
  }
  if (stats) {
    stats.innerHTML = accounts.map(account => {
      const label = String(account.accountRemark || account.accountName || 'LINE');
      const active = String(account.accountId) === aggregateCustomerAccountFilter;
      return `<button type="button" class="aggregate-account-stat${active ? ' active' : ''}" data-account-id="${escapeHtml(account.accountId)}" title="${escapeHtml(label)}：客户 ${Number(account.activeCustomerCount || 0)}，近72小时活跃 ${Number(account.recentActiveCustomerCount || 0)}，待回复 ${Number(account.waitingCount || 0)}，今日新进粉 ${Number(account.todayNewCustomerCount || 0)}，重复粉 ${Number(account.duplicateCustomerCount || 0)}">
        <span class="aggregate-account-dot ${account.online ? 'online' : 'offline'}"></span><strong>${escapeHtml(label)}</strong><small>客户 ${Number(account.activeCustomerCount || 0)} · 待回 ${Number(account.waitingCount || 0)} · 今日 ${Number(account.todayNewCustomerCount || 0)} · 重复 ${Number(account.duplicateCustomerCount || 0)}</small>
      </button>`;
    }).join('') || '<span class="aggregate-account-stats-empty">暂无账号统计</span>';
  }
}

function openAggregateConversationByKey(key) {
  const item = (aggregateInbox?.conversations || []).find(row => aggregateConversationKey(row) === String(key || ''));
  if (!item) return false;
  aggregateCustomerAccountFilter = '';
  aggregateCustomerFilter = 'all';
  const search = $('#aggregateCustomerSearch');
  if (search) search.value = '';
  aggregateCustomerRenderSignature = '';
  renderAggregateCustomerSidebar();
  requestAnimationFrame(() => {
    const node = [...document.querySelectorAll('#aggregateCustomerList .aggregate-customer-item')]
      .find(row => String(row.dataset.conversationKey || '') === aggregateConversationKey(item));
    if (node) {
      try { node.scrollIntoView({ block: 'nearest' }); } catch {}
      node.click();
    }
  });
  scheduleAggregateWorkspaceSave();
  return true;
}

function aggregateTranslationEngineLabel() {
  const engine = String(state?.config?.translation?.engine || 'none');
  return ({
    ollama: '本地 Ollama',
    groq: 'Groq',
    openrouter: 'OpenRouter',
    googleweb: 'Google 网页翻译',
    mymemory: 'MyMemory',
    deepl: 'DeepL',
    google: 'Google Cloud',
    libre: 'LibreTranslate',
    none: '未配置翻译'
  })[engine] || engine;
}

function currentAggregateConversation() {
  const source = Array.isArray(aggregateInbox?.conversations) ? aggregateInbox.conversations : [];
  const latest = source.find(item => aggregateConversationKey(item) === aggregateSelectedConversationKey);
  if (latest) aggregateSelectedConversation = latest;
  return latest || aggregateSelectedConversation || null;
}

function clearAggregateReplyDraft() {
  const source = $('#aggregateReplySource');
  const translated = $('#aggregateReplyTranslated');
  const latest = $('#aggregateLatestTranslation');
  if (source) source.value = '';
  if (translated) translated.value = '';
  if (latest) latest.classList.add('hidden');
}

function setAggregateReplyStatus(text, kind = '') {
  const node = $('#aggregateReplyStatus');
  if (!node) return;
  node.textContent = text || '';
  node.dataset.kind = kind || '';
}

function setAggregateReplyBusy(busy) {
  aggregateReplyBusy = !!busy;
  const selected = currentAggregateConversation();
  const disabled = aggregateReplyBusy || !selected || selected.accountIsOpen === false;
  for (const id of [
    'aggregateReplySourceLang',
    'aggregateReplyTargetLang',
    'aggregateTranslateLatestBtn',
    'aggregateReplyTranslateBtn',
    'aggregateReplySendOriginalBtn',
    'aggregateReplyTranslateSendBtn',
    'aggregateReplySendBtn'
  ]) {
    const el = $('#' + id);
    if (el) el.disabled = disabled;
  }
  const source = $('#aggregateReplySource');
  const translated = $('#aggregateReplyTranslated');
  if (source) source.disabled = !selected || selected.accountIsOpen === false;
  if (translated) translated.disabled = !selected || selected.accountIsOpen === false;
}

function renderAggregateReplyDock({ clearLatest = false } = {}) {
  const item = currentAggregateConversation();
  const name = $('#aggregateReplyName');
  const meta = $('#aggregateReplyMeta');
  const avatar = $('#aggregateReplyAvatar');
  const latestBox = $('#aggregateLatestTranslation');

  if (!item) {
    if (name) name.textContent = '请选择左侧客户';
    if (meta) meta.textContent = `选择客户后，可直接翻译并从对应 LINE 账号发送 · ${aggregateTranslationEngineLabel()}`;
    if (avatar) avatar.innerHTML = '<span>?</span>';
    if (clearLatest && latestBox) latestBox.classList.add('hidden');
    setAggregateReplyStatus('请选择客户');
    setAggregateReplyBusy(false);
    return;
  }

  const displayName = String(item.displayName || '未命名聊天').trim();
  const accountLabel = String(item.accountRemark || item.accountName || 'LINE').trim();
  const avatarUrl = String(item.avatarLocalUrl || item.avatarDataUrl || item.avatarUrl || '').trim();
  if (name) name.textContent = displayName;
  if (meta) meta.textContent = `${accountLabel} · ${item.hasConversation === false ? '未开始聊天，可直接发送第一条消息' : '当前聊天'} · 翻译：${aggregateTranslationEngineLabel()}`;
  if (avatar) {
    avatar.innerHTML = '';
    const fallback = document.createElement('span');
    fallback.textContent = displayName.slice(0, 1).toUpperCase() || 'L';
    avatar.appendChild(fallback);
    if (avatarUrl) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = avatarUrl;
      img.addEventListener('error', () => img.remove(), { once: true });
      avatar.appendChild(img);
    }
  }
  if (clearLatest && latestBox) latestBox.classList.add('hidden');
  setAggregateReplyStatus(item.accountIsOpen === false ? `${accountLabel} 已关闭，请先在 LINE模式启动账号` : `已选择 ${accountLabel} · ${displayName}`);
  setAggregateReplyBusy(false);
}

async function aggregateTranslateDraft({ sendAfter = false } = {}) {
  const item = currentAggregateConversation();
  if (!item) {
    setAggregateReplyStatus('请先选择左侧客户', 'error');
    return '';
  }
  if (item.accountIsOpen === false) {
    setAggregateReplyStatus('这个 LINE 账号已关闭，请先启动账号', 'error');
    return '';
  }
  const sourceText = String($('#aggregateReplySource')?.value || '').trim();
  if (!sourceText) {
    setAggregateReplyStatus('请输入需要翻译的内容', 'error');
    $('#aggregateReplySource')?.focus();
    return '';
  }
  const source = String($('#aggregateReplySourceLang')?.value || 'zh');
  const target = String($('#aggregateReplyTargetLang')?.value || 'ja');
  setAggregateReplyBusy(true);
  setAggregateReplyStatus(`正在使用 ${aggregateTranslationEngineLabel()} 翻译…`);
  try {
    const result = await window.yoko.aggregateTranslate(item.accountId, item.chatId, sourceText, source, target);
    if (!result?.ok || !String(result?.translated || '').trim()) {
      throw new Error(result?.error || '没有得到翻译结果');
    }
    const translated = String(result.translated || '').trim();
    const targetBox = $('#aggregateReplyTranslated');
    if (targetBox) targetBox.value = translated;
    setAggregateReplyStatus(`翻译完成 · ${result.providerLabel || aggregateTranslationEngineLabel()}`, 'ok');
    if (sendAfter) {
      await aggregateSendMessage(translated, sourceText);
    }
    return translated;
  } catch (error) {
    setAggregateReplyStatus('翻译失败：' + (error?.message || error), 'error');
    return '';
  } finally {
    setAggregateReplyBusy(false);
  }
}

async function aggregateSendMessage(text, originalText = '') {
  const item = currentAggregateConversation();
  if (!item) {
    setAggregateReplyStatus('请先选择左侧客户', 'error');
    return false;
  }
  const outgoing = String(text || '').trim();
  if (!outgoing) {
    setAggregateReplyStatus('发送内容不能为空', 'error');
    return false;
  }
  if (item.accountIsOpen === false) {
    setAggregateReplyStatus('这个 LINE 账号已关闭，请先启动账号', 'error');
    return false;
  }

  setAggregateReplyBusy(true);
  const accountLabel = String(item.accountRemark || item.accountName || 'LINE').trim();
  const displayName = String(item.displayName || '未命名聊天').trim();
  setAggregateReplyStatus(`正在通过 ${accountLabel} 发送给 ${displayName}…`);
  try {
    const result = await window.yoko.aggregateSendMessage(
      item.accountId,
      item.chatId,
      outgoing,
      String(originalText || '').trim()
    );
    if (!result?.ok) throw new Error(result?.error || 'LINE 未确认发送');
    const sourceBox = $('#aggregateReplySource');
    const translatedBox = $('#aggregateReplyTranslated');
    if (sourceBox) sourceBox.value = '';
    if (translatedBox) translatedBox.value = '';
    if (result?.verified) {
      setAggregateReplyStatus(`发送成功 · LINE已回显 · ${accountLabel} → ${displayName}`, 'ok');
      setStatus(`聚合回复已确认发送 · ${accountLabel} · ${displayName}`);
    } else {
      setAggregateReplyStatus(`已交给 LINE · 等待回显 · ${accountLabel} → ${displayName}`);
      setStatus(`聚合回复已交给 LINE，正在等待消息回显 · ${accountLabel} · ${displayName}`);
    }
    setTimeout(() => refreshAggregateInbox({ remote: true, quiet: true }), 450);
    return true;
  } catch (error) {
    setAggregateReplyStatus('发送失败：' + (error?.message || error), 'error');
    return false;
  } finally {
    setAggregateReplyBusy(false);
  }
}

async function aggregateTranslateLatestIncoming() {
  const item = currentAggregateConversation();
  if (!item) {
    setAggregateReplyStatus('请先选择左侧客户', 'error');
    return;
  }
  setAggregateReplyBusy(true);
  setAggregateReplyStatus('正在读取并翻译最近一条客户消息…');
  try {
    const result = await window.yoko.aggregateTranslateLatest(item.accountId, item.chatId, 'zh');
    if (!result?.ok) throw new Error(result?.error || '没有找到可翻译的客户消息');
    const box = $('#aggregateLatestTranslation');
    const original = $('#aggregateLatestOriginal');
    const translated = $('#aggregateLatestTranslated');
    if (original) original.textContent = `原文：${String(result.original || '').trim()}`;
    if (translated) translated.textContent = `中文：${String(result.translated || '').trim()}`;
    if (box) box.classList.remove('hidden');
    setAggregateReplyStatus(`最近消息已翻译 · ${result.providerLabel || aggregateTranslationEngineLabel()}`, 'ok');
  } catch (error) {
    setAggregateReplyStatus('最新消息翻译失败：' + (error?.message || error), 'error');
  } finally {
    setAggregateReplyBusy(false);
  }
}

function updateAggregateCustomerSelectionVisual(key) {
  document.querySelectorAll('#aggregateCustomerList .aggregate-customer-item').forEach(node => {
    node.classList.toggle('active', String(node.dataset.conversationKey || '') === String(key || ''));
  });
}

// V1.15.20: keyboard-first aggregate navigation. Tab walks forward through the
// exact visible/sorted customer list and Ctrl+Tab walks backward. Shift+Tab is
// intentionally left to the native focus system. The actual
// open still goes through the same customer-card click path, so V1.15.15+ open
// tokens, exact-MID routing, prewarm and anti-cross-chat guards all stay intact.
function aggregateVisibleCustomerNodes() {
  return [...document.querySelectorAll('#aggregateCustomerList .aggregate-customer-item')]
    .filter(node => !node.disabled && node.offsetParent !== null);
}

function switchAggregateCustomerByOffset(direction = 1, { source = 'Tab' } = {}) {
  if (workspaceMode !== 'aggregate') return false;
  const nodes = aggregateVisibleCustomerNodes();
  if (!nodes.length) {
    setStatus('当前筛选条件下没有可切换的客户');
    return false;
  }
  if (nodes.length === 1 && String(nodes[0].dataset.conversationKey || '') === aggregateSelectedConversationKey) {
    setStatus(`${source === 'Tab' ? 'Tab切换' : source === 'Ctrl+Tab' ? 'Ctrl+Tab切换' : '客户切换'} · 当前只有 1 位可见客户`);
    return true;
  }

  const step = Number(direction || 0) < 0 ? -1 : 1;
  const currentIndex = nodes.findIndex(node =>
    String(node.dataset.conversationKey || '') === String(aggregateSelectedConversationKey || '')
  );
  const targetIndex = currentIndex >= 0
    ? (currentIndex + step + nodes.length) % nodes.length
    : (step > 0 ? 0 : nodes.length - 1);
  const target = nodes[targetIndex];
  if (!target) return false;

  const targetKey = String(target.dataset.conversationKey || '');
  const item = (aggregateInbox?.conversations || []).find(row => aggregateConversationKey(row) === targetKey);
  if (item && typeof window.yoko?.prewarmAggregateConversation === 'function') {
    // Send the read-only prewarm IPC before the open IPC. On a cross-account Tab
    // this lets main.js arm the off-screen warm standby as early as possible.
    window.yoko.prewarmAggregateConversation(item.accountId, item.chatId).catch(() => null);
  }

  // scrollIntoView does not steal focus from LINE's native composer. Keeping
  // composer focus is important because the operator can type -> Tab -> keep
  // typing without reaching for the mouse.
  try { target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
  target.click();
  return true;
}

function aggregateShellKeepsNativeTab(target) {
  if (!(target instanceof Element)) return false;
  // LINE's composer is a different WebContentsView and is handled in
  // line-preload.js. Inside Yoko itself, keep ordinary Tab navigation while the
  // operator edits CRM/search/settings fields.
  if (target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return true;
  if (target.closest('.modal, dialog, .aggregate-crm-panel')) return true;
  return false;
}

function cancelAggregateConversationPrewarm() {
  if (aggregateConversationPrewarmTimer) {
    clearTimeout(aggregateConversationPrewarmTimer);
    aggregateConversationPrewarmTimer = null;
  }
  aggregateConversationPrewarmKey = '';
}

function scheduleAggregateConversationPrewarm(item, delay = 70) {
  if (workspaceMode !== 'aggregate' || !item || item.accountIsOpen === false) return;
  const accountId = String(item.accountId || '').trim();
  const chatId = String(item.chatId || '').trim();
  if (!accountId || !chatId || typeof window.yoko?.prewarmAggregateConversation !== 'function') return;
  const key = aggregateConversationKey(item);
  if (!key || key === aggregateSelectedConversationKey) return;
  if (aggregateConversationPrewarmKey === key && aggregateConversationPrewarmTimer) return;

  if (aggregateConversationPrewarmTimer) clearTimeout(aggregateConversationPrewarmTimer);
  aggregateConversationPrewarmKey = key;
  aggregateConversationPrewarmTimer = setTimeout(() => {
    aggregateConversationPrewarmTimer = null;
    if (workspaceMode !== 'aggregate' || aggregateConversationPrewarmKey !== key) return;
    window.yoko.prewarmAggregateConversation(accountId, chatId).catch(() => null);
  }, Math.max(0, Number(delay) || 0));
}

function prewarmNextLikelyAggregateConversation(currentKey = '') {
  if (workspaceMode !== 'aggregate') return;
  const source = (aggregateInbox?.conversations || [])
    .filter(item => item && item.accountIsOpen !== false && !isAggregateConversationHidden(item));
  if (!source.length) return;

  const queueRank = item => aggregateRoundRobinRank(item);
  const candidates = source
    .filter(item => aggregateConversationKey(item) !== String(currentKey || ''))
    .sort((a, b) => {
      const ar = queueRank(a);
      const br = queueRank(b);
      if ((ar >= 0) !== (br >= 0)) return ar >= 0 ? -1 : 1;
      if (ar >= 0 && br >= 0 && ar !== br) return ar - br;
      const au = aggregateEffectiveUnreadCount(a);
      const bu = aggregateEffectiveUnreadCount(b);
      if ((au > 0) !== (bu > 0)) return bu > 0 ? 1 : -1;
      return Number(b.timestamp || 0) - Number(a.timestamp || 0);
    });
  if (candidates[0]) scheduleAggregateConversationPrewarm(candidates[0], 180);
}

function renderAggregateLineLifecycleGroups(source=[]) {
  const rows=Array.isArray(source)?source:[];
  const counts=new Map(LINE_LIFECYCLE_GROUPS.map(group=>[group.id,0]));
  for(const item of rows){const id=lineLifecycleGroupId(item);if(id&&counts.has(id))counts.set(id,(counts.get(id)||0)+1);}
  document.querySelectorAll('[data-line-lifecycle-group]').forEach(button=>{
    const id=String(button.dataset.lineLifecycleGroup||'all');
    const count=id==='all'?rows.length:(counts.get(id)||0);
    const badge=button.querySelector('span');if(badge)badge.textContent=String(count);
    const active=id===aggregateLineLifecycleFilter;
    button.classList.toggle('active',active);button.setAttribute('aria-pressed',active?'true':'false');
  });
}

function renderAggregateCustomerSidebar() {
  const listBox = $('#aggregateCustomerList');
  if (!listBox) return;
  // V1.15.19: preserve the operator's list position across background snapshot
  // refreshes. This prevents the customer column from visually jumping while
  // Tab navigation or live unread updates are happening.
  const previousScrollTop = Math.max(0, Number(listBox.scrollTop || 0));

  const query = String($('#aggregateCustomerSearch')?.value || '').trim().toLocaleLowerCase();
  const rawSource = Array.isArray(aggregateInbox?.conversations) ? aggregateInbox.conversations : [];
  if (aggregateSelectedConversationKey) {
    const refreshedSelected = rawSource.find(item => aggregateConversationKey(item) === aggregateSelectedConversationKey);
    if (refreshedSelected) aggregateSelectedConversation = refreshedSelected;
  }
  const visibleSource = rawSource.filter(item => !isAggregateConversationHidden(item));
  renderAggregateAccountControls();
  const source = visibleSource.filter(item => !aggregateCustomerAccountFilter || String(item.accountId || '') === aggregateCustomerAccountFilter);
  renderAggregateLineLifecycleGroups(source);
  syncAggregateRoundRobin(visibleSource);
  updateAggregateRoundRobinControls();
  renderAggregateOpsSummary(source);
  const hiddenCount = rawSource.length - visibleSource.length;
  const restoreHiddenBtn = $('#aggregateCustomerRestoreHiddenBtn');
  if (restoreHiddenBtn) {
    restoreHiddenBtn.classList.toggle('hidden', hiddenCount <= 0);
    restoreHiddenBtn.textContent = hiddenCount > 0 ? `已删除 ${hiddenCount}` : '已删除';
    restoreHiddenBtn.title = hiddenCount > 0 ? `恢复 ${hiddenCount} 个已从聚合列表删除的会话` : '没有已删除会话';
  }
  const allCount = source.length;
  const roundRobinEnabled = aggregateRoundRobinState.enabled !== false;
  const unreadCount = source.filter(item => roundRobinEnabled ? aggregateCustomerAwaitingReply(item) : aggregateEffectiveUnreadCount(item) > 0).length;
  const readCount = Math.max(0, allCount - unreadCount);
  const unreadMessages = source.reduce((sum, item) => sum + (roundRobinEnabled && aggregateCustomerAwaitingReply(item) ? Math.max(1, Number(item?.unreadCount || 0) || 0) : aggregateEffectiveUnreadCount(item)), 0);

  const countTargets = {
    all: $('#aggregateCustomerAllCount'),
    unread: $('#aggregateCustomerUnreadCount'),
    read: $('#aggregateCustomerReadCount')
  };
  if (countTargets.all) countTargets.all.textContent = String(allCount);
  if (countTargets.unread) countTargets.unread.textContent = String(unreadCount);
  if (countTargets.read) countTargets.read.textContent = String(readCount);

  document.querySelectorAll('.aggregate-customer-filter-btn').forEach(button => {
    const active = String(button.dataset.filter || '') === aggregateCustomerFilter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  let filtered = source.filter(item => {
    const unread = aggregateEffectiveUnreadCount(item);
    const awaitingReply = aggregateCustomerAwaitingReply(item);
    if (aggregateCustomerFilter === 'unread' && (roundRobinEnabled ? !awaitingReply : unread <= 0)) return false;
    if (aggregateCustomerFilter === 'read' && (roundRobinEnabled ? awaitingReply : unread > 0)) return false;
    if (aggregateLineLifecycleFilter !== 'all' && lineLifecycleGroupId(item) !== aggregateLineLifecycleFilter) return false;
    if (!query) return true;
    const crm = item.crmProfile || {};
    const haystack = `${item.displayName || ''}\n${crm.name || ''}\n${item.preview || ''}\n${item.searchText || ''}\n${item.accountName || ''}\n${item.accountRemark || ''}\n${item.accountId || ''}\n${item.chatId || ''}\n${crm.stage || ''}\n${crm.serviceStatus || ''}\n${crm.tags || ''}\n${crm.region || ''}\n${crm.age || ''}\n${crm.occupation || ''}\n${crm.interests || ''}\n${crm.note || ''}`.toLocaleLowerCase();
    const tokens = query.split(/\s+/).map(part => part.trim()).filter(Boolean);
    return tokens.every(token => haystack.includes(token));
  }).sort((a, b) => {
    // V1.23.11 priority rule: manual pinning ALWAYS wins. A pinned customer stays
    // at the very top whether round-robin is ON or OFF. Round-robin chronology is
    // applied only inside the pinned group and inside the normal group.
    const ap = isAggregateCustomerPinned(a);
    const bp = isAggregateCustomerPinned(b);
    if (ap !== bp) return ap ? -1 : 1;

    if (roundRobinEnabled) {
      // V1.23.10: 全部 / 未读 / 已读 use one strict chronological rail.
      // Opening a chat does not change these timestamps, while a real outgoing
      // reply does, so only sending can move the current row toward the bottom.
      const at = aggregateRoundRobinOrderAt(a);
      const bt = aggregateRoundRobinOrderAt(b);
      if (at !== bt) return at - bt;
      return aggregateConversationKey(a).localeCompare(aggregateConversationKey(b));
    }

    const au = aggregateEffectiveUnreadCount(a);
    const bu = aggregateEffectiveUnreadCount(b);
    if (aggregateCustomerFilter === 'all' && (bu > 0) !== (au > 0)) return bu > 0 ? 1 : -1;
    return Number(b?.timestamp || 0) - Number(a?.timestamp || 0);
  });

  // V1.23.11: opening a chat never changes ordering. Pinned customers remain
  // above the round-robin rail; only unpinned ordering follows reply chronology.


  const filteredKeys = filtered.map(item => aggregateConversationKey(item));

  // V1.23.13: never seize the operator's scroll position during background
  // snapshots/CRM saves/round-robin refreshes. Chromium can safely clamp an old
  // scrollTop after DOM replacement; explicit filter/search actions already have
  // their own user-driven navigation paths.
  listBox.classList.toggle('large-list', filtered.length > 120);

  const summary = $('#aggregateCustomerSummary');
  if (summary) summary.textContent = `共 ${allCount} 位 · 未读 ${unreadCount} 位/${unreadMessages} 条`;

  const renderSignature = [
    aggregateCustomerFilter,
    aggregateLineLifecycleFilter,
    aggregateCustomerAccountFilter,
    query,
    aggregateSelectedConversationKey,
    hiddenCount,
    aggregateRoundRobinState.enabled !== false ? 'rr-on' : 'rr-off',
    aggregateRoundRobinState.queue.join(','),
    filtered.map(item => {
      const crm = item.crmProfile || {};
      const avatar = String(item.avatarLocalUrl || item.avatarDataUrl || item.avatarUrl || '');
      return [
        aggregateConversationKey(item), aggregateEffectiveUnreadCount(item), item.timestamp || 0,
        item.preview || '', String(item.searchText || '').length, String(item.searchText || '').slice(-32),
        crm.name || '', crm.stage || '', crm.serviceStatus || '', crm.tags || '', isAggregateCustomerPinned(item) ? 'pin' : '',
        `day:${lineLifecycleEffectiveDay(item)}`, item.duplicate ? `dup:${Number(item.duplicateCount || 0)}` : '', avatar.length, avatar.slice(-24)
      ].join('~');
    }).join('|')
  ].join('::');
  if (renderSignature === aggregateCustomerRenderSignature) {
    updateAggregateCustomerSelectionVisual(aggregateSelectedConversationKey);
    return;
  }
  aggregateCustomerRenderSignature = renderSignature;

  listBox.innerHTML = '';
  if (!filtered.length) {
    let message = source.length ? '没有符合当前筛选条件的客户' : '正在读取所有 LINE 账号的会话列表…';
    if (source.length && aggregateCustomerFilter === 'unread') message = '当前没有未读客户';
    if (source.length && aggregateCustomerFilter === 'read') message = '当前没有已读客户';
    if (source.length && aggregateLineLifecycleFilter !== 'all') message = `${lineLifecycleGroupLabel(aggregateLineLifecycleFilter)} 分组当前没有客户`;
    listBox.innerHTML = `<div class="aggregate-customer-empty">${message}</div>`;
    aggregateLastRenderedCustomerKeys = [];
    listBox.scrollTop = 0;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of filtered) {
    const key = aggregateConversationKey(item);
    const node = document.createElement('button');
    node.type = 'button';
    node.className = `aggregate-customer-item${key === aggregateSelectedConversationKey ? ' active' : ''}${isAggregateCustomerPinned(item) ? ' pinned' : ''}${item.duplicate ? ' duplicate' : ''}${item.accountIsOpen === false ? ' closed-account' : ''}`;
    node.dataset.accountId = item.accountId;
    node.dataset.chatId = item.chatId;
    node.dataset.conversationKey = key;

    const lineDisplayName = String(item.displayName || '未命名聊天').trim();
    const crm = item.crmProfile || null;
    const displayName = String(crm?.name || lineDisplayName || '未命名聊天').trim();
    const accountLabel = String(item.accountRemark || item.accountName || 'LINE').trim();
    const avatarChar = displayName.slice(0, 1).toUpperCase() || 'L';
    const avatarUrl = String(item.avatarLocalUrl || item.avatarDataUrl || item.avatarUrl || '').trim();
    const unread = aggregateEffectiveUnreadCount(item);
    const crmTags = aggregateCrmTags(crm);
    const roundRobinRank = aggregateRoundRobinRank(item);
    const serviceStatus = aggregateServiceStatus(item);

    node.innerHTML = `
      <span class="aggregate-customer-avatar">
        <span>${escapeHtml(avatarChar)}</span>
        ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="" decoding="async" loading="lazy" />` : ''}
      </span>
      <span class="aggregate-customer-body">
        <span class="aggregate-customer-row primary">
          <span class="aggregate-customer-name-line">
            ${isAggregateCustomerPinned(item) ? '<span class="aggregate-customer-pin" title="已置顶">★</span>' : ''}
            <strong class="aggregate-customer-name">${escapeHtml(displayName)}</strong>
            ${item.duplicate ? `<span class="aggregate-customer-duplicate-badge" title="同时出现在 ${escapeHtml((item.duplicateAccounts || []).join(' / ') || `${Number(item.duplicateCount || 2)} 个账号`)}">重复粉</span>` : ''}
            <span class="aggregate-customer-service-status ${escapeHtml(serviceStatus)}">${escapeHtml(aggregateServiceStatusLabel(serviceStatus))}</span>
            ${crm ? crmTags.map(tag => `<span class="aggregate-customer-tag">${escapeHtml(tag)}</span>`).join('') : ''}
          </span>
          <span class="aggregate-customer-time">${escapeHtml(aggregateTimeLabel(item.timestamp))}</span>
        </span>
        <span class="aggregate-customer-row secondary">
          <span class="aggregate-customer-account">${escapeHtml(accountLabel)}</span>
          ${lineLifecycleGroupId(item)?lineLifecycleDayBadgeHtml(item):''}
          ${aggregateDateGroupLabel(item.timestamp) ? `<span class="aggregate-customer-date-group">${escapeHtml(aggregateDateGroupLabel(item.timestamp))}</span>` : ''}
          ${roundRobinRank >= 0 ? `<span class="aggregate-customer-round-robin">待回 ${roundRobinRank + 1}</span>` : ''}
          ${unread > 0
            ? `<span class="aggregate-customer-unread">${escapeHtml(unread > 99 ? '99+' : String(unread))}</span>`
            : item.hasConversation === false
              ? '<span class="aggregate-customer-read">未聊天</span>'
              : '<span class="aggregate-customer-read">已读</span>'}
        </span>
        <span class="aggregate-customer-preview ${item.lastDirection === 'me' ? 'me' : ''}">${escapeHtml(item.preview || (item.hasConversation === false ? '[未开始聊天，可直接发消息]' : '[暂无预览]'))}</span>
      </span>
    `;

    const img = node.querySelector('.aggregate-customer-avatar img');
    if (img) img.addEventListener('error', () => img.remove(), { once: true });

    // V1.15.18: begin a read-only warm-up as soon as the operator hovers or
    // keyboard-focuses a customer. It never changes the visible conversation.
    node.addEventListener('pointerenter', () => scheduleAggregateConversationPrewarm(item, 65));
    node.addEventListener('focus', () => scheduleAggregateConversationPrewarm(item, 45));

    node.addEventListener('click', async () => {
      // V1.15.11: make aggregate selection feel like a normal chat list.
      // The card, CRM panel and unread state follow the mouse click immediately;
      // LINE navigation then runs in the background. We only roll back when LINE
      // explicitly reports that it could not accept/open the target conversation.
      // A monotonic token still prevents a slow earlier click from overwriting a
      // newer selection when the operator clicks several customers quickly.
      const openToken = ++aggregateConversationOpenToken;
      const previousKey = aggregateSelectedConversationKey;
      const previousConversation = aggregateSelectedConversation;
      const customerChanged = previousKey !== key;

      aggregateSelectedConversationKey = key;
      aggregateSelectedConversation = item;
      rememberAggregateRecentConversation(item);
      markAggregateCustomerOpened(item);
      markAggregateNotificationsRead(key);
      scheduleAggregateWorkspaceSave();
      if (customerChanged) clearAggregateReplyDraft();
      updateAggregateCustomerSelectionVisual(key);
      renderAggregateReplyDock({ clearLatest: true });
      loadAggregateCrmPanel(item, { quiet: true }).catch(() => {});
      markAggregateConversationViewed(item, { quiet: true });
      setStatus(`正在打开 ${accountLabel} · ${displayName}…`);

      try {
        const result = await window.yoko.openAggregateConversation(item.accountId, item.chatId);
        if (openToken !== aggregateConversationOpenToken || workspaceMode !== 'aggregate') return;
        if (result?.canceled) return;
        if (result?.closed || !result?.ok) {
          // Closed/hard-rejected targets are genuine failures, so restore the
          // previous customer. A guarded slow switch is returned as ok+pending
          // and deliberately stays selected until LINE finishes painting it.
          aggregateSelectedConversationKey = previousKey;
          aggregateSelectedConversation = previousConversation;
          updateAggregateCustomerSelectionVisual(previousKey);
          if (previousConversation) loadAggregateCrmPanel(previousConversation, { quiet: true }).catch(() => {});
          else clearAggregateCrmPanel();
          setStatus(result?.closed
            ? `${accountLabel} 已关闭；请回到 LINE模式后点 ▶ 启动该账号`
            : (result?.error || `未能打开 ${displayName}，请再点一次`));
          return;
        }

        try { await window.yoko.setLineViewVisible(true); } catch {}
        autoShowChatgptForSelectedCustomer(result?.pending ? 260 : 40).catch(() => null);
        if (!result?.pending) {
          setTimeout(() => window.yoko.focusAggregateComposer?.(item.accountId).catch(() => null), 35);
        }
        // Account cards can refresh after the chat is already visible; do not
        // put get-state on the critical customer-switch path.
        refreshState().catch(() => {});
        if (openToken !== aggregateConversationOpenToken || workspaceMode !== 'aggregate') return;
        const latest = (aggregateInbox?.conversations || []).find(row => aggregateConversationKey(row) === key);
        if (latest) aggregateSelectedConversation = latest;
        renderAggregateCustomerSidebar();
        renderAggregateUnreadBadge();
        renderAggregateReplyDock();
        setStatus(`聚合模式 · ${accountLabel} · ${displayName}${result?.prewarmedAccount ? ' · 预热命中' : ''}${result?.pending ? ' · 后台完成加载中' : (result?.verified === false ? ' · LINE正在同步' : '')}${item.hasConversation === false ? ' · 可直接发送第一条消息' : ''}`);
        prewarmNextLikelyAggregateConversation(key);
        prewarmRecentAggregateConversations(key);
        setTimeout(() => refreshAggregateInbox({ remote: true, quiet: true }), 700);
      } catch (error) {
        if (openToken !== aggregateConversationOpenToken) return;
        aggregateSelectedConversationKey = previousKey;
        aggregateSelectedConversation = previousConversation;
        updateAggregateCustomerSelectionVisual(previousKey);
        if (previousConversation) loadAggregateCrmPanel(previousConversation, { quiet: true }).catch(() => {});
        else clearAggregateCrmPanel();
        setStatus('打开聚合客户失败：' + (error?.message || error));
      }
    });

    node.addEventListener('contextmenu', event => {
      showAggregateCustomerContextMenu(event, item, displayName, accountLabel);
    });

    fragment.appendChild(node);
  }
  listBox.appendChild(fragment);
  aggregateLastRenderedCustomerKeys = filteredKeys;

  const settleCustomerListScroll = () => {
    if (!listBox?.isConnected) return;
    const maxScrollTop = Math.max(0, listBox.scrollHeight - listBox.clientHeight);
    listBox.scrollTop = Math.min(previousScrollTop, maxScrollTop);
  };
  // Chromium may update scrollHeight a frame after DOM replacement. Restore the
  // exact operator position twice, clamped only when the list genuinely shrank.
  settleCustomerListScroll();
  requestAnimationFrame(() => {
    settleCustomerListScroll();
    requestAnimationFrame(settleCustomerListScroll);
  });
}

function renderAggregateUnreadBadge() {
  const badge = $('#aggregateUnreadBadge');
  if (!badge) return;
  const source = Array.isArray(aggregateInbox?.conversations) ? aggregateInbox.conversations : [];
  const unread = source
    .filter(item => !isAggregateConversationHidden(item))
    .reduce((sum, item) => sum + aggregateEffectiveUnreadCount(item), 0);
  badge.textContent = unread > 99 ? '99+' : String(unread);
  badge.classList.toggle('hidden', unread <= 0);
}

function renderAggregateInbox() {
  renderAggregateCustomerSidebar();
  renderAggregateUnreadBadge();

  // The legacy full-page aggregate inbox has been hidden since V1.12.1. Do
  // not keep rebuilding its duplicate account chips/conversation cards in the
  // background; on large customer sets that was pure CPU/DOM work with no
  // visible result.
  if ($('#aggregateView')?.classList.contains('hidden')) return;

  const listBox = $('#aggregateList');
  if (!listBox) return;
  const accountSelect = $('#aggregateAccountFilter');
  const previousAccount = String(accountSelect?.value || '');
  if (accountSelect) {
    accountSelect.innerHTML = '<option value="">全部账号</option>';
    for (const account of aggregateInbox.accounts || []) {
      const option = document.createElement('option');
      option.value = account.accountId;
      option.textContent = `${aggregateDisplayAccount(account)}${account.isOpen ? '' : '（已关闭）'}`;
      accountSelect.appendChild(option);
    }
    if ([...accountSelect.options].some(option => option.value === previousAccount)) {
      accountSelect.value = previousAccount;
    }
  }

  const accountStrip = $('#aggregateAccountStrip');
  if (accountStrip) {
    accountStrip.innerHTML = '';
    for (const account of aggregateInbox.accounts || []) {
      const chip = document.createElement('div');
      chip.className = `aggregate-account-chip${account.online ? ' online' : ''}${account.isOpen ? '' : ' closed'}`;
      chip.title = `${account.accountName || 'LINE'}${account.isOpen ? '' : ' · 已关闭'}`;
      chip.innerHTML = `
        <span class="dot"></span>
        <strong>${escapeHtml(aggregateDisplayAccount(account))}</strong>
        ${Number(account.unreadCount || 0) > 0 ? `<span class="count">${escapeHtml(Number(account.unreadCount) > 99 ? '99+' : String(account.unreadCount))}</span>` : ''}
      `;
      chip.addEventListener('click', () => {
        if (accountSelect) accountSelect.value = account.accountId;
        renderAggregateInbox();
      });
      accountStrip.appendChild(chip);
    }
  }

  const query = String($('#aggregateSearch')?.value || '').trim().toLocaleLowerCase();
  const accountFilter = String(accountSelect?.value || '');
  const source = Array.isArray(aggregateInbox.conversations) ? aggregateInbox.conversations : [];
  const filtered = source.filter(item => {
    if (accountFilter && item.accountId !== accountFilter) return false;
    if (aggregateUnreadOnly && aggregateEffectiveUnreadCount(item) <= 0) return false;
    if (!query) return true;
    const haystack = `${item.displayName || ''}\n${item.preview || ''}\n${item.accountName || ''}\n${item.accountRemark || ''}`.toLocaleLowerCase();
    return haystack.includes(query);
  });

  const summary = $('#aggregateSummary');
  if (summary) {
    const unread = filtered.reduce((sum, item) => sum + aggregateEffectiveUnreadCount(item), 0);
    summary.textContent = `${filtered.length} 个会话 · ${unread} 条未读`;
  }

  listBox.innerHTML = '';
  if (!filtered.length) {
    listBox.innerHTML = `<div class="aggregate-empty">${source.length ? '没有符合当前筛选条件的会话' : '暂时没有聚合会话。打开 LINE 后会自动读取最近聊天。'}</div>`;
    return;
  }

  for (const item of filtered) {
    const key = aggregateConversationKey(item);
    const node = document.createElement('article');
    node.className = `aggregate-item${item.accountIsOpen === false ? ' closed-account' : ''}`;
    node.dataset.accountId = item.accountId;
    node.dataset.chatId = item.chatId;
    node.dataset.conversationKey = key;
    const displayName = String(item.displayName || '未命名聊天').trim();
    const avatarChar = displayName.slice(0, 1).toUpperCase() || 'L';
    const avatarUrl = String(item.avatarLocalUrl || item.avatarDataUrl || item.avatarUrl || '').trim();
    const unread = aggregateEffectiveUnreadCount(item);
    const accountLabel = String(item.accountRemark || item.accountName || 'LINE').trim();
    node.innerHTML = `
      <div class="aggregate-contact-avatar">
        <span>${escapeHtml(avatarChar)}</span>
        ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="" decoding="async" loading="lazy" />` : ''}
      </div>
      <div class="aggregate-item-main">
        <div class="aggregate-item-title-row">
          <span class="aggregate-contact-name">${escapeHtml(displayName)}</span>
          <span class="aggregate-account-label">${escapeHtml(accountLabel)}</span>
        </div>
        <div class="aggregate-preview ${item.lastDirection === 'me' ? 'me' : ''}">${escapeHtml(item.preview || '[暂无预览]')}</div>
      </div>
      <div class="aggregate-item-meta">
        <span class="aggregate-time">${escapeHtml(aggregateTimeLabel(item.timestamp))}</span>
        ${unread > 0 ? `<span class="aggregate-unread">${escapeHtml(unread > 99 ? '99+' : String(unread))}</span>` : item.accountIsOpen === false ? '<span class="aggregate-closed-label">账号已关闭</span>' : ''}
      </div>
    `;

    const img = node.querySelector('.aggregate-contact-avatar img');
    if (img) {
      img.addEventListener('error', () => img.remove(), { once: true });
    }

    node.addEventListener('pointerenter', () => scheduleAggregateConversationPrewarm(item, 65));
    node.addEventListener('focus', () => scheduleAggregateConversationPrewarm(item, 45));

    node.addEventListener('click', async () => {
      const openToken = ++aggregateConversationOpenToken;
      const previousKey = aggregateSelectedConversationKey;
      const previousConversation = aggregateSelectedConversation;
      const nextKey = aggregateConversationKey(item);
      aggregateSelectedConversationKey = nextKey;
      aggregateSelectedConversation = item;
      updateAggregateCustomerSelectionVisual(nextKey);
      loadAggregateCrmPanel(item, { quiet: true }).catch(() => {});
      markAggregateConversationViewed(item, { quiet: true });
      try {
        setStatus(`正在打开 ${accountLabel} · ${displayName}…`);
        const result = await window.yoko.openAggregateConversation(item.accountId, item.chatId);
        if (openToken !== aggregateConversationOpenToken || workspaceMode !== 'aggregate') return;
        if (result?.canceled) return;
        if (result?.closed || !result?.ok) {
          aggregateSelectedConversationKey = previousKey;
          aggregateSelectedConversation = previousConversation;
          updateAggregateCustomerSelectionVisual(previousKey);
          if (previousConversation) loadAggregateCrmPanel(previousConversation, { quiet: true }).catch(() => {});
          setStatus(result?.closed
            ? `${accountLabel} 已关闭；请先点左侧 ▶ 启动，再打开该会话`
            : (result?.error || `未能打开 ${displayName}，请再点一次`));
          return;
        }
        try { await window.yoko.setLineViewVisible(true); } catch {}
        autoShowChatgptForSelectedCustomer(result?.pending ? 260 : 40).catch(() => null);
        refreshState().catch(() => {});
        if (openToken !== aggregateConversationOpenToken || workspaceMode !== 'aggregate') return;
        renderAggregateCustomerSidebar();
        setStatus(`聚合模式 · ${accountLabel} · ${displayName}${result?.prewarmedAccount ? ' · 预热命中' : ''}${result?.pending ? ' · 后台完成加载中' : (result?.verified === false ? ' · LINE正在同步' : '')}`);
        prewarmNextLikelyAggregateConversation(nextKey);
      } catch (error) {
        if (openToken !== aggregateConversationOpenToken) return;
        aggregateSelectedConversationKey = previousKey;
        aggregateSelectedConversation = previousConversation;
        updateAggregateCustomerSelectionVisual(previousKey);
        if (previousConversation) loadAggregateCrmPanel(previousConversation, { quiet: true }).catch(() => {});
        setStatus('打开聚合会话失败：' + (error?.message || error));
      }
    });
    listBox.appendChild(node);
  }
}

async function refreshAggregateInbox({ remote = true, quiet = false } = {}) {
  try {
    if (!quiet) setStatus('正在刷新聚合消息…');
    aggregateInbox = remote
      ? await window.yoko.refreshAggregateInbox()
      : await window.yoko.getAggregateInbox();
    aggregateInbox = aggregateInbox || { accounts: [], conversations: [], unreadCount: 0 };
    renderAggregateInbox();
    renderLineCustomerStats();
    if (!quiet) setStatus(`聚合消息已刷新：${aggregateInbox.conversations?.length || 0} 个会话`);
  } catch (error) {
    if (!quiet) setStatus('聚合消息刷新失败：' + (error?.message || error));
  }
}

async function setWorkspaceMode(mode, options = {}) {
  // While an open LINE renderer is still authenticating/bootstrap-loading, a
  // manual Aggregate click is deferred by the same startup gate. This prevents
  // reproducing the logout race simply by clicking Aggregate very early.
  if (mode === 'aggregate' && !options?.startupRestore) {
    // V1.23.11: refresh runtime state once before applying the login-safety gate.
    // A stale renderer snapshot could say live.online=false even though LINE is
    // already usable, making the Aggregate button look completely broken.
    if (!aggregateStartupHasOnlineLine()) {
      await refreshState().catch(() => {});
    }
    const accounts = Array.isArray(state?.config?.accounts) ? state.config.accounts : [];
    const hasOpenLine = accounts.some(account => account?.isOpen !== false);
    if (hasOpenLine && !aggregateStartupHasOnlineLine()) {
      aggregateStartupRestorePending = true;
      aggregateWorkspaceRestoreState = {
        ...(aggregateWorkspaceRestoreState || {}),
        mode: 'aggregate',
        savedAt: Date.now()
      };
      setStatus('LINE 正在登录初始化 · 聚合模式将在账号在线后自动打开');
      scheduleAggregateStartupRestoreAttempt(250);
      return;
    }
  }
  if (!options?.startupRestore && aggregateStartupRestorePending) cancelAggregateStartupRestore();
  // V1.15.15: mode changes cancel any customer-open continuation still awaiting
  // IPC. A second mode click also supersedes the first async mode transition.
  const modeSwitchToken = ++workspaceModeSwitchToken;
  ++aggregateConversationOpenToken;
  cancelAggregateConversationPrewarm();
  workspaceMode = mode === 'aggregate' ? 'aggregate' : 'line';
  document.body.classList.toggle('aggregate-mode', workspaceMode === 'aggregate');
  $('#lineModeBtn')?.classList.toggle('active', workspaceMode === 'line');
  $('#aggregateModeBtn')?.classList.toggle('active', workspaceMode === 'aggregate');
  // V1.12.1: Aggregate Mode no longer covers the right side with a separate
  // inbox page. The left sidebar becomes unread customers while the native
  // LINE conversation view remains visible on the right.
  $('#aggregateView')?.classList.add('hidden');

  // Tell the main process the new mode first so it can cancel any LINE-side
  // aggregate switch overlay before layout metrics make the view visible.
  try { await window.yoko.setWorkspaceMode?.(workspaceMode); } catch {}
  if (modeSwitchToken !== workspaceModeSwitchToken) return;
  await syncWorkspaceLayoutMetrics();
  if (modeSwitchToken !== workspaceModeSwitchToken) return;
  try { await window.yoko.setLineViewVisible(true); } catch {}
  if (modeSwitchToken !== workspaceModeSwitchToken) return;

  if (workspaceMode === 'aggregate') {
    stopLineCrmSync();
    if (aggregateRefreshTimer) clearInterval(aggregateRefreshTimer);

    // V1.12.5: show the last local customer snapshot immediately. Do not blank
    // the whole left rail while every LINE account is being refreshed.
    await refreshAggregateInbox({ remote: false, quiet: true });
    renderAggregateCustomerSidebar();
    renderAggregateReplyDock();
    loadAggregateCrmPanel(currentAggregateConversation(), { quiet: true }).catch(() => clearAggregateCrmPanel());
    prewarmNextLikelyAggregateConversation(aggregateSelectedConversationKey);
    setStatus(`聚合模式 · 当前显示 ${aggregateInbox.conversations?.length || 0} 个客户，正在后台刷新全部 LINE…`);

    // Refresh open LINE sessions in the background. aggregate-updated events
    // stream the results into the sidebar as each account finishes.
    refreshAggregateInbox({ remote: true, quiet: true }).then(() => {
      if (workspaceMode !== 'aggregate') return;
      renderAggregateCustomerSidebar();
      prewarmNextLikelyAggregateConversation(aggregateSelectedConversationKey);
      setStatus(`聚合模式 · 已读取 ${aggregateInbox.conversations?.length || 0} 个客户会话 · 收发消息在 LINE 气泡内自动显示中文翻译`);
    }).catch(() => {});

    aggregateRefreshTimer = setInterval(() => {
      if (document.hidden) return;
      if (workspaceMode === 'aggregate') refreshAggregateInbox({ remote: false, quiet: true });
    }, 8000);
  } else {
    if (aggregateCrmPanelSaveTimer) {
      clearTimeout(aggregateCrmPanelSaveTimer);
      aggregateCrmPanelSaveTimer = null;
    }
    if (aggregateCrmPanelDirty) saveAggregateCrmPanel({ quiet: true }).catch(() => {});
    if (aggregateRefreshTimer) {
      clearInterval(aggregateRefreshTimer);
      aggregateRefreshTimer = null;
    }
    lineCrmLastConversationKey = '';
    lineCrmMissCount = 0;
    startLineCrmSync({ force: true });
    setStatus('LINE模式 · 右侧客户资料会随当前聊天自动同步');
  }
  renderLineCustomerStats();
  scheduleAggregateWorkspaceSave();
}


// V1.20.1 persistent multi-app shell. App Center is the startup surface;
// LINE and every installed platform live behind their own left-rail icon.
let appCenterOpen = true;
let appCenterStartupTimer = null; // retained for backward compatibility; unused in V1.20.1
let appCenterPane = 'apps';
let appCenterState = { platforms: [], accounts: [], installedPlatforms: [], activeAccountId: '', shellSurface: 'app-center' };
let operationsDashboardState = null;
let operationsDashboardRefreshTimer = null;
let appAccountManagingPlatform = '';
let shellSurface = 'app-center';
let appRailAddMenuOpen = false;
let appRailRemoveMenuOpen = false;
let activeExternalPlatform = '';
let activeExternalAccountId = '';
let appProxyEditingAccountId = '';

// V1.23.9: independent all-platform aggregate desk. It deliberately excludes
// LINE and only merges the six external application adapters. Selecting a
// customer still opens that customer's real native platform WebContentsView,
// preserving the account's own Profile/Session/proxy while the surrounding
// customer list remains global.
// V1.27.41: Meta Business is native-only. It no longer participates in the
// all-platform aggregate desk; all MB translation/CRM work happens inside the
// real Meta Business inbox/chat WebContentsView.
const EXTERNAL_GLOBAL_AGGREGATE_PLATFORMS = Object.freeze(['tiktok','facebook','instagram','whatsapp','telegram']);
const EXTERNAL_GLOBAL_PLATFORM = Object.freeze({
  id:'global-aggregate', name:'全平台聚合', short:'聚合', description:'TikTok / Facebook / Instagram / WhatsApp / Telegram 统一客户工作台'
});
let externalGlobalAggregateActive = false;
let externalGlobalPlatformInboxes = new Map();
let externalAggregatePlatformFilter = '';


// V1.21.0: every external platform will own an independent aggregate customer
// workspace. TikTok is the first adapter. Its state/storage is intentionally
// separate from LINE aggregate mode and from future FB/IG/WA/TG/MB adapters.
const EXTERNAL_WORKSPACE_MODE_STORAGE_KEY = 'yoko.externalWorkspaceModes.v1';
let externalWorkspaceModes = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(EXTERNAL_WORKSPACE_MODE_STORAGE_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
})();
let externalAggregateInbox = { platform:'', accounts:[], conversations:[], unreadCount:0 };
// V1.27.36: remember the actual MB native visual order last rendered. When
// Meta moves a newly-active conversation to the native top, the software rail
// must visibly follow instead of preserving an old scroll anchor.
let externalMetaNormalMirrorSignature = '';
let externalAggregateAccountFilter = '';
let externalAggregateSearch = '';
// V1.23.67 smart waiting-reply center. This is a view/filter only: it never
// marks a customer read and never changes CRM status merely by opening it.
let externalWaitingCenterActive = false;
// V1.27.5: external aggregate desks now expose the same practical queue controls
// as LINE: waiting customers are a visible FIFO/round-robin queue and operators
// can jump to the next unanswered customer without leaving the aggregate desk.
const EXTERNAL_ROUND_ROBIN_STORAGE_KEY = 'yoko.externalRoundRobin.v1';
let externalRoundRobinEnabledState = (() => {
  try { return localStorage.getItem(EXTERNAL_ROUND_ROBIN_STORAGE_KEY) !== '0'; } catch { return true; }
})();
let externalAggregateSelectedKey = '';
let externalAggregateSelected = null;
// V1.27.14 persisted Meta positions remain as a deterministic tie-breaker.
// V1.27.24 no longer uses them as the primary normal-list order: the visible
// rail follows LINE reply chronology, while this map only resolves equal-time
// rows without reintroducing Meta virtual-list jitter.
const externalMetaBusinessFixedOrder = new Map();
let externalMetaBusinessFixedOrderSequence = 0;
// V1.27.13: discard late async open completions when the operator clicks a
// different aggregate customer before Meta finishes switching the native chat.
let externalAggregateOpenSequence = 0;
let externalAggregateRefreshTimer = null;
let externalAggregateCrmContext = null;
let externalAggregateCrmHydrating = false;
// V1.27.21: monotonic CRM hydration token; stale reads may never overwrite a newer explicit customer selection.
let externalAggregateCrmHydrationSequence = 0;

// V1.23.63: keep CRM auto-extract feedback even when TikTok/other native
// conversation identity hydrates a little later than the extracted payload.
let pendingExternalCrmAutoExtractToast = null;

// V1.23.11: one persistent pin set is shared by every non-LINE aggregate desk.
// The key includes platform + account + chat, so the same display name in two
// accounts can be pinned independently and global aggregate reuses the exact pin.
const EXTERNAL_AGGREGATE_PINNED_STORAGE_KEY = 'yoko.externalAggregatePinnedCustomers.v1';
let externalAggregatePinnedKeys = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(EXTERNAL_AGGREGATE_PINNED_STORAGE_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.map(String).filter(Boolean).slice(0, 5000) : []);
  } catch { return new Set(); }
})();

function saveExternalAggregatePinnedCustomers() {
  try { localStorage.setItem(EXTERNAL_AGGREGATE_PINNED_STORAGE_KEY, JSON.stringify([...externalAggregatePinnedKeys].slice(0, 5000))); } catch {}
}

function isExternalAggregateCustomerPinned(item) {
  return externalAggregatePinnedKeys.has(externalAggregateKey(item));
}

// V1.27.17: every external aggregate gets the same persistent remove/hide
// behavior as LINE. Deleting here never touches the platform's native chat.
const EXTERNAL_AGGREGATE_HIDDEN_STORAGE_KEY = 'yoko.externalAggregateHiddenCustomers.v1';
let externalAggregateHiddenKeys = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(EXTERNAL_AGGREGATE_HIDDEN_STORAGE_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.map(String).filter(Boolean).slice(0, 10000) : []);
  } catch { return new Set(); }
})();

function saveExternalAggregateHiddenCustomers() {
  try { localStorage.setItem(EXTERNAL_AGGREGATE_HIDDEN_STORAGE_KEY, JSON.stringify([...externalAggregateHiddenKeys].slice(0, 20000))); } catch {}
}

// V1.27.20: external customer deletion must survive identity hydration.
// Meta Business can replace name:* with mb-thread:* (or refresh aggregateUiKey)
// between opening the context menu and clicking Delete. A single volatile key is
// therefore not enough: persist a compact tombstone set covering every stable
// identity surface we know for the same platform/account/customer.
function normalizeExternalAggregateIdentityPart(value) {
  let text = String(value || '').trim();
  try { text = text.normalize('NFKC'); } catch {}
  return text.replace(/\s+/g, ' ').toLocaleLowerCase();
}

function externalAggregateIdentityKeys(item) {
  if (!item || typeof item !== 'object') return [];
  const platform = normalizeExternalAggregateIdentityPart(item.platform || activeExternalPlatform || '');
  const accountId = String(item.accountId || '').trim();
  if (!platform || !accountId) return [];
  const prefix = `${platform}|${accountId}|`;
  const keys = new Set();
  const canonical = externalAggregateKey(item);
  if (canonical) keys.add(String(canonical));
  const ui = normalizeExternalAggregateIdentityPart(item.aggregateUiKey);
  const chat = normalizeExternalAggregateIdentityPart(item.chatId);
  const handle = normalizeExternalAggregateIdentityPart(String(item.handle || '').replace(/^@/, ''));
  const name = normalizeExternalAggregateIdentityPart(item.displayName);
  if (ui) keys.add(`${prefix}ui:${ui}`);
  if (chat) {
    keys.add(`${prefix}chat:${chat}`);
    // Backward compatibility for V1.27.17-19 single-key tombstones created
    // when aggregateUiKey was absent and externalAggregateKey fell back to chatId.
    keys.add(`${prefix}${chat}`);
  }
  if (handle) keys.add(`${prefix}handle:${handle}`);
  if (name) {
    keys.add(`${prefix}name:${name}`);
    // V1.27.15-19 Meta rows commonly used mb-ui:name:<lower-name> as the
    // canonical aggregate key. Keep that legacy shape so users already deleted
    // on the old build disappear automatically after upgrading.
    if (platform === 'metabusiness') keys.add(`${prefix}mb-ui:name:${name}`);
  }
  return [...keys];
}

function externalAggregateRowsEquivalent(a, b) {
  if (!a || !b) return false;
  const ap = normalizeExternalAggregateIdentityPart(a.platform || activeExternalPlatform || '');
  const bp = normalizeExternalAggregateIdentityPart(b.platform || activeExternalPlatform || '');
  if (!ap || ap !== bp || String(a.accountId || '') !== String(b.accountId || '')) return false;
  const ac = normalizeExternalAggregateIdentityPart(a.chatId);
  const bc = normalizeExternalAggregateIdentityPart(b.chatId);
  if (ac && bc && ac === bc) return true;
  const au = normalizeExternalAggregateIdentityPart(a.aggregateUiKey);
  const bu = normalizeExternalAggregateIdentityPart(b.aggregateUiKey);
  if (au && bu && au === bu) return true;
  const ah = normalizeExternalAggregateIdentityPart(String(a.handle || '').replace(/^@/, ''));
  const bh = normalizeExternalAggregateIdentityPart(String(b.handle || '').replace(/^@/, ''));
  if (ah && bh && ah === bh) return true;
  const an = normalizeExternalAggregateIdentityPart(a.displayName);
  const bn = normalizeExternalAggregateIdentityPart(b.displayName);
  if (!an || an !== bn) return false;
  // Same normalized name in the same account is the final hydration fallback.
  // If both avatars are known and conflict, keep them separate.
  const aa = normalizeExternalAggregateIdentityPart(a.avatarUrl);
  const ba = normalizeExternalAggregateIdentityPart(b.avatarUrl);
  return !(aa && ba && aa !== ba);
}

function hideExternalAggregateCustomer(item) {
  const rows = [];
  if (item) rows.push(item);
  for (const row of (externalAggregateInbox?.conversations || [])) {
    if (externalAggregateRowsEquivalent(row, item)) rows.push(row);
  }
  for (const inbox of externalGlobalPlatformInboxes.values()) {
    for (const row of (inbox?.conversations || [])) {
      if (externalAggregateRowsEquivalent(row, item)) rows.push(row);
    }
  }
  let added = 0;
  for (const row of rows) {
    for (const key of externalAggregateIdentityKeys(row)) {
      if (!externalAggregateHiddenKeys.has(key)) added += 1;
      externalAggregateHiddenKeys.add(key);
    }
  }
  saveExternalAggregateHiddenCustomers();
  return added;
}

function isExternalAggregateCustomerHidden(item) {
  return externalAggregateIdentityKeys(item).some(key => externalAggregateHiddenKeys.has(key));
}

function externalAggregateSortTimestamp(item) {
  const numeric = Math.max(0, Number(item?.timestamp || item?.lastMessageTimestamp || 0) || 0);
  if (numeric) return numeric;
  const parsed = Date.parse(item?.lastMessageAt || item?.updatedAt || '') || 0;
  if (parsed) return parsed;
  // capturedAt is the scanner poll time, not a customer activity time. Using it
  // for MB made every 8-second refresh reshuffle rows that only had labels such
  // as "22:55". Keep those rows on deterministic native order instead.
  if (String(item?.platform || '') === 'metabusiness') return 0;
  return Date.parse(item?.capturedAt || '') || 0;
}

// V1.27.24: external aggregate desks now use the same strict chronological
// round-robin rail as LINE. The row's position is driven by its latest handled
// or customer-activity boundary, never by clicking/opening it. A confirmed
// reply (or explicit mark-read) stamps a fresh handled time and therefore sends
// that customer to the bottom of the rail. As the operator handles the rows
// ahead of it, the customer naturally rotates back toward the top. A later
// customer message also creates a newer turn timestamp and re-enters at the
// tail, exactly like LINE's "回复后再次来消息会排到队尾" behavior.
function externalAggregateRoundRobinOrderAt(item) {
  const messageAt = Math.max(
    0,
    Number(item?.timestamp || item?.lastMessageTimestamp || 0) || 0,
    Date.parse(item?.lastMessageAt || '') || 0
  );
  return Math.max(
    Math.max(0, Number(item?.lastReplyAt || 0) || 0),
    Math.max(0, Number(item?.manualReadAt || 0) || 0),
    Math.max(0, Number(item?.lastIncomingAt || 0) || 0),
    messageAt,
    Math.max(0, Number(item?.newCustomerAt || item?.firstMessageAt || 0) || 0)
  );
}

function renderLineCustomerStats() {
  const scope = $('#lineCustomerStatsScope');
  const today = $('#lineTodayNewCount');
  const duplicate = $('#lineDuplicateCount');
  if (!scope || !today || !duplicate) return;
  const inbox = aggregateInbox || { accounts:[], conversations:[] };
  if (workspaceMode === 'aggregate') {
    scope.textContent = '综合';
    today.textContent = String(Math.max(0, Number(inbox.todayNewCustomerCount || 0) || 0));
    duplicate.textContent = String(Math.max(0, Number(inbox.duplicateCustomerCount || 0) || 0));
    return;
  }
  const activeId = String(state?.config?.activeAccountId || '');
  const account = (inbox.accounts || []).find(row => String(row.accountId || '') === activeId) || null;
  const cfg = (state?.config?.accounts || []).find(row => String(row.id || '') === activeId) || null;
  scope.textContent = String(cfg?.remark || cfg?.name || account?.accountRemark || account?.accountName || '当前账号');
  today.textContent = String(Math.max(0, Number(account?.todayNewCustomerCount || 0) || 0));
  duplicate.textContent = String(Math.max(0, Number(account?.duplicateCustomerCount || 0) || 0));
}


function externalGlobalInstalledPlatforms() {
  const installed = new Set(installedPlatformIds());
  return EXTERNAL_GLOBAL_AGGREGATE_PLATFORMS
    .filter(id => installed.has(id))
    .map(id => appCenterPlatformById(id))
    .filter(Boolean);
}

function externalGlobalPlatformMeta(platform) {
  return appCenterPlatformById(platform) || {
    id:String(platform || ''),
    name:String(platform || '').toUpperCase(),
    short:String(platform || '').toUpperCase().slice(0,4)
  };
}

function combineExternalGlobalAggregateInbox() {
  const platforms = externalGlobalInstalledPlatforms();
  const accounts = [];
  const conversations = [];
  let unreadCount = 0;
  let waitingCount = 0;
  let todayNewCustomerCount = 0;
  let duplicateCustomerCount = 0;

  for (const def of platforms) {
    const inbox = externalGlobalPlatformInboxes.get(def.id) || { accounts:[], conversations:[] };
    const normalizedAccounts = (inbox.accounts || []).map(account => ({
      ...account,
      platform:def.id,
      platformName:def.name,
      platformShort:def.short || def.name.slice(0,2),
      id:String(account.id || account.accountId || '')
    }));
    const accountById = new Map(normalizedAccounts.map(account => [String(account.id || ''), account]));
    accounts.push(...normalizedAccounts);
    conversations.push(...(inbox.conversations || []).map(item => {
      const account = accountById.get(String(item.accountId || ''));
      return {
        ...item,
        platform:def.id,
        platformName:def.name,
        platformShort:def.short || def.name.slice(0,2),
        accountName:item.accountName || account?.name || def.short || def.name
      };
    }));
    unreadCount += Math.max(0, Number(inbox.unreadCount || 0) || 0);
    waitingCount += Math.max(0, Number(inbox.waitingCount || (inbox.conversations || []).filter(item => item?.waiting === true).length) || 0);
    todayNewCustomerCount += Math.max(0, Number(inbox.todayNewCustomerCount || 0) || 0);
    duplicateCustomerCount += Math.max(0, Number(inbox.duplicateCustomerCount || 0) || 0);
  }

  conversations.sort((a,b) => {
    const av = Date.parse(a.lastMessageAt || a.updatedAt || a.capturedAt || '') || 0;
    const bv = Date.parse(b.lastMessageAt || b.updatedAt || b.capturedAt || '') || 0;
    return bv - av;
  });

  const lineAddedCount = conversations.filter(item => normalizeExternalCrmStage(item?.crm?.stage || '') === 'LINE已添加').length;
  const totalCustomerCount = conversations.length;
  const lineConversionRate = totalCustomerCount ? Math.round((lineAddedCount / totalCustomerCount) * 1000) / 10 : 0;

  externalAggregateInbox = {
    platform:EXTERNAL_GLOBAL_PLATFORM.id,
    accounts,
    conversations,
    unreadCount,
    waitingCount,
    todayNewCustomerCount,
    duplicateCustomerCount,
    lineAddedCount,
    totalCustomerCount,
    lineConversionRate,
    platforms:platforms.map(item => item.id)
  };
  return externalAggregateInbox;
}

async function refreshGlobalExternalAggregate({ remote = false, quiet = false, deepHarvest = false } = {}) {
  if (!externalGlobalAggregateActive) return null;
  const platforms = externalGlobalInstalledPlatforms();
  try {
    if (!quiet) setExternalStatus(remote ? '正在刷新全平台客户…' : '正在读取全平台客户缓存…');
    for (const def of platforms) {
      if (!externalGlobalAggregateActive) break;
      try {
        const payload = remote
          ? await window.yoko.refreshPlatformAggregate?.({ platform:def.id, deepHarvest: deepHarvest === true && def.id === 'metabusiness' })
          : await window.yoko.getPlatformAggregate?.(def.id);
        if (payload) externalGlobalPlatformInboxes.set(def.id, payload);
      } catch (error) {
        console.warn('[global-aggregate] refresh failed', def.id, error);
      }
    }
    const inbox = combineExternalGlobalAggregateInbox();
    if (externalGlobalAggregateActive) {
      renderExternalAggregateFilters();
      const selected = (inbox.conversations || []).find(item => externalAggregateKey(item) === externalAggregateSelectedKey);
      if (selected) externalAggregateSelected = selected;
      renderExternalAggregateCustomers();
      renderExternalCustomerStats();
      const label = $('#externalWorkspaceAccountLabel');
      if (label) label.textContent = `${platforms.length} 个平台 · ${inbox.accounts.length} 个账号 · ${inbox.conversations.length} 个客户`;
      if (!quiet) setExternalStatus(externalWaitingCenterActive ? `待回复中心 · ${externalWaitingCenterCount()} 位客户 · 已按优先级排序` : `全平台聚合 · ${inbox.conversations.length} 个客户 · ${inbox.unreadCount || 0} 条未读`);
    }
    return inbox;
  } catch (error) {
    if (!quiet) setExternalStatus('全平台聚合刷新失败：' + (error?.message || error));
    return null;
  }
}

function renderExternalCustomerStats() {
  renderExternalWaitingCenterState();
  const scope = $('#externalCustomerStatsScope');
  const today = $('#externalTodayNewCount');
  const duplicate = $('#externalDuplicateCount');
  const conversionWrap = $('#externalLineConversionStat');
  const addedWrap = $('#externalLineAddedStat');
  const conversion = $('#externalLineConversionRate');
  const added = $('#externalLineAddedCount');
  if (!scope || !today || !duplicate) return;

  if (externalGlobalAggregateActive) {
    const inbox = String(externalAggregateInbox?.platform || '') === EXTERNAL_GLOBAL_PLATFORM.id
      ? externalAggregateInbox
      : combineExternalGlobalAggregateInbox();
    scope.textContent = '全平台';
    today.textContent = String(Math.max(0, Number(inbox.todayNewCustomerCount || 0) || 0));
    duplicate.textContent = String(Math.max(0, Number(inbox.duplicateCustomerCount || 0) || 0));
    conversionWrap?.classList.remove('hidden');
    addedWrap?.classList.remove('hidden');
    if (conversion) conversion.textContent = `${Number(inbox.lineConversionRate || 0).toFixed(Number(inbox.lineConversionRate || 0) % 1 ? 1 : 0)}%`;
    if (added) added.textContent = String(Math.max(0, Number(inbox.lineAddedCount || 0) || 0));
    return;
  }

  conversionWrap?.classList.add('hidden');
  addedWrap?.classList.add('hidden');
  const platform = String(activeExternalPlatform || '');
  const inbox = String(externalAggregateInbox?.platform || '') === platform
    ? externalAggregateInbox
    : { platform, accounts:[], conversations:[], todayNewCustomerCount:0, duplicateCustomerCount:0 };
  if (externalGlobalAggregateActive || externalWorkspaceModeFor(platform) === 'aggregate') {
    scope.textContent = '综合';
    today.textContent = String(Math.max(0, Number(inbox.todayNewCustomerCount || 0) || 0));
    duplicate.textContent = String(Math.max(0, Number(inbox.duplicateCustomerCount || 0) || 0));
    return;
  }
  const activeId = String(activeExternalAccountId || '');
  const account = (inbox.accounts || []).find(row => String(row.id || row.accountId || '') === activeId) || null;
  const appAccount = externalAccountById(activeId);
  scope.textContent = String(appAccount?.name || account?.name || '当前账号');
  today.textContent = String(Math.max(0, Number(account?.todayNewCustomerCount || 0) || 0));
  duplicate.textContent = String(Math.max(0, Number(account?.duplicateCustomerCount || 0) || 0));
}

async function loadExternalCustomerStatsCache(platform = activeExternalPlatform) {
  platform = String(platform || '').trim();
  if (!externalPlatformHasAggregateWorkspace(platform)) return;
  try {
    const payload = await window.yoko.getPlatformAggregate?.(platform);
    if (!payload || String(activeExternalPlatform || '') !== platform) return;
    externalAggregateInbox = payload;
    renderExternalCustomerStats();
    if (externalWorkspaceModeFor(platform) === 'aggregate') {
      renderExternalAggregateFilters();
      renderExternalAggregateCustomers();
    }
  } catch {}
}
let externalTikTokCrmSyncTimer = null;
let externalTikTokCrmSyncInFlight = false;
let externalTikTokCrmLastKey = '';
let externalTikTokCrmMissCount = 0;
// V1.24.0 Hotfix3: native TikTok can transiently drop header selectors while
// the conversation is still visibly open. Keep the last confirmed customer
// sticky instead of blanking the CRM panel during those hydration gaps.
let externalTikTokCrmLastSuccessAt = 0;
let externalTikTokCrmLastGoodItem = null;
let externalCrmAutoSaveTimer = null;

// V1.21.5: every platform CRM panel has its own persistent open/collapsed state.
// TikTok is the first external CRM consumer; FB/IG/WA/TG/MB can reuse this
// exact map and toggle without sharing state with LINE or with each other.
const EXTERNAL_CRM_COLLAPSED_STORAGE_KEY = 'yoko.externalCrmCollapsedByPlatform.v1';
let externalCrmCollapsedByPlatform = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(EXTERNAL_CRM_COLLAPSED_STORAGE_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
})();

function externalPlatformHasCrm(platform) {
  // V1.22.0: every non-LINE application shares the same CRM shell/template.
  return String(platform || '').trim() === EXTERNAL_GLOBAL_PLATFORM.id || ['tiktok','facebook','instagram','whatsapp','telegram','metabusiness'].includes(String(platform || '').trim());
}

function externalCrmCollapsedFor(platform) {
  return !!externalCrmCollapsedByPlatform[String(platform || '').trim()];
}

function persistExternalCrmCollapsed(platform, collapsed) {
  platform = String(platform || '').trim();
  if (!platform) return;
  externalCrmCollapsedByPlatform[platform] = !!collapsed;
  try { localStorage.setItem(EXTERNAL_CRM_COLLAPSED_STORAGE_KEY, JSON.stringify(externalCrmCollapsedByPlatform)); } catch {}
}

async function applyExternalCrmCollapseState(platform = activeExternalPlatform, { persist = false, collapsed = null } = {}) {
  platform = String(platform || '').trim();
  const supported = externalPlatformHasCrm(platform);
  let next = collapsed === null ? externalCrmCollapsedFor(platform) : !!collapsed;
  if (!supported) next = false;
  if (persist && supported) persistExternalCrmCollapsed(platform, next);

  const panel = $('#externalCrmPanel');
  const collapseBtn = $('#externalCrmCollapseBtn');
  const toolbarBtn = $('#externalCrmToolbarToggleBtn');
  const page = $('#externalWorkspacePage');
  page?.classList.toggle('crm-collapsed', supported && next);
  panel?.classList.toggle('hidden', !supported || next);
  toolbarBtn?.classList.toggle('hidden', !supported || platform === EXTERNAL_GLOBAL_PLATFORM.id);
  if (collapseBtn) {
    collapseBtn.textContent = '›';
    collapseBtn.title = '收起客户资料';
    collapseBtn.setAttribute('aria-label', collapseBtn.title);
  }
  if (toolbarBtn) {
    toolbarBtn.textContent = next ? '显示CRM' : '收起CRM';
    toolbarBtn.title = next ? '展开客户资料' : '收起客户资料';
    toolbarBtn.setAttribute('aria-label', toolbarBtn.title);
  }

  try {
    const metrics = applyWorkspaceLayoutCss();
    await window.yoko.setLayoutMetrics?.({ ...metrics, externalCrmWidth: supported && !next ? metrics.externalCrmTargetWidth : 0 });
  } catch {}
  return next;
}

function externalWorkspaceModeFor(platform) {
  platform = String(platform || '').trim();
  if (platform === EXTERNAL_GLOBAL_PLATFORM.id) return 'aggregate';
  // V1.27.41: MB has one authoritative workspace only: the real native inbox.
  if (platform === 'metabusiness') return 'native';
  if (!externalPlatformHasAggregateWorkspace(platform)) return 'native';
  return externalWorkspaceModes[platform] === 'aggregate' ? 'aggregate' : 'native';
}


function persistExternalWorkspaceMode(platform, mode) {
  platform = String(platform || '').trim();
  if (!platform) return;
  // V1.27.41: purge every historical MB aggregate preference on sight.
  externalWorkspaceModes[platform] = platform === 'metabusiness' ? 'native' : (mode === 'aggregate' ? 'aggregate' : 'native');
  try { localStorage.setItem(EXTERNAL_WORKSPACE_MODE_STORAGE_KEY, JSON.stringify(externalWorkspaceModes)); } catch {}
}


function externalAggregateKey(item) {
  const platform=String(item?.platform || '');
  const stableUi = platform === 'metabusiness' ? String(item?.aggregateUiKey || '') : '';
  return `${platform}|${String(item?.accountId || '')}|${stableUi || String(item?.chatId || item?.displayName || '')}`;
}

function externalAggregateAwaitingReply(item) {
  if (!item) return false;
  const status = String(item?.crm?.serviceStatus || 'auto').trim();
  if (['paused','blacklist'].includes(status)) return false;
  // V1.27.25: `waiting` is computed in the main process by
  // externalConversationWaitingSnapshot(), which already understands manual
  // read/reply boundaries, aliases, CRM status and later customer turns. Once
  // the canonical boolean is present the renderer MUST NOT guess again from
  // lastDirection/lastIncomingAt. The old fallback resurrected a customer
  // immediately after mark-read because the last real message quite correctly
  // remained `customer` even though that turn had already been handled.
  if (typeof item?.waiting === 'boolean') return item.waiting;
  // Compatibility fallback for old/non-canonical snapshots only.
  if (status === 'waiting') return true;
  if (['active','done'].includes(status)) return false;
  if (item?.manualReadAt && item?.awaitingReply !== true && Math.max(0, Number(item?.unreadCount || 0) || 0) === 0) return false;
  if (item?.awaitingReply === true) return true;
  if (Math.max(0, Number(item?.unreadCount || 0) || 0) > 0) return true;
  const incoming = Math.max(0, Number(item?.lastIncomingAt || 0) || 0);
  const reply = Math.max(0, Number(item?.lastReplyAt || 0) || 0);
  return String(item?.lastDirection || '') === 'customer' && incoming > reply;
}

function externalAggregateWaitingSinceAt(item) {
  if (!externalAggregateAwaitingReply(item)) return 0;
  const direct = Math.max(0, Number(item?.waitingSinceAt || item?.pendingSinceAt || item?.lastIncomingAt || 0) || 0);
  if (direct) return direct;
  return externalAggregateSortTimestamp(item);
}

function externalAggregatePendingMessageCount(item) {
  if (!externalAggregateAwaitingReply(item)) return 0;
  return Math.max(1, Number(item?.pendingCustomerMessageCount || 0) || 0, Number(item?.unreadCount || 0) || 0);
}

// V1.23.68: weighted waiting priority. The score is intentionally based only
// on persisted CRM/waiting facts we already trust; it never changes CRM state.
function externalWaitingPriorityTagSet(item) {
  return new Set(String(item?.crm?.tags || '')
    .split(/[,，、;；/|\n]+/)
    .map(value => value.trim().toLowerCase())
    .filter(Boolean));
}

function externalWaitingPriorityStagePoints(stage = '') {
  return ({
    '已邀请LINE':34,
    '准备引导LINE':30,
    '有效聊天':22,
    '已接待':12,
    '新进线':7,
    'LINE已添加':8,
    '无效/暂停':-50
  })[String(stage || '').trim()] || 0;
}

function externalWaitingPriority(item, now = Date.now()) {
  if (!externalAggregateAwaitingReply(item)) return { score:-999, level:'none', label:'', reasons:[] };
  const reasons = [];
  let score = 0;
  const tags = externalWaitingPriorityTagSet(item);
  if (tags.has('重点客户') || tags.has('vip') || tags.has('高价值') || tags.has('高潜')) {
    score += 36;
    reasons.push('重点客户');
  }
  const stage = String(item?.crm?.stage || '').trim();
  const stagePoints = externalWaitingPriorityStagePoints(stage);
  score += stagePoints;
  if (stagePoints >= 30) reasons.push(stage);
  else if (stage === '有效聊天') reasons.push('有效聊天');

  const serviceStatus = String(item?.crm?.serviceStatus || 'auto').trim();
  if (serviceStatus === 'waiting') { score += 8; reasons.push('人工待回复'); }

  const pendingCount = externalAggregatePendingMessageCount(item);
  if (pendingCount > 1) {
    score += Math.min(18, (pendingCount - 1) * 6);
    reasons.push(`连续${pendingCount}条`);
  }

  const waitingSinceAt = externalAggregateWaitingSinceAt(item);
  const waitMs = waitingSinceAt ? Math.max(0, Number(now || Date.now()) - waitingSinceAt) : 0;
  const waitMinutes = Math.floor(waitMs / 60000);
  score += Math.min(30, Math.floor(waitMinutes / 20) * 2);
  if (waitMinutes >= 120) reasons.push(`已等${formatExternalWaitingDuration(waitMs)}`);

  const unread = Math.max(0, Number(item?.unreadCount || 0) || 0);
  if (unread > 0) score += Math.min(6, unread * 2);

  const level = score >= 60 ? 'urgent' : (score >= 38 ? 'high' : 'normal');
  const label = level === 'urgent' ? '紧急' : (level === 'high' ? '优先' : '待回复');
  return { score, level, label, reasons:reasons.slice(0, 4), pendingCount, waitMs, stage };
}

function formatExternalWaitingDuration(ms) {
  const minutes = Math.max(0, Math.floor(Number(ms || 0) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const remain = minutes % 60;
  if (hours < 24) return remain && hours < 10 ? `${hours}小时${remain}分` : `${hours}小时`;
  const days = Math.floor(hours / 24);
  return `${days}天`;
}

function externalWaitingCenterCount() {
  return (externalAggregateInbox?.conversations || []).filter(item => !isExternalAggregateCustomerHidden(item) && externalAggregateAwaitingReply(item)).length;
}

function externalRoundRobinCandidates() {
  return (externalAggregateInbox?.conversations || []).filter(item => {
    if (isExternalAggregateCustomerHidden(item)) return false;
    if (!externalAggregateAwaitingReply(item)) return false;
    if (externalGlobalAggregateActive && externalAggregatePlatformFilter && String(item.platform || '') !== externalAggregatePlatformFilter) return false;
    if (externalAggregateAccountFilter && String(item.accountId || '') !== externalAggregateAccountFilter) return false;
    return true;
  }).sort((a, b) => {
    const aw = externalAggregateWaitingSinceAt(a) || Number.MAX_SAFE_INTEGER;
    const bw = externalAggregateWaitingSinceAt(b) || Number.MAX_SAFE_INTEGER;
    if (aw !== bw) return aw - bw;
    const at = externalAggregateSortTimestamp(a);
    const bt = externalAggregateSortTimestamp(b);
    if (at !== bt) return at - bt;
    return externalAggregateKey(a).localeCompare(externalAggregateKey(b));
  });
}

function saveExternalRoundRobinState() {
  try { localStorage.setItem(EXTERNAL_ROUND_ROBIN_STORAGE_KEY, externalRoundRobinEnabledState ? '1' : '0'); } catch {}
}

function renderExternalRoundRobinState() {
  const button = $('#externalRoundRobinBtn');
  const count = $('#externalRoundRobinCount');
  const next = $('#externalRoundRobinNextBtn');
  const queueCount = externalRoundRobinCandidates().length;
  if (count) count.textContent = String(queueCount);
  button?.classList.toggle('active', externalRoundRobinEnabledState);
  if (button) {
    button.setAttribute('aria-pressed', externalRoundRobinEnabledState ? 'true' : 'false');
    button.title = externalRoundRobinEnabledState
      ? `轮回已开启（${queueCount} 位待回复客户，按最早等待顺序）`
      : `轮回已关闭（${queueCount} 位待回复客户）`;
  }
  if (next) {
    next.disabled = queueCount < 1;
    next.title = queueCount ? `打开下一位待回复客户（当前队列 ${queueCount} 位）` : '当前没有待回复客户';
  }
}

function renderExternalWaitingCenterState() {
  const button = $('#externalWaitingCenterBtn');
  const topButton = $('#externalAggregateWaitingBtn');
  const count = $('#externalWaitingCenterCount');
  const topCount = $('#externalAggregateWaitingCount');
  const waiting = externalWaitingCenterCount();
  if (count) count.textContent = String(waiting);
  if (topCount) topCount.textContent = String(waiting);
  button?.classList.toggle('active', externalWaitingCenterActive);
  topButton?.classList.toggle('active', externalWaitingCenterActive);
  const title = externalWaitingCenterActive
    ? `退出待回复中心（当前 ${waiting} 位待回复）`
    : `进入智能待回复中心（当前 ${waiting} 位待回复）`;
  if (button) button.title = title;
  if (topButton) topButton.title = title;
  renderExternalRoundRobinState();
}

function externalMetaBusinessFixedOrderEntry(item, fallbackIndex = 0) {
  if (String(item?.platform || '') !== 'metabusiness') return null;
  const key = externalAggregateKey(item);
  if (!key) return null;
  const existing = externalMetaBusinessFixedOrder.get(key);
  if (existing) return existing;
  const persisted = Math.max(0, Number(item?.aggregateDisplayOrder || 0) || 0);
  const nativeRaw = Number(item?.order ?? item?.nativeOffset);
  const position = persisted > 0
    ? persisted
    : (Number.isFinite(nativeRaw) && nativeRaw >= 0 ? 1000000 + nativeRaw : 2000000 + Math.max(0, Number(fallbackIndex || 0) || 0));
  const entry = { position, sequence: ++externalMetaBusinessFixedOrderSequence };
  externalMetaBusinessFixedOrder.set(key, entry);
  return entry;
}

function externalAggregateFilteredRows() {
  const q = String(externalAggregateSearch || '').trim().toLowerCase();
  const filtered = (externalAggregateInbox?.conversations || []).filter(item => {
    if (isExternalAggregateCustomerHidden(item)) return false;
    if (externalGlobalAggregateActive && externalAggregatePlatformFilter && String(item.platform || '') !== externalAggregatePlatformFilter) return false;
    if (externalAggregateAccountFilter && String(item.accountId || '') !== externalAggregateAccountFilter) return false;
    if (externalWaitingCenterActive && !externalAggregateAwaitingReply(item)) return false;
    if (!q) return true;
    return [item.displayName, item.handle, item.preview, item.accountName, item.platformName, item.platformShort, item.crm?.name, item.crm?.tags]
      .some(value => String(value || '').toLowerCase().includes(q));
  });
  return filtered.sort((a, b) => {
    const bothMeta = String(a?.platform || '') === 'metabusiness' && String(b?.platform || '') === 'metabusiness';
    const normalMetaMirror = bothMeta && !externalWaitingCenterActive && !externalRoundRobinEnabledState;
    // Exact native mirror means exact: in normal MB mode even a historical
    // Yoko pin may not jump ahead of Meta's own first row. Pins remain useful in
    // waiting/round-robin modes and on other platforms.
    if (!normalMetaMirror) {
      const ap = isExternalAggregateCustomerPinned(a);
      const bp = isExternalAggregateCustomerPinned(b);
      if (ap !== bp) return ap ? -1 : 1;
    }

    // V1.27.36 mode-aware Meta ordering:
    // - normal aggregate view mirrors Meta Business' native visible inbox order;
    // - waiting-center / round-robin views intentionally switch to LINE-style
    //   chronology. A handled reply stamps a new boundary and moves the customer
    //   to the rail tail; a later customer message starts a new turn and re-enters
    //   the rail by that new timestamp. Never mix native mirror order into these
    //   queue modes.
    if (bothMeta && (externalWaitingCenterActive || externalRoundRobinEnabledState)) {
      const aa = String(a?.accountId || '');
      const ba = String(b?.accountId || '');
      if (aa !== ba) return aa.localeCompare(ba, 'zh-CN', { numeric:true });
      const at = externalAggregateRoundRobinOrderAt(a);
      const bt = externalAggregateRoundRobinOrderAt(b);
      if (at !== bt) return at - bt;
      const aw = externalAggregateWaitingSinceAt(a);
      const bw = externalAggregateWaitingSinceAt(b);
      if (aw !== bw) return aw - bw;
      return externalAggregateKey(a).localeCompare(externalAggregateKey(b));
    }

    // Normal Meta aggregate view mirrors the newest native MB visual snapshot
    // directly. Queue modes above deliberately bypass this mirror.
    if (bothMeta) {
      const aa = String(a?.accountId || '');
      const ba = String(b?.accountId || '');
      if (aa !== ba) return aa.localeCompare(ba, 'zh-CN', { numeric:true });
      // V1.27.33: main attaches nativeMirrorRank directly from the newest
      // preload snapshot. Prefer it before all cached snapshot/offset fallbacks.
      const mirrorRank=item=>{ const raw=item?.nativeMirrorRank; if(raw===null||raw===undefined||raw==='')return null; const n=Number(raw); return Number.isFinite(n)&&n>=0?n:null; };
      const am=mirrorRank(a), bm=mirrorRank(b);
      if (am !== null || bm !== null) {
        if (am === null) return 1;
        if (bm === null) return -1;
        if (am !== bm) return am - bm;
      }
      let latestSnapshotAt=0;
      for (const row of (Array.isArray(externalAggregateInbox?.conversations)?externalAggregateInbox.conversations:[])) {
        if (String(row?.platform||'')!=='metabusiness'||String(row?.accountId||'')!==aa) continue;
        latestSnapshotAt=Math.max(latestSnapshotAt,Math.max(0,Number(row?.nativeSnapshotAt||0)||0));
      }
      const snapshotRank=item=>{
        if (!latestSnapshotAt||Math.max(0,Number(item?.nativeSnapshotAt||0)||0)!==latestSnapshotAt) return null;
        const n=Number(item?.nativeSnapshotRank); return Number.isFinite(n)&&n>=0?n:null;
      };
      const ar=snapshotRank(a), br=snapshotRank(b);
      if (ar !== null || br !== null) {
        if (ar === null) return 1;
        if (br === null) return -1;
        if (ar !== br) return ar - br;
      }
      const native = item => { const raw=item?.nativeOffset ?? item?.order; const n=Number(raw); return raw!==null&&raw!==undefined&&raw!==''&&Number.isFinite(n)&&n>=0 ? n : null; };
      const an=native(a), bn=native(b);
      if (an !== null || bn !== null) {
        if (an === null) return 1;
        if (bn === null) return -1;
        if (an !== bn) return an - bn;
      }
      const af=Math.max(0,Number(a?.aggregateDisplayOrder || 0)||0);
      const bf=Math.max(0,Number(b?.aggregateDisplayOrder || 0)||0);
      if (af !== bf) return af - bf;
      return externalAggregateKey(a).localeCompare(externalAggregateKey(b));
    }

    if (externalWaitingCenterActive) {
      const apriority = externalWaitingPriority(a);
      const bpriority = externalWaitingPriority(b);
      if (apriority.score !== bpriority.score) return bpriority.score - apriority.score;
      const aw = externalAggregateWaitingSinceAt(a);
      const bw = externalAggregateWaitingSinceAt(b);
      if (aw !== bw) return aw - bw;
    } else if (externalRoundRobinEnabledState) {
      const at = externalAggregateRoundRobinOrderAt(a);
      const bt = externalAggregateRoundRobinOrderAt(b);
      if (at !== bt) return at - bt;
    }
    const at = externalAggregateSortTimestamp(a);
    const bt = externalAggregateSortTimestamp(b);
    if (at !== bt) return bt - at;
    return externalAggregateKey(a).localeCompare(externalAggregateKey(b));
  });
}

function externalAggregateAvatarHtml(item, cls = 'external-aggregate-avatar') {
  const url = String(item?.avatarUrl || '').trim();
  const initial = String(item?.displayName || '?').trim().slice(0, 1) || '?';
  return `<span class="${cls}">${url ? `<img src="${escapeHtml(url)}" alt="" referrerpolicy="no-referrer" />` : `<span>${escapeHtml(initial)}</span>`}</span>`;
}

function externalAggregateServiceStatus(item) {
  const raw = String(item?.crm?.serviceStatus || 'auto').trim();
  if (['waiting','active','done','paused','blacklist'].includes(raw)) return raw;
  if (externalAggregateAwaitingReply(item)) return 'waiting';
  return 'active';
}

function externalAggregateServiceStatusLabel(status) {
  return ({ waiting:'待回复', active:'跟进中', done:'已完成', paused:'暂停', blacklist:'黑名单' })[status] || '跟进中';
}

function applyExternalAggregateSelectionVisual() {
  const list = $('#externalAccountSidebarList');
  if (!list) return;
  for (const card of list.querySelectorAll('[data-platform-customer-key]')) {
    const key = String(card.getAttribute('data-platform-customer-key') || '');
    card.classList.toggle('active', !!externalAggregateSelectedKey && key === externalAggregateSelectedKey);
  }
}

function renderExternalAggregateCustomers() {
  const list = $('#externalAccountSidebarList');
  if (!list) return;
  const previousScrollTop = list.scrollTop;
  let scrollAnchorKey = '';
  let scrollAnchorOffset = 0;
  try {
    const lr=list.getBoundingClientRect();
    const cards=Array.from(list.querySelectorAll('[data-platform-customer-key]'));
    const anchor=cards.find(card => card.getBoundingClientRect().bottom >= lr.top + 2) || cards[0] || null;
    if (anchor) {
      scrollAnchorKey=String(anchor.getAttribute('data-platform-customer-key') || '');
      scrollAnchorOffset=anchor.getBoundingClientRect().top-lr.top;
    }
  } catch {}
  const restoreScroll = () => {
    try {
      // V1.27.36: when the native MB order itself changed, preserving the old
      // Yoko scroll anchor hides the newly-promoted first customer and makes the
      // two lists look unsynchronized even though their data is sorted. Follow
      // the native move visually once; steady heartbeats keep the user's scroll.
      // V1.27.38: order synchronization is NOT scroll synchronization.
      // If the operator is already at the top, a newly-promoted native customer
      // should be visible at the top too. But when either list is being browsed
      // farther down, preserve this software list's own scroll anchor; Meta's
      // virtual-scroll viewport must never drag Yoko's scrollbar with it.
      if (typeof metaMirrorOrderChanged !== 'undefined' && metaMirrorOrderChanged && previousScrollTop <= 8) {
        list.scrollTop = 0;
        return;
      }
      if (scrollAnchorKey) {
        const anchor=Array.from(list.querySelectorAll('[data-platform-customer-key]')).find(node => String(node.getAttribute('data-platform-customer-key') || '') === scrollAnchorKey);
        if (anchor) {
          const lr=list.getBoundingClientRect();
          list.scrollTop += anchor.getBoundingClientRect().top-lr.top-scrollAnchorOffset;
          return;
        }
      }
      list.scrollTop=previousScrollTop;
    } catch {}
  };
  renderExternalWaitingCenterState();
  const rows = externalAggregateFilteredRows();
  const normalMetaMirrorMode = !externalGlobalAggregateActive && activeExternalPlatform === 'metabusiness' && !externalWaitingCenterActive && !externalRoundRobinEnabledState;
  const currentMetaMirrorSignature = normalMetaMirrorMode
    ? rows.filter(row => String(row?.platform||'') === 'metabusiness' && row?.nativeMirrorRank !== null && row?.nativeMirrorRank !== undefined && row?.nativeMirrorRank !== '')
        .slice(0,80).map(row => `${externalAggregateKey(row)}@${Number(row.nativeMirrorRank)}`).join('|')
    : '';
  const metaMirrorOrderChanged = !!(normalMetaMirrorMode && currentMetaMirrorSignature && currentMetaMirrorSignature !== externalMetaNormalMirrorSignature);
  if (normalMetaMirrorMode && currentMetaMirrorSignature) externalMetaNormalMirrorSignature = currentMetaMirrorSignature;
  else if (!normalMetaMirrorMode) externalMetaNormalMirrorSignature = '';
  const count = $('#externalAccountSidebarCount');
  if (count) count.textContent = String(rows.length);
  if (!rows.length) {
    if (externalGlobalAggregateActive) {
      list.innerHTML = `<div class="external-aggregate-empty">${externalAggregateInbox?.accounts?.length ? (externalWaitingCenterActive ? '当前没有待回复客户。<br>客户再次发来消息后会自动进入这里。' : '暂时没有符合条件的客户。<br>系统会从每个非 LINE 平台自己的独立 Profile/Session 抓取客户；未登录账号请先进入对应平台登录。') : '还没有已添加的非 LINE 平台账号。'}</div>`;
    } else {
      const def = appCenterPlatformById(activeExternalPlatform);
      const short = def?.short || activeExternalPlatform.toUpperCase();
      list.innerHTML = `<div class="external-aggregate-empty">${externalAggregateInbox?.accounts?.length ? (externalWaitingCenterActive ? `当前没有 ${short} 待回复客户。<br>客户再次来信后会自动进入这里。` : `暂时没有抓到客户。<br>系统正在使用每个 ${short} 自己的独立登录 Profile 扫描；未登录的账号请到 ${short}模式 登录一次。`) : `还没有 ${def?.name || short} 账号。`}</div>`;
    }
    requestAnimationFrame(restoreScroll);
    return;
  }
  list.innerHTML = rows.map(item => {
    const key = externalAggregateKey(item);
    const selected = key === externalAggregateSelectedKey;
    const handle = String(item.handle || '').replace(/^@/, '');
    const preview = String(item.preview || item.lastMessage || '暂无消息预览');
    const duplicate = externalDuplicateInfoFor(item);
    const serviceStatus = externalAggregateServiceStatus(item);
    const tags = String(item?.crm?.tags || '').split(/[,，、;；]/).map(v => v.trim()).filter(Boolean).slice(0, 2);
    const platformMeta = externalGlobalPlatformMeta(item.platform || activeExternalPlatform);
    const source = String(item.accountName || platformMeta?.short || '账号');
    const unread = Math.max(0, Number(item.unreadCount || 0) || 0);
    const pinned = isExternalAggregateCustomerPinned(item);
    const awaitingReply = externalAggregateAwaitingReply(item);
    const waitingSinceAt = externalAggregateWaitingSinceAt(item);
    const waitMs = awaitingReply && waitingSinceAt ? Math.max(0, Date.now() - waitingSinceAt) : 0;
    const pendingCount = externalAggregatePendingMessageCount(item);
    const stage = String(item?.crm?.stage || '').trim();
    const priority = awaitingReply ? externalWaitingPriority(item) : { score:0, level:'none', label:'', reasons:[] };
    const priorityTitle = priority.reasons?.length
      ? `优先级 ${priority.score} · ${priority.reasons.join(' · ')}`
      : `优先级 ${priority.score}`;
    const compactAccount = source.length > 8 ? `${source.slice(0, 8)}…` : source;
    const tooltip = [item.displayName || '未命名客户', platformMeta?.short || item.platform || '', source, handle ? `@${handle}` : ''].filter(Boolean).join(' · ');
    return `<button class="external-aggregate-customer aggregate-customer-item${selected ? ' active' : ''}${pinned ? ' pinned' : ''}${duplicate.duplicate ? ' duplicate' : ''}" type="button" data-platform-customer-key="${escapeHtml(key)}" title="${escapeHtml(tooltip)}">
      ${externalAggregateAvatarHtml(item, 'aggregate-customer-avatar external-aggregate-avatar')}
      <span class="external-aggregate-compact-meta" aria-hidden="true">
        <strong>${escapeHtml(item.displayName || '未命名')}</strong>
        <span class="external-aggregate-compact-source">
          ${externalGlobalAggregateActive ? `<span class="external-global-platform-badge platform-${escapeHtml(item.platform || '')}">${escapeHtml(item.platformShort || platformMeta.short || item.platform || '')}</span>` : ''}
          <small>${escapeHtml(compactAccount)}</small>
        </span>
      </span>
      <span class="aggregate-customer-body external-aggregate-body">
        <span class="aggregate-customer-row primary">
          <span class="aggregate-customer-name-line">
            ${pinned ? '<span class="aggregate-customer-pin" title="已置顶">★</span>' : ''}
            <strong class="aggregate-customer-name">${escapeHtml(item.displayName || '未命名客户')}</strong>
            ${duplicate.duplicate ? `<span class="aggregate-customer-duplicate-badge" title="同时出现在 ${escapeHtml(duplicate.accounts.join(' / ') || `${duplicate.count} 个账号`)}">重复粉</span>` : ''}
            <span class="aggregate-customer-service-status ${escapeHtml(serviceStatus)}">${escapeHtml(externalAggregateServiceStatusLabel(serviceStatus))}</span>
            ${tags.map(tag => `<span class="aggregate-customer-tag">${escapeHtml(tag)}</span>`).join('')}
          </span>
          <span class="aggregate-customer-time">${escapeHtml(item.lastMessageAt || '')}</span>
        </span>
        <span class="aggregate-customer-row secondary">
          ${externalGlobalAggregateActive ? `<span class="external-global-platform-badge platform-${escapeHtml(item.platform || '')}">${escapeHtml(item.platformShort || platformMeta.short || item.platform || '')}</span>` : ''}
          <span class="aggregate-customer-account">${escapeHtml(source)}</span>
          ${handle ? `<span class="external-aggregate-handle">@${escapeHtml(handle)}</span>` : ''}
          ${unread > 0 ? `<span class="aggregate-customer-unread">${escapeHtml(unread > 99 ? '99+' : String(unread))}</span>` : '<span class="aggregate-customer-read">已读</span>'}
        </span>
        ${awaitingReply ? `<span class="external-waiting-meta">${externalWaitingCenterActive ? `<strong class="external-waiting-priority ${escapeHtml(priority.level)}" title="${escapeHtml(priorityTitle)}">${escapeHtml(priority.label)}</strong>` : ''}<b>等待 ${escapeHtml(formatExternalWaitingDuration(waitMs))}</b>${pendingCount > 1 ? `<em>连续 ${pendingCount} 条</em>` : ''}${stage ? `<i>${escapeHtml(stage)}</i>` : ''}</span>` : ''}
        <span class="aggregate-customer-preview">${escapeHtml(preview)}</span>
      </span>
    </button>`;
  }).join('');
  requestAnimationFrame(restoreScroll);
}

function showExternalAggregateCustomerContextMenu(event, item) {
  if (!item) return;
  event.preventDefault();
  event.stopPropagation();
  closeAggregateCustomerContextMenu();
  const key = externalAggregateKey(item);
  const pinned = externalAggregatePinnedKeys.has(key);
  const def = externalGlobalPlatformMeta(item.platform || activeExternalPlatform);
  const menu = document.createElement('div');
  menu.className = 'aggregate-customer-context-menu external-customer-context-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <button type="button" class="pin" role="menuitem">${pinned ? '取消置顶' : '置顶客户'}</button>
    <button type="button" class="mark-read" role="menuitem">标记已读</button>
    <button type="button" class="danger delete-user" role="menuitem">删除用户</button>
    <div class="aggregate-customer-context-hint">${escapeHtml(def.short || def.name || '平台')} · ${escapeHtml(item.accountName || item.accountId || '账号')} · 标记已读 = 手动完成当前轮回；客户再次来信会重新进入。删除用户只从 Yoko 聚合列表隐藏，不删除平台原聊天。</div>
  `;
  document.body.appendChild(menu);
  const margin = 8;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(margin, Math.min(event.clientX, window.innerWidth - rect.width - margin))}px`;
  menu.style.top = `${Math.max(margin, Math.min(event.clientY, window.innerHeight - rect.height - margin))}px`;
  menu.querySelector('button.pin')?.addEventListener('click', () => {
    if (externalAggregatePinnedKeys.has(key)) externalAggregatePinnedKeys.delete(key);
    else externalAggregatePinnedKeys.add(key);
    saveExternalAggregatePinnedCustomers();
    closeAggregateCustomerContextMenu();
    renderExternalAggregateCustomers();
    setExternalStatus(`${externalAggregatePinnedKeys.has(key) ? '已置顶' : '已取消置顶'}：${item.displayName || '客户'}`);
  });
  menu.querySelector('button.mark-read')?.addEventListener('click', async () => {
    closeAggregateCustomerContextMenu();
    try {
      const result = await window.yoko.savePlatformCrmContact?.({ _action:'mark-read',
        platform:String(item.platform || activeExternalPlatform || ''),
        accountId:String(item.accountId || ''),
        chatId:String(item.chatId || ''),
        displayName:String(item.displayName || ''),
        handle:String(item.handle || '')
      });
      if (!result?.ok) throw new Error(result?.error || '当前没有可完成的客户来信');
      // V1.27.19: update the local row immediately so the orange waiting badge
      // and round-robin membership disappear in the same click, before the
      // asynchronous aggregate refresh comes back.
      const markedAt = Math.max(0, Number(result?.markedAt || Date.now()) || Date.now());
      const patchRow = row => {
        if (!row) return;
        const sameKey = externalAggregateKey(row) === key;
        const sameChat = String(item.chatId || '') && String(row.chatId || '') === String(item.chatId || '');
        const sameUi = String(item.aggregateUiKey || '') && String(row.aggregateUiKey || '') === String(item.aggregateUiKey || '');
        if (!(sameKey || sameChat || sameUi)) return;
        row.awaitingReply = false; row.waiting = false; row.unreadCount = 0;
        row.pendingCustomerMessageCount = 0; row.pendingSinceAt = 0; row.waitingSinceAt = 0;
        row.manualReadAt = markedAt;
      };
      (externalAggregateInbox?.conversations || []).forEach(patchRow);
      for (const inbox of externalGlobalPlatformInboxes.values()) (inbox?.conversations || []).forEach(patchRow);
      renderExternalWaitingCenterState();
      renderExternalAggregateCustomers();
      if (externalGlobalAggregateActive) await refreshGlobalExternalAggregate({ remote:false, quiet:true });
      else await refreshExternalAggregate({ remote:false, quiet:true });
      renderExternalWaitingCenterState();
      renderExternalAggregateCustomers();
      setExternalStatus(`已标记已读：${item.displayName || '客户'} · 已从当前轮回移除`);
    } catch (error) {
      setExternalStatus('标记已读失败：' + (error?.message || error));
    }
  });
  menu.querySelector('button.delete-user')?.addEventListener('click', () => {
    const name = String(item.displayName || '客户');
    const ok = window.confirm(`确定从 Yoko 聚合列表删除「${name}」吗？\n\n这只会隐藏这个客户，不会删除 ${def.name || '平台'} 里的原始聊天记录，也不会删除已有 CRM / 长期记忆。`);
    if (!ok) return;

    // V1.27.20: tombstone every known alias instead of only the context-menu
    // key. The native page may hydrate name:* -> thread:* while the confirm
    // dialog is open; alias tombstones guarantee the refreshed row is still
    // considered deleted.
    hideExternalAggregateCustomer(item);
    for (const row of (externalAggregateInbox?.conversations || [])) {
      if (!externalAggregateRowsEquivalent(row, item)) continue;
      externalAggregatePinnedKeys.delete(externalAggregateKey(row));
    }
    externalAggregatePinnedKeys.delete(key);
    saveExternalAggregatePinnedCustomers();

    // Purge matching rows from the current renderer snapshot immediately.
    // Background refresh may repopulate the raw snapshot later, but the
    // tombstone filter above keeps the customer hidden until explicitly restored.
    if (Array.isArray(externalAggregateInbox?.conversations)) {
      externalAggregateInbox.conversations = externalAggregateInbox.conversations.filter(row => !isExternalAggregateCustomerHidden(row));
    }

    const selectedWasDeleted = externalAggregateSelected && externalAggregateRowsEquivalent(externalAggregateSelected, item);
    if (selectedWasDeleted || externalAggregateSelectedKey === key) {
      externalAggregateSelectedKey = '';
      externalAggregateSelected = null;
      externalAggregateCrmContext = null;
      resetExternalCrmPanel();
    }
    closeAggregateCustomerContextMenu();
    renderExternalAggregateFilters();
    renderExternalWaitingCenterState();
    renderExternalAggregateCustomers();
    setExternalStatus(`已从聚合列表删除：${name}`);
  });

  setTimeout(() => {
    const close = e => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('pointerdown', close, true);
      }
    };
    document.addEventListener('pointerdown', close, true);
  }, 0);
}

function renderExternalAggregateFilters() {
  const accountSelect = $('#externalAggregateAccountFilter');
  const platformSelect = $('#externalAggregatePlatformFilter');
  if (!accountSelect) return;

  if (externalGlobalAggregateActive) {
    platformSelect?.classList.remove('hidden');
    const platformCounts = new Map();
    for (const row of (externalAggregateInbox?.conversations || [])) {
      if (isExternalAggregateCustomerHidden(row)) continue;
      const id = String(row.platform || '');
      platformCounts.set(id, (platformCounts.get(id) || 0) + 1);
    }
    const defs = externalGlobalInstalledPlatforms();
    if (platformSelect) {
      platformSelect.innerHTML = '<option value="">全部平台</option>' + defs.map(def =>
        `<option value="${escapeHtml(def.id)}">${escapeHtml(def.short || def.name)} · ${platformCounts.get(def.id) || 0}</option>`
      ).join('');
      platformSelect.value = defs.some(def => def.id === externalAggregatePlatformFilter) ? externalAggregatePlatformFilter : '';
      if (platformSelect.value !== externalAggregatePlatformFilter) externalAggregatePlatformFilter = '';
    }

    const accounts = (externalAggregateInbox?.accounts || []).filter(account =>
      !externalAggregatePlatformFilter || String(account.platform || '') === externalAggregatePlatformFilter
    );
    accountSelect.innerHTML = '<option value="">全部账号</option>' + accounts.map(account =>
      `<option value="${escapeHtml(account.id)}">${escapeHtml(account.platformShort || externalGlobalPlatformMeta(account.platform).short)} · ${escapeHtml(account.name || account.id)}${account.isOpen ? '' : '（已关闭）'}</option>`
    ).join('');
    accountSelect.value = accounts.some(a => String(a.id) === externalAggregateAccountFilter) ? externalAggregateAccountFilter : '';
    if (accountSelect.value !== externalAggregateAccountFilter) externalAggregateAccountFilter = '';
    return;
  }

  platformSelect?.classList.add('hidden');
  externalAggregatePlatformFilter = '';
  const current = externalAggregateAccountFilter;
  const short = appCenterPlatformById(activeExternalPlatform)?.short || activeExternalPlatform.toUpperCase();
  accountSelect.innerHTML = `<option value="">全部${escapeHtml(short)}账号</option>` + (externalAggregateInbox?.accounts || []).map(account =>
    `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}${account.isOpen ? '' : '（已关闭）'}</option>`
  ).join('');
  accountSelect.value = (externalAggregateInbox?.accounts || []).some(a => a.id === current) ? current : '';
  if (accountSelect.value !== current) externalAggregateAccountFilter = '';
}

function externalCrmTimelineLabel(value) {
  if (value === null || value === undefined || value === '') return '—';
  const raw = String(value).trim();
  if (!raw) return '—';
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && numeric > 1000000000
    ? new Date(numeric)
    : new Date(raw);
  if (!Number.isNaN(date.getTime())) {
    return `${String(date.getMonth()+1).padStart(2,'0')}/${String(date.getDate()).padStart(2,'0')} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
  }
  return raw.length > 18 ? raw.slice(0,18) : raw;
}

function setExternalSelectValue(selector, value, fallback) {
  const node = $(selector);
  if (!node) return;
  const wanted = String(value || fallback || '');
  node.value = Array.from(node.options || []).some(opt => opt.value === wanted) ? wanted : String(fallback || '');
}

const BUSINESS_ENGINE_DEFINITIONS = window.yoko?.businessEngine || {
  line:{ id:'relationship_chat', label:'聊天经营', goal:'长期聊天 · 关系维护 · 持续跟进', defaultStage:'初步认识', stages:['初步认识','熟悉互动','信任建立','重点跟进','长期维护','暂缓'], stageMeta:{} },
  lead:{ id:'lead_conversion', label:'招商跟进', goal:'待回复 · 有意向 · 已对接 WS · 无效', defaultStage:'待回复', stages:['待回复','有意向','已对接ws','无效'], stageMeta:{} }
};
const LINE_BUSINESS_ENGINE = BUSINESS_ENGINE_DEFINITIONS.line || {};
const LEAD_BUSINESS_ENGINE = BUSINESS_ENGINE_DEFINITIONS.lead || {};

function businessStageMeta(engine, stage) {
  const value = String(stage || engine?.defaultStage || '').trim();
  return engine?.stageMeta?.[value] || { nextStage:value, action:engine?.goal || '', automation:engine?.label || '' };
}

function renderExternalBusinessEngineHint(stage = '') {
  const node = $('#externalCrmBusinessHint');
  if (!node) return;
  const value = normalizeExternalCrmStage(String(stage || LEAD_BUSINESS_ENGINE.defaultStage || '新进线'));
  const meta = businessStageMeta(LEAD_BUSINESS_ENGINE, value);
  const added = value === 'LINE已添加';
  const next = meta.nextStage && meta.nextStage !== value ? ` · 下一阶段：${meta.nextStage}` : '';
  node.classList.toggle('line-added', added);
  node.innerHTML = `<strong>${escapeHtml(LEAD_BUSINESS_ENGINE.label || '引流转化')} · ${escapeHtml(value)}</strong><span>${escapeHtml(added ? '已完成引流转化，客户已进入 LINE。' : (meta.action || LEAD_BUSINESS_ENGINE.goal || ''))}${escapeHtml(added ? '' : next)}</span>`;
}

function renderLineBusinessEngineHint(stage = '') {
  const node = $('#crmSideBusinessHint');
  if (!node) return;
  const value = String(stage || LINE_BUSINESS_ENGINE.defaultStage || '初步认识');
  const meta = businessStageMeta(LINE_BUSINESS_ENGINE, value);
  const next = meta.nextStage && meta.nextStage !== value ? ` · 下一阶段：${meta.nextStage}` : '';
  node.innerHTML = `<strong>${escapeHtml(LINE_BUSINESS_ENGINE.label || '聊天经营')} · ${escapeHtml(value)}</strong><span>${escapeHtml(meta.action || LINE_BUSINESS_ENGINE.goal || '')}${escapeHtml(next)}</span>`;
}

const EXTERNAL_FLOW_STAGE_STORAGE_KEY = 'yoko.externalFlowStages.v1';
const OLD_DEFAULT_EXTERNAL_FLOW_STAGES = ['新客户', '沟通了解中', 'LINE已添加'];
const LEGACY_LEAD_DEFAULT_STAGES = ['新进线','已接待','有效聊天','准备引导LINE','已邀请LINE','LINE已添加','无效/暂停'];
const LEAD_STAGE_ALIASES = Object.freeze({'新客户':'待回复','沟通了解中':'有意向','新进线':'待回复','已接待':'待回复','有效聊天':'有意向','准备引导LINE':'有意向','已邀请LINE':'有意向','LINE已添加':'已对接ws','已添加LINE':'已对接ws','无效/暂停':'无效','暂停':'无效'});
const DEFAULT_EXTERNAL_FLOW_STAGES = Array.isArray(LEAD_BUSINESS_ENGINE.stages) && LEAD_BUSINESS_ENGINE.stages.length
  ? [...LEAD_BUSINESS_ENGINE.stages]
  : ['待回复','有意向','已对接ws','无效'];

function normalizeExternalFlowStages(items) {
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    let value = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!value) continue;
    if (/^(?:LINE已添加|已添加LINE|Line已添加|line已添加)$/i.test(value)) value = 'LINE已添加';
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  if (!result.length) return [...DEFAULT_EXTERNAL_FLOW_STAGES];
  return result.slice(0, 24);
}

function loadExternalFlowStages() {
  try {
    const parsed = JSON.parse(localStorage.getItem(EXTERNAL_FLOW_STAGE_STORAGE_KEY) || 'null');
    if (Array.isArray(parsed)) {
      const clean = normalizeExternalFlowStages(parsed);
      const oldDefault = normalizeExternalFlowStages(OLD_DEFAULT_EXTERNAL_FLOW_STAGES);
      if (clean.length) {
        if (JSON.stringify(clean) === JSON.stringify(normalizeExternalFlowStages(LEGACY_LEAD_DEFAULT_STAGES))) {
          try { localStorage.setItem(EXTERNAL_FLOW_STAGE_STORAGE_KEY, JSON.stringify(DEFAULT_EXTERNAL_FLOW_STAGES)); } catch {}
          return [...DEFAULT_EXTERNAL_FLOW_STAGES];
        }
        if (JSON.stringify(clean) === JSON.stringify(oldDefault)) {
          try { localStorage.setItem(EXTERNAL_FLOW_STAGE_STORAGE_KEY, JSON.stringify(DEFAULT_EXTERNAL_FLOW_STAGES)); } catch {}
          return [...DEFAULT_EXTERNAL_FLOW_STAGES];
        }
        return clean;
      }
    }
  } catch {}
  return [...DEFAULT_EXTERNAL_FLOW_STAGES];
}

function saveExternalFlowStages(items) {
  const clean = normalizeExternalFlowStages(items);
  const next = clean.length ? clean : [...DEFAULT_EXTERNAL_FLOW_STAGES];
  try { localStorage.setItem(EXTERNAL_FLOW_STAGE_STORAGE_KEY, JSON.stringify(next)); } catch {}
  ensureExternalCrmStageOptions($('#externalCrmStage')?.value || '');
  renderExternalFlowSettingsList();
  return next;
}

function normalizeExternalCrmStage(value) {
  const raw = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!raw) return loadExternalFlowStages()[0] || '待回复';
  return LEAD_STAGE_ALIASES[raw] || raw;
}

function ensureExternalCrmStageOptions(preferredValue = '') {
  const node = $('#externalCrmStage');
  if (!node) return;
  const wanted = normalizeExternalCrmStage(preferredValue || node.value || '待回复');
  const stages = loadExternalFlowStages();
  node.innerHTML = stages.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
  if (wanted && !stages.includes(wanted)) {
    node.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(wanted)}">${escapeHtml(wanted)}（历史阶段）</option>`);
  }
  node.value = Array.from(node.options || []).some(option => option.value === wanted)
    ? wanted
    : (stages[0] || '新进线');
}

function renderExternalFlowSettingsList() {
  const list = $('#externalFlowStageList');
  if (!list) return;
  const stages = loadExternalFlowStages();
  list.innerHTML = stages.map((stage, index) => {
    const locked = stage === 'LINE已添加';
    return `<div class="line-flow-settings-row" data-external-flow-stage-index="${index}">
      <span class="line-flow-settings-main"><strong>${index + 1}. ${escapeHtml(stage)}</strong><small>${locked ? 'LINE 转化统计阶段 · 固定保留' : '非 LINE 平台共用流程阶段'}</small></span>
      <span class="line-flow-settings-actions">
        <button type="button" data-external-flow-stage-up="${index}" ${index === 0 ? 'disabled' : ''} title="上移">↑</button>
        <button type="button" data-external-flow-stage-down="${index}" ${index === stages.length - 1 ? 'disabled' : ''} title="下移">↓</button>
        <button type="button" class="danger" data-external-flow-stage-delete="${index}" ${locked || stages.length <= 2 ? 'disabled' : ''}>删除</button>
      </span>
    </div>`;
  }).join('');
}

async function openExternalFlowSettingsModal() {
  renderExternalFlowSettingsList();
  if ($('#externalFlowStageInput')) $('#externalFlowStageInput').value = '';
  await openModal('externalFlowSettingsModal');
  setTimeout(() => $('#externalFlowStageInput')?.focus({ preventScroll:true }), 0);
}

const LINE_FLOW_STAGE_STORAGE_KEY = 'yoko.lineFlowStages.v1';
const LINE_FLOW_BLACKLIST_STAGE = '黑名单';
const OLD_DEFAULT_LINE_FLOW_STAGES = ['新客户', '了解中', '信任建立', '重点跟进', '已成交', '暂缓'];
const DEFAULT_LINE_FLOW_STAGES = Array.isArray(LINE_BUSINESS_ENGINE.stages) && LINE_BUSINESS_ENGINE.stages.length
  ? [...LINE_BUSINESS_ENGINE.stages]
  : ['初步认识','熟悉互动','信任建立','重点跟进','长期维护','暂缓'];

function normalizeLineFlowStages(items) {
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const value = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!value) continue;
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value.slice(0, 40));
  }
  return result;
}

function ensureLineBlacklistStage(stages=[]) {
  const clean=normalizeLineFlowStages(stages).filter(stage=>stage!==LINE_FLOW_BLACKLIST_STAGE);
  return [...clean,LINE_FLOW_BLACKLIST_STAGE];
}
function loadLineFlowStages() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LINE_FLOW_STAGE_STORAGE_KEY) || 'null');
    const clean = normalizeLineFlowStages(parsed);
    const oldDefault = normalizeLineFlowStages(OLD_DEFAULT_LINE_FLOW_STAGES);
    if (clean.length) {
      if (JSON.stringify(clean) === JSON.stringify(oldDefault)) {
        const migrated=ensureLineBlacklistStage(DEFAULT_LINE_FLOW_STAGES);
        try { localStorage.setItem(LINE_FLOW_STAGE_STORAGE_KEY, JSON.stringify(migrated)); } catch {}
        return migrated;
      }
      return ensureLineBlacklistStage(clean);
    }
  } catch {}
  return ensureLineBlacklistStage(DEFAULT_LINE_FLOW_STAGES);
}

function lineFlowDefaultStage() {
  return loadLineFlowStages()[0] || '初步认识';
}

function saveLineFlowStages(items) {
  const clean = normalizeLineFlowStages(items);
  const next = ensureLineBlacklistStage(clean.length ? clean : DEFAULT_LINE_FLOW_STAGES);
  localStorage.setItem(LINE_FLOW_STAGE_STORAGE_KEY, JSON.stringify(next));
  refreshLineFlowStageOptions();
  renderLineFlowSettingsList();
  return next;
}

function fillLineFlowStageSelect(node, preferredValue = '') {
  if (!node) return;
  const stages = loadLineFlowStages();
  const wanted = String(preferredValue || node.value || '').trim();
  node.innerHTML = stages.map(stage => `<option value="${escapeHtml(stage)}">${escapeHtml(stage)}</option>`).join('');
  if (wanted && !stages.includes(wanted)) {
    node.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(wanted)}">${escapeHtml(wanted)}（历史阶段）</option>`);
  }
  const next = wanted && Array.from(node.options).some(option => option.value === wanted)
    ? wanted
    : (stages[0] || '初步认识');
  node.value = next;
}

function refreshLineFlowStageOptions(sideValue = '', modalValue = '') {
  fillLineFlowStageSelect($('#crmSideStage'), sideValue || $('#crmSideStage')?.value || '');
  fillLineFlowStageSelect($('#crmStage'), modalValue || $('#crmStage')?.value || '');
}

function renderLineFlowSettingsList() {
  const list = $('#lineFlowStageList');
  if (!list) return;
  const stages = loadLineFlowStages();
  list.innerHTML = stages.map((stage, index) => `
    <div class="line-flow-settings-row" data-flow-stage-index="${index}">
      <span class="line-flow-settings-main"><strong>${index + 1}. ${escapeHtml(stage)}</strong><small>LINE CRM 跟进阶段</small></span>
      <span class="line-flow-settings-actions">
        <button type="button" data-flow-stage-up="${index}" ${index === 0 ? 'disabled' : ''} title="上移">↑</button>
        <button type="button" data-flow-stage-down="${index}" ${index === stages.length - 1 ? 'disabled' : ''} title="下移">↓</button>
        <button type="button" class="danger" data-flow-stage-delete="${index}" ${stages.length <= 1 ? 'disabled' : ''}>删除</button>
      </span>
    </div>`).join('');
}

async function refocusLineFlowStageInput({ select = false } = {}) {
  const input = $('#lineFlowStageInput');
  if (!input) return;
  // Native window.confirm() temporarily owns the Windows keyboard focus. When
  // it closes, an embedded BrowserView/WebContentsView can reclaim focus before
  // Chromium routes keystrokes back to this input. Re-suppress native views and
  // explicitly focus the main renderer, then retry across a few event-loop turns
  // so Chinese/Japanese IME activation is restored without clicking outside Yoko.
  try { await window.yoko.setNativeViewsVisible?.(false); } catch {}
  try { window.focus(); } catch {}
  const apply = () => {
    try { window.focus(); } catch {}
    try {
      input.focus({ preventScroll: true });
      if (select) input.select?.();
      else {
        const len = String(input.value || '').length;
        input.setSelectionRange?.(len, len);
      }
    } catch {}
  };
  requestAnimationFrame(apply);
  setTimeout(apply, 35);
  setTimeout(apply, 110);
  setTimeout(apply, 240);
}

async function openLineFlowSettingsModal() {
  renderLineFlowSettingsList();
  const input = $('#lineFlowStageInput');
  if (input) input.value = '';
  await openModal('lineFlowSettingsModal');
  refocusLineFlowStageInput({ select: true }).catch(() => {});
}

let lineFlowConfirmResolver = null;

async function showLineFlowConfirm({ title = '请确认', message = '', detail = '', confirmText = '确定' } = {}) {
  const titleNode = $('#lineFlowConfirmTitle');
  const messageNode = $('#lineFlowConfirmMessage');
  const detailNode = $('#lineFlowConfirmDetail');
  const okButton = $('#lineFlowConfirmOkBtn');
  if (titleNode) titleNode.textContent = title;
  if (messageNode) messageNode.textContent = message;
  if (detailNode) {
    detailNode.textContent = detail;
    detailNode.style.display = detail ? '' : 'none';
  }
  if (okButton) okButton.textContent = confirmText;

  // Keep confirmation inside the main renderer. Unlike window.confirm(), this
  // never transfers the Windows/IME focus to a native dialog, so the flow-stage
  // input remains immediately usable after confirm/cancel.
  await openModal('lineFlowConfirmModal');
  return new Promise(resolve => {
    lineFlowConfirmResolver = resolve;
    setTimeout(() => okButton?.focus({ preventScroll: true }), 0);
  });
}

async function finishLineFlowConfirm(result) {
  const resolve = lineFlowConfirmResolver;
  if (!resolve) return;
  lineFlowConfirmResolver = null;
  await closeModal('lineFlowConfirmModal');
  await refocusLineFlowStageInput();
  resolve(Boolean(result));
}

// Shared once across TikTok / Facebook / Instagram / WhatsApp / Telegram / Meta Business.
const EXTERNAL_LINE_ID_STORAGE_KEY = 'yoko.externalLineIds.v1';

function loadConfiguredLineIds() {
  try {
    const parsed = JSON.parse(localStorage.getItem(EXTERNAL_LINE_ID_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item, index) => ({
      id: String(item?.id || `lineid-${index}-${Date.now()}`).trim(),
      lineId: String(item?.lineId || '').trim(),
      remark: String(item?.remark || '').trim()
    })).filter(item => item.lineId);
  } catch {
    return [];
  }
}

function saveConfiguredLineIds(items) {
  const clean = (Array.isArray(items) ? items : []).map(item => ({
    id: String(item?.id || '').trim(),
    lineId: String(item?.lineId || '').trim(),
    remark: String(item?.remark || '').trim()
  })).filter(item => item.id && item.lineId);
  localStorage.setItem(EXTERNAL_LINE_ID_STORAGE_KEY, JSON.stringify(clean));
  return clean;
}

function configuredLineIdLabel(item) {
  const lineId = String(item?.lineId || '').trim();
  const remark = String(item?.remark || '').trim();
  return remark ? `${remark} · ${lineId}` : lineId;
}

function renderLineIdSettingsList() {
  const list = $('#lineIdSettingsList');
  if (!list) return;
  const items = loadConfiguredLineIds();
  list.innerHTML = items.length ? items.map(item => `
    <div class="line-id-settings-row" data-line-id-key="${escapeHtml(item.id)}">
      <span class="line-id-settings-main"><strong>${escapeHtml(item.lineId)}</strong><small>${escapeHtml(item.remark || '未设置备注')}</small></span>
      <button type="button" class="danger" data-line-id-delete="${escapeHtml(item.id)}">删除</button>
    </div>`).join('') : '<div class="line-id-settings-empty">还没有设置 LINE ID。请先在上方添加。</div>';
}

async function openLineIdSettingsModal() {
  if ($('#lineIdValueInput')) $('#lineIdValueInput').value = '';
  if ($('#lineIdRemarkInput')) $('#lineIdRemarkInput').value = '';
  renderLineIdSettingsList();
  await openModal('lineIdSettingsModal');
  setTimeout(() => $('#lineIdValueInput')?.focus(), 0);
}

function externalLineAccounts() {
  return Array.isArray(state?.config?.accounts) ? state.config.accounts.filter(account => account?.platform === 'line' || !account?.platform) : [];
}

function refreshExternalTargetLineOptions(selectedId = '', selectedName = '') {
  const select = $('#externalCrmTargetLine');
  if (!select) return;
  const configured = loadConfiguredLineIds();
  const wanted = String(selectedId || '').trim();

  select.innerHTML = '<option value="">请选择 LINE ID</option>' + configured.map(item => {
    const label = configuredLineIdLabel(item);
    return `<option value="${escapeHtml(item.id)}" data-line-id="${escapeHtml(item.lineId)}">${escapeHtml(label)}</option>`;
  }).join('');

  // Backward compatibility: contacts saved before V1.21.9 may point to a real
  // LINE account id. Keep that historical value visible until the operator
  // chooses one of the new configured LINE IDs.
  if (wanted && !configured.some(item => String(item.id) === wanted)) {
    const legacyAccounts = externalLineAccounts();
    const legacy = legacyAccounts.find(account => String(account?.id || '') === wanted);
    const label = String(selectedName || legacy?.displayNameOverride || legacy?.name || wanted || '原 LINE 选择').trim();
    select.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(wanted)}">${escapeHtml(label)}（原选择）</option>`);
  }
  select.value = wanted && Array.from(select.options).some(option => option.value === wanted) ? wanted : '';
}

function externalTagsWithAddedLineTag(rawTags) {
  const tags = String(rawTags || '').split(/[,，、;；/\n]+/).map(x => x.trim()).filter(Boolean);
  if (!tags.some(tag => /^已添加\s*LINE$/i.test(tag) || /^LINE\s*已添加$/i.test(tag))) tags.push('已添加LINE');
  return [...new Set(tags)].join('，');
}

function externalTagsWithoutAddedLineTag(rawTags) {
  const tags = String(rawTags || '').split(/[,，、;；/\n]+/).map(x => x.trim()).filter(Boolean)
    .filter(tag => !/^已添加\s*LINE$/i.test(tag) && !/^LINE\s*已添加$/i.test(tag));
  return [...new Set(tags)].join('，');
}

function externalDuplicateInfoFor(item) {
  if (!item) return { duplicate:false, accounts:[], count:0 };
  if (item.duplicate && Array.isArray(item.duplicateAccounts)) {
    return { duplicate:true, accounts:item.duplicateAccounts.filter(Boolean), count:Number(item.duplicateCount || item.duplicateAccounts.length || 2) };
  }
  const rows = externalAggregateInbox?.conversations || [];
  const handle = String(item.handle || '').replace(/^@/, '').trim().toLowerCase();
  const avatarBase = String(item.avatarUrl || '').split('?')[0].trim().toLowerCase();
  const displayName = String(item.displayName || '').trim().toLowerCase();
  const matched = rows.filter(row => {
    const rowHandle = String(row?.handle || '').replace(/^@/, '').trim().toLowerCase();
    if (handle && rowHandle) return handle === rowHandle;
    if (!handle && !rowHandle && avatarBase && displayName) {
      return String(row?.avatarUrl || '').split('?')[0].trim().toLowerCase() === avatarBase && String(row?.displayName || '').trim().toLowerCase() === displayName;
    }
    return false;
  });
  const accounts = [...new Set(matched.map(row => String(row.accountName || '').trim()).filter(Boolean))];
  const accountIds = [...new Set(matched.map(row => String(row.accountId || '').trim()).filter(Boolean))];
  return { duplicate:accountIds.length > 1, accounts, count:accountIds.length };
}

function externalStageUsesTargetLine(stage = '') {
  return ['准备引导LINE','已邀请LINE','LINE已添加'].includes(normalizeExternalCrmStage(stage));
}

function externalCrmFormSnapshot() {
  const lineSelect = $('#externalCrmTargetLine');
  const selectedOption = lineSelect?.selectedOptions?.[0];
  return {
    stage: normalizeExternalCrmStage($('#externalCrmStage')?.value || '新进线'),
    tags: String($('#externalCrmTags')?.value || ''),
    region: String($('#externalCrmRegion')?.value || ''),
    targetLineAccountId: String(lineSelect?.value || ''),
    targetLineAccountName: lineSelect?.value ? String(selectedOption?.textContent || '').replace(/（当前未加载）$/, '').trim() : ''
  };
}


function crmMemoryRows(contact = {}) {
  const items = Array.isArray(contact?.memoryItems) ? contact.memoryItems : [];
  return items.slice(-20).map(item => ({
    label:String(item?.label || '记忆').trim(),
    text:String(item?.text || '').trim()
  })).filter(item => item.text);
}

function renderCrmMemory(contact = {}, target = 'external') {
  const rows = crmMemoryRows(contact);
  const toggle = target === 'line' ? $('#crmSideMemoryToggle') : $('#externalCrmMemoryToggle');
  const panel = target === 'line' ? $('#crmSideMemoryPanel') : $('#externalCrmMemoryPanel');
  const list = target === 'line' ? $('#crmSideMemoryList') : $('#externalCrmMemoryList');
  if (toggle) toggle.textContent = `长期记忆 ${rows.length}`;
  if (list) list.innerHTML = rows.length
    ? rows.slice().reverse().map(item => `<span class="crm-memory-item"><b>${escapeHtml(item.label)}</b>：${escapeHtml(item.text)}</span>`).join('')
    : '暂无长期记忆';
  if (!rows.length) panel?.classList.add('hidden');
}

function externalManualStageLinePreview(stage = '') {
  const normalized = normalizeExternalCrmStage(stage || '新进线');
  const map = {
    '新进线': { lineIntent:'none', lineIntentScore:0, lineProgress:'not_started', lineEvidence:'跟进阶段：新进线' },
    '已接待': { lineIntent:'none', lineIntentScore:20, lineProgress:'not_started', lineEvidence:'跟进阶段：已接待' },
    '有效聊天': { lineIntent:'positive', lineIntentScore:55, lineProgress:'interested', lineEvidence:'跟进阶段：有效聊天' },
    '准备引导LINE': { lineIntent:'positive', lineIntentScore:70, lineProgress:'interested', lineEvidence:'跟进阶段：准备引导LINE' },
    '已邀请LINE': { lineIntent:'high', lineIntentScore:90, lineProgress:'waiting_add', lineEvidence:'跟进阶段：已邀请LINE' },
    'LINE已添加': { lineIntent:'high', lineIntentScore:100, lineProgress:'added', lineEvidence:'跟进阶段：LINE已添加' },
    '无效/暂停': { lineIntent:'paused', lineIntentScore:0, lineProgress:'paused', lineEvidence:'跟进阶段：无效/暂停' }
  };
  return map[normalized] || null;
}

function renderExternalCrmIntelligence(contact = {}) {
  const badge = $('#externalCrmLineIntentBadge');
  if (badge) {
    const intent = String(contact?.lineIntent || 'none');
    const progress = String(contact?.lineProgress || 'not_started');
    const intentLabel = String(contact?.lineIntentLabel || ({none:'暂无',positive:'有意向',high:'高意向',negative:'暂不使用',paused:'已暂停'}[intent] || '暂无'));
    const progressLabel = String(contact?.lineProgressLabel || ({not_started:'未开始',interested:'发现意向',waiting_add:'已邀请/等待添加',added:'已添加',declined:'暂不使用LINE',paused:'暂停跟进'}[progress] || '未开始'));
    badge.textContent = `LINE意向：${intentLabel} · ${progressLabel}`;
    badge.className = 'crm-intelligence-badge ' + (progress === 'paused' ? 'neutral' : (progress === 'added' ? 'added' : (intent === 'high' ? 'high' : (intent === 'positive' ? 'positive' : (intent === 'negative' ? 'negative' : 'neutral')))));
    badge.title = String(contact?.lineEvidence || '').trim() || badge.textContent;
  }
  renderCrmMemory(contact, 'external');
}

function renderExternalCrmSummary(contact = {}, item = externalAggregateCrmContext) {
  const node = $('#externalCrmSummary');
  const box = node?.closest?.('.external-crm-summary');
  if (!node || !box) return;
  const stage = normalizeExternalCrmStage(contact.stage || $('#externalCrmStage')?.value || '新进线');
  const duplicate = externalDuplicateInfoFor(item);
  const targetLineName = String(contact.targetLineAccountName || '').trim();
  const targetLineId = String(contact.targetLineAccountId || '').trim();
  const bits = [];
  if (duplicate.duplicate) bits.push(`⚠ 重复客户：同时出现在 ${duplicate.accounts.join(' / ') || `${duplicate.count} 个账号`}`);
  const autoSummary = String(contact.summary || '').trim();
  if (autoSummary) {
    bits.push(autoSummary);
    if (externalStageUsesTargetLine(stage) && (targetLineName || targetLineId)) bits.push(`目标LINE：${targetLineName || targetLineId}`);
  } else {
    if (stage === 'LINE已添加') bits.push(`已添加LINE${targetLineName || targetLineId ? ` → ${targetLineName || targetLineId}` : ''}`);
    else {
      bits.push(`阶段：${stage}`);
      if (externalStageUsesTargetLine(stage) && (targetLineName || targetLineId)) bits.push(`目标LINE：${targetLineName || targetLineId}`);
    }
    if (contact.region) bits.push(String(contact.region));
    const tags = String(contact.tags || '').split(/[,，/]/).map(x=>x.trim()).filter(Boolean).filter(tag => tag !== '已添加LINE').slice(0,2);
    if (tags.length) bits.push(tags.join(' / '));
  }
  node.textContent = bits.join(' · ');
  box.classList.toggle('duplicate', duplicate.duplicate);
  box.classList.toggle('line-added', stage === 'LINE已添加');
}

function updateExternalLineStageUi({ autoTag = false, renderSummary = true } = {}) {
  const stageNode = $('#externalCrmStage');
  if (!stageNode) return;
  const stage = normalizeExternalCrmStage(stageNode.value || '新进线');
  if (stageNode.value !== stage) stageNode.value = stage;
  const added = stage === 'LINE已添加';
  const targetLineRelevant = externalStageUsesTargetLine(stage);
  $('#externalCrmTargetLineWrap')?.classList.toggle('hidden', !targetLineRelevant);
  if (autoTag && $('#externalCrmTags')) {
    $('#externalCrmTags').value = added
      ? externalTagsWithAddedLineTag($('#externalCrmTags').value)
      : externalTagsWithoutAddedLineTag($('#externalCrmTags').value);
  }
  if (!targetLineRelevant && autoTag) refreshExternalTargetLineOptions('', '');
  renderExternalBusinessEngineHint(stage);
  if (renderSummary) {
    const snap = externalCrmFormSnapshot();
    renderExternalCrmSummary({ ...snap, stage, tags:snap.tags }, externalAggregateCrmContext);
  }
}

function resetExternalCrmPanel(platformOverride = '') {
  ensureExternalCrmStageOptions();
  const resetPlatform = String(platformOverride || activeExternalPlatform || '').trim();
  externalAggregateCrmContext = null;
  if ($('#externalCrmDisplayName')) $('#externalCrmDisplayName').textContent = '客户资料';
  if ($('#externalCrmIdentity')) $('#externalCrmIdentity').textContent = externalGlobalAggregateActive ? '请选择一个非 LINE 客户' : `请选择一个 ${appCenterPlatformById(resetPlatform)?.name || '客户'} 对话`;
  if ($('#externalCrmAccount')) $('#externalCrmAccount').textContent = '-';
  if ($('#externalCrmAvatar')) $('#externalCrmAvatar').innerHTML = '<span>?</span>';
  if ($('#externalCrmHeadState')) $('#externalCrmHeadState').textContent = '等待选择';
  if ($('#externalCrmSummary')) $('#externalCrmSummary').textContent = '选择客户后立即显示本地资料';
  renderExternalCrmIntelligence({});
  $('#externalCrmMemoryPanel')?.classList.add('hidden');
  renderExternalBusinessEngineHint(loadExternalFlowStages()[0] || '新进线');
  $('#externalCrmSummary')?.closest?.('.external-crm-summary')?.classList.remove('duplicate','line-added');
  for (const id of ['externalCrmTimelineFirst','externalCrmTimelineIncoming','externalCrmTimelineReply','externalCrmTimelineOpened']) if ($('#'+id)) $('#'+id).textContent = '—';
  for (const id of ['externalCrmName','externalCrmTags','externalCrmRegion','externalCrmAge','externalCrmInterests','externalCrmOccupation','externalCrmNote']) if ($('#'+id)) $('#'+id).value = '';
  setExternalSelectValue('#externalCrmStage', loadExternalFlowStages()[0] || '新进线', loadExternalFlowStages()[0] || '新进线');
  setExternalSelectValue('#externalCrmServiceStatus', 'auto', 'auto');
  refreshExternalTargetLineOptions('', '');
  $('#externalCrmTargetLineWrap')?.classList.add('hidden');
  $('#externalCrmExtractWrap')?.classList.add('hidden');
  if ($('#externalCrmExtractPreview')) $('#externalCrmExtractPreview').value = '';
  if ($('#externalCrmExtractStatus')) $('#externalCrmExtractStatus').textContent = '已生成文本，可直接复制使用';
  if ($('#externalCrmSaveStatus')) $('#externalCrmSaveStatus').textContent = externalGlobalAggregateActive ? '选择左侧客户后编辑' : `选择当前 ${appCenterPlatformById(resetPlatform)?.name || ''} 客户后编辑`;
}

async function hydrateExternalCrmPanel(item, prefetched = null) {
  ensureExternalCrmStageOptions();
  const hydrationSequence = ++externalAggregateCrmHydrationSequence;
  if (!item) { resetExternalCrmPanel(); return; }
  const contextKey = externalAggregateKey(item);
  const previousKey = externalAggregateCrmContext ? externalAggregateKey(externalAggregateCrmContext) : '';
  if (previousKey && previousKey !== contextKey && externalCrmAutoSaveTimer) {
    clearTimeout(externalCrmAutoSaveTimer);
    externalCrmAutoSaveTimer = null;
    await saveExternalCrmPanel().catch(() => {});
  }
  // A newer explicit click may arrive while the previous customer's pending CRM
  // autosave is being flushed. Never let that older hydration re-claim the panel.
  if (hydrationSequence !== externalAggregateCrmHydrationSequence) return;
  externalAggregateCrmHydrating = true;
  externalAggregateCrmContext = item;
  $('#externalCrmExtractWrap')?.classList.add('hidden');
  if ($('#externalCrmExtractPreview')) $('#externalCrmExtractPreview').value = '';
  const handle = String(item.handle || prefetched?.handle || '').replace(/^@/, '');
  if ($('#externalCrmDisplayName')) $('#externalCrmDisplayName').textContent = item.displayName || prefetched?.displayName || '未命名客户';
  if ($('#externalCrmIdentity')) $('#externalCrmIdentity').textContent = handle ? `@${handle}` : `${appCenterPlatformById(item.platform || activeExternalPlatform)?.name || '平台'} 客户`;
  if ($('#externalCrmAccount')) $('#externalCrmAccount').textContent = item.accountName || prefetched?.accountName || appCenterPlatformById(item.platform || activeExternalPlatform)?.short || '-';
  const avatarUrl = String(item.avatarUrl || prefetched?.avatarUrl || '').trim();
  if ($('#externalCrmAvatar')) $('#externalCrmAvatar').innerHTML = avatarUrl
    ? `<img src="${escapeHtml(avatarUrl)}" alt="" referrerpolicy="no-referrer" />`
    : `<span>${escapeHtml(String(item.displayName || prefetched?.displayName || '?').slice(0,1))}</span>`;
  if ($('#externalCrmHeadState')) $('#externalCrmHeadState').textContent = '已同步';
  maybeShowPendingExternalCrmAutoExtractToast(item);
  try {
    // A native-selection event is only an identity hint. It is a usable CRM
    // prefetch only when it actually contains `contact`; otherwise fetch the
    // selected customer's persisted CRM instead of reusing stale right-panel data.
    const hasPrefetchedContact = !!prefetched?.ok && Object.prototype.hasOwnProperty.call(prefetched || {}, 'contact');
    const result = hasPrefetchedContact ? prefetched : await window.yoko.getPlatformCrmContact?.({
      platform:item.platform || 'tiktok', accountId:item.accountId, chatId:item.chatId, displayName:item.displayName
    });
    if (hydrationSequence !== externalAggregateCrmHydrationSequence) return;
    if (!externalAggregateCrmContext || externalAggregateKey(externalAggregateCrmContext) !== contextKey) return;
    const c = result?.contact || item.crm || {};
    item.crm = c;
    if (externalAggregateCrmContext) externalAggregateCrmContext.crm = c;
    if ($('#externalCrmName')) $('#externalCrmName').value = c.name || '';
    const normalizedStage = normalizeExternalCrmStage(c.stage || loadExternalFlowStages()[0] || '新进线');
    ensureExternalCrmStageOptions(normalizedStage);
    setExternalSelectValue('#externalCrmStage', normalizedStage, loadExternalFlowStages()[0] || '新进线');
    setExternalSelectValue('#externalCrmServiceStatus', c.serviceStatus || 'auto', 'auto');
    const hydratedTags = normalizedStage === 'LINE已添加'
      ? externalTagsWithAddedLineTag(c.tags || '')
      : externalTagsWithoutAddedLineTag(c.tags || '');
    if ($('#externalCrmTags')) $('#externalCrmTags').value = hydratedTags;
    refreshExternalTargetLineOptions(c.targetLineAccountId || '', c.targetLineAccountName || '');
    updateExternalLineStageUi({ autoTag:false, renderSummary:false });
    if ($('#externalCrmRegion')) $('#externalCrmRegion').value = c.region || '';
    if ($('#externalCrmAge')) $('#externalCrmAge').value = c.age || '';
    if ($('#externalCrmInterests')) $('#externalCrmInterests').value = c.interests || '';
    if ($('#externalCrmOccupation')) $('#externalCrmOccupation').value = c.occupation || '';
    if ($('#externalCrmNote')) $('#externalCrmNote').value = c.note || '';
    renderExternalCrmIntelligence(c);
    renderExternalCrmSummary({ ...c, stage:normalizedStage, tags:hydratedTags }, item);
    if ($('#externalCrmTimelineFirst')) $('#externalCrmTimelineFirst').textContent = externalCrmTimelineLabel(result?.firstContactAt || c.createdAt || item.capturedAt);
    if ($('#externalCrmTimelineIncoming')) $('#externalCrmTimelineIncoming').textContent = externalCrmTimelineLabel(result?.lastIncomingAt || item.lastMessageAt);
    if ($('#externalCrmTimelineReply')) $('#externalCrmTimelineReply').textContent = externalCrmTimelineLabel(result?.lastReplyAt || c.lastReplyAt);
    if ($('#externalCrmTimelineOpened')) $('#externalCrmTimelineOpened').textContent = externalCrmTimelineLabel(result?.lastOpenedAt || c.lastOpenedAt);
    if ($('#externalCrmSaveStatus')) $('#externalCrmSaveStatus').textContent = '客户资料已同步';
  } catch (error) {
    if ($('#externalCrmHeadState')) $('#externalCrmHeadState').textContent = '同步失败';
    if ($('#externalCrmSaveStatus')) $('#externalCrmSaveStatus').textContent = '读取失败：' + (error?.message || error);
  } finally {
    if (hydrationSequence === externalAggregateCrmHydrationSequence) externalAggregateCrmHydrating = false;
  }
}

const EXTERNAL_CRM_SERVICE_STATUS_LABELS = {
  auto:'自动判断', waiting:'待回复', active:'跟进中', done:'已完成', paused:'暂停', blacklist:'黑名单'
};

function crmAutoExtractToastLines(payload = {}) {
  const changes = Array.isArray(payload?.changes) ? payload.changes : [];
  const lines = [];
  for (const change of changes) {
    const field = String(change?.field || '');
    if (field === 'interests') {
      const added = Array.isArray(change?.added) ? change.added.map(v => String(v || '').trim()).filter(Boolean) : [];
      const value = added.join('、') || String(change?.after || '').trim();
      if (value) lines.push(`新增兴趣：${value}`);
      continue;
    }
    if (field === 'stage') {
      const after = String(change?.after || '').trim();
      if (after) lines.push(`自动推进阶段：${after}`);
      continue;
    }
    if (field === 'lineProgress') {
      const after = String(change?.after || '').trim();
      const intent = String(change?.intent || '').trim();
      if (after) lines.push(`LINE识别：${intent ? `${intent} · ` : ''}${after}`);
      continue;
    }
    if (field === 'memory') {
      const added = Array.isArray(change?.added) ? change.added.map(v => String(v || '').trim()).filter(Boolean) : [];
      if (added.length) lines.push(`新增记忆：${added.slice(0,2).join('；')}`);
      continue;
    }
    const label = String(change?.label || ({name:'姓名',region:'地区',age:'年龄',occupation:'工作'}[field] || '资料'));
    const after = String(change?.after || '').trim();
    if (!after) continue;
    lines.push(`${change?.kind === 'updated' ? '自动更新' : '自动采集'}${label}：${after}`);
  }
  if (!lines.length) {
    const facts = payload?.facts || {};
    if (facts.name) lines.push(`自动采集姓名：${facts.name}`);
    if (facts.region) lines.push(`自动采集地区：${facts.region}`);
    if (facts.age) lines.push(`自动采集年龄：${facts.age}`);
    if (facts.occupation) lines.push(`自动采集工作：${facts.occupation}`);
    if (Array.isArray(facts.interests) && facts.interests.length) lines.push(`新增兴趣：${facts.interests.join('、')}`);
  }
  return lines.slice(0, 5);
}

function crmAutoExtractCustomerMatches(item = {}, payload = {}) {
  const itemPlatform = String(item?.platform || activeExternalPlatform || '').trim().toLowerCase();
  const payloadPlatform = String(payload?.platform || 'line').trim().toLowerCase();
  if (itemPlatform && payloadPlatform && itemPlatform !== payloadPlatform) return false;

  const itemAccount = String(item?.accountId || '').trim();
  const payloadAccount = String(payload?.accountId || '').trim();
  if (itemAccount && payloadAccount && itemAccount !== payloadAccount) return false;

  const itemChat = String(item?.chatId || '').trim();
  const payloadChat = String(payload?.chatId || '').trim();
  if (itemChat && payloadChat && itemChat === payloadChat) return true;

  const itemHandle = String(item?.handle || '').replace(/^@/, '').trim().toLowerCase();
  const payloadHandle = String(payload?.handle || '').replace(/^@/, '').trim().toLowerCase();
  if (itemHandle && payloadHandle && itemHandle === payloadHandle) return true;

  const itemDisplay = String(item?.displayName || '').trim().toLowerCase();
  const payloadDisplay = String(payload?.displayName || '').trim().toLowerCase();
  if (itemDisplay && payloadDisplay && itemDisplay === payloadDisplay) return true;

  // V1.24.3: never fall back to account-only matching when BOTH sides name a
  // concrete customer. That could apply a conversion event from customer A to
  // customer B merely because both belong to TK-1. Only a genuinely identity-
  // less payload may use the current concrete panel as a temporary hydration
  // fallback.
  const itemConcrete = !!(itemChat || itemHandle || itemDisplay);
  const payloadConcrete = !!(payloadChat || payloadHandle || payloadDisplay);
  if (itemConcrete && payloadConcrete) return false;
  return Boolean(itemConcrete && !payloadConcrete && (itemAccount || payloadAccount));
}

function positionCrmAutoExtractToast(node, target = 'external') {
  if (!node) return;
  const panel = target === 'line'
    ? ($('#aggregateCrmPanel') || node.closest?.('.aggregate-crm-panel'))
    : ($('#externalCrmPanel') || node.closest?.('.external-crm-panel'));
  const rect = panel?.getBoundingClientRect?.();
  if (!rect || rect.width <= 0 || rect.height <= 0) return;
  const inset = target === 'line' ? 12 : 10;
  const topInset = target === 'line' ? 58 : 62;
  node.style.setProperty('--crm-toast-left', `${Math.round(rect.left + inset)}px`);
  node.style.setProperty('--crm-toast-top', `${Math.round(rect.top + topInset)}px`);
  node.style.setProperty('--crm-toast-width', `${Math.max(180, Math.round(rect.width - inset * 2))}px`);
}

function showCrmAutoExtractToast(payload = {}, target = 'external') {
  const node = target === 'line' ? $('#crmSideAutoExtractToast') : $('#externalCrmAutoExtractToast');
  if (!node) return false;
  const lines = crmAutoExtractToastLines(payload);
  if (!lines.length) return false;

  positionCrmAutoExtractToast(node, target);
  node.innerHTML = `<strong>✓ CRM 自动采集成功</strong>${lines.map(line => `<span>${escapeHtml(line)}</span>`).join('')}`;
  node.classList.remove('show');
  // Force a new transition even when two profile facts are extracted back to back.
  void node.offsetWidth;
  node.classList.add('show');
  if (node._yokoHideTimer) clearTimeout(node._yokoHideTimer);
  node._yokoHideTimer = setTimeout(() => {
    node.classList.remove('show');
    node._yokoHideTimer = null;
  }, 4600);
  return true;
}

function queueExternalCrmAutoExtractToast(payload = {}) {
  pendingExternalCrmAutoExtractToast = {
    payload: { ...payload },
    createdAt: Date.now()
  };
  setTimeout(() => {
    if (pendingExternalCrmAutoExtractToast && Date.now() - pendingExternalCrmAutoExtractToast.createdAt > 7000) {
      pendingExternalCrmAutoExtractToast = null;
    }
  }, 7200);
}

function maybeShowPendingExternalCrmAutoExtractToast(item = externalAggregateCrmContext) {
  const pending = pendingExternalCrmAutoExtractToast;
  if (!pending?.payload || Date.now() - pending.createdAt > 7000) {
    if (pendingExternalCrmAutoExtractToast) pendingExternalCrmAutoExtractToast = null;
    return false;
  }
  if (!crmAutoExtractCustomerMatches(item || {}, pending.payload)) return false;
  pendingExternalCrmAutoExtractToast = null;
  return showCrmAutoExtractToast(pending.payload, 'external');
}

function externalCrmSelectedTargetLineText() {
  const select = $('#externalCrmTargetLine');
  if (!select?.value) return '';
  const option = select.selectedOptions?.[0];
  const lineId = String(option?.dataset?.lineId || '').trim();
  const label = String(option?.textContent || '').replace(/（当前未加载）$/, '').trim();
  if (lineId && label && !label.includes(lineId)) return `${label}（${lineId}）`;
  return label || lineId || String(select.value || '');
}

function buildExternalCrmExtractText() {
  const item = externalAggregateCrmContext || {};
  const displayName = String(item.displayName || $('#externalCrmDisplayName')?.textContent || '').trim();
  const handle = String(item.handle || $('#externalCrmIdentity')?.textContent || '').replace(/^@/, '').trim();
  const sourceAccount = String(item.accountName || $('#externalCrmAccount')?.textContent || '').trim();
  const serviceValue = String($('#externalCrmServiceStatus')?.value || 'auto');
  const stage = normalizeExternalCrmStage($('#externalCrmStage')?.value || '新进线');
  const targetLine = externalCrmSelectedTargetLineText();
  const rows = [
    ['客户昵称', displayName],
    ['平台账号', handle ? `@${handle}` : ''],
    ['来源账号', sourceAccount],
    ['姓名', String($('#externalCrmName')?.value || '').trim()],
    ['年龄', String($('#externalCrmAge')?.value || '').trim()],
    ['地区', String($('#externalCrmRegion')?.value || '').trim()],
    ['工作', String($('#externalCrmOccupation')?.value || '').trim()],
    ['兴趣爱好', String($('#externalCrmInterests')?.value || '').trim()],
    ['标签', String($('#externalCrmTags')?.value || '').trim()],
    ['备注', String($('#externalCrmNote')?.value || '').trim()],
    ['处理状态', EXTERNAL_CRM_SERVICE_STATUS_LABELS[serviceValue] || serviceValue],
    ['跟进阶段', stage],
    ['LINE意向', String(item?.crm?.lineIntentLabel || item?.crm?.lineIntent || '').trim()],
    ['LINE进度', String(item?.crm?.lineProgressLabel || item?.crm?.lineProgress || '').trim()],
    ['长期记忆', String(item?.crm?.memorySummary || '').trim()],
    ['目标LINE', targetLine]
  ];
  return rows.map(([label, value]) => `${label}：${value || '—'}`).join('\n');
}

async function copyTextWithFallback(text) {
  const value = String(text || '');
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {}
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return !!ok;
  } catch {
    return false;
  }
}

async function extractExternalCrmText() {
  if (!externalAggregateCrmContext) {
    if ($('#externalCrmSaveStatus')) $('#externalCrmSaveStatus').textContent = '请先选择客户';
    return;
  }
  const item = externalAggregateCrmContext;
  if ($('#externalCrmSaveStatus')) $('#externalCrmSaveStatus').textContent = '正在回溯历史聊天…';
  try {
    const backfill = await window.yoko.savePlatformCrmContact?.({
      _action:'backfill-history', platform:String(item.platform || activeExternalPlatform || ''),
      accountId:String(item.accountId || ''), chatId:String(item.chatId || ''),
      displayName:String(item.displayName || ''), handle:String(item.handle || '')
    });
    if (backfill?.ok) {
      await hydrateExternalCrmPanel(item, { force:true }).catch(() => {});
      setExternalStatus(`已回溯 ${Number(backfill.scanned || 0)} 条历史聊天并更新客户资料`);
    }
  } catch (error) {
    setExternalStatus('历史聊天回溯失败：' + (error?.message || error));
  }
  const text = buildExternalCrmExtractText();
  if ($('#externalCrmExtractPreview')) $('#externalCrmExtractPreview').value = text;
  $('#externalCrmExtractWrap')?.classList.remove('hidden');
  const copied = await copyTextWithFallback(text);
  if ($('#externalCrmExtractStatus')) $('#externalCrmExtractStatus').textContent = copied
    ? '客户资料已提取并复制到剪贴板'
    : '客户资料已提取；请在上方文本框手动复制';
  if ($('#externalCrmSaveStatus')) $('#externalCrmSaveStatus').textContent = copied ? '客户资料已复制' : '客户资料已生成';
}

async function saveExternalCrmPanel() {
  ensureExternalCrmStageOptions();
  const item = externalAggregateCrmContext;
  if (!item || externalAggregateCrmHydrating) return;
  try {
    if ($('#externalCrmSaveStatus')) $('#externalCrmSaveStatus').textContent = '保存中…';
    if ($('#externalCrmHeadState')) $('#externalCrmHeadState').textContent = '保存中';
    const saved = await window.yoko.savePlatformCrmContact?.({
      platform:item.platform || 'tiktok', accountId:item.accountId, chatId:item.chatId, displayName:item.displayName,
      name:String($('#externalCrmName')?.value || ''), stage:normalizeExternalCrmStage($('#externalCrmStage')?.value || '新进线'),
      serviceStatus:String($('#externalCrmServiceStatus')?.value || 'auto'), tags:String($('#externalCrmTags')?.value || ''),
      region:String($('#externalCrmRegion')?.value || ''), age:String($('#externalCrmAge')?.value || ''),
      interests:String($('#externalCrmInterests')?.value || ''), occupation:String($('#externalCrmOccupation')?.value || ''),
      targetLineAccountId:String($('#externalCrmTargetLine')?.value || ''),
      targetLineAccountName:$('#externalCrmTargetLine')?.value ? String($('#externalCrmTargetLine')?.selectedOptions?.[0]?.textContent || '').replace(/（当前未加载）$/, '').trim() : '',
      note:String($('#externalCrmNote')?.value || '')
    });
    item.crm = saved || item.crm;
    if (externalGlobalAggregateActive) {
      const sourceInbox = externalGlobalPlatformInboxes.get(String(item.platform || ''));
      const sourceItem = (sourceInbox?.conversations || []).find(row =>
        String(row.accountId || '') === String(item.accountId || '') &&
        String(row.chatId || row.displayName || '') === String(item.chatId || item.displayName || '')
      );
      if (sourceItem) sourceItem.crm = saved || sourceItem.crm;
      combineExternalGlobalAggregateInbox();
      const refreshed = (externalAggregateInbox.conversations || []).find(row => externalAggregateKey(row) === externalAggregateSelectedKey);
      if (refreshed) { externalAggregateSelected = refreshed; externalAggregateCrmContext = refreshed; }
    }
    if ($('#externalCrmSaveStatus')) $('#externalCrmSaveStatus').textContent = '已保存';
    if ($('#externalCrmHeadState')) $('#externalCrmHeadState').textContent = '已保存';
    renderExternalCrmSummary(saved || externalCrmFormSnapshot(), externalAggregateCrmContext || item);
    renderExternalAggregateCustomers();
    renderExternalCustomerStats();
  } catch (error) {
    if ($('#externalCrmHeadState')) $('#externalCrmHeadState').textContent = '保存失败';
    if ($('#externalCrmSaveStatus')) $('#externalCrmSaveStatus').textContent = '保存失败：' + (error?.message || error);
  }
}


function externalCrmItemFromCurrentTikTok(data) {
  const rows = externalAggregateInbox?.conversations || [];
  const handle = String(data?.handle || '').replace(/^@/, '');
  const platform = String(data?.platform || activeExternalPlatform || 'tiktok');
  let cached = null;
  if (platform === 'metabusiness') {
    const wantedChatId=String(data?.chatId || '');
    const wantedName=String(data?.displayName || '');
    const exactStrong=wantedChatId && /^mb-thread:/i.test(wantedChatId)
      ? rows.find(item => String(item?.accountId || '') === String(data?.accountId || '') && String(item?.chatId || '') === wantedChatId)
      : null;
    // A strong token that currently points at another name is evidence of the
    // Meta transition/cross-binding bug, not permission to steal that row.
    if (exactStrong && (!wantedName || String(exactStrong?.displayName || '') === wantedName)) cached=exactStrong;
    if (!cached && wantedName) {
      cached=rows.find(item => String(item?.accountId || '') === String(data?.accountId || '') && String(item?.displayName || '') === wantedName && !/^mb-thread:/i.test(String(item?.chatId || '')))
        || rows.find(item => String(item?.accountId || '') === String(data?.accountId || '') && String(item?.displayName || '') === wantedName)
        || null;
    }
    if (!cached && handle) cached=rows.find(item => String(item?.accountId || '') === String(data?.accountId || '') && String(item?.handle || '').replace(/^@/,'') === handle) || null;
  } else {
    cached = rows.find(item =>
      String(item?.accountId || '') === String(data?.accountId || '') && (
        (data?.chatId && String(item?.chatId || '') === String(data.chatId)) ||
        (handle && String(item?.handle || '').replace(/^@/, '') === handle) ||
        String(item?.displayName || '') === String(data?.displayName || '')
      )
    ) || null;
  }
  const platformDef = appCenterPlatformById(platform);
  return {
    ...(cached || {}),
    platform,
    accountId:data?.accountId || cached?.accountId || activeExternalAccountId || '',
    accountName:data?.accountName || cached?.accountName || externalAccountById(data?.accountId)?.name || platformDef?.short || platform.toUpperCase(),
    // For MB, once a cached aggregate row is found its identity is authoritative;
    // background CRM polling cannot rewrite the card to a transient strong id.
    chatId:platform === 'metabusiness' && cached ? (cached.chatId || `name:${String(cached.displayName || data?.displayName || '')}`) : (data?.chatId || cached?.chatId || `name:${String(data?.displayName || '')}`),
    displayName:platform === 'metabusiness' && cached ? (cached.displayName || data?.displayName || '未命名客户') : (data?.displayName || cached?.displayName || '未命名客户'),
    handle:handle || cached?.handle || '',
    avatarUrl:data?.avatarUrl || cached?.avatarUrl || '',
    preview:data?.preview || cached?.preview || '',
    lastMessageAt:data?.lastMessageAt || cached?.lastMessageAt || '',
    capturedAt:data?.firstContactAt || cached?.capturedAt || '',
    duplicate:!!(data?.duplicate || cached?.duplicate),
    duplicateCount:Number(data?.duplicateCount || cached?.duplicateCount || 0),
    duplicateAccounts:Array.isArray(data?.duplicateAccounts) ? data.duplicateAccounts : (cached?.duplicateAccounts || []),
    crm:data?.contact || cached?.crm || null
  };
}

function externalCrmContactRevision(contact = {}) {
  const c = contact && typeof contact === 'object' ? contact : {};
  return JSON.stringify([
    String(c.updatedAt || ''), String(c.stage || ''), String(c.lineProgress || ''),
    String(c.lineIntent || ''), Number(c.lineIntentScore || 0) || 0,
    String(c.tags || ''), String(c.summary || ''), String(c.name || ''),
    String(c.region || ''), String(c.age || ''), String(c.occupation || ''),
    String(c.interests || ''), String(c.note || ''), String(c.targetLineAccountId || ''),
    String(c.targetLineAccountName || ''), String(c.serviceStatus || '')
  ]);
}

function externalCrmFormIsBeingEdited() {
  const focusedId = String(document.activeElement?.id || '');
  return /^(?:externalCrm)(?:Name|Region|Age|Interests|Occupation|Tags|Note|Stage|TargetLine|ServiceStatus)$/.test(focusedId)
    || !!externalCrmAutoSaveTimer;
}

async function syncExternalTikTokCrmPanel({ force = false } = {}) {
  if (shellSurface !== 'external' || !externalPlatformHasCrm(activeExternalPlatform) || !activeExternalAccountId || externalTikTokCrmSyncInFlight) return;
  externalTikTokCrmSyncInFlight = true;
  try {
    const platform = activeExternalPlatform;
    const data = await window.yoko.getCurrentPlatformChatCrm?.(platform, activeExternalAccountId);
    try {
      window.yoko.traceConversionDiagnostic?.({ event:'crm-sync-response', data:{
        platform, accountId:activeExternalAccountId,
        ok:!!data?.ok, chatId:data?.chatId || '', displayName:data?.displayName || '', handle:data?.handle || '', contactKey:data?.contactKey || '',
        incoming:{ stage:data?.contact?.stage || '', lineProgress:data?.contact?.lineProgress || '', lineIntent:data?.contact?.lineIntent || '', tags:data?.contact?.tags || '' },
        current:externalAggregateCrmContext ? { key:externalAggregateKey(externalAggregateCrmContext), stage:externalAggregateCrmContext?.crm?.stage || '', lineProgress:externalAggregateCrmContext?.crm?.lineProgress || '' } : null
      }});
    } catch {}
    if (shellSurface !== 'external' || activeExternalPlatform !== platform) return;
    if (!data?.ok || (!data?.chatId && !data?.displayName)) {
      externalTikTokCrmMissCount += 1;
      const sticky = externalAggregateCrmContext || externalTikTokCrmLastGoodItem || externalAggregateSelected;
      const stickySameAccount = !!sticky && String(sticky.accountId || '') === String(activeExternalAccountId || '') && String(sticky.platform || platform) === String(platform);
      const recentlyConfirmed = externalTikTokCrmLastSuccessAt > 0 && (Date.now() - externalTikTokCrmLastSuccessAt) < 30000;
      // A forced sync commonly runs exactly while TikTok is rebuilding the chat
      // header. Never turn that single miss into "请选择一个 TikTok 对话".
      if (stickySameAccount && (recentlyConfirmed || externalTikTokCrmMissCount < 12)) {
        if (!externalAggregateCrmContext) await hydrateExternalCrmPanel(sticky).catch(() => {});
        if ($('#externalCrmHeadState')) $('#externalCrmHeadState').textContent = '已同步';
        return;
      }
      // Hotfix5: never destroy a confirmed TikTok CRM binding merely because
      // TikTok rebuilt its virtual header for a few polling cycles. Native click
      // signals + the next successful header read will replace the sticky item.
      // A destructive reset here caused the exact 'middle chat selected, CRM
      // blank forever' failure seen in real use.
      if (stickySameAccount) {
        externalTikTokCrmLastKey = '';
        if (!externalAggregateCrmContext) await hydrateExternalCrmPanel(sticky).catch(() => {});
        if ($('#externalCrmHeadState')) $('#externalCrmHeadState').textContent = '重新识别中…';
        return;
      }
      if (!externalGlobalAggregateActive && externalTikTokCrmMissCount >= 12 && externalWorkspaceModeFor(platform) === 'native' && !data?.chatVisible) {
        resetExternalCrmPanel();
      }
      return;
    }
    externalTikTokCrmMissCount = 0;
    externalTikTokCrmLastSuccessAt = Date.now();
    const item = externalCrmItemFromCurrentTikTok(data);
    externalTikTokCrmLastGoodItem = item;
    const key = externalAggregateKey(item);

    // Native TikTok clicks are authoritative. Meta Business is different:
    // its periodic CRM poll is NOT a selection event. During React hydration a
    // poll can briefly report another header/thread; letting that poll re-select
    // the sidebar was the remaining source of the 2.2-second customer jump.
    if (externalGlobalAggregateActive || externalWorkspaceModeFor(platform) === 'aggregate') {
      if (platform === 'metabusiness' && externalAggregateSelectedKey && externalAggregateSelectedKey !== key) {
        // Explicit aggregate clicks and onExternalNativeChatSelected own MB
        // selection. Ignore a mismatching background poll completely.
        return;
      }
      if (externalAggregateSelectedKey !== key) {
        externalAggregateSelectedKey = key;
        externalAggregateSelected = item;
        renderExternalAggregateCustomers();
      } else {
        externalAggregateSelected = item;
      }
    }

    if (!force && key === externalTikTokCrmLastKey) {
      const contextKey = externalAggregateCrmContext ? externalAggregateKey(externalAggregateCrmContext) : '';
      // V1.24.3: identity equality is NOT data equality. The main process can
      // legitimately update stage/LINE progress while the operator stays on the
      // same customer. Older builds returned here unconditionally and left the
      // right CRM showing a stale '已邀请LINE' forever even after persistence
      // had reached 'LINE已添加'. Compare the server-side CRM revision before
      // taking the same-customer fast path.
      if (externalAggregateCrmContext && contextKey === key) {
        externalAggregateCrmContext.handle = item.handle || externalAggregateCrmContext.handle;
        externalAggregateCrmContext.avatarUrl = item.avatarUrl || externalAggregateCrmContext.avatarUrl;
        const currentRevision = externalCrmContactRevision(externalAggregateCrmContext.crm || {});
        const incomingRevision = externalCrmContactRevision(data?.contact || item.crm || {});
        if (currentRevision === incomingRevision || externalCrmFormIsBeingEdited()) return;
        try { window.yoko.traceConversionDiagnostic?.({ event:'crm-rehydrate-revision', data:{ key, currentRevision, incomingRevision, before:{ stage:externalAggregateCrmContext?.crm?.stage || '', lineProgress:externalAggregateCrmContext?.crm?.lineProgress || '' }, after:{ stage:data?.contact?.stage || '', lineProgress:data?.contact?.lineProgress || '' } } }); } catch {}
        await hydrateExternalCrmPanel(item, data);
        return;
      }
      externalTikTokCrmLastKey = key;
      await hydrateExternalCrmPanel(item, data);
      // V1.27.49: Meta Business CRM polling is hydration only, never a GPT
      // customer-selection event. The preload's trusted native-row-click owns
      // explicit GPT routing so a 900ms CRM heartbeat cannot look like refresh.
      if (platform !== 'metabusiness') autoShowChatgptForSelectedCustomer(40).catch(() => null);
      return;
    }
    externalTikTokCrmLastKey = key;
    await hydrateExternalCrmPanel(item, data);
    // V1.27.49: periodic Meta Business CRM identity reads are not user
    // selections and may fluctuate during React hydration. Never route GPT from
    // this polling path. TikTok keeps the historical behavior.
    if (platform !== 'metabusiness') autoShowChatgptForSelectedCustomer(40).catch(() => null);
  } catch (error) {
    if (force) setExternalStatus(`同步当前 ${appCenterPlatformById(activeExternalPlatform)?.name || activeExternalPlatform} 客户资料失败：` + (error?.message || error));
  } finally {
    externalTikTokCrmSyncInFlight = false;
  }
}

function stopExternalTikTokCrmSync() {
  if (externalTikTokCrmSyncTimer) {
    clearInterval(externalTikTokCrmSyncTimer);
    externalTikTokCrmSyncTimer = null;
  }
  externalTikTokCrmSyncInFlight = false;
}

function startExternalTikTokCrmSync({ force = false } = {}) {
  const shouldRun = shellSurface === 'external' && externalPlatformHasCrm(activeExternalPlatform) && !!activeExternalAccountId;
  if (!shouldRun) { stopExternalTikTokCrmSync(); return; }
  if (force) syncExternalTikTokCrmPanel({ force:true }).catch(() => {});
  if (externalTikTokCrmSyncTimer) return;
  syncExternalTikTokCrmPanel({ force:true }).catch(() => {});
  // V1.27.41: native MB selection + CRM extraction are event-driven by the
  // preload. Keep only a slow fallback poll so scrolling never competes with a
  // 2.2-second full current-chat scan.
  const intervalMs = activeExternalPlatform === 'tiktok' ? 900 : (activeExternalPlatform === 'metabusiness' ? 12000 : 2200);
  externalTikTokCrmSyncTimer = setInterval(() => {
    if (document.hidden) return;
    if (shellSurface !== 'external' || !externalPlatformHasCrm(activeExternalPlatform)) return;
    // Non-TikTok login pages should be completely idle. After several misses
    // stop polling; did-finish-load/navigation will render the workspace and
    // start the sync again once the operator reaches a real conversation.
    if (activeExternalPlatform !== 'tiktok' && externalTikTokCrmMissCount >= 3) {
      stopExternalTikTokCrmSync();
      return;
    }
    syncExternalTikTokCrmPanel().catch(() => {});
  }, intervalMs);
}

async function refreshExternalAggregate({ remote = true, quiet = false, deepHarvest = false } = {}) {
  if (externalGlobalAggregateActive) return refreshGlobalExternalAggregate({ remote, quiet, deepHarvest });
  const platform = activeExternalPlatform;
  if (!externalPlatformHasAggregateWorkspace(platform)) return;
  const def = appCenterPlatformById(platform);
  const short = def?.short || platform.toUpperCase();
  try {
    if (!quiet) setExternalStatus(remote ? `正在刷新 ${short} 聚合客户…` : `正在读取 ${short} 客户缓存…`);
    externalAggregateInbox = remote
      ? (await window.yoko.refreshPlatformAggregate?.({ platform, deepHarvest: deepHarvest === true && platform === 'metabusiness' }))
      : (await window.yoko.getPlatformAggregate?.(platform));
    externalAggregateInbox = externalAggregateInbox || { platform, accounts:[], conversations:[], unreadCount:0 };
    renderExternalAggregateFilters();
    const selected = (externalAggregateInbox.conversations || []).find(item => externalAggregateKey(item) === externalAggregateSelectedKey);
    if (selected) {
      externalAggregateSelected = selected;
      if (externalAggregateCrmContext) hydrateExternalCrmPanel(selected).catch(() => {});
    }
    renderExternalAggregateCustomers();
    renderExternalCustomerStats();
    const label = $('#externalWorkspaceAccountLabel');
    if (label && externalWorkspaceModeFor(platform) === 'aggregate') label.textContent = `聚合 ${externalAggregateInbox.accounts?.length || 0} 个账号 · ${externalAggregateInbox.conversations?.length || 0} 个客户`;
    if (!quiet) setExternalStatus(externalWaitingCenterActive ? `${short}待回复中心 · ${externalWaitingCenterCount()} 位客户 · 已按优先级排序` : `${short}聚合 · ${externalAggregateInbox.conversations?.length || 0} 个客户 · ${externalAggregateInbox.unreadCount || 0} 条未读`);
  } catch (error) {
    if (!quiet) setExternalStatus(`${short}聚合刷新失败：` + (error?.message || error));
  }
}

function startExternalAggregateRefreshTimer() {
  if (externalAggregateRefreshTimer) clearInterval(externalAggregateRefreshTimer);
  externalAggregateRefreshTimer = null;
  if (shellSurface !== 'external') return;

  if (externalGlobalAggregateActive) {
    externalAggregateRefreshTimer = setInterval(() => {
      if (document.hidden) return;
      if (shellSurface !== 'external' || !externalGlobalAggregateActive) return;
      refreshGlobalExternalAggregate({ remote:false, quiet:true }).catch(() => {});
    }, 8000);
    return;
  }

  const platform = activeExternalPlatform;
  if (!externalPlatformHasAggregateWorkspace(platform) || externalWorkspaceModeFor(platform) !== 'aggregate') return;
  // V1.27.39: Meta Business is event-driven. The preload already inspects the
  // native inbox every 2.5s and publishes ONLY semantic changes; running another
  // renderer-side remote refresh every 3s rebuilt the entire software list even
  // while absolutely nothing changed. That was the visible self-refresh/flicker
  // the operator reported. Manual refresh still performs a remote scan.
  if (platform === 'metabusiness') return;
  const refreshMs = 8000;
  externalAggregateRefreshTimer = setInterval(() => {
    if (document.hidden) return;
    if (shellSurface !== 'external' || externalGlobalAggregateActive || activeExternalPlatform !== platform || externalWorkspaceModeFor(platform) !== 'aggregate') return;
    refreshExternalAggregate({ remote:true, quiet:true, deepHarvest:false }).catch(() => {});
  }, refreshMs);
}

async function setExternalPlatformWorkspaceMode(mode) {
  if (externalGlobalAggregateActive) return;
  const platform = String(activeExternalPlatform || '').trim();
  // V1.27.41: Meta Business is native-only. Ignore any stale aggregate click/
  // persisted mode and recommit the real native WebContentsView instead.
  if (platform === 'metabusiness') mode = 'native';
  else if (!externalPlatformHasAggregateWorkspace(platform)) return;
  mode = mode === 'aggregate' ? 'aggregate' : 'native';

  const platformAccounts = appCenterAccountsFor(platform);
  let activeAccount = externalAccountById(activeExternalAccountId);
  if (!activeAccount || String(activeAccount.platform || '') !== platform) activeAccount = platformAccounts[0] || null;
  if (activeAccount) activeExternalAccountId = String(activeAccount.id || '');

  const previousCustomer = externalAggregateCrmContext || externalAggregateSelected || externalTikTokCrmLastGoodItem;
  const keepPreviousForNative = mode === 'native' && previousCustomer && activeAccount &&
    String(previousCustomer.platform || platform) === platform &&
    String(previousCustomer.accountId || '') === String(activeAccount.id || '');

  persistExternalWorkspaceMode(platform, mode);

  // V1.27.22: native mode needs a real active WebContentsView authority, not
  // only a renderer-side mode toggle. Aggregate/background scans may leave the
  // backend activeAccountId pointing at another platform while this workspace
  // still visually says "MB模式". In that state layoutViews correctly hides the
  // MB view, producing the blank center seen in production. Re-commit the
  // external surface to this platform/account before switching the layout mode.
  if (mode === 'native' && activeAccount) {
    const surface = await window.yoko.setShellSurface?.('external', activeAccount.id);
    if (surface?.stale) return;
    activeExternalAccountId = String(activeAccount.id || '');
    appCenterState.activeAccountId = activeExternalAccountId;
    try { await window.yoko.setNativeViewsVisible?.(true); } catch {}
  }

  await window.yoko.setExternalWorkspaceMode?.(platform, mode);
  await window.yoko.setExternalAccountSidebarCollapsed?.(externalAccountSidebarCollapsed);
  externalAggregateSelectedKey = keepPreviousForNative ? externalAggregateKey(previousCustomer) : '';
  externalAggregateSelected = keepPreviousForNative ? previousCustomer : null;
  if (keepPreviousForNative) externalTikTokCrmLastGoodItem = previousCustomer;
  renderExternalWorkspace();
  if (keepPreviousForNative) hydrateExternalCrmPanel(previousCustomer).catch(() => {});
  else if (mode === 'native') resetExternalCrmPanel(platform);

  const def = appCenterPlatformById(platform);
  const short = def?.short || platform.toUpperCase();
  if (mode === 'aggregate') {
    await refreshExternalAggregate({ remote:true, quiet:false });
  } else {
    await loadExternalCustomerStatsCache(platform);
    setExternalStatus(`${activeAccount?.name || short} · ${short}模式`);
    // Reconcile the CRM only after the correct native platform view is visible.
    startExternalTikTokCrmSync({ force:true });
  }
  startExternalAggregateRefreshTimer();
}

async function openExternalAggregateCustomer(item) {
  if (!item) return;
  const openSequence = ++externalAggregateOpenSequence;
  const openRequestId = `aggregate-${Date.now()}-${openSequence}`;
  const key = externalAggregateKey(item);
  externalAggregateSelectedKey = key;
  externalAggregateSelected = item;
  if (String(item?.platform || '') === 'metabusiness' && !externalWaitingCenterActive) applyExternalAggregateSelectionVisual();
  else renderExternalAggregateCustomers();
  hydrateExternalCrmPanel(item).catch(() => {});
  const platform = String(item.platform || activeExternalPlatform || '');
  const def = appCenterPlatformById(platform);
  const short = def?.short || platform.toUpperCase();
  try {
    setExternalStatus(`正在打开 ${short} · ${item.accountName || '账号'} · ${item.displayName || '客户'}…`);
    const opened = await window.yoko.openPlatformAggregateConversation?.({
      platform, accountId:item.accountId, chatId:item.chatId, displayName:item.displayName, href:item.href || '', aggregateUiKey:item.aggregateUiKey || '', openRequestId
    });
    // A slower previous click is stale the instant a newer card was chosen.
    // Never let its completion re-select/re-render an older customer.
    if (openSequence !== externalAggregateOpenSequence) return;
    activeExternalPlatform = platform;
    activeExternalAccountId = String(opened?.accountId || item.accountId || '');
    appCenterState.activeAccountId = activeExternalAccountId;
    if (opened?.chatId) item.chatId = opened.chatId;
    if (opened?.displayName) item.displayName = opened.displayName;
    if (opened?.handle) item.handle = opened.handle;
    if (opened?.avatarUrl) item.avatarUrl = opened.avatarUrl;
    // A durable thread id may only become available after the native conversation
    // opens. Re-key the selection immediately so the clicked row remains the one
    // selected row instead of losing selection after name:* -> mb-thread:* hydration.
    externalAggregateSelected = item;
    externalAggregateSelectedKey = externalAggregateKey(item);
    try { await window.yoko.setNativeViewsVisible?.(true); } catch {}
    if (openSequence !== externalAggregateOpenSequence) return;
    if (platform === 'metabusiness' && !externalGlobalAggregateActive && externalWorkspaceModeFor(platform) === 'aggregate' && !externalWaitingCenterActive) {
      applyExternalAggregateSelectionVisual();
      renderExternalCustomerStats();
      if ($('#externalWorkspaceAccountLabel')) $('#externalWorkspaceAccountLabel').textContent = `聚合 ${externalAggregateInbox.accounts?.length || 0} 个账号 · ${externalAggregateInbox.conversations?.length || 0} 个客户`;
    } else {
      renderExternalWorkspace();
    }
    hydrateExternalCrmPanel(item).catch(() => {});
    autoShowChatgptForSelectedCustomer(80).catch(() => null);
    startExternalTikTokCrmSync({ force:true });
    setExternalStatus(`${short} · ${item.accountName || '账号'} · ${item.displayName || '客户'} 已打开`);
  } catch (error) {
    if (openSequence !== externalAggregateOpenSequence) return;
    if (String(error?.message || error) === '__YOKO_MB_OPEN_SUPERSEDED__') return;
    setExternalStatus('打开客户失败：' + (error?.message || error));
  }
}


const APP_CENTER_LINE_CARD = {
  id: 'line', name: 'LINE', short: 'LINE',
  description: 'Yoko LINE 核心 · LINE模式 / 聚合客服 / CRM / 翻译 / 独立代理'
};

function appCenterPlatformById(id) {
  id = String(id || '').trim();
  return (appCenterState.platforms || []).find(item => item.id === id) || null;
}

function appCenterAccountsFor(platform) {
  platform = String(platform || '').trim();
  return (appCenterState.accounts || []).filter(item => item.platform === platform);
}

function installedPlatformIds() {
  return Array.isArray(appCenterState.installedPlatforms) ? appCenterState.installedPlatforms.map(id => String(id || '').trim()).filter(Boolean) : [];
}

function isPlatformInstalled(platform) {
  return installedPlatformIds().includes(String(platform || '').trim());
}

function setAppCenterPane(pane = 'apps') {
  appCenterPane = pane === 'home' ? 'home' : 'apps';
  $('#appCenterHomePane')?.classList.toggle('hidden', appCenterPane !== 'home');
  $('#appCenterAppsPane')?.classList.toggle('hidden', appCenterPane !== 'apps');
  $('#shellHomeBtn')?.classList.toggle('active', shellSurface === 'app-center' && appCenterPane === 'home');
  $('#shellAppCenterBtn')?.classList.toggle('active', shellSurface === 'app-center' && appCenterPane === 'apps');
}

function setShellBodyClass(surface) {
  const previousSurface = shellSurface;
  shellSurface = ['app-center','line','external','native-api'].includes(surface) ? surface : 'app-center';
  document.body.classList.toggle('shell-app-center', shellSurface === 'app-center');
  document.body.classList.toggle('shell-line', shellSurface === 'line');
  document.body.classList.toggle('shell-external', shellSurface === 'external');
  document.body.classList.toggle('shell-native-api', shellSurface === 'native-api');
  $('#appCenterPage')?.classList.toggle('hidden', shellSurface !== 'app-center');
  $('#externalWorkspacePage')?.classList.toggle('hidden', shellSurface !== 'external');
  $('#nativeApiPage')?.classList.toggle('hidden', shellSurface !== 'native-api');
  $('#shellLineBtn')?.classList.toggle('active', shellSurface === 'line');
  $('#shellNativeApiBtn')?.classList.toggle('active', shellSurface === 'native-api');
  $('#shellUnifiedAggregateBtn')?.classList.toggle('active', shellSurface === 'external' && externalGlobalAggregateActive);
  if (shellSurface !== 'app-center') {
    $('#shellHomeBtn')?.classList.remove('active');
    $('#shellAppCenterBtn')?.classList.remove('active');
  } else {
    setAppCenterPane(appCenterPane);
  }
  if (previousSurface === 'native-api' && shellSurface !== 'native-api') stopNativeApiRefreshTimer?.();
}

function appRailButtonHtml(platform) {
  const running = Number(platform.openCount || 0) > 0;
  const active = shellSurface === 'external' && !externalGlobalAggregateActive && activeExternalPlatform === platform.id;
  const title = platform.name;
  return `<button class="global-app-platform-btn platform-${escapeHtml(platform.id)}${running ? ' running' : ''}${active ? ' active' : ''}" type="button" data-shell-platform="${escapeHtml(platform.id)}" title="${escapeHtml(title)}"><span>${escapeHtml(platform.short || platform.name.slice(0,2))}</span><i class="rail-running-dot"></i></button>`;
}

function quickAddPlatformIconHtml(platform) {
  const short = String(platform?.short || platform?.name || platform?.id || '?').slice(0, 4);
  return `<span class="shell-quick-add-icon platform-${escapeHtml(platform?.id || '')}">${escapeHtml(short)}</span>`;
}

function renderQuickAddAppMenu() {
  const menu = $('#shellQuickAddMenu');
  if (!menu) return;
  const installed = new Set(installedPlatformIds());
  const allPlatforms = [APP_CENTER_LINE_CARD, ...(appCenterState.platforms || [])];
  const seen = new Set();
  const available = allPlatforms.filter(platform => {
    const id = String(platform?.id || '').trim();
    if (!id || installed.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (!available.length) {
    menu.innerHTML = '<div class="shell-quick-add-empty">可用应用都已经添加</div>';
    return;
  }
  menu.innerHTML = available.map(platform => `
    <button class="shell-quick-add-item" type="button" role="menuitem" data-quick-install-platform="${escapeHtml(platform.id)}" title="添加 ${escapeHtml(platform.name)}">
      ${quickAddPlatformIconHtml(platform)}
      <span class="shell-quick-add-copy"><strong>${escapeHtml(platform.name)}</strong><small>添加到左侧导航</small></span>
      <span class="shell-quick-add-plus">＋</span>
    </button>`).join('');
}

function setQuickAddAppMenu(open = false) {
  appRailAddMenuOpen = Boolean(open);
  const menu = $('#shellQuickAddMenu');
  const button = $('#shellAddAppBtn');
  menu?.classList.toggle('hidden', !appRailAddMenuOpen);
  const compactPicker = document.body.classList.contains('accounts-collapsed') || $('#externalWorkspacePage')?.classList.contains('external-sidebar-collapsed');
  menu?.classList.toggle('compact', Boolean(compactPicker));
  button?.classList.toggle('active', appRailAddMenuOpen);
  button?.setAttribute('aria-expanded', appRailAddMenuOpen ? 'true' : 'false');
  if (appRailAddMenuOpen) {
    renderQuickAddAppMenu();
  }
}

async function quickInstallPlatform(platform) {
  platform = String(platform || '').trim();
  // V1.23.5: keep the quick-add picker open so several applications can be
  // added in one pass. Invalid/already-added entries simply refresh the menu.
  if (!platform || isPlatformInstalled(platform)) {
    if (appRailAddMenuOpen) renderQuickAddAppMenu();
    return;
  }
  const def = platform === 'line' ? APP_CENTER_LINE_CARD : appCenterPlatformById(platform);
  try {
    await window.yoko.installAppCenterPlatform?.(platform);
    await refreshAppCenterState({ quiet: true });
    renderInstalledAppRail();
    if (appRailAddMenuOpen) renderQuickAddAppMenu();
    const message = `${def?.name || platform} 已直接添加到左侧 · 可继续添加其他应用`;
    if (shellSurface === 'external') setExternalStatus(message);
    else setStatus(message);
  } catch (error) {
    const message = '添加应用失败：' + (error?.message || error);
    if (shellSurface === 'external') setExternalStatus(message);
    else setStatus(message);
    if (appRailAddMenuOpen) renderQuickAddAppMenu();
  }
}

function renderQuickRemoveAppMenu() {
  const menu = $('#shellQuickRemoveMenu');
  if (!menu) return;
  const installed = installedPlatformIds();
  const platforms = installed.map(id => id === 'line' ? APP_CENTER_LINE_CARD : appCenterPlatformById(id)).filter(Boolean);
  if (!platforms.length) {
    menu.innerHTML = '<div class="shell-quick-add-empty">当前没有可移除的应用</div>';
    return;
  }
  menu.innerHTML = platforms.map(platform => `
    <button class="shell-quick-add-item shell-quick-remove-item" type="button" role="menuitem" data-quick-remove-platform="${escapeHtml(platform.id)}" title="移除 ${escapeHtml(platform.name)}">
      ${quickAddPlatformIconHtml(platform)}
      <span class="shell-quick-add-copy"><strong>${escapeHtml(platform.name)}</strong><small>从左侧移除 · 账号和登录数据保留</small></span>
      <span class="shell-quick-remove-minus">－</span>
    </button>`).join('');
}

function setQuickRemoveAppMenu(open = false) {
  appRailRemoveMenuOpen = Boolean(open);
  const menu = $('#shellQuickRemoveMenu');
  const button = $('#shellRemoveAppBtn');
  menu?.classList.toggle('hidden', !appRailRemoveMenuOpen);
  const compactPicker = document.body.classList.contains('accounts-collapsed') || $('#externalWorkspacePage')?.classList.contains('external-sidebar-collapsed');
  menu?.classList.toggle('compact', Boolean(compactPicker));
  button?.classList.toggle('active', appRailRemoveMenuOpen);
  button?.setAttribute('aria-expanded', appRailRemoveMenuOpen ? 'true' : 'false');
  if (appRailRemoveMenuOpen) {
    if (appRailAddMenuOpen) setQuickAddAppMenu(false);
    renderQuickRemoveAppMenu();
  }
}

async function quickRemovePlatform(platform) {
  platform = String(platform || '').trim();
  // V1.23.5: keep the remove picker open after each one-click removal so the
  // operator can remove several applications without reopening the menu.
  if (!platform || !isPlatformInstalled(platform)) {
    if (appRailRemoveMenuOpen) renderQuickRemoveAppMenu();
    return;
  }
  // Scheme B stays intact: only the rail entry is removed; accounts/Profile/
  // CRM/login/proxy data remain preserved for a later re-add.
  await removePlatform(platform);
  if (appRailRemoveMenuOpen) renderQuickRemoveAppMenu();
}

function renderInstalledAppRail() {
  const rail = $('#installedAppRail');
  if (!rail) return;
  // V1.20.2: rail order is the installation order and NEVER changes when an
  // app/account is clicked. Active state is visual only.
  const ids = installedPlatformIds();
  const installedExternal = ids
    .filter(id => id !== 'line')
    .map(id => appCenterPlatformById(id))
    .filter(Boolean);
  rail.innerHTML = installedExternal.map(appRailButtonHtml).join('');

  const lineInstalled = ids.includes('line');
  const lineBtn = $('#shellLineBtn');
  if (lineBtn) { lineBtn.hidden = !lineInstalled; lineBtn.title = 'LINE'; }
  const lineRunning = lineInstalled && (state?.config?.accounts || []).some(account => account?.isOpen !== false);
  lineBtn?.classList.toggle('running', lineRunning);
  lineBtn?.classList.toggle('active', lineInstalled && shellSurface === 'line');
  if (appRailAddMenuOpen) renderQuickAddAppMenu();
  if (appRailRemoveMenuOpen) renderQuickRemoveAppMenu();
}

function platformCardHtml(platform) {
  const accounts = appCenterAccountsFor(platform.id);
  const openCount = accounts.filter(a => a.isOpen).length;
  const installed = isPlatformInstalled(platform.id);
  const countText = accounts.length
    ? `${accounts.length} 个账号 · ${openCount} 已运行${installed ? '' : ' · 数据已保留'}`
    : (installed ? '已添加 · 尚未创建账号' : '尚未添加');
  const primary = installed
    ? `<button type="button" data-app-enter-platform="${escapeHtml(platform.id)}">进入</button>`
    : `<button type="button" data-app-install-platform="${escapeHtml(platform.id)}">＋ 添加应用</button>`;
  return `
    <article class="app-card platform-${escapeHtml(platform.id)}" data-platform-card="${escapeHtml(platform.id)}">
      <div class="app-card-icon"><span>${escapeHtml(platform.short || platform.name.slice(0,2))}</span></div>
      <div class="app-card-copy">
        <div class="app-card-title"><strong>${escapeHtml(platform.name)}</strong><span>${installed ? (openCount ? '运行中' : '已添加') : '可添加'}</span></div>
        <p>${escapeHtml(platform.description || '')}</p>
        <small>${escapeHtml(countText)}${accounts.some(a => a.proxy?.enabled) ? ' · 已配置独立代理' : ''}</small>
      </div>
      <div class="app-card-actions">
        ${primary}
        ${installed ? `<button type="button" data-app-manage-platform="${escapeHtml(platform.id)}">管理账号</button><button type="button" class="danger" data-app-remove-platform="${escapeHtml(platform.id)}">移除应用</button>` : ''}
      </div>
    </article>`;
}

function dashboardPlatformCardHtml(row = {}) {
  const running = Math.max(0, Number(row.accountOpen || 0) || 0);
  const total = Math.max(0, Number(row.accountTotal || 0) || 0);
  const progress = total ? Math.max(0, Math.min(100, Math.round((running / total) * 100))) : 0;
  return `<button class="dashboard-platform-card platform-${escapeHtml(row.id || '')}" type="button" data-dashboard-platform="${escapeHtml(row.id || '')}">
    <span class="dashboard-platform-card-head">
      <span class="app-dashboard-platform-icon platform-${escapeHtml(row.id || '')}">${escapeHtml(row.short || row.name || '?')}</span>
      <span class="dashboard-platform-card-title"><strong>${escapeHtml(row.name || row.id || '平台')}</strong><small>${running}/${total} 运行</small></span>
      <span class="dashboard-platform-arrow">›</span>
    </span>
    <span class="dashboard-platform-metrics">
      <span><b>${Number(row.todayNewCustomerCount || 0)}</b><small>今日新进</small></span>
      <span class="dup"><b>${Number(row.todayDuplicateCustomerCount || 0)}</b><small>重复粉</small></span>
      <span><b>${Number(row.todayValidCustomerCount || 0)}</b><small>有效新客</small></span>
      <span><b>${Number(row.waitingCount || 0)}</b><small>待回复</small></span>
    </span>
    <span class="dashboard-platform-foot"><span>已加 LINE ${Number(row.lineAddedCount || 0)}</span><span>客户 ${Number(row.totalCustomerCount || 0)}</span></span>
    <span class="dashboard-account-progress"><i style="width:${progress}%"></i></span>
  </button>`;
}

function leadFunnelStageHtml(row = {}, total = 0) {
  const stage = String(row.stage || '新进线');
  const count = Math.max(0, Number(row.count || 0) || 0);
  const share = total > 0 ? Math.round((count / total) * 1000) / 10 : 0;
  const cls = stage === '已对接ws' ? ' line-added' : (stage === '无效' ? ' paused' : '');
  return `<article class="lead-funnel-stage${cls}" title="${escapeHtml(stage)} · ${count} 位 · 占全部 ${share}%">
    <strong>${count}</strong><span>${escapeHtml(stage)}</span><small>占全部 ${share}%</small>
  </article>`;
}

function leadFunnelPlatformRowHtml(row = {}) {
  const platform = String(row.id || '');
  const total = Math.max(0, Number(row.totalCustomerCount || 0) || 0);
  const today = Math.max(0, Number(row.todayNewCustomerCount || 0) || 0);
  const added = Math.max(0, Number(row.lineAddedCount || 0) || 0);
  const rate = Math.max(0, Number(row.conversionRate || 0) || 0);
  return `<button type="button" class="lead-funnel-row" data-lead-funnel-platform="${escapeHtml(platform)}">
    <span class="lead-funnel-row-name"><span class="app-dashboard-platform-icon platform-${escapeHtml(platform)}">${escapeHtml(row.short || row.name || '?')}</span><span class="lead-funnel-row-copy"><strong>${escapeHtml(row.name || platform || '平台')}</strong><small>今日新进 ${today} · 客户 ${total}</small></span></span>
    <span class="lead-funnel-row-metric"><strong>${added}</strong><small>加LINE</small></span>
    <span class="lead-funnel-row-metric"><strong>${Math.max(0, Number(row.waitingCount || 0) || 0)}</strong><small>待回复</small></span>
    <span class="lead-funnel-row-metric"><strong class="lead-funnel-rate">${rate.toFixed(rate % 1 ? 1 : 0)}%</strong><small>转化率</small></span>
  </button>`;
}

function leadFunnelAccountRowHtml(row = {}) {
  const platform = String(row.platform || '');
  const total = Math.max(0, Number(row.totalCustomerCount || 0) || 0);
  const added = Math.max(0, Number(row.lineAddedCount || 0) || 0);
  const ready = Math.max(0, Number(row.readyCount || 0) || 0) + Math.max(0, Number(row.invitedCount || 0) || 0);
  const rate = Math.max(0, Number(row.conversionRate || 0) || 0);
  return `<button type="button" class="lead-funnel-row" data-lead-funnel-platform="${escapeHtml(platform)}" data-lead-funnel-account="${escapeHtml(row.accountId || '')}">
    <span class="lead-funnel-row-name"><span class="app-dashboard-platform-icon platform-${escapeHtml(platform)}">${escapeHtml(row.platformShort || row.platformName || '?')}</span><span class="lead-funnel-row-copy"><strong>${escapeHtml(row.accountName || row.accountId || '账号')}</strong><small>${escapeHtml(row.platformName || platform)} · 今日 ${Math.max(0, Number(row.todayNewCustomerCount || 0) || 0)}</small></span></span>
    <span class="lead-funnel-row-metric"><strong>${total}</strong><small>客户</small></span>
    <span class="lead-funnel-row-metric"><strong>${ready}</strong><small>待引导</small></span>
    <span class="lead-funnel-row-metric"><strong class="lead-funnel-rate">${rate.toFixed(rate % 1 ? 1 : 0)}%</strong><small>${added} 加LINE</small></span>
  </button>`;
}

function renderLeadFunnelCenter(funnel = {}) {
  const total = Math.max(0, Number(funnel.totalCustomerCount || 0) || 0);
  const rate = Math.max(0, Number(funnel.conversionRate || 0) || 0);
  if ($('#leadFunnelTotal')) $('#leadFunnelTotal').textContent = String(total);
  if ($('#leadFunnelRate')) $('#leadFunnelRate').textContent = `${rate.toFixed(rate % 1 ? 1 : 0)}%`;
  if ($('#leadFunnelTodayNew')) $('#leadFunnelTodayNew').textContent = String(Math.max(0, Number(funnel.todayNewCustomerCount || 0) || 0));
  if ($('#leadFunnelQualified')) $('#leadFunnelQualified').textContent = String(Math.max(0, Number(funnel.qualifiedCount || 0) || 0));
  if ($('#leadFunnelReady')) $('#leadFunnelReady').textContent = String(Math.max(0, Number(funnel.readyCount || 0) || 0));
  if ($('#leadFunnelInvited')) $('#leadFunnelInvited').textContent = String(Math.max(0, Number(funnel.invitedCount || 0) || 0));
  if ($('#leadFunnelWaiting')) $('#leadFunnelWaiting').textContent = String(Math.max(0, Number(funnel.waitingCount || 0) || 0));
  if ($('#leadFunnelUnassigned')) $('#leadFunnelUnassigned').textContent = String(Math.max(0, Number(funnel.unassignedLineCount || 0) || 0));

  const stageGrid = $('#leadFunnelStageGrid');
  const stages = Array.isArray(funnel.stages) ? funnel.stages : [];
  if (stageGrid) stageGrid.innerHTML = stages.length
    ? stages.map(row => leadFunnelStageHtml(row, total)).join('')
    : '<div class="dashboard-empty dashboard-empty-wide">暂无引流客户数据</div>';

  const platformList = $('#leadFunnelPlatformList');
  const platforms = Array.isArray(funnel.platforms) ? funnel.platforms : [];
  if (platformList) platformList.innerHTML = platforms.length
    ? platforms.map(leadFunnelPlatformRowHtml).join('')
    : '<div class="dashboard-empty">暂无平台数据</div>';

  const accountList = $('#leadFunnelAccountList');
  const accounts = Array.isArray(funnel.accounts) ? funnel.accounts : [];
  if (accountList) accountList.innerHTML = accounts.length
    ? accounts.map(leadFunnelAccountRowHtml).join('')
    : '<div class="dashboard-empty">暂无账号数据</div>';
}

function renderDashboardTrend(trend = []) {
  const box = $('#dashboardTrendChart');
  if (!box) return;
  const rows = Array.isArray(trend) ? trend : [];
  const maxValue = Math.max(1, ...rows.flatMap(row => [Number(row.newCount || 0), Number(row.duplicateCount || 0)]));
  if (!rows.length) {
    box.innerHTML = '<div class="dashboard-empty">暂无趋势数据</div>';
    return;
  }
  box.innerHTML = `<div class="dashboard-chart-grid">${rows.map(row => {
    const fresh = Math.max(0, Number(row.newCount || 0) || 0);
    const dup = Math.max(0, Number(row.duplicateCount || 0) || 0);
    const freshH = Math.round((fresh / maxValue) * 100);
    const dupH = Math.round((dup / maxValue) * 100);
    return `<div class="dashboard-chart-day" title="${escapeHtml(row.label || '')} · 新进 ${fresh} · 重复 ${dup}">
      <div class="dashboard-chart-values"><span>${fresh || ''}</span><span>${dup || ''}</span></div>
      <div class="dashboard-chart-bars"><i class="new" style="height:${freshH}%"></i><i class="duplicate" style="height:${dupH}%"></i></div>
      <small>${escapeHtml(row.label || '')}</small>
    </div>`;
  }).join('')}</div>`;
}

function renderOperationsDashboard() {
  const data = operationsDashboardState;
  if (!data) return;
  const today = data.today || {};
  if ($('#appDashTodayNew')) $('#appDashTodayNew').textContent = String(Number(today.newCustomerCount || 0));
  if ($('#appDashTodayDuplicate')) $('#appDashTodayDuplicate').textContent = String(Number(today.duplicateCustomerCount || 0));
  if ($('#appDashTodayValid')) $('#appDashTodayValid').textContent = String(Number(today.validCustomerCount || 0));
  if ($('#appDashLineAdded')) $('#appDashLineAdded').textContent = String(Number(today.lineAddedCount || 0));
  if ($('#appDashWaiting')) $('#appDashWaiting').textContent = String(Number(today.waitingCount || 0));
  if ($('#appDashRunning')) $('#appDashRunning').textContent = `${Number(today.runningAccounts || 0)}/${Number(today.totalAccounts || 0)}`;
  const updated = $('#dashboardUpdatedAt');
  if (updated) {
    const at = Date.parse(String(data.generatedAt || ''));
    updated.textContent = Number.isFinite(at) ? `更新 ${new Date(at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' })}` : '已刷新';
  }

  const platformList = $('#appDashboardPlatformList');
  const platforms = Array.isArray(data.platforms) ? data.platforms : [];
  if (platformList) platformList.innerHTML = platforms.length
    ? platforms.map(dashboardPlatformCardHtml).join('')
    : '<div class="dashboard-empty dashboard-empty-wide">还没有添加应用，可用左侧「＋添加应用」快速添加。</div>';

  renderDashboardTrend(data.trend || []);
  renderLeadFunnelCenter(data.leadFunnel || {});

  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  const accountList = $('#dashboardAccountStatusList');
  if ($('#dashboardAccountSummary')) $('#dashboardAccountSummary').textContent = `${Number(today.runningAccounts || 0)} 运行 / ${accounts.length} 总计`;
  if (accountList) {
    accountList.innerHTML = accounts.length ? accounts.map(row => {
      const kind = row.isOpen ? (row.online ? 'online' : 'running') : 'closed';
      return `<button type="button" class="dashboard-account-status-row ${kind}" data-dashboard-platform="${escapeHtml(row.platform || '')}">
        <span class="app-dashboard-platform-icon platform-${escapeHtml(row.platform || '')}">${escapeHtml(row.platformShort || row.platformName || '?')}</span>
        <span class="dashboard-account-status-copy"><strong>${escapeHtml(row.accountName || '账号')}</strong><small>${escapeHtml(row.platformName || row.platform || '')}</small></span>
        <span class="dashboard-account-state"><i></i>${escapeHtml(row.status || (row.isOpen ? '运行中' : '已关闭'))}</span>
      </button>`;
    }).join('') : '<div class="dashboard-empty dashboard-empty-wide">暂无账号</div>';
  }
}

async function refreshOperationsDashboard({ quiet = false } = {}) {
  try {
    const payload = await window.yoko.getOperationsDashboard?.();
    if (payload) operationsDashboardState = payload;
    renderOperationsDashboard();
    await refreshCustomerNumberVault({ quiet:true });
    if (!quiet) setStatus('首页数据已刷新');
  } catch (error) {
    if (!quiet) setStatus('首页数据读取失败：' + (error?.message || error));
  }
}

let customerNumberVaultState = { stats:{}, contacts:[] };

function customerNumberVaultSourceLabel(value) {
  return ({ whatsapp:'WS客户', group:'WS群', community:'社群', import:'导入' })[String(value || '')] || String(value || '其他');
}

function renderCustomerNumberVault() {
  const stats = customerNumberVaultState.stats || {};
  const set = (id, value) => { const node = $(`#${id}`); if (node) node.textContent = String(Number(value || 0)); };
  set('customerNumberVaultTotal', stats.total);
  set('customerNumberVaultToday', stats.todayNew);
  set('customerNumberVaultGroups', stats.groups);
  set('customerNumberVaultDeletedGroups', stats.deletedGroups);
  const box = $('#customerNumberVaultTable');
  const rows = Array.isArray(customerNumberVaultState.contacts) ? customerNumberVaultState.contacts : [];
  if (!box) return;
  if (!rows.length) { box.innerHTML = '<div class="dashboard-empty">暂无号码记录。可先手动保存，或导入 CSV。</div>'; return; }
  box.innerHTML = `<div class="customer-number-vault-table-head"><span>电话号码</span><span>来源</span><span>账号 / 群组</span><span>最近记录</span></div>${rows.slice(0, 500).map(row => {
    const source = row.sources?.[0] || {};
    const where = [source.accountName || source.accountId, source.groupName || source.groupId].filter(Boolean).join(' · ') || '未标记来源';
    const when = row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleString() : '-';
    return `<div class="customer-number-vault-row"><strong>${escapeHtml(row.phone || '')}</strong><span>${escapeHtml(customerNumberVaultSourceLabel(source.type))}</span><span>${escapeHtml(where)}</span><small>${escapeHtml(when)}</small></div>`;
  }).join('')}`;
}

async function refreshCustomerNumberVault({ quiet = false } = {}) {
  try {
    const payload = await window.yoko.getCustomerNumberVaultStats?.();
    if (payload?.ok !== false) {
      customerNumberVaultState = { stats:payload?.stats || {}, contacts:Array.isArray(payload?.contacts) ? payload.contacts : [] };
      renderCustomerNumberVault();
    }
  } catch (error) {
    if (!quiet) setStatus('号码库读取失败：' + (error?.message || error));
  }
}

function parseCustomerNumberCsv(textValue) {
  const text = String(textValue || '').replace(/^\ufeff/, '');
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = !quoted; continue; }
    if (ch === ',' && !quoted) { row.push(cell); cell = ''; continue; }
    if ((ch === '\n' || ch === '\r') && !quoted) { if (ch === '\r' && text[i + 1] === '\n') i += 1; row.push(cell); if (row.some(value => value.trim())) rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell || row.length) { row.push(cell); if (row.some(value => value.trim())) rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map(value => value.trim().toLowerCase());
  return rows.map(values => {
    const item = {}; headers.forEach((header, index) => { item[header] = String(values[index] || '').trim(); });
    const sources = item.sources || '';
    const type = /community|社群/i.test(sources) ? 'community' : (/group|群/i.test(sources) ? 'group' : (/whatsapp|ws/i.test(sources) ? 'whatsapp' : 'import'));
    return { phone:item.phone || item.phonenumber || item.number, status:item.status || 'active', sourceType:type, accountName:item.accounts || item.account || '', groupName:item.groups || item.group || '', note:item.note || '' };
  }).filter(row => row.phone);
}

async function importCustomerNumberCsvFile(file) {
  if (!file) return;
  const parsed = parseCustomerNumberCsv(await file.text());
  if (!parsed.length) { setStatus('CSV 中没有可识别的 phone 列。'); return; }
  const result = await window.yoko.importCustomerNumberRows?.(parsed);
  await refreshCustomerNumberVault({ quiet:true });
  setStatus(`号码导入完成：新增 ${result?.added || 0}，更新 ${result?.updated || 0}，跳过 ${result?.skipped || 0}`);
}

function scheduleOperationsDashboardRefresh(delay = 350) {
  if (operationsDashboardRefreshTimer) clearTimeout(operationsDashboardRefreshTimer);
  operationsDashboardRefreshTimer = setTimeout(() => {
    operationsDashboardRefreshTimer = null;
    if (shellSurface === 'app-center' && appCenterPane === 'home') refreshOperationsDashboard({ quiet:true });
  }, Math.max(0, Number(delay || 0) || 0));
}

function renderAppCenter() {
  const grid = $('#appCenterGrid');
  const lineCount = Array.isArray(state?.config?.accounts) ? state.config.accounts.length : 0;
  const externalAccounts = Array.isArray(appCenterState.accounts) ? appCenterState.accounts : [];
  const installedIds = installedPlatformIds();

  if (grid) {
    const lineInstalled = isPlatformInstalled('line');
    const lineCard = `
      <article class="app-card platform-line">
        <div class="app-card-icon"><span>LINE</span></div>
        <div class="app-card-copy">
          <div class="app-card-title"><strong>LINE</strong><span>${lineInstalled ? '已添加' : '可添加'}</span></div>
          <p>${escapeHtml(APP_CENTER_LINE_CARD.description)}</p>
          <small>${lineCount} 个 LINE 账号${lineInstalled ? ' · 登录/E2EE 使用现有稳定核心' : (lineCount ? ' · 原账号数据已保留' : '')}</small>
        </div>
        <div class="app-card-actions">${lineInstalled
          ? `<button type="button" data-app-enter-line="1">进入 LINE</button><button type="button" class="danger" data-app-remove-line="1">移除应用</button>`
          : `<button type="button" data-app-install-line="1">＋ 添加应用</button>`}</div>
      </article>`;
    grid.innerHTML = lineCard + (appCenterState.platforms || []).map(platformCardHtml).join('');
  }

  if (operationsDashboardState) renderOperationsDashboard();
  renderInstalledAppRail();
  if (!$('#appAccountModal')?.classList.contains('hidden')) renderAppAccountManager();
  if (shellSurface === 'external') renderExternalWorkspace();
}

async function refreshAppCenterState({ quiet = false } = {}) {
  try {
    appCenterState = await window.yoko.getAppCenterState?.() || { platforms: [], accounts: [], installedPlatforms: [] };
    const backendActiveId = String(appCenterState.activeAccountId || '');
    const backendActive = (appCenterState.accounts || []).find(a => a.id === backendActiveId);
    // When the operator has entered an installed platform that has no account
    // yet, keep that empty platform shell stable instead of jumping to the last
    // account that happened to be active in another application.
    if (externalGlobalAggregateActive && shellSurface === 'external') {
      if (externalAggregateSelected) {
        activeExternalPlatform = String(externalAggregateSelected.platform || activeExternalPlatform || '');
        activeExternalAccountId = String(backendActiveId || externalAggregateSelected.accountId || activeExternalAccountId || '');
      } else {
        activeExternalAccountId = '';
      }
    } else if (shellSurface === 'external' && activeExternalPlatform) {
      const current = (appCenterState.accounts || []).find(a => String(a.id || '') === String(activeExternalAccountId || '') && String(a.platform || '') === String(activeExternalPlatform || ''));
      if (backendActive && String(backendActive.platform || '') === String(activeExternalPlatform || '')) {
        activeExternalAccountId = backendActiveId;
      } else if (current) {
        // V1.27.22: a passive App Center update from a background platform must
        // never clear/switch the operator's explicit external workspace.
        activeExternalAccountId = String(current.id || '');
      } else {
        const fallback = (appCenterState.accounts || []).find(a => String(a.platform || '') === String(activeExternalPlatform || ''));
        activeExternalAccountId = String(fallback?.id || '');
      }
    } else {
      activeExternalAccountId = backendActiveId;
      if (backendActive) activeExternalPlatform = backendActive.platform;
      else if (shellSurface !== 'external') activeExternalPlatform = '';
    }
    renderAppCenter();
    if (!quiet) setStatus('应用状态已刷新');
  } catch (error) {
    if (!quiet) setStatus('应用中心读取失败：' + (error?.message || error));
  }
}

async function openAppCenter(pane = 'apps') {
  externalGlobalAggregateActive = false;
  if (externalAggregateRefreshTimer) { clearInterval(externalAggregateRefreshTimer); externalAggregateRefreshTimer = null; }
  if (appCenterStartupTimer) { clearTimeout(appCenterStartupTimer); appCenterStartupTimer = null; }
  appCenterOpen = true;
  setAppCenterPane(pane);
  setShellBodyClass('app-center');
  // V1.23.8: native WebContentsViews render above normal HTML. Hide them
  // immediately when entering Home/App Center, before any async state refresh,
  // so a still-loading TikTok/FB/IG view cannot cover the dashboard.
  try { await window.yoko.setNativeViewsVisible?.(false); } catch {}
  try { await window.yoko.setShellSurface?.('app-center'); } catch {}
  await refreshAppCenterState({ quiet: true });
  if (pane === 'home') await refreshOperationsDashboard({ quiet:true });
  setStatus(pane === 'home' ? '数据中心' : '应用中心');
}


async function openGlobalExternalAggregate() {
  externalGlobalAggregateActive = true;
  appCenterOpen = false;
  externalAggregatePlatformFilter = '';
  externalAggregateAccountFilter = '';
  externalAggregateSearch = '';
  externalAggregateSelectedKey = '';
  externalAggregateSelected = null;
  externalAggregateCrmContext = null;
  stopExternalTikTokCrmSync();
  setQuickAddAppMenu(false);
  setQuickRemoveAppMenu(false);

  // Keep native views suppressed until an actual customer is selected. The
  // global desk itself is normal renderer HTML, while customer replies still
  // use the selected platform's native WebContentsView in the center.
  try { await window.yoko.setNativeViewsVisible?.(false); } catch {}
  try { await window.yoko.setShellSurface?.('external-aggregate'); } catch {}
  setShellBodyClass('external');
  renderExternalWorkspace();
  await refreshGlobalExternalAggregate({ remote:false, quiet:true });
  renderExternalWorkspace();
  setExternalStatus(`全平台聚合 · ${externalAggregateInbox?.conversations?.length || 0} 个客户`);

  // A full platform rescan can be expensive, so paint cache first and refresh
  // remotely afterwards instead of blocking entry to the workspace.
  refreshGlobalExternalAggregate({ remote:true, quiet:true }).then(() => {
    if (externalGlobalAggregateActive && shellSurface === 'external') {
      renderExternalWorkspace();
      setExternalStatus(`全平台聚合 · ${externalAggregateInbox?.conversations?.length || 0} 个客户 · ${externalAggregateInbox?.unreadCount || 0} 条未读`);
    }
  }).catch(() => {});
  startExternalAggregateRefreshTimer();
}

async function closeAppCenter() {
  return enterLineWorkspace();
}

async function enterLineWorkspace(mode = '') {
  externalGlobalAggregateActive = false;
  if (externalAggregateRefreshTimer) { clearInterval(externalAggregateRefreshTimer); externalAggregateRefreshTimer = null; }
  appCenterOpen = false;
  setShellBodyClass('line');
  try { await window.yoko.setShellSurface?.('line'); } catch {}
  try { await window.yoko.setNativeViewsVisible?.(true); } catch {}
  if (mode === 'aggregate' || mode === 'line') await setWorkspaceMode(mode);
  else setStatus(workspaceMode === 'aggregate' ? '聚合模式' : 'LINE模式');
}

function externalAccountById(id) {
  return (appCenterState.accounts || []).find(a => a.id === String(id || '')) || null;
}

function setExternalStatus(message) {
  const el = $('#externalWorkspaceStatus');
  if (el) el.textContent = String(message || '');
  setStatus(message);
}

function externalOpsAccounts() {
  const installed = new Set(externalGlobalInstalledPlatforms().map(item => item.id));
  return (appCenterState.accounts || []).filter(account =>
    installed.has(String(account.platform || '')) && EXTERNAL_GLOBAL_AGGREGATE_PLATFORMS.includes(String(account.platform || ''))
  );
}

function renderExternalOps() {
  const accounts = externalOpsAccounts();
  const running = accounts.filter(account => account.isOpen).length;
  const platforms = new Set(accounts.map(account => String(account.platform || '')).filter(Boolean));
  if ($('#externalOpsTotal')) $('#externalOpsTotal').textContent = String(accounts.length);
  if ($('#externalOpsRunning')) $('#externalOpsRunning').textContent = String(running);
  if ($('#externalOpsClosed')) $('#externalOpsClosed').textContent = String(Math.max(0, accounts.length - running));
  if ($('#externalOpsPlatforms')) $('#externalOpsPlatforms').textContent = String(externalGlobalInstalledPlatforms().length);
  if ($('#externalOpsUpdatedAt')) $('#externalOpsUpdatedAt').textContent = `更新 ${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;

  const list = $('#externalOpsList');
  if (!list) return;
  list.innerHTML = accounts.length ? accounts.map(account => {
    const def = externalGlobalPlatformMeta(account.platform);
    const proxy = account.proxy?.enabled
      ? `${String(account.proxy.protocol || 'socks5').toUpperCase()} · ${account.proxy.host || '已配置'}`
      : '直连';
    return `<div class="external-ops-account-row">
      <span class="external-ops-account-platform platform-${escapeHtml(account.platform || '')}">${escapeHtml(def.short || def.name.slice(0,2))}</span>
      <span class="external-ops-account-copy"><strong>${escapeHtml(account.name || account.id)}</strong><small>${escapeHtml(def.name)} · 独立 Profile / Session</small></span>
      <span class="external-ops-account-state ${account.isOpen ? 'running' : 'closed'}">${account.isOpen ? '运行中' : '已关闭'}</span>
      <span class="external-ops-account-proxy">${escapeHtml(proxy)}</span>
    </div>`;
  }).join('') : '<div class="ops-health-empty">还没有非 LINE 平台账号。</div>';
}

async function openExternalOpsModal() {
  renderExternalOps();
  await openModal('externalOpsModal');
}

async function diagnoseExternalGlobalAccount() {
  const accountId = String(externalAggregateSelected?.accountId || activeExternalAccountId || '');
  const account = externalAccountById(accountId);
  const title = $('#diagModalTitle');
  const text = $('#diagText');
  if (title) title.textContent = '非 LINE 账号诊断';
  if (!account) {
    if (text) text.textContent = '请先在左侧选择一个客户。\n\n账号诊断会检查该客户来源账号的运行状态、代理配置和网络连通性。';
    await openModal('diagModal');
    return;
  }
  const def = externalGlobalPlatformMeta(account.platform);
  if (text) text.textContent = '正在诊断…';
  await openModal('diagModal');
  let network = null;
  try { network = await window.yoko.testAppCenterAccountNetwork?.(account.id); }
  catch (error) { network = { ok:false, error:error?.message || String(error) }; }
  const lines = [
    `平台：${def.name}`,
    `账号：${account.name || account.id}`,
    `账号 ID：${account.id}`,
    `运行状态：${account.isOpen ? '运行中' : '已关闭'}`,
    `独立 Profile / Session：已隔离`,
    `代理：${account.proxy?.enabled ? `${String(account.proxy.protocol || 'socks5').toUpperCase()} ${account.proxy.host || ''}:${account.proxy.port || ''}` : '直连'}`,
    '',
    '线路测试：',
    network?.ok
      ? `正常 · IP ${network.ip || '-'} · ${network.latencyMs || 0}ms · ${network.mode === 'proxy' ? '代理' : '直连'}`
      : `失败 · ${network?.error || '未知错误'}`
  ];
  if (text) text.textContent = lines.join('\n');
}


async function saveExternalInlineAccountRemark(account, input, originalRemark) {
  const value = String(input?.value || '').trim();
  try {
    const updated = await window.yoko.updateAppCenterAccountRemark(account.id, value);
    account.remark = String(updated?.remark ?? value);
    setExternalStatus(`窗口备注已保存：${account.remark || account.name}`);
    await refreshAppCenterState({ quiet:true });
  } catch (error) {
    account.remark = originalRemark;
    setExternalStatus('窗口备注保存失败：' + (error?.message || error));
  }
  renderExternalWorkspace();
}

async function saveExternalInlineAccountPhone(account, input, originalPhone) {
  const value = String(input?.value || '').trim();
  try {
    const updated = await window.yoko.updateAppCenterAccountPhone(account.id, value);
    account.phoneNumber = String(updated?.phoneNumber ?? value);
    await refreshAppCenterState({ quiet:true });
    renderExternalWorkspace();
    setExternalStatus(`WS号码已保存：${account.phoneNumber || '未填写'}`);
  } catch (error) {
    account.phoneNumber = originalPhone;
    renderExternalWorkspace();
    setExternalStatus('WS号码保存失败：' + (error?.message || error));
  }
}

function beginExternalInlineAccountPhoneEdit(account, row) {
  const target = row?.querySelector('.external-account-phone');
  if (!target || row.querySelector('.external-account-phone-input')) return;
  const originalPhone = String(account.phoneNumber || '');
  const input = document.createElement('input');
  input.type = 'tel';
  input.maxLength = 40;
  input.className = 'external-account-phone-input';
  input.value = originalPhone;
  input.placeholder = '例如 +255 712 345 678';
  const editor = document.createElement('span');
  editor.className = 'external-account-phone-editor';
  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'external-account-phone-save';
  saveButton.textContent = '保存';
  editor.append(input, saveButton);
  target.replaceWith(editor);
  let done = false;
  const finish = async save => {
    if (done) return;
    done = true;
    if (save) await saveExternalInlineAccountPhone(account, input, originalPhone);
    else renderExternalWorkspace();
  };
  input.addEventListener('click', event => event.stopPropagation());
  input.addEventListener('pointerdown', event => event.stopPropagation());
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') { event.preventDefault(); event.stopImmediatePropagation(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  saveButton.addEventListener('pointerdown', event => event.preventDefault());
  saveButton.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); finish(true); });
  requestAnimationFrame(() => { input.focus(); input.select(); });
}

function beginExternalInlineAccountRemarkEdit(account, row) {
  const target = row?.querySelector('.external-account-remark');
  if (!target || row.querySelector('.external-account-remark-input')) return;
  const originalRemark = String(account.remark || '');
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 80;
  input.className = 'external-account-remark-input';
  input.value = originalRemark;
  input.placeholder = '填写窗口备注';
  const editor = document.createElement('span');
  editor.className = 'external-account-remark-editor';
  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'external-account-remark-save';
  saveButton.textContent = '保存';
  saveButton.title = '保存窗口备注（Enter）';
  editor.append(input, saveButton);
  target.replaceWith(editor);
  let done = false;
  const finish = async save => {
    if (done) return;
    done = true;
    if (save) await saveExternalInlineAccountRemark(account, input, originalRemark);
    else renderExternalWorkspace();
  };
  input.addEventListener('click', event => event.stopPropagation());
  input.addEventListener('pointerdown', event => event.stopPropagation());
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') { event.preventDefault(); event.stopImmediatePropagation(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  saveButton.addEventListener('pointerdown', event => event.preventDefault());
  saveButton.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); finish(true); });
  requestAnimationFrame(() => { input.focus(); input.select(); });
}


function renderGlobalExternalWorkspace() {
  const page = $('#externalWorkspacePage');
  page?.classList.add('aggregate-active', 'global-aggregate-active');
  page?.classList.toggle('external-sidebar-collapsed', externalAccountSidebarCollapsed);

  $('#externalWorkspaceModes')?.classList.add('hidden');
  $('#externalAggregateQueueControls')?.classList.remove('hidden');
  $('#externalWaitingCenterBtn')?.classList.add('hidden');
  $('#externalAddAccountBtn')?.classList.add('hidden');
  $('#externalManageBtn')?.classList.add('hidden');
  $('#externalLineIdSettingsBtn')?.classList.add('hidden');
  $('#externalCrmToolbarToggleBtn')?.classList.add('hidden');

  const icon = $('#externalWorkspaceIcon');
  if (icon) {
    icon.textContent = '◎';
    icon.className = 'external-workspace-icon global-aggregate-icon';
  }
  if ($('#externalWorkspaceTitle')) $('#externalWorkspaceTitle').textContent = '全平台聚合';
  const platforms = externalGlobalInstalledPlatforms();
  if ($('#externalWorkspaceAccountLabel')) {
    $('#externalWorkspaceAccountLabel').textContent = `${platforms.length} 个平台 · ${externalAggregateInbox?.accounts?.length || 0} 个账号 · ${externalAggregateInbox?.conversations?.length || 0} 个客户`;
  }
  if ($('#externalAccountSidebarTitle')) $('#externalAccountSidebarTitle').textContent = '全平台客户';
  $('#externalAggregateTools')?.classList.remove('hidden');
  $('#externalBulkAccountControls')?.classList.add('hidden');
  $('#externalAccountSidebarToggle')?.classList.remove('hidden');
  const globalSidebarToggle = $('#externalAccountSidebarToggle');
  if (globalSidebarToggle) {
    globalSidebarToggle.textContent = externalAccountSidebarCollapsed ? '▶' : '◀';
    globalSidebarToggle.title = externalAccountSidebarCollapsed ? '展开客户栏' : '收起客户栏';
    globalSidebarToggle.setAttribute('aria-label', globalSidebarToggle.title);
  }
  if ($('#externalWorkspaceVersionBadge')) $('#externalWorkspaceVersionBadge').textContent = 'V' + (state?.version || '1.23.14');

  ensureExternalCrmStageOptions(externalAggregateCrmContext?.crm?.stage || '');
  const collapsed = externalCrmCollapsedFor(EXTERNAL_GLOBAL_PLATFORM.id);
  $('#externalCrmPanel')?.classList.toggle('hidden', collapsed);
  page?.classList.toggle('crm-collapsed', collapsed);
  applyExternalCrmCollapseState(EXTERNAL_GLOBAL_PLATFORM.id).catch(() => {});

  const placeholder = $('#externalViewPlaceholder');
  if (placeholder) {
    const strong = placeholder.querySelector('strong');
    const span = placeholder.querySelector('span');
    if (strong) strong.textContent = externalAggregateSelected ? `正在打开 ${externalAggregateSelected.displayName || '客户'}…` : '请选择左侧任意平台客户';
    if (span) span.textContent = '客户列表统一聚合；点击后会使用他的来源平台、来源账号和独立 Session 在这里打开真实会话';
  }

  renderExternalAggregateFilters();
  renderExternalAggregateCustomers();
  renderExternalCustomerStats();
  if (!externalAggregateSelected && !externalAggregateCrmContext && !externalTikTokCrmLastGoodItem) resetExternalCrmPanel();
  renderInstalledAppRail();

  if (externalAggregateSelected && activeExternalAccountId && externalPlatformHasCrm(activeExternalPlatform)) startExternalTikTokCrmSync();
  else stopExternalTikTokCrmSync();
}

function renderExternalWorkspace() {
  if (externalGlobalAggregateActive) return renderGlobalExternalWorkspace();
  const account = externalAccountById(activeExternalAccountId);
  const platform = account ? appCenterPlatformById(account.platform) : appCenterPlatformById(activeExternalPlatform);
  if (!platform) return;
  activeExternalPlatform = platform.id;
  const aggregateMode = externalPlatformHasAggregateWorkspace(platform.id) && externalWorkspaceModeFor(platform.id) === 'aggregate';
  const page = $('#externalWorkspacePage');
  page?.classList.remove('global-aggregate-active');
  page?.classList.toggle('aggregate-active', aggregateMode);
  $('#externalAddAccountBtn')?.classList.remove('hidden');
  $('#externalManageBtn')?.classList.remove('hidden');

  const modes = $('#externalWorkspaceModes');
  const metaNativeOnly = platform.id === 'metabusiness';
  modes?.classList.toggle('hidden', metaNativeOnly || !externalPlatformHasAggregateWorkspace(platform.id));
  $('#externalAggregateQueueControls')?.classList.toggle('hidden', metaNativeOnly || !aggregateMode);
  // V1.27.41: MB waiting/round-robin depended on the removed software aggregate
  // list. Hide that entry instead of silently switching the operator back into
  // a second customer list. Native MB now uses Meta's own inbox directly.
  $('#externalWaitingCenterBtn')?.classList.toggle('hidden', metaNativeOnly || aggregateMode);
  if ($('#externalAggregateModeBtn')) {
    $('#externalAggregateModeBtn').textContent = `${platform.short || 'TK'}聚合模式`;
    $('#externalAggregateModeBtn').classList.toggle('active', aggregateMode);
  }
  if ($('#externalNativeModeBtn')) {
    $('#externalNativeModeBtn').textContent = `${platform.short || 'TK'}模式`;
    $('#externalNativeModeBtn').classList.toggle('active', !aggregateMode);
  }

  const icon = $('#externalWorkspaceIcon');
  if (icon) {
    icon.textContent = platform.short || platform.name.slice(0,2);
    icon.className = `external-workspace-icon platform-${platform.id}`;
  }
  if ($('#externalWorkspaceTitle')) $('#externalWorkspaceTitle').textContent = platform.name;
  if ($('#externalWorkspaceAccountLabel')) $('#externalWorkspaceAccountLabel').textContent = aggregateMode
    ? `聚合 ${externalAggregateInbox.accounts?.length || appCenterAccountsFor(platform.id).length} 个账号 · ${externalAggregateInbox.conversations?.length || 0} 个客户`
    : (account?.name || '请选择账号');
  if ($('#externalAccountSidebarTitle')) $('#externalAccountSidebarTitle').textContent = aggregateMode ? `${platform.name} 客户` : `${platform.name} 账号`;
  $('#externalAggregateTools')?.classList.toggle('hidden', !aggregateMode);
  $('#externalBulkAccountControls')?.classList.toggle('hidden', aggregateMode);
  // V1.27.215: Facebook native workspace gets a real browser Back control.
  // Aggregate mode is renderer HTML, so the browser-history button is hidden there.
  $('#externalBackBtn')?.classList.toggle('hidden', aggregateMode || platform.id !== 'facebook' || !account);
  $('#externalAccountSidebarToggle')?.classList.remove('hidden');
  $('#externalWorkspacePage')?.classList.toggle('external-sidebar-collapsed', externalAccountSidebarCollapsed);
  const externalSidebarToggle = $('#externalAccountSidebarToggle');
  if (externalSidebarToggle) {
    externalSidebarToggle.textContent = externalAccountSidebarCollapsed ? '▶' : '◀';
    externalSidebarToggle.title = externalAccountSidebarCollapsed
      ? (aggregateMode ? '展开客户栏' : '展开账号栏')
      : (aggregateMode ? '收起客户栏' : '收起账号栏');
    externalSidebarToggle.setAttribute('aria-label', externalSidebarToggle.title);
  }
  const showExternalCrm = externalPlatformHasCrm(platform.id);
  if (showExternalCrm && platform.id !== 'line') ensureExternalCrmStageOptions();
  if ($('#externalWorkspaceVersionBadge')) $('#externalWorkspaceVersionBadge').textContent = 'V' + (state?.version || '1.22.0');
  $('#externalCrmPanel')?.classList.toggle('hidden', !showExternalCrm || externalCrmCollapsedFor(platform.id));
  $('#externalCrmToolbarToggleBtn')?.classList.toggle('hidden', !showExternalCrm);
  // V1.21.15: global LINE settings are shared by every non-LINE platform.
  // They remain available even before a platform's CRM adapter is implemented.
  $('#externalLineIdSettingsBtn')?.classList.toggle('hidden', platform.id === 'line');
  $('#externalWorkspacePage')?.classList.toggle('crm-collapsed', showExternalCrm && externalCrmCollapsedFor(platform.id));
  // Keep the embedded browser width synchronized with this platform's CRM state.
  applyExternalCrmCollapseState(platform.id).catch(() => {});
  const placeholder = $('#externalViewPlaceholder');
  if (placeholder) {
    const strong = placeholder.querySelector('strong');
    const span = placeholder.querySelector('span');
    if (strong) strong.textContent = aggregateMode ? `请选择左侧 ${platform.name} 客户` : (account ? '正在打开应用…' : `请先新建一个 ${platform.short || platform.name} 账号`);
    if (span) span.textContent = aggregateMode ? `点击客户后会自动切到他的来源 ${platform.short || platform.name} 账号和对应会话` : (account ? '网页工作区会显示在这里' : '点击顶部“＋ 新增账号”创建独立登录环境');
  }

  if (aggregateMode) {
    renderExternalAggregateFilters();
    renderExternalAggregateCustomers();
    if (!externalAggregateSelected && !externalAggregateCrmContext && !externalTikTokCrmLastGoodItem) resetExternalCrmPanel(platform.id);
  } else {
    // V1.20.2: account position is fixed. Clicking a lower account must not
    // promote it to the top just because lastOpenedAt changed.
    const accounts = appCenterAccountsFor(platform.id).slice();
    if ($('#externalAccountSidebarCount')) $('#externalAccountSidebarCount').textContent = String(accounts.length);
    const list = $('#externalAccountSidebarList');
    if (list) {
      // Keep the inline WS/account remark editor mounted while the background
      // account-status polling repaints the sidebar. Replacing innerHTML during
      // typing used to blur and prematurely save an empty/partial remark.
      const inlineRemarkEditing = !!list.querySelector('.external-account-remark-input, .external-account-phone-input');
      if (!inlineRemarkEditing) list.innerHTML = accounts.length ? accounts.map(item => {
        const proxyText = item.proxy?.enabled ? `${String(item.proxy.protocol || 'socks5').toUpperCase()}代理` : '直连';
        const phoneText = String(item.phoneNumber || '').trim();
        const accountIdentifierHtml = platform.id === 'whatsapp'
          ? `<small class="external-account-phone" data-external-sidebar-action="phone" title="点击填写或修改 WhatsApp 号码">WS号码：${escapeHtml(phoneText || '点击填写')} ✎</small>`
          : `<small class="external-account-remark" data-external-sidebar-action="remark" title="点击修改窗口备注">备注：${escapeHtml(String(item.remark || '').trim() || '未设置')} ✎</small>`;
        return `<div class="external-account-item${item.id === activeExternalAccountId ? ' active' : ''}${item.isOpen ? ' open' : ''}" role="button" tabindex="0" data-external-account-id="${escapeHtml(item.id)}">
          <span class="external-account-drag-handle" data-external-account-drag-id="${escapeHtml(item.id)}" title="按住卡片空白处拖动排序" aria-label="拖动账号排序">⠿</span>
          <span class="external-account-avatar platform-${escapeHtml(platform.id)}">${escapeHtml(platform.short)}</span>
          <span class="external-account-copy">
            <strong>${escapeHtml(item.name)}</strong>
            <small class="external-account-proxy">${escapeHtml(proxyText)}</small>
            ${accountIdentifierHtml}
          </span>
          <span class="external-account-actions">
            <button type="button" class="external-account-icon-btn ${item.isOpen ? 'stop' : 'start'}" data-external-sidebar-action="toggle" title="${item.isOpen ? '关闭这个账号窗口' : '开启这个账号窗口'}" aria-label="${item.isOpen ? '关闭账号' : '开启账号'}">${item.isOpen ? '⏹' : '▶'}</button>
            <span class="external-account-online-state ${item.isOpen ? 'online' : 'offline'}">${item.isOpen ? '在线' : '离线'}</span>
            <button type="button" class="external-account-icon-btn danger" data-external-sidebar-action="delete" title="删除这个账号" aria-label="删除账号">×</button>
          </span>
        </div>`;
      }).join('') : '<div class="external-account-empty">还没有账号。<br>点击上方“新增账号”。</div>';
    }
  }
  renderExternalCustomerStats();
  renderInstalledAppRail();
  if (externalPlatformHasCrm(platform.id) && activeExternalAccountId) startExternalTikTokCrmSync();
  else stopExternalTikTokCrmSync();
}
async function openExternalAccount(accountId) {
  externalGlobalAggregateActive = false;
  accountId = String(accountId || '').trim();
  const account = externalAccountById(accountId);
  if (!account) return;
  activeExternalAccountId = account.id;
  activeExternalPlatform = account.platform;
  appCenterOpen = false;
  setShellBodyClass('external');
  renderExternalWorkspace();
  setExternalStatus(`正在打开 ${account.name}…`);
  try {
    // V1.23.8: setShellSurface('external') already restores/creates the account
    // runtime with activate:false and then commits the surface atomically. Do
    // not call openAppCenterAccount() first: that older path activates the
    // external surface independently and can race a later Home click.
    const surfaceResult = await window.yoko.setShellSurface?.('external', account.id);
    if (surfaceResult?.stale) return;
    try { await window.yoko.setNativeViewsVisible?.(true); } catch {}
    const externalMode = externalWorkspaceModeFor(account.platform);
    await window.yoko.setExternalWorkspaceMode?.(account.platform, externalMode);
    await window.yoko.setExternalAccountSidebarCollapsed?.(externalAccountSidebarCollapsed);
    await refreshAppCenterState({ quiet: true });
    activeExternalAccountId = account.id;
    activeExternalPlatform = account.platform;
    await loadExternalCustomerStatsCache(account.platform);
    renderExternalWorkspace();
    if (externalPlatformHasAggregateWorkspace(account.platform) && externalWorkspaceModeFor(account.platform) === 'aggregate') {
      await refreshExternalAggregate({ remote:true, quiet:true });
      const short = appCenterPlatformById(account.platform)?.short || account.platform.toUpperCase();
      setExternalStatus(`${short}聚合 · ${externalAggregateInbox.conversations?.length || 0} 个客户`);
    } else {
      setExternalStatus(`${account.name} · ${account.proxy?.enabled ? '独立代理已启用' : '直连'}`);
    }
    startExternalAggregateRefreshTimer();
  } catch (error) {
    const message = String(error?.message || error || '打开失败');
    setExternalStatus('打开应用失败：' + message);

    // V1.27.213: never eject Facebook back to App Center on a network/login
    // navigation failure. Keep the external shell visible so the real Chromium
    // error state and diagnostics can be inspected and retried in place.
    if (String(account.platform || '') === 'facebook') {
      appCenterOpen = false;
      setShellBodyClass('external');
      activeExternalAccountId = account.id;
      activeExternalPlatform = account.platform;
      renderExternalWorkspace();
      try { await window.yoko.setNativeViewsVisible?.(true); } catch {}
      return;
    }
    await openAppCenter('apps');
  }
}

function externalPlatformHasAggregateWorkspace(platform) {
  // V1.27.41: Meta Business intentionally has no software aggregate workspace.
  // The official MB inbox/customer list is the only customer-list authority.
  return ['tiktok','facebook','instagram','whatsapp','telegram'].includes(String(platform || '').trim());
}


async function ensureAndOpenPlatform(platform) {
  externalGlobalAggregateActive = false;
  platform = String(platform || '').trim();
  const accounts = appCenterAccountsFor(platform);
  try {
    // Every non-LINE application opens in its native/platform mode by default.
    persistExternalWorkspaceMode(platform, 'native');
    const target = accounts.find(a => a.id === activeExternalAccountId) || accounts[0] || null;
    if (target) {
      await openExternalAccount(target.id);
      return;
    }
    // No account yet: enter the platform shell without creating anything.
    // The operator creates the first account from the platform's own toolbar.
    activeExternalPlatform = platform;
    activeExternalAccountId = '';
    appCenterOpen = false;
    setShellBodyClass('external');
    await loadExternalCustomerStatsCache(platform);
    renderExternalWorkspace();
    setExternalStatus(`${appCenterPlatformById(platform)?.name || platform} · 尚未创建账号`);
  } catch (error) {
    setStatus('打开应用失败：' + (error?.message || error));
  }
}

async function installPlatform(platform) {
  platform = String(platform || '').trim();
  try {
    const def = platform === 'line' ? APP_CENTER_LINE_CARD : appCenterPlatformById(platform);
    await window.yoko.installAppCenterPlatform?.(platform);
    await refreshAppCenterState({ quiet: true });
    // V1.22.0: "添加应用" only pins the application to the left rail.
    // Account creation belongs inside the platform workspace via "＋ 新增账号".
    setStatus(`${def?.name || platform} 已添加到左侧${platform === 'line' ? '' : ' · 进入应用后再新建账号'}`);
  } catch (error) {
    setStatus('添加应用失败：' + (error?.message || error));
  }
}

async function removePlatform(platform) {
  platform = String(platform || '').trim();
  try {
    const def = platform === 'line' ? APP_CENTER_LINE_CARD : appCenterPlatformById(platform);
    await window.yoko.removeAppCenterPlatform?.(platform);
    if ((platform === 'line' && shellSurface === 'line') || (shellSurface === 'external' && activeExternalPlatform === platform)) {
      activeExternalAccountId = '';
      activeExternalPlatform = '';
      setShellBodyClass('app-center');
      setAppCenterPane('apps');
      try { await window.yoko.setShellSurface?.('app-center'); } catch {}
    }
    await refreshAppCenterState({ quiet: true });
    setStatus(`${def?.name || platform} 已从左侧移除 · 账号和登录数据已保留`);
  } catch (error) {
    setStatus('移除应用失败：' + (error?.message || error));
  }
}

function renderAppAccountManager() {
  const platform = appCenterPlatformById(appAccountManagingPlatform);
  const list = $('#appAccountList');
  if (!list || !platform) return;
  $('#appAccountModalTitle').textContent = `${platform.name} · 账号管理`;
  $('#appAccountModalMeta').textContent = '每个账号独立 Cookie / LocalStorage / Chromium Profile / 代理';
  const accounts = appCenterAccountsFor(platform.id);
  if (!accounts.length) {
    list.innerHTML = '<div class="app-account-empty">还没有账号。点击上方“新增账号”即可创建独立登录环境。</div>';
    return;
  }
  list.innerHTML = accounts.map(account => `
    <div class="app-account-row" data-app-account-id="${escapeHtml(account.id)}">
      <span class="app-account-drag-handle" data-app-account-drag-id="${escapeHtml(account.id)}" title="按住卡片空白处拖动排序" aria-label="拖动排序">⠿</span>
      <span class="app-account-avatar platform-${escapeHtml(platform.id)}">${escapeHtml(platform.short)}</span>
      <span class="app-account-name"><strong>${escapeHtml(account.name)}</strong><small>${account.isOpen ? '运行中' : '已关闭'} · ${account.proxy?.enabled ? `${String(account.proxy.protocol || 'socks5').toUpperCase()}代理` : '直连'}</small>${platform.id === 'whatsapp' ? `<small class="app-account-phone">WS号码：${escapeHtml(String(account.phoneNumber || '').trim() || '未填写')}</small>` : ''}</span>
      <div class="app-account-row-actions">
        <button type="button" data-app-account-action="${account.isOpen ? 'close' : 'open'}">${account.isOpen ? '关闭' : '打开'}</button>
        <button type="button" data-app-account-action="proxy">代理</button>
        <button type="button" data-app-account-action="rename">重命名</button>
        <button type="button" class="danger" data-app-account-action="delete">删除</button>
      </div>
    </div>`).join('');
}

async function openAppAccountManager(platform) {
  appAccountManagingPlatform = String(platform || '');
  if ($('#appAccountNewName')) $('#appAccountNewName').value = '';
  await refreshAppCenterState({ quiet: true });
  renderAppAccountManager();
  await openModal('appAccountModal');
}

function collectAppProxyForm() {
  return {
    enabled: !!$('#appProxyEnabled')?.checked,
    protocol: String($('#appProxyProtocol')?.value || 'socks5'),
    host: String($('#appProxyHost')?.value || '').trim(),
    port: Number($('#appProxyPort')?.value || 0),
    auth: !!$('#appProxyAuth')?.checked,
    username: String($('#appProxyUsername')?.value || ''),
    password: String($('#appProxyPassword')?.value || '')
  };
}

async function openAppProxyModal(accountId) {
  const account = externalAccountById(accountId);
  if (!account) return;
  appProxyEditingAccountId = account.id;
  const platform = appCenterPlatformById(account.platform);
  if ($('#appProxyModalTitle')) $('#appProxyModalTitle').textContent = `${platform?.name || '应用'} · 独立代理`;
  if ($('#appProxyAccountLabel')) $('#appProxyAccountLabel').textContent = account.name;
  const proxy = account.proxy || {};
  $('#appProxyEnabled').checked = proxy.enabled === true;
  $('#appProxyProtocol').value = proxy.protocol || 'socks5';
  $('#appProxyHost').value = proxy.host || '';
  $('#appProxyPort').value = proxy.port || '';
  $('#appProxyAuth').checked = proxy.auth === true;
  $('#appProxyUsername').value = proxy.username || '';
  $('#appProxyPassword').value = proxy.password || '';
  if ($('#appProxyTestResult')) $('#appProxyTestResult').textContent = '最近测速：未测试';
  await openModal('appProxyModal');
  // Native WhatsApp Chromium must not sit above the HTML modal and intercept
  // pointer/keyboard events. Focus an actual form control after suppression.
  try { await window.yoko.setNativeViewsVisible?.(false); } catch {}
  requestAnimationFrame(()=>($('#appProxyHost') || $('#appProxyEnabled'))?.focus());
}

let softwareUpdateState = null;

function renderSoftwareUpdateState(next) {
  if (!next) return;
  softwareUpdateState = { ...(softwareUpdateState || {}), ...next };
  const current = $('#updateCurrentVersion');
  const latest = $('#updateLatestVersion');
  const box = $('#softwareUpdateStatus');
  const downloadBtn = $('#downloadUpdateBtn');
  const installBtn = $('#installUpdateBtn');
  if (current) current.textContent = 'V' + (softwareUpdateState.currentVersion || state?.version || '-');
  if (latest) latest.textContent = softwareUpdateState.latestVersion ? 'V' + softwareUpdateState.latestVersion : '-';
  if (box) {
    const error = softwareUpdateState.error ? `\n${softwareUpdateState.error}` : '';
    box.className = 'ai-test-result ' + (softwareUpdateState.status === 'error' ? 'error' : softwareUpdateState.status === 'up-to-date' || softwareUpdateState.status === 'downloaded' ? 'ok' : '');
    box.textContent = `${softwareUpdateState.message || '尚未检查更新'}${error}`;
  }
  if (downloadBtn) downloadBtn.disabled = softwareUpdateState.status !== 'available';
  if (installBtn) installBtn.disabled = softwareUpdateState.status !== 'downloaded';
  if (['available','downloading','downloaded'].includes(softwareUpdateState.status)) {
    setStatus(softwareUpdateState.message || '发现软件更新');
  }
}

async function openModal(id) {
  try {
    if (typeof window.yoko.setNativeViewsVisible === 'function') await window.yoko.setNativeViewsVisible(false);
    else await window.yoko.setLineViewVisible(false);
  } catch {}
  $('#' + id).classList.remove('hidden');
  // Native WebContentsViews live above renderer HTML. Reassert suppression after
  // the modal paints so no external page can steal clicks from Settings/Save.
  if (typeof window.yoko.setNativeViewsVisible === 'function') {
    setTimeout(() => window.yoko.setNativeViewsVisible(false).catch(() => {}), 80);
    setTimeout(() => window.yoko.setNativeViewsVisible(false).catch(() => {}), 260);
  }
}

async function closeModal(id) {
  $('#' + id).classList.add('hidden');
  if(id==='handoffHealthModal' && handoffHealthTransientRefreshTimer){clearTimeout(handoffHealthTransientRefreshTimer);handoffHealthTransientRefreshTimer=null;}
  if(id==='stabilityDiagnosticsModal' && stabilityDiagnosticsTimer){clearInterval(stabilityDiagnosticsTimer);stabilityDiagnosticsTimer=null;}
  if(id==='performanceDiagnosticsModal' && performanceDiagnosticsTimer){clearInterval(performanceDiagnosticsTimer);performanceDiagnosticsTimer=null;}
  if(id==='nativeApiBulkModal' && nativeApiBulkPollTimer){clearInterval(nativeApiBulkPollTimer);nativeApiBulkPollTimer=null;}
  const anyOpen = [...document.querySelectorAll('.modal')]
    .some(m => !m.classList.contains('hidden'));

  if (!anyOpen) {
    try {
      if (typeof window.yoko.setNativeViewsVisible === 'function') await window.yoko.setNativeViewsVisible(true);
      else if (!appCenterOpen) await window.yoko.setLineViewVisible(true);
    } catch {}
  }
}

document.querySelectorAll('[data-close]').forEach(button => {
  button.addEventListener(
    'click',
    () => closeModal(button.dataset.close)
  );
});

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}


let teamSyncUiState = null;

function teamTaskStatusLabel(status = '') {
  return ({ pending:'待接单', accepted:'已接单待绑定', bound:'已绑定LINE', completed:'已完成', cancelled:'已取消' })[String(status || '')] || String(status || '待接单');
}

const TEAM_FIXED_PUBLIC_URL='https://team.dalongvpn.cc.cd';
// V1.27.187 — portable team connection bundle for additional workstations.
// The bundle intentionally contains only the shared team/VPS connection secret.
// It never exports customers, cookies, sessions, proxy credentials, GPT bindings,
// local device identity, LINE mappings, or account login state.
const TEAM_CONNECTION_BUNDLE_TYPE='yoko-scrm-team-connection';
const TEAM_CONNECTION_BUNDLE_VERSION=1;
const TEAM_CONNECTION_CODE_PREFIX='YOKO-TEAM-1.';
function teamSyncCloudflareMode(mode='') { return ['server-cloudflare-quick','server-cloudflare-token'].includes(String(mode||'')); }
function teamConnectionTransferStatus(message='',kind=''){
  const el=$('#teamSyncConnectionTransferStatus'); if(!el)return;
  el.textContent=String(message||'');
  el.classList.remove('ok','error');
  if(kind==='ok'||kind==='error')el.classList.add(kind);
}
function teamConnectionBundleNormalize(raw={}){
  const source=raw&&typeof raw==='object'?raw:{};
  const serverUrl=String(source.serverUrl||source.cloudflarePublicUrl||'').trim().replace(/\/+$/,'');
  const teamId=String(source.teamId||'').trim();
  const apiKey=String(source.apiKey||source.syncKey||'').trim();
  if(!serverUrl)throw new Error('连接配置缺少 VPS / 团队服务器地址。');
  let parsed; try{parsed=new URL(serverUrl);}catch{throw new Error('连接配置里的服务器地址无效。');}
  if(!['http:','https:'].includes(parsed.protocol))throw new Error('团队服务器地址必须是 http:// 或 https://。');
  if(!teamId)throw new Error('连接配置缺少团队ID。');
  if(!apiKey)throw new Error('连接配置缺少同步密钥。');
  return {type:TEAM_CONNECTION_BUNDLE_TYPE,version:TEAM_CONNECTION_BUNDLE_VERSION,serverUrl,teamId,apiKey,enabled:true,mode:'client'};
}
function teamConnectionBundleFromUi(){
  const state=teamSyncUiState||{};
  const mode=String($('#teamSyncMode')?.value||state.mode||'client');
  const publicUrl=String($('#teamSyncCloudflarePublicUrl')?.value||state.cloudflarePublicUrl||'').trim();
  let serverUrl=String($('#teamSyncServerUrl')?.value||state.serverUrl||'').trim();
  if(mode==='server-cloudflare-token')serverUrl=TEAM_FIXED_PUBLIC_URL;
  else if(mode==='server-cloudflare-quick'&&publicUrl)serverUrl=publicUrl;
  else if(publicUrl&&/^https?:\/\//i.test(publicUrl))serverUrl=publicUrl;
  const bundle=teamConnectionBundleNormalize({serverUrl,teamId:String($('#teamSyncTeamId')?.value||state.teamId||'').trim(),apiKey:String($('#teamSyncApiKey')?.value||state.apiKey||'').trim()});
  return {...bundle,generatedAt:new Date().toISOString()};
}
function teamConnectionCodeEncode(bundle){
  const json=JSON.stringify(teamConnectionBundleNormalize(bundle));
  const bytes=new TextEncoder().encode(json); let binary='';
  for(const byte of bytes)binary+=String.fromCharCode(byte);
  const base64=btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  return TEAM_CONNECTION_CODE_PREFIX+base64;
}
function teamConnectionCodeDecode(code=''){
  const value=String(code||'').trim();
  if(!value.startsWith(TEAM_CONNECTION_CODE_PREFIX))throw new Error('不是有效的 Yoko SCRM 团队连接码。');
  let base64=value.slice(TEAM_CONNECTION_CODE_PREFIX.length).replace(/-/g,'+').replace(/_/g,'/');
  while(base64.length%4)base64+='=';
  let binary=''; try{binary=atob(base64);}catch{throw new Error('团队连接码已损坏或复制不完整。');}
  const bytes=Uint8Array.from(binary,ch=>ch.charCodeAt(0));
  let raw; try{raw=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new Error('团队连接码内容无法解析。');}
  return teamConnectionBundleNormalize(raw);
}
function teamConnectionParseLegacyText(text=''){
  const value=String(text||'').trim(); if(!value)return null;
  const pick=label=>{const m=value.match(new RegExp(`${label}[：:]\\s*([^\\r\\n]+)`));return m?String(m[1]||'').trim():'';};
  const serverUrl=pick('服务器地址'); const teamId=pick('团队ID'); const apiKey=pick('同步密钥');
  if(serverUrl&&teamId&&apiKey)return teamConnectionBundleNormalize({serverUrl,teamId,apiKey});
  return null;
}
function teamConnectionParseInput(text=''){
  const value=String(text||'').trim(); if(!value)throw new Error('连接配置为空。');
  if(value.startsWith(TEAM_CONNECTION_CODE_PREFIX))return teamConnectionCodeDecode(value);
  const legacy=teamConnectionParseLegacyText(value); if(legacy)return legacy;
  let raw; try{raw=JSON.parse(value);}catch{throw new Error('无法识别连接配置。请粘贴团队连接码，或选择 Yoko 团队连接文件。');}
  return teamConnectionBundleNormalize(raw);
}
async function teamConnectionApply(bundle){
  const cfg=teamConnectionBundleNormalize(bundle);
  teamConnectionTransferStatus('正在导入团队连接并测试 VPS…');
  let next=await window.yoko.saveTeamSyncSettings?.({enabled:true,mode:'client',serverUrl:cfg.serverUrl,cloudflarePublicUrl:'',teamId:cfg.teamId,apiKey:cfg.apiKey});
  if(next)renderTeamSyncState(next);
  if(next?.lastError)throw new Error(next.lastError);
  try{const synced=await window.yoko.syncTeamNow?.();if(synced){next=synced;renderTeamSyncState(synced);}}catch(error){throw new Error(String(error?.message||error||'团队服务器测试失败'));}
  if(next?.lastError)throw new Error(next.lastError);
  // V1.27.188: Native API LINE/Facebook translation reads team/VPS readiness
  // from the renderer's public state. Refresh it immediately after portable
  // connection import so the already-open inbox does not keep the old disabled
  // snapshot until the next full application reload.
  try{const fresh=await window.yoko.getState?.();if(fresh?.config)state=fresh;}catch{}
  teamConnectionTransferStatus(`✓ 已导入并连接：${cfg.serverUrl} · VPS DeepL 将共用此团队连接`,'ok');
  return next;
}

const TEAM_NODE_PLATFORM_LABELS={tiktok:'TikTok',metabusiness:'Meta Business',facebook:'Facebook',instagram:'Instagram',line:'LINE',whatsapp:'WhatsApp',telegram:'Telegram'};
function teamNodeRoleLabel(role=''){return ({lead:'引流节点',handoff:'承接节点',dual:'引流 + 承接节点',idle:'空闲节点'})[String(role||'')]||'空闲节点';}
function teamNodeCapabilityKind(platform=''){return ['tiktok','metabusiness','facebook','instagram'].includes(String(platform||''))?'lead':'handoff';}

function updateTeamSyncModeUi(mode = $('#teamSyncMode')?.value || 'client') {
  const cloudflare = teamSyncCloudflareMode(mode);
  const fixed = mode === 'server-cloudflare-token';
  const quick = mode === 'server-cloudflare-quick';
  $('#teamSyncCloudflarePanel')?.classList.toggle('hidden', !cloudflare);
  // V1.26.1: Named Tunnel is installed once as a Windows Service. The app never
  // needs the Tunnel Token and never launches a duplicate fixed connector.
  $('#teamSyncCloudflareTokenField')?.classList.add('hidden');
  const urlInput=$('#teamSyncServerUrl');
  if(urlInput){
    urlInput.readOnly = mode !== 'client';
    if(fixed && document.activeElement!==urlInput) urlInput.value=TEAM_FIXED_PUBLIC_URL;
    urlInput.placeholder = mode === 'client' ? 'https://team.dalongvpn.cc.cd' : (fixed ? TEAM_FIXED_PUBLIC_URL : (cloudflare ? '应急隧道启动后自动生成地址' : '本机服务器自动生成'));
  }
  const pathInput=$('#teamSyncCloudflaredPath');
  const pathLabel=$('#teamSyncCloudflaredPathLabel');
  if(pathInput){
    pathInput.readOnly = fixed;
    pathInput.placeholder = fixed ? '由 Windows cloudflared Service 托管；此处仅显示检测/历史路径' : '例如 C:\Cloudflared\bin\cloudflared.exe；已加入 PATH 可留空';
  }
  if(pathLabel) pathLabel.textContent = fixed ? 'cloudflared 检测路径（只读）' : 'cloudflared 路径（可留空自动检测）';
  const cfPublic=$('#teamSyncCloudflarePublicUrl');
  if(cfPublic){
    cfPublic.readOnly = true;
    if(fixed && document.activeElement!==cfPublic) cfPublic.value=TEAM_FIXED_PUBLIC_URL;
    if(quick && !/^https:\/\/[^/]+\.trycloudflare\.com/i.test(String(cfPublic.value||''))) cfPublic.value='';
    cfPublic.placeholder = fixed ? TEAM_FIXED_PUBLIC_URL : '应急隧道启动后自动生成 *.trycloudflare.com';
  }
  const detectBtn=$('#teamSyncCloudflareDetectBtn'); if(detectBtn)detectBtn.classList.toggle('hidden', fixed);
  const downloadBtn=$('#teamSyncCloudflareDownloadBtn'); if(downloadBtn)downloadBtn.classList.toggle('hidden', fixed);
  const testBtn=$('#teamSyncCloudflareTestBtn'); if(testBtn)testBtn.textContent=fixed?'测试固定地址':'测试应急地址';
  const hint=$('#teamSyncCloudflareHint'); if(hint)hint.textContent = fixed
    ? '固定团队入口：https://team.dalongvpn.cc.cd。Named Tunnel 已由 Windows cloudflared 服务托管；Yoko SCRM 只启动本机 127.0.0.1:17891 并检查 /health，不保存 Tunnel Token，也不会重复启动 cloudflared。'
    : '应急临时隧道：仅在固定入口故障排查时手动使用。地址为随机 *.trycloudflare.com，软件或电脑重启后会自动恢复固定入口。';
}

function renderTeamSyncState(snapshot = teamSyncUiState) {
  teamSyncUiState = snapshot || {};
  const s = teamSyncUiState || {};
  const connected = !!s.connected;
  const badge = $('#teamSyncConnectionBadge');
  if (badge) {
    badge.className = `team-sync-badge ${s.lastError ? 'error' : (connected ? 'online' : 'offline')}`;
    badge.textContent = s.lastError ? (s.reconnecting ? '云端重连中' : '连接异常') : (connected ? (s.serverRunning ? '服务器运行中' : '已连接') : (s.enabled ? '等待连接' : '未启用'));
  }
  if ($('#teamSyncLastSync')) $('#teamSyncLastSync').textContent = s.lastError ? `错误：${s.lastError}${s.reconnectDelayMs?` · ${Math.ceil(Number(s.reconnectDelayMs||0)/1000)}秒后重试`:''}` : (s.lastSyncAt ? `最近同步：${new Date(s.lastSyncAt).toLocaleString()}${s.lastRecoveredAt?` · 已自动恢复`:''}` : '尚未同步');
  const setVal=(id,value)=>{const el=$(id);if(el&&document.activeElement!==el)el.value=String(value ?? '');};
  setVal('#teamSyncEnabled', s.enabled ? '1':'0'); setVal('#teamSyncRole', s.role || 'employee'); setVal('#teamSyncMode', s.mode || 'client');
  setVal('#teamSyncDeviceName', s.deviceName || ''); setVal('#teamSyncServerUrl', s.serverUrl || ''); setVal('#teamSyncServerPort', s.serverPort || 17891); setVal('#teamSyncTeamId', s.teamId || ''); if(Object.prototype.hasOwnProperty.call(s,'apiKey')) setVal('#teamSyncApiKey', s.apiKey || '');
  setVal('#teamSyncCloudflaredPath', s.cloudflaredPath || ''); setVal('#teamSyncCloudflarePublicUrl', s.cloudflarePublicUrl || s.cloudflareStatus?.publicUrl || '');
  const cfToken=$('#teamSyncCloudflareToken');
  if(cfToken&&document.activeElement!==cfToken&&!cfToken.value) cfToken.placeholder = s.mode==='server-cloudflare-token' ? '固定模式不使用 Tunnel Token' : (s.cloudflareTokenSet?'旧版 Tunnel Token 已保存；当前模式不需要修改':'无需填写 Tunnel Token');
  const cfStatus=$('#teamSyncCloudflareStatus'); if(cfStatus){
    const info=s.cloudflareStatus||{};
    if(info.externallyManaged){
      const serviceText=info.serviceRunning?'Windows Service运行中':(info.serviceInstalled?'Windows Service未运行':'Windows Service状态未知');
      cfStatus.textContent=info.healthOk?`固定隧道在线 · ${serviceText}`:`固定隧道异常 · ${info.lastError||serviceText}`;
    } else cfStatus.textContent=s.cloudflareTunnelRunning?`应急隧道运行中${info.publicUrl?` · ${info.publicUrl}`:''}`:(info.lastError?`异常：${info.lastError}`:'未启动');
  }
  updateTeamSyncModeUi(s.mode || 'client');
  const caps=s.nodeCapabilities&&typeof s.nodeCapabilities==='object'?s.nodeCapabilities:{accounts:[]};
  const role=String(s.dynamicRole||caps.dynamicRole||'idle');
  const roleBadge=$('#teamNodeRoleBadge'); if(roleBadge){roleBadge.className=`team-node-role-badge ${escapeHtml(role)}`;roleBadge.textContent=teamNodeRoleLabel(role);}
  const roleTitle=$('#teamNodeRoleTitle'); if(roleTitle) roleTitle.textContent=`本机：${teamNodeRoleLabel(role)}`;
  const capList=$('#teamNodeCapabilityList');
  if(capList){
    const logged=(Array.isArray(caps.accounts)?caps.accounts:[]).filter(row=>row?.loggedIn===true);
    capList.innerHTML=logged.length?logged.map(row=>`<span class="team-node-capability ${teamNodeCapabilityKind(row.platform)}">${escapeHtml(TEAM_NODE_PLATFORM_LABELS[row.platform]||row.platform)} · ${escapeHtml(row.accountName||row.accountId)}</span>`).join(''):'<span class="muted">当前没有检测到已登录的平台账号，因此本机暂不承担团队业务角色。</span>';
  }
  const deviceList=$('#teamNodeDeviceList');
  if(deviceList){
    const devices=Array.isArray(s.teamDevices)?s.teamDevices:[];
    const isAdmin=String(s.role||'')==='admin';
    const currentDeviceId=String(s.deviceId||'');
    deviceList.innerHTML=devices.length?devices.map(device=>{
      const dc=device?.nodeCapabilities&&typeof device.nodeCapabilities==='object'?device.nodeCapabilities:{accounts:[]};
      const logged=(Array.isArray(dc.accounts)?dc.accounts:[]).filter(row=>row?.loggedIn===true);
      const capsText=logged.map(row=>`${TEAM_NODE_PLATFORM_LABELS[row.platform]||row.platform}:${row.accountName||row.accountId}`).join(' · ')||'无已登录业务平台';
      const deviceId=String(device?.deviceId||'');
      const isMe=!!deviceId && deviceId===currentDeviceId;
      const removeHtml=isAdmin&&!isMe?`<button class="team-node-remove" type="button" data-team-device-delete="${escapeHtml(deviceId)}" title="移除此节点记录；如果设备仍在线，下次同步会自动重新出现">删除</button>`:(isMe?'<span class="team-node-self">本机</span>':'');
      return `<div class="team-node-device-row${device.online?'':' offline'}" data-team-device-id="${escapeHtml(deviceId)}"><strong>${escapeHtml(device.deviceName||device.deviceId||'设备')}</strong><span class="device-role">${escapeHtml(teamNodeRoleLabel(device.dynamicRole||dc.dynamicRole||'idle'))}</span><span class="device-caps" title="${escapeHtml(capsText)}">${escapeHtml(capsText)}</span><span class="device-online">${device.online?'在线':'离线'}</span><span class="device-actions">${removeHtml}</span></div>`;
    }).join(''):'<div class="dashboard-empty">暂无团队节点数据</div>';
  }
  const tasks=Array.isArray(s.tasks)?s.tasks:[];
  const adminCanManage=String(s.role||'')==='admin';
  const pendingCount=tasks.filter(t=>String(t?.status||'pending')==='pending').length;
  const acceptedCount=tasks.filter(t=>String(t?.status||'')==='accepted').length;
  const boundCount=tasks.filter(t=>['bound','completed'].includes(String(t?.status||''))).length;
  const attentionCount=pendingCount+acceptedCount;
  if ($('#teamSyncTaskSummary')) $('#teamSyncTaskSummary').textContent = `待接单 ${pendingCount} · 待绑定 ${acceptedCount} · 已绑定 ${boundCount} · 共 ${tasks.length} 条`;
  if ($('#teamSyncServerStats')) $('#teamSyncServerStats').textContent = `服务器：在线 ${s.stats?.devices||0} · 引流 ${s.stats?.acquisitionNodes||0} · 承接 ${s.stats?.handoffNodes||0} · 双角色 ${s.stats?.dualNodes||0} · 客户 ${s.stats?.customers||0} · 待接单 ${s.stats?.pending||0} · 待绑定 ${s.stats?.accepted||0} · 已绑定 ${s.stats?.bound||0}`;
  const mapList=$('#teamSyncLineMappingList');
  if(mapList){
    const endpoints=Array.isArray(s.lineEndpoints)?s.lineEndpoints:[];
    const activeIds=new Set((Array.isArray(s.activeLineEndpoints)?s.activeLineEndpoints:[]).map(ep=>String(ep?.localAccountId||'')));
    mapList.innerHTML=endpoints.length?endpoints.map(ep=>`<div class="team-sync-line-map-row"><strong>${escapeHtml(ep.displayName||ep.localAccountId)}</strong><span class="endpoint-state ${activeIds.has(String(ep.localAccountId||''))?'online':'offline'}">${activeIds.has(String(ep.localAccountId||''))?'已登录':'未登录'}</span><input data-team-line-map="${escapeHtml(ep.localAccountId)}" value="${escapeHtml(ep.mappedName||ep.displayName||'')}" placeholder="逻辑LINE名称" /></div>`).join(''):'<div class="dashboard-empty">本机暂无 LINE 账号</div>';
  }
  const badge2=$('#externalTeamPendingBadge'); if(badge2){badge2.textContent=String(attentionCount);badge2.classList.toggle('hidden',attentionCount<=0);}
  const list=$('#teamSyncTaskList'); if(!list)return;
  if(!tasks.length){list.innerHTML='<div class="dashboard-empty">暂无承接任务</div>';return;}
  list.innerHTML=tasks.map(task=>{
    const status=String(task.status||'pending'); const customer=task.customer||{};
    const sourceName=task.sourceDisplayName||customer.sourceDisplayName||'未命名客户';
    const sourceHandle=task.sourceHandle||customer.sourceHandle||'';
    const bound=status==='bound'||status==='completed';
    const assignedToMe=!task.assignedDeviceId||String(task.assignedDeviceId)===String(s.deviceId||'');
    let actionHtml='';
    if(status==='pending') actionHtml=task.eligibleOnThisDevice===true?'<button type="button" data-team-action="accept">接单</button>':'<button type="button" disabled>需登录目标LINE</button>';
    else if(status==='accepted'&&assignedToMe) actionHtml=task.eligibleOnThisDevice===true?'<button class="primary" type="button" data-team-action="bind">绑定当前LINE客户</button>':'<button type="button" disabled>目标LINE当前未登录</button>';
    else if(status==='accepted') actionHtml=`<button type="button" disabled>${escapeHtml(task.assignedDeviceName||'其他员工')} 已接单</button>`;
    else if(bound) actionHtml=`<button type="button" disabled>已绑定：${escapeHtml(task.boundLineDisplayName||'LINE客户')}</button>`;
    if(adminCanManage) actionHtml += `<button class="danger team-task-delete" type="button" data-team-action="delete" title="删除这条承接任务记录；不会删除客户CRM、LINE聊天或GPT绑定">删除</button>`;
    return `<article class="team-sync-task ${escapeHtml(status)}" data-task-id="${escapeHtml(task.taskId)}">
      <div class="team-sync-task-main"><strong>${escapeHtml(sourceName)}${sourceHandle?` <small>@${escapeHtml(sourceHandle)}</small>`:''}</strong>
      <small>来源：${escapeHtml(task.sourcePlatform||customer.sourcePlatform||'')} · ${escapeHtml(task.sourceAccountName||customer.sourceAccountName||'')}</small>
      <div class="team-sync-task-meta"><span class="target">目标LINE：${escapeHtml(task.targetLineAccountName||task.targetLineLogicalKey||'未指定')}</span><span>${escapeHtml(customer.age?`${customer.age}岁`:'')}</span><span>${escapeHtml(customer.region||'')}</span><span>${escapeHtml(teamTaskStatusLabel(status))}</span>${task.assignedDeviceName?`<span>负责人：${escapeHtml(task.assignedDeviceName)}</span>`:''}</div></div>
      <div class="team-sync-task-actions">${actionHtml}</div>
    </article>`;
  }).join('');
}

async function openTeamSyncCenter() {
  try {
    const cached = await window.yoko.getTeamSyncState?.();
    teamSyncUiState = cached || {};
    if (cached?.enabled && typeof window.yoko.syncTeamNow === 'function') {
      try { teamSyncUiState = await window.yoko.syncTeamNow(); } catch {}
    }
    renderTeamSyncState(teamSyncUiState);
    await openModal('teamSyncModal');
  } catch (error) {
    const msg='团队承接中心打开失败：'+(error?.message||error); if(shellSurface==='external')setExternalStatus(msg);else setStatus(msg);
  }
}

// V1.27.99 — unified operator-facing system health console. It deliberately
// reuses existing sealed bridges: getRuntimePerformance + nativeApiAction.
// No secret-bearing settings or message bodies are copied into the snapshot.
let stabilityDiagnosticsTimer = null;
let stabilityDiagnosticsLastSnapshot = null;

function stabilityDiagTime(raw) {
  const n=Number(raw || 0);
  const d=n ? new Date(n) : (raw ? new Date(raw) : null);
  if(!d || Number.isNaN(d.getTime())) return '--';
  return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
function stabilityDiagAge(raw) {
  if(!raw)return '暂无';
  const d=new Date(raw);if(Number.isNaN(d.getTime()))return '--';
  const age=Math.max(0,Date.now()-d.getTime());
  if(age<60000)return `${Math.max(1,Math.round(age/1000))} 秒前`;
  if(age<3600000)return `${Math.round(age/60000)} 分钟前`;
  return `${Math.round(age/3600000)} 小时前`;
}
function stabilityDiagDuration(ms=0) {
  const n=Math.max(0,Number(ms||0));
  if(n<60000)return `${Math.round(n/1000)} 秒`;
  if(n<3600000)return `${Math.round(n/60000)} 分钟`;
  if(n<86400000)return `${Math.round(n/360000)/10} 小时`;
  return `${Math.round(n/8640000)/10} 天`;
}
function nativeApiTranslationHealthSnapshot() {
  const t=nativeApiTranslationSettings();
  const enabled=nativeApiTranslationEnabled();
  const values=Array.from(nativeApiTranslationCache.values());
  const errors=values.filter(row=>row?.status==='error').length;
  let queued=0;
  try{
    if(nativeApiSelected&&enabled){const selectionKey=nativeApiKey(nativeApiSelected);queued=nativeApiVisibleTranslationRows().filter(row=>{const key=nativeApiTranslationKeyFor(selectionKey,row);return nativeApiTranslationCandidate(row)&&!nativeApiTranslationCache.has(key)&&!nativeApiTranslationBusy.has(key);}).length;}
  }catch{}
  return {
    enabled,engine:String(t.engine||'none'),effectiveEngine:nativeApiCloudFastLaneEngine()?'deepl-gateway-fast-lane':String(t.engine||'none'),busy:nativeApiTranslationBusy.size,queued,
    scheduler:!!nativeApiTranslationScheduler,cacheEntries:nativeApiTranslationCache.size,errors,
    selectedCustomer:!!nativeApiSelected,serverPreTranslation:t.serverPreTranslationV127133!==false,localFallbackEnabled:t.localFallbackEnabledV127133!==false,
    firstPaintFastLane:{...nativeApiTranslationFirstPaintStats,active:!!nativeApiTranslationFirstPaintPromise,backgroundConcurrency:nativeApiTranslationConcurrency()}
  };
}
function stabilitySystemEntry(state='idle',label='--',summary='--',detail='--') { return {state,label,summary,detail}; }
function buildStabilitySystemSnapshot(perf={},apiHealth={},translation=nativeApiTranslationHealthSnapshot()) {
  const fb=apiHealth?.facebook||{},line=apiHealth?.line||{},auto=fb?.autoReconcile||{},echo=fb?.messageEchoSubscription||{};
  const out={};
  const fbReady=!!fb.ok&&!!fb.pageAccessTokenConfigured&&String(fb.storage||'')==='sqlite';
  out.facebook=fbReady
    ? stabilitySystemEntry('ok','正常',`事件 ${Number(fb.events||0)} · 客户 ${Number(fb.historyConversations||0)}`,`Page Token 已配置 · ${fb.lastEventAt?`最近事件 ${stabilityDiagAge(fb.lastEventAt)}`:'暂无事件记录'}`)
    : stabilitySystemEntry('error','异常','Facebook 官方 API 不完整',String(fb.error||(!fb.pageAccessTokenConfigured?'Page Token 未配置':`存储 ${fb.storage||'不可用'}`)));

  const webhookBase=!!fb.ok&&!!fb.appSecretConfigured&&!!fb.verifyTokenConfigured;
  const echoError=String(echo?.lastError||'');
  const echoReady=webhookBase&&echo?.enabled!==false&&!!echo?.lastSuccessAt&&!echoError;
  out.webhook=echoError
    ? stabilitySystemEntry('error','异常','message_echoes 订阅失败',echoError)
    : echoReady
      ? stabilitySystemEntry('ok','正常','Webhook + message_echoes 已订阅',`${fb.lastEventAt?`最近事件 ${stabilityDiagAge(fb.lastEventAt)} · ${fb.lastDirection||''}/${fb.lastEventType||''}`:'尚无事件'} · 最近订阅 ${stabilityDiagAge(echo.lastSuccessAt)}`)
      : webhookBase
        ? stabilitySystemEntry('warn','待确认','Webhook 已配置，等待订阅确认',echo?.lastAttemptAt?`最近尝试 ${stabilityDiagAge(echo.lastAttemptAt)}`:'尚未尝试订阅')
        : stabilitySystemEntry('error','异常','Webhook 配置不完整',!fb.appSecretConfigured?'App Secret 未配置':'Verify Token 未配置');

  out.reconcile=String(auto?.lastError||'')
    ? stabilitySystemEntry('error','异常','自动补漏最近一次失败',String(auto.lastError))
    : !auto?.enabled
      ? stabilitySystemEntry('error','关闭','60 秒自动补漏未启用','需要 VPS v0.8 自动增量对账')
      : auto?.running
        ? stabilitySystemEntry('warn','运行中','正在自动增量对账',`间隔 ${Math.max(1,Math.round(Number(auto.intervalMs||60000)/1000))} 秒 · 累计追回 ${Number(auto.totalRecoveredMessages||0)} 条`)
        : auto?.lastSuccessAt
          ? stabilitySystemEntry('ok','正常',`每 ${Math.max(1,Math.round(Number(auto.intervalMs||60000)/1000))} 秒自动补漏`,`最近检查 ${stabilityDiagAge(auto.lastSuccessAt)} · 最近追回 ${Number(auto.lastRecoveredMessages||0)} · 累计 ${Number(auto.totalRecoveredMessages||0)}`)
          : stabilitySystemEntry('warn','等待首次','自动补漏已启用',`每 ${Math.max(1,Math.round(Number(auto.intervalMs||60000)/1000))} 秒检查一次`);

  const fbSqlite=String(fb.storage||'')==='sqlite',lineSqlite=String(line.storage||'')==='sqlite';
  out.sqlite=fbSqlite&&lineSqlite
    ? stabilitySystemEntry('ok','正常','Facebook / LINE SQLite 可用',`FB 事件 ${Number(fb.events||0)} · LINE 事件 ${Number(line.events||0)}`)
    : (fbSqlite||lineSqlite)
      ? stabilitySystemEntry('warn','部分正常','只有一个事件库可用',`Facebook ${fb.storage||'不可用'} · LINE ${line.storage||'不可用'}`)
      : stabilitySystemEntry('error','异常','SQLite 事件库不可用',`Facebook ${fb.storage||'不可用'} · LINE ${line.storage||'不可用'}`);

  const lineReady=!!line.ok&&!!line.channelSecretConfigured&&!!line.channelAccessTokenConfigured&&lineSqlite;
  out.line=lineReady
    ? stabilitySystemEntry('ok','正常',`LINE 官方 API 在线 · 事件 ${Number(line.events||0)}`,line.lastEventAt?`最近事件 ${stabilityDiagAge(line.lastEventAt)} · ${line.lastDirection||''}/${line.lastEventType||''}`:'Webhook 已配置，暂无事件记录')
    : stabilitySystemEntry('error','异常','LINE 官方 API 配置不完整',String(line.error||(!line.channelSecretConfigured?'Channel Secret 未配置':(!line.channelAccessTokenConfigured?'Channel Access Token 未配置':`存储 ${line.storage||'不可用'}`))));

  const translationLabel=String(translation.effectiveEngine||translation.engine||'none');
  const firstPaint=translation.firstPaintFastLane||{};
  const firstPaintDetail=Number(firstPaint.startedCount||0)>0?` · 首屏 ${Number(firstPaint.lastElapsedMs||0)} ms · 排队 ${Number(firstPaint.lastQueueWaitMs||0)} ms · 网关 ${Number(firstPaint.lastProviderMs||0)} ms / MAX ${Number(firstPaint.maxElapsedMs||0)} ms`:'';
  if(!translation.enabled||translation.engine==='none')out.translation=stabilitySystemEntry('idle','未开启','翻译当前关闭','不会影响消息收发');
  else if(translation.errors>0)out.translation=stabilitySystemEntry('warn','有错误',`${translationLabel} · ${translation.errors} 条失败`,`处理中 ${translation.busy} · 待处理 ${translation.queued} · 缓存 ${translation.cacheEntries}${firstPaintDetail}`);
  else if(translation.busy>0||translation.scheduler||translation.queued>0||firstPaint.active)out.translation=stabilitySystemEntry('warn','工作中',`${translationLabel} · 正在翻译`,`处理中 ${translation.busy} · 待处理 ${translation.queued} · 缓存 ${translation.cacheEntries}${firstPaintDetail}`);
  else out.translation=stabilitySystemEntry('ok','正常',`${translationLabel} · 队列空闲`,`处理中 0 · 待处理 0 · 缓存 ${translation.cacheEntries}${firstPaintDetail}`);

  const gpt=perf?.gptStability||{},workbench=gpt?.workbench||{},customer=gpt?.customer||{};
  const conversationMismatch=!!workbench.bound&&!!workbench.bindingConversation&&!!workbench.currentConversation&&workbench.bindingConversation!==workbench.currentConversation&&!workbench.loading;
  if(Number(workbench.healthFailures||0)>=3||conversationMismatch)out.gpt=stabilitySystemEntry('error','异常',conversationMismatch?'GPT 历史会话与绑定不一致':'GPT 健康检查连续失败',`失败 ${Number(workbench.healthFailures||0)} 次 · ${workbench.currentConversation||'无当前会话'}`);
  else if(!workbench.visible)out.gpt=stabilitySystemEntry('idle','未打开','GPT 工作台当前关闭','需要时打开即可，不影响官方 API 消息');
  else if(customer.pending||workbench.loading||workbench.generationWaiting)out.gpt=stabilitySystemEntry('warn','工作中',customer.pending?'正在确认客户':(workbench.loading?'GPT 页面加载中':'正在生成回复'),`已绑定 ${workbench.bound?'是':'否'} · 健康失败 ${Number(workbench.healthFailures||0)}`);
  else out.gpt=stabilitySystemEntry(workbench.ready?'ok':'warn',workbench.ready?'正常':'待就绪',workbench.bound?'GPT 工作台已绑定':'GPT 工作台已打开',`客户锁 ${customer.authority?'可信':'未锁定'} · 健康失败 ${Number(workbench.healthFailures||0)}`);

  const cpu=Number(perf?.cpuPercent||0),mem=Number(perf?.memoryMb||0),processes=Number(perf?.processCount||0);
  const runtimeState=(cpu>=95||mem>=3000)?'error':((cpu>=75||mem>=1800)?'warn':'ok');
  out.runtime=stabilitySystemEntry(runtimeState,runtimeState==='ok'?'正常':(runtimeState==='warn'?'偏高':'过载'),`CPU ${cpu.toFixed(1)}% · 内存 ${mem} MB`,`Electron 进程 ${processes} · 客户缓存 ${Number(perf?.conversationCache||0)} · 翻译缓存 ${Number(perf?.translationCache||0)}`);

  const states=Object.values(out).map(row=>row.state).filter(state=>state!=='idle');
  const overall=states.includes('error')?'error':(states.includes('warn')||states.includes('pending')?'warn':'ok');
  return {overall,items:out};
}
function renderStabilitySystemHealth(system={}) {
  const items=system?.items||{};
  for(const [key,row] of Object.entries(items)){
    const card=document.querySelector(`[data-system-health="${key}"]`);if(!card)continue;
    card.className=`stability-system-card ${row?.state||'idle'}`;
    const status=card.querySelector('.stability-system-card-head span');if(status)status.textContent=String(row?.label||'--');
    const summary=card.querySelector('p');if(summary)summary.textContent=String(row?.summary||'--');
    const detail=card.querySelector('small');if(detail)detail.textContent=String(row?.detail||'--');
  }
  const badge=$('#stabilitySystemOverallBadge');
  if(badge){const overall=String(system?.overall||'idle');badge.className=`stability-diag-badge ${overall==='ok'?'healthy':(overall==='warn'?'pending':'idle')} ${overall==='error'?'error':''}`;badge.textContent=overall==='ok'?'✓ 系统健康':(overall==='warn'?'⚠ 有项目需关注':(overall==='error'?'✗ 系统异常':'等待系统检查'));}
}
function updateNativeApiDiagnosticsQuickBadge(apiHealth=null,system=null) {
  const btn=$('#nativeApiDiagnosticsBtn'),textNode=$('#nativeApiDiagnosticsText');if(!btn)return;
  let level=system?.overall||'';
  if(!level&&apiHealth){const fb=apiHealth?.facebook||{},line=apiHealth?.line||{},auto=fb?.autoReconcile||{},echo=fb?.messageEchoSubscription||{};if(!fb.ok||!line.ok||!auto.enabled||auto.lastError||echo.lastError)level='error';else if(!echo.lastSuccessAt||!auto.lastSuccessAt)level='warn';else level='ok';}
  if(!level)level='pending';
  btn.classList.remove('ok','warn','error','pending');btn.classList.add(level);
  if(textNode)textNode.textContent=level==='ok'?'系统健康':(level==='warn'?'系统关注':(level==='error'?'系统异常':'系统检查中'));
}

function renderStabilityDiagnostics(snapshot = stabilityDiagnosticsLastSnapshot) {
  stabilityDiagnosticsLastSnapshot=snapshot || null;
  const root=snapshot||{};
  const data=root?.gpt || root;
  const customer=data?.customer || {};
  const authority=customer?.authority || null;
  const stable=customer?.stable || null;
  const effective=authority || stable || null;
  const meta=data?.meta || {};
  const workbench=data?.workbench || {};
  const workflow=data?.workflowCore || {};
  const set=(sel,value)=>{const el=$(sel);if(el)el.textContent=String(value ?? '--');};
  set('#stabilityDiagCheckedAt', root?.at ? `最近检查：${stabilityDiagTime(root.at)}` : (data?.at ? `最近检查：${stabilityDiagTime(data.at)}` : '--'));
  set('#stabilityDiagCustomer', effective?.displayName || '未锁定客户');
  set('#stabilityDiagCustomerKey', effective?.targetKey || '--');
  set('#stabilityDiagAuthority', authority ? `可信客户锁 · Epoch ${authority.selectionEpoch || meta.selectionEpoch || 0}` : '未建立可信客户锁');
  set('#stabilityDiagPending', customer?.pending ? `正在确认新客户 · ${Math.round(Number(customer.pendingAgeMs||0))}ms` : '当前没有客户切换等待');
  set('#stabilityDiagBinding', workbench?.bound ? '已绑定' : '未绑定');
  set('#stabilityDiagConversation', workbench?.bindingConversation || workbench?.currentConversation || '--');
  set('#stabilityDiagNavigation', workbench?.lastNavigationReason || '无自动导航');
  set('#stabilityDiagNavigationCount', `累计导航 ${Number(workbench?.navigationCount || 0)} 次 · ${workbench?.lastNavigationAt ? stabilityDiagTime(workbench.lastNavigationAt) : '--'}`);
  set('#stabilityDiagFastRoute', `${Number(workbench?.fastRouteCount || 0)} 次`);
  const gptStageTiming=workbench?.lastStageTiming||{};
  const gptStageDetail=Number(gptStageTiming?.totalMs||0)>0 ? ` · 消息→GPT ${Number(gptStageTiming.totalMs)}ms [选${Number(gptStageTiming.selectionResolveMs||0)} 路${Number(gptStageTiming.routeMs||0)} 取${Number(gptStageTiming.messageSnapshotMs||0)} 发${Number(gptStageTiming.composerSubmitMs||0)} 绑${Number(gptStageTiming.autoBindForegroundMs||0)}]` : '';
  set('#stabilityDiagFastRouteDetail', `最近路由 ${Number(workbench?.lastFastRouteSettleMs || 0) ? `${Number(workbench.lastFastRouteSettleMs)}ms` : '--'} · 抢占 ${Number(workbench?.fastRoutePreemptCount || 0)} · 历史热切 ${Number(workbench?.fastHistoryHitCount || 0)} · SPA ${Number(workbench?.fastSpaHitCount || 0)} · fallback ${Number(workbench?.fastRouteFallbackCount || 0)}${gptStageDetail}`);
  set('#stabilityDiagObserveHits', Number(meta?.observeLockHits || 0));
  set('#stabilityDiagBlocked', Number(meta?.mismatchBlockedCount || 0));
  set('#stabilityDiagIgnored', `已忽略 ${Number(meta?.observationIgnoredCount || 0)} 次非客户点击观察事件`);
  const attachmentBoot=workbench?.attachmentBootstrap||{},attachmentLast=attachmentBoot?.last||{};
  set('#stabilityDiagAttachment', attachmentLast?.ok ? `Ready · ${attachmentLast.strategy||'附件'}` : (attachmentLast?.error ? '失败' : '未运行'));
  set('#stabilityDiagAttachmentDetail', attachmentLast?.at ? `总 ${Number(attachmentLast.coreTotalMs||attachmentLast.totalMs||0)}ms · 窗口 ${Number(attachmentLast.windowAcquireMs||0)} · 新会话 ${Number(attachmentLast.freshConversationMs||0)} · 页面Ready ${Number(attachmentLast.readyGateMs||0)} · 附件准备 ${Number(attachmentLast.attachmentPrepareMs||0)} · 附件Ready ${Number(attachmentLast.attachmentReadyMs||0)} · 短指令 ${Number(attachmentLast.promptSubmitMs||0)} · 会话ID ${Number(attachmentLast.conversationStableMs||0)} · 复用 ${Number(attachmentBoot.attachmentReuseCount||0)} · 阻止重复 ${Number(attachmentBoot.duplicatePreventedCount||0)} · 文档锁 ${Number(attachmentBoot.documentLeaseHitCount||0)} · 串客拦截 ${Number(attachmentBoot.staleCustomerBlockedCount||0)} · 清空旧附件 ${Number(attachmentBoot.cleanSurfaceResetCount||0)} · 语义发送 ${Number(attachmentBoot.semanticSubmitCount||0)} · 视觉发送 ${Number(attachmentBoot.visualSubmitCount||0)}${attachmentLast.error?` · ${attachmentLast.error}`:''}` : `成功 ${Number(attachmentBoot.successes||0)} · 失败 ${Number(attachmentBoot.failures||0)} · 拖放 ${Number(attachmentBoot.dragDropCount||0)} · 复用 ${Number(attachmentBoot.attachmentReuseCount||0)} · 阻止重复 ${Number(attachmentBoot.duplicatePreventedCount||0)}`);
  const workflowActive=Array.isArray(workflow?.active)?workflow.active:[];
  const workflowCurrent=(effective?.targetKey?workflowActive.find(row=>String(row?.targetKey||'')===String(effective.targetKey||'')):null)||workflowActive[workflowActive.length-1]||null;
  const workflowQueue=workflow?.queue||{},workflowStats=workflow?.stats||{},workflowRecovery=workflow?.recovery||{};
  set('#stabilityWorkflowState', workflowCurrent?.state || 'IDLE');
  set('#stabilityWorkflowStateDetail', workflowCurrent ? `${workflowCurrent.reason||'运行中'} · ${Math.round(Number(workflowCurrent.ageMs||0))}ms` : '当前没有活动流程');
  set('#stabilityWorkflowQueue', `运行 ${Number(workflowQueue.running||0)} · 等待 ${Number(workflowQueue.pending||0)}`);
  set('#stabilityWorkflowQueueDetail', `客户队列 ${Number(workflowQueue.targets||0)} · 并发幂等 ${Number(workflowQueue.inFlightIdempotency||0)}`);
  set('#stabilityWorkflowIdempotency', `JOIN ${Number(workflowStats.joined||0)} · 去重 ${Number(workflowStats.dedupedRecent||0)}`);
  set('#stabilityWorkflowIdempotencyDetail', `已入队 ${Number(workflowStats.enqueued||0)} · 成功 ${Number(workflowStats.succeeded||0)} · 失败 ${Number(workflowStats.failed||0)}`);
  set('#stabilityWorkflowRecovery', Number(workflowRecovery.interruptedCount||0) ? `需确认 ${Number(workflowRecovery.interruptedCount||0)}` : '正常');
  set('#stabilityWorkflowRecoveryDetail', Number(workflowRecovery.interruptedCount||0) ? '检测到上次异常退出时未完成的流程；不会自动重发' : '没有未完成的崩溃恢复任务');
  const workflowLast=workflowStats?.lastOperation||{};
  set('#stabilityWorkflowLast', workflowLast?.kind ? `${workflowLast.kind} · ${workflowLast.status||'--'}` : '--');
  set('#stabilityWorkflowLastDetail', workflowLast?.operationId ? `${workflowLast.operationId} · ${Number(workflowLast.elapsedMs||0)}ms${workflowLast.error?` · ${workflowLast.error}`:''}` : '--');
  set('#stabilityWorkflowIllegal', Number(workflowStats.illegalTransitions||0));
  const longRun=root?.longRun||{};const migration=root?.migration||{};const mem=longRun?.memory||{},loop=longRun?.eventLoop||{},heal=longRun?.selfHeal||{};const stress=Array.isArray(longRun?.stressRuns)?longRun.stressRuns[longRun.stressRuns.length-1]:null;
  set('#stabilityLongRunDuration', stabilityDiagDuration(longRun?.monitoredForMs||0));
  set('#stabilityLongRunSamples', `采样 ${Number(longRun?.sampleCount||longRun?.storedSamples||0)} · 事件 ${Number(longRun?.storedIncidents||longRun?.incidents?.length||0)}`);
  set('#stabilityLongRunMemory', `${Number(mem.currentMb||0)} MB`);
  set('#stabilityLongRunMemoryDetail', `平均 ${Number(mem.avgMb||0)} MB · MAX ${Number(mem.maxMb||0)} MB · 趋势 ${Number(mem.growthMbPerHour||0)} MB/h`);
  set('#stabilityLongRunLoop', `P95 ${Number(loop.p95LagMs||0)} ms`);
  set('#stabilityLongRunLoopDetail', `平均 ${Number(loop.avgLagMs||0)} ms · MAX ${Number(loop.maxLagMs||0)} ms`);
  set('#stabilityLongRunHeal', `${Number(heal.actions||0)} 次动作`);
  set('#stabilityLongRunHealDetail', `运行 ${Number(heal.runs||0)} · 残留状态 ${Number(heal.staleStates||0)} · 残留幂等 ${Number(heal.staleIdempotency||0)}`);
  set('#stabilityLongRunStress', stress ? (stress.passed?'PASS':'FAIL') : '未运行');
  set('#stabilityLongRunStressDetail', stress ? `${Number(stress.iterations||0)} 任务 · ${Number(stress.elapsedMs||0)}ms · 并发冲突 ${Number(stress.overlapViolations||0)} · 内存Δ ${Number(stress.memoryDeltaMb||0)}MB` : '只使用合成任务，不发送真实客户消息');
  set('#stabilityMigrationVersion', `Schema ${Number(migration?.schemaVersion||0)}`);
  set('#stabilityMigrationDetail', `${migration?.lastMigrationVersion||'--'}${migration?.lastMigrationAt?` · ${stabilityDiagAge(migration.lastMigrationAt)}`:''}`);
  const healthy=!!authority && !customer?.pending && (!workbench?.bound || !workbench?.bindingConversation || !workbench?.currentConversation || workbench.bindingConversation===workbench.currentConversation || workbench.loading===true);
  const badge=$('#stabilityDiagOverallBadge');
  if(badge){badge.className=`stability-diag-badge ${healthy?'healthy':(customer?.pending?'pending':'idle')}`;badge.textContent=healthy?'客户锁稳定':(customer?.pending?'确认客户中':'等待可信客户选择');}
  const events=Array.isArray(data?.events)?data.events.slice().reverse():[];
  const list=$('#stabilityDiagEventList');
  if(list){
    list.innerHTML=events.length?events.map(row=>{
      const type=String(row?.type||'event');
      const bad=/blocked|mismatch|pending/i.test(type);
      const good=/authority|fast-path|fast-route|reconfirmed/i.test(type);
      const nearby=row?.attribution?.nearbyOperation?.operation ? `附近操作 ${row.attribution.nearbyOperation.operation} · ${row.attribution.confidence||'unknown'}` : (row?.operation&&/^ui-latency/i.test(type)?`操作 ${row.operation}`:'');
      const detail=[row?.displayName,row?.reason,row?.authorityName&&row?.liveName?`${row.authorityName} ←拦截→ ${row.liveName}`:'',nearby,row?.targetKey].filter(Boolean).join(' · ');
      return `<div class="stability-diag-event ${bad?'bad':(good?'ok':'')}"><span>${escapeHtml(stabilityDiagTime(row?.at))}</span><strong>${escapeHtml(type)}</strong><small>${escapeHtml(detail || '--')}</small></div>`;
    }).join(''):'<div class="dashboard-empty">暂无事件</div>';
  }
  renderStabilitySystemHealth(root?.system||{});
  updateNativeApiDiagnosticsQuickBadge(root?.apiHealth||null,root?.system||null);
  const raw=$('#stabilityDiagRaw');if(raw)raw.textContent=JSON.stringify(root,null,2);
}

async function refreshStabilityDiagnostics({quiet=false}={}) {
  try {
    const [perfResult,healthResult]=await Promise.allSettled([
      window.yoko.getRuntimePerformance?.(),
      nativeApiAction('native-api-health')
    ]);
    const perf=perfResult.status==='fulfilled'?(perfResult.value||{}):{};
    const apiHealth=healthResult.status==='fulfilled'?(healthResult.value||{}):{ok:false,facebook:{ok:false,error:String(healthResult.reason?.message||healthResult.reason||'健康检查失败')},line:{ok:false,error:String(healthResult.reason?.message||healthResult.reason||'健康检查失败')}};
    const translation=nativeApiTranslationHealthSnapshot();
    const runtimeVersion=String(perf?.appVersion||perf?.gptStability?.version||'unknown').trim()||'unknown';
    const snapshot={version:runtimeVersion,at:new Date().toISOString(),system:buildStabilitySystemSnapshot(perf,apiHealth,translation),apiHealth,translation,runtime:{cpuPercent:Number(perf?.cpuPercent||0),memoryMb:Number(perf?.memoryMb||0),processCount:Number(perf?.processCount||0),conversationCache:Number(perf?.conversationCache||0),translationCache:Number(perf?.translationCache||0)},longRun:perf?.longRunStability||{},migration:perf?.configMigration||{},gpt:perf?.gptStability||{}};
    renderStabilityDiagnostics(snapshot);
    if(!quiet){const msg='系统健康检查已刷新';if(shellSurface==='external')setExternalStatus(msg);else if(shellSurface==='native-api')nativeApiSetStatus(msg);else setStatus(msg);}
    return snapshot;
  } catch(error) {
    updateNativeApiDiagnosticsQuickBadge(null,{overall:'error'});
    if(!quiet){const msg='稳定性诊断读取失败：'+(error?.message||error);if(shellSurface==='external')setExternalStatus(msg);else if(shellSurface==='native-api')nativeApiSetStatus(msg);else setStatus(msg);}
    return null;
  }
}

async function openStabilityDiagnostics() {
  await closeModal('settingsModal').catch(()=>{});
  await openModal('stabilityDiagnosticsModal');
  await refreshStabilityDiagnostics({quiet:true});
  if(stabilityDiagnosticsTimer)clearInterval(stabilityDiagnosticsTimer);
  stabilityDiagnosticsTimer=setInterval(()=>{
    const modal=$('#stabilityDiagnosticsModal');
    if(!modal || modal.classList.contains('hidden')){clearInterval(stabilityDiagnosticsTimer);stabilityDiagnosticsTimer=null;return;}
    refreshStabilityDiagnostics({quiet:true}).catch(()=>{});
  },3000);
}

let handoffHealthUiState = null;
let handoffHealthTransientRefreshTimer = null;
const HANDOFF_ISSUE_LABELS = {
  lineAccountPresent:'LINE账号存在',
  lineChatBound:'LINE客户已绑定',
  crmPresent:'CRM记录存在',
  crmGlobalMatch:'CRM跨平台ID一致',
  crmTaskMatch:'CRM任务ID一致',
  localCommitVerified:'本地提交已验证',
  gptDestinationPresent:'LINE GPT绑定存在',
  gptConversationExact:'GPT历史会话一致',
  gptContinuityMarked:'GPT连续性已确认',
  selfCheckException:'自检执行异常'
};
const HANDOFF_GPT_ISSUES = new Set(['gptDestinationPresent','gptConversationExact','gptContinuityMarked']);
const HANDOFF_CRM_ISSUES = new Set(['crmPresent','crmGlobalMatch','crmTaskMatch','localCommitVerified']);

function handoffHealthTime(raw) {
  if (!raw) return '--';
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return '--';
  return date.toLocaleString();
}
function handoffIssueLabel(code) { return HANDOFF_ISSUE_LABELS[String(code || '')] || String(code || '未知异常'); }
function handoffTraceLabel(event='') {
  return ({
    'integrity-check':'完整性检查', 'integrity-check-exception':'自检异常',
    'bind-start':'开始绑定', 'line-account-resolved':'LINE账号识别', 'line-customer-resolved':'LINE客户识别',
    'local-commit-check':'本地提交检查', 'local-commit-verified':'本地提交成功', 'bind-rollback':'绑定回滚',
    'remote-commit-check':'云端提交检查', 'remote-commit-pending':'云端等待确认',
    'gpt-continuity-repair':'GPT连续性恢复', 'health-repair-gpt':'健康中心修复GPT',
    'health-repair-gpt-failed':'健康中心GPT修复失败', 'health-repair-crm':'健康中心同步CRM',
    'gpt-retarget-pending':'GPT等待加载后跳转', 'gpt-retarget-settle':'GPT历史会话跳转',
    'customer-message-gpt-target':'客户GPT目标确认', 'customer-message-gpt-selected':'客户消息已识别',
    'customer-message-gpt-sent':'客户消息已发送GPT', 'customer-message-gpt-failed':'客户消息发送GPT失败'
  })[String(event || '')] || String(event || '链路事件');
}
const HANDOFF_TRANSIENT_TIMEOUT_MS = 15000;
function handoffTraceProblem(row={}) {
  const event = String(row?.event || '');
  // V1.25.14: gpt-retarget-pending is a normal loading state, not a failure.
  // Its display severity is resolved against the current workbench state below.
  if (event === 'gpt-retarget-pending') return false;
  if (/failed|rollback|exception|pending/i.test(event)) return true;
  if (event === 'integrity-check' && row?.ok === false) return true;
  if (event === 'local-commit-check' && row?.ok === false) return true;
  if (event === 'remote-commit-check' && row?.ok === false) return true;
  return false;
}
function handoffTraceAgeMs(row={}, now=Date.now()) {
  const ts = new Date(row?.at || '').getTime();
  return Number.isFinite(ts) ? Math.max(0, Number(now||Date.now()) - ts) : Number.POSITIVE_INFINITY;
}
function handoffPendingMatchesHealthyTask(row={}, health={}) {
  const wanted=String(row?.wantedConversation || '');
  if(!wanted) return false;
  return (Array.isArray(health?.rows)?health.rows:[]).some(task=>task?.ok===true && [String(task?.sourceConversation||''),String(task?.destinationConversation||'')].includes(wanted));
}
function handoffTraceDisplayState(row={}, health=handoffHealthUiState, now=Date.now()) {
  const event=String(row?.event || '');
  if(event !== 'gpt-retarget-pending') return handoffTraceProblem(row)?{kind:'bad',detail:'需要关注'}:{kind:'ok',detail:'已完成'};
  const workbench=health?.workbench || {};
  const age=handoffTraceAgeMs(row,now);
  const targetKey=String(row?.targetKey || '');
  const wanted=String(row?.wantedConversation || '');
  const activePending=!!targetKey && String(workbench?.pendingRetargetKey || '')===targetKey;
  const currentSettled=!!wanted && String(workbench?.currentConversation || '')===wanted && workbench?.ready===true && workbench?.loading!==true;
  const structurallyHealthy=handoffPendingMatchesHealthyTask(row,health);
  if(currentSettled || (workbench?.visible===false && structurallyHealthy)) return {kind:'recovered',detail:'已自动恢复'};
  if(workbench?.loginProtected===true) return {kind:'wait',detail:'等待GPT登录完成'};
  if(activePending && age < HANDOFF_TRANSIENT_TIMEOUT_MS) return {kind:'wait',detail:'等待GPT加载'};
  if(activePending && age >= HANDOFF_TRANSIENT_TIMEOUT_MS) return {kind:'bad',detail:'GPT加载/跳转超过15秒'};
  // Once this exact pending key is no longer active, treat the historical event
  // as resolved unless the workbench is currently settled on the same customer
  // but demonstrably on the wrong conversation. This prevents stale old pending
  // rows from turning red after a customer switch/close.
  if(!activePending){
    const sameTarget=!!targetKey && String(workbench?.targetKey||'')===targetKey;
    const visiblyWrong=sameTarget && workbench?.visible===true && workbench?.ready===true && workbench?.loading!==true && !!wanted && !!workbench?.currentConversation && String(workbench.currentConversation)!==wanted;
    if(visiblyWrong && age>=HANDOFF_TRANSIENT_TIMEOUT_MS) return {kind:'bad',detail:'GPT跳转未完成，需要检查'};
    if(structurallyHealthy || !sameTarget || workbench?.visible===false) return {kind:'recovered',detail:'已自动恢复'};
  }
  if(age < HANDOFF_TRANSIENT_TIMEOUT_MS) return {kind:'wait',detail:'等待GPT加载'};
  return {kind:'bad',detail:'GPT跳转未完成，需要检查'};
}
// V1.25.13: the health console is an operator view, not a raw log viewer.
// Collapse consecutive equivalent events so a burst is shown once (×N) while
// the exported diagnostic trace still keeps every underlying record.
function collapseHandoffTraceRows(rows=[]) {
  const out=[];
  for(const raw of Array.isArray(rows)?rows:[]){
    const row={...(raw||{})};
    const ids=String(row._traceId||'').trim()?[String(row._traceId).trim()]:[];
    const key=JSON.stringify([
      String(row.event||''), String(row.taskId||''), String(row.accountId||''), String(row.chatId||''),
      handoffTraceProblem(row), String(row.error||''), row.issueCounts||null,
      String(row.currentConversation||''), String(row.wantedConversation||'')
    ]);
    const prev=out[out.length-1];
    if(prev && prev._collapseKey===key){
      prev._count=Number(prev._count||1)+1;
      prev._traceIds=[...(Array.isArray(prev._traceIds)?prev._traceIds:[]),...ids];
      continue;
    }
    row._collapseKey=key;
    row._count=1;
    row._traceIds=ids;
    out.push(row);
  }
  return out;
}
function handoffHealthHasWaitingTransient(health=handoffHealthUiState) {
  const rows=Array.isArray(health?.recentTrace)?health.recentTrace:[];
  return rows.slice(-30).some(row=>String(row?.event||'')==='gpt-retarget-pending' && handoffTraceDisplayState(row,health).kind==='wait');
}
function scheduleHandoffHealthTransientRefresh(health=handoffHealthUiState) {
  if(handoffHealthTransientRefreshTimer){clearTimeout(handoffHealthTransientRefreshTimer);handoffHealthTransientRefreshTimer=null;}
  if(!handoffHealthHasWaitingTransient(health)) return;
  handoffHealthTransientRefreshTimer=setTimeout(async()=>{
    handoffHealthTransientRefreshTimer=null;
    const modal=$('#handoffHealthModal');
    if(!modal || modal.classList.contains('hidden')) return;
    try { await refreshHandoffHealth({quiet:true}); } catch {}
  },2000);
}
function renderHandoffHealth(health = handoffHealthUiState) {
  handoffHealthUiState = health || { counts:{boundTasks:0,healthy:0,unhealthy:0}, rows:[], recentTrace:[] };
  const h = handoffHealthUiState;
  const counts = h.counts || {};
  const setText=(selector,value)=>{const node=$(selector);if(node)node.textContent=String(value ?? '');};
  setText('#handoffHealthBoundCount', counts.boundTasks || 0);
  setText('#handoffHealthHealthyCount', counts.healthy || 0);
  setText('#handoffHealthUnhealthyCount', counts.unhealthy || 0);
  setText('#handoffHealthCheckedAt', h.at ? `最近检查：${handoffHealthTime(h.at)}` : '尚未检查');
  const badge=$('#handoffHealthOverallBadge');
  if(badge){
    const hasRows=Number(counts.boundTasks||0)>0;
    const ok=h.ok===true;
    badge.className=`handoff-health-overall ${!hasRows?'idle':(ok?'healthy':'unhealthy')}`;
    badge.textContent=!hasRows?'暂无已绑定任务':(ok?'✓ 承接链健康':`⚠ ${Number(counts.unhealthy||0)} 条异常`);
  }
  const list=$('#handoffHealthTaskList');
  const rows=Array.isArray(h.rows)?h.rows:[];
  if(list){
    if(!rows.length) list.innerHTML='<div class="dashboard-empty">当前没有属于本机的已绑定 LINE 承接任务。</div>';
    else list.innerHTML=rows.map(row=>{
      const issues=Array.isArray(row.issues)?row.issues:[];
      const checks=row.checks||{};
      const sourceName=row.sourceDisplayName||row.sourceHandle||'来源客户';
      const lineName=row.boundLineDisplayName||row.chatId||'LINE客户';
      const gptRepair=issues.some(code=>HANDOFF_GPT_ISSUES.has(code));
      const crmRepair=issues.some(code=>HANDOFF_CRM_ISSUES.has(code));
      const lineProblem=issues.some(code=>['lineAccountPresent','lineChatBound'].includes(code));
      const checkChips=Object.entries(checks).map(([code,ok])=>`<span class="handoff-check-chip ${ok?'ok':'bad'}">${ok?'✓':'✗'} ${escapeHtml(handoffIssueLabel(code))}</span>`).join('');
      const issueText=issues.length?issues.map(handoffIssueLabel).join('、'):'完整闭环已确认';
      const sourceConversation=row.sourceConversation?`来源GPT ${row.sourceConversation}`:'来源暂无GPT历史';
      const destConversation=row.destinationConversation?`LINE GPT ${row.destinationConversation}`:'LINE GPT未绑定';
      return `<article class="handoff-health-task ${row.ok?'ok':'bad'}" data-handoff-task-id="${escapeHtml(row.taskId||'')}">
        <div class="handoff-health-task-head"><div><strong>${escapeHtml(sourceName)} → ${escapeHtml(lineName)}</strong><small>${escapeHtml(row.sourcePlatform||'')} · ${escapeHtml(row.sourceAccountName||'')} → ${escapeHtml(row.targetLineAccountName||row.boundLineAccountName||row.accountId||'LINE')}</small></div><span class="handoff-health-status ${row.ok?'ok':'bad'}">${row.ok?'健康':'需要处理'}</span></div>
        <div class="handoff-health-conversations"><span>${escapeHtml(sourceConversation)}</span><span>${escapeHtml(destConversation)}</span></div>
        <div class="handoff-health-checks">${checkChips}</div>
        <div class="handoff-health-issue-text ${row.ok?'ok':'bad'}">${row.ok?'✓ ':`断点：`}${escapeHtml(issueText)}</div>
        ${row.ok?'':`<div class="handoff-health-actions">${crmRepair?'<button type="button" data-handoff-repair="crm">重新同步CRM</button>':''}${gptRepair?'<button class="primary" type="button" data-handoff-repair="gpt">修复GPT连续性</button>':''}${String(teamSyncUiState?.role||'')==='admin'?'<button class="danger" type="button" data-handoff-task-delete>删除这条任务</button>':''}${lineProblem?'<span class="handoff-health-manual-hint">LINE账号/客户绑定异常需要人工确认，不会自动重绑。</span>':''}</div>`}
      </article>`;
    }).join('');
  }
  const traceList=$('#handoffHealthTraceList');
  if(traceList){
    const trace=(Array.isArray(h.recentTrace)?h.recentTrace:[]).slice().reverse();
    const meaningful=collapseHandoffTraceRows(trace.filter(row=>handoffTraceProblem(row)||/^health-repair-|^local-commit-verified$|^gpt-retarget-pending$|^gpt-retarget-settle$|^customer-message-gpt-sent$/.test(String(row?.event||'')))).slice(0,16);
    if(!meaningful.length) traceList.innerHTML='<div class="dashboard-empty">最近没有异常事件；链路运行平稳。</div>';
    else traceList.innerHTML=meaningful.map(row=>{
      const state=handoffTraceDisplayState(row,h);
      const metadata=[row.taskId?`任务 ${String(row.taskId).slice(0,18)}`:'',row.accountId?`LINE ${row.accountId}`:'',row.chatId?`客户 ${row.chatId}`:'',row.error?String(row.error).slice(0,160):'',row.issueCounts&&Object.keys(row.issueCounts).length?`异常 ${Object.entries(row.issueCounts).map(([k,v])=>`${handoffIssueLabel(k)}×${v}`).join('、')}`:''].filter(Boolean).join(' · ');
      const count=Number(row?._count||1);
      const label=`${handoffTraceLabel(row.event)}${count>1?` ×${count}`:''}`;
      const detail=metadata ? `${state.detail} · ${metadata}` : state.detail;
      const traceIds=(Array.isArray(row?._traceIds)?row._traceIds:[]).filter(Boolean);
      const selectHtml=traceIds.length?`<label class="handoff-trace-select" title="选择后可删除这条诊断事件"><input type="checkbox" data-handoff-trace-select data-trace-ids="${escapeHtml(traceIds.join(','))}" />选择</label>`:'';
      return `<div class="handoff-health-trace ${state.kind}"><span>${escapeHtml(handoffHealthTime(row.at))}</span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small><div class="handoff-trace-row-actions">${selectHtml}</div></div>`;
    }).join('');
  }
  scheduleHandoffHealthTransientRefresh(h);
}
async function refreshHandoffHealth({syncFirst=false,quiet=false}={}) {
  const refreshBtn=$('#handoffHealthRefreshBtn'); const syncBtn=$('#handoffHealthSyncBtn');
  if(refreshBtn)refreshBtn.disabled=true;if(syncBtn)syncBtn.disabled=true;
  try {
    if(syncFirst) await window.yoko.syncTeamNow?.();
    const dashboard=await window.yoko.getOperationsDashboard?.();
    renderHandoffHealth(dashboard?.handoffHealth || null);
    if(!quiet){const msg=dashboard?.handoffHealth?.ok===false?'链路检查完成：发现需要处理的异常':'链路检查完成';if(shellSurface==='external')setExternalStatus(msg);else setStatus(msg);}
    return dashboard?.handoffHealth || null;
  } finally { if(refreshBtn)refreshBtn.disabled=false;if(syncBtn)syncBtn.disabled=false; }
}
async function openHandoffHealthCenter() {
  try {
    await openModal('handoffHealthModal');
    renderHandoffHealth({counts:{boundTasks:0,healthy:0,unhealthy:0},rows:[],recentTrace:[],at:'',ok:true});
    await refreshHandoffHealth({quiet:true});
  } catch(error) {
    const msg='链路健康中心打开失败：'+(error?.message||error); if(shellSurface==='external')setExternalStatus(msg);else setStatus(msg);
  }
}

// V1.23.31: independent local chat-history center. It is deliberately not
// part of the speech library; both LINE and external platform toolbars open the
// same persistent archive window.
async function openChatHistoryCenter() {
  try {
    const result = await window.yoko.openChatHistoryWindow?.();
    if (result?.ok === false) throw new Error(result.error || '聊天记录打开失败');
    if (shellSurface === 'external') setExternalStatus?.('聊天记录已打开');
    else setStatus('聊天记录已打开');
  } catch (error) {
    if (shellSurface === 'external') setExternalStatus?.('聊天记录打开失败：' + (error?.message || error));
    else setStatus('聊天记录打开失败：' + (error?.message || error));
  }
}
$('#lineChatHistoryBtn')?.addEventListener('click', openChatHistoryCenter);
$('#externalChatHistoryBtn')?.addEventListener('click', openChatHistoryCenter);

// V1.23.14: open the persistent speech library as a separate BrowserWindow.
// Keeping it outside the main renderer means native LINE/TikTok/etc. views stay
// at their normal bounds while a preset is being sent.
$('#lineSpeechLibraryBtn')?.addEventListener('click', async () => {
  try { await window.yoko.openSpeechLibraryWindow?.(); }
  catch (error) { setStatus('话术库打开失败：' + (error?.message || error)); }
});
$('#externalSpeechLibraryBtn')?.addEventListener('click', async () => {
  try { await window.yoko.openSpeechLibraryWindow?.(); }
  catch (error) { setExternalStatus?.('话术库打开失败：' + (error?.message || error)); }
});

// V1.23.25: ChatGPT runs in a real persistent sidecar BrowserWindow attached
// outside Yoko's right edge. Each SCRM customer can bind a different existing
// chatgpt.com conversation. Login pages are protected from automatic target navigation.
let chatgptWorkbenchUiState = { visible:false, bound:false, target:null, binding:null, replyTone:'', replyFormat:'bilingual' };

function renderChatgptWorkbenchState(payload = {}) {
  chatgptWorkbenchUiState = { ...chatgptWorkbenchUiState, ...(payload || {}) };
  const visible = !!chatgptWorkbenchUiState.visible;
  const bound = !!chatgptWorkbenchUiState.bound;
  const hasTarget = !!chatgptWorkbenchUiState.target?.ok || !!chatgptWorkbenchUiState.target;
  const targetName = String(chatgptWorkbenchUiState.target?.displayName || '').trim();
  const loginProtected = !!chatgptWorkbenchUiState.loginProtected;
  const loadFailureCircuit = chatgptWorkbenchUiState.loadFailureCircuit && typeof chatgptWorkbenchUiState.loadFailureCircuit === 'object' ? chatgptWorkbenchUiState.loadFailureCircuit : null;
  const loadFailureActive = !!loadFailureCircuit?.active;
  const chatModeInfo = chatgptWorkbenchUiState.chatMode && typeof chatgptWorkbenchUiState.chatMode === 'object' ? chatgptWorkbenchUiState.chatMode : {mode:'reception',source:'channel-default'};
  const chatMode = String(chatModeInfo.mode || 'reception');
  const receptionState = chatgptWorkbenchUiState.receptionState && typeof chatgptWorkbenchUiState.receptionState === 'object' ? chatgptWorkbenchUiState.receptionState : null;
  const dailyState = chatgptWorkbenchUiState.dailyFlowState && typeof chatgptWorkbenchUiState.dailyFlowState === 'object' ? chatgptWorkbenchUiState.dailyFlowState : null;
  const dailyDirection = chatgptWorkbenchUiState.dailyFlowDirection && typeof chatgptWorkbenchUiState.dailyFlowDirection === 'object' ? chatgptWorkbenchUiState.dailyFlowDirection : null;
  const dailyDay = Math.max(0, Number(dailyState?.currentDay || 0) || 0);
  const dailyStatus = String(dailyState?.status || 'waiting-morning');
  const dailyStageLabel = String(dailyState?.dayStageLabel || '').trim();
  const dailyStageClock = String(dailyState?.dayStageClock || '').trim();
  const dailyDelivery = chatgptWorkbenchUiState.dailyFlowDelivery && typeof chatgptWorkbenchUiState.dailyFlowDelivery === 'object'
    ? chatgptWorkbenchUiState.dailyFlowDelivery
    : (dailyState?.delivery && typeof dailyState.delivery === 'object' ? dailyState.delivery : null);
  const deliveryStatus = String(dailyDelivery?.status || 'none');
  const deliverySuffix = dailyStatus === 'active'
    ? ({pending:'｜流程待同步','in-flight':'｜流程同步中',failed:'｜流程待重试',delivered:'｜流程已送达',locked:'｜流程已锁定'}[deliveryStatus] || '')
    : (deliveryStatus === 'locked' ? '｜流程未送达已锁定' : (deliveryStatus === 'delivered' && dailyDay > 0 ? '｜流程已送达' : ''));
  const schedulePhase = String(dailyState?.schedulePhase || '');
  const enrollmentDateKey = String(dailyState?.enrollmentDateKey || dailyState?.newCustomerDateKey || '');
  let dailyLabel = 'Stage 长期自然聊天｜Day 1～Day 10 已取消';
  if (dailyStatus === 'active' && dailyDay > 0) dailyLabel = `Day ${dailyDay}${dailyStageLabel ? `｜${dailyStageLabel}` : ''}｜进行中${deliverySuffix}`;
  else if (dailyStatus === 'finished') dailyLabel = `Day 10｜已完成${deliverySuffix}`;
  else if (dailyStatus === 'waiting-morning' && dailyDay > 0) dailyLabel = `Day ${dailyDay}｜已结束 · 次日05:00自动切换${deliverySuffix}`;
  if (chatMode === 'reception') dailyLabel = dailyDay > 0 ? `Day ${dailyDay}｜接待模式（时间继续）` : '新客户｜接待模式';
  for (const id of ['lineChatModeBtn','externalChatModeBtn','nativeApiChatModeBtn']) {
    const btn=$('#'+id); if(!btn) continue;
    btn.classList.toggle('hidden', !hasTarget);
    btn.classList.toggle('reception', chatMode === 'reception');
    btn.classList.toggle('deep', chatMode === 'deep');
    btn.textContent = chatMode === 'deep' ? '精聊模式' : '接待模式';
    const defaultText = chatModeInfo.source === 'channel-default' ? '（按渠道默认）' : '（手动设置）';
    const receptionDetail = chatMode === 'reception' && receptionState ? ` · ${String(receptionState.nextLabel||'自然接待')} · ${Number(receptionState.completedCount||0)}/${Number(receptionState.totalCount||6)}` : '';
    btn.title = `当前：${btn.textContent}${defaultText}${receptionDetail}。点击切换为${chatMode === 'deep' ? '接待模式' : '精聊模式'}。TG / WS / LINE 客户端默认精聊；聚官方API、TK、IG、FB、MB及其他获客渠道默认接待。`;
  }
  const title = loadFailureActive
    ? `ChatGPT 对话加载失败保护已开启 · ${targetName || '当前客户'} · 已停止后台重试/刷新${loadFailureCircuit?.manualRetryUsed ? ' · 人工重试已用，请重新绑定' : ''}`
    : (loginProtected
      ? 'ChatGPT 正在登录 · 已暂停自动切换/刷新'
      : (bound
        ? `已绑定：${targetName || '当前客户'} → ${chatgptWorkbenchUiState.binding?.title || 'ChatGPT 历史对话'}`
        : (hasTarget ? `${targetName || '当前客户'} 尚未绑定 ChatGPT` : '请先打开一个客户聊天')));
  for (const id of ['lineChatgptToggleBtn','externalChatgptToggleBtn','nativeApiGptToggleBtn']) {
    const btn = $('#' + id); if (!btn) continue;
    btn.classList.toggle('active', visible);
    btn.textContent = visible ? '关闭GPT' : 'GPT工作台';
    btn.title = visible ? `关闭右侧 ChatGPT 窗口 · ${title}` : `打开右侧 ChatGPT 窗口 · ${title}`;
  }
  for (const id of ['lineChatgptBindBtn','externalChatgptBindBtn','nativeApiGptBindBtn']) {
    const btn = $('#' + id); if (!btn) continue;
    btn.disabled = !hasTarget;
    btn.textContent = bound ? '解绑' : '绑定GPT';
    btn.title = bound ? `${title}。点击“解绑”解除当前客户与这个 ChatGPT 对话的绑定。` : `${title}。请先在右侧独立 ChatGPT 窗口打开正确的历史对话，再点击这里绑定。`;
  }
  for (const id of ['lineChatgptStageBtn','externalChatgptStageBtn','nativeApiGptStageBtn']) {
    const btn = $('#' + id); if (!btn) continue;
    // V1.27.69: V1.27.68 main process already supports first-message auto-bind,
    // but the renderer still disabled this button whenever bound=false. That
    // made the new workflow unreachable. A real selected customer is enough.
    btn.disabled = !hasTarget || loginProtected || loadFailureActive;
    btn.title = loadFailureActive
      ? (loadFailureCircuit?.manualRetryUsed
        ? '这个客户的 GPT 对话加载失败，人工重试已使用。请先解绑并重新绑定正确的 GPT 对话；程序不会继续自动刷新。'
        : '这个客户的 GPT 对话加载失败，已熔断后台导航和自动刷新。可在 ChatGPT 页面人工重试一次；失败后请重新绑定。')
      : (loginProtected
        ? 'ChatGPT 正在登录，请完成登录后再发送客户消息'
        : (bound
          ? '把这个客户最近一轮有效文字消息放进绑定的 ChatGPT 输入框；全部消息结尾只留一个“补充：”，检查/补充后再手动发送'
          : '新客户首次手动打开 GPT 工作台时会把固定人设 + 长期回复规则作为 TXT 附件发送并自动绑定；绑定后这里用于准备客户消息草稿'));
  }
  $('#shellChatgptBtn')?.classList.toggle('active', visible);
  if ($('#shellChatgptBtn')) $('#shellChatgptBtn').title = title;
  for (const id of ['lineDailyFlowStatus','externalDailyFlowStatus','nativeApiDailyFlowStatus']) {
    const badge = $('#' + id); if (!badge) continue;
    badge.classList.toggle('hidden', !hasTarget);
    badge.classList.toggle('active', dailyStatus === 'active');
    badge.classList.toggle('waiting', dailyStatus === 'waiting-morning' && dailyDay > 0);
    badge.classList.toggle('finished', dailyStatus === 'finished');
    badge.classList.toggle('paused', chatMode === 'reception');
    badge.classList.toggle('day-selectable', hasTarget);
    badge.setAttribute('role','button');
    badge.setAttribute('tabindex', hasTarget ? '0' : '-1');
    badge.textContent = hasTarget ? `${dailyLabel} ▾` : dailyLabel;
    const deliveryDetail = dailyDelivery
      ? ` 投递状态：${deliveryStatus}${Number(dailyDelivery.attempts||0) ? `，尝试 ${Number(dailyDelivery.attempts||0)} 次` : ''}${dailyDelivery.lastError ? `，最近原因：${String(dailyDelivery.lastError).slice(0,120)}` : ''}。`
      : '';
    const quickHint='';
    const directionDetail = dailyDirection ? ` 当天主线：${String(dailyDirection.dayGoal||'').slice(0,160)} 当前节点目标：${String(dailyDirection.currentObjective||'先回应客户当前内容').slice(0,120)} 已触达节点：${Array.isArray(dailyDirection.touchedSegmentLabels)&&dailyDirection.touchedSegmentLabels.length?dailyDirection.touchedSegmentLabels.join('、'):'无'}。` : '';
    badge.title = 'V1.27.260：新增10组主要聊天主题参考；主题不是按天流程，真实对话与边界优先。';
  }
  const formatLabel = chatgptWorkbenchUiState.replyFormat === 'japanese' ? '仅日语' : (chatgptWorkbenchUiState.replyFormat === 'chinese' ? '仅中文' : (chatgptWorkbenchUiState.replyFormat === 'english' ? '仅英文' : (chatgptWorkbenchUiState.replyFormat === 'auto' ? '自动语言' : '中日双语')));
  const tonePreview = String(chatgptWorkbenchUiState.replyTone || '').trim().replace(/\s+/g, ' ').slice(0, 70);
  for (const id of ['lineChatgptStyleBtn','externalChatgptStyleBtn']) {
    const btn = $('#' + id); if (!btn) continue;
    btn.title = `GPT回复语气 · ${formatLabel}${tonePreview ? ` · ${tonePreview}` : ''}`;
  }
}

async function refreshChatgptWorkbenchState() {
  try { renderChatgptWorkbenchState(await window.yoko.getChatgptWorkbenchState?.() || {}); } catch {}
}

async function toggleCurrentCustomerChatMode() {
  const current = String(chatgptWorkbenchUiState?.chatMode?.mode || 'reception');
  const next = current === 'deep' ? 'reception' : 'deep';
  const buttons=['lineChatModeBtn','externalChatModeBtn','nativeApiChatModeBtn'].map(id=>$('#'+id)).filter(Boolean);
  buttons.forEach(btn=>btn.disabled=true);
  try {
    const result=await window.yoko.setChatgptCustomerMode?.(next);
    if(result?.ok===false) throw new Error(result.error||'模式切换失败');
    renderChatgptWorkbenchState(result?.state || await window.yoko.getChatgptWorkbenchState?.() || {});
    const msg=`当前客户已切换为${next==='deep'?'精聊模式':'接待模式'}`;
    if(shellSurface==='external') setExternalStatus?.(msg); else if(shellSurface==='native-api') setNativeApiStatus?.(msg); else setStatus?.(msg);
  } catch(error) {
    const msg='聊天模式切换失败：'+(error?.message||error);
    if(shellSurface==='external') setExternalStatus?.(msg); else if(shellSurface==='native-api') setNativeApiStatus?.(msg); else setStatus?.(msg);
  } finally { buttons.forEach(btn=>btn.disabled=false); }
}
['lineChatModeBtn','externalChatModeBtn','nativeApiChatModeBtn'].forEach(id=>$('#'+id)?.addEventListener('click',toggleCurrentCustomerChatMode));

async function toggleChatgptWorkbench() {
  try {
    // V1.23.26: let the main process toggle its real window state; renderer state can be stale after native close/hide.
    const next = await window.yoko.toggleChatgptWorkbench?.();
    if (next?.ok === false) throw new Error(next.error || 'GPT工作台打开失败');
    renderChatgptWorkbenchState(next || {});
    const msg = next?.visible ? (next?.loginProtected ? 'GPT 登录保护中 · 请先完成登录，软件不会自动刷新页面' : (next?.bound ? `GPT 已打开 · ${next.target?.displayName || '当前客户'} 已自动进入绑定对话` : 'GPT 已在主程序右侧打开 · 请选择正确历史对话后点“绑定GPT”')) : 'GPT 工作台已关闭';
    if (shellSurface === 'external') setExternalStatus(msg); else setStatus(msg);
  } catch (error) {
    if (shellSurface === 'external') setExternalStatus('GPT工作台：' + (error?.message || error));
    else setStatus('GPT工作台：' + (error?.message || error));
  }
}

let chatgptAutoShowToken = 0;
async function autoShowChatgptForSelectedCustomer(delay = 0) {
  // V1.27.250: customer selection never opens GPT. The user owns the OPEN
  // action through the GPT rail/toolbar button.
  chatgptAutoShowToken += 1;
  return {ok:true,skipped:true,manualOpenRequired:true,version:'v127250-gpt-manual-open-only'};
}

async function openChatgptWorkbenchFromRail() {
  try {
    // The left GPT rail is an OPEN/FOCUS action, not a state guess. If the
    // sidecar is already open but behind another window, this brings it back.
    const next = await window.yoko.toggleChatgptWorkbench?.(true);
    if (next?.ok === false) throw new Error(next.error || 'GPT工作台打开失败');
    renderChatgptWorkbenchState(next || {});
    const msg = next?.loginProtected ? 'GPT 登录保护中 · 请先完成登录' : 'GPT 工作台已打开并贴在主窗口右侧';
    if (shellSurface === 'external') setExternalStatus(msg); else setStatus(msg);
  } catch (error) {
    if (shellSurface === 'external') setExternalStatus('GPT工作台：' + (error?.message || error));
    else setStatus('GPT工作台：' + (error?.message || error));
  }
}

async function bindCurrentCustomerToChatgpt() {
  const wasBound = !!chatgptWorkbenchUiState.bound;
  const bindButtons=['lineChatgptBindBtn','externalChatgptBindBtn','nativeApiGptBindBtn'].map(id=>$('#'+id)).filter(Boolean);
  if(bindButtons.some(btn=>btn.dataset.yokoBinding==='1'))return;
  bindButtons.forEach(btn=>{btn.dataset.yokoBinding='1';btn.disabled=true;btn.textContent=wasBound?'解绑中…':'绑定中…';});
  try {
    if (wasBound) {
      const result = await window.yoko.unbindCurrentChatgptConversation?.();
      if (result?.ok === false) throw new Error(result.error || '解绑失败');
      await refreshChatgptWorkbenchState();
      const msg = `${result?.target?.displayName || '当前客户'} 已解除 ChatGPT 绑定`;
      if (shellSurface === 'external') setExternalStatus(msg); else setStatus(msg);
      return;
    }
    if (!chatgptWorkbenchUiState.visible) {
      throw new Error('GPT 自动打开已关闭。请先手动点击“GPT”打开工作台，再点“绑定GPT”。');
    }
    const result = await window.yoko.bindCurrentChatgptConversation?.();
    if (result?.ok === false) throw new Error(result.error || '绑定失败');
    await refreshChatgptWorkbenchState();
    const msg = `${result?.target?.displayName || '当前客户'} 已绑定当前 ChatGPT 历史对话`;
    if (shellSurface === 'external') setExternalStatus(msg); else setStatus(msg);
  } catch (error) {
    const prefix = wasBound ? 'GPT解绑失败：' : 'GPT绑定失败：';
    if (shellSurface === 'external') setExternalStatus(prefix + (error?.message || error));
    else setStatus(prefix + (error?.message || error));
  } finally {
    bindButtons.forEach(btn=>{delete btn.dataset.yokoBinding;btn.disabled=false;});
    await refreshChatgptWorkbenchState().catch(()=>{});
  }
}

async function stageCustomerTurnToChatgpt() {
  const buttons = [$('#lineChatgptStageBtn'), $('#externalChatgptStageBtn'), $('#nativeApiGptStageBtn')].filter(Boolean);
  for (const button of buttons) { button.disabled = true; button.dataset.yokoSending = '1'; button.textContent = '准备中…'; }
  if (shellSurface === 'external') setExternalStatus('客户消息→GPT：正在读取客户消息并准备可编辑草稿…');
  else if (shellSurface === 'native-api') nativeApiSetStatus('客户消息→GPT：正在读取客户消息并准备可编辑草稿…');
  else setStatus('客户消息→GPT：正在读取客户消息并准备可编辑草稿…');
  try {
    const result = await window.yoko.stageCustomerTurnToChatgpt?.();
    if (result?.ok === false) throw new Error(result.error || '无法放入 ChatGPT');
    renderChatgptWorkbenchState({ visible:true, bound:!!result?.binding?.url || !!chatgptWorkbenchUiState.bound, target:result.target, binding:result.binding || chatgptWorkbenchUiState.binding });
    const count = Math.max(1, Number(result?.messageCount || 1) || 1);
    const msg = result?.bootstrapDraftReady
      ? '新客户专属 GPT 正在上传人设+规则 TXT 附件并初始化；完成后会自动绑定。'
      : (result?.drafted
        ? (result?.manualReplay
          ? '这批客户消息已按你的手动操作重新放入 GPT 输入框 · 请检查/补充后决定是否再次发送'
          : (result?.deduped
            ? '客户消息草稿已经在 GPT 输入框里，请直接补充后手动发送。'
            : (count > 1 ? `已准备客户连续 ${count} 条消息 · 全部消息结尾只有一个“补充：”，请填写想表达的内容后手动发送` : '客户最新消息已放入 GPT 输入框 · 可在结尾唯一的“补充：”后写你的想法，再手动发送')))
        : (result?.deduped ? '客户消息→GPT：这批消息已经处理过。' : String(result?.message || '客户消息已准备。')));
    if (shellSurface === 'external') setExternalStatus(msg); else if (shellSurface === 'native-api') nativeApiSetStatus(msg); else setStatus(msg);
  } catch (error) {
    if (shellSurface === 'external') setExternalStatus('客户消息→GPT：' + (error?.message || error));
    else if (shellSurface === 'native-api') nativeApiSetStatus('客户消息→GPT：' + (error?.message || error));
    else setStatus('客户消息→GPT：' + (error?.message || error));
  } finally {
    for (const button of buttons) { button.disabled = false; button.dataset.yokoSending = '0'; button.textContent = '客户消息→GPT'; }
  }
}

const CHATGPT_REPLY_TONE_DEFAULT = '自然、温柔、走心、有真实回应和亲近感；先回应对方的情绪和重点，再自然分享自己的感受；不要机械连续提问，不要模板式夸赞，也不要过度客气。';
let chatgptFlowLibraryBuiltinDefault = '';
let chatgptReceptionFlowBuiltinDefault = '';
let chatgptReplyRulesBuiltinDefault = '';
let chatgptFlowDaysDraft = {};
let chatgptFlowDaysBuiltinDefault = {};
let chatgptFlowDaySelected = 1;
const CHATGPT_PERSONA_DEFAULT = `姓名：Yoko / 鈴木優子，35岁，日本国籍，日本出生、在台北长大，目前居住在台北101附近。
职业：经营奢侈品商店，工作相对自由；关注经营、电商、经济和新技术。
性格与价值观：独立、自律、理性、温柔、有耐心，重视真诚、信任、稳定、家庭与责任感。
兴趣：旅行、温泉、摄影、网球、跑步、健身、音乐、电影、烹饪、时尚。
聊天方式：自然、温柔、真实、口语化；先理解并回应对方情绪，再分享自己的感受、生活细节或价值观；减少机械提问、模板式夸赞和过度客气；根据关系阶段自然增加亲近感。
回复排版：需要中日双语时，日语在前、中文在后，逐句分段；表情自然丰富但不过量。`;
const CHATGPT_REPLY_TONE_PRESETS = {
  warm: '自然、温柔、有亲近感，先回应对方的情绪和重点，再自然分享自己的感受；不要机械连续提问，也不要过度客气。',
  friend: '像熟悉的朋友一样轻松自然，口语化一点，可以带适量表情；不要太正式，不要每句话都感谢，也不要连续追问。',
  heartfelt: '精聊＋走心。先理解并回应对方当下的情绪、语气和潜台词，再自然分享自己的感受、生活细节或价值观，让交流有真实共鸣；减少机械提问。',
  close: '自然温柔的基础上增加一点亲近感和回应对方期待的感觉，但不要过度暧昧、不要刻意讨好，保持真实自然。',
  short: '简短、自然、口语化，重点明确，句子不要太长；保持温柔和真实感，不重复对方原话，不连续提问。',
  english: 'Use natural, warm, conversational English. Respond to the customer’s emotion and key point first, then share a small genuine reaction or life detail. Avoid robotic questions, canned compliments, and over-formality.',
  auto: '精聊＋走心。先理解并回应对方当下的情绪、语气和潜台词，再自然分享自己的感受、生活细节或价值观；语言跟随客户本轮主要语言，减少机械提问。'
};

function setChatgptReplyStyleStatus(text, kind = '') {
  const node = $('#chatgptReplyStyleStatus');
  if (!node) return;
  node.textContent = text || '';
  node.className = `gpt-style-save-status${kind ? ' ' + kind : ''}`;
}

function selectChatgptTonePreset(key = '') {
  document.querySelectorAll('[data-gpt-tone-preset]').forEach(btn => btn.classList.toggle('active', btn.dataset.gptTonePreset === key));
}

async function openChatgptReplyStyleSettings() {
  try {
    const result = await window.yoko.getChatgptReplySettings?.();
    if (result?.ok === false) throw new Error(result.error || '读取失败');
    const tone = String(result?.replyTone || CHATGPT_REPLY_TONE_DEFAULT);
    const format = ['auto','bilingual','japanese','chinese','english'].includes(String(result?.replyFormat || '')) ? result.replyFormat : 'bilingual';
    if ($('#chatgptReplyTone')) $('#chatgptReplyTone').value = tone;
    if ($('#chatgptReplyFormat')) $('#chatgptReplyFormat').value = format;
    const hasTarget = !!result?.target;
    const scope = hasTarget ? (result?.hasCustomerOverride ? 'customer' : 'customer') : 'global';
    if ($('#chatgptReplyScope')) {
      $('#chatgptReplyScope').value = scope;
      $('#chatgptReplyScope').querySelector('option[value="customer"]')?.toggleAttribute('disabled', !hasTarget);
    }
    const targetName = String(result?.target?.displayName || '').trim();
    if ($('#chatgptReplyScopeHint')) $('#chatgptReplyScopeHint').textContent = hasTarget
      ? `${targetName || '当前客户'}：${result?.hasCustomerOverride ? '已使用独立设置' : '目前继承全局；保存为“仅当前客户”后会独立生效。'}`
      : '当前没有选中客户，只能保存为全局默认。';
    const inheritBtn = $('#inheritChatgptReplyStyleBtn');
    if (inheritBtn) inheritBtn.disabled = !hasTarget || !result?.hasCustomerOverride;
    selectChatgptTonePreset('');
    setChatgptReplyStyleStatus('修改后点击“保存并使用”，下一次客户消息→GPT立即生效。');
    await openModal('chatgptReplyStyleModal');
    setTimeout(() => $('#chatgptReplyTone')?.focus(), 80);
  } catch (error) {
    if (shellSurface === 'external') setExternalStatus('GPT语气设置：' + (error?.message || error));
    else setStatus('GPT语气设置：' + (error?.message || error));
  }
}

async function saveChatgptReplyStyleSettings() {
  const tone = String($('#chatgptReplyTone')?.value || '').trim();
  const replyFormat = String($('#chatgptReplyFormat')?.value || 'bilingual');
  const scope = String($('#chatgptReplyScope')?.value || 'global');
  if (!tone) { setChatgptReplyStyleStatus('请填写回复语气，或者点击“恢复默认”。', 'error'); return; }
  try {
    const result = await window.yoko.saveChatgptReplySettings?.({ replyTone:tone, replyFormat, scope });
    if (result?.ok === false) throw new Error(result.error || '保存失败');
    renderChatgptWorkbenchState({ replyTone:result?.replyTone || tone, replyFormat:result?.replyFormat || replyFormat, replySettingsScope:result?.scope || scope });
    const scopeLabel = result?.scope === 'customer' ? `当前客户${result?.target?.displayName ? `（${result.target.displayName}）` : ''}` : '全局默认';
    setChatgptReplyStyleStatus(`✓ 已保存为${scopeLabel}，下一次客户消息→GPT会立即使用。`, 'ok');
    setTimeout(() => closeModal('chatgptReplyStyleModal'), 420);
  } catch (error) {
    setChatgptReplyStyleStatus('保存失败：' + (error?.message || error), 'error');
  }
}

async function inheritCurrentCustomerChatgptReplyStyle() {
  try {
    const result = await window.yoko.saveChatgptReplySettings?.({ scope:'inherit' });
    if (result?.ok === false) throw new Error(result.error || '恢复继承失败');
    if ($('#chatgptReplyTone')) $('#chatgptReplyTone').value = String(result?.replyTone || CHATGPT_REPLY_TONE_DEFAULT);
    if ($('#chatgptReplyFormat')) $('#chatgptReplyFormat').value = String(result?.replyFormat || 'bilingual');
    if ($('#chatgptReplyScope')) $('#chatgptReplyScope').value = 'customer';
    $('#inheritChatgptReplyStyleBtn') && ($('#inheritChatgptReplyStyleBtn').disabled = true);
    if ($('#chatgptReplyScopeHint')) $('#chatgptReplyScopeHint').textContent = `${result?.target?.displayName || '当前客户'}：已恢复继承全局默认。`;
    renderChatgptWorkbenchState({ replyTone:result?.replyTone || CHATGPT_REPLY_TONE_DEFAULT, replyFormat:result?.replyFormat || 'bilingual', replySettingsScope:'global' });
    setChatgptReplyStyleStatus('✓ 当前客户已恢复继承全局默认。', 'ok');
  } catch (error) {
    setChatgptReplyStyleStatus('操作失败：' + (error?.message || error), 'error');
  }
}

function setChatgptPersonaStatus(text, kind = '') {
  const node = $('#chatgptPersonaStatus');
  if (!node) return;
  node.textContent = text || '';
  node.className = `gpt-style-save-status${kind ? ' ' + kind : ''}`;
}

function normalizeChatgptFlowDaysUi(value = {}, fallback = {}) {
  const src=value&&typeof value==='object'?value:{};
  const fb=fallback&&typeof fallback==='object'?fallback:{};
  const out={};
  for(let day=1;day<=10;day+=1){
    const key=`day${day}`;
    out[key]=String(src[key] ?? src[String(day)] ?? fb[key] ?? fb[String(day)] ?? '').replace(/\r\n?/g,'\n').trim().slice(0,20000);
  }
  return out;
}

function persistSelectedChatgptFlowDayDraft() {
  const day=Math.max(1,Math.min(10,Number(chatgptFlowDaySelected||1)||1));
  if ($('#chatgptFlowLibrary')) chatgptFlowDaysDraft[`day${day}`]=String($('#chatgptFlowLibrary').value||'').replace(/\r\n?/g,'\n').trim().slice(0,20000);
}

function renderChatgptFlowDayEditor(day = 1, {persist=true} = {}) {
  if(persist)persistSelectedChatgptFlowDayDraft();
  chatgptFlowDaySelected=Math.max(1,Math.min(10,Number(day||1)||1));
  const key=`day${chatgptFlowDaySelected}`;
  if ($('#chatgptFlowLibrary')) $('#chatgptFlowLibrary').value=String(chatgptFlowDaysDraft[key]||'');
  if ($('#chatgptFlowDayEditorLabel')) $('#chatgptFlowDayEditorLabel').textContent=`Day ${chatgptFlowDaySelected} 流程`;
  document.querySelectorAll('[data-chatgpt-flow-day]').forEach(btn=>btn.classList.toggle('active',Number(btn.dataset.chatgptFlowDay)===chatgptFlowDaySelected));
}

async function openChatgptPersonaSettings() {
  try {
    const result = await window.yoko.getChatgptPersona?.();
    if (result?.ok === false) throw new Error(result.error || '读取失败');
    if ($('#chatgptPersonaProfile')) $('#chatgptPersonaProfile').value = String(result?.personaProfile || CHATGPT_PERSONA_DEFAULT);
    chatgptReplyRulesBuiltinDefault = String(result?.defaultReplyRules || result?.replyRules || '');
    if ($('#chatgptReplyRules')) $('#chatgptReplyRules').value = String(result?.replyRules || chatgptReplyRulesBuiltinDefault);
    // Day 1～Day 10 was retired in V1.27.255. Keep old draft variables empty
    // so legacy renderer helpers cannot accidentally reintroduce day content.
    chatgptFlowLibraryBuiltinDefault = '';
    chatgptReceptionFlowBuiltinDefault = '';
    chatgptFlowDaysBuiltinDefault = {};
    chatgptFlowDaysDraft = {};
    setChatgptPersonaStatus('固定人设 + 长期 Stage 回复规则已加载。Day 1～Day 10 已取消。');
    await openModal('chatgptPersonaModal');
    setTimeout(() => $('#chatgptPersonaProfile')?.focus(), 80);
  } catch (error) {
    if (shellSurface === 'external') setExternalStatus('GPT人设/规则：' + (error?.message || error));
    else if (shellSurface === 'native-api') nativeApiSetStatus('GPT人设/规则：' + (error?.message || error));
    else setStatus('GPT人设/规则：' + (error?.message || error));
  }
}

async function saveChatgptPersonaSettings({ send = false } = {}) {
  const persona = String($('#chatgptPersonaProfile')?.value || '').trim();
  const replyRules = String($('#chatgptReplyRules')?.value || '').trim();
  if (!persona) { setChatgptPersonaStatus('请填写人设资料，或者点击“恢复默认”。', 'error'); return; }
  if (!replyRules) { setChatgptPersonaStatus('请填写长期回复规则，或者点击“恢复默认”。', 'error'); return; }
  try {
    const saved = await window.yoko.saveChatgptPersona?.({ personaProfile:persona, replyRules, flowDays:{}, flowLibrary:'' });
    if (saved?.ok === false) throw new Error(saved.error || '保存失败');
    chatgptReplyRulesBuiltinDefault = String(saved?.defaultReplyRules || chatgptReplyRulesBuiltinDefault || '');
    if (!send) {
      setChatgptPersonaStatus('✓ 固定人设和长期 Stage 回复规则已保存。Day 1～Day 10 不再使用。', 'ok');
      setTimeout(() => closeModal('chatgptPersonaModal'), 420);
      return;
    }
    setChatgptPersonaStatus('正在把固定人设 + 长期回复规则发送给当前 ChatGPT 对话…');
    const sent = await window.yoko.sendChatgptPersona?.();
    if (sent?.ok === false) throw new Error(sent.error || '发送失败');
    setChatgptPersonaStatus('✓ 固定人设 + 长期回复规则已发送。', 'ok');
    if (shellSurface === 'external') setExternalStatus('GPT固定人设 + 长期回复规则已发送');
    else if (shellSurface === 'native-api') nativeApiSetStatus('GPT固定人设 + 长期回复规则已发送');
    else setStatus('GPT固定人设 + 长期回复规则已发送');
    setTimeout(() => closeModal('chatgptPersonaModal'), 520);
  } catch (error) {
    setChatgptPersonaStatus('操作失败：' + (error?.message || error), 'error');
  }
}

function renderAutomationMasterState(enabled) {
  const on = enabled !== false;
  for (const id of ['lineAutomationBtn','externalAutomationBtn']) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.textContent = on ? '自动化 ON' : '自动化 OFF';
    btn.classList.toggle('automation-off', !on);
    btn.title = on ? '自动化已开启 · 点击查看设置' : '自动化已关闭 · 点击开启或查看设置';
  }
  const master = document.getElementById('automationMasterEnabled');
  if (master) master.checked = on;
}
function syncAutomationMasterControls() {
  const enabled = document.getElementById('automationMasterEnabled')?.checked !== false;
  for (const id of ['automationAutoGenerateReplyEnabled','automationAutoGenerateOnSelection','automationAutoGenerateDebounceMs']) {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  }
}

function setAutomationFoundationStatus(text, kind = '') {
  const node = $('#automationFoundationStatus');
  if (!node) return;
  node.textContent = text || '';
  node.className = `gpt-style-save-status${kind ? ' ' + kind : ''}`;
}

// V1.27.223: the top Day status badge is now the primary operator shortcut.
// Selecting Day N is a one-time calendar rebase; the existing automatic 05:00/23:00
// clock stays authoritative afterwards.
let dailyFlowQuickPickerAnchor = null;
let dailyFlowQuickPickerNativeViewsSuppressed = false;
let dailyFlowQuickPickerReassertTimers = [];
function clearDailyFlowQuickPickerReassertTimers(){
  for(const timer of dailyFlowQuickPickerReassertTimers.splice(0)){ try{clearTimeout(timer);}catch{} }
}
function ensureDailyFlowQuickPicker() {
  let picker=$('#dailyFlowQuickPicker');
  if(picker)return picker;
  picker=document.createElement('div');
  picker.id='dailyFlowQuickPicker';
  picker.className='daily-flow-quick-picker hidden';
  picker.innerHTML=`<div class="daily-flow-quick-picker-head"><div><strong>手动校正今天的 Day</strong><small>选择一次后继续自动推进；不会切成手动模式。</small></div><button class="daily-flow-quick-picker-close" type="button" aria-label="关闭">×</button></div><div class="daily-flow-quick-picker-grid">${Array.from({length:10},(_,i)=>`<button type="button" data-day="${i+1}">Day ${i+1}</button>`).join('')}</div><div class="daily-flow-quick-picker-status">请选择 Day 1～Day 10。</div><div class="daily-flow-quick-picker-actions"><button type="button" data-open-full="1">打开详细自动化设置</button></div>`;
  document.body.appendChild(picker);
  picker.querySelector('.daily-flow-quick-picker-close')?.addEventListener('click',()=>closeDailyFlowQuickPicker().catch(()=>{}));
  picker.querySelector('[data-open-full="1"]')?.addEventListener('click',async()=>{
    await closeDailyFlowQuickPicker();
    await openAutomationFoundationSettings();
    setTimeout(()=>$('#automationCurrentDaySelect')?.focus(),80);
  });
  picker.querySelectorAll('[data-day]').forEach(btn=>btn.addEventListener('click',async()=>{
    const day=Math.max(1,Math.min(10,Number(btn.dataset.day||0)||0));
    if(!day)return;
    const status=picker.querySelector('.daily-flow-quick-picker-status');
    const buttons=[...picker.querySelectorAll('[data-day]')];
    buttons.forEach(x=>x.disabled=true);
    if(status)status.textContent=`正在把今天校正为 Day ${day}…`;
    try{
      const result=await window.yoko.setChatgptDailyFlowCurrentDay?.(day);
      if(result?.ok===false)throw new Error(result.error||'校正失败');
      if(result?.workbenchState)renderChatgptWorkbenchState(result.workbenchState);
      else await refreshChatgptWorkbenchState();
      if(status)status.textContent=result?.message||`已校正为 Day ${day}，后续继续自动推进。`;
      buttons.forEach(x=>x.classList.toggle('current',Number(x.dataset.day||0)===day));
      if(shellSurface==='external')setExternalStatus?.(`今天已校正为 Day ${day} · 后续继续自动`);
      else if(shellSurface==='native-api')nativeApiSetStatus?.(`今天已校正为 Day ${day} · 后续继续自动`);
      else setStatus?.(`今天已校正为 Day ${day} · 后续继续自动`);
      setTimeout(()=>closeDailyFlowQuickPicker().catch(()=>{}),850);
    }catch(error){
      if(status)status.textContent='校正失败：'+(error?.message||error);
    }finally{buttons.forEach(x=>x.disabled=false);}
  }));
  return picker;
}
function positionDailyFlowQuickPicker(picker,anchor){
  if(!picker||!anchor)return;
  const r=anchor.getBoundingClientRect();
  const width=290;
  const left=Math.max(8,Math.min(window.innerWidth-width-8,r.right-width));
  const below=r.bottom+7;
  picker.style.left=`${left}px`;
  picker.style.top=`${Math.min(window.innerHeight-250,below)}px`;
}
async function closeDailyFlowQuickPicker(){
  const picker=$('#dailyFlowQuickPicker');
  if(picker)picker.classList.add('hidden');
  dailyFlowQuickPickerAnchor=null;
  clearDailyFlowQuickPickerReassertTimers();
  if(dailyFlowQuickPickerNativeViewsSuppressed){
    dailyFlowQuickPickerNativeViewsSuppressed=false;
    // V1.27.224: the selector lives in the shell renderer while LINE/TG/FB live
    // in native WebContentsViews above it. Restore the native page only after
    // the selector has fully closed so it cannot steal the final click.
    try{await window.yoko.setNativeViewsVisible?.(true);}catch{}
  }
}
async function openDailyFlowQuickPicker(anchor){
  if(!anchor||!chatgptWorkbenchUiState?.target)return;
  // V1.27.224: WebContentsView is a native child surface above renderer HTML.
  // V1.27.223 opened the selector correctly but it was visually hidden behind
  // Telegram/Facebook/LINE, which looked exactly like a dead left click. Hide
  // native views while the small operator selector is open, same principle as
  // the existing settings/modal suppression path.
  try{
    await window.yoko.setNativeViewsVisible?.(false);
    dailyFlowQuickPickerNativeViewsSuppressed=true;
  }catch{}
  const picker=ensureDailyFlowQuickPicker();
  dailyFlowQuickPickerAnchor=anchor;
  picker.classList.remove('hidden');
  positionDailyFlowQuickPicker(picker,anchor);
  clearDailyFlowQuickPickerReassertTimers();
  if(typeof window.yoko.setNativeViewsVisible==='function'){
    for(const delay of [80,260]) dailyFlowQuickPickerReassertTimers.push(setTimeout(()=>window.yoko.setNativeViewsVisible(false).catch(()=>{}),delay));
  }
  const current=Math.max(0,Number(chatgptWorkbenchUiState?.dailyFlowState?.currentDay||0)||0);
  picker.querySelectorAll('[data-day]').forEach(x=>x.classList.toggle('current',Number(x.dataset.day||0)===current));
  const status=picker.querySelector('.daily-flow-quick-picker-status');
  if(status)status.textContent=chatgptWorkbenchUiState?.bound
    ? (current>0?`系统当前：Day ${current}。请选择需要校正到的 Day。`:'当前是新客户期。请选择今天应当作为哪一个 Day。')
    : '当前客户尚未绑定 GPT；请先绑定 GPT，再校正 Day。';
  picker.querySelectorAll('[data-day]').forEach(x=>x.disabled=!chatgptWorkbenchUiState?.bound);
}
for(const id of ['lineDailyFlowStatus','externalDailyFlowStatus','nativeApiDailyFlowStatus']){
  const badge=$('#'+id); if(!badge)continue;
  badge.addEventListener('click',async ev=>{ev.preventDefault();ev.stopPropagation();await openDailyFlowQuickPicker(badge);});
  badge.addEventListener('keydown',async ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();await openDailyFlowQuickPicker(badge);}});
}
document.addEventListener('click',ev=>{
  const picker=$('#dailyFlowQuickPicker');
  if(!picker||picker.classList.contains('hidden'))return;
  if(picker.contains(ev.target)||dailyFlowQuickPickerAnchor?.contains?.(ev.target))return;
  closeDailyFlowQuickPicker().catch(()=>{});
});
document.addEventListener('keydown',ev=>{if(ev.key==='Escape')closeDailyFlowQuickPicker().catch(()=>{});});
window.addEventListener('resize',()=>{const picker=$('#dailyFlowQuickPicker');if(picker&&!picker.classList.contains('hidden')&&dailyFlowQuickPickerAnchor)positionDailyFlowQuickPicker(picker,dailyFlowQuickPickerAnchor);});

function localDateKeyForAutomationDay(value = Date.now()) {
  const d=new Date(Number(value)||Date.now());
  const p=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}
function renderAutomationCurrentDayState(state = {}) {
  const target=state?.target && typeof state.target==='object' ? state.target : null;
  const bound=!!state?.bound;
  const daily=state?.dailyFlowState && typeof state.dailyFlowState==='object' ? state.dailyFlowState : {};
  const node=$('#automationCurrentDayStatus');
  const select=$('#automationCurrentDaySelect');
  const apply=$('#automationApplyCurrentDayBtn');
  const hint=$('#automationCurrentDayHint');
  const day=Math.max(0,Number(daily.currentDay||0)||0);
  const status=String(daily.status||'waiting-morning');
  const correctionDay=Math.max(0,Number(daily.manualDayCorrectionDay||0)||0);
  const correctionDate=String(daily.manualDayCorrectionDateKey||'');
  const today=localDateKeyForAutomationDay();
  if(!target){
    if(node)node.textContent='请先选择客户';
    if(select){select.value='';select.disabled=true;}
    if(apply)apply.disabled=true;
    if(hint)hint.textContent='请先打开一个客户聊天，再进行 Day 流程校正。';
    return;
  }
  if(!bound){
    if(node)node.textContent=`${String(target.displayName||'当前客户')} · 尚未绑定 GPT`;
    if(select){select.value='';select.disabled=true;}
    if(apply)apply.disabled=true;
    if(hint)hint.textContent='当前客户还没有绑定 GPT。绑定后才能校正 Day 流程。';
    return;
  }
  const statusText=status==='active'?'进行中':status==='finished'?'已完成':(day>0?'等待下个自动时段':'新客户期');
  const scheduledCorrection=correctionDate===today&&correctionDay>0 ? ` · 今天已手动校正为 Day ${correctionDay}` : '';
  if(node)node.textContent=day>0?`Day ${day} · ${statusText}${scheduledCorrection}`:`新客户 · ${statusText}${scheduledCorrection}`;
  if(select){select.disabled=false;select.value='';}
  if(apply)apply.disabled=false;
  if(hint){
    hint.textContent=correctionDate===today&&correctionDay>0
      ? `今天已校正为 Day ${correctionDay}。这不是“手动模式”；后续会继续按原来的自动时间规则推进。`
      : '选择后只重设当前客户的 Day 起点，不会关闭自动流程，也不需要第二天再次手动选择。';
  }
}
async function refreshAutomationCurrentDayState() {
  try{
    const state=await window.yoko.getChatgptWorkbenchState?.();
    if(state?.ok===false)throw new Error(state.error||'读取失败');
    renderAutomationCurrentDayState(state||{});
    return state||{};
  }catch(error){
    renderAutomationCurrentDayState({});
    const hint=$('#automationCurrentDayHint');
    if(hint)hint.textContent='读取当前客户 Day 状态失败：'+(error?.message||error);
    return null;
  }
}
async function applyAutomationCurrentDayCorrection() {
  const day=Math.max(1,Math.min(10,Number($('#automationCurrentDaySelect')?.value||0)||0));
  if(!day){
    const hint=$('#automationCurrentDayHint'); if(hint)hint.textContent='请先选择 Day 1～Day 10。';
    return;
  }
  const btn=$('#automationApplyCurrentDayBtn'); if(btn)btn.disabled=true;
  try{
    const result=await window.yoko.setChatgptDailyFlowCurrentDay?.(day);
    if(result?.ok===false)throw new Error(result.error||'校正失败');
    if(result?.workbenchState)renderChatgptWorkbenchState(result.workbenchState);
    renderAutomationCurrentDayState(result?.workbenchState||{});
    const hint=$('#automationCurrentDayHint');
    if(hint)hint.textContent=result?.message||`已把今天校正为 Day ${day}，后续继续自动推进。`;
    setAutomationFoundationStatus(`✓ 当前客户今天已校正为 Day ${day}；自动流程继续运行。`,'ok');
  }catch(error){
    const hint=$('#automationCurrentDayHint'); if(hint)hint.textContent='校正失败：'+(error?.message||error);
    setAutomationFoundationStatus('Day 校正失败：'+(error?.message||error),'error');
  }finally{if(btn)btn.disabled=false;}
}
function renderAutomationQueueStatus(queue = {}) {
  const node = $('#automationQueueStatus');
  if (!node) return;
  const running = Math.max(0, Number(queue?.running || 0) || 0);
  const pending = Math.max(0, Number(queue?.pending || 0) || 0);
  node.textContent = running || pending ? `运行 ${running} · 排队 ${pending}` : '空闲';
}
function renderAutomationGptMonitorStatus(monitor = {}) {
  const node = $('#automationGptMonitorStatus');
  if (!node) return;
  if (monitor?.enabled === false) node.textContent = '已关闭';
  else if (monitor?.busy) node.textContent = '检测中';
  else if (monitor?.pending) node.textContent = '等待合并';
  else node.textContent = `运行中 · 已生成 ${Math.max(0, Number(monitor?.generatedCount || 0) || 0)}`;
}
async function openAutomationFoundationSettings() {
  try {
    const result = await window.yoko.getAutomationSettings?.();
    if (result?.ok === false) throw new Error(result.error || '读取失败');
    const cfg = result?.settings || {};
    renderAutomationMasterState(cfg.masterEnabled !== false);
    syncAutomationMasterControls();
    if ($('#automationSendQueueEnabled')) $('#automationSendQueueEnabled').checked = cfg.sendQueueEnabled !== false;
    if ($('#automationPreventDuplicateSend')) $('#automationPreventDuplicateSend').checked = cfg.preventDuplicateSend !== false;
    if ($('#automationTargetRecheck')) $('#automationTargetRecheck').checked = cfg.requireTargetRecheck !== false;
    if ($('#automationDiagnosticsEnabled')) $('#automationDiagnosticsEnabled').checked = cfg.diagnosticsEnabled !== false;
    if ($('#automationAutoGenerateReplyEnabled')) $('#automationAutoGenerateReplyEnabled').checked = cfg.autoGenerateReplyEnabled !== false;
    if ($('#automationAutoGenerateOnSelection')) $('#automationAutoGenerateOnSelection').checked = cfg.autoGenerateOnSelection !== false;
    const autoDebounceMs = String(Number(cfg.autoGenerateDebounceMs || 1800));
    const autoDebounceSelect = $('#automationAutoGenerateDebounceMs');
    if (autoDebounceSelect) autoDebounceSelect.value = ['1200','1800','2500','4000'].includes(autoDebounceMs) ? autoDebounceMs : '1800';
    const windowMs = String(Number(cfg.duplicateWindowMs || 5000));
    const select = $('#automationDuplicateWindowMs');
    if (select) select.value = ['3000','5000','8000','12000'].includes(windowMs) ? windowMs : '5000';
    renderAutomationQueueStatus(result?.queue || {});
    renderAutomationGptMonitorStatus(result?.monitor || {});
    await refreshAutomationCurrentDayState();
    setAutomationFoundationStatus(cfg.masterEnabled === false ? '自动化当前已关闭：不会自动识别或自动生成；手动功能仍可正常使用。Day 校正只调整进度，不会改变总开关。' : '自动化已开启：当前客户新消息会自动送入绑定 GPT；真正发给客户仍由你点击“发送”。');
    await openModal('automationFoundationModal');
  } catch (error) {
    const msg = '自动化设置：' + (error?.message || error);
    if (shellSurface === 'external') setExternalStatus(msg); else setStatus(msg);
  }
}
async function saveAutomationFoundationSettings() {
  try {
    const payload = {
      masterEnabled: !!$('#automationMasterEnabled')?.checked,
      sendQueueEnabled: !!$('#automationSendQueueEnabled')?.checked,
      preventDuplicateSend: !!$('#automationPreventDuplicateSend')?.checked,
      duplicateWindowMs: Number($('#automationDuplicateWindowMs')?.value || 5000),
      requireTargetRecheck: !!$('#automationTargetRecheck')?.checked,
      diagnosticsEnabled: !!$('#automationDiagnosticsEnabled')?.checked,
      autoGenerateReplyEnabled: !!$('#automationAutoGenerateReplyEnabled')?.checked,
      autoGenerateOnSelection: !!$('#automationAutoGenerateOnSelection')?.checked,
      autoGenerateDebounceMs: Number($('#automationAutoGenerateDebounceMs')?.value || 1800)
    };
    const result = await window.yoko.saveAutomationSettings?.(payload);
    if (result?.ok === false) throw new Error(result.error || '保存失败');
    renderAutomationMasterState(result?.settings?.masterEnabled !== false);
    syncAutomationMasterControls();
    renderAutomationQueueStatus(result?.queue || {});
    renderAutomationGptMonitorStatus(result?.monitor || {});
    setAutomationFoundationStatus(result?.settings?.masterEnabled === false ? '✓ 已保存 · 自动化已关闭，手动功能保持可用。' : '✓ 已保存 · 自动化已开启。', 'ok');
    setTimeout(() => closeModal('automationFoundationModal'), 520);
  } catch (error) {
    setAutomationFoundationStatus('保存失败：' + (error?.message || error), 'error');
  }
}

$('#automationMasterEnabled')?.addEventListener('change', syncAutomationMasterControls);
$('#automationApplyCurrentDayBtn')?.addEventListener('click', applyAutomationCurrentDayCorrection);
$('#lineChatgptToggleBtn')?.addEventListener('click', toggleChatgptWorkbench);
$('#externalChatgptToggleBtn')?.addEventListener('click', toggleChatgptWorkbench);
$('#shellChatgptBtn')?.addEventListener('click', openChatgptWorkbenchFromRail);
$('#lineChatgptBindBtn')?.addEventListener('click', bindCurrentCustomerToChatgpt);
$('#externalChatgptBindBtn')?.addEventListener('click', bindCurrentCustomerToChatgpt);
async function linkWsExistingFacebookGpt() {
  let inheritDialog = null;
  const restoreWsView = async () => {
    const otherModalOpen = [...document.querySelectorAll('.modal')].some(m => m !== inheritDialog && !m.classList.contains('hidden'));
    if (!otherModalOpen && inheritDialog?.isConnected === false) {
      try { await window.yoko.setNativeViewsVisible?.(true); } catch {}
    }
  };
  const closeInheritDialog = async () => {
    inheritDialog?.remove();
    await restoreWsView();
  };
  try {
    const result=await window.yoko.getWsExistingChatgptBindings?.();
    if(!result?.ok)throw new Error(result?.error||'无法读取 Facebook GPT 绑定');
    if(!result.items?.length)throw new Error('没有找到已绑定 GPT 的 Facebook 客户');
    // The native WhatsApp WebContentsView overlays HTML regardless of z-index.
    // Suppress it before rendering our chooser, just like regular app modals.
    await window.yoko.setNativeViewsVisible?.(false);
    const backdrop=document.createElement('div');
    inheritDialog=backdrop;
    backdrop.style.cssText='position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.45);display:grid;place-items:center';
    const panel=document.createElement('div');
    panel.style.cssText='background:var(--surface,#fff);color:var(--text,#202934);padding:22px;border-radius:12px;width:min(460px,92vw);box-shadow:0 14px 40px #0003';
    const title=document.createElement('h3');title.textContent='WS 客户继承 Facebook GPT 会话';panel.append(title);
    const note=document.createElement('p');note.textContent=`当前 WS 客户：${result.customerName}。请人工核对来源客户，严禁仅凭同名选择。`;panel.append(note);
    // V1.27.292: searchable chooser. Never perform name-based automatic linking.
    const search=document.createElement('input');search.type='search';search.placeholder='搜索 Facebook 客户姓名、客户 ID 或 Page…';
    search.setAttribute('aria-label','搜索已绑定 GPT 的 Facebook 客户');
    search.style.cssText='width:100%;box-sizing:border-box;padding:11px;margin:8px 0 10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit';
    panel.append(search);
    const count=document.createElement('div');count.style.cssText='color:#64748b;font-size:12px;margin-bottom:6px';panel.append(count);
    const list=document.createElement('div');list.setAttribute('role','radiogroup');list.setAttribute('aria-label','Facebook 来源客户');
    list.style.cssText='max-height:min(38vh,310px);min-height:64px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:12px';panel.append(list);
    const detail=document.createElement('div');detail.style.cssText='font-size:12px;color:#64748b;line-height:1.6;margin-bottom:10px';panel.append(detail);
    let selectedKey='';
    const normalize=value=>String(value||'').normalize('NFKC').toLocaleLowerCase().trim();
    const safeLabel=value=>String(value||'').includes('\uFFFD')?'姓名含乱码，请核对客户 ID':String(value||'');
    const sourcePage=item=>String(item.pageName||'').trim()||`Page ID：${String(item.accountId||'').replace(/^fb-api:/,'')||'未知'}`;
    const matches=item=>normalize([item.displayName,item.accountId,item.pageName,item.key].join(' ')).includes(normalize(search.value));
    const render=()=>{
      const filtered=result.items.filter(matches);list.replaceChildren();
      count.textContent=`找到 ${filtered.length} / ${result.items.length} 位已绑定 GPT 客户`;
      for(const item of filtered){
        const btn=document.createElement('button');btn.type='button';btn.setAttribute('role','radio');
        btn.setAttribute('aria-checked',String(selectedKey===item.key));
        btn.style.cssText=`display:block;width:100%;box-sizing:border-box;text-align:left;padding:10px 12px;border:0;border-bottom:1px solid #edf2f7;background:${selectedKey===item.key?'#e8f3ff':'transparent'};color:inherit;cursor:pointer;white-space:normal`;
        const name=document.createElement('strong');name.textContent=safeLabel(item.displayName);btn.append(name);
        const meta=document.createElement('div');meta.style.cssText='font-size:12px;color:#64748b;margin-top:3px';
        meta.textContent=`${sourcePage(item)} · ${item.accountId||'无账号ID'}`;btn.append(meta);
        btn.addEventListener('click',()=>{selectedKey=item.key;detail.textContent=`已选择：${safeLabel(item.displayName)} / ${sourcePage(item)} / ${item.accountId||''}。请人工确认身份后继承。`;render();});
        list.append(btn);
      }
      if(!filtered.length){const empty=document.createElement('p');empty.textContent='没有匹配客户，请尝试姓名、Facebook 客户 ID 或主页 ID。';empty.style.cssText='padding:12px;color:#64748b';list.append(empty);}
      confirm.disabled=!selectedKey || !result.items.some(x=>x.key===selectedKey);
    };
    search.addEventListener('input',render);
    const buttons=document.createElement('div');buttons.style.cssText='display:flex;gap:10px;justify-content:flex-end';
    const cancel=document.createElement('button');cancel.textContent='取消';cancel.type='button';cancel.onclick=()=>{ void closeInheritDialog(); };
    const confirm=document.createElement('button');confirm.textContent='确认同一客户并继承';confirm.type='button';
    confirm.onclick=async()=>{confirm.disabled=true;try{const selected=result.items.find(x=>x.key===selectedKey);if(!selected)throw new Error('请选择来源客户');
      if(!window.confirm(`请确认 WS 客户「${result.customerName}」和 Facebook 客户「${selected.displayName}」确实是同一个人。关联后共享 GPT 会话，但仍分别向各平台发送消息。`))return;
      const linked=await window.yoko.linkWsExistingChatgptBinding?.(selected.key);if(!linked?.ok)throw new Error(linked?.error||'关联失败');
      await closeInheritDialog();await refreshChatgptWorkbenchState();setExternalStatus('WS 已继承原 Facebook 客户 GPT 会话，原 Facebook 绑定保持不变。');
    }catch(error){setExternalStatus('继承 GPT 失败：'+(error?.message||error))}finally{confirm.disabled=false}};
    buttons.append(cancel,confirm);panel.append(buttons);backdrop.append(panel);document.body.append(backdrop);
    // Keep the chooser above the native view during delayed resize/surface updates.
    for(const delay of [80,260]) setTimeout(()=>{if(backdrop.isConnected)window.yoko.setNativeViewsVisible?.(false)?.catch?.(()=>{});},delay);
    backdrop.addEventListener('keydown', event=>{if(event.key==='Escape'){event.preventDefault();void closeInheritDialog();}});
    render();search.focus();
  }catch(error){if(inheritDialog?.isConnected)await closeInheritDialog();else {inheritDialog={isConnected:false};await restoreWsView();}setExternalStatus('继承 GPT：'+(error?.message||error))}
}
$('#externalChatgptInheritBtn')?.addEventListener('click',linkWsExistingFacebookGpt);

$('#lineChatgptStageBtn')?.addEventListener('click', stageCustomerTurnToChatgpt);
$('#externalChatgptStageBtn')?.addEventListener('click', stageCustomerTurnToChatgpt);
$('#lineChatgptStyleBtn')?.addEventListener('click', openChatgptReplyStyleSettings);
$('#externalChatgptStyleBtn')?.addEventListener('click', openChatgptReplyStyleSettings);
$('#lineChatgptPersonaBtn')?.addEventListener('click', openChatgptPersonaSettings);
$('#externalChatgptPersonaBtn')?.addEventListener('click', openChatgptPersonaSettings);
$('#nativeApiChatgptPersonaBtn')?.addEventListener('click', openChatgptPersonaSettings);
$('#lineAutomationBtn')?.addEventListener('click', openAutomationFoundationSettings);
$('#externalAutomationBtn')?.addEventListener('click', openAutomationFoundationSettings);
$('#saveAutomationFoundationBtn')?.addEventListener('click', saveAutomationFoundationSettings);
$('#saveChatgptReplyStyleBtn')?.addEventListener('click', saveChatgptReplyStyleSettings);
$('#inheritChatgptReplyStyleBtn')?.addEventListener('click', inheritCurrentCustomerChatgptReplyStyle);
$('#saveChatgptPersonaBtn')?.addEventListener('click', () => saveChatgptPersonaSettings({ send:false }));
$('#sendChatgptPersonaBtn')?.addEventListener('click', () => saveChatgptPersonaSettings({ send:true }));
$('#resetChatgptPersonaBtn')?.addEventListener('click', () => {
  if ($('#chatgptPersonaProfile')) $('#chatgptPersonaProfile').value = CHATGPT_PERSONA_DEFAULT;
  if ($('#chatgptReplyRules')) $('#chatgptReplyRules').value = chatgptReplyRulesBuiltinDefault;
  setChatgptPersonaStatus('已恢复默认人设和长期回复规则；保存后生效。');
});
document.querySelectorAll('[data-chatgpt-flow-day]').forEach(btn => btn.addEventListener('click', () => {
  renderChatgptFlowDayEditor(Number(btn.dataset.chatgptFlowDay || 1));
  setChatgptPersonaStatus(`正在编辑 Day ${chatgptFlowDaySelected}。每一天单独保存、单独加载。`);
}));
$('#resetChatgptReplyStyleBtn')?.addEventListener('click', () => {
  if ($('#chatgptReplyTone')) $('#chatgptReplyTone').value = CHATGPT_REPLY_TONE_DEFAULT;
  if ($('#chatgptReplyFormat')) $('#chatgptReplyFormat').value = 'bilingual';
  selectChatgptTonePreset('warm');
  setChatgptReplyStyleStatus('已恢复默认内容，点击“保存并使用”后生效。');
});
document.querySelectorAll('[data-gpt-tone-preset]').forEach(btn => btn.addEventListener('click', () => {
  const key = String(btn.dataset.gptTonePreset || '');
  const tone = CHATGPT_REPLY_TONE_PRESETS[key];
  if (!tone) return;
  if ($('#chatgptReplyTone')) $('#chatgptReplyTone').value = tone;
  if (key === 'english' && $('#chatgptReplyFormat')) $('#chatgptReplyFormat').value = 'english';
  if (key === 'auto' && $('#chatgptReplyFormat')) $('#chatgptReplyFormat').value = 'auto';
  selectChatgptTonePreset(key);
  setChatgptReplyStyleStatus(`已切换到“${btn.textContent.trim()}”，可继续编辑后保存。`);
}));
$('#chatgptReplyTone')?.addEventListener('input', () => selectChatgptTonePreset(''));

window.yoko.onChatgptWorkbenchUpdated?.(payload => renderChatgptWorkbenchState(payload || {}));
window.yoko.onAutomationGptStatus?.(payload => {
  const kind = String(payload?.kind || 'info');
  const message = String(payload?.message || '').trim();
  if (!message) return;
  if (shellSurface === 'external') setExternalStatus(message); else setStatus(message);
});

function proxyLabel(account) {
  const p = account.proxy || {};
  if (!p.enabled || !p.host || !p.port) return '直连';
  return `${p.protocol}://${p.host}:${p.port}`;
}


let currentCrmContext = null;

function crmDatetimeLocalValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw.slice(0, 16);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fillCrmModal(data) {
  currentCrmContext = data;
  const record = data?.contact || {};
  $('#crmAccountId').value = data?.accountId || '';
  $('#crmChatId').value = data?.chatId || '';
  $('#crmDisplayName').value = data?.displayName || '';
  $('#crmAccountName').textContent = data?.accountName || '-';
  $('#crmChatName').textContent = data?.displayName || '-';
  $('#crmName').value = record.name || data?.displayName || '';
  fillLineFlowStageSelect($('#crmStage'), record.stage || lineFlowDefaultStage());
  $('#crmLanguage').value = record.language || 'ja';
  $('#crmRegion').value = record.region || '';
  $('#crmAge').value = record.age || '';
  $('#crmOccupation').value = record.occupation || '';
  $('#crmInterests').value = record.interests || '';
  $('#crmTags').value = record.tags || '';
  $('#crmNote').value = record.note || '';
}

async function openAggregateCustomerCrm(item = currentAggregateConversation()) {
  if (!item) throw new Error('请先选择左侧客户。');
  await loadAggregateCrmPanel(item);
  $('#crmSideStage')?.focus();
  setStatus(`客户资料已显示在右侧：${item.crmProfile?.name || item.displayName || '未命名客户'}`);
}

function setAggregateCrmPanelSaveState(text, kind = '') {
  const node = $('#crmSideSaveState');
  if (!node) return;
  node.textContent = text || '';
  node.dataset.kind = kind || '';
}

function aggregateCrmPanelSetDisabled(disabled) {
  document.querySelectorAll('#aggregateCrmPanel input:not([type="hidden"]), #aggregateCrmPanel select, #aggregateCrmPanel textarea, #aggregateCrmPanel button:not(#crmSideCollapseBtn)').forEach(node => {
    node.disabled = !!disabled;
  });
}

function clearAggregateCrmPanel() {
  aggregateCrmPanelContext = null;
  aggregateCrmPanelDirty = false;
  if (aggregateCrmPanelSaveTimer) {
    clearTimeout(aggregateCrmPanelSaveTimer);
    aggregateCrmPanelSaveTimer = null;
  }
  for (const id of ['crmSideAccountId', 'crmSideChatId', 'crmSideDisplayName', 'crmSideName', 'crmSideRegion', 'crmSideAge', 'crmSideInterests', 'crmSideOccupation', 'crmSideTags', 'crmSideNote']) {
    const node = $('#' + id);
    if (node) node.value = '';
  }
  if ($('#crmSideServiceStatus')) $('#crmSideServiceStatus').value = 'auto';
  fillLineFlowStageSelect($('#crmSideStage'), lineFlowDefaultStage());
  if ($('#crmSideQuickSummaryText')) $('#crmSideQuickSummaryText').textContent = '选择客户后立即显示本地资料';
  $('#crmSideCrossPlatformSource')?.classList.add('hidden');
  if ($('#crmSideCrossPlatformText')) $('#crmSideCrossPlatformText').textContent = '';
  renderCrmMemory({}, 'line');
  $('#crmSideMemoryPanel')?.classList.add('hidden');
  renderLineBusinessEngineHint(lineFlowDefaultStage());
  for (const id of ['crmTimelineFirst', 'crmTimelineIncoming', 'crmTimelineReply', 'crmTimelineOpened']) {
    const node = $('#' + id);
    if (node) node.textContent = '—';
  }
  $('#crmSideTitle').textContent = '客户资料';
  $('#crmSideMeta').textContent = workspaceMode === 'aggregate' ? '请选择左侧客户' : '请选择一个 LINE 对话';
  const avatar = $('#crmSideAvatar');
  if (avatar) avatar.innerHTML = '<span>?</span>';
  setAggregateCrmPanelSaveState('等待选择');
  aggregateCrmPanelSetDisabled(true);
}

function fillAggregateCrmPanel(data, item) {
  aggregateCrmPanelHydrating = true;
  try {
    const panelKey = String(item?.chatId || '').trim()
      ? aggregateConversationKey(item)
      : `${String(item?.accountId || data?.accountId || '')}::name:${String(item?.displayName || data?.displayName || '')}`;
    aggregateCrmPanelContext = { data, item, key: panelKey };
    const record = data?.contact || {};
    $('#crmSideAccountId').value = data?.accountId || item?.accountId || '';
    $('#crmSideChatId').value = data?.chatId || item?.chatId || '';
    $('#crmSideDisplayName').value = data?.displayName || item?.displayName || '';
    $('#crmSideServiceStatus').value = ['waiting', 'active', 'done', 'paused', 'blacklist'].includes(String(record.serviceStatus || '')) ? String(record.serviceStatus) : 'auto';
    fillLineFlowStageSelect($('#crmSideStage'), record.stage || lineFlowDefaultStage());
    renderLineBusinessEngineHint($('#crmSideStage')?.value || record.stage || lineFlowDefaultStage());
    $('#crmSideName').value = record.name || data?.displayName || item?.displayName || '';
    $('#crmSideRegion').value = record.region || '';
    $('#crmSideAge').value = record.age || '';
    $('#crmSideInterests').value = record.interests || '';
    $('#crmSideOccupation').value = record.occupation || '';
    $('#crmSideTags').value = record.tags || '';
    $('#crmSideNote').value = record.note || '';
    renderCrmMemory(record, 'line');
    const cross = record.crossPlatform && typeof record.crossPlatform === 'object' ? record.crossPlatform : null;
    const crossNode = $('#crmSideCrossPlatformSource');
    if (crossNode) {
      const bits = cross ? [String(cross.sourcePlatform || '').toUpperCase(), cross.sourceAccountName || '', cross.sourceHandle ? `@${cross.sourceHandle}` : (cross.sourceDisplayName || '')].filter(Boolean) : [];
      crossNode.classList.toggle('hidden', !bits.length);
      if ($('#crmSideCrossPlatformText')) $('#crmSideCrossPlatformText').textContent = bits.join(' · ');
    }

    const title = record.name || data?.displayName || item?.displayName || '未命名客户';
    const quickBits = [
      record.age ? `${record.age}岁` : '',
      record.region || '',
      record.occupation || '',
      record.interests || '',
      `阶段：${record.stage || lineFlowDefaultStage()}`
    ].filter(Boolean);
    if ($('#crmSideQuickSummaryText')) $('#crmSideQuickSummaryText').textContent = String(record.summary || '').trim() || quickBits.join(' · ') || '暂无详细资料，可在下方补充';
    const openedAt = aggregateOpenedAt[panelKey] || 0;
    if ($('#crmTimelineFirst')) $('#crmTimelineFirst').textContent = formatAggregateTimelineTime(item?.firstMessageAt || item?.firstSeenAt);
    if ($('#crmTimelineIncoming')) $('#crmTimelineIncoming').textContent = formatAggregateTimelineTime(item?.lastIncomingAt);
    if ($('#crmTimelineReply')) $('#crmTimelineReply').textContent = formatAggregateTimelineTime(item?.lastOutgoingAt);
    if ($('#crmTimelineOpened')) $('#crmTimelineOpened').textContent = formatAggregateTimelineTime(openedAt);
    $('#crmSideTitle').textContent = title;
    $('#crmSideMeta').textContent = `${data?.accountName || item?.accountRemark || item?.accountName || 'LINE'} · ${item?.hasConversation === false ? '未开始聊天' : '当前对话'}`;
    const avatarUrl = String(item?.avatarLocalUrl || item?.avatarDataUrl || item?.avatarUrl || '').trim();
    const avatarChar = String(title).slice(0, 1).toUpperCase() || '?';
    const avatar = $('#crmSideAvatar');
    if (avatar) {
      avatar.innerHTML = `<span>${escapeHtml(avatarChar)}</span>${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="" decoding="async" loading="lazy" />` : ''}`;
      const img = avatar.querySelector('img');
      if (img) img.addEventListener('error', () => img.remove(), { once: true });
    }
    aggregateCrmPanelDirty = false;
    aggregateCrmPanelSetDisabled(false);
    setAggregateCrmPanelSaveState('已同步', 'ok');
  } finally {
    aggregateCrmPanelHydrating = false;
  }
}

async function loadAggregateCrmPanel(item = currentAggregateConversation(), { quiet = false } = {}) {
  if (workspaceMode !== 'aggregate') return;
  if (!item) {
    clearAggregateCrmPanel();
    return;
  }
  const key = aggregateConversationKey(item);
  // V1.15.21: paint cached CRM data immediately, then reconcile from main in
  // the background. Customer switching no longer waits for a config round-trip.
  if (item?.crmProfile) {
    fillAggregateCrmPanel({
      ok: true, accountId: item.accountId, chatId: item.chatId, displayName: item.displayName,
      accountName: item.accountRemark || item.accountName || 'LINE', contact: item.crmProfile
    }, item);
  }
  if (!quiet) setAggregateCrmPanelSaveState(item?.crmProfile ? '同步中…' : '读取中…');
  const data = await window.yoko.getConversationContact({
    accountId: item.accountId,
    chatId: item.chatId,
    displayName: item.displayName
  });
  if (!data?.ok) throw new Error(data?.error || '读取客户资料失败');
  if (workspaceMode !== 'aggregate') return;
  if (aggregateSelectedConversationKey && aggregateSelectedConversationKey !== key) return;
  fillAggregateCrmPanel(data, item);
}

function lineCrmItemFromData(data) {
  const cached = (aggregateInbox?.conversations || []).find(item =>
    String(item?.accountId || '') === String(data?.accountId || '') &&
    (
      (data?.chatId && String(item?.chatId || '') === String(data.chatId)) ||
      (!data?.chatId && String(item?.displayName || '') === String(data?.displayName || ''))
    )
  );
  return {
    ...(cached || {}),
    accountId: data?.accountId || cached?.accountId || '',
    chatId: data?.chatId || cached?.chatId || '',
    displayName: data?.displayName || cached?.displayName || '未命名客户',
    accountName: data?.accountName || cached?.accountName || 'LINE',
    accountRemark: data?.accountName || cached?.accountRemark || '',
    accountIsOpen: true,
    avatarDataUrl: data?.avatarDataUrl || cached?.avatarDataUrl || '',
    avatarUrl: data?.avatarUrl || cached?.avatarUrl || '',
    hasConversation: true
  };
}

async function syncLineModeCrmPanel({ force = false } = {}) {
  if (workspaceMode !== 'line' || lineCrmSyncInFlight) return;
  if (!currentActiveIsOpen()) {
    lineCrmLastConversationKey = '';
    clearAggregateCrmPanel();
    return;
  }

  lineCrmSyncInFlight = true;
  try {
    const data = await window.yoko.getCurrentChatCrm();
    if (workspaceMode !== 'line') return;
    if (!data?.ok || (!data?.chatId && !data?.displayName)) {
      lineCrmMissCount += 1;
      if (force || lineCrmMissCount >= 2) {
        if (aggregateCrmPanelDirty) await saveAggregateCrmPanel({ quiet: true }).catch(() => {});
        lineCrmLastConversationKey = '';
        clearAggregateCrmPanel();
      }
      return;
    }

    lineCrmMissCount = 0;
    const item = lineCrmItemFromData(data);
    const key = String(item.chatId || '').trim()
      ? aggregateConversationKey(item)
      : `${String(data.accountId || '')}::name:${String(data.displayName || '')}`;
    if (!force && key === lineCrmLastConversationKey) return;

    if (aggregateCrmPanelDirty && aggregateCrmPanelContext?.key && aggregateCrmPanelContext.key !== key) {
      await saveAggregateCrmPanel({ quiet: true }).catch(() => {});
    }
    if (workspaceMode !== 'line') return;
    lineCrmLastConversationKey = key;
    fillAggregateCrmPanel(data, item);
  } catch (error) {
    if (force) setStatus('同步当前客户资料失败：' + (error?.message || error));
  } finally {
    lineCrmSyncInFlight = false;
  }
}

function stopLineCrmSync() {
  if (lineCrmSyncTimer) {
    clearInterval(lineCrmSyncTimer);
    lineCrmSyncTimer = null;
  }
}

function startLineCrmSync({ force = false } = {}) {
  stopLineCrmSync();
  if (workspaceMode !== 'line') return;
  syncLineModeCrmPanel({ force }).catch(() => {});
  lineCrmSyncTimer = setInterval(() => {
    if (document.hidden) return;
    if (workspaceMode === 'line') syncLineModeCrmPanel().catch(() => {});
  }, 1600);
}

function collectAggregateCrmPanelPayload() {
  const accountId = String($('#crmSideAccountId')?.value || '').trim();
  const displayName = String($('#crmSideDisplayName')?.value || '').trim();
  if (!accountId || !displayName) return null;
  return {
    accountId,
    chatId: String($('#crmSideChatId')?.value || '').trim(),
    displayName,
    name: String($('#crmSideName')?.value || '').trim(),
    serviceStatus: String($('#crmSideServiceStatus')?.value || 'auto'),
    stage: String($('#crmSideStage')?.value || '新客户'),
    language: aggregateCrmPanelContext?.data?.contact?.language || 'ja',
    region: String($('#crmSideRegion')?.value || '').trim(),
    age: String($('#crmSideAge')?.value || '').trim(),
    occupation: String($('#crmSideOccupation')?.value || '').trim(),
    interests: String($('#crmSideInterests')?.value || '').trim(),
    tags: String($('#crmSideTags')?.value || '').trim(),
    note: String($('#crmSideNote')?.value || '').trim()
  };
}

async function saveAggregateCrmPanel({ quiet = false } = {}) {
  const payload = collectAggregateCrmPanelPayload();
  if (!payload) return;
  if (aggregateCrmPanelSaveTimer) {
    clearTimeout(aggregateCrmPanelSaveTimer);
    aggregateCrmPanelSaveTimer = null;
  }
  setAggregateCrmPanelSaveState('保存中…');
  try {
    const record = await window.yoko.saveCurrentContact(payload);
    aggregateCrmPanelDirty = false;
    if (aggregateCrmPanelContext?.data) aggregateCrmPanelContext.data.contact = record || payload;
    const key = aggregateCrmPanelContext?.key || aggregateSelectedConversationKey;
    const target = (aggregateInbox?.conversations || []).find(item => aggregateConversationKey(item) === key);
    if (target) target.crmProfile = { ...(target.crmProfile || {}), ...(record || payload) };
    if (aggregateSelectedConversation && aggregateConversationKey(aggregateSelectedConversation) === key) {
      aggregateSelectedConversation.crmProfile = { ...(aggregateSelectedConversation.crmProfile || {}), ...(record || payload) };
    }
    $('#crmSideTitle').textContent = payload.name || payload.displayName;
    setAggregateCrmPanelSaveState('已保存', 'ok');
    renderAggregateCustomerSidebar();
    if (!quiet) setStatus(`客户资料已保存：${payload.name || payload.displayName}`);
  } catch (error) {
    setAggregateCrmPanelSaveState('保存失败', 'error');
    if (!quiet) setStatus('客户资料保存失败：' + (error?.message || error));
  }
}

function scheduleAggregateCrmPanelSave() {
  if (aggregateCrmPanelHydrating) return;
  if (!collectAggregateCrmPanelPayload()) return;
  aggregateCrmPanelDirty = true;
  setAggregateCrmPanelSaveState('待保存…');
  if (aggregateCrmPanelSaveTimer) clearTimeout(aggregateCrmPanelSaveTimer);
  aggregateCrmPanelSaveTimer = setTimeout(() => {
    aggregateCrmPanelSaveTimer = null;
    saveAggregateCrmPanel({ quiet: true });
  }, 700);
}

function aggregateCrmTags(profile) {
  return String(profile?.tags || '')
    .split(/[,，、;；]/)
    .map(x => x.trim())
    .filter(Boolean)
    .slice(0, 2);
}

let latestAiReplyText = '';
let latestAiReplyProvider = '';
let latestChatScriptRequestId = '';
let latestChatScriptTranslation = '';


function currentActiveIsOpen() {
  const active = state?.config?.accounts?.find(
    a => a.id === state?.config?.activeAccountId
  );
  return !!active && active.isOpen !== false;
}

async function refreshState() {
  state = await window.yoko.getState();
  $('#version').textContent = 'V' + state.version;
  renderAutomationMasterState(state?.config?.automation?.masterEnabled !== false);
  renderAccounts();
  $('#emptyHint').style.display =
    currentActiveIsOpen() ? 'none' : 'grid';
  if (workspaceMode === 'line') startLineCrmSync();
}



async function saveInlineAccountRemark(account, node, input, originalRemark) {
  const value = String(input.value || '').trim();
  const nextRemark = value;

  try {
    const updated = await window.yoko.updateAccountRemark(account.id, nextRemark);
    account.remark = updated?.remark ?? nextRemark;
    setStatus(`备注已保存：${account.remark || account.name}`);
  } catch (error) {
    account.remark = originalRemark;
    setStatus('备注保存失败：' + (error?.message || error));
  }

  renderAccounts();
}

function beginInlineAccountRemarkEdit(account, node) {
  const row = node.querySelector('.account-alias-row');
  const label = node.querySelector('.account-alias-label');
  const pencil = node.querySelector('.account-pencil');
  if (!row || !label || row.querySelector('.account-alias-input')) return;

  const originalRemark = String(account.remark || '');
  const input = document.createElement('input');
  input.className = 'account-alias-input';
  input.type = 'text';
  input.maxLength = 80;
  input.value = originalRemark || account.name || '';
  input.setAttribute('aria-label', '账号备注');

  label.style.display = 'none';
  if (pencil) pencil.style.display = 'none';
  row.appendChild(input);

  let finished = false;
  const finish = async save => {
    if (finished) return;
    finished = true;
    if (save) {
      await saveInlineAccountRemark(account, node, input, originalRemark);
    } else {
      renderAccounts();
    }
  };

  input.addEventListener('click', event => event.stopPropagation());
  input.addEventListener('pointerdown', event => event.stopPropagation());
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

async function saveInlineAccountDisplayName(account, input, originalValue) {
  const value = String(input.value || '').trim();
  try {
    const updated = await window.yoko.updateAccountDisplayName(account.id, value);
    account.displayNameOverride = String(updated?.displayNameOverride || value);
    setStatus(`名称已保存：${account.displayNameOverride || account.lineProfile?.displayName || account.name}`);
  } catch (error) {
    account.displayNameOverride = originalValue;
    setStatus('名称保存失败：' + (error?.message || error));
  }
  renderAccounts();
}

function beginInlineAccountDisplayNameEdit(account, node) {
  const label = node.querySelector('.account-primary-name');
  if (!label || node.querySelector('.account-name-input')) return;

  const originalValue = String(account.displayNameOverride || '');
  const fallbackValue = String(
    account.displayNameOverride ||
    account.live?.displayName ||
    account.lineProfile?.displayName ||
    account.name ||
    'LINE'
  ).trim();
  const input = document.createElement('input');
  input.className = 'account-name-input';
  input.type = 'text';
  input.maxLength = 80;
  input.value = fallbackValue;
  input.setAttribute('aria-label', '账号显示名称');

  label.style.display = 'none';
  label.parentElement?.appendChild(input);

  let finished = false;
  const finish = async save => {
    if (finished) return;
    finished = true;
    if (save) await saveInlineAccountDisplayName(account, input, originalValue);
    else renderAccounts();
  };

  input.addEventListener('click', event => event.stopPropagation());
  input.addEventListener('pointerdown', event => event.stopPropagation());
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

async function persistAccountOrderFromDom(box) {
  const ids = [...box.querySelectorAll('.account')]
    .map(node => String(node.dataset.accountId || ''))
    .filter(Boolean);

  if (ids.length !== (state?.config?.accounts?.length || 0)) return;

  try {
    await window.yoko.reorderAccounts(ids);
    const byId = new Map(state.config.accounts.map(account => [account.id, account]));
    state.config.accounts = ids.map(id => byId.get(id)).filter(Boolean);
    setStatus('LINE 账号顺序已保存');
  } catch (error) {
    setStatus('账号排序保存失败：' + (error?.message || error));
    await refreshState();
  }
}

function closeAccountActionMenus() {
  document.querySelectorAll('.account-action-menu.open').forEach(menu => {
    menu.classList.remove('open', 'open-up');
    const toggle = menu.closest('.account-menu-wrap')?.querySelector('.account-menu-toggle');
    toggle?.setAttribute('aria-expanded', 'false');
  });
}

function accountHealthMeta(account) {
  const isOpen = account?.isOpen !== false;
  if (!isOpen) return { key: 'closed', label: '已关闭', title: 'LINE 窗口已关闭' };
  const live = account?.live || {};
  const recent = accountHealthState.get(String(account?.id || '')) || {};
  if (recent.kind === 'error' && Date.now() - Number(recent.at || 0) < 120000) {
    return { key: 'error', label: '异常', title: recent.message || 'LINE 加载/渲染异常' };
  }
  if (live.online === true) return { key: 'online', label: '在线', title: 'LINE 在线，消息连接正常' };
  if (live.loginRequired === true || String(live.loginState || '') === 'login-required') return { key:'login', label:'需要登录', title:'LINE 当前停留在登录/二维码页面，请重新登录' };
  return { key: 'loading', label: '连接中', title: 'LINE 已打开，正在等待在线状态' };
}

function renderAccounts() {
  const box = $('#accounts');
  box.innerHTML = '';
  $('#accountCount').textContent =
    state.config.accounts.length;

  for (const account of state.config.accounts) {
    const isOpen = account.isOpen !== false;
    const node = document.createElement('div');

    node.className =
      'account' +
      (account.id === state.config.activeAccountId
        ? ' active'
        : '') +
      (isOpen ? '' : ' closed');

    node.dataset.accountId = account.id;
    node.draggable = true;

    const live = account.live || {};
    const profile = account.lineProfile || {};
    // V1.11.4: only render a locally captured data URL. Remote LINE CDN URLs
    // are metadata/fetch sources for the authenticated LINE view, not UI image
    // sources; this prevents broken avatars when cookies/proxy/CDN are unavailable.
    const avatar = String(live.avatarDataUrl || profile.avatarDataUrl || '');
    const lineDisplayName = String(live.displayName || profile.displayName || '').trim();
    const lineUserId = String(live.userId || profile.userId || '').trim();
    const online = live.online === true && isOpen;
    const health = accountHealthMeta(account);
    node.classList.toggle('health-error', health.key === 'error');
    const unread = Math.max(0, Number(live.unreadCount || 0) || 0);
    const unreadLabel = unread > 99 ? '99+' : String(unread);
    const primaryName = lineDisplayName || account.name || 'LINE';
    const aliasName = String(account.remark || account.name || '').trim();
    const fallbackChar = primaryName.trim().slice(0, 1).toUpperCase();
    const userIdLabel = lineUserId || '未获取';

    node.innerHTML = `
      <div class="account-avatar-wrap" title="${escapeHtml(primaryName)} · ${escapeHtml(userIdLabel)} · ${escapeHtml(aliasName || '未命名')}">
        <div class="account-avatar">
          <span class="account-avatar-fallback">${escapeHtml(fallbackChar)}</span>
          ${avatar ? `<img class="account-avatar-img" src="${escapeHtml(avatar)}" alt="${escapeHtml(primaryName)}" />` : ''}
        </div>
        ${online ? '<span class="account-online-dot" title="LINE 在线"></span>' : '<span class="account-offline-dot" title="LINE 未在线"></span>'}
        ${unread > 0 ? `<span class="account-unread" title="${unread} 条未读消息">${escapeHtml(unreadLabel)}</span>` : ''}
      </div>

      <div class="account-info">
        <div class="account-name-row">
          <span class="account-primary-name" title="LINE 昵称（固定显示，不可修改）">${escapeHtml(primaryName)}</span>
        </div>
        <div class="account-user-id" title="LINE 用户ID"><span class="account-id-prefix">ID：</span><span class="account-id-value">${escapeHtml(userIdLabel)}</span></div>
        <div class="account-alias-row" title="点击修改本地备注" role="button" tabindex="0">
          <span class="account-pencil" aria-hidden="true">✏</span>
          <span class="account-alias-label">备注：${escapeHtml(aliasName || '未设置')}</span>
        </div>
      </div>

      <div class="account-actions">
        <button class="mini window-btn ${isOpen ? 'stop' : 'start'}" title="${isOpen ? '关闭这个 LINE 窗口' : '开启这个 LINE 窗口'}" aria-label="${isOpen ? '关闭 LINE' : '开启 LINE'}">${isOpen ? '⏹' : '▶'}</button>
        <span class="account-window-status health-${escapeHtml(health.key)}" title="${escapeHtml(health.title)}">${escapeHtml(health.label)}</span>
        <button class="mini delete-btn" title="删除这个 LINE 账号" aria-label="删除账号">×</button>
      </div>
    `;

    const avatarImg = node.querySelector('.account-avatar-img');
    if (avatarImg) {
      let avatarFailed = false;
      const markLoaded = () => {
        if (!avatarFailed) avatarImg.classList.add('is-loaded');
      };
      const recoverAvatar = () => {
        if (avatarFailed) return;
        avatarFailed = true;
        avatarImg.remove();
        // A cached data URL should be deterministic. If decoding fails, invalidate
        // only the avatar cache and let main process reacquire it from authenticated
        // LINE without affecting the LINE login/session itself.
        window.yoko.refreshAccountAvatar?.(account.id, { invalidate: true }).catch(() => {});
      };
      avatarImg.addEventListener('load', markLoaded, { once: true });
      avatarImg.addEventListener('error', recoverAvatar, { once: true });
      // data: URLs can finish before listeners are attached after innerHTML.
      if (avatarImg.complete) {
        if (avatarImg.naturalWidth > 0) markLoaded();
        else recoverAvatar();
      }
    }

    node.addEventListener('dragstart', event => {
      if (event.target.closest('button,input,.account-pencil,.account-alias-row,.account-primary-name')) {
        event.preventDefault();
        return;
      }
      draggedAccountId = account.id;
      accountDragMoved = false;
      node.classList.add('dragging');
      try {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', account.id);
      } catch {}
    });

    node.addEventListener('dragover', event => {
      if (!draggedAccountId || draggedAccountId === account.id) return;
      const draggedNode = [...box.querySelectorAll('.account')]
        .find(item => item.dataset.accountId === draggedAccountId);
      if (!draggedNode) return;

      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const before = event.clientY < rect.top + rect.height / 2;
      if (before) {
        if (draggedNode.nextElementSibling !== node) box.insertBefore(draggedNode, node);
      } else {
        if (node.nextElementSibling !== draggedNode) box.insertBefore(draggedNode, node.nextElementSibling);
      }
      accountDragMoved = true;
    });

    node.addEventListener('dragend', async () => {
      node.classList.remove('dragging');
      suppressAccountClickUntil = Date.now() + 250;
      const moved = accountDragMoved;
      draggedAccountId = '';
      accountDragMoved = false;
      if (moved) await persistAccountOrderFromDom(box);
    });

    node.addEventListener('click', async event => {
      if (Date.now() < suppressAccountClickUntil) return;
      if (
        event.target.closest(
          '.window-btn,.delete-btn,.account-pencil,.account-alias-row,.account-alias-input'
        )
      ) return;

      // V1.11.9: closed accounts are still selectable, but selecting them must
      // never start LINE. Starting/reopening remains restricted to the dedicated
      // ▶ button. This keeps the card useful for selection, editing and diagnostics
      // while preserving V1.11.6's anti-misclick behavior.
      try {
        setStatus(isOpen ? `正在切换到 ${account.name}…` : `正在选择 ${account.name}…`);
        await window.yoko.selectAccount(account.id);
        lineCrmLastConversationKey = '';
        lineCrmMissCount = 0;
        await refreshState();
        if (workspaceMode === 'line' && isOpen) await syncLineModeCrmPanel({ force: true }).catch(() => {});
        setStatus(
          isOpen
            ? `${account.name} 已选中`
            : `${account.name} 已选中（窗口已关闭；点右侧 ▶ 才会启动）`
        );
      } catch (error) {
        setStatus('切换失败：' + error.message);
      }
    });


    node
      .querySelector('.window-btn')
      .addEventListener('click', async event => {
        event.stopPropagation();

        try {
          if (isOpen) {
            setStatus(`正在关闭 ${account.name}…`);
            await window.yoko.closeAccountWindow(account.id);
            await refreshState();
            setStatus(`${account.name} 已关闭；再次点击 ▶ 可重新开启`);
          } else {
            setStatus(`正在开启 ${account.name}…`);
            await window.yoko.openAccountWindow(account.id);
            await refreshState();
            setStatus(`${account.name} 已开启`);
          }
        } catch (error) {
          setStatus(`${isOpen ? '关闭' : '开启'}窗口失败：` + error.message);
        }
      });

    const aliasRow = node.querySelector('.account-alias-row');
    if (aliasRow) {
      const startRemarkEdit = event => {
        event.preventDefault();
        event.stopPropagation();
        beginInlineAccountRemarkEdit(account, node);
      };
      aliasRow.addEventListener('click', startRemarkEdit);
      aliasRow.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') startRemarkEdit(event);
      });
    }

    node
      .querySelector('.delete-btn')
      .addEventListener('click', async event => {
        event.stopPropagation();

        const confirmed = window.confirm(
          `确定删除 LINE「${account.name}」吗？\n\n` +
          '这会关闭该 LINE，并删除本地登录会话、代理配置和该账号绑定的客户资料。\n' +
          '此操作不可撤销。'
        );
        if (!confirmed) return;

        try {
          setStatus(`正在删除 ${account.name}…`);
          await window.yoko.deleteAccount(account.id);
          await refreshState();
          setStatus(`${account.name} 已删除`);
        } catch (error) {
          setStatus('删除 LINE 失败：' + error.message);
        }
      });

    box.appendChild(node);
  }
  renderLineCustomerStats();
}

function clearAccountForm() {
  $('#editAccountId').value = '';
  $('#accountName').value =
    `LINE-${String(
      (state?.config?.accounts?.length || 0) + 1
    ).padStart(2, '0')}`;
  $('#accountRemark').value = '';
  $('#proxyEnabled').checked = false;
  $('#proxyProtocol').value = 'socks5';
  $('#proxyHost').value = '';
  $('#proxyPort').value = '';
  $('#proxyAuth').checked = false;
  $('#proxyUsername').value = '';
  $('#proxyPassword').value = '';
  const resultBox = $('#accountFormProxyTestResult');
  if (resultBox) {
    resultBox.className = 'proxy-test-result';
    resultBox.textContent = '填写代理后可先测试；测试不会保存账号。';
  }
}

function readAccountFormProxy({ forceEnabled = false } = {}) {
  return {
    enabled: forceEnabled ? true : $('#proxyEnabled').checked,
    protocol: $('#proxyProtocol').value,
    host: $('#proxyHost').value.trim(),
    port: Number($('#proxyPort').value || 0),
    auth: $('#proxyAuth').checked,
    username: $('#proxyUsername').value.trim(),
    password: $('#proxyPassword').value
  };
}

function editAccount(account) {
  $('#accountModalTitle').textContent =
    '编辑 LINE 账号';
  $('#editAccountId').value = account.id;
  $('#accountName').value = account.name || '';
  $('#accountRemark').value = account.remark || '';

  const p = account.proxy || {};
  $('#proxyEnabled').checked = !!p.enabled;
  $('#proxyProtocol').value =
    p.protocol || 'socks5';
  $('#proxyHost').value = p.host || '';
  $('#proxyPort').value = p.port || '';
  $('#proxyAuth').checked = !!p.auth;
  $('#proxyUsername').value = p.username || '';
  $('#proxyPassword').value = p.password || '';
  const resultBox = $('#accountFormProxyTestResult');
  if (resultBox) {
    resultBox.className = 'proxy-test-result';
    resultBox.textContent = '可以先测试当前代理；测试不会保存修改。';
  }

  openModal('accountModal');
}

$('#addAccountBtn').addEventListener('click', () => {
  clearAccountForm();
  $('#accountModalTitle').textContent =
    '新增个人 LINE';
  openModal('accountModal');
});

$('#testAccountFormProxyBtn')?.addEventListener('click', async () => {
  const btn = $('#testAccountFormProxyBtn');
  const resultBox = $('#accountFormProxyTestResult');
  const proxy = readAccountFormProxy({ forceEnabled: true });

  if (!proxy.host || !Number(proxy.port)) {
    if (resultBox) {
      resultBox.className = 'proxy-test-result error';
      resultBox.textContent = '请先填写代理 IP / Host 和端口。';
    }
    return;
  }

  if (proxy.auth && !proxy.username) {
    if (resultBox) {
      resultBox.className = 'proxy-test-result error';
      resultBox.textContent = '已勾选代理认证，请填写用户名。';
    }
    return;
  }

  const oldText = btn?.textContent || '测试代理';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '测试中…';
  }
  if (resultBox) {
    resultBox.className = 'proxy-test-result testing';
    resultBox.textContent = '正在使用当前填写的代理测试延迟和出口 IP…';
  }

  try {
    const result = await window.yoko.testProxyConfig(proxy);
    if (result?.ok) {
      const modeText = result.bridge ? 'SOCKS5认证桥' : String(proxy.protocol || 'proxy').toUpperCase();
      if (resultBox) {
        resultBox.className = 'proxy-test-result ok';
        resultBox.textContent = `代理可用 · 延迟 ${result.latencyMs} ms · 出口 IP ${result.ip || '-'} · ${modeText}`;
      }
    } else {
      if (resultBox) {
        resultBox.className = 'proxy-test-result error';
        resultBox.textContent = `代理测试失败：${result?.error || '未知错误'}`;
      }
    }
  } catch (error) {
    if (resultBox) {
      resultBox.className = 'proxy-test-result error';
      resultBox.textContent = `代理测试失败：${error?.message || error}`;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }
});

$('#saveAccountBtn').addEventListener(
  'click',
  async () => {
    const id = $('#editAccountId').value.trim();

    const payload = {
      id: id || undefined,
      name:
        $('#accountName').value.trim() || 'LINE',
      remark: $('#accountRemark').value.trim(),
      proxy: readAccountFormProxy()
    };

    try {
      if (id) {
        await window.yoko.updateAccount(payload);
      } else {
        await window.yoko.addAccount(payload);
      }

      await closeModal('accountModal');
      await refreshState();
      setStatus('账号配置已保存');
    } catch (error) {
      const message = String(error?.message || error || '未知错误');
      if (/LINE 扩展|Loading extension|loadExtension|manifest/i.test(message)) {
        setStatus('保存失败：LINE 扩展不可用。请打开“设置”→“自动检测并导入”或“导入 LINE 扩展”。详细信息：' + message);
      } else {
        setStatus('保存失败：' + message);
      }
    }
  }
);

$('#reloadBtn').addEventListener(
  'click',
  async () => {
    try {
      const ok = await window.yoko.reloadAccount();
      setStatus(
        ok
          ? '当前 LINE 已刷新'
          : '当前没有打开的 LINE'
      );
    } catch (error) {
      setStatus(error.message);
    }
  }
);

$('#networkBtn')?.addEventListener(
  'click',
  async () => {
    const account =
      state?.config?.accounts?.find(
        a => a.id === state?.config?.activeAccountId
      );

    if (!account) {
      setStatus('请先选择 LINE 账号');
      return;
    }

    setStatus(
      `正在测试 ${account.name} 的出口线路…`
    );

    try {
      const result =
        await window.yoko.testActiveNetwork();

      if (result.ok) {
        setStatus(
          `${account.name} 出口 IP：${result.ip}` +
          ` · ${result.latencyMs}ms · ` +
          (
            result.bridge
              ? 'SOCKS5认证桥'
              : (
                result.mode === 'proxy'
                  ? '独立代理'
                  : '直连'
              )
          )
        );
      } else {
        setStatus(
          `${account.name} 线路测试失败：${result.error}`
        );
      }

      await refreshState();
    } catch (error) {
      setStatus('线路测试失败：' + error.message);
    }
  }
);

$('#diagBtn')?.addEventListener(
  'click',
  async () => {
    if ($('#diagModalTitle')) $('#diagModalTitle').textContent = '账号诊断';
    const id = state?.config?.activeAccountId;
    if (!id) {
      setStatus('请先选择 LINE 账号');
      return;
    }

    try {
      const d =
        await window.yoko.accountDiagnostics(id);

      $('#diagText').textContent = [
        `账号：${d.name}`,
        `窗口：${d.windowOpen ? '已打开' : '已关闭'}`,
        `账号ID：${d.accountId}`,
        `Partition：${d.partition}`,
        `Storage：${d.storagePath}`,
        `扩展：${d.extensionName} ${d.extensionVersion}`,
        `扩展ID：${d.extensionId}`,
        `Cookie数量：${d.cookieCount}`,
        `Session Cookie：${d.sessionCookieCount}`,
        `Cookie Vault：${d.cookieVaultExists ? '存在' : '不存在'}`,
        `代理：${d.proxy}`,
        `SOCKS5认证桥：${d.proxyAuthBridge ? '已启用' : '未启用'}`,
        `本地桥端口：${d.localBridgePort || '(无)'}`,
        `上次出口IP：${d.lastPublicIp || '(未测试)'}`,
        `上次延迟：${
          d.lastLatencyMs == null
            ? '(未测试)'
            : d.lastLatencyMs + 'ms'
        }`,
        `当前URL：${d.url}`,
        '',
        '最近控制台/加载错误：',
        ...(
          Array.isArray(d.consoleErrors) &&
          d.consoleErrors.length
            ? d.consoleErrors.map(
                x => `[${x.kind}] ${x.message}`
              )
            : ['(无)']
        )
      ].join('\n');

      await openModal('diagModal');
    } catch (error) {
      setStatus('诊断失败：' + error.message);
    }
  }
);



$('#crmSideStage')?.addEventListener('change', () => {
  const stage=String($('#crmSideStage')?.value||lineFlowDefaultStage());
  if(stage===LINE_FLOW_BLACKLIST_STAGE&&$('#crmSideServiceStatus'))$('#crmSideServiceStatus').value='blacklist';
  renderLineBusinessEngineHint(stage);
});
$('#crmSideServiceStatus')?.addEventListener('change',()=>{
  if(String($('#crmSideServiceStatus')?.value||'')==='blacklist')fillLineFlowStageSelect($('#crmSideStage'),LINE_FLOW_BLACKLIST_STAGE);
});
$('#externalCrmStage')?.addEventListener('change', () => {
  const stage = $('#externalCrmStage')?.value || loadExternalFlowStages()[0] || '新进线';
  renderExternalBusinessEngineHint(stage);
  const preview = externalManualStageLinePreview(stage);
  if (preview) renderExternalCrmIntelligence({ ...(externalAggregateCrmContext?.crm || {}), ...preview });
});
$('#lineFlowSettingsBtn')?.addEventListener('click', () => openLineFlowSettingsModal());
$('#lineFlowStageAddBtn')?.addEventListener('click', () => {
  const value = String($('#lineFlowStageInput')?.value || '').trim().replace(/\s+/g, ' ');
  if (!value) { setStatus('请先填写跟进阶段名称'); $('#lineFlowStageInput')?.focus(); return; }
  const stages = loadLineFlowStages();
  if (stages.some(stage => stage.toLocaleLowerCase() === value.toLocaleLowerCase())) {
    setStatus(`跟进阶段已存在：${value}`);
    $('#lineFlowStageInput')?.focus();
    return;
  }
  stages.push(value);
  saveLineFlowStages(stages);
  if ($('#lineFlowStageInput')) $('#lineFlowStageInput').value = '';
  setStatus(`已添加跟进阶段：${value}`);
  $('#lineFlowStageInput')?.focus();
});
$('#lineFlowStageInput')?.addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); $('#lineFlowStageAddBtn')?.click(); }
});
$('#lineFlowStageList')?.addEventListener('click', async event => {
  const up = event.target.closest('[data-flow-stage-up]');
  const down = event.target.closest('[data-flow-stage-down]');
  const del = event.target.closest('[data-flow-stage-delete]');
  const button = up || down || del;
  if (!button) return;
  const stages = loadLineFlowStages();
  const index = Number(up?.dataset.flowStageUp ?? down?.dataset.flowStageDown ?? del?.dataset.flowStageDelete ?? -1);
  if (!Number.isInteger(index) || index < 0 || index >= stages.length) return;
  if (up && index > 0) {
    [stages[index - 1], stages[index]] = [stages[index], stages[index - 1]];
    saveLineFlowStages(stages);
    setStatus(`已上移阶段：${stages[index - 1]}`);
    return;
  }
  if (down && index < stages.length - 1) {
    [stages[index], stages[index + 1]] = [stages[index + 1], stages[index]];
    saveLineFlowStages(stages);
    setStatus(`已下移阶段：${stages[index + 1]}`);
    return;
  }
  if (del) {
    if (stages.length <= 1) { setStatus('至少需要保留一个跟进阶段'); refocusLineFlowStageInput().catch(() => {}); return; }
    const removed = stages[index];
    const confirmed = await showLineFlowConfirm({
      title: '删除跟进阶段',
      message: `确定删除跟进阶段「${removed}」吗？`,
      detail: '已经保存为该阶段的老客户不会被清除；再次打开时会显示为“历史阶段”。',
      confirmText: '删除'
    });
    if (!confirmed) return;
    stages.splice(index, 1);
    saveLineFlowStages(stages);
    setStatus(`已删除跟进阶段：${removed}`);
    refocusLineFlowStageInput().catch(() => {});
  }
});
$('#lineFlowResetBtn')?.addEventListener('click', async () => {
  const confirmed = await showLineFlowConfirm({
    title: '恢复默认流程',
    message: '确定恢复默认跟进流程吗？',
    detail: '当前自定义流程会被替换。已有客户资料不会删除。',
    confirmText: '恢复默认'
  });
  if (!confirmed) return;
  saveLineFlowStages(DEFAULT_LINE_FLOW_STAGES);
  setStatus('LINE 跟进流程已恢复默认');
  refocusLineFlowStageInput().catch(() => {});
});

$('#lineFlowConfirmOkBtn')?.addEventListener('click', () => finishLineFlowConfirm(true));
$('#lineFlowConfirmCancelBtn')?.addEventListener('click', () => finishLineFlowConfirm(false));
$('#lineFlowConfirmCloseBtn')?.addEventListener('click', () => finishLineFlowConfirm(false));
$('#lineFlowConfirmModal')?.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); finishLineFlowConfirm(false); }
});

$('#contactBtn')?.addEventListener('click', async () => {
  // V1.23.26: customer-data toolbar button is a true open/close toggle.
  if (!crmPanelCollapsed) {
    if (aggregateCrmPanelDirty) await saveAggregateCrmPanel({ quiet:true }).catch(() => {});
    await setCrmPanelCollapsed(true, true);
    setStatus('客户资料已收起');
    return;
  }
  await setCrmPanelCollapsed(false, true);
  if (workspaceMode === 'aggregate') {
    try {
      await openAggregateCustomerCrm();
    } catch (error) {
      setStatus('客户资料打开失败：' + (error?.message || error));
    }
    return;
  }

  if (!currentActiveIsOpen()) {
    setStatus('请先打开并选择一个 LINE 账号');
    return;
  }

  try {
    setStatus('正在同步当前聊天客户资料…');
    await syncLineModeCrmPanel({ force: true });
    if (!aggregateCrmPanelContext) {
      setStatus('没有识别到当前聊天对象，请先进入一个聊天');
      return;
    }
    $('#crmSideStage')?.focus();
    setStatus(`客户资料已同步到右侧：${$('#crmSideTitle')?.textContent || '当前客户'}`);
  } catch (error) {
    setStatus('客户识别失败：' + error.message);
  }
});

$('#saveContactBtn').addEventListener('click', async () => {
  const accountId = $('#crmAccountId').value.trim();
  const displayName = $('#crmDisplayName').value.trim();
  if (!accountId || !displayName) {
    setStatus('当前没有可保存的客户');
    return;
  }

  try {
    await window.yoko.saveCurrentContact({
      accountId,
      chatId: $('#crmChatId').value.trim(),
      displayName,
      name: $('#crmName').value.trim(),
      stage: $('#crmStage').value,
      language: $('#crmLanguage').value,
      region: $('#crmRegion').value.trim(),
      age: $('#crmAge').value.trim(),
      occupation: $('#crmOccupation').value.trim(),
      interests: $('#crmInterests').value.trim(),
      tags: $('#crmTags').value.trim(),
      note: $('#crmNote').value.trim()
    });
    await closeModal('contactModal');
    if (workspaceMode === 'aggregate') await refreshAggregateInbox({ remote: false, quiet: true });
    setStatus(`客户资料已保存：${displayName}`);
  } catch (error) {
    setStatus('保存客户资料失败：' + error.message);
  }
});


$('#aiReplyBtn').addEventListener('click', async () => {
  if (!currentActiveIsOpen()) {
    setStatus('请先打开并选择一个 LINE 账号');
    return;
  }

  try {
    state = await window.yoko.getState();
    const t = state?.config?.translation || {};
    latestAiReplyText = '';
    latestAiReplyProvider = '';
    latestChatScriptRequestId = '';
    latestChatScriptTranslation = '';
    $('#aiReplyResult').value = '';
    $('#aiReplyTranslation').value = '';
    $('#chatScriptRelationshipState').textContent = '';
    $('#chatScriptFeedbackActions').style.display = 'none';
    $('#writeAiReplyBtn').disabled = true;
    $('#aiReplyRequest').value = t.aiReplyRequirements || '自然、真诚、像真人聊天一样回复。先回应对方当前内容，再自然延伸；不要机械连续提问，不要过度客套，不要编造事实。';
    $('#aiReplyProviderLabel').textContent = ({
      ollama: '本地 Ollama', current: '跟随当前 AI', groq: 'Groq', openrouter: 'OpenRouter',
      openai: 'ChatGPT / OpenAI', deepseek: 'DeepSeek', gemini: 'Google Gemini'
    })[t.aiReplyProvider || 'ollama'] || (t.aiReplyProvider || '本地 Ollama');

    try {
      const cs = await window.yoko.getChatScriptAiHealth();
      $('#chatScriptStatusText').textContent = cs?.ok ? `已连接 · ${cs.ai?.model || 'AI'} · ${cs.baseUrl || '本机'}` : `未连接 · ${cs?.error || '请先启动 Chat Script AI'}`;
      $('#generateChatScriptReplyBtn').disabled = !cs?.ok || cs?.ai?.enabled === false;
    } catch (e) {
      $('#chatScriptStatusText').textContent = `未连接 · ${e?.message || e}`;
      $('#generateChatScriptReplyBtn').disabled = true;
    }

    let chatName = '-';
    try {
      const info = await window.yoko.getLineCurrentChatInfo();
      chatName = info?.name || info?.displayName || info?.title || '-';
    } catch {}
    $('#aiReplyChatName').textContent = chatName;

    let detailed = [];
    try {
      detailed = await window.yoko.getLineRecentMessagesDetailed(Number(t.aiReplyContextMessages || 8));
    } catch {}
    const latestCustomer = [...(Array.isArray(detailed) ? detailed : [])]
      .reverse()
      .find(item => item?.role === 'customer' && item?.text)?.text || '';
    $('#aiReplyCustomerMessage').value = latestCustomer;
    $('#aiReplyStatus').textContent = latestCustomer
      ? '已读取客户最近消息。修改“本次回复要求”后点击生成回复。'
      : '暂未识别到客户最近消息；请确认当前打开的是聊天窗口。';

    await openModal('aiReplyModal');
  } catch (error) {
    setStatus('打开 AI 回复失败：' + error.message);
  }
});

$('#generateChatScriptReplyBtn').addEventListener('click', async () => {
  const btn = $('#generateChatScriptReplyBtn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '长期记忆思考中…';
  $('#aiReplyStatus').textContent = 'Chat Script AI 正在读取此客户的独立长期记忆、关系阶段与最近聊天…';
  try {
    const result = await window.yoko.generateChatScriptAiReply({ requirements: $('#aiReplyRequest').value.trim() });
    if (!result?.ok || !result?.reply_ja) throw new Error(result?.error || '没有生成回复');
    latestAiReplyText = result.reply_ja;
    latestAiReplyProvider = `Chat Script AI · ${result.model || ''}`;
    latestChatScriptRequestId = result.request_id || '';
    latestChatScriptTranslation = result.reply_zh || '';
    $('#aiReplyResult').value = result.reply_ja;
    $('#aiReplyTranslation').value = result.reply_zh || '';
    $('#aiReplyCustomerMessage').value = result.latestCustomer || $('#aiReplyCustomerMessage').value;
    $('#aiReplyProviderLabel').textContent = latestAiReplyProvider;
    const boundary = result.boundary?.triggered ? ` · ⚠ 边界：${result.boundary.type || '越界'}（强度 ${result.boundary.severity || '-'}）` : '';
    $('#chatScriptRelationshipState').textContent = `自动第 ${result.active_day || '-'} 天 · ${result.relationship_label || result.relationship_stage || '关系评估中'} · 情绪 ${result.emotion || '-'} · 本轮 ${result.turn_action || '-'}${boundary}`;
    $('#writeAiReplyBtn').disabled = false;
    $('#chatScriptFeedbackActions').style.display = 'flex';
    $('#aiReplyStatus').textContent = result.deduped ? '已读取同一客户消息的现有草稿，避免重复写入长期记忆。请确认后写入 LINE。' : '生成完成。日语可发送正文与中文对照已返回；不会自动发送。';
    setStatus(`Chat Script AI 回复已生成 · ${result.relationship_label || ''}`);
  } catch (error) {
    $('#aiReplyStatus').textContent = 'Chat Script AI 生成失败：' + (error?.message || error);
    setStatus('Chat Script AI 生成失败：' + (error?.message || error));
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

$('#chatScriptEffectiveBtn').addEventListener('click', async () => {
  if (!latestChatScriptRequestId) return;
  try { await window.yoko.feedbackChatScriptAi({requestId:latestChatScriptRequestId,verdict:'effective',reason:'YokoSCRM 人工确认有效'}); $('#aiReplyStatus').textContent='已加入 Chat Script AI 有效话术资产库。'; }
  catch(e){ setStatus('有效话术保存失败：'+e.message); }
});
$('#chatScriptRejectBtn').addEventListener('click', async () => {
  if (!latestChatScriptRequestId) return;
  const reason = window.prompt('为什么不合适？例如：问太多、太甜、没回应重点、边界太软、重复模板') || '人工标记不合适';
  try { await window.yoko.feedbackChatScriptAi({requestId:latestChatScriptRequestId,verdict:'reject',reason}); $('#aiReplyStatus').textContent='已记录为不合适样本，后续会降低类似表达。'; }
  catch(e){ setStatus('反馈保存失败：'+e.message); }
});

$('#generateAiReplyBtn').addEventListener('click', async () => {
  const btn = $('#generateAiReplyBtn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '思考中…';
  $('#aiReplyStatus').textContent = 'AI 正在根据当前聊天和你的要求生成回复…';
  try {
    state = await window.yoko.getState();
    const t = state?.config?.translation || {};
    const result = await window.yoko.generateAiReply({
      requirements: $('#aiReplyRequest').value.trim(),
      provider: t.aiReplyProvider || 'ollama',
      contextMessages: Number(t.aiReplyContextMessages || 8),
      language: t.aiReplyLanguage || 'ja'
    });
    if (!result?.ok || !result?.reply) throw new Error(result?.error || '没有生成回复');
    latestAiReplyText = result.reply;
    latestAiReplyProvider = result.providerLabel || result.provider || '';
    latestChatScriptRequestId = '';
    latestChatScriptTranslation = result.replyZh || '';
    $('#aiReplyTranslation').value = result.replyZh || '';
    $('#chatScriptRelationshipState').textContent = '';
    $('#chatScriptFeedbackActions').style.display = 'none';
    $('#aiReplyResult').value = result.reply;
    $('#aiReplyCustomerMessage').value = result.latestCustomer || $('#aiReplyCustomerMessage').value;
    $('#aiReplyProviderLabel').textContent = `${result.providerLabel || result.provider} · ${result.model || ''}`;
    $('#writeAiReplyBtn').disabled = false;
    $('#aiReplyStatus').textContent = `生成完成 · 参考最近 ${result.chatCount || 0} 条消息。你可以先修改草稿，再写入 LINE。`;
    setStatus(`AI回复已生成 · ${result.providerLabel || result.provider}`);
  } catch (error) {
    $('#aiReplyStatus').textContent = '生成失败：' + (error?.message || error);
    setStatus('AI回复生成失败：' + (error?.message || error));
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

$('#writeAiReplyBtn').addEventListener('click', async () => {
  const text = $('#aiReplyResult').value.trim();
  if (!text) {
    setStatus('AI回复内容为空');
    return;
  }
  try {
    const result = await window.yoko.setLineInput(text);
    if (!result?.ok) throw new Error(result?.error || '写入 LINE 失败');
    await closeModal('aiReplyModal');
    setStatus(`AI回复已写入 LINE 输入框${latestAiReplyProvider ? ' · ' + latestAiReplyProvider : ''}，请确认后发送`);
  } catch (error) {
    setStatus('写入 AI 回复失败：' + error.message);
  }
});


function currentAiTestPayload(provider) {
  return {
    provider: 'ollama',
    ollamaUrl: $('#ollamaUrl').value.trim(),
    ollamaModel: ($('#ollamaModelMode')?.value || 'auto_balanced') === 'fixed' ? $('#ollamaModel').value.trim() : ollamaFixedModelDraft,
    ollamaModelMode: $('#ollamaModelMode')?.value || 'auto_balanced'
  };
}

for (const btn of document.querySelectorAll('.test-ai-btn')) {
  btn.addEventListener('click', async () => {
    const provider = btn.dataset.provider;
    const resultBox = $('#aiTestResult');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '测试中…';
    resultBox.className = 'ai-test-result';
    resultBox.textContent = '正在测试本机 Ollama（仅本地直连，不调用任何云端翻译）…';
    try {
      const result = await window.yoko.testAiProvider(currentAiTestPayload(provider));
      if (result?.ok) {
        resultBox.className = 'ai-test-result ok';
        const routeText = result?.route?.mode !== 'fixed' ? `\n智能路由：速度×准确平衡 · 难度 ${result.route.score ?? '-'} · 目标 ${result.route.targetModel || '-'} · 实际 ${result.route.model || result.model}${result.route.fallbackUsed ? ` · 超时降级自 ${result.route.fallbackFrom || '-'}` : ''}` : '';
        resultBox.textContent = `✓ ${result.providerLabel} 测试成功\n模型：${result.model}${routeText}\n耗时：${result.latencyMs} ms\n测试译文：${result.translated}`;
      } else {
        resultBox.className = 'ai-test-result error';
        resultBox.textContent = `✗ ${result?.providerLabel || provider} 测试失败\n模型：${result?.model || ''}\n${result?.error || '未知错误'}`;
      }
    } catch (error) {
      resultBox.className = 'ai-test-result error';
      resultBox.textContent = `✗ 测试失败\n${error?.message || error}`;
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
}


function renderLineExtensionStatus(extensionState) {
  const box = $('#lineExtensionStatusText');
  if (!box) return;
  const info = extensionState?.lineExtensionStatus || {};
  const current = String($('#lineExtensionPath')?.value || info.configuredPath || '').trim();
  if (info.valid && info.bundled) {
    box.textContent = `✓ 安装包已内置 LINE 扩展${info.version ? ' v' + info.version : ''}。换电脑安装后可直接新增 LINE，无需再安装 Chrome 扩展。`;
    return;
  }
  if (info.valid && info.managed) {
    box.textContent = '✓ 当前使用手动导入的 LINE 扩展副本。';
    return;
  }
  if (info.valid) {
    box.textContent = '✓ 当前 LINE 扩展可用，但正在直接使用浏览器目录。建议点击“导入 LINE 扩展”复制到 Yoko SCRM 本地目录。';
    return;
  }
  if (info.browserDetected) {
    box.textContent = '检测到浏览器里的 LINE 扩展。点击“自动检测并导入”即可复制到 Yoko SCRM。';
    return;
  }
  if (current) {
    box.textContent = '⚠ 当前保存的扩展目录在这台电脑上无效。请重新自动检测或导入 LINE 扩展。';
    return;
  }
  box.textContent = '⚠ 当前电脑还没有配置 LINE 扩展。请先在 Chrome/Edge 安装 LINE 扩展，再自动检测；也可以手动导入已有扩展目录。';
}

function getActiveAccount() {
  return state?.config?.accounts?.find(account => account.id === state?.config?.activeAccountId) || null;
}

function fillActiveProxyForm(account) {
  const p = account?.proxy || {};
  const label = String(account?.displayNameOverride || account?.live?.displayName || account?.lineProfile?.displayName || account?.name || 'LINE');
  $('#proxyAccountLabel').textContent = `当前账号：${label}`;
  $('#activeProxyEnabled').checked = !!p.enabled;
  $('#activeProxyProtocol').value = p.protocol || 'socks5';
  $('#activeProxyHost').value = p.host || '';
  $('#activeProxyPort').value = p.port || '';
  $('#activeProxyAuth').checked = !!p.auth;
  $('#activeProxyUsername').value = p.username || '';
  $('#activeProxyPassword').value = p.password || '';

  const network = account?.network || {};
  const latency = Number(network.lastLatencyMs);
  const lastIp = String(network.lastPublicIp || '').trim();
  const resultBox = $('#activeProxyTestResult');
  if (resultBox) {
    resultBox.className = 'proxy-test-result';
    resultBox.textContent = Number.isFinite(latency)
      ? `最近测速：${Math.max(0, Math.round(latency))} ms${lastIp ? ` · 出口 IP：${lastIp}` : ''}`
      : '最近测速：未测试';
  }
}

$('#proxyBtn').addEventListener('click', async () => {
  state = await window.yoko.getState();
  const account = getActiveAccount();
  if (!account) {
    setStatus('请先在左侧选择一个 LINE 账号，再设置代理');
    return;
  }
  fillActiveProxyForm(account);
  openModal('proxyModal');
});

$('#refreshAvatarBtn')?.addEventListener('click', async () => {
  const btn = $('#refreshAvatarBtn');
  const oldText = btn?.textContent || '重抓头像';

  if (btn) {
    btn.disabled = true;
    btn.textContent = workspaceMode === 'aggregate' ? '聚合抓取中…' : '抓取中…';
  }

  try {
    if (workspaceMode === 'aggregate') {
      setStatus('正在重新抓取聚合模式全部已打开 LINE 的客户头像…');
      const result = await window.yoko.refreshAggregateAvatars?.({ force: true, limit: 800 });
      await refreshAggregateInbox({ remote: false, quiet: true });
      aggregateCustomerRenderSignature = '';
      renderAggregateCustomerSidebar();
      const total = Math.max(0, Number(result?.total || aggregateInbox.conversations?.length || 0) || 0);
      const withAvatar = Math.max(0, Number(result?.withAvatar || 0) || 0);
      const queued = Math.max(0, Number(result?.queued || 0) || 0);
      if (result?.ok !== false) {
        setStatus(`聚合客户头像已重抓：已显示 ${withAvatar}/${total}${queued ? ` · 本轮处理 ${queued} 位` : ''}`);
      } else {
        setStatus(result?.error || `聚合头像暂未完整恢复，当前 ${withAvatar}/${total}；请保持 LINE 已打开后再点一次“重抓头像”`);
      }
      return;
    }

    state = await window.yoko.getState();
    const account = getActiveAccount();
    if (!account) {
      setStatus('请先在左侧选择一个 LINE 账号，再重抓头像');
      return;
    }

    setStatus(`正在重新抓取 ${account.lineProfile?.displayName || account.name} 的头像…`);
    // LINE模式仍保持原来的“当前账号本人头像”逻辑；聚合模式则使用
    // 上面的全客户修复流程，两个缓存互不覆盖。
    const result = await window.yoko.refreshAccountAvatar(account.id, { force: true });
    await refreshState();

    if (result?.refreshed && result?.avatarDataUrl) {
      setStatus(`${account.lineProfile?.displayName || account.name} 头像已重新抓取并保存`);
    } else if (result?.avatarDataUrl) {
      setStatus(result?.message || `${account.name} 已保留现有头像缓存`);
    } else if (account.isOpen === false) {
      setStatus('当前账号已关闭且没有可用头像，请先点 ▶ 打开 LINE，资料加载后再点“重抓头像”');
    } else {
      setStatus(result?.message || '暂未抓到头像，请等 LINE 好友/个人资料加载完成后再试');
    }
  } catch (error) {
    setStatus('重抓头像失败：' + (error?.message || error));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }
});

$('#testActiveProxyBtn')?.addEventListener('click', async () => {
  const account = getActiveAccount();
  const btn = $('#testActiveProxyBtn');
  const resultBox = $('#activeProxyTestResult');
  if (!account) {
    setStatus('请先在左侧选择一个 LINE 账号');
    return;
  }

  const originalText = btn?.textContent || '测试延迟';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '测速中…';
  }
  if (resultBox) {
    resultBox.className = 'proxy-test-result testing';
    resultBox.textContent = '正在测试当前账号的线路延迟…';
  }

  try {
    const result = await window.yoko.testAccountNetwork(account.id);
    if (result.ok) {
      const modeText = result.bridge ? 'SOCKS5认证桥' : (result.mode === 'proxy' ? '独立代理' : '直连');
      if (resultBox) {
        resultBox.className = 'proxy-test-result ok';
        resultBox.textContent = `延迟：${result.latencyMs} ms · 出口 IP：${result.ip || '-'} · ${modeText}`;
      }
      setStatus(`${account.name} 延迟 ${result.latencyMs}ms · 出口 IP ${result.ip || '-'}`);
      state = await window.yoko.getState();
    } else {
      if (resultBox) {
        resultBox.className = 'proxy-test-result error';
        resultBox.textContent = `测速失败：${result.error || '未知错误'}`;
      }
      setStatus(`${account.name} 线路测试失败：${result.error || '未知错误'}`);
    }
  } catch (error) {
    if (resultBox) {
      resultBox.className = 'proxy-test-result error';
      resultBox.textContent = `测速失败：${error?.message || error}`;
    }
    setStatus('线路测试失败：' + (error?.message || error));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
});

$('#saveActiveProxyBtn').addEventListener('click', async () => {
  const account = getActiveAccount();
  if (!account) {
    setStatus('当前没有选中的 LINE 账号');
    return;
  }
  try {
    await window.yoko.updateAccount({
      id: account.id,
      proxy: {
        enabled: $('#activeProxyEnabled').checked,
        protocol: $('#activeProxyProtocol').value,
        host: $('#activeProxyHost').value.trim(),
        port: Number($('#activeProxyPort').value || 0),
        auth: $('#activeProxyAuth').checked,
        username: $('#activeProxyUsername').value.trim(),
        password: $('#activeProxyPassword').value
      }
    });
    await closeModal('proxyModal');
    await refreshState();
    setStatus(`${account.name} 的代理已保存`);
  } catch (error) {
    setStatus('代理保存失败：' + (error?.message || error));
  }
});

$('#opsBtn')?.addEventListener('click', async () => {
  await openModal('opsModal');
  startOpsHealthMonitor();
});

$('#opsHealthRefreshBtn')?.addEventListener('click', () => refreshOpsHealth());

$('#opsHealthList')?.addEventListener('click', async event => {
  const button = event.target.closest('[data-ops-start]');
  if (!button) return;
  const accountId = String(button.dataset.opsStart || '');
  if (!accountId) return;
  const old = button.textContent;
  button.disabled = true;
  button.textContent = '启动中…';
  try {
    await window.yoko.openAccountWindow(accountId);
    await refreshState().catch(() => {});
    await refreshOpsHealth({ quiet: true });
    setStatus('LINE 已启动');
  } catch (error) {
    setStatus('启动 LINE 失败：' + (error?.message || error));
  } finally {
    button.disabled = false;
    button.textContent = old;
  }
});

$('#opsBackupBtn')?.addEventListener('click', async () => {
  const button = $('#opsBackupBtn');
  const old = button?.textContent || '备份客服数据';
  if (button) { button.disabled = true; button.textContent = '备份中…'; }
  try {
    const result = await window.yoko.createOperationsBackup(collectOperationsWorkspaceBackup());
    if (result?.canceled) return;
    if (result?.ok) {
      const notice = $('#opsNotice');
      if (notice) notice.textContent = `备份完成：${result.filePath}`;
      setStatus('客服运营数据已备份；LINE 登录、代理密码和 API Key 未写入便携备份');
    }
  } catch (error) {
    setStatus('备份失败：' + (error?.message || error));
  } finally {
    if (button) { button.disabled = false; button.textContent = old; }
  }
});

$('#opsRestoreBtn')?.addEventListener('click', async () => {
  if (!window.confirm('恢复客服运营数据会覆盖 CRM、客户状态和部分工作现场设置。LINE 登录会话不会被替换。继续吗？')) return;
  const button = $('#opsRestoreBtn');
  const old = button?.textContent || '恢复客服数据';
  if (button) { button.disabled = true; button.textContent = '恢复中…'; }
  try {
    const result = await window.yoko.restoreOperationsBackup();
    if (result?.canceled) return;
    if (result?.ok) {
      const restoredUi = applyOperationsWorkspaceBackup(result.workspace || {});
      setStatus(`客服数据已恢复${result.restoredDrafts ? ` · 草稿 ${result.restoredDrafts} 条` : ''} · 工作现场 ${restoredUi} 项；正在刷新工作台…`);
      setTimeout(() => window.location.reload(), 450);
    }
  } catch (error) {
    setStatus('恢复失败：' + (error?.message || error));
  } finally {
    if (button) { button.disabled = false; button.textContent = old; }
  }
});

$('#opsDiagnosticBtn')?.addEventListener('click', async () => {
  const button = $('#opsDiagnosticBtn');
  const old = button?.textContent || '导出诊断包';
  if (button) { button.disabled = true; button.textContent = '正在收集…'; }
  try {
    const result = await window.yoko.createDiagnosticPack();
    if (result?.canceled) return;
    if (result?.ok) {
      const notice = $('#opsNotice');
      if (notice) notice.textContent = `诊断包已导出：${result.filePath}`;
      setStatus('诊断包已生成；不包含聊天正文、代理密码或 API Key');
    }
  } catch (error) {
    setStatus('导出诊断包失败：' + (error?.message || error));
  } finally {
    if (button) { button.disabled = false; button.textContent = old; }
  }
});

async function openSettingsPanel() {
  state = await window.yoko.getState();
  const cfg = state.config;

  $('#lineExtensionPath').value =
    state.lineExtensionStatus?.effectivePath ||
    cfg.lineExtensionPath ||
    state.lineExtensionStatus?.managedPath ||
    state.detectedLineExtension ||
    '';
  renderLineExtensionStatus(state);

  const updateCfg = cfg.updates || {};
  $('#updateAutoCheck').checked = updateCfg.autoCheck !== false;
  $('#updateAutoDownload').checked = updateCfg.autoDownload === true;
  $('#updateCheckInterval').value = String(updateCfg.checkIntervalHours || 6);
  try { renderSoftwareUpdateState(await window.yoko.getUpdateState()); } catch {}
  openModal('settingsModal');
}


let ollamaManagerBusy = false;
let ollamaFixedModelDraft = '';
let ollamaLastManagerStatus = null;

function humanLocalBytes(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B','KB','MB','GB','TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)}${units[i]}`;
}

function setOllamaManagerBusy(busy) {
  ollamaManagerBusy = !!busy;
  document.querySelectorAll('#ollamaManager button').forEach(button => {
    button.disabled = !!busy || button.dataset.ollamaLocked === '1';
  });
}

function showOllamaManagerProgress(payload = {}) {
  const box = $('#ollamaDownloadBox');
  if (!box) return;
  box.classList.remove('hidden');
  const percent = Math.max(0, Math.min(100, Number(payload.percent || 0)));
  const indeterminate = payload.indeterminate === true;
  if ($('#ollamaDownloadText')) $('#ollamaDownloadText').textContent = payload.status || '正在处理…';
  if ($('#ollamaDownloadPercent')) $('#ollamaDownloadPercent').textContent = indeterminate ? '进行中' : `${Math.round(percent)}%`;
  if ($('#ollamaProgressBar')) {
    $('#ollamaProgressBar').classList.toggle('indeterminate', indeterminate);
    $('#ollamaProgressBar').style.width = indeterminate ? '32%' : `${percent}%`;
  }
  const completed = humanLocalBytes(payload.completed);
  const total = humanLocalBytes(payload.total);
  const sizeText = completed && total ? `${completed} / ${total}` : '';
  if ($('#ollamaDownloadDetail')) $('#ollamaDownloadDetail').textContent = [payload.model, sizeText, payload.detail].filter(Boolean).join(' · ');
}

function syncOllamaModelModeUi(mode = $('#ollamaModelMode')?.value || 'auto_balanced') {
  const fixed = String(mode) === 'fixed';
  const select = $('#ollamaModel');
  const field = $('#ollamaFixedModelField');
  if (!select) return;
  const emptyOption = select.querySelector('option[value=""]');
  if (emptyOption) emptyOption.textContent = fixed ? '请选择已安装模型' : '自动管理，无需选择';
  if (fixed) {
    select.disabled = false;
    if (ollamaFixedModelDraft && [...select.options].some(option => option.value === ollamaFixedModelDraft)) select.value = ollamaFixedModelDraft;
  } else {
    if (select.value) ollamaFixedModelDraft = select.value;
    select.value = '';
    select.disabled = true;
  }
  field?.classList.toggle('ollama-auto-disabled', !fixed);
}

function renderOllamaManager(status = {}) {
  const runtime = $('#ollamaRuntimeState');
  const list = $('#ollamaModelList');
  if (!runtime || !list) return;
  ollamaLastManagerStatus = status || {};
  const versionBits = [status.runtimeVersion ? `当前 v${status.runtimeVersion}` : '', status.latestVersion ? `最新 v${status.latestVersion}` : ''].filter(Boolean).join(' · ');
  const versionState = status.updateAvailable ? ' · 有可用更新' : status.isLatest ? ' · 已是最新版' : status.latestCheckError ? ' · 最新版本检查失败' : '';
  const runtimeLabel = status.serverOnline
    ? `环境已就绪 · Ollama 服务运行中${status.runtimeType === 'bundled' ? ' · 内置运行时' : ''}${versionBits ? ` · ${versionBits}` : ''}${versionState}`
    : status.runtimeInstalled
      ? `已检测到 Ollama，但服务尚未启动${versionBits ? ` · ${versionBits}` : ''}${versionState}`
      : '未安装 Ollama 环境';
  runtime.textContent = runtimeLabel;
  runtime.classList.toggle('ok', !!status.serverOnline);
  runtime.classList.toggle('warn', !status.serverOnline);

  const current = String(status.currentModel || '');
  const modelMode = String(status.modelMode || 'auto_balanced');
  if ($('#ollamaModelMode')) $('#ollamaModelMode').value = modelMode;
  if (modelMode === 'fixed' && current) ollamaFixedModelDraft = current;
  syncOllamaModelModeUi(modelMode);
  const actionButton = $('#installOllamaRuntimeBtn');
  if (actionButton) {
    actionButton.dataset.ollamaLocked = (status.runtimeType === 'bundled' || status.isLatest) ? '1' : '0';
    if (status.runtimeType === 'bundled') { actionButton.textContent = '内置环境无需更新'; actionButton.disabled = true; }
    else if (!status.runtimeInstalled) { actionButton.textContent = '安装 Ollama'; actionButton.disabled = !!ollamaManagerBusy; }
    else if (status.updateAvailable) { actionButton.textContent = status.latestVersion ? `更新到 v${status.latestVersion}` : '更新 Ollama'; actionButton.disabled = !!ollamaManagerBusy; }
    else if (status.isLatest) { actionButton.textContent = '已是最新版'; actionButton.disabled = true; }
    else { actionButton.textContent = '检测后更新'; actionButton.disabled = !!ollamaManagerBusy; }
  }
  const hint = $('#ollamaAutoModeHint');
  if (hint) {
    const last = status.lastRoute || null;
    hint.textContent = modelMode !== 'fixed'
      ? `智能自动（速度×准确平衡）已启用${last?.model ? ` · 最近一次选择 ${last.model}${Number.isFinite(last.score) ? ` · 难度 ${last.score}` : ''}${Number.isFinite(last.elapsedMs) ? ` · ${last.elapsedMs}ms` : ''}` : ''}。只使用已下载模型。`
      : '当前为固定模型模式；点击模型卡片“使用此模型”也会切换到固定模式。';
  }
  const models = Array.isArray(status.models) ? status.models : [];
  list.innerHTML = models.map(model => {
    const installed = model.installed === true;
    const active = modelMode === 'fixed' && current === model.id;
    return `<div class="ollama-model-card ${installed ? 'installed' : ''}" data-model="${escapeHtml(model.id)}">
      <div class="ollama-model-title"><span>${escapeHtml(model.label)}</span><span class="ollama-model-badge">${installed ? (active ? '使用中' : modelMode !== 'fixed' ? '自动候选' : '已下载') : '未下载'}</span></div>
      <div class="ollama-model-meta">${escapeHtml(model.tier || '')} · ${escapeHtml(model.size || '')}</div>
      <div class="ollama-model-actions">
        ${installed
          ? `<button type="button" class="${active ? '' : 'primary'}" data-ollama-use="${escapeHtml(model.id)}" ${active ? 'disabled data-ollama-locked="1"' : ''}>${active ? '正在使用' : modelMode !== 'fixed' ? '固定使用此模型' : '使用此模型'}</button><button type="button" class="danger" data-ollama-delete="${escapeHtml(model.id)}">删除模型</button>`
          : `<button type="button" class="primary" data-ollama-install="${escapeHtml(model.id)}">一键下载安装</button>`}
      </div>
    </div>`;
  }).join('');
  setOllamaManagerBusy(ollamaManagerBusy);
}

async function refreshOllamaManager({ quiet = false } = {}) {
  if (!window.yoko.getOllamaManagerStatus) return;
  try {
    const status = await window.yoko.getOllamaManagerStatus();
    renderOllamaManager(status || {});
    return status;
  } catch (error) {
    const runtime = $('#ollamaRuntimeState');
    if (runtime) { runtime.textContent = '环境检测失败：' + (error?.message || error); runtime.classList.add('warn'); }
    if (!quiet) setStatus('Ollama 环境检测失败：' + (error?.message || error));
    return null;
  }
}

async function detectOllamaRuntimeFromUi({ quiet = false } = {}) {
  if (ollamaManagerBusy || !window.yoko.detectOllamaRuntime) return ollamaLastManagerStatus;
  try {
    setOllamaManagerBusy(true);
    showOllamaManagerProgress({ status: '正在检测 Ollama 环境与版本…', percent: 12 });
    const status = await window.yoko.detectOllamaRuntime();
    renderOllamaManager(status || {});
    if (!quiet) {
      if (!status?.runtimeInstalled) setStatus('未检测到 Ollama 环境，可以点击“安装 Ollama”');
      else if (status?.updateAvailable) setStatus(`检测完成：当前 v${status.runtimeVersion || '?'}，可更新到 v${status.latestVersion || '?'}`);
      else if (status?.isLatest) setStatus(`检测完成：Ollama v${status.runtimeVersion || ''} 已是最新版`);
      else if (status?.latestCheckError) setStatus(`已检测到 Ollama${status.runtimeVersion ? ` v${status.runtimeVersion}` : ''}；暂时无法检查最新版本`);
      else setStatus('Ollama 环境检测完成');
    }
    return status;
  } catch (error) {
    showOllamaManagerProgress({ status: 'Ollama 环境检测失败', percent: 0, detail: error?.message || error });
    if (!quiet) setStatus('Ollama 环境检测失败：' + (error?.message || error));
    return null;
  } finally {
    setOllamaManagerBusy(false);
  }
}

async function installOllamaRuntimeFromUi() {
  if (ollamaManagerBusy) return;
  let status = ollamaLastManagerStatus;
  if (!status?.runtimeInstalled || (!status?.latestVersion && status?.runtimeType !== 'bundled')) status = await detectOllamaRuntimeFromUi({ quiet: true });
  if (!status) return;
  if (status.runtimeType === 'bundled') { setStatus('当前使用内置 Ollama 环境，无需单独更新'); return; }
  if (status.runtimeInstalled && status.isLatest) {
    alert(`当前 Ollama${status.runtimeVersion ? ` v${status.runtimeVersion}` : ''} 已是最新版，无需更新。`);
    return;
  }
  const forceUpdate = !!(status.runtimeInstalled && status.updateAvailable);
  const prompt = forceUpdate
    ? `检测到 Ollama 可更新：\n当前版本：v${status.runtimeVersion || '?'}\n最新版本：v${status.latestVersion || '?'}\n\n是否现在更新？`
    : status.runtimeInstalled
      ? `已检测到 Ollama${status.runtimeVersion ? ` v${status.runtimeVersion}` : ''}，但暂时无法确认最新版本。\n是否仍要运行官方更新程序？`
      : '未检测到 Ollama 环境。\n是否现在安装官方 Ollama？';
  if (!confirm(prompt)) return;
  try {
    setOllamaManagerBusy(true);
    showOllamaManagerProgress({ status: forceUpdate ? '正在启动 Ollama 更新流程…' : '正在启动 Ollama 安装流程…', percent: 8, indeterminate: true });
    const result = await window.yoko.installOllamaRuntime({ forceUpdate: forceUpdate || !!status.runtimeInstalled });
    renderOllamaManager(result?.status || await window.yoko.getOllamaManagerStatus());
    setStatus(forceUpdate ? 'Ollama 已更新并重新检测版本' : 'Ollama 本地环境已就绪');
  } catch (error) {
    showOllamaManagerProgress({ status: forceUpdate ? 'Ollama 环境更新失败' : 'Ollama 环境安装失败', percent: 0, detail: error?.message || error });
    setStatus((forceUpdate ? 'Ollama 环境更新失败：' : 'Ollama 环境安装失败：') + (error?.message || error));
  } finally {
    setOllamaManagerBusy(false);
    await refreshOllamaManager({ quiet: true });
  }
}

async function installOllamaModelFromUi(model) {
  if (ollamaManagerBusy || !model) return;
  try {
    setOllamaManagerBusy(true);
    showOllamaManagerProgress({ model, status: '检查 Ollama 环境…', percent: 1 });
    const result = await window.yoko.installOllamaModel(model);
    if (result?.modelMode === 'fixed') {
      ollamaFixedModelDraft = result?.selectedModel || model;
      if ($('#ollamaModel')) $('#ollamaModel').value = ollamaFixedModelDraft;
    }
    state = await window.yoko.getState();
    await refreshOllamaManager({ quiet: true });
    setStatus(result?.modelMode !== 'fixed' ? `已下载 ${result?.selectedModel || model}，已加入智能自动模型池` : `已下载并启用 ${result?.selectedModel || model}`);
  } catch (error) {
    showOllamaManagerProgress({ model, status: '模型下载安装失败', percent: 0, detail: error?.message || error });
    setStatus('Qwen 模型下载安装失败：' + (error?.message || error));
  } finally {
    setOllamaManagerBusy(false);
  }
}

async function deleteOllamaModelFromUi(model) {
  if (ollamaManagerBusy || !model) return;
  if (!confirm(`确定删除本机模型 ${model}？\n删除后会释放对应磁盘空间。`)) return;
  try {
    setOllamaManagerBusy(true);
    showOllamaManagerProgress({ model, status: `正在卸载并删除 ${model}…`, percent: 15 });
    const result = await window.yoko.deleteOllamaModel(model);
    state = await window.yoko.getState();
    const nextModel = String(result?.selectedModel ?? state?.config?.translation?.ollamaModel ?? '');
    if ($('#ollamaModel')) $('#ollamaModel').value = nextModel;
    renderOllamaManager(result?.status || await window.yoko.getOllamaManagerStatus());
    const resultBox = $('#aiTestResult');
    if (resultBox) {
      resultBox.className = 'ai-test-result';
      const autoMode = String(result?.status?.modelMode || state?.config?.translation?.ollamaModelMode || '') !== 'fixed';
      resultBox.textContent = result?.removedCurrent
        ? (autoMode
            ? '这个模型已删除并从智能自动模型池移除；如果仍有其他已安装模型，自动翻译会继续使用剩余模型。请重新测试以确认实际路由。'
            : (nextModel ? `当前模型已删除，已切换到 ${nextModel}。请重新测试本地 Ollama。` : '当前固定模型已删除。请先下载或选择其他模型。'))
        : `模型 ${model} 已确认从 Ollama 模型列表移除。`;
    }
    showOllamaManagerProgress({ model, status: `已确认删除 ${model}`, percent: 100 });
    setStatus(result?.alreadyMissing ? `模型 ${model} 本机已不存在` : `已确认删除本机模型 ${model}`);
  } catch (error) {
    showOllamaManagerProgress({ model, status: '模型删除失败', percent: 0, detail: error?.message || error });
    await refreshOllamaManager({ quiet: true });
    setStatus('删除模型失败：' + (error?.message || error));
  } finally {
    setOllamaManagerBusy(false);
  }
}

$('#detectOllamaRuntimeBtn')?.addEventListener('click', () => detectOllamaRuntimeFromUi());
$('#installOllamaRuntimeBtn')?.addEventListener('click', () => installOllamaRuntimeFromUi());
$('#refreshOllamaManagerBtn')?.addEventListener('click', () => refreshOllamaManager());
$('#ollamaModelMode')?.addEventListener('change', () => {
  const fixed = $('#ollamaModelMode').value === 'fixed';
  syncOllamaModelModeUi($('#ollamaModelMode').value);
  const hint = $('#ollamaAutoModeHint');
  if (hint) hint.textContent = fixed
    ? '固定模型模式：所有本地翻译都使用下方选定模型。'
    : '智能自动（速度×准确平衡）：普通聊天优先快速模型，复杂内容才升档；大模型超时会自动降一级重试。';
});
$('#ollamaModel')?.addEventListener('change', () => { if ($('#ollamaModel').value) ollamaFixedModelDraft = $('#ollamaModel').value; });
$('#ollamaModelList')?.addEventListener('click', async event => {
  const installButton = event.target.closest('[data-ollama-install]');
  if (installButton) { await installOllamaModelFromUi(installButton.dataset.ollamaInstall); return; }
  const useButton = event.target.closest('[data-ollama-use]');
  if (useButton) {
    const model = useButton.dataset.ollamaUse;
    try {
      setOllamaManagerBusy(true);
      const result = await window.yoko.selectOllamaModel(model);
      ollamaFixedModelDraft = result?.selectedModel || model;
      if ($('#ollamaModelMode')) $('#ollamaModelMode').value = 'fixed';
      syncOllamaModelModeUi('fixed');
      state = await window.yoko.getState();
      renderOllamaManager(result?.status || await window.yoko.getOllamaManagerStatus());
      setStatus(`已切换到 ${result?.selectedModel || model}`);
    } catch (error) {
      setStatus('切换本地模型失败：' + (error?.message || error));
    } finally {
      setOllamaManagerBusy(false);
    }
    return;
  }
  const deleteButton = event.target.closest('[data-ollama-delete]');
  if (deleteButton) await deleteOllamaModelFromUi(deleteButton.dataset.ollamaDelete);
});

if (window.yoko.onOllamaManagerProgress) {
  window.yoko.onOllamaManagerProgress(payload => showOllamaManagerProgress(payload || {}));
}

function formatVpsCacheTime(value='') {
  if(!value)return '暂无';
  try{return new Date(value).toLocaleString();}catch{return String(value);}
}
async function refreshVpsTranslationCacheStatus({ quiet=false } = {}) {
  const box=$('#vpsTranslationCacheStatus');
  const btn=$('#refreshVpsTranslationCacheBtn');
  if(!box)return null;
  if(!quiet){ box.className='ai-test-result'; box.textContent='正在检测 VPS DeepL 翻译网关…'; }
  if(btn)btn.disabled=true;
  try{
    const result=await window.yoko.testAiProvider?.({provider:'vpscache'});
    const runtime=result?.runtime||{};
    if(result?.ok){
      box.className='ai-test-result ok';
      const uploadState=runtime.lastUploadOk===true
        ? `成功 · ${formatVpsCacheTime(runtime.lastUploadAt)} · ${runtime.lastUploadSourceLang||'-'}`
        : (runtime.lastUploadOk===false ? `失败 · ${formatVpsCacheTime(runtime.lastUploadAt)} · ${runtime.lastUploadError||''}` : '暂无本机上传记录');
      const lookupState=runtime.lastLookupAt
        ? `${runtime.lastLookupHit===true?'命中':(runtime.lastLookupHit===false?'未命中':'已查询')} · ${formatVpsCacheTime(runtime.lastLookupAt)} · ${runtime.lastLookupSourceLang||'-'}`
        : '暂无本机查询记录';
      const pre=result.preTranslation||{};
      box.textContent=`✓ VPS DeepL 翻译网关已连接
DeepL API：${result.deeplConfigured?'已配置':'未配置'} · 云翻译：${result.cloudProvider?'在线':'未启用'} · 仅客户入站：${result.inboundOnly?'是':'否'}
服务器预翻译：${pre.enabled?'已开启':'未开启'}${pre.running?' · 正在处理':''} · 已翻译 ${Number(pre.translated||0)} · 缓存命中 ${Number(pre.cacheHits||0)} · 失败 ${Number(pre.failures||0)}
缓存数量：${Number(result.cacheEntries||0)} / ${Number(result.cacheMax||0)||'-'}
存储：${result.storage==='sqlite'?'SQLite 高性能缓存':(result.storage||'兼容模式')}
最近 Provider：${runtime.lastProvider||'-'} · ${runtime.lastProviderCacheHit===true?'缓存命中':(runtime.lastProviderOk===true?'翻译成功':(runtime.lastProviderOk===false?'失败':'暂无'))} · ${Number(runtime.lastProviderElapsedMs||0)} ms
最近上传：${uploadState}
最近查询：${lookupState}
检测耗时：${Number(result.latencyMs||0)} ms`;
    }else{
      box.className='ai-test-result error';
      box.textContent=`✗ VPS DeepL 翻译网关未连接
${result?.error||'请检查团队承接/VPS连接及 DeepL API Key。'}`;
    }
    return result;
  }catch(error){
    box.className='ai-test-result error';
    box.textContent=`✗ VPS DeepL 翻译检测失败
${error?.message||error}`;
    return null;
  }finally{ if(btn)btn.disabled=false; }
}

async function openTranslationPanel() {
  state = await window.yoko.getState();
  const cfg = state.config || {};
  const translation = cfg.translation || {};
  $('#incomingTranslationProvider').value = translation.incomingTranslationProvider === 'openai' ? 'openai' : 'deepl';
  $('#openaiTranslationModel').value = translation.openaiTranslationModel || 'gpt-6-luna';
  $('#openaiTranslationApiKey').value = '';
  $('#openaiTranslationKeyStatus').textContent = translation.openaiTranslationKeyConfigured ? 'API Key 已在本机配置（不会回显）' : '尚未配置 OpenAI API Key';
  $('#ollamaUrl').value = translation.ollamaUrl || 'http://127.0.0.1:11434';
  ollamaFixedModelDraft = translation.ollamaModel || '';
  $('#ollamaModelMode').value = translation.ollamaModelMode === 'fixed' ? 'fixed' : 'auto_balanced';
  $('#ollamaModel').value = ollamaFixedModelDraft;
  syncOllamaModelModeUi($('#ollamaModelMode').value);
  $('#aiContextMessages').value = String(translation.aiContextMessages ?? 4);
  $('#translationCacheEnabled').checked = translation.cacheEnabled !== false;
  refreshGptTranslationCacheStats();
  $('#inlineTranslationEnabled').checked = translation.inlineEnabled !== false;
  $('#translateOutgoingMessages').checked = translation.ollamaTranslateOutgoing !== false;
  if ($('#localTranslationFallbackEnabled')) $('#localTranslationFallbackEnabled').checked = translation.localFallbackEnabledV127133 !== false;
  $('#inlineSource').value = translation.inlineSource || 'auto';
  $('#inlineTarget').value = translation.inlineTarget || 'zh';
  $('#inlineDisplayMode').value = translation.inlineDisplayMode || 'bilingual';
  openModal('translationModal');
  refreshOllamaManager({ quiet: true });
  setTimeout(() => $('#inlineTranslationEnabled')?.focus({ preventScroll: true }), 60);
}

$('#settingsBtn')?.addEventListener('click', () => openSettingsPanel());
$('#globalTranslationSettingsBtn')?.addEventListener('click', () => openTranslationPanel());
$('#externalTranslationSettingsBtn')?.addEventListener('click', () => openTranslationPanel());

$('#detectExtensionBtn').addEventListener(
  'click',
  async () => {
    try {
      const path = await window.yoko.autoDetectLineExtension();
      $('#lineExtensionPath').value = path || '';
      state = await window.yoko.getState();
      renderLineExtensionStatus(state);
      setStatus(path ? '已检测并配置 LINE 扩展' : '没有自动找到 LINE 扩展，请先在浏览器安装或手动导入');
    } catch (error) {
      setStatus('自动检测 LINE 扩展失败：' + (error?.message || error));
    }
  }
);

$('#importExtensionBtn').addEventListener(
  'click',
  async () => {
    try {
      const path = await window.yoko.importLineExtension();
      if (!path) return;
      $('#lineExtensionPath').value = path;
      state = await window.yoko.getState();
      renderLineExtensionStatus(state);
      setStatus('LINE 扩展已导入到 Yoko SCRM 本地数据目录');
    } catch (error) {
      setStatus('导入 LINE 扩展失败：' + (error?.message || error));
    }
  }
);

$('#chooseExtensionBtn').addEventListener(
  'click',
  async () => {
    try {
      const path =
        await window.yoko.chooseLineExtension();
      if (path) {
        $('#lineExtensionPath').value = path;
        state = await window.yoko.getState();
        renderLineExtensionStatus(state);
        setStatus('已选择外部 LINE 扩展目录；建议后续使用“导入 LINE 扩展”以提高稳定性');
      }
    } catch (error) {
      setStatus(
        '扩展目录无效：' + error.message
      );
    }
  }
);

$('#saveSettingsBtn').addEventListener(
  'click',
  async () => {
    try {
      const cfg = await window.yoko.saveSettings({
        lineExtensionPath: $('#lineExtensionPath').value.trim(),
        updates: {
          autoCheck: $('#updateAutoCheck').checked,
          autoDownload: $('#updateAutoDownload').checked,
          checkIntervalHours: Number($('#updateCheckInterval').value || 6)
        }
      });
      state.config = cfg;
      await closeModal('settingsModal');
      setStatus('设置已保存');
    } catch (error) {
      setStatus('设置保存失败：' + error.message);
    }
  }
);

$('#refreshVpsTranslationCacheBtn')?.addEventListener('click', () => refreshVpsTranslationCacheStatus({ quiet:false }));
async function refreshGptTranslationCacheStats() {
  const el=$('#gptTranslationCacheStats');
  if(!el || !window.yoko?.getGptTranslationCacheStats)return;
  try { const stats=await window.yoko.getGptTranslationCacheStats();
    el.textContent=`本地翻译缓存：${Number(stats.entries||0)} 条 · GPT 缓存命中：${Number(stats.cacheHits||0)} 次 · GPT API 请求：${Number(stats.apiCalls||0)} 次（统计从 V1.27.280 开始）`;
  } catch { el.textContent='缓存统计暂不可用'; }
}
$('#testOpenaiTranslationBtn')?.addEventListener('click', async () => {
  const output = $('#testOpenaiTranslationResult');
  const btn = $('#testOpenaiTranslationBtn');
  btn.disabled = true;
  output.textContent = '正在请求 GPT 翻译…';
  try {
    const result = await window.yoko.testAiProvider({provider:'openai-translation'});
    output.textContent = result?.ok
      ? `连接成功 · ${result.model || ''} · ${result.latencyMs || 0}ms · ${result.translated || ''}`
      : `测试失败：${result?.error || '请检查 API Key、模型或网络连接'}`;
  } catch (error) { output.textContent = `测试失败：${error?.message || error}`; }
  finally { btn.disabled = false; refreshGptTranslationCacheStats(); }
});


$('#saveTranslationSettingsBtn')?.addEventListener('click', async () => {
  try {
    const engine = 'ollama';
    const incomingTranslationProvider = $('#incomingTranslationProvider').value;
    const openaiTranslationModel = $('#openaiTranslationModel').value.trim();
    const openaiTranslationApiKey = $('#openaiTranslationApiKey').value.trim();
    const inlineEnabled = $('#inlineTranslationEnabled').checked;
    const ollamaUrl = $('#ollamaUrl').value.trim();
    const ollamaModelMode = $('#ollamaModelMode')?.value || 'auto_balanced';
    const ollamaModel = ollamaModelMode === 'fixed' ? $('#ollamaModel').value.trim() : ollamaFixedModelDraft;
    const localFallbackEnabled = $('#localTranslationFallbackEnabled')?.checked !== false;
    if (incomingTranslationProvider !== 'openai' && inlineEnabled && localFallbackEnabled && !ollamaUrl) { setStatus('已开启本地备用，请填写 Ollama 本地地址'); return; }
    if (incomingTranslationProvider !== 'openai' && inlineEnabled && localFallbackEnabled && ollamaModelMode === 'fixed' && !ollamaModel) { setStatus('已开启本地备用，固定模型模式需要选择一个已安装模型'); return; }

    const cfg = await window.yoko.saveSettings({
      translation: {
        engine,
        incomingTranslationProvider,
        openaiTranslationModel,
        openaiTranslationApiKey,
        ollamaUrl,
        ollamaModel,
        ollamaModelMode,
        aiContextMessages: Number($('#aiContextMessages').value || 4),
        cacheEnabled: $('#translationCacheEnabled').checked,
        inlineEnabled,
        ollamaTranslateOutgoing: $('#translateOutgoingMessages').checked,
        inlineSource: $('#inlineSource').value,
        inlineTarget: $('#inlineTarget').value,
        inlineDisplayMode: $('#inlineDisplayMode').value,
        vpsGatewayEnabled: true,
        localFallbackEnabledV127133: localFallbackEnabled,
        serverPreTranslationV127133: true
      }
    });
    state.config = cfg;
    if(shellSurface==='native-api'){nativeApiTranslationGeneration++;nativeApiTranslationCache.clear();nativeApiTranslationReschedule=true;renderNativeApiMessages({keepBottom:false});scheduleNativeApiTranslations().catch(()=>{});}
    await closeModal('translationModal');
    setStatus(cfg.translation.inlineEnabled
      ? (cfg.translation.incomingTranslationProvider === 'openai' ? '全局翻译已开启 · 客户：GPT API 翻译 · 我方：原有本地翻译' : `全局翻译已开启 · 客户：服务器预翻译 + DeepL${cfg.translation.localFallbackEnabledV127133!==false?' + Ollama故障备用':' · 本地备用关闭'} · 我方：${cfg.translation.ollamaTranslateOutgoing!==false?'本地翻译开启':'不翻译'}`)
      : '全局翻译已关闭');
  } catch (error) {
    setStatus('翻译设置保存失败：' + error.message);
  }
});



$('#checkUpdateBtn')?.addEventListener('click', async () => {
  const btn = $('#checkUpdateBtn');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '检查中…';
  try {
    renderSoftwareUpdateState(await window.yoko.checkForUpdates());
  } catch (error) {
    renderSoftwareUpdateState({ status: 'error', message: '检查更新失败', error: error?.message || String(error) });
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
});

$('#downloadUpdateBtn')?.addEventListener('click', async () => {
  try {
    renderSoftwareUpdateState({ status: 'downloading', message: '正在开始下载新版本…' });
    await window.yoko.downloadUpdate();
  } catch (error) {
    renderSoftwareUpdateState({ status: 'error', message: '下载更新失败', error: error?.message || String(error) });
  }
});

$('#installUpdateBtn')?.addEventListener('click', async () => {
  try {
    await window.yoko.installUpdate();
  } catch (error) {
    renderSoftwareUpdateState({ status: 'error', message: '启动安装失败', error: error?.message || String(error) });
  }
});

window.yoko.onSoftwareUpdateStatus(payload => renderSoftwareUpdateState(payload));


$('#aggregateReplyTranslateBtn')?.addEventListener('click', () => aggregateTranslateDraft());
$('#aggregateReplyTranslateSendBtn')?.addEventListener('click', () => aggregateTranslateDraft({ sendAfter: true }));
$('#aggregateReplySendOriginalBtn')?.addEventListener('click', () => {
  const source = String($('#aggregateReplySource')?.value || '').trim();
  aggregateSendMessage(source, '');
});
$('#aggregateReplySendBtn')?.addEventListener('click', () => {
  const translated = String($('#aggregateReplyTranslated')?.value || '').trim();
  const original = String($('#aggregateReplySource')?.value || '').trim();
  aggregateSendMessage(translated, original && translated !== original ? original : '');
});
$('#aggregateTranslateLatestBtn')?.addEventListener('click', () => aggregateTranslateLatestIncoming());
$('#aggregateReplySource')?.addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.ctrlKey) {
    event.preventDefault();
    aggregateTranslateDraft({ sendAfter: true });
  }
});
$('#aggregateReplyTranslated')?.addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.ctrlKey) {
    event.preventDefault();
    const translated = String(event.currentTarget.value || '').trim();
    const original = String($('#aggregateReplySource')?.value || '').trim();
    aggregateSendMessage(translated, original && translated !== original ? original : '');
  }
});

$('#lineModeBtn')?.addEventListener('click', async () => {
  if (shellSurface !== 'line') await enterLineWorkspace();
  await setWorkspaceMode('line');
});
$('#aggregateModeBtn')?.addEventListener('click', async () => {
  if (shellSurface !== 'line') await enterLineWorkspace();
  await setWorkspaceMode('aggregate');
});

// V1.27.86 official Meta + LINE native API inbox -------------------------
// The renderer only receives stable customer identities and message text from
// Team Server. Platform tokens/secrets never cross the VPS boundary.
let nativeApiInboxState = { items:[], errors:[], count:0 };
let nativeApiMasterEnabled = true;
let nativeApiRuntimeSettings = { activePollMs:2500, backgroundPollMs:5000, healthPollMs:30000 };
let nativeApiSelected = null;
let nativeApiChatScriptRequestId = '';
let nativeApiChatScriptJa = '';
let nativeApiChatScriptZh = '';
let nativeApiChatScriptCustomerKey = '';
let nativeApiMessages = [];
// V1.27.257 server-paged history. Desktop keeps the recent page and only asks
// VPS SQLite for older pages when the operator scrolls near the top.
const NATIVE_API_HISTORY_PAGE_SIZE = 100;
let nativeApiHistoryCursor = null;
let nativeApiHistoryHasMore = false;
let nativeApiHistoryLoading = false;
let nativeApiHistorySelectionKey = '';
function nativeApiMergeMessageRows(a=[],b=[]){
  const map=new Map();
  for(const row of [...(Array.isArray(a)?a:[]),...(Array.isArray(b)?b:[])]){
    const id=nativeApiMessageIdentity(row)||`${Number(row?.timestampMs||0)}|${String(row?.direction||row?.role||'')}|${String(row?.text||'')}`;
    if(!map.has(id))map.set(id,row);else map.set(id,{...map.get(id),...row});
  }
  return [...map.values()].sort((x,y)=>{const tx=Number(x?.timestampMs||0),ty=Number(y?.timestampMs||0);if(tx!==ty)return tx-ty;return String(x?.eventKey||x?.id||'').localeCompare(String(y?.eventKey||y?.id||''));});
}
async function loadOlderNativeApiMessages(){
  const box=$('#nativeApiMessages');const target=nativeApiSelected;const selectionKey=nativeApiKey(target||{});
  if(!box||!target||!selectionKey||nativeApiHistoryLoading||!nativeApiHistoryHasMore||!nativeApiHistoryCursor)return false;
  if(selectionKey!==nativeApiHistorySelectionKey)return false;
  nativeApiHistoryLoading=true;
  try{
    const result=await nativeApiAction('native-api-messages',{target,limit:NATIVE_API_HISTORY_PAGE_SIZE,cursor:nativeApiHistoryCursor});
    if(nativeApiKey(nativeApiSelected||{})!==selectionKey)return false;
    const older=Array.isArray(result?.items)?result.items:[];if(!older.length){nativeApiHistoryHasMore=false;nativeApiHistoryCursor=null;return false;}
    nativeApiMessages=nativeApiMergeMessageRows(older,nativeApiMessages);
    nativeApiHistoryHasMore=result?.hasMore===true;nativeApiHistoryCursor=result?.nextCursor||null;
    nativeApiApplyPersistentTranslations(result?.translations,selectionKey);nativeApiMessageVirtualRangeKey='';renderNativeApiMessages({keepBottom:false});scheduleNativeApiTranslations({preempt:false}).catch(()=>{});
    nativeApiSetStatus(`${target.displayName||'客户'} · 已加载 ${nativeApiMessages.length} 条历史${nativeApiHistoryHasMore?' · 向上继续加载':''}`);
    return true;
  }catch(error){nativeApiSetStatus('历史消息加载失败：'+(error?.message||error));return false;}
  finally{nativeApiHistoryLoading=false;}
}
// V1.27.254 customer-switch/IPC/render latency telemetry. Counters only; no
// customer text is recorded. Used by the existing performance diagnostics UI.
const NATIVE_API_LATENCY_V254_VERSION = 'v127254-customer-switch-ipc-render-latency';
const nativeApiV254Perf = {
  customerSwitch:{count:0,completed:0,staleCancelled:0,sameSelectionNoop:0,lastMs:0,maxMs:0,firstPaintLastMs:0,firstPaintMaxMs:0,recent:[]},
  ipc:{calls:0,invoked:0,joined:0,readCalls:0,writeCalls:0,inFlight:0,last:null},
  render:{customerFull:0,customerRowPatch:0,customerSelectionPatch:0,messageFull:0,chatHead:0,last:null}
};
const nativeApiIpcInFlight = new Map();
let nativeApiSelectionTask = null;
function nativeApiPerfNow(){try{return performance.now()}catch{return Date.now()}}
function nativeApiV254Snapshot(){return {version:NATIVE_API_LATENCY_V254_VERSION,customerSwitch:{...nativeApiV254Perf.customerSwitch,recent:(nativeApiV254Perf.customerSwitch.recent||[]).slice(-10)},ipc:{...nativeApiV254Perf.ipc,inFlight:nativeApiIpcInFlight.size},render:{...nativeApiV254Perf.render}};}
function nativeApiSelectionCurrent(epoch,key=''){return Number(epoch)===Number(nativeApiSelectEpoch)&&(!key||nativeApiKey(nativeApiSelected||{})===String(key));}
// V1.27.253 performance windowing: keep the DOM bounded while preserving the
// complete in-memory history. No image policy or periodic cleanup is added.
const NATIVE_API_MESSAGE_VIRTUAL_THRESHOLD = 120;
const NATIVE_API_MESSAGE_VIRTUAL_WINDOW = 96;
const NATIVE_API_MESSAGE_VIRTUAL_OVERSCAN = 24;
let nativeApiMessageVirtualRangeKey = '';
let nativeApiMessageVirtualSelectionKey = '';
let nativeApiMessageVirtualAverageHeight = 72;
const nativeApiMessageVirtualHeights = new Map();
let nativeApiMessageVirtualScrollRaf = 0;
// Render normal-size inboxes in full: mixed-height customer cards cause inaccurate
// virtual spacers and make the last customers unreachable when only ~100-500 exist.
// Keep virtualization for genuinely large inboxes.
const NATIVE_API_CUSTOMER_VIRTUAL_THRESHOLD = 1000;
const NATIVE_API_CUSTOMER_VIRTUAL_OVERSCAN = 10;
let nativeApiCustomerVirtualRowHeight = 66;
let nativeApiCustomerVirtualLastSelectionKey = '';
let nativeApiCustomerVirtualScrollRaf = 0;
let nativeApiInboxVisualSignature = '';
let nativeApiPlatformFilter = 'all';
let nativeApiFacebookPageFilter = 'all';
let nativeApiFacebookPages = [];
// V1.27.283: local inbox layouts only. Credentials remain in the existing
// server-side per-Page token pool; customer identity remains (pageId, peerId).
const NATIVE_API_INBOX_STORAGE_KEY='yoko.nativeApi.facebookInboxes.v1';
function nativeApiReadInboxLayout(){
  try{
    const obj=JSON.parse(localStorage.getItem(NATIVE_API_INBOX_STORAGE_KEY)||'null');
    if(obj&&Array.isArray(obj.inboxes))return {
      inboxes:[{id:'default',name:'默认收件箱'},...obj.inboxes.filter(x=>x&&/^[a-z0-9-]{1,80}$/i.test(x.id)&&x.id!=='default').map(x=>({id:x.id,name:String(x.name||'收件箱').slice(0,60)}))],
      assignments:obj.assignments&&typeof obj.assignments==='object'?obj.assignments:{},
      selected:typeof obj.selected==='string'?obj.selected:'all'
    };
  }catch{}
  return {inboxes:[{id:'default',name:'默认收件箱'}],assignments:{},selected:'all'};
}
let nativeApiInboxLayout=nativeApiReadInboxLayout();
let nativeApiInboxServerRevision=0;
let nativeApiInboxSyncReady=false;
let nativeApiInboxSyncFailure='';
let nativeApiInboxMutationQueue=Promise.resolve();
setInterval(()=>{if(nativeApiInboxSyncReady&&document.visibilityState==='visible')nativeApiLoadServerInboxes({quiet:true}).catch(()=>{});},60000);
function nativeApiWriteLocalInboxLayout(){try{localStorage.setItem(NATIVE_API_INBOX_STORAGE_KEY,JSON.stringify(nativeApiInboxLayout));}catch{}}
function nativeApiCleanServerLayout(obj){
  if(!obj||!Array.isArray(obj.inboxes))return {inboxes:[{id:'default',name:'默认收件箱'}],assignments:{},selected:'all'};
  const inboxes=[{id:'default',name:'默认收件箱'}],seen=new Set(['default']);
  for(const row of obj.inboxes){const id=String(row?.id||'');if(!/^[a-z0-9-]{1,80}$/i.test(id)||seen.has(id)||inboxes.length>=100)continue;seen.add(id);inboxes.push({id,name:String(row.name||'收件箱').slice(0,60)});}
  const assignments={};for(const [pageId,owner] of Object.entries(obj.assignments||{})){if(pageId.length<=180&&seen.has(String(owner)))assignments[pageId]=String(owner);}
  return {inboxes,assignments,selected:'all'};
}
async function nativeApiLoadServerInboxes({quiet=false}={}){
  try{
    const response=await nativeApiAction('native-api-inboxes-get');
    if(!response?.ok)throw new Error('服务器未返回有效收件箱配置');
    let server=nativeApiCleanServerLayout(response.layout||{});
    // One-time import for users upgrading from the local-only V1.27.283 layout.
    if(Number(response.version||0)===0 && nativeApiInboxLayout.inboxes.length>1){
      try{
        const migrated=await nativeApiAction('native-api-inboxes-put',{layout:nativeApiCleanServerLayout(nativeApiInboxLayout),expectedVersion:0});
        if(migrated?.ok){server=nativeApiCleanServerLayout(migrated.layout);response.version=migrated.version;}
      }catch(error){
        if(error?.status===409){return nativeApiLoadServerInboxes({quiet});}
        throw error;
      }
    }
    const localSelected=nativeApiInboxLayout.selected;
    nativeApiInboxLayout={...server,selected:localSelected==='all'||server.inboxes.some(x=>x.id===localSelected)?localSelected:'all'};
    nativeApiInboxServerRevision=Number(response.version||0);nativeApiInboxSyncReady=true;nativeApiInboxSyncFailure='';
    nativeApiWriteLocalInboxLayout();nativeApiRenderInboxSelector();nativeApiRenderInboxManagement();
    nativeApiCustomerRenderSignature='';renderNativeApiCustomers({force:true});
    return response;
  }catch(error){nativeApiInboxSyncReady=false;nativeApiInboxSyncFailure=String(error?.message||error);nativeApiRenderInboxSelector();if(!quiet)nativeApiSetStatus('收件箱服务器同步失败，已暂停分组修改：'+nativeApiInboxSyncFailure);nativeApiRenderInboxManagement();return null;}
}
function nativeApiSaveInboxLayout(){nativeApiWriteLocalInboxLayout();}
function nativeApiCommitInboxMutation(mutator){
 nativeApiInboxMutationQueue=nativeApiInboxMutationQueue.catch(()=>{}).then(async()=>{
   if(!nativeApiInboxSyncReady){nativeApiSetStatus('收件箱尚未与服务器同步，不能修改分组');return;}
   const original=nativeApiInboxLayout,expectedVersion=nativeApiInboxServerRevision;
   const draft=JSON.parse(JSON.stringify(original));
   if(mutator(draft)===false)return;
   const clean=nativeApiCleanServerLayout(draft);
   try{
     const result=await nativeApiAction('native-api-inboxes-put',{layout:clean,expectedVersion});
     if(!result?.ok)throw new Error('服务器拒绝保存收件箱');
     nativeApiInboxServerRevision=Number(result.version||expectedVersion+1);
     const selected=original.selected;
     nativeApiInboxLayout={...nativeApiCleanServerLayout(result.layout||clean),selected};
     nativeApiWriteLocalInboxLayout();nativeApiRenderInboxSelector();nativeApiRenderInboxManagement();
     nativeApiSwitchInbox(nativeApiInboxLayout.selected);
   }catch(error){nativeApiSetStatus('收件箱保存失败，正在重新同步：'+String(error?.message||error));await nativeApiLoadServerInboxes({quiet:true});}
 });return nativeApiInboxMutationQueue;
}
function nativeApiInboxOfPage(pageId){const owner=nativeApiInboxLayout.assignments[String(pageId||'')];return nativeApiInboxLayout.inboxes.some(i=>i.id===owner)?owner:'default';}
function nativeApiInboxAllows(item){
  if(nativeApiInboxLayout.selected==='all')return true;
  return String(item?.platform||'').toLowerCase()==='facebook'&&nativeApiInboxOfPage(item.pageId)===nativeApiInboxLayout.selected;
}
function nativeApiInboxScopedItems(){return (nativeApiInboxState.items||[]).filter(nativeApiInboxAllows);}
function nativeApiRenderInboxSelector(){
 const select=$('#nativeApiInboxSelector');if(!select)return;
 const selected=nativeApiInboxLayout.selected;
 select.disabled=false; // local selection works while VPS grouping sync is offline
 select.innerHTML='<option value="all">全部收件箱（汇总）</option>'+nativeApiInboxLayout.inboxes.map(x=>`<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('');
 if(selected!=='all'&&!nativeApiInboxLayout.inboxes.some(x=>x.id===selected))nativeApiInboxLayout.selected='all';
 select.value=nativeApiInboxLayout.selected;
 const count=$('#nativeApiInboxScopeCount');if(count)count.textContent=`${nativeApiInboxScopedItems().filter(x=>!nativeApiIsHidden(x)).length} 位客户`;
}
function nativeApiRenderInboxManagement(){
 const holder=$('#nativeApiInboxManager');if(!holder)return;const createBtn=$('#nativeApiInboxCreateBtn');if(createBtn)createBtn.disabled=!nativeApiInboxSyncReady;
 const pages=Array.isArray(nativeApiFacebookPages)?nativeApiFacebookPages:[];
 holder.innerHTML=(nativeApiInboxSyncReady?'':'<div class="native-api-inbox-warning">服务器分组未同步，禁止修改。请检查 VPS 更新及网络连接。</div>')+nativeApiInboxLayout.inboxes.map(x=>{
 const assigned=pages.filter(p=>nativeApiInboxOfPage(p.pageId)===x.id);
 return `<div class="native-api-inbox-manager-item"><strong>${escapeHtml(x.name)}</strong><small>${assigned.length} 个 Facebook Page</small><button type="button" data-inbox-rename="${escapeHtml(x.id)}">重命名</button>${x.id==='default'?'':`<button type="button" data-inbox-delete="${escapeHtml(x.id)}">删除空收件箱</button>`}<div>${assigned.map(p=>`<span>${escapeHtml(p.name||p.pageId)}</span>`).join(' · ')||'暂无账号'}</div></div>`;
 }).join('')+'<div class="native-api-inbox-assign-list">'+pages.map(p=>`<label><span>${escapeHtml(p.name||p.pageId)}</span><select data-inbox-page="${escapeHtml(p.pageId)}">${nativeApiInboxLayout.inboxes.map(x=>`<option value="${escapeHtml(x.id)}" ${nativeApiInboxOfPage(p.pageId)===x.id?'selected':''}>${escapeHtml(x.name)}</option>`).join('')}</select></label>`).join('')+'</div>';
}
function nativeApiSwitchInbox(next){
 if(next!=='all'&&!nativeApiInboxLayout.inboxes.some(x=>x.id===next))return;
 nativeApiInboxLayout.selected=next;nativeApiSaveInboxLayout();nativeApiRenderInboxSelector();
 nativeApiFacebookPageFilter='all';nativeApiRenderFacebookPageFilter();
 if(nativeApiSelected&&!nativeApiInboxAllows(nativeApiSelected)){
   nativeApiSelected=null;nativeApiMessages=[];nativeApiSelectEpoch++;clearNativeApiCrm();renderNativeApiChatHead();renderNativeApiMessages();
 }
 nativeApiCustomerRenderSignature='';nativeApiCustomerBaseSignature='';renderNativeApiCustomers({force:true});
}

let nativeApiStageGroupFilter = '';
let nativeApiDayFilter = 0;
let nativeApiSearchText = '';
let nativeApiWaitingOnly = false;
// V1.27.199 multi-channel bulk-send state. One selected software owns one customer list.
let nativeApiBulkSelectedKeys = new Set();
let nativeApiBulkSearchText = '';
let nativeApiBulkPlatformFilter = 'line';
let nativeApiBulkFacebookAccountFilter = 'all';
let nativeApiBulkStageGroupFilter = '';
let nativeApiBulkLineGroupFilter = 'all';
let nativeApiBulkCustomerItems = [];
let nativeApiBulkRuntimeState = null;
let nativeApiBulkPollTimer = null;
let nativeApiRefreshBusy = false;
let nativeApiSelectEpoch = 0;
let nativeApiRefreshEpoch = 0;
let nativeApiRefreshTimer = null;
let nativeApiHealthTimer = null;
let nativeApiRealtimePushTimer = null;
let nativeApiLastHydrateAt = 0;
let nativeApiCustomerRenderSignature = '';
let nativeApiCustomerBaseSignature = '';
let nativeApiChatAvatarSignature = '';
let nativeApiTranslationGeneration = 0;
let nativeApiTranslationScheduler = null;
let nativeApiTranslationSchedulerKey = '';
let nativeApiTranslationReschedule = false;
let nativeApiTranslationScrollTimer = null;
let nativeApiTranslationRenderScheduled = false;
let nativeApiTranslationPriorityEpoch = 0;
// V1.27.132: reserve one dedicated first-paint lane for the newest customer
// message. Backlog/history translation must never make a fresh inbound bubble
// wait for the existing scheduler to drain.
let nativeApiTranslationFirstPaintPromise = null;
let nativeApiTranslationFirstPaintReschedule = false;
let nativeApiTranslationFirstPaintRequestedAt = 0;
let nativeApiTranslationFirstPaintReason = '';
const nativeApiTranslationFirstPaintStats = {
  version:'v127132-native-api-deepl-first-paint-fast-lane',
  cacheFirstVersion:'v127134-pretranslation-cache-first-display-lock',
  queueBreakerVersion:'v127185-first-paint-direct-cache-aware-gateway',
  requestedCount:0,startedCount:0,successCount:0,errorCount:0,
  pretranslatedHitCount:0,clientFallbackCount:0,directGatewayCount:0,
  skippedRedundantCacheProbeCount:0,
  lastQueueWaitMs:0,lastElapsedMs:0,maxElapsedMs:0,lastCacheProbeMs:0,maxCacheProbeMs:0,
  lastProviderMs:0,maxProviderMs:0,lastReason:'',
  lastMessageId:'',lastAt:0
};
let nativeApiProfileHydrationPromise = null;
let nativeApiProfileHydrationNextSweepAt = 0;
const NATIVE_API_PROFILE_SWEEP_MS = 10 * 60 * 1000;
const NATIVE_API_PROFILE_TARGET_RETRY_MS = 6 * 60 * 60 * 1000;
const nativeApiProfileHydrationAttemptedAt = new Map();
// V1.27.253: renderer translation state is LRU-bounded on insertion. This is
// intentionally not a timer/sweep; active/recent rows stay hot automatically.
const NATIVE_API_TRANSLATION_LRU_MAX = 1000;
const NATIVE_API_TRANSLATION_LRU_RETAIN = 800;
class NativeApiTranslationLruMap extends Map {
  get(key){if(!super.has(key))return undefined;const value=super.get(key);super.delete(key);super.set(key,value);return value;}
  set(key,value){if(super.has(key))super.delete(key);super.set(key,value);if(this.size>NATIVE_API_TRANSLATION_LRU_MAX){let drop=this.size-NATIVE_API_TRANSLATION_LRU_RETAIN;for(const oldest of this.keys()){super.delete(oldest);if(--drop<=0)break;}}return this;}
}
const nativeApiTranslationCache = new NativeApiTranslationLruMap();
const nativeApiTranslationBusy = new Set();

const NATIVE_API_UNREAD_STORAGE_KEY = 'yoko.nativeApi.unread.v12797';
const NATIVE_API_NOTIFICATION_STORAGE_KEY = 'yoko.nativeApi.notifications.enabled';
const NATIVE_API_HIDDEN_STORAGE_KEY = 'yoko.nativeApi.hidden.v12798';
const NATIVE_API_MANUAL_READ_STORAGE_KEY = 'yoko.nativeApi.manualRead.v127100';
const NATIVE_API_DRAFT_STORAGE_KEY = 'yoko.nativeApi.drafts.v127103';
const NATIVE_API_FIRST_INCOMING_STORAGE_KEY = 'yoko.nativeApi.firstIncoming.v127197';
const NATIVE_API_DRAFT_LIMIT = 200;
const nativeApiFirstIncomingByKey = new Map();
const nativeApiFirstIncomingBusy = new Set();
const nativeApiFirstIncomingUnresolvedAt = new Map();
let nativeApiDayResolutionPromise = null;
let nativeApiFirstIncomingPersistTimer = null;
let nativeApiNotificationBaselineReady = false;
let nativeApiGlobalMonitorTimer = null;
let nativeApiNotificationAudioContext = null;
const nativeApiUnreadByKey = new Map();
const nativeApiHiddenByKey = new Map();
const nativeApiManualReadByKey = new Map();
const nativeApiDraftByKey = new Map();
let nativeApiDraftPersistTimer = null;

function nativeApiTodayBounds(now=Date.now()) {
  const d=new Date(Number(now)||Date.now());
  const start=new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();
  return {start,end:new Date(d.getFullYear(),d.getMonth(),d.getDate()+1).getTime()};
}
function nativeApiLoadFirstIncomingState() {
  nativeApiFirstIncomingByKey.clear();
  try {
    const raw=JSON.parse(localStorage.getItem(NATIVE_API_FIRST_INCOMING_STORAGE_KEY)||'{}');
    for(const [key,value] of Object.entries(raw||{})){
      const firstIncomingAt=Number(value?.firstIncomingAt||0)||0;
      if(!firstIncomingAt)continue;
      nativeApiFirstIncomingByKey.set(String(key),{firstIncomingAt,exact:value?.exact!==false,checkedAt:Number(value?.checkedAt||0)||0});
    }
  } catch {}
}
function nativeApiPersistFirstIncomingState() {
  if(nativeApiFirstIncomingPersistTimer){clearTimeout(nativeApiFirstIncomingPersistTimer);nativeApiFirstIncomingPersistTimer=null;}
  try {
    const rows=Array.from(nativeApiFirstIncomingByKey.entries())
      .filter(([,value])=>Number(value?.firstIncomingAt||0)>0&&value?.exact!==false)
      .sort((a,b)=>Number(b[1]?.checkedAt||0)-Number(a[1]?.checkedAt||0))
      .slice(0,2000);
    const out={};
    for(const [key,value] of rows)out[key]={firstIncomingAt:Number(value.firstIncomingAt||0),exact:true,checkedAt:Number(value.checkedAt||0)||Date.now()};
    localStorage.setItem(NATIVE_API_FIRST_INCOMING_STORAGE_KEY,JSON.stringify(out));
  } catch {}
}
function nativeApiScheduleFirstIncomingPersist() {
  if(nativeApiFirstIncomingPersistTimer)clearTimeout(nativeApiFirstIncomingPersistTimer);
  nativeApiFirstIncomingPersistTimer=setTimeout(()=>nativeApiPersistFirstIncomingState(),180);
}
function nativeApiCacheFirstIncoming(item={},firstIncomingAt=0,{exact=true}={}) {
  const key=nativeApiKey(item),value=Number(firstIncomingAt||0)||0;
  if(!key||!value||exact===false)return false;
  const prev=nativeApiFirstIncomingByKey.get(key);
  if(prev?.exact!==false&&Number(prev?.firstIncomingAt||0)===value)return false;
  nativeApiFirstIncomingByKey.set(key,{firstIncomingAt:value,exact:true,checkedAt:Date.now()});
  nativeApiScheduleFirstIncomingPersist();
  return true;
}
function nativeApiFirstIncomingAt(item={}) {
  const direct=Number(item?.firstIncomingAt||0)||0;if(direct>0)return direct;
  return Number(nativeApiFirstIncomingByKey.get(nativeApiKey(item))?.firstIncomingAt||0)||0;
}
function nativeApiCustomerDayCalibration(item={}){return customerDayCalibrationEffective(item,'native');}
function nativeApiTodayNewStats(items=nativeApiInboxState.items||[]) {
  const {start,end}=nativeApiTodayBounds();
  let count=0,pending=0;
  for(const item of Array.isArray(items)?items:[]){
    if(nativeApiIsHidden(item))continue;
    const first=nativeApiFirstIncomingAt(item);
    if(first>=start&&first<end){count++;continue;}
    const incoming=Number(item?.lastIncomingAt||0)||0;
    if(!first&&incoming>=start&&incoming<end&&!item?.historyOnly)pending++;
  }
  return {count,pending,start,end};
}
function nativeApiRenderTodayNewStat() {
  const box=$('#nativeApiTodayNewStat'),node=$('#nativeApiTodayNewCount');if(!box||!node)return;
  const stats=nativeApiTodayNewStats();node.textContent=String(stats.count);
  box.classList.toggle('pending',stats.pending>0);
  box.title=stats.pending>0
    ? `今日新进 ${stats.count} 位；另有 ${stats.pending} 位今天来信客户正在核对是否为历史首次私信`
    : `今日新进 ${stats.count} 位：今天第一次给我们发私信，且历史记录中没有更早私信的客户`;
}
async function nativeApiResolveFirstIncomingFor(item={}) {
  const key=nativeApiKey(item);if(!key||nativeApiFirstIncomingAt(item)||nativeApiFirstIncomingBusy.has(key)||item?.historyOnly)return false;
  const {start,end}=nativeApiTodayBounds();const incoming=Number(item?.lastIncomingAt||0)||0;
  if(incoming<start||incoming>=end)return false;
  nativeApiFirstIncomingBusy.add(key);
  try {
    const result=await nativeApiAction('native-api-first-incoming',{target:item,limit:500});
    if(result?.exact===true&&Number(result?.firstIncomingAt||0)>0){
      const changed=nativeApiCacheFirstIncoming(item,Number(result.firstIncomingAt),{exact:true});
      if(changed){nativeApiCustomerRenderSignature='';nativeApiRenderTodayNewStat();}
      return changed;
    }
    return false;
  } catch { return false; }
  finally { nativeApiFirstIncomingBusy.delete(key);nativeApiRenderTodayNewStat(); }
}
function nativeApiScheduleTodayNewResolution(items=nativeApiInboxState.items||[]) {
  const {start,end}=nativeApiTodayBounds();
  const candidates=(Array.isArray(items)?items:[])
    .filter(item=>!nativeApiIsHidden(item)&&!item?.historyOnly&&!nativeApiFirstIncomingAt(item)&&Number(item?.lastIncomingAt||0)>=start&&Number(item?.lastIncomingAt||0)<end&&!nativeApiFirstIncomingBusy.has(nativeApiKey(item)))
    .slice(0,12);
  if(!candidates.length){nativeApiRenderTodayNewStat();return;}
  // Bounded concurrency: enough for a quick dashboard count without turning the
  // 1.8s inbox refresh into a history-download storm.
  const workers=Math.min(2,candidates.length);let cursor=0;
  for(let i=0;i<workers;i++)(async()=>{while(cursor<candidates.length){const item=candidates[cursor++];await nativeApiResolveFirstIncomingFor(item);}})().catch(()=>{});
  nativeApiRenderTodayNewStat();
}

function nativeApiLoadDraftState() {
  nativeApiDraftByKey.clear();
  try {
    const raw=JSON.parse(localStorage.getItem(NATIVE_API_DRAFT_STORAGE_KEY)||'{}');
    for(const [key,value] of Object.entries(raw||{})){
      const text=String(value?.text||'').slice(0,12000);
      if(!text)continue;
      nativeApiDraftByKey.set(String(key),{text,updatedAt:Number(value?.updatedAt||0)||0});
    }
  } catch {}
}
function nativeApiPersistDraftState() {
  if(nativeApiDraftPersistTimer){clearTimeout(nativeApiDraftPersistTimer);nativeApiDraftPersistTimer=null;}
  try {
    const rows=Array.from(nativeApiDraftByKey.entries())
      .filter(([,value])=>String(value?.text||''))
      .sort((a,b)=>Number(b[1]?.updatedAt||0)-Number(a[1]?.updatedAt||0))
      .slice(0,NATIVE_API_DRAFT_LIMIT);
    nativeApiDraftByKey.clear();
    const out={};
    for(const [key,value] of rows){
      const normalized={text:String(value?.text||'').slice(0,12000),updatedAt:Number(value?.updatedAt||0)||Date.now()};
      nativeApiDraftByKey.set(key,normalized);out[key]=normalized;
    }
    localStorage.setItem(NATIVE_API_DRAFT_STORAGE_KEY,JSON.stringify(out));
  } catch {}
}
function nativeApiScheduleDraftPersist(delay=250) {
  if(nativeApiDraftPersistTimer)clearTimeout(nativeApiDraftPersistTimer);
  nativeApiDraftPersistTimer=setTimeout(()=>nativeApiPersistDraftState(),Math.max(80,Number(delay||250)));
}
function nativeApiDraftKey(item=nativeApiSelected) { return item?nativeApiKey(item):''; }
function nativeApiDraftText(item=nativeApiSelected) { const key=nativeApiDraftKey(item);return key?String(nativeApiDraftByKey.get(key)?.text||''):''; }
function nativeApiHasDraft(item={}) { return !!nativeApiDraftText(item); }
function nativeApiSetDraft(item,text,{persist=true}={}) {
  const key=nativeApiDraftKey(item);if(!key)return false;
  const hadDraft=!!String(nativeApiDraftByKey.get(key)?.text||'');
  const value=String(text||'').slice(0,12000);
  if(value)nativeApiDraftByKey.set(key,{text:value,updatedAt:Date.now()});
  else nativeApiDraftByKey.delete(key);
  const hasDraft=!!value;
  if(hadDraft!==hasDraft)nativeApiCustomerRenderSignature='';
  if(persist)nativeApiPersistDraftState();else nativeApiScheduleDraftPersist();
  return hadDraft!==hasDraft;
}
function nativeApiSaveCurrentDraft() {
  if(!nativeApiSelected)return false;
  const composer=$('#nativeApiComposer');
  return nativeApiSetDraft(nativeApiSelected,String(composer?.value||''));
}
function nativeApiRestoreDraft(item=nativeApiSelected,{focus=false}={}) {
  const composer=$('#nativeApiComposer');if(!composer||!item)return '';
  const text=nativeApiDraftText(item);composer.value=text;
  if(focus)setTimeout(()=>composer.focus({preventScroll:true}),0);
  return text;
}
function nativeApiClearDraft(item=nativeApiSelected) { return item?nativeApiSetDraft(item,''):false; }

function nativeApiLoadManualReadState() {
  nativeApiManualReadByKey.clear();
  try {
    const raw=JSON.parse(localStorage.getItem(NATIVE_API_MANUAL_READ_STORAGE_KEY)||'{}');
    for(const [key,value] of Object.entries(raw||{})){
      nativeApiManualReadByKey.set(String(key),{
        lastEventKey:String(value?.lastEventKey||''),
        lastIncomingAt:Number(value?.lastIncomingAt||0)||0,
        lastTimestampMs:Number(value?.lastTimestampMs||0)||0,
        markedAt:Number(value?.markedAt||0)||0
      });
    }
  } catch {}
}
function nativeApiPersistManualReadState() {
  try {
    const out={};
    for(const [key,value] of nativeApiManualReadByKey.entries()){
      out[key]={
        lastEventKey:String(value?.lastEventKey||''),
        lastIncomingAt:Number(value?.lastIncomingAt||0)||0,
        lastTimestampMs:Number(value?.lastTimestampMs||0)||0,
        markedAt:Number(value?.markedAt||0)||0
      };
    }
    localStorage.setItem(NATIVE_API_MANUAL_READ_STORAGE_KEY,JSON.stringify(out));
  } catch {}
}
function nativeApiManualReadActive(item={}) {
  const key=nativeApiKey(item), marker=nativeApiManualReadByKey.get(key);if(!marker)return false;
  const incoming=Number(item.lastIncomingAt||0)||0;
  const timestamp=Number(item.lastTimestampMs||0)||0;
  const eventKey=String(item.lastEventKey||'');
  const newerIncoming=incoming>Number(marker.lastIncomingAt||0);
  const newerIncomingEvent=!!eventKey&&!!marker.lastEventKey&&eventKey!==String(marker.lastEventKey||'')&&nativeApiIncomingState(item)&&timestamp>Number(marker.lastTimestampMs||0);
  if(newerIncoming||newerIncomingEvent){
    nativeApiManualReadByKey.delete(key);nativeApiPersistManualReadState();nativeApiCustomerRenderSignature='';return false;
  }
  return true;
}
function nativeApiAwaitingReply(item={}) {
  return nativeApiIncomingState(item)&&!nativeApiManualReadActive(item);
}
function nativeApiMarkManualRead(item={}) {
  if(!item||!nativeApiIncomingState(item))return false;
  const key=nativeApiKey(item);if(!key)return false;
  nativeApiManualReadByKey.set(key,{
    lastEventKey:String(item.lastEventKey||''),
    lastIncomingAt:Number(item.lastIncomingAt||0)||0,
    lastTimestampMs:Number(item.lastTimestampMs||0)||0,
    markedAt:Date.now()
  });
  nativeApiPersistManualReadState();nativeApiMarkRead(item);nativeApiCustomerRenderSignature='';return true;
}

function nativeApiLoadHiddenState() {
  nativeApiHiddenByKey.clear();
  try {
    const raw=JSON.parse(localStorage.getItem(NATIVE_API_HIDDEN_STORAGE_KEY)||'{}');
    for(const [key,value] of Object.entries(raw||{})){
      nativeApiHiddenByKey.set(String(key),{
        lastEventKey:String(value?.lastEventKey||''),
        lastTimestampMs:Number(value?.lastTimestampMs||0)||0,
        deletedAt:Number(value?.deletedAt||0)||0
      });
    }
  } catch {}
}
function nativeApiPersistHiddenState() {
  try {
    const out={};
    for(const [key,value] of nativeApiHiddenByKey.entries()){
      out[key]={lastEventKey:String(value?.lastEventKey||''),lastTimestampMs:Number(value?.lastTimestampMs||0)||0,deletedAt:Number(value?.deletedAt||0)||0};
    }
    localStorage.setItem(NATIVE_API_HIDDEN_STORAGE_KEY,JSON.stringify(out));
  } catch {}
}
function nativeApiIsHidden(item={}) { return nativeApiHiddenByKey.has(nativeApiKey(item)); }
function nativeApiRestoreHiddenIfNewIncoming(previous=[],nextItems=[]) {
  if(!nativeApiHiddenByKey.size)return;
  const prevMap=new Map((Array.isArray(previous)?previous:[]).map(item=>[nativeApiKey(item),item]));
  let changed=false;
  for(const item of Array.isArray(nextItems)?nextItems:[]){
    const key=nativeApiKey(item), hidden=nativeApiHiddenByKey.get(key);if(!hidden||!nativeApiIncomingState(item))continue;
    const prev=prevMap.get(key);
    const currentTs=Number(item.lastIncomingAt||item.lastTimestampMs||0)||0;
    const previousTs=Number(prev?.lastIncomingAt||prev?.lastTimestampMs||0)||Number(hidden.lastTimestampMs||0)||0;
    const currentEvent=String(item.lastEventKey||'');
    const eventChanged=!!currentEvent&&currentEvent!==String(hidden.lastEventKey||'');
    if(currentTs>Math.max(Number(hidden.lastTimestampMs||0),previousTs)||(eventChanged&&currentTs>=Number(hidden.lastTimestampMs||0))){
      nativeApiHiddenByKey.delete(key);changed=true;
    }
  }
  if(changed){nativeApiPersistHiddenState();nativeApiCustomerRenderSignature='';}
}
function nativeApiHideCustomer(item={}) {
  const key=nativeApiKey(item);if(!key)return false;
  nativeApiHiddenByKey.set(key,{
    lastEventKey:String(item.lastEventKey||''),
    lastTimestampMs:Number(item.lastIncomingAt||item.lastTimestampMs||0)||0,
    deletedAt:Date.now()
  });
  nativeApiPersistHiddenState();
  nativeApiClearDraft(item);
  nativeApiMarkRead(key);
  if(nativeApiSameCustomer(item,nativeApiSelected)){
    nativeApiTranslationGeneration++;
    nativeApiSelected=null;nativeApiMessages=[];clearNativeApiCrm();renderNativeApiChatHead();renderNativeApiMessages();
  }
  nativeApiCustomerRenderSignature='';renderNativeApiCustomers({force:true});nativeApiRenderNotificationState();
  return true;
}
function closeNativeApiCustomerContextMenu(){document.querySelectorAll('.native-api-customer-context-menu').forEach(node=>node.remove());}
function showNativeApiCustomerContextMenu(event,item={}){
  event.preventDefault();event.stopPropagation();closeNativeApiCustomerContextMenu();
  const name=String(item.displayName||'客户');const source=nativeApiPlatformLabel(item.platform);
  const menu=document.createElement('div');menu.className='native-api-customer-context-menu';menu.setAttribute('role','menu');
  menu.innerHTML=`<button type="button" class="mark-read" role="menuitem">标记已读</button><button type="button" class="danger" role="menuitem">删除客户</button><div class="native-api-customer-context-hint">标记已读 = 从 Yoko 待回复队列移除；删除客户只从 Yoko 官方 API 收件箱隐藏，不删除 ${escapeHtml(source)} 原平台聊天。</div>`;
  document.body.appendChild(menu);
  const margin=8,rect=menu.getBoundingClientRect();menu.style.left=`${Math.max(margin,Math.min(event.clientX,window.innerWidth-rect.width-margin))}px`;menu.style.top=`${Math.max(margin,Math.min(event.clientY,window.innerHeight-rect.height-margin))}px`;
  menu.querySelector('button.mark-read')?.addEventListener('click',()=>{
    const marked=nativeApiMarkManualRead(item);closeNativeApiCustomerContextMenu();
    if(!marked){nativeApiSetStatus(`无法标记已读：${name} 当前没有待回复客户消息`);return;}
    renderNativeApiCustomers({force:true});renderNativeApiChatHead();nativeApiRenderNotificationState();
    nativeApiSetStatus(`已标记已读：${name} · 已从待回复列表移除`);
  });
  menu.querySelector('button.danger')?.addEventListener('click',()=>{
    const ok=window.confirm(`确定从 Yoko 收件箱删除「${name}」吗？\n\n不会删除 ${source} 原平台聊天；如果客户之后再次发来新消息，会重新出现在收件箱。`);if(!ok)return;
    nativeApiHideCustomer(item);closeNativeApiCustomerContextMenu();nativeApiSetStatus(`已从收件箱删除：${name}`);
  });
  setTimeout(()=>{document.addEventListener('pointerdown',ev=>{if(!menu.contains(ev.target))closeNativeApiCustomerContextMenu();},{once:true,capture:true});},0);
}

function nativeApiLoadUnreadState() {
  nativeApiUnreadByKey.clear();
  try {
    const raw=JSON.parse(localStorage.getItem(NATIVE_API_UNREAD_STORAGE_KEY)||'{}');
    for(const [key,value] of Object.entries(raw||{})){
      const count=Math.max(0,Math.min(999,Number(value?.count||0)||0));
      if(!count)continue;
      nativeApiUnreadByKey.set(String(key),{count,lastEventKey:String(value?.lastEventKey||''),lastTimestampMs:Number(value?.lastTimestampMs||0)||0});
    }
  } catch {}
}
function nativeApiPersistUnreadState() {
  try {
    const out={};
    for(const [key,value] of nativeApiUnreadByKey.entries()){
      if(Number(value?.count||0)>0)out[key]={count:Number(value.count)||0,lastEventKey:String(value.lastEventKey||''),lastTimestampMs:Number(value.lastTimestampMs||0)||0};
    }
    localStorage.setItem(NATIVE_API_UNREAD_STORAGE_KEY,JSON.stringify(out));
  } catch {}
}
function nativeApiUnreadCountFor(item={}) { return Math.max(0,Number(nativeApiUnreadByKey.get(nativeApiKey(item))?.count||0)||0); }
function nativeApiTotalUnread() { let total=0;for(const value of nativeApiUnreadByKey.values())total+=Math.max(0,Number(value?.count||0)||0);return total; }
function nativeApiNotificationsEnabled() { try{return localStorage.getItem(NATIVE_API_NOTIFICATION_STORAGE_KEY)!=='0';}catch{return true;} }
function nativeApiSetNotificationsEnabled(enabled) { try{localStorage.setItem(NATIVE_API_NOTIFICATION_STORAGE_KEY,enabled?'1':'0');}catch{} nativeApiRenderNotificationState(); }
function nativeApiRenderNotificationState() {
  const enabled=nativeApiNotificationsEnabled();const button=$('#nativeApiNotificationBtn');
  if(button){button.textContent=enabled?'通知：开':'通知：关';button.classList.toggle('active',enabled);button.classList.toggle('muted',!enabled);button.setAttribute('aria-pressed',enabled?'true':'false');}
  const total=nativeApiTotalUnread();const badge=$('#nativeApiRailUnreadBadge');
  if(badge){badge.textContent=total>99?'99+':String(total);badge.classList.toggle('hidden',total<=0);badge.setAttribute('aria-label',`官方 API 未读 ${total} 条`);}
  const count=$('#nativeApiCustomerCount');if(count){const all=(Array.isArray(nativeApiInboxState.items)?nativeApiInboxState.items:[]).filter(item=>!nativeApiIsHidden(item)).length;count.textContent=total?`${all} 位 · 未读 ${total}`:`${all} 位`;}
}
function nativeApiMarkRead(itemOrKey) {
  const key=typeof itemOrKey==='string'?itemOrKey:nativeApiKey(itemOrKey||{});if(!key)return;
  if(nativeApiUnreadByKey.delete(key)){nativeApiPersistUnreadState();nativeApiCustomerRenderSignature='';renderNativeApiCustomers({force:true});nativeApiRenderNotificationState();}
}
function nativeApiClearAllUnread() {
  if(!nativeApiUnreadByKey.size)return;nativeApiUnreadByKey.clear();nativeApiPersistUnreadState();nativeApiCustomerRenderSignature='';renderNativeApiCustomers({force:true});nativeApiRenderNotificationState();
}
function nativeApiIncomingState(item={}) {
  const direction=String(item.lastDirection||'').toLowerCase();
  const lastIncoming=Number(item.lastIncomingAt||0)||0,lastReply=Number(item.lastReplyAt||0)||0;
  return item.awaitingReply===true || ((direction==='incoming'||direction==='customer') && lastIncoming>=lastReply);
}
function nativeApiEnsureNotificationAudio() {
  try {
    const Ctx=window.AudioContext||window.webkitAudioContext;if(!Ctx)return null;
    if(!nativeApiNotificationAudioContext)nativeApiNotificationAudioContext=new Ctx();
    if(nativeApiNotificationAudioContext.state==='suspended')nativeApiNotificationAudioContext.resume().catch(()=>{});
    return nativeApiNotificationAudioContext;
  } catch { return null; }
}
function nativeApiPlayNotificationSound() {
  if(!nativeApiNotificationsEnabled())return;const ctx=nativeApiEnsureNotificationAudio();if(!ctx||ctx.state!=='running')return;
  try {
    const now=ctx.currentTime, gain=ctx.createGain(), osc=ctx.createOscillator();
    osc.type='sine';osc.frequency.setValueAtTime(740,now);osc.frequency.exponentialRampToValueAtTime(940,now+.12);
    gain.gain.setValueAtTime(.0001,now);gain.gain.exponentialRampToValueAtTime(.11,now+.015);gain.gain.exponentialRampToValueAtTime(.0001,now+.18);
    osc.connect(gain);gain.connect(ctx.destination);osc.start(now);osc.stop(now+.19);
  } catch {}
}
async function nativeApiEnsureDesktopNotificationPermission() {
  try {
    if(!('Notification' in window))return false;
    if(Notification.permission==='granted')return true;
    if(Notification.permission==='denied')return false;
    const permission=await Notification.requestPermission();return permission==='granted';
  } catch { return false; }
}
function nativeApiShowDesktopNotification(item={}) {
  if(!nativeApiInboxAllowsNotification(item))return;
  if(!nativeApiNotificationsEnabled()||!('Notification' in window)||Notification.permission!=='granted')return;
  const name=String(item.displayName||'客户');const preview=String(item.preview||'收到一条新消息').trim().slice(0,180);const platform=nativeApiPlatformLabel(item.platform);
  try {
    const n=new Notification(`YokoSCRM · ${name}`,{body:`${platform}：${preview}`,silent:true,tag:`yoko-native-api-${nativeApiKey(item)}`,renotify:true});
    n.onclick=()=>{try{window.focus();}catch{};enterNativeApiWorkspace().then(()=>{const latest=(nativeApiInboxState.items||[]).find(row=>nativeApiSameCustomer(row,item))||item;if(!nativeApiInboxAllows(latest))nativeApiSwitchInbox('all');selectNativeApiCustomer(latest).catch(()=>{});}).catch(()=>{});try{n.close();}catch{}};
    setTimeout(()=>{try{n.close();}catch{}},10000);
  } catch {}
}
// V1.27.287: inboxes are a VIEW FILTER only; notifications remain global.
function nativeApiInboxAllowsNotification(item={}) { return true; }
function nativeApiRegisterUnread(item={}, {delta=1,notify=false}={}) {
  const key=nativeApiKey(item);if(!key)return;
  const activeVisible=shellSurface==='native-api'&&nativeApiInboxAllows(item)&&nativeApiSameCustomer(item,nativeApiSelected)&&document.hasFocus();
  if(activeVisible){nativeApiMarkRead(key);return;}
  const eventKey=String(item.lastEventKey||'');const ts=Number(item.lastIncomingAt||item.lastTimestampMs||0)||0;const old=nativeApiUnreadByKey.get(key)||{count:0,lastEventKey:'',lastTimestampMs:0};
  if((eventKey&&old.lastEventKey===eventKey)||(!eventKey&&ts&&Number(old.lastTimestampMs||0)>=ts))return;
  nativeApiUnreadByKey.set(key,{count:Math.min(999,Math.max(1,Number(old.count||0)+(Math.max(1,Number(delta||1)||1)))),lastEventKey:eventKey,lastTimestampMs:ts});
  nativeApiPersistUnreadState();nativeApiCustomerRenderSignature='';nativeApiRenderNotificationState();
  if(notify&&nativeApiInboxAllowsNotification(item)){nativeApiPlayNotificationSound();nativeApiShowDesktopNotification(item);}
}
function nativeApiProcessIncomingChanges(previous=[],nextItems=[]) {
  if(!nativeApiNotificationBaselineReady){nativeApiNotificationBaselineReady=true;nativeApiRenderNotificationState();return;}
  const prevMap=new Map((Array.isArray(previous)?previous:[]).map(item=>[nativeApiKey(item),item]));const now=Date.now();
  for(const item of Array.isArray(nextItems)?nextItems:[]){
    if(!nativeApiIncomingState(item))continue;const prev=prevMap.get(nativeApiKey(item));const incomingAt=Number(item.lastIncomingAt||item.lastTimestampMs||0)||0;
    let advanced=false,delta=1;
    if(prev){
      advanced=incomingAt>Number(prev.lastIncomingAt||0)||(
        String(item.lastEventKey||'')&&String(item.lastEventKey||'')!==String(prev.lastEventKey||'')&&Number(item.lastTimestampMs||0)>Number(prev.lastTimestampMs||0)
      );
      delta=Math.max(1,Math.min(20,(Number(item.messageCount||0)||0)-(Number(prev.messageCount||0)||0)||1));
    }else advanced=!!incomingAt&&now-incomingAt<=120000;
    if(!advanced)continue;
    const age=incomingAt?Math.max(0,now-incomingAt):0;const freshEnoughForAlert=!incomingAt||age<=120000;
    nativeApiRegisterUnread(item,{delta,notify:freshEnoughForAlert});
  }
}
function startNativeApiGlobalNotificationMonitor() {
  if(nativeApiGlobalMonitorTimer)clearInterval(nativeApiGlobalMonitorTimer);
  const interval=Math.max(5000,Number(nativeApiRuntimeSettings.backgroundPollMs||5000));
  nativeApiGlobalMonitorTimer=setInterval(()=>{if(document.hidden||!nativeApiMasterEnabled)return;if(shellSurface!=='native-api')refreshNativeApiInbox({quiet:true,hydrate:false}).catch(()=>{});},interval);
  setTimeout(()=>{if(nativeApiMasterEnabled&&shellSurface!=='native-api')refreshNativeApiInbox({quiet:true,hydrate:false}).catch(()=>{});},900);
}


function nativeApiIpcReadKey(action,payload={}) {
  const a=String(action||'');
  if(!['native-api-state','native-api-health','native-api-refresh','native-api-messages','native-api-first-incoming','native-api-meta-pages'].includes(a))return '';
  const target=payload?.target||{};
  return [a,nativeApiKey(target),Number(payload?.limit||0),payload?.hydrate===true?'1':'0'].join('|');
}
function nativeApiAction(action, payload = {}) {
  const a=String(action||'');nativeApiV254Perf.ipc.calls+=1;
  const key=nativeApiIpcReadKey(a,payload);
  if(key){nativeApiV254Perf.ipc.readCalls+=1;const existing=nativeApiIpcInFlight.get(key);if(existing){nativeApiV254Perf.ipc.joined+=1;nativeApiV254Perf.ipc.last={at:Date.now(),action:a,mode:'join',key};return existing;}}
  else nativeApiV254Perf.ipc.writeCalls+=1;
  nativeApiV254Perf.ipc.invoked+=1;nativeApiV254Perf.ipc.last={at:Date.now(),action:a,mode:'invoke',key};
  const run=Promise.resolve(window.yoko.bindTeamHandoffCurrentLine?.({ ...(payload || {}), action:a }));
  if(!key)return run;
  nativeApiIpcInFlight.set(key,run);
  return run.finally(()=>{if(nativeApiIpcInFlight.get(key)===run)nativeApiIpcInFlight.delete(key);});
}
function applyNativeApiMasterState(state={}) {
  nativeApiMasterEnabled=state?.enabled!==false;
  nativeApiRuntimeSettings={
    activePollMs:Math.max(2500,Number(state?.activePollMs||2500)||2500),
    backgroundPollMs:Math.max(5000,Number(state?.backgroundPollMs||5000)||5000),
    healthPollMs:Math.max(15000,Number(state?.healthPollMs||30000)||30000)
  };
  const btn=$('#nativeApiMasterToggleBtn');
  if(btn){btn.textContent=nativeApiMasterEnabled?'API：开':'API：关';btn.classList.toggle('on',nativeApiMasterEnabled);btn.classList.toggle('off',!nativeApiMasterEnabled);btn.setAttribute('aria-pressed',nativeApiMasterEnabled?'true':'false');}
  $('#nativeApiPage')?.classList.toggle('api-disabled',!nativeApiMasterEnabled);
  for(const id of ['nativeApiRefreshBtn','nativeApiHistorySyncBtn','nativeApiBulkBtn','nativeApiSendBtn','nativeApiImageBtn']){const node=$('#'+id);if(node)node.disabled=!nativeApiMasterEnabled;}
  if(!nativeApiMasterEnabled){
    stopNativeApiRefreshTimer();
    for(const id of ['nativeApiMetaHealth','nativeApiLineHealth']){const node=$('#'+id);if(node){node.classList.remove('ok','error');node.textContent=(id.includes('Meta')?'Facebook':'LINE')+' · 已关闭';node.title='官方 API 收件箱总开关已关闭';}}
    nativeApiSetStatus('官方 API 已关闭 · 已停止轮询和官方 API 请求');
  }
  return nativeApiMasterEnabled;
}
async function syncNativeApiMasterState(){
  try{const state=await nativeApiAction('native-api-state');applyNativeApiMasterState(state||{});return state;}catch{return {enabled:nativeApiMasterEnabled,...nativeApiRuntimeSettings};}
}
async function toggleNativeApiMaster(){
  const wanted=!nativeApiMasterEnabled;
  const btn=$('#nativeApiMasterToggleBtn');if(btn)btn.disabled=true;
  try{
    const state=await nativeApiAction('native-api-toggle',{enabled:wanted});applyNativeApiMasterState(state||{enabled:wanted});
    if(nativeApiMasterEnabled){
      nativeApiCustomerRenderSignature='';
      await Promise.all([refreshNativeApiHealth({quiet:true}),refreshNativeApiInbox({quiet:true,hydrate:false})]);
      if(shellSurface==='native-api')startNativeApiRefreshTimer();
      nativeApiSetStatus(`官方 API 已开启 · ${nativeApiInboxState.items.length||0} 位客户`);
    }
  }catch(error){nativeApiSetStatus('切换官方 API 失败：'+(error?.message||error));}
  finally{if(btn)btn.disabled=false;}
}
function nativeApiKey(item = {}) {
  return String(item.stableKey || `${item.platform || ''}|${item.accountId || ''}|${item.chatId || ''}`);
}
function nativeApiSameCustomer(a, b) { return !!a && !!b && nativeApiKey(a) === nativeApiKey(b); }
function nativeApiPlatformLabel(platform = '') { return String(platform || '').toLowerCase() === 'line' ? 'LINE' : 'Facebook'; }
function nativeApiSetStatus(message = '') {
  const text = String(message || '');
  const node = $('#nativeApiStatus'); if (node) node.textContent = text;
  const global = $('#globalStatus'); if (global) global.textContent = text;
  // V1.27.183: mirror the Native API status into the native application menu
  // immediately to the right of Help, where it stays fully visible.
  try { window.yoko.setNativeApiMenuStatus?.(text); } catch {}
}
function nativeApiAvatarHtml(item = {}, { large=false } = {}) {
  const platform = String(item.platform || '').toLowerCase() === 'line' ? 'line' : 'facebook';
  const name = String(item.displayName || nativeApiPlatformLabel(platform)).trim();
  const initial = (name.match(/[A-Za-z0-9\p{L}]/u)?.[0] || (platform === 'line' ? 'L' : 'F')).toUpperCase();
  const cls = `native-api-avatar ${platform}${large ? ' large' : ''}`;
  const url = String(item.avatarUrl || '').trim();
  return url ? `<span class="${cls}" data-native-api-avatar-url="${escapeHtml(url)}"><img src="${escapeHtml(url)}" alt="" referrerpolicy="no-referrer" decoding="async" /></span>` : `<span class="${cls}" data-native-api-avatar-url=""><span>${escapeHtml(initial)}</span></span>`;
}
function syncNativeApiChatAvatar(item = null) {
  const holder=$('#nativeApiChatAvatar'); if(!holder)return;
  const platform=String(item?.platform||'').toLowerCase()==='line'?'line':'facebook';
  const name=String(item?.displayName||nativeApiPlatformLabel(platform)).trim();
  const initial=(name.match(/[A-Za-z0-9\p{L}]/u)?.[0]||(item?(platform==='line'?'L':'F'):'?')).toUpperCase();
  const url=String(item?.avatarUrl||'').trim();
  const signature=`${item?platform:'none'}|${url}|${initial}`;
  if(nativeApiChatAvatarSignature===signature)return;
  nativeApiChatAvatarSignature=signature;
  holder.className=`native-api-avatar large${item?` ${platform}`:''}`;
  holder.dataset.nativeApiAvatarUrl=url;
  const existing=holder.querySelector('img');
  if(url){
    if(existing&&String(existing.getAttribute('src')||'')===url)return;
    holder.innerHTML=`<img src="${escapeHtml(url)}" alt="" referrerpolicy="no-referrer" decoding="async" />`;
  }else holder.innerHTML=`<span>${escapeHtml(initial)}</span>`;
}
// V1.27.228: the official API workspace follows Japan Standard Time (Asia/Tokyo)
// instead of the Windows host timezone. Facebook Messenger for these accounts is
// operated in JST, while the workstation may be UTC+8; using the host locale made
// every API timestamp appear exactly one hour behind Messenger.
const NATIVE_API_TIME_ZONE='Asia/Tokyo';
function nativeApiTokyoParts(value=0){
  let time=Number(value||0)||0;if(time>0&&time<1e12)time*=1000;if(!time)return null;
  const date=new Date(time);if(Number.isNaN(date.getTime()))return null;
  try{
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:NATIVE_API_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);
    return Object.fromEntries(parts.filter(row=>row.type!=='literal').map(row=>[row.type,row.value]));
  }catch{return null;}
}
function nativeApiTokyoDayKey(value=0){const p=nativeApiTokyoParts(value);return p?`${p.year}-${p.month}-${p.day}`:'';}
function nativeApiTimeLabel(value=0){
  let time=Number(value||0)||0;if(time>0&&time<1e12)time*=1000;if(!time)return '';
  const p=nativeApiTokyoParts(time);if(!p)return '';
  const now=Date.now(),today=nativeApiTokyoDayKey(now),day=nativeApiTokyoDayKey(time);
  if(day===today)return `${p.hour}:${p.minute}`;
  const yesterday=nativeApiTokyoDayKey(now-86400000);if(day===yesterday)return '昨天';
  return `${p.month}/${p.day}`;
}
function formatNativeApiTimelineTime(value=0){
  let time=Number(value||0)||0;if(time>0&&time<1e12)time*=1000;if(!time)return '—';
  const p=nativeApiTokyoParts(time);return p?`${p.month}/${p.day} ${p.hour}:${p.minute}`:'—';
}
const NATIVE_API_STAGE_GROUPS = [
  { id:'new', label:'待回复', stages:['待回复','新进线','已接待'] },
  { id:'active', label:'有意向', stages:['有意向','有效聊天','准备引导LINE','已邀请LINE'] },
  { id:'added', label:'已对接ws', stages:['已对接ws','LINE已添加','已添加LINE'] },
  { id:'paused', label:'无效', stages:['无效','无效/暂停'] }
];
function nativeApiCanonicalLeadStage(stage='') {
  const raw=String(stage||'').trim().replace(/\s+/g,' ');
  if(/^(?:LINE已添加|已添加LINE|Line已添加|line已添加)$/i.test(raw))return '已对接ws';
  if(/^(?:无效|暂停|无效\/暂停|暂停\/无效)$/i.test(raw))return '无效';
  return raw;
}
function nativeApiStageGroupId(item={}) {
  const stage=nativeApiCanonicalLeadStage(item?.crmStage||item?.crm?.stage||'');
  if(String(item?.platform||'').toLowerCase()==='line'){
    return /(?:暂缓|暂停|无效|黑名单)/.test(stage)?'paused':'added';
  }
  for(const group of NATIVE_API_STAGE_GROUPS){
    if(group.stages.includes(stage))return group.id;
  }
  return '';
}
function nativeApiStageGroupScopeItems() {
  return (nativeApiInboxState.items||[]).filter(item=>{
    if(nativeApiIsHidden(item)||!nativeApiInboxAllows(item))return false;
    if(nativeApiPlatformFilter!=='all'&&String(item.platform||'')!==nativeApiPlatformFilter)return false;
    if(String(item.platform||'')==='facebook'&&nativeApiFacebookPageFilter!=='all'&&String(item.pageId||'')!==nativeApiFacebookPageFilter)return false;
    if(nativeApiWaitingOnly&&!nativeApiAwaitingReply(item))return false;
    return true;
  });
}
// V1.27.276: customer day grouping supports authoritative history fallback + moving manual calibration. Day 1 starts on the
// customer's first incoming message. The operational day rolls at 05:00 JST so
// late-night conversations do not jump buckets at midnight. This does NOT
// reactivate the retired Day 1-10 GPT/chat automation.
const NATIVE_API_CUSTOMER_DAY_MAX = 10;
const NATIVE_API_CUSTOMER_DAY_BOUNDARY_HOUR_JST = 5;
const NATIVE_API_FIRST_INCOMING_RETRY_MS = 15*60*1000;
function nativeApiBusinessDayOrdinalJst(value=Date.now()) {
  let time=Number(value||0)||0;if(time>0&&time<1e12)time*=1000;if(!time)return NaN;
  const shifted=time-NATIVE_API_CUSTOMER_DAY_BOUNDARY_HOUR_JST*60*60*1000;
  const p=nativeApiTokyoParts(shifted);if(!p)return NaN;
  const y=Number(p.year),m=Number(p.month),d=Number(p.day);
  if(!y||!m||!d)return NaN;
  return Math.floor(Date.UTC(y,m-1,d)/86400000);
}
function nativeApiCustomerDayNumber(item={},now=Date.now()) {
  const calibrated=customerDayCalibrationEffective(item,'native',now);if(calibrated>0)return calibrated;
  const first=nativeApiFirstIncomingAt(item);if(!first)return 0;
  const current=nativeApiBusinessDayOrdinalJst(now),started=nativeApiBusinessDayOrdinalJst(first);
  if(!Number.isFinite(current)||!Number.isFinite(started))return 0;
  const diff=current-started;
  return diff>=0?diff+1:0;
}
function nativeApiDayFilterScopeItems() {
  return nativeApiStageGroupScopeItems().filter(item=>!nativeApiStageGroupFilter||nativeApiStageGroupId(item)===nativeApiStageGroupFilter);
}
function nativeApiNeedsDayResolution(item={},now=Date.now()) {
  if(customerDayCalibrationEffective(item,'native',now)>0||nativeApiFirstIncomingAt(item)||item?.historyOnly)return false;
  const last=Number(item?.lastIncomingAt||0)||((String(item?.lastDirection||'')==='incoming')?Number(item?.lastTimestampMs||0):0)||0;if(!last)return false;
  const current=nativeApiBusinessDayOrdinalJst(now),recent=nativeApiBusinessDayOrdinalJst(last);
  if(!Number.isFinite(current)||!Number.isFinite(recent))return false;
  const diff=current-recent;
  if(diff<0||diff>=NATIVE_API_CUSTOMER_DAY_MAX)return false;
  const lastUnresolved=Number(nativeApiFirstIncomingUnresolvedAt.get(nativeApiKey(item))||0);
  return !lastUnresolved||Date.now()-lastUnresolved>=NATIVE_API_FIRST_INCOMING_RETRY_MS;
}
async function nativeApiResolveFirstIncomingForDayBucket(item={}) {
  const key=nativeApiKey(item);if(!key||nativeApiFirstIncomingAt(item)||nativeApiFirstIncomingBusy.has(key)||item?.historyOnly)return false;
  nativeApiFirstIncomingBusy.add(key);
  try{
    const result=await nativeApiAction('native-api-first-incoming',{target:item,limit:500});
    if(result?.exact===true&&Number(result?.firstIncomingAt||0)>0){
      nativeApiFirstIncomingUnresolvedAt.delete(key);
      return nativeApiCacheFirstIncoming(item,Number(result.firstIncomingAt),{exact:true});
    }
    nativeApiFirstIncomingUnresolvedAt.set(key,Date.now());
    return false;
  }catch{
    nativeApiFirstIncomingUnresolvedAt.set(key,Date.now());
    return false;
  }finally{nativeApiFirstIncomingBusy.delete(key);}
}
function nativeApiScheduleDayBucketResolution(items=nativeApiInboxState.items||[]) {
  if(nativeApiDayResolutionPromise)return nativeApiDayResolutionPromise;
  const source=Array.isArray(items)?items:[];
  if(!source.some(item=>nativeApiNeedsDayResolution(item))){nativeApiRenderDayFilter();return Promise.resolve(false);}
  nativeApiDayResolutionPromise=(async()=>{
    let changed=false,processed=0;
    // V1.27.276: drain all currently resolvable recent customers in bounded
    // batches. V1.27.273 only handled the first 80 and waited for another full
    // renderer refresh, which could leave every Day counter at 0 on large inboxes.
    while(processed<240){
      const candidates=source.filter(item=>nativeApiNeedsDayResolution(item)).slice(0,60);if(!candidates.length)break;
      let cursor=0;const worker=async()=>{while(cursor<candidates.length){const item=candidates[cursor++];processed+=1;if(await nativeApiResolveFirstIncomingForDayBucket(item))changed=true;}};
      await Promise.all(Array.from({length:Math.min(2,candidates.length)},()=>worker()));
      nativeApiRenderDayFilter();
    }
    if(changed){nativeApiCustomerRenderSignature='';nativeApiCustomerBaseSignature='';}
    nativeApiRenderDayFilter();
    if(changed||nativeApiDayFilter)renderNativeApiCustomers({force:true});if(changed&&nativeApiSelected)renderNativeApiChatHead();
    return changed;
  })().finally(()=>{nativeApiDayResolutionPromise=null;});
  nativeApiRenderDayFilter();
  return nativeApiDayResolutionPromise;
}
function nativeApiRenderDayFilter() {
  const select=$('#nativeApiDayFilter'),status=$('#nativeApiDayFilterStatus'),row=select?.closest?.('.native-api-day-filter-row');
  if(!select)return;
  const scope=nativeApiDayFilterScopeItems(),counts=Array(NATIVE_API_CUSTOMER_DAY_MAX+1).fill(0);
  let unresolved=0;
  for(const item of scope){
    const day=nativeApiCustomerDayNumber(item);
    if(day>=NATIVE_API_CUSTOMER_DAY_MAX)counts[NATIVE_API_CUSTOMER_DAY_MAX]++;else if(day>=1)counts[day]++;
    else if(nativeApiNeedsDayResolution(item))unresolved++;
  }
  select.value=String(nativeApiDayFilter||0);
  for(const option of Array.from(select.options||[])){
    const day=Number(option.value||0);
    option.textContent=day>=1&&day<=NATIVE_API_CUSTOMER_DAY_MAX?`${day===NATIVE_API_CUSTOMER_DAY_MAX?'第10天+':`第${day}天`} · ${counts[day]}人`:'全部天数';
  }
  if(status){
    const selected=nativeApiDayFilter>=1&&nativeApiDayFilter<=NATIVE_API_CUSTOMER_DAY_MAX;
    status.textContent=selected
      ? `当前第${nativeApiDayFilter}天 · ${counts[nativeApiDayFilter]}人${unresolved?` · ${unresolved}位首次来信核对中`:''}`
      : `按首次来信计算 · 日本时间 05:00 换日${unresolved?` · 正在核对 ${unresolved} 位（完成后自动刷新人数）`:''}`;
  }
  row?.classList.toggle('resolving',unresolved>0||!!nativeApiDayResolutionPromise);
}
function nativeApiRenderStageGroups() {
  const scope=nativeApiStageGroupScopeItems();
  const counts=new Map(NATIVE_API_STAGE_GROUPS.map(group=>[group.id,0]));
  for(const item of scope){const id=nativeApiStageGroupId(item);if(id)counts.set(id,(counts.get(id)||0)+1);}
  document.querySelectorAll('[data-native-api-stage-group]').forEach(button=>{
    const id=String(button.dataset.nativeApiStageGroup||'');
    const count=counts.get(id)||0;
    const badge=button.querySelector('span');if(badge)badge.textContent=String(count);
    const active=id===nativeApiStageGroupFilter;
    button.classList.toggle('active',active);
    button.setAttribute('aria-pressed',active?'true':'false');
  });
}
function nativeApiVisibleItems() {
  const q=String(nativeApiSearchText||'').trim().toLocaleLowerCase();
  return (nativeApiInboxState.items||[]).filter(item=>{
    if(nativeApiIsHidden(item)||!nativeApiInboxAllows(item))return false;
    if(nativeApiPlatformFilter!=='all'&&String(item.platform||'')!==nativeApiPlatformFilter)return false;
    if(String(item.platform||'')==='facebook'&&nativeApiFacebookPageFilter!=='all'&&String(item.pageId||'')!==nativeApiFacebookPageFilter)return false;

    if(nativeApiWaitingOnly&&!nativeApiAwaitingReply(item))return false;
    if(nativeApiStageGroupFilter&&nativeApiStageGroupId(item)!==nativeApiStageGroupFilter)return false;
    if(nativeApiDayFilter){const day=nativeApiCustomerDayNumber(item);if(nativeApiDayFilter===NATIVE_API_CUSTOMER_DAY_MAX?day<NATIVE_API_CUSTOMER_DAY_MAX:day!==nativeApiDayFilter)return false;}
    if(!q)return true;
    return [item.displayName,item.preview,item.accountName,item.chatId,item.remoteId,item.crmStage].join('\n').toLocaleLowerCase().includes(q);
  });
}
function nativeApiCustomerVirtualRange(list,visible=[]) {
  const total=visible.length;
  if(total<=NATIVE_API_CUSTOMER_VIRTUAL_THRESHOLD||!list)return {virtual:false,start:0,end:total,top:0,bottom:0};
  const rowHeight=Math.max(54,Number(nativeApiCustomerVirtualRowHeight||66));
  const viewport=Math.max(240,Number(list.clientHeight||0)||600);
  let scrollTop=Math.max(0,Number(list.scrollTop||0));
  let start=Math.max(0,Math.floor(scrollTop/rowHeight)-NATIVE_API_CUSTOMER_VIRTUAL_OVERSCAN);
  let end=Math.min(total,Math.ceil((scrollTop+viewport)/rowHeight)+NATIVE_API_CUSTOMER_VIRTUAL_OVERSCAN);
  const selectedKey=nativeApiKey(nativeApiSelected||{});
  const selectedIndex=selectedKey?visible.findIndex(item=>nativeApiKey(item)===selectedKey):-1;
  if(selectedKey&&selectedKey!==nativeApiCustomerVirtualLastSelectionKey&&selectedIndex>=0&&(selectedIndex<start||selectedIndex>=end)){
    scrollTop=Math.max(0,selectedIndex*rowHeight-Math.round(viewport*0.4));
    list.scrollTop=scrollTop;
    start=Math.max(0,Math.floor(scrollTop/rowHeight)-NATIVE_API_CUSTOMER_VIRTUAL_OVERSCAN);
    end=Math.min(total,Math.ceil((scrollTop+viewport)/rowHeight)+NATIVE_API_CUSTOMER_VIRTUAL_OVERSCAN);
  }
  nativeApiCustomerVirtualLastSelectionKey=selectedKey;
  return {virtual:true,start,end,top:start*rowHeight,bottom:Math.max(0,(total-end)*rowHeight)};
}
function scheduleNativeApiCustomerVirtualRender(){
  if(nativeApiCustomerVirtualScrollRaf)return;
  const flush=()=>{nativeApiCustomerVirtualScrollRaf=0;renderNativeApiCustomers({virtualScroll:true});};
  try{nativeApiCustomerVirtualScrollRaf=requestAnimationFrame(flush);}catch{nativeApiCustomerVirtualScrollRaf=setTimeout(flush,16);}
}
function nativeApiInboxVisualSignatureFor(items=[]){
  return (Array.isArray(items)?items:[]).map(item=>[
    nativeApiKey(item),String(item.displayName||''),String(item.preview||''),String(item.avatarUrl||''),
    Number(item.lastTimestampMs||0),Number(item.firstIncomingAt||0),String(item.lastEventKey||''),String(item.lastDirection||''),
    String(item.crmStage||''),String(item.crmServiceStatus||''),`day:${nativeApiCustomerDayNumber(item)}`,nativeApiAwaitingReply(item)?1:0,nativeApiUnreadCountFor(item),nativeApiHasDraft(item)?1:0
  ].join('~')).join('|');
}
function nativeApiCustomerSignature() {
  const visible=nativeApiVisibleItems();
  return JSON.stringify({
    filter:nativeApiPlatformFilter, inbox:nativeApiInboxLayout.selected, facebookPage:nativeApiFacebookPageFilter, stageGroup:nativeApiStageGroupFilter, dayFilter:nativeApiDayFilter, search:String(nativeApiSearchText||''), waitingOnly:nativeApiWaitingOnly, selected:nativeApiKey(nativeApiSelected||{}),
    rows:visible.map(item=>[nativeApiKey(item),item.displayName||'',item.preview||'',item.avatarUrl||'',Number(item.lastTimestampMs||0),nativeApiAwaitingReply(item),nativeApiUnreadCountFor(item),nativeApiHasDraft(item),item.crmStage||'',nativeApiCustomerDayNumber(item)])
  });
}
function nativeApiCustomerRowHtml(item={}) {
  const selected=nativeApiSameCustomer(item,nativeApiSelected); const platform=String(item.platform||'')==='line'?'line':'facebook'; const source=platform==='line'?'LINE Official Account':(String(item.accountName||'').trim()||'Facebook Messenger');
  const unread=nativeApiUnreadCountFor(item);const stage=String(item.crmStage||'').trim();const stageClass=stage==='LINE已添加'?' line-added':(/暂停|无效|黑名单/.test(stage)?' paused':'');
  return `<button type="button" class="native-api-customer${selected?' active':''}${nativeApiAwaitingReply(item)?' waiting':''}${unread?' unread':''}" data-native-api-key="${escapeHtml(nativeApiKey(item))}">${nativeApiAvatarHtml(item)}<span class="native-api-customer-copy"><strong class="native-api-customer-name">${escapeHtml(item.displayName||`${source} 客户`)}</strong><span class="native-api-customer-preview">${escapeHtml(item.preview||'暂无文字消息')}</span><span class="native-api-customer-source">${escapeHtml(source)}${stage?`<span class="native-api-stage-badge${stageClass}">${escapeHtml(stage)}</span>`:''}${nativeApiHasDraft(item)?'<span class="native-api-draft-badge">草稿</span>':''}</span></span><span class="native-api-customer-side"><span class="native-api-customer-time">${escapeHtml(nativeApiTimeLabel(item.lastTimestampMs))}</span>${unread?`<span class="native-api-customer-unread">${unread>99?'99+':unread}</span>`:`<span class="native-api-platform-badge ${platform}">${platform==='line'?'LINE':'FB'}</span>`}</span></button>`;
}
function nativeApiRenderCustomerMetaOnly(){
  const all=(Array.isArray(nativeApiInboxState.items)?nativeApiInboxState.items:[]).filter(item=>!nativeApiIsHidden(item));const waiting=all.filter(item=>nativeApiAwaitingReply(item)).length;
  nativeApiRenderTodayNewStat();if($('#nativeApiCustomerCount')){const total=nativeApiTotalUnread();$('#nativeApiCustomerCount').textContent=total?`${all.length} 位 · 未读 ${total}`:`${all.length} 位`;}nativeApiRenderNotificationState();
  const waitingBtn=$('#nativeApiWaitingOnlyBtn');if(waitingBtn){waitingBtn.textContent=`待回复 ${waiting}`;waitingBtn.classList.toggle('active',nativeApiWaitingOnly);waitingBtn.setAttribute('aria-pressed',nativeApiWaitingOnly?'true':'false');}nativeApiRenderStageGroups();nativeApiRenderDayFilter();
}
function nativeApiPatchCustomerSelection(){
  const selectedKey=nativeApiKey(nativeApiSelected||{});let patched=0;for(const node of document.querySelectorAll('#nativeApiCustomerList [data-native-api-key]')){const active=String(node.dataset.nativeApiKey||'')===selectedKey;if(node.classList.contains('active')!==active){node.classList.toggle('active',active);patched++;}}
  if(patched){nativeApiV254Perf.render.customerSelectionPatch+=patched;nativeApiV254Perf.render.last={at:Date.now(),type:'customer-selection-patch',count:patched};}
  nativeApiRenderCustomerMetaOnly();return patched;
}
function nativeApiPatchCustomerRows(keys=[]){
  const wanted=new Set((keys||[]).map(String));if(!wanted.size)return 0;const list=$('#nativeApiCustomerList');if(!list)return 0;let patched=0;
  for(const node of Array.from(list.querySelectorAll('[data-native-api-key]'))){const key=String(node.dataset.nativeApiKey||'');if(!wanted.has(key))continue;const item=(nativeApiInboxState.items||[]).find(row=>nativeApiKey(row)===key);if(!item)continue;node.outerHTML=nativeApiCustomerRowHtml(item);patched++;}
  if(patched){nativeApiV254Perf.render.customerRowPatch+=patched;nativeApiV254Perf.render.last={at:Date.now(),type:'customer-row-patch',count:patched};nativeApiRenderCustomerMetaOnly();}
  return patched;
}
function nativeApiCustomerPatchPlan(previous=[],next=[]){
  if(previous.length!==next.length)return {patchable:false,keys:[]};
  const prevKeys=previous.map(nativeApiKey),nextKeys=next.map(nativeApiKey);for(let i=0;i<prevKeys.length;i++)if(prevKeys[i]!==nextKeys[i])return {patchable:false,keys:[]};
  const keys=[];for(let i=0;i<next.length;i++){const a=previous[i]||{},b=next[i]||{};const structural=[a.platform,a.pageId,a.displayName,a.avatarUrl,a.crmStage,a.crmServiceStatus,nativeApiIsHidden(a)?1:0].join('|')!==[b.platform,b.pageId,b.displayName,b.avatarUrl,b.crmStage,b.crmServiceStatus,nativeApiIsHidden(b)?1:0].join('|');if(structural)return {patchable:false,keys:[]};if(nativeApiCustomerVisualRowSignature(a)!==nativeApiCustomerVisualRowSignature(b))keys.push(nativeApiKey(b));}
  return {patchable:keys.length<=8,keys};
}
function nativeApiCustomerVisualRowSignature(item={}){return [nativeApiKey(item),String(item.preview||''),Number(item.lastTimestampMs||0),String(item.lastEventKey||''),String(item.lastDirection||''),nativeApiAwaitingReply(item)?1:0,nativeApiUnreadCountFor(item),nativeApiHasDraft(item)?1:0].join('~');}
function renderNativeApiCustomers({ force=false, virtualScroll=false } = {}) {
  const list=$('#nativeApiCustomerList'); const all=nativeApiInboxScopedItems().filter(item=>!nativeApiIsHidden(item));
  const waiting=all.filter(item=>nativeApiAwaitingReply(item)).length; const visible=nativeApiVisibleItems();
  if(!virtualScroll){
    for(const item of all){const direct=Number(item?.firstIncomingAt||0)||0;if(direct>0)nativeApiCacheFirstIncoming(item,direct,{exact:true});}
    nativeApiRenderTodayNewStat();
    if($('#nativeApiCustomerCount')){const total=nativeApiTotalUnread();$('#nativeApiCustomerCount').textContent=total?`${all.length} 位 · 未读 ${total}`:`${all.length} 位`;} nativeApiRenderNotificationState();
    const waitingBtn=$('#nativeApiWaitingOnlyBtn'); if(waitingBtn){waitingBtn.textContent=`待回复 ${waiting}`;waitingBtn.classList.toggle('active',nativeApiWaitingOnly);waitingBtn.setAttribute('aria-pressed',nativeApiWaitingOnly?'true':'false');}
    document.querySelectorAll('[data-native-api-filter]').forEach(button=>button.classList.toggle('active',String(button.dataset.nativeApiFilter||'all')===nativeApiPlatformFilter));
    nativeApiRenderStageGroups();nativeApiRenderDayFilter();nativeApiScheduleDayBucketResolution(all).catch(()=>{});
  }
  if(!list)return;
  const range=nativeApiCustomerVirtualRange(list,visible);
  const baseSignature=virtualScroll&&nativeApiCustomerBaseSignature?nativeApiCustomerBaseSignature:nativeApiCustomerSignature();
  if(!virtualScroll)nativeApiCustomerBaseSignature=baseSignature;
  const signature=`${baseSignature}::window=${range.start}-${range.end}`;
  if(!force&&signature===nativeApiCustomerRenderSignature)return;
  nativeApiCustomerRenderSignature=signature;
  if(!visible.length){const group=NATIVE_API_STAGE_GROUPS.find(row=>row.id===nativeApiStageGroupFilter);const reason=all.length?(nativeApiDayFilter?`第${nativeApiDayFilter}天当前没有客户。`:(group?`${group.label} 分组当前没有客户。`:'当前筛选条件下没有客户。')):((nativeApiInboxState.errors||[]).length?'官方 API 暂时没有返回客户，请检查 VPS Native API Inbox 补丁。':'还没有收到 Facebook / LINE 客户消息。');list.innerHTML=`<div class="native-api-empty">${escapeHtml(reason)}</div>`;return;}
  const rows=visible.slice(range.start,range.end);
  const topSpacer=range.virtual&&range.top>0?`<div class="native-api-virtual-spacer" style="height:${Math.round(range.top)}px" aria-hidden="true"></div>`:'';
  const bottomSpacer=range.virtual&&range.bottom>0?`<div class="native-api-virtual-spacer" style="height:${Math.round(range.bottom)}px" aria-hidden="true"></div>`:'';
  nativeApiV254Perf.render.customerFull+=1;nativeApiV254Perf.render.last={at:Date.now(),type:'customer-full',rows:rows.length};
  list.innerHTML=topSpacer+rows.map(nativeApiCustomerRowHtml).join('')+bottomSpacer;
  if(range.virtual){
    const first=list.querySelector('.native-api-customer');
    if(first){try{const style=getComputedStyle(first);const measured=first.getBoundingClientRect().height+(parseFloat(style.marginBottom)||0);if(measured>=54&&measured<=110)nativeApiCustomerVirtualRowHeight=Math.round(nativeApiCustomerVirtualRowHeight*0.75+measured*0.25);}catch{}}
  }
}


function nativeApiBulkChannelLabel(channel=''){
  return ({line:'LINE',telegram:'TG',whatsapp:'WS',facebook:'Facebook Messenger'})[String(channel||'').toLowerCase()]||String(channel||'');
}
function nativeApiBulkCustomerKey(item={}){return String(item.stableKey||`${item.platform||''}|${item.accountId||''}|${item.chatId||item.displayName||''}`);}
function nativeApiBulkAvatarHtml(item={}){
  const src=String(item.avatarDataUrl||item.avatarUrl||'').trim(),name=String(item.displayName||'客').trim(),letter=escapeHtml((Array.from(name)[0]||'客').toUpperCase());
  return `<span class="native-api-avatar">${src?`<img src="${escapeHtml(src)}" alt="" />`:`<span>${letter}</span>`}</span>`;
}
function nativeApiBulkStageGroupLabel(id=''){
  return NATIVE_API_STAGE_GROUPS.find(group=>group.id===String(id||''))?.label||'';
}
function nativeApiBulkLineGroupLabel(id=''){
  return lineLifecycleGroupLabel(id);
}
function nativeApiBulkFacebookAccountId(item={}){
  return String(item.accountId||item.pageId||'').trim();
}
function nativeApiBulkFacebookAccountLabel(item={}){
  const name=String(item.accountName||item.pageName||'').trim();
  const id=nativeApiBulkFacebookAccountId(item).replace(/^fb-api:/i,'');
  return name&&name!=='Facebook Messenger API' ? name : (id?`Facebook 主页 ${id}`:'未命名 Facebook 主页');
}
function nativeApiBulkRenderFacebookAccounts(){
  const wrap=$('#nativeApiBulkFacebookAccountWrap'),select=$('#nativeApiBulkFacebookAccount');
  if(wrap)wrap.classList.toggle('hidden',nativeApiBulkPlatformFilter!=='facebook');
  if(!select)return;
  const map=new Map();
  for(const item of (nativeApiBulkCustomerItems||[])){
    const id=nativeApiBulkFacebookAccountId(item);if(!id)continue;
    if(!map.has(id))map.set(id,{id,label:nativeApiBulkFacebookAccountLabel(item)});
  }
  const rows=[...map.values()].sort((a,b)=>a.label.localeCompare(b.label,'zh-CN'));
  if(nativeApiBulkFacebookAccountFilter!=='all'&&!map.has(nativeApiBulkFacebookAccountFilter))nativeApiBulkFacebookAccountFilter='all';
  select.innerHTML='<option value="all">全部 Facebook 账号</option>'+rows.map(row=>`<option value="${escapeHtml(row.id)}">${escapeHtml(row.label)} · ${escapeHtml(row.id.replace(/^fb-api:/i,''))}</option>`).join('');
  select.value=nativeApiBulkFacebookAccountFilter;
}
function nativeApiBulkRenderStageGroups(){
  const lineMode=nativeApiBulkPlatformFilter==='line';
  const stageBox=$('#nativeApiBulkStageGroups'),lineBox=$('#nativeApiBulkLineLifecycleGroups');
  if(stageBox)stageBox.classList.toggle('hidden',lineMode);
  if(lineBox)lineBox.classList.toggle('hidden',!lineMode);
  const frontWrap=$('#nativeApiBulkFrontFilterWrap');if(frontWrap)frontWrap.classList.toggle('hidden',lineMode);
  const stageSelect=$('#nativeApiBulkCrmStage');if(stageSelect)stageSelect.value=nativeApiBulkStageGroupFilter||'all';
  const all=nativeApiBulkCustomerItems||[];
  if(lineMode){
    const counts=new Map(LINE_LIFECYCLE_GROUPS.map(group=>[group.id,0]));
    for(const item of all){const id=lineLifecycleGroupId(item);if(id&&counts.has(id))counts.set(id,(counts.get(id)||0)+1);}
    document.querySelectorAll('[data-native-api-bulk-line-group]').forEach(button=>{
      const id=String(button.dataset.nativeApiBulkLineGroup||'all'),count=id==='all'?all.length:(counts.get(id)||0),active=id===nativeApiBulkLineGroupFilter;
      const badge=button.querySelector('span');if(badge)badge.textContent=String(count);
      button.classList.toggle('active',active);button.setAttribute('aria-pressed',active?'true':'false');
    });
    return;
  }
  const counts=new Map(NATIVE_API_STAGE_GROUPS.map(group=>[group.id,0]));
  for(const item of all){const id=nativeApiStageGroupId(item);if(id)counts.set(id,(counts.get(id)||0)+1);}
  document.querySelectorAll('[data-native-api-bulk-stage-group]').forEach(button=>{
    const raw=String(button.dataset.nativeApiBulkStageGroup||'all'),id=raw==='all'?'':raw,count=raw==='all'?all.length:(counts.get(id)||0),active=id===nativeApiBulkStageGroupFilter;
    const badge=button.querySelector('span');if(badge)badge.textContent=String(count);
    button.classList.toggle('active',active);button.setAttribute('aria-pressed',active?'true':'false');
  });
}
function nativeApiBulkVisibleCustomers(){
  const q=String(nativeApiBulkSearchText||'').trim().toLocaleLowerCase();
  return (nativeApiBulkCustomerItems||[]).filter(item=>{
    if(nativeApiBulkPlatformFilter==='facebook'&&nativeApiBulkFacebookAccountFilter!=='all'&&nativeApiBulkFacebookAccountId(item)!==nativeApiBulkFacebookAccountFilter)return false;
    if(nativeApiBulkPlatformFilter==='line'){
      if(nativeApiBulkLineGroupFilter!=='all'&&lineLifecycleGroupId(item)!==nativeApiBulkLineGroupFilter)return false;
    }else if(nativeApiBulkStageGroupFilter&&nativeApiStageGroupId(item)!==nativeApiBulkStageGroupFilter)return false;
    return !q||[item.displayName,item.preview,item.accountName,item.crmStage,item.lineLifecycleLabel,item.chatId,item.handle].join('\n').toLocaleLowerCase().includes(q);
  });
}
async function nativeApiBulkLoadChannelCustomers(channel=nativeApiBulkPlatformFilter,{refresh=true,keepSelection=false}={}){
  const c=['line','telegram','whatsapp','facebook'].includes(String(channel||''))?String(channel):'line';nativeApiBulkPlatformFilter=c;
  if(c!=='facebook')nativeApiBulkFacebookAccountFilter='all';
  const list=$('#nativeApiBulkCustomerList');if(list)list.innerHTML=`<div class="native-api-empty">正在读取 ${escapeHtml(nativeApiBulkChannelLabel(c))} 客户…</div>`;
  try{
    const result=await nativeApiAction('native-api-bulk-customers',{channel:c,refresh});
    nativeApiBulkCustomerItems=Array.isArray(result?.items)?result.items:[];
    if(!keepSelection)nativeApiBulkSelectedKeys=new Set();
    else nativeApiBulkSelectedKeys=new Set([...nativeApiBulkSelectedKeys].filter(key=>nativeApiBulkCustomerItems.some(item=>nativeApiBulkCustomerKey(item)===key)));
    nativeApiBulkRenderCustomers();return result;
  }catch(error){nativeApiBulkCustomerItems=[];nativeApiBulkSelectedKeys=new Set();nativeApiBulkRenderCustomers();if(list)list.innerHTML=`<div class="native-api-empty">读取失败：${escapeHtml(error?.message||error)}</div>`;throw error;}
}
function nativeApiBulkRenderCustomers(){
  const list=$('#nativeApiBulkCustomerList');if(!list)return;const all=nativeApiBulkCustomerItems||[];
  nativeApiBulkRenderFacebookAccounts();
  const visible=nativeApiBulkVisibleCustomers();
  const groupLabel=nativeApiBulkPlatformFilter==='line'?nativeApiBulkLineGroupLabel(nativeApiBulkLineGroupFilter):nativeApiBulkStageGroupLabel(nativeApiBulkStageGroupFilter);
  nativeApiBulkRenderStageGroups();
  const accountLabel=nativeApiBulkPlatformFilter==='facebook'&&nativeApiBulkFacebookAccountFilter!=='all'?nativeApiBulkFacebookAccountLabel(all.find(item=>nativeApiBulkFacebookAccountId(item)===nativeApiBulkFacebookAccountFilter)||{accountId:nativeApiBulkFacebookAccountFilter}):'';
  if($('#nativeApiBulkCustomerMeta'))$('#nativeApiBulkCustomerMeta').textContent=`${nativeApiBulkChannelLabel(nativeApiBulkPlatformFilter)}${accountLabel?` · ${accountLabel}`:''} · 已读取 ${all.length} 位${groupLabel?` · ${groupLabel} ${visible.length} 位`:` · 当前 ${visible.length} 位`}`;
  if($('#nativeApiBulkSelectedCount'))$('#nativeApiBulkSelectedCount').textContent=`已选 ${nativeApiBulkSelectedKeys.size}`;
  const actionHint=$('#nativeApiBulkActionHint');if(actionHint)actionHint.textContent=`当前发送对象：${nativeApiBulkChannelLabel(nativeApiBulkPlatformFilter)}${accountLabel?` / ${accountLabel}`:''}${groupLabel?` / ${groupLabel}分组`:''}；实际只发送已勾选客户。`;
  const selectBtn=$('#nativeApiBulkSelectVisibleBtn');if(selectBtn){const every=visible.length>0&&visible.every(item=>nativeApiBulkSelectedKeys.has(nativeApiBulkCustomerKey(item))),scope=String(nativeApiBulkSearchText||'').trim()?'搜索结果':(groupLabel?'此分组':'当前');selectBtn.textContent=every?`取消${scope}全选`:`全选${scope}`;selectBtn.dataset.allSelected=every?'1':'0';}
  if(!visible.length){list.innerHTML=`<div class="native-api-empty">${escapeHtml(groupLabel?`${groupLabel}分组当前没有符合条件的客户。`:'当前软件的客户列表为空，或没有符合搜索条件的客户。')}</div>`;return;}
  const badge=channel=>({line:'LINE',telegram:'TG',whatsapp:'WS',facebook:'FB'})[channel]||channel.toUpperCase();
  list.innerHTML=visible.map(item=>{const key=nativeApiBulkCustomerKey(item),selected=nativeApiBulkSelectedKeys.has(key),channel=String(item.channel||item.platform||nativeApiBulkPlatformFilter),lineLabel=channel==='line'?String(item.lineLifecycleLabel||lineLifecycleGroupLabel(lineLifecycleGroupId(item))):'',accountLabel=channel==='facebook'?nativeApiBulkFacebookAccountLabel(item):'',detail=[accountLabel,lineLabel||item.crmStage||item.preview||'暂无备注'].filter(Boolean).join(' · ');return `<label class="native-api-bulk-customer${selected?' selected':''}" data-native-api-bulk-key="${escapeHtml(key)}"><span class="native-api-bulk-customer-copy"><strong>${escapeHtml(item.displayName||'客户')}</strong><small>${escapeHtml(detail)}${item.accountIsOpen===false?' · 账号未启动':''}</small></span><input class="native-api-bulk-checkbox" type="checkbox" ${selected?'checked':''} aria-label="选择 ${escapeHtml(item.displayName||'客户')}" /></label>`;}).join('');
}
function nativeApiBulkStatusLabel(status=''){
  return ({idle:'尚未开始',scheduled:'等待定时',running:'发送中',paused:'已暂停',completed:'已完成',cancelled:'已取消'}[String(status||'')]||String(status||'--'));
}
function nativeApiBulkRecipientLabel(status=''){
  return ({queued:'等待',sending:'发送中',sent:'已发送',failed:'失败',cancelled:'已取消'}[String(status||'')]||String(status||'--'));
}
function nativeApiBulkFormatSchedule(ms=0){const n=Number(ms||0);if(!n)return '--';try{return new Date(n).toLocaleString('zh-CN',{hour12:false});}catch{return '--';}}
function nativeApiBulkLocalDateTimeValue(ms=Date.now()+10*60*1000){const d=new Date(Number(ms)||Date.now());const p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;}
function nativeApiBulkUpdateScheduleUi(){
  const mode=String($('#nativeApiBulkSendMode')?.value||'immediate'),wrap=$('#nativeApiBulkScheduleWrap'),btn=$('#nativeApiBulkStartBtn');if(wrap)wrap.classList.toggle('hidden',mode!=='scheduled');if(btn)btn.textContent=mode==='scheduled'?'创建定时群发':'开始随机群发';
}
function nativeApiBulkRenderRuntime(next=nativeApiBulkRuntimeState){
  nativeApiBulkRuntimeState=next||nativeApiBulkRuntimeState||{status:'idle',counts:{total:0,sent:0,failed:0,cancelled:0,queued:0}};const s=nativeApiBulkRuntimeState,c=s.counts||{},done=Number(c.sent||0)+Number(c.failed||0)+Number(c.cancelled||0),total=Number(c.total||0),pct=total?Math.min(100,Math.round(done/total*100)):0;
  const title=$('#nativeApiBulkProgressTitle');if(title)title.textContent=`${nativeApiBulkStatusLabel(s.status)} · ${done}/${total}`;const bar=$('#nativeApiBulkProgressBar span');if(bar)bar.style.width=`${pct}%`;
  const countdown=$('#nativeApiBulkCountdown');if(countdown){const left=Number(s.nextSendAt||0)-Date.now();if(String(s.status)==='scheduled')countdown.textContent=left>0?`距开始 ${Math.ceil(left/1000)} 秒`:'准备开始…';else countdown.textContent=String(s.status)==='running'&&left>0?`下一位 ${Math.ceil(left/1000)} 秒`:(String(s.status)==='running'?'正在处理…':'--');}
  const meta=$('#nativeApiBulkProgressMeta');if(meta){const sched=String(s.status)==='scheduled'?` · 定时 ${nativeApiBulkFormatSchedule(s.scheduledStartAt)}`:'';meta.textContent=`${nativeApiBulkChannelLabel(s.channel||nativeApiBulkPlatformFilter)} · 成功 ${Number(c.sent||0)} · 失败 ${Number(c.failed||0)} · 等待 ${Number(c.queued||0)}${sched}${s.lastError?` · 最近错误：${s.lastError}`:''}`;}
  const rows=Array.isArray(s.recipients)?s.recipients:[],box=$('#nativeApiBulkResultList');if(box){const active=rows.filter(row=>String(row.status||'')!=='queued'||Number(row.scheduledAt||0)>0||['scheduled','paused'].includes(String(s.status||'')));box.innerHTML=active.length?active.slice(-120).map(row=>`<div class="native-api-bulk-result-row"><div><strong>${escapeHtml(row.displayName||'客户')} · ${escapeHtml(nativeApiBulkChannelLabel(row.channel||row.platform||s.channel))}</strong><small>${row.error?escapeHtml(row.error):(row.sentAt?`完成 ${escapeHtml(formatAggregateTimelineTime(row.sentAt))}`:(row.scheduledAt?`计划 ${escapeHtml(formatAggregateTimelineTime(row.scheduledAt))}`:'等待发送'))}</small></div><span class="native-api-bulk-result-state ${escapeHtml(row.status||'queued')}">${escapeHtml(nativeApiBulkRecipientLabel(row.status))}</span></div>`).join(''):'<div class="native-api-empty">暂无发送记录</div>';}
  const running=String(s.status)==='running',scheduled=String(s.status)==='scheduled',paused=String(s.status)==='paused',busy=running||paused||scheduled;const start=$('#nativeApiBulkStartBtn'),pause=$('#nativeApiBulkPauseBtn'),resume=$('#nativeApiBulkResumeBtn'),cancel=$('#nativeApiBulkCancelBtn');if(start)start.disabled=busy;if(pause)pause.disabled=!(running||scheduled);if(resume)resume.disabled=!paused;if(cancel)cancel.disabled=!busy;
  for(const id of ['nativeApiBulkComposer','nativeApiBulkMinDelay','nativeApiBulkMaxDelay','nativeApiBulkPlatform','nativeApiBulkFacebookAccount','nativeApiBulkCrmStage','nativeApiBulkSendMode','nativeApiBulkScheduleAt']){const node=$('#'+id);if(node)node.disabled=busy;}const selectVisible=$('#nativeApiBulkSelectVisibleBtn');if(selectVisible)selectVisible.disabled=busy;document.querySelectorAll('.native-api-bulk-checkbox').forEach(node=>{node.disabled=busy;});document.querySelectorAll('[data-native-api-bulk-stage-group]').forEach(node=>{node.disabled=busy;});document.querySelectorAll('[data-native-api-bulk-line-group]').forEach(node=>{node.disabled=busy;});
}
async function nativeApiBulkPoll({quiet=true}={}){
  try{const s=await nativeApiAction('native-api-bulk-state');nativeApiBulkRenderRuntime(s);if(!quiet&&s?.status)nativeApiSetStatus(`群发：${nativeApiBulkStatusLabel(s.status)}`);return s;}catch(error){if(!quiet)nativeApiSetStatus('群发状态读取失败：'+(error?.message||error));return null;}
}
function nativeApiBulkStartPolling(){if(nativeApiBulkPollTimer)clearInterval(nativeApiBulkPollTimer);nativeApiBulkPollTimer=setInterval(()=>{const modal=$('#nativeApiBulkModal');if(!modal||modal.classList.contains('hidden')){clearInterval(nativeApiBulkPollTimer);nativeApiBulkPollTimer=null;return;}nativeApiBulkPoll({quiet:true}).catch(()=>{});},700);}
async function openNativeApiBulkModal(options={}){
  const current=await nativeApiBulkPoll({quiet:true});const busy=['running','paused','scheduled'].includes(String(current?.status||''));const requestedChannel=String(options?.channel||'').toLowerCase(),channel=busy?String(current?.channel||'line'):(['line','telegram','whatsapp','facebook'].includes(requestedChannel)?requestedChannel:'line');nativeApiBulkPlatformFilter=['line','telegram','whatsapp','facebook'].includes(channel)?channel:'line';
  nativeApiBulkFacebookAccountFilter=!busy&&String(options?.facebookAccountId||'all').trim()?String(options?.facebookAccountId||'all').trim():'all';
  const requestedGroup=String(options?.stageGroup||'');nativeApiBulkStageGroupFilter=!busy&&NATIVE_API_STAGE_GROUPS.some(group=>group.id===requestedGroup)?requestedGroup:'';
  const requestedLineGroup=String(options?.lineGroup||'all');nativeApiBulkLineGroupFilter=!busy&&['all',...LINE_LIFECYCLE_GROUPS.map(group=>group.id)].includes(requestedLineGroup)?requestedLineGroup:'all';
  if($('#nativeApiBulkPlatform'))$('#nativeApiBulkPlatform').value=nativeApiBulkPlatformFilter;if($('#nativeApiBulkComposer')&&busy)$('#nativeApiBulkComposer').value=String(current?.message||'');
  if($('#nativeApiBulkSendMode'))$('#nativeApiBulkSendMode').value=busy&&String(current?.mode)==='scheduled'?'scheduled':'immediate';if($('#nativeApiBulkScheduleAt')&&!$('#nativeApiBulkScheduleAt').value)$('#nativeApiBulkScheduleAt').value=nativeApiBulkLocalDateTimeValue();nativeApiBulkUpdateScheduleUi();
  nativeApiBulkSearchText='';if($('#nativeApiBulkSearch'))$('#nativeApiBulkSearch').value='';nativeApiBulkSelectedKeys=busy?new Set((current?.recipients||[]).map(row=>String(row?.key||'')).filter(Boolean)):new Set();
  await nativeApiBulkLoadChannelCustomers(nativeApiBulkPlatformFilter,{refresh:!busy,keepSelection:busy}).catch(()=>{});await openModal('nativeApiBulkModal');nativeApiBulkStartPolling();nativeApiBulkRenderRuntime(current);
}
async function startNativeApiBulkSend(){
  const text=String($('#nativeApiBulkComposer')?.value||'').trim();if(!text){nativeApiSetStatus('请先输入群发内容');$('#nativeApiBulkComposer')?.focus();return;}const channel=String($('#nativeApiBulkPlatform')?.value||nativeApiBulkPlatformFilter||'line');
  const targets=(nativeApiBulkCustomerItems||[]).filter(item=>nativeApiBulkSelectedKeys.has(nativeApiBulkCustomerKey(item))).map(item=>({...item,channel,platform:channel}));if(!targets.length){nativeApiSetStatus(`请至少勾选 1 位 ${nativeApiBulkChannelLabel(channel)} 客户`);return;}
  const min=Math.max(5,Math.min(3600,Math.round(Number($('#nativeApiBulkMinDelay')?.value||15)||15))),max=Math.max(min,Math.min(3600,Math.round(Number($('#nativeApiBulkMaxDelay')?.value||45)||45)));if($('#nativeApiBulkMinDelay'))$('#nativeApiBulkMinDelay').value=String(min);if($('#nativeApiBulkMaxDelay'))$('#nativeApiBulkMaxDelay').value=String(max);
  const mode=String($('#nativeApiBulkSendMode')?.value||'immediate')==='scheduled'?'scheduled':'immediate';let scheduledStartAt=0;if(mode==='scheduled'){const raw=String($('#nativeApiBulkScheduleAt')?.value||'');scheduledStartAt=raw?new Date(raw).getTime():0;if(!Number.isFinite(scheduledStartAt)||scheduledStartAt<=Date.now()+1000){nativeApiSetStatus('请选择晚于当前时间的定时发送时间');$('#nativeApiBulkScheduleAt')?.focus();return;}}
  const groupLabel=channel==='line'?nativeApiBulkLineGroupLabel(nativeApiBulkLineGroupFilter):nativeApiBulkStageGroupLabel(nativeApiBulkStageGroupFilter),groupText=groupLabel?` · ${groupLabel}分组`:'';const btn=$('#nativeApiBulkStartBtn');if(btn)btn.disabled=true;try{const result=await nativeApiAction('native-api-bulk-start',{channel,targets,text,minDelaySec:min,maxDelaySec:max,mode,scheduledStartAt});nativeApiBulkRenderRuntime(result);nativeApiSetStatus(mode==='scheduled'?`${nativeApiBulkChannelLabel(channel)}${groupText} 定时群发已创建 · ${targets.length} 位 · ${nativeApiBulkFormatSchedule(scheduledStartAt)}`:`${nativeApiBulkChannelLabel(channel)}${groupText} 群发已开始 · ${targets.length} 位 · 随机间隔 ${min}-${max} 秒`);}catch(error){nativeApiSetStatus('群发启动失败：'+(error?.message||error));}finally{const s=nativeApiBulkRuntimeState;if(btn)btn.disabled=['running','paused','scheduled'].includes(String(s?.status||''));}
}

function renderNativeApiChatHead() {
  nativeApiV254Perf.render.chatHead+=1;
  const target=nativeApiSelected; syncNativeApiChatAvatar(target||null);
  const dayBadge=$('#nativeApiCustomerDayBadge');
  if(!target){if($('#nativeApiChatName'))$('#nativeApiChatName').textContent='请选择客户';if($('#nativeApiChatMeta'))$('#nativeApiChatMeta').textContent='Facebook / LINE 官方 API 客户会显示在这里';if(dayBadge){dayBadge.innerHTML='<option value="">--</option>';dayBadge.value='';dayBadge.className='native-api-customer-day-badge hidden';}if($('#nativeApiChatState')){$('#nativeApiChatState').textContent='未选择';$('#nativeApiChatState').classList.remove('waiting');}return;}
  if($('#nativeApiChatName'))$('#nativeApiChatName').textContent=target.displayName||'客户';
  if(dayBadge){
    const day=nativeApiCustomerDayNumber(target),manual=customerDayCalibrationRecord(target,'native'),autoFirst=nativeApiFirstIncomingAt(target);
    let autoDay=0;if(autoFirst){const current=nativeApiBusinessDayOrdinalJst(Date.now()),started=nativeApiBusinessDayOrdinalJst(autoFirst);if(Number.isFinite(current)&&Number.isFinite(started)&&current>=started)autoDay=current-started+1;}
    const selected=manual?String(Math.min(10,Math.max(1,day))):'';
    const options=[`<option value="" ${selected?'':'selected'}>${escapeHtml(autoDay?`自动 · ${customerDayLabel(autoDay)}`:'自动判断')}</option>`];
    for(let n=1;n<=10;n++){let label=n===10?'第10天':`第${n}天`;if(manual&&String(n)===selected)label=`${customerDayLabel(day)} · 已校准`;options.push(`<option value="${n}" ${String(n)===selected?'selected':''}>${escapeHtml(label)}</option>`);}
    dayBadge.innerHTML=options.join('');dayBadge.value=selected;dayBadge.className=`native-api-customer-day-badge ${day>10?'plus':day>=8?'late':day>=4?'mid':day>=1?'early':'pending'}`;dayBadge.title=day?`${customerDayLabel(day)} · 可手动校准；之后按日本时间05:00自动进入下一天`:'正在核对客户首次来信时间，可手动校准';
  }
  if($('#nativeApiChatMeta'))$('#nativeApiChatMeta').textContent=`${nativeApiPlatformLabel(target.platform)} · ${target.accountName||'官方 API'} · ${String(target.remoteId||'').slice(-10)}`;
  if($('#nativeApiChatState')){$('#nativeApiChatState').textContent=nativeApiAwaitingReply(target)?'待回复':(nativeApiManualReadActive(target)?'已读':'已回复');$('#nativeApiChatState').classList.toggle('waiting',nativeApiAwaitingReply(target));}
}

function nativeApiMessageIdentity(row={}) { return String(row.id||row.eventKey||row.messageId||''); }
function nativeApiTranslationKeyFor(selectionKey,row={}) { return `${selectionKey}|${nativeApiMessageIdentity(row)}|${String(row.text||'')}`; }
function nativeApiTranslationKey(row = {}) { return nativeApiTranslationKeyFor(nativeApiKey(nativeApiSelected||{}),row); }
function nativeApiTranslationSettings() { return state?.config?.translation || {}; }
function nativeApiTranslationEnabled() { const t=nativeApiTranslationSettings(); return t.inlineEnabled!==false&&String(t.engine||'none')!=='none'; }
function nativeApiVpsDeepLFastLaneReady() {
  const t=nativeApiTranslationSettings();
  const team=state?.config?.teamSync||{};
  // V1.27.132 root-cause fix: desktop config intentionally keeps engine=ollama
  // because Ollama is the fallback, while the real incoming primary is the VPS
  // DeepL gateway. Use the actual Team/VPS configuration as authority so a
  // disconnected gateway still falls back to safe Ollama single-flight behavior.
  return t?.gatewayPrimaryV127130!==false && t?.vpsGatewayEnabled!==false && team?.enabled===true &&
    !!String(team?.cloudflarePublicUrl||team?.serverUrl||'').trim() && !!String(team?.teamId||'').trim() && !!String(team?.apiKey||'').trim();
}
function nativeApiCloudFastLaneEngine() { return ['googleweb','google','deepl','mymemory','libre'].includes(String(nativeApiTranslationSettings()?.engine||'').toLowerCase()) || nativeApiVpsDeepLFastLaneReady(); }
function nativeApiServerPreTranslationCacheFirstEnabled() {
  const t=nativeApiTranslationSettings();
  return t?.serverPreTranslationV127133!==false && nativeApiVpsDeepLFastLaneReady();
}
function nativeApiTranslationConcurrency() {
  const engine=String(nativeApiTranslationSettings()?.engine||'').toLowerCase();
  const explicitCloud=['googleweb','google','deepl','mymemory','libre'].includes(engine);
  // V1.27.185: when the urgent first-paint lane is active, background history
  // yields one worker so a fresh customer bubble is not competing with two old
  // history rows for the same gateway/provider. Once the urgent lane drains,
  // the normal background concurrency is restored automatically.
  if(typeof nativeApiTranslationFirstPaintPromise!=='undefined'&&nativeApiTranslationFirstPaintPromise){
    if(explicitCloud)return 2;
    if(nativeApiVpsDeepLFastLaneReady())return 1;
  }
  // Preserve V1.27.107's direct-cloud concurrency=3. For the V1.27.131 VPS
  // DeepL gateway specifically, reserve one dedicated first-paint lane and let
  // only two background workers chew through old history.
  if(explicitCloud)return 3;
  if(nativeApiVpsDeepLFastLaneReady())return 2;
  if(engine==='ollama')return 1;
  return 2;
}
function nativeApiTranslationCandidate(row={}) {
  if(!row)return false;
  const mine=String(row.role||'')==='me'||String(row.direction||'')==='outgoing';
  if(mine && nativeApiTranslationSettings()?.ollamaTranslateOutgoing===false)return false;
  const text=String(row.text||'').trim();
  return !!text&&!/^\[(?:image|video|audio|file|location|sticker|message:)/i.test(text);
}
let nativeApiProgrammaticScrollUntil = 0;
function captureNativeApiMessageViewport(box) {
  if(!box)return { nearBottom:true, scrollTop:0, anchorId:'', anchorOffset:0 };
  const gap=Math.max(0,Number(box.scrollHeight||0)-Number(box.scrollTop||0)-Number(box.clientHeight||0));
  const viewport=box.getBoundingClientRect?.();
  let anchorId='',anchorOffset=0;
  if(viewport){
    const rows=Array.from(box.querySelectorAll?.('[data-native-api-message-id]')||[]);
    for(const node of rows){
      const rect=node.getBoundingClientRect?.();
      if(!rect)continue;
      if(rect.bottom>viewport.top+1&&rect.top<viewport.bottom-1){anchorId=String(node.dataset?.nativeApiMessageId||'');anchorOffset=rect.top-viewport.top;break;}
    }
  }
  return { nearBottom:gap<120, scrollTop:Math.max(0,Number(box.scrollTop||0)), anchorId, anchorOffset };
}
function restoreNativeApiMessageViewport(box,snapshot,{keepBottom=true}={}) {
  if(!box||!snapshot)return;
  nativeApiProgrammaticScrollUntil=(typeof performance!=='undefined'?performance.now():Date.now())+120;
  if(keepBottom&&snapshot.nearBottom){box.scrollTop=Math.max(0,Number(box.scrollHeight||0));return;}
  if(snapshot.anchorId){
    const viewport=box.getBoundingClientRect?.();
    const anchor=Array.from(box.querySelectorAll?.('[data-native-api-message-id]')||[]).find(node=>String(node.dataset?.nativeApiMessageId||'')===snapshot.anchorId);
    const rect=anchor?.getBoundingClientRect?.();
    if(viewport&&rect){
      const delta=(rect.top-viewport.top)-Number(snapshot.anchorOffset||0);
      if(Math.abs(delta)>0.5)box.scrollTop=Math.max(0,Number(box.scrollTop||0)+delta);
      return;
    }
  }
  box.scrollTop=Math.max(0,Number(snapshot.scrollTop||0));
}

function nativeApiMessageMedia(row={}) {
  return (Array.isArray(row?.media)?row.media:[]).filter(item=>item&&typeof item==='object').slice(0,12);
}
function nativeApiMediaImageUrl(item={}) {
  const url=String(item?.previewUrl||item?.url||'').trim();
  return /^(?:https?:\/\/|data:image\/|blob:)/i.test(url)?url:'';
}
function nativeApiMediaOriginalText(row={}) {
  const value=String(row?.text||'').trim();
  if(nativeApiMessageMedia(row).length&&/^[［\[](?:图片|image|附件|attachment)[］\]]$/i.test(value))return '';
  return value;
}
function ensureNativeApiMediaPreview() {
  let overlay=document.querySelector('#nativeApiMediaPreview');
  if(overlay)return overlay;
  overlay=document.createElement('div');
  overlay.id='nativeApiMediaPreview';overlay.className='native-api-media-preview hidden';
  overlay.innerHTML='<button class="native-api-media-preview-close" type="button" aria-label="关闭">×</button><div class="native-api-media-preview-stage"><img alt="Messenger 图片预览" /></div><div class="native-api-media-preview-name"></div>';
  document.body.appendChild(overlay);
  const close=()=>overlay.classList.add('hidden');
  overlay.querySelector('.native-api-media-preview-close')?.addEventListener('click',close);
  overlay.addEventListener('click',event=>{if(event.target===overlay)close();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!overlay.classList.contains('hidden'))close();});
  return overlay;
}
function openNativeApiMediaPreview(url='',name='') {
  const safe=String(url||'').trim();if(!/^(?:https?:\/\/|data:image\/|blob:)/i.test(safe))return;
  const overlay=ensureNativeApiMediaPreview();const img=overlay.querySelector('img');if(img)img.src=safe;
  const label=overlay.querySelector('.native-api-media-preview-name');if(label)label.textContent=String(name||'');
  overlay.classList.remove('hidden');
}
function nativeApiMediaMarkup(row={}) {
  const items=nativeApiMessageMedia(row);if(!items.length)return '';
  const images=items.filter(item=>String(item?.type||'').toLowerCase()==='image'&&nativeApiMediaImageUrl(item));
  const files=items.filter(item=>!images.includes(item));
  let html='';
  if(images.length){
    html+=`<div class="native-api-message-media-grid ${images.length===1?'single':''}">${images.map((item,index)=>{const url=nativeApiMediaImageUrl(item);const name=String(item?.name||`图片 ${index+1}`);return `<button type="button" class="native-api-media-thumb" data-native-api-media-url="${escapeHtml(url)}" data-native-api-media-name="${escapeHtml(name)}"><img loading="lazy" src="${escapeHtml(url)}" alt="${escapeHtml(name)}" /></button>`;}).join('')}</div>`;
  }
  if(files.length){
    html+=`<div class="native-api-message-file-list">${files.map(item=>`<div class="native-api-message-file-chip">${escapeHtml(item?.name||({video:'［视频］',audio:'［音频］',file:'［文件］'}[String(item?.type||'').toLowerCase()]||'［附件］'))}</div>`).join('')}</div>`;
  }
  return html;
}
function nativeApiMessageVirtualHeight(row={}) {
  const key=`${nativeApiKey(nativeApiSelected||{})}|${nativeApiMessageIdentity(row)}`;
  return Math.max(28,Number(nativeApiMessageVirtualHeights.get(key)||nativeApiMessageVirtualAverageHeight||72));
}
function nativeApiMessageVirtualRange(box,snapshot,{keepBottom=true}={}) {
  const total=nativeApiMessages.length;
  const selectionKey=nativeApiKey(nativeApiSelected||{});
  if(selectionKey!==nativeApiMessageVirtualSelectionKey){nativeApiMessageVirtualSelectionKey=selectionKey;nativeApiMessageVirtualRangeKey='';}
  if(total<=NATIVE_API_MESSAGE_VIRTUAL_THRESHOLD)return {virtual:false,start:0,end:total,top:0,bottom:0,key:`${selectionKey}|0:${total}`};
  let anchorIndex=-1;
  if(snapshot?.anchorId)anchorIndex=nativeApiMessages.findIndex(row=>nativeApiMessageIdentity(row)===String(snapshot.anchorId||''));
  let start=0,end=total;
  if(keepBottom&&snapshot?.nearBottom){end=total;start=Math.max(0,end-NATIVE_API_MESSAGE_VIRTUAL_WINDOW);}
  else if(anchorIndex>=0){start=Math.max(0,anchorIndex-NATIVE_API_MESSAGE_VIRTUAL_OVERSCAN);end=Math.min(total,start+NATIVE_API_MESSAGE_VIRTUAL_WINDOW);start=Math.max(0,end-NATIVE_API_MESSAGE_VIRTUAL_WINDOW);}
  else{
    const targetTop=Math.max(0,Number(box?.scrollTop||snapshot?.scrollTop||0));let sum=0,index=0;
    while(index<total&&sum+nativeApiMessageVirtualHeight(nativeApiMessages[index])<targetTop){sum+=nativeApiMessageVirtualHeight(nativeApiMessages[index]);index++;}
    start=Math.max(0,index-NATIVE_API_MESSAGE_VIRTUAL_OVERSCAN);end=Math.min(total,start+NATIVE_API_MESSAGE_VIRTUAL_WINDOW);start=Math.max(0,end-NATIVE_API_MESSAGE_VIRTUAL_WINDOW);
  }
  let top=0,bottom=0;for(let i=0;i<start;i++)top+=nativeApiMessageVirtualHeight(nativeApiMessages[i]);for(let i=end;i<total;i++)bottom+=nativeApiMessageVirtualHeight(nativeApiMessages[i]);
  return {virtual:true,start,end,top,bottom,key:`${selectionKey}|${start}:${end}`};
}
function scheduleNativeApiMessageVirtualRender(){
  if(nativeApiMessages.length<=NATIVE_API_MESSAGE_VIRTUAL_THRESHOLD||nativeApiMessageVirtualScrollRaf)return;
  const now=(typeof performance!=='undefined'?performance.now():Date.now());if(now<nativeApiProgrammaticScrollUntil)return;
  const flush=()=>{nativeApiMessageVirtualScrollRaf=0;renderNativeApiMessages({keepBottom:false,virtualScroll:true});};
  try{nativeApiMessageVirtualScrollRaf=requestAnimationFrame(flush);}catch{nativeApiMessageVirtualScrollRaf=setTimeout(flush,16);}
}
function renderNativeApiMessages({ keepBottom=true, virtualScroll=false } = {}) {
  const box=$('#nativeApiMessages'); if(!box)return;
  if(!nativeApiSelected){nativeApiMessageVirtualRangeKey='';box.innerHTML='<div class="native-api-chat-placeholder"><strong>官方 API 原生聊天</strong><span>选择左侧客户后直接读取 VPS SQLite 历史，不再切换 Meta Business 或 LINE 网页。</span></div>';return;}
  const viewportSnapshot=captureNativeApiMessageViewport(box);
  if(!nativeApiMessages.length){nativeApiMessageVirtualRangeKey='';box.innerHTML='<div class="native-api-chat-placeholder"><strong>还没有文字聊天</strong><span>客户发来第一条消息后会自动出现在这里。</span></div>';return;}
  const range=nativeApiMessageVirtualRange(box,viewportSnapshot,{keepBottom});
  if(virtualScroll&&range.key===nativeApiMessageVirtualRangeKey)return;
  nativeApiMessageVirtualRangeKey=range.key;
  const rows=nativeApiMessages.slice(range.start,range.end);
  const topSpacer=range.virtual&&range.top>0?`<div class="native-api-message-virtual-spacer" style="height:${Math.round(range.top)}px" aria-hidden="true"></div>`:'';
  const bottomSpacer=range.virtual&&range.bottom>0?`<div class="native-api-message-virtual-spacer" style="height:${Math.round(range.bottom)}px" aria-hidden="true"></div>`:'';
  nativeApiV254Perf.render.messageFull+=1;nativeApiV254Perf.render.last={at:Date.now(),type:'message-full',rows:rows.length};
  box.innerHTML=topSpacer+rows.map(row=>{
    const mine=String(row.role||'')==='me'||String(row.direction||'')==='outgoing'; const translation=nativeApiTranslationCache.get(nativeApiTranslationKey(row)); let translated='';
    if(translation?.status==='loading')translated='<div class="native-api-message-translation loading">正在翻译…</div>';
    else if(translation?.status==='ok'&&translation.text&&translation.text!==row.text)translated=`<div class="native-api-message-translation">${escapeHtml(translation.text)}</div>`;
    else if(translation?.status==='error')translated=`<div class="native-api-message-translation error"><button type="button" data-native-api-retranslate="${escapeHtml(nativeApiMessageIdentity(row))}" title="${escapeHtml(translation.error||'翻译失败')}">${escapeHtml(translation.label||'翻译失败 · 点击重试')}</button></div>`;
    const original=nativeApiMediaOriginalText(row);const media=nativeApiMediaMarkup(row);
    const receipt=mine&&String(row.platform||nativeApiSelected?.platform||'').toLowerCase()==='facebook'
      ? (row.deliveryStatus==='read'?' · 已读':row.deliveryStatus==='delivered'?' · 已送达':' · 状态未知') : '';
    return `<div class="native-api-message-row ${mine?'me':'customer'}" data-native-api-message-id="${escapeHtml(nativeApiMessageIdentity(row))}"><div class="native-api-message-bubble">${original?`<div class="native-api-message-original">${escapeHtml(original)}</div>`:''}${media}${translated}<div class="native-api-message-meta">${escapeHtml(formatNativeApiTimelineTime(row.timestampMs||0))}${escapeHtml(receipt)}</div></div></div>`;
  }).join('')+bottomSpacer;
  restoreNativeApiMessageViewport(box,viewportSnapshot,{keepBottom});
  if(range.virtual){
    try{
      let measuredTotal=0,measuredCount=0;
      for(const node of Array.from(box.querySelectorAll('[data-native-api-message-id]'))){
        const id=String(node.dataset.nativeApiMessageId||'');if(!id)continue;
        const h=Math.max(28,node.getBoundingClientRect().height+8);const key=`${nativeApiKey(nativeApiSelected||{})}|${id}`;nativeApiMessageVirtualHeights.set(key,h);measuredTotal+=h;measuredCount++;
      }
      if(measuredCount){const sample=measuredTotal/measuredCount;nativeApiMessageVirtualAverageHeight=Math.max(44,Math.min(220,nativeApiMessageVirtualAverageHeight*0.7+sample*0.3));}
      if(nativeApiMessageVirtualHeights.size>1200){let drop=nativeApiMessageVirtualHeights.size-1000;for(const key of nativeApiMessageVirtualHeights.keys()){nativeApiMessageVirtualHeights.delete(key);if(--drop<=0)break;}}
    }catch{}
  }
}

function scheduleNativeApiTranslationRender() {
  if(nativeApiTranslationRenderScheduled)return;
  nativeApiTranslationRenderScheduled=true;
  const flush=()=>{nativeApiTranslationRenderScheduled=false;renderNativeApiMessages({keepBottom:false});};
  try{requestAnimationFrame(flush);}catch{setTimeout(flush,16);}
}
let nativeApiTranslatedCrmTimer=null;
function scheduleNativeApiTranslatedCrmExtract(delay=260){
  if(nativeApiTranslatedCrmTimer)clearTimeout(nativeApiTranslatedCrmTimer);
  const selection=nativeApiSelected?{...nativeApiSelected}:null;
  const selectionKey=nativeApiKey(selection||{});
  if(!selection||!selectionKey)return;
  nativeApiTranslatedCrmTimer=setTimeout(async()=>{
    nativeApiTranslatedCrmTimer=null;
    if(!nativeApiSelected||nativeApiKey(nativeApiSelected)!==selectionKey)return;
    const messages=nativeApiMessages.slice(-60).map(row=>{
      const state=nativeApiTranslationCache.get(nativeApiTranslationKeyFor(selectionKey,row));
      const translatedText=state?.status==='ok'?String(state.text||'').trim():'';
      return {...row,translatedText};
    });
    if(!messages.some(row=>((String(row.role||'')!=='me'&&String(row.direction||'')!=='outgoing')&&String(row.translatedText||'').trim())))return;
    try{await nativeApiAction('native-api-crm-extract-translated',{target:selection,messages});}catch{}
  },Math.max(120,Number(delay)||260));
}

function nativeApiApplyPersistentTranslations(items, selectionKey=nativeApiKey(nativeApiSelected||{})) {
  if(!selectionKey)return 0;
  const byId=new Map(nativeApiMessages.map(row=>[nativeApiMessageIdentity(row),row]));
  let changed=0;
  for(const hit of Array.isArray(items)?items:[]){
    if(!hit?.hit||!String(hit.translated||'').trim())continue;
    const row=byId.get(String(hit.id||''));if(!row)continue;
    const key=nativeApiTranslationKeyFor(selectionKey,row);
    nativeApiTranslationCache.set(key,{status:'ok',text:String(hit.translated).trim(),tier:String(hit.tier||'persistent')});
    changed++;
  }
  if(changed)scheduleNativeApiTranslatedCrmExtract(180);
  return changed;
}
function nativeApiTranslationContext(row={}) {
  const text=String(row?.text||'').trim();
  // V1.27.108: context is a quality fast-path only for short/chat-sensitive
  // messages. Long/self-contained messages stay on the zero-extra-work lane.
  if(!text||text.length>56)return [];
  const id=nativeApiMessageIdentity(row);const index=nativeApiMessages.findIndex(item=>nativeApiMessageIdentity(item)===id);
  if(index<=0)return [];
  return nativeApiMessages.slice(Math.max(0,index-3),index).map(item=>({
    role:(String(item.role||'')==='me'||String(item.direction||'')==='outgoing')?'me':'customer',
    text:String(item.text||'').trim().slice(0,500)
  })).filter(item=>item.text&&nativeApiTranslationCandidate({text:item.text})).slice(-3);
}
function nativeApiTranslationPriorityRows() {
  const candidates=nativeApiMessages.filter(nativeApiTranslationCandidate).slice().reverse();
  if(!candidates.length)return [];
  const box=$('#nativeApiMessages');if(!box)return candidates;
  const rect=box.getBoundingClientRect?.();if(!rect)return candidates;
  const minY=rect.top-220,maxY=rect.bottom+220,visible=new Set();
  box.querySelectorAll('[data-native-api-message-id]').forEach(node=>{const r=node.getBoundingClientRect?.();if(r&&r.bottom>=minY&&r.top<=maxY)visible.add(String(node.dataset.nativeApiMessageId||''));});
  if(!visible.size)return candidates;
  // Visible newest first, then continue monotonically upward through all history.
  const hot=candidates.filter(row=>visible.has(nativeApiMessageIdentity(row)));
  const cold=candidates.filter(row=>!visible.has(nativeApiMessageIdentity(row)));
  return hot.concat(cold);
}

function nativeApiVisibleTranslationRows() {
  // Compatibility alias retained for older diagnostics/tests. V1.27.108's
  // real scheduler owns the full newest->oldest conversation queue.
  return nativeApiTranslationPriorityRows().slice(0,10);
}
async function nativeApiPrimeTranslationCache(rows,selectionKey,generation,{allowBusy=false,allowLoading=false,forceVps=false}={}) {
  const t=nativeApiTranslationSettings(); const source=String(t.inlineSource||'auto'),target=String(t.inlineTarget||'zh');
  const pending=rows.filter(row=>{
    const key=nativeApiTranslationKeyFor(selectionKey,row),stateRow=nativeApiTranslationCache.get(key);
    const cacheBlocks=stateRow && !(allowLoading&&stateRow.status==='loading');
    const mine=String(row.role||'')==='me'||String(row.direction||'')==='outgoing';
    return !mine&&nativeApiTranslationCandidate(row)&&!cacheBlocks&&(allowBusy||!nativeApiTranslationBusy.has(key));
  });
  if(!pending.length)return {hits:0,attempted:0};
  try{
    // V1.27.134: server pre-translation is cache-first. The old DeepL fast-lane
    // used preferSpeed=true, which intentionally skipped the VPS shared-cache
    // lookup. That made a just-pretranslated message fall through to another
    // client/provider request. Force a real shared-cache probe before fallback.
    const preferSpeed=forceVps||nativeApiServerPreTranslationCacheFirstEnabled()?false:nativeApiCloudFastLaneEngine();
    const result=await nativeApiAction('native-api-translation-cache-batch',{items:pending.slice(0,32).map(row=>({id:nativeApiMessageIdentity(row),text:String(row.text||'').trim(),source,target})),preferSpeed});
    if(generation!==nativeApiTranslationGeneration||nativeApiKey(nativeApiSelected||{})!==selectionKey)return {hits:0,attempted:pending.length,stale:true};
    const byId=new Map(pending.map(row=>[nativeApiMessageIdentity(row),row])); let changed=false,hits=0;
    for(const hit of Array.isArray(result?.items)?result.items:[]){if(!hit?.hit||!String(hit.translated||'').trim())continue;const row=byId.get(String(hit.id||''));if(!row)continue;nativeApiTranslationCache.set(nativeApiTranslationKeyFor(selectionKey,row),{status:'ok',text:String(hit.translated).trim(),tier:String(hit.tier||'cache')});changed=true;hits++;}
    if(changed)scheduleNativeApiTranslationRender();
    return {hits,attempted:pending.length};
  }catch{return {hits:0,attempted:pending.length,error:true};}
}
async function nativeApiTranslateOne(row, selectionKey, generation, { force=false, cacheFirstChecked=false, urgentFirstPaint=false } = {}) {
  if(!nativeApiTranslationEnabled()||generation!==nativeApiTranslationGeneration||nativeApiKey(nativeApiSelected||{})!==selectionKey)return {source:'skipped'};
  if(!nativeApiTranslationCandidate(row))return {source:'skipped'}; const sourceText=String(row.text||'').trim();
  const mine=String(row.role||'')==='me'||String(row.direction||'')==='outgoing';
  const t=nativeApiTranslationSettings(); const source=mine?'ja':String(t.inlineSource||'auto'); const target=String(t.inlineTarget||'zh');
  const key=nativeApiTranslationKeyFor(selectionKey,row); if(!force&&(nativeApiTranslationCache.has(key)||nativeApiTranslationBusy.has(key)))return {source:'coalesced'};
  nativeApiTranslationBusy.add(key);nativeApiTranslationCache.set(key,{status:'loading',text:''});scheduleNativeApiTranslationRender();
  let cacheProbeMs=0;
  try{
    // V1.27.134: before any client-side provider fallback, give the VPS
    // pre-translation/shared-cache path first ownership. This probe is bounded
    // and exactly-once protected by nativeApiTranslationBusy. A tiny second
    // probe catches the common race where webhook pre-translation finishes just
    // after the conversation history was opened.
    if(!mine&&!force&&!cacheFirstChecked&&!urgentFirstPaint&&nativeApiServerPreTranslationCacheFirstEnabled()){
      const probeStarted=nativeApiTranslationNowMs();
      await nativeApiPrimeTranslationCache([row],selectionKey,generation,{allowBusy:true,allowLoading:true,forceVps:true});
      let restored=nativeApiTranslationCache.get(key);
      if(restored?.status!=='ok'&&generation===nativeApiTranslationGeneration&&nativeApiKey(nativeApiSelected||{})===selectionKey){
        await new Promise(resolve=>setTimeout(resolve,180));
        await nativeApiPrimeTranslationCache([row],selectionKey,generation,{allowBusy:true,allowLoading:true,forceVps:true});
        restored=nativeApiTranslationCache.get(key);
      }
      cacheProbeMs=Math.max(0,Math.round(nativeApiTranslationNowMs()-probeStarted));
      if(restored?.status==='ok')return {source:'pretranslated-cache',cacheProbeMs};
    }
    // V1.27.89: do NOT race an extra renderer timeout against the IPC. Main
    // process already owns the real provider deadline. Racing here creates an
    // orphaned Ollama request that keeps consuming the global single-flight
    // queue after the UI has already moved on.
    // V1.27.185: urgent first paint must not pay for the old two-step shared
    // cache probe before the provider request. /api/translation/translate is
    // itself cache-aware (shared SQLite hit first, DeepL only on a miss), so the
    // separate probe merely duplicated network latency. Background/history
    // translation still keeps the V1.27.134 cache-first batch path above.
    if(urgentFirstPaint&&!mine&&nativeApiServerPreTranslationCacheFirstEnabled()){
      nativeApiTranslationFirstPaintStats.skippedRedundantCacheProbeCount++;
      nativeApiTranslationFirstPaintStats.directGatewayCount++;
    }
    const context=mine?[]:nativeApiTranslationContext(row);
    const providerStarted=nativeApiTranslationNowMs();
    const translated=await window.yoko.translate?.({text:sourceText,direction:mine?'outgoing':'incoming',localOnly:mine,source,target,accountId:String(nativeApiSelected?.accountId||''),context,inlineFast:true,skipSharedCache:mine?true:nativeApiCloudFastLaneEngine(),bypassCache:force});
    const providerElapsedMs=Math.max(0,Math.round(nativeApiTranslationNowMs()-providerStarted));
    if(nativeApiKey(nativeApiSelected||{})!==selectionKey||generation!==nativeApiTranslationGeneration)return {source:'stale',cacheProbeMs,providerElapsedMs};
    const value=String(translated||'').trim();nativeApiTranslationCache.set(key,{status:'ok',text:value||sourceText});
    scheduleNativeApiTranslatedCrmExtract(220);
    return {source:'client-provider',cacheProbeMs,providerElapsedMs};
  }catch(error){
    if(generation===nativeApiTranslationGeneration&&nativeApiKey(nativeApiSelected||{})===selectionKey){const message=String(error?.message||error||'翻译失败');nativeApiTranslationCache.set(key,{status:'error',text:'',error:message,label:/超时/.test(message)?'翻译超时 · 点击重试':'翻译失败 · 点击重试'});}
    return {source:'error',cacheProbeMs,error:String(error?.message||error||'翻译失败')};
  }finally{nativeApiTranslationBusy.delete(key);if(generation===nativeApiTranslationGeneration&&nativeApiKey(nativeApiSelected||{})===selectionKey)scheduleNativeApiTranslationRender();}
}
function nativeApiTranslationNowMs(){
  try{return performance.now();}catch{return Date.now();}
}
function scheduleNativeApiTranslationFirstPaint(reason='update') {
  if(!nativeApiTranslationEnabled()||!nativeApiSelected||!nativeApiMessages.length)return Promise.resolve(false);
  nativeApiTranslationFirstPaintStats.requestedCount++;
  nativeApiTranslationFirstPaintRequestedAt=nativeApiTranslationNowMs();
  nativeApiTranslationFirstPaintReason=String(reason||'update');
  nativeApiTranslationFirstPaintReschedule=true;
  if(nativeApiTranslationFirstPaintPromise)return nativeApiTranslationFirstPaintPromise;

  nativeApiTranslationFirstPaintPromise=(async()=>{
    let translatedAny=false;
    while(nativeApiTranslationFirstPaintReschedule){
      nativeApiTranslationFirstPaintReschedule=false;
      const selectionKey=nativeApiKey(nativeApiSelected||{}),generation=nativeApiTranslationGeneration;
      if(!selectionKey||!nativeApiMessages.length)break;
      const row=nativeApiTranslationPriorityRows().find(candidate=>{
        const key=nativeApiTranslationKeyFor(selectionKey,candidate);
        return nativeApiTranslationCandidate(candidate)&&!nativeApiTranslationCache.has(key)&&!nativeApiTranslationBusy.has(key);
      });
      if(!row)break;
      const messageId=nativeApiMessageIdentity(row);
      const started=nativeApiTranslationNowMs();
      const queueWait=Math.max(0,Math.round(started-Number(nativeApiTranslationFirstPaintRequestedAt||started)));
      nativeApiTranslationFirstPaintStats.startedCount++;
      nativeApiTranslationFirstPaintStats.lastQueueWaitMs=queueWait;
      nativeApiTranslationFirstPaintStats.lastReason=nativeApiTranslationFirstPaintReason;
      nativeApiTranslationFirstPaintStats.lastMessageId=messageId;
      nativeApiTranslationFirstPaintStats.lastAt=Date.now();
      try{
        const outcome=await nativeApiTranslateOne(row,selectionKey,generation,{force:false,urgentFirstPaint:true});
        if(generation!==nativeApiTranslationGeneration||nativeApiKey(nativeApiSelected||{})!==selectionKey)continue;
        const stateRow=nativeApiTranslationCache.get(nativeApiTranslationKeyFor(selectionKey,row));
        const probeMs=Math.max(0,Number(outcome?.cacheProbeMs||0)||0);
        const providerMs=Math.max(0,Number(outcome?.providerElapsedMs||0)||0);
        nativeApiTranslationFirstPaintStats.lastCacheProbeMs=Math.round(probeMs);
        nativeApiTranslationFirstPaintStats.maxCacheProbeMs=Math.max(nativeApiTranslationFirstPaintStats.maxCacheProbeMs,Math.round(probeMs));
        nativeApiTranslationFirstPaintStats.lastProviderMs=Math.round(providerMs);
        nativeApiTranslationFirstPaintStats.maxProviderMs=Math.max(nativeApiTranslationFirstPaintStats.maxProviderMs,Math.round(providerMs));
        if(outcome?.source==='pretranslated-cache')nativeApiTranslationFirstPaintStats.pretranslatedHitCount++;
        else if(outcome?.source==='client-provider')nativeApiTranslationFirstPaintStats.clientFallbackCount++;
        if(stateRow?.status==='ok'){nativeApiTranslationFirstPaintStats.successCount++;translatedAny=true;}
        else if(stateRow?.status==='error')nativeApiTranslationFirstPaintStats.errorCount++;
      }catch{nativeApiTranslationFirstPaintStats.errorCount++;}
      finally{
        const elapsed=Math.max(0,Math.round(nativeApiTranslationNowMs()-started));
        nativeApiTranslationFirstPaintStats.lastElapsedMs=elapsed;
        nativeApiTranslationFirstPaintStats.maxElapsedMs=Math.max(nativeApiTranslationFirstPaintStats.maxElapsedMs,elapsed);
      }
      // Exactly one newest bubble per request. If a still newer message arrived
      // while this request was in flight, reschedule=true makes it go next.
    }
    return translatedAny;
  })().finally(()=>{
    nativeApiTranslationFirstPaintPromise=null;
    if(nativeApiTranslationFirstPaintReschedule)queueMicrotask(()=>scheduleNativeApiTranslationFirstPaint('coalesced-newest'));
  });
  return nativeApiTranslationFirstPaintPromise;
}

function scheduleNativeApiTranslations({force=false,preempt=false}={}) {
  if(!nativeApiTranslationEnabled()||!nativeApiSelected||!nativeApiMessages.length)return Promise.resolve();
  if(preempt)nativeApiTranslationPriorityEpoch++;
  // V1.27.132: start the newest customer bubble immediately BEFORE consulting
  // the existing backlog scheduler. This is the critical first-paint fast lane.
  scheduleNativeApiTranslationFirstPaint(preempt?'preempt-newest':'scheduler-newest').catch(()=>{});
  const selectionKey=nativeApiKey(nativeApiSelected),generation=nativeApiTranslationGeneration,schedulerKey=`${selectionKey}|${generation}`;
  if(nativeApiTranslationScheduler){nativeApiTranslationReschedule=true;return nativeApiTranslationScheduler;}
  nativeApiTranslationSchedulerKey=schedulerKey;nativeApiTranslationReschedule=false;
  const runEpoch=nativeApiTranslationPriorityEpoch;
  nativeApiTranslationScheduler=(async()=>{
    do{
      nativeApiTranslationReschedule=false;
      if(generation!==nativeApiTranslationGeneration||nativeApiKey(nativeApiSelected||{})!==selectionKey)break;
      let rows=nativeApiTranslationPriorityRows();
      // Cache restoration is always attempted before provider work. The select/
      // refresh IPC already returns persistent hits for first paint; this second
      // local batch probe is a cheap safety net for messages added mid-session.
      await nativeApiPrimeTranslationCache(rows.slice(0,64),selectionKey,generation);
      if(generation!==nativeApiTranslationGeneration||nativeApiKey(nativeApiSelected||{})!==selectionKey)break;
      rows=nativeApiTranslationPriorityRows().filter(row=>{const key=nativeApiTranslationKeyFor(selectionKey,row);return force||(!nativeApiTranslationCache.has(key)&&!nativeApiTranslationBusy.has(key));});
      let cursor=0;const worker=async()=>{while(cursor<rows.length&&generation===nativeApiTranslationGeneration&&nativeApiKey(nativeApiSelected||{})===selectionKey&&runEpoch===nativeApiTranslationPriorityEpoch){const row=rows[cursor++];await nativeApiTranslateOne(row,selectionKey,generation,{force,cacheFirstChecked:nativeApiServerPreTranslationCacheFirstEnabled()});}};
      await Promise.all(Array.from({length:Math.min(nativeApiTranslationConcurrency(),rows.length)},worker));
    }while(nativeApiTranslationReschedule&&generation===nativeApiTranslationGeneration&&nativeApiKey(nativeApiSelected||{})===selectionKey&&runEpoch===nativeApiTranslationPriorityEpoch);
  })().finally(()=>{if(nativeApiTranslationSchedulerKey===schedulerKey){nativeApiTranslationScheduler=null;nativeApiTranslationSchedulerKey='';if(nativeApiTranslationReschedule)queueMicrotask(()=>scheduleNativeApiTranslations({preempt:false}));}});
  return nativeApiTranslationScheduler;
}
function scheduleNativeApiTranslationFromScroll(){const now=(typeof performance!=='undefined'?performance.now():Date.now());if(now<nativeApiProgrammaticScrollUntil)return;if(nativeApiTranslationScrollTimer)clearTimeout(nativeApiTranslationScrollTimer);nativeApiTranslationScrollTimer=setTimeout(()=>{nativeApiTranslationScrollTimer=null;scheduleNativeApiTranslations({preempt:true}).catch(()=>{});},120);}

function fillNativeApiCrmStageOptions(target=nativeApiSelected, preferred='') {
  const node=$('#nativeApiCrmStage');if(!node)return;
  if(String(target?.platform||'')==='line'){fillLineFlowStageSelect(node,preferred||node.value||lineFlowDefaultStage());return;}
  const stages=['待回复','有意向','已对接ws','无效'];const normalized=normalizeExternalCrmStage(preferred||node.value||stages[0]);const wanted=stages.includes(normalized)?normalized:'待回复';node.innerHTML=stages.map(stage=>`<option value="${escapeHtml(stage)}">${escapeHtml(stage)}</option>`).join('');node.value=wanted;
}
function nativeApiUpdateCrmSummary(target=nativeApiSelected,stage='',serviceStatus='auto') {
  if(!target)return;const normalizedStage=String(stage||'').trim();const status=String(serviceStatus||'auto');
  if(nativeApiSelected&&nativeApiSameCustomer(target,nativeApiSelected))nativeApiSelected={...nativeApiSelected,crmStage:normalizedStage,crmServiceStatus:status};
  const idx=(nativeApiInboxState.items||[]).findIndex(item=>nativeApiSameCustomer(item,target));if(idx>=0)nativeApiInboxState.items[idx]={...nativeApiInboxState.items[idx],crmStage:normalizedStage,crmServiceStatus:status};
  nativeApiCustomerRenderSignature='';renderNativeApiCustomers({force:true});
}
async function saveNativeApiStageOnly() {
  const target=nativeApiSelected;if(!target)return;const raw=String($('#nativeApiCrmStage')?.value||'');const stage=String(target.platform||'')==='line'?raw:normalizeExternalCrmStage(raw);const oldStage=String(target.crmStage||'');
  nativeApiUpdateCrmSummary(target,stage,String(target.crmServiceStatus||$('#nativeApiCrmServiceStatus')?.value||'auto'));const state=$('#nativeApiCrmSaveState');if(state){state.textContent='阶段保存中…';state.classList.remove('saved');}
  try{const saved=await window.yoko.savePlatformCrmContact?.({_action:'native-api-stage-only',platform:target.platform,accountId:target.accountId,chatId:target.chatId,displayName:target.displayName,stage});nativeApiUpdateCrmSummary(target,String(saved?.stage||stage),String(saved?.serviceStatus||target.crmServiceStatus||'auto'));if(state){state.textContent='阶段已保存';state.classList.add('saved');}nativeApiSetStatus(`${target.displayName||'客户'} · 跟进阶段：${String(saved?.stage||stage)}`);}
  catch(error){nativeApiUpdateCrmSummary(target,oldStage,String(target.crmServiceStatus||'auto'));if(state){state.textContent='阶段保存失败';state.classList.remove('saved');}nativeApiSetStatus('跟进阶段保存失败：'+(error?.message||error));}
}
function clearNativeApiCrm() {
  for(const id of ['nativeApiCrmName','nativeApiCrmRegion','nativeApiCrmAge','nativeApiCrmOccupation','nativeApiCrmInterests','nativeApiCrmTags','nativeApiCrmNote'])if($('#'+id))$('#'+id).value='';
  if($('#nativeApiCrmServiceStatus'))$('#nativeApiCrmServiceStatus').value='auto';fillNativeApiCrmStageOptions(nativeApiSelected,'');
  if($('#nativeApiCrmIdentity'))$('#nativeApiCrmIdentity').textContent=nativeApiSelected?`${nativeApiPlatformLabel(nativeApiSelected.platform)} · ${nativeApiSelected.displayName||'客户'}`:'选择客户后读取本机 CRM';
  if($('#nativeApiCrmSaveState')){$('#nativeApiCrmSaveState').textContent=nativeApiSelected?'正在读取':'等待选择';$('#nativeApiCrmSaveState').classList.remove('saved');}
}
async function hydrateNativeApiCrm(target=nativeApiSelected,epoch=nativeApiSelectEpoch) {
  if(!target){clearNativeApiCrm();return;}clearNativeApiCrm();
  try{const result=await window.yoko.getPlatformCrmContact?.({platform:target.platform,accountId:target.accountId,chatId:target.chatId,displayName:target.displayName});if(epoch!==nativeApiSelectEpoch||!nativeApiSameCustomer(target,nativeApiSelected))return;const c=result?.contact||{};const serviceStatus=['auto','waiting','active','done','paused','blacklist'].includes(String(c.serviceStatus||''))?String(c.serviceStatus):'auto';fillNativeApiCrmStageOptions(target,c.stage||'');nativeApiUpdateCrmSummary(target,String(c.stage||''),serviceStatus);if($('#nativeApiCrmServiceStatus'))$('#nativeApiCrmServiceStatus').value=serviceStatus;if($('#nativeApiCrmName'))$('#nativeApiCrmName').value=String(c.name||'');if($('#nativeApiCrmRegion'))$('#nativeApiCrmRegion').value=String(c.region||'');if($('#nativeApiCrmAge'))$('#nativeApiCrmAge').value=String(c.age||'');if($('#nativeApiCrmOccupation'))$('#nativeApiCrmOccupation').value=String(c.occupation||'');if($('#nativeApiCrmInterests'))$('#nativeApiCrmInterests').value=String(c.interests||'');if($('#nativeApiCrmTags'))$('#nativeApiCrmTags').value=String(c.tags||'');if($('#nativeApiCrmNote'))$('#nativeApiCrmNote').value=String(c.note||'');if($('#nativeApiCrmIdentity'))$('#nativeApiCrmIdentity').textContent=`${nativeApiPlatformLabel(target.platform)} · ${target.displayName||'客户'} · 稳定 API 身份`;if($('#nativeApiCrmSaveState')){$('#nativeApiCrmSaveState').textContent='已同步';$('#nativeApiCrmSaveState').classList.add('saved');}}
  catch(error){if(epoch!==nativeApiSelectEpoch)return;if($('#nativeApiCrmSaveState')){$('#nativeApiCrmSaveState').textContent='读取失败';$('#nativeApiCrmSaveState').classList.remove('saved');}nativeApiSetStatus('CRM 读取失败：'+(error?.message||error));}
}
async function saveNativeApiCrm() {
  const target=nativeApiSelected;if(!target){nativeApiSetStatus('请先选择客户');return;}const node=$('#nativeApiCrmSaveState');if(node){node.textContent='保存中…';node.classList.remove('saved');}
  try{const stageRaw=String($('#nativeApiCrmStage')?.value||'');const saved=await window.yoko.savePlatformCrmContact?.({platform:target.platform,accountId:target.accountId,chatId:target.chatId,displayName:target.displayName,name:String($('#nativeApiCrmName')?.value||''),stage:String(target.platform||'')==='line'?stageRaw:normalizeExternalCrmStage(stageRaw),serviceStatus:String($('#nativeApiCrmServiceStatus')?.value||'auto'),tags:String($('#nativeApiCrmTags')?.value||''),region:String($('#nativeApiCrmRegion')?.value||''),age:String($('#nativeApiCrmAge')?.value||''),occupation:String($('#nativeApiCrmOccupation')?.value||''),interests:String($('#nativeApiCrmInterests')?.value||''),note:String($('#nativeApiCrmNote')?.value||'')});nativeApiUpdateCrmSummary(target,String(saved?.stage||stageRaw),String(saved?.serviceStatus||$('#nativeApiCrmServiceStatus')?.value||'auto'));if(node){node.textContent='已保存';node.classList.add('saved');}nativeApiSetStatus(`${target.displayName||'客户'} · CRM 已保存`);return saved;}
  catch(error){if(node){node.textContent='保存失败';node.classList.remove('saved');}nativeApiSetStatus('CRM 保存失败：'+(error?.message||error));}
}
function mergeNativeApiProfiles(next=[],previous=[]) {const old=new Map((previous||[]).map(item=>[nativeApiKey(item),item]));return(next||[]).map(item=>{const prior=old.get(nativeApiKey(item));if(!prior)return item;const generic=/^(?:FB客户|LINE客户)\s*·/i.test(String(item.displayName||''));return{...prior,...item,displayName:generic&&prior.displayName?prior.displayName:item.displayName,avatarUrl:item.avatarUrl||prior.avatarUrl||''};});}
function nativeApiProfileNeedsHydration(item={}) {
  // V1.27.234: do not try to repair Facebook avatars/profiles. Initials are the
  // stable fallback; cached/native conversation avatars may still render if present.
  if(String(item.platform||'').toLowerCase()==='facebook')return false;
  const name=String(item.displayName||'').trim();
  return !String(item.avatarUrl||'').trim()||/^LINE客户\s*·/i.test(name);
}
function scheduleNativeApiProfileHydration() {
  if(nativeApiProfileHydrationPromise)return nativeApiProfileHydrationPromise;
  const now=Date.now();
  // V1.27.233: enrichment must never chase every missing avatar after each
  // 2.5-second inbox refresh. Run one tiny sweep at most every 10 minutes.
  if(now<nativeApiProfileHydrationNextSweepAt)return Promise.resolve({ok:true,updated:0,skipped:'cooldown'});
  nativeApiProfileHydrationNextSweepAt=now+NATIVE_API_PROFILE_SWEEP_MS;
  const targets=(nativeApiInboxState.items||[]).filter(item=>{
    if(!nativeApiProfileNeedsHydration(item))return false;
    const last=Number(nativeApiProfileHydrationAttemptedAt.get(nativeApiKey(item))||0);
    return !last||now-last>NATIVE_API_PROFILE_TARGET_RETRY_MS;
  }).slice(0,8);
  if(!targets.length)return Promise.resolve({ok:true,updated:0});
  nativeApiProfileHydrationPromise=(async()=>{
    let updated=0;
    // Keep this deliberately serial/small. Message freshness has priority.
    for(let i=0;i<targets.length;i+=4){
      const chunk=targets.slice(i,i+4);const stamp=Date.now();chunk.forEach(item=>nativeApiProfileHydrationAttemptedAt.set(nativeApiKey(item),stamp));
      let result=null;try{result=await nativeApiAction('native-api-hydrate-profiles',{targets:chunk,max:chunk.length});}catch{continue;}
      for(const hydrated of Array.isArray(result?.items)?result.items:[]){
        const idx=(nativeApiInboxState.items||[]).findIndex(row=>nativeApiSameCustomer(row,hydrated));if(idx<0)continue;
        const prior=nativeApiInboxState.items[idx];const next={...prior,...hydrated,displayName:String(hydrated.displayName||prior.displayName||''),avatarUrl:String(hydrated.avatarUrl||prior.avatarUrl||'')};
        if(next.displayName!==prior.displayName||next.avatarUrl!==prior.avatarUrl){nativeApiInboxState.items[idx]=next;updated++;}
      }
      if(i+4<targets.length)await new Promise(resolve=>setTimeout(resolve,750));
    }
    if(updated){
      const current=nativeApiSelected?(nativeApiInboxState.items||[]).find(row=>nativeApiSameCustomer(row,nativeApiSelected)):null;
      if(current){nativeApiSelected={...nativeApiSelected,...current};renderNativeApiChatHead();}
      renderNativeApiCustomers({force:true});
    }
    return {ok:true,updated};
  })().finally(()=>{nativeApiProfileHydrationPromise=null;});
  return nativeApiProfileHydrationPromise;
}
function nativeApiRenderFacebookPageFilter(){
  const select=$('#nativeApiFacebookPageFilter');if(!select)return;
  const current=nativeApiFacebookPageFilter;
  const pages=(nativeApiFacebookPages||[]).filter(row=>row&&row.pageId&&(nativeApiInboxLayout.selected==='all'||nativeApiInboxOfPage(row.pageId)===nativeApiInboxLayout.selected));
  select.innerHTML='<option value="all">全部 Facebook Page</option>'+pages.map(row=>`<option value="${escapeHtml(row.pageId)}">${escapeHtml(row.name||row.pageId)}${row.enabled===false?'（已停用）':''}</option>`).join('');
  if(current==='all'||pages.some(row=>String(row.pageId)===current))select.value=current;else{nativeApiFacebookPageFilter='all';select.value='all';}
}
function nativeApiClearFacebookPageEditor(){
  const id=$('#nativeApiFbPageId'),name=$('#nativeApiFbPageName'),token=$('#nativeApiFbPageToken'),enabled=$('#nativeApiFbPageEnabled');
  if(id)id.value='';if(name)name.value='';if(token)token.value='';if(enabled)enabled.checked=true;
}
function nativeApiRenderFacebookPages(){
  const list=$('#nativeApiFbPagesList');if(!list)return;
  const pages=Array.isArray(nativeApiFacebookPages)?nativeApiFacebookPages:[];
  if(!pages.length){list.innerHTML='<div class="native-api-empty">还没有配置 Facebook Page API。点击“新建”，填写 Page Access Token 后保存。</div>';return;}
  list.innerHTML=pages.map(row=>`<div class="native-api-fb-page-row${row.enabled===false?' disabled':''}" data-fb-page-id="${escapeHtml(row.pageId||'')}"><div class="native-api-fb-page-copy"><strong>${escapeHtml(row.name||'Facebook Page')}</strong><small>Page ID：${escapeHtml(row.pageId||'--')} · Token：${row.tokenConfigured?'已配置':'未配置'}${row.legacy?' · 旧单账号配置':''}</small></div><div class="native-api-fb-page-actions"><button type="button" data-fb-page-edit>编辑</button>${row.legacy?'':`<button type="button" data-fb-page-toggle>${row.enabled===false?'开启':'关闭'}</button><button type="button" class="danger" data-fb-page-remove>删除</button>`}</div></div>`).join('');
}
async function nativeApiLoadFacebookPages({quiet=true}={}){
  if(!nativeApiMasterEnabled)return {ok:false,disabled:true,pages:nativeApiFacebookPages};
  try{const result=await nativeApiAction('native-api-meta-pages');nativeApiFacebookPages=Array.isArray(result?.pages)?result.pages:[];if(!nativeApiInboxSyncReady)await nativeApiLoadServerInboxes({quiet:true});nativeApiRenderFacebookPageFilter();nativeApiRenderFacebookPages();nativeApiRenderInboxSelector();nativeApiRenderInboxManagement();if(!quiet)nativeApiSetStatus(`Facebook API 账号池 · ${nativeApiFacebookPages.length} 个 Page`);return result;}
  catch(error){if(!quiet)nativeApiSetStatus('Facebook API 账号读取失败：'+(error?.message||error));throw error;}
}
async function openNativeApiFacebookPages(){
  nativeApiClearFacebookPageEditor();await nativeApiLoadFacebookPages({quiet:true}).catch(()=>{});await openModal('nativeApiFbPagesModal');
}
const NATIVE_API_AUTO_REPLY_DEFAULT='您好！感谢您的联系。请问有什么可以帮助您？';
let nativeApiAutoReplySettingsByPage=new Map();
function nativeApiRenderAutoReplySettings(){
  const holder=$('#nativeApiAutoReplyPages');if(!holder)return;
  const pages=Array.isArray(nativeApiFacebookPages)?nativeApiFacebookPages:[];
  if(!pages.length){holder.innerHTML='<div class="native-api-empty">尚未配置 Facebook Page API，请先在“FB账号”中添加主页。</div>';return;}
  holder.innerHTML=pages.filter(row=>row&&row.pageId&&!row.legacy).map(row=>{
    const cfg=nativeApiAutoReplySettingsByPage.get(String(row.pageId))||{enabled:false,replyText:NATIVE_API_AUTO_REPLY_DEFAULT};
    return `<section class="native-api-auto-reply-card" data-auto-reply-page="${escapeHtml(row.pageId)}"><div class="native-api-auto-reply-head"><div><strong>${escapeHtml(row.name||'Facebook Page')}</strong><small>Page ID：${escapeHtml(row.pageId)}${row.enabled===false?' · Page API 已关闭':''}</small></div><label class="native-api-auto-reply-toggle"><input type="checkbox" data-auto-reply-enabled ${cfg.enabled===true&&row.enabled!==false?'checked':''} ${row.enabled===false?'disabled':''}/><span>启用</span></label></div><label class="native-api-auto-reply-label">自动回复内容<textarea data-auto-reply-text maxlength="2000" rows="3">${escapeHtml(cfg.replyText||NATIVE_API_AUTO_REPLY_DEFAULT)}</textarea></label><div class="native-api-auto-reply-actions"><small>最多 2000 字符 · 保存后立即生效</small><button type="button" class="primary" data-auto-reply-save ${row.enabled===false?'disabled':''}>保存设置</button></div></section>`;
  }).join('')||'<div class="native-api-empty">没有可配置的 Facebook Page。</div>';
}
async function openNativeApiAutoReplySettings(){
  const status=$('#nativeApiAutoReplyStatus');if(status)status.textContent='正在读取 VPS 自动回复设置…';
  await nativeApiLoadFacebookPages({quiet:true}).catch(()=>{});
  try{
    const result=await nativeApiAction('native-api-auto-reply-get');
    nativeApiAutoReplySettingsByPage=new Map((Array.isArray(result?.pages)?result.pages:[]).map(row=>[String(row.pageId||''),{enabled:row?.autoReply?.enabled===true,replyText:String(row?.autoReply?.replyText||result?.defaultReplyText||NATIVE_API_AUTO_REPLY_DEFAULT)}]));
    if(status)status.textContent='已连接 VPS。每个主页单独保存；自动回复默认关闭。';
  }catch(error){if(status)status.textContent='读取失败：'+(error?.message||error);}
  nativeApiRenderAutoReplySettings();await openModal('nativeApiAutoReplyModal');
}
async function saveNativeApiAutoReplySettings(card){
  if(!card)return;const pageId=String(card.dataset.autoReplyPage||'');const enabled=card.querySelector('[data-auto-reply-enabled]')?.checked===true;const replyText=String(card.querySelector('[data-auto-reply-text]')?.value||'').trim();const button=card.querySelector('[data-auto-reply-save]');const status=$('#nativeApiAutoReplyStatus');
  if(enabled&&!replyText){if(status)status.textContent='启用自动回复前，请先填写回复内容。';return;}
  if(button)button.disabled=true;if(status)status.textContent='正在保存到 VPS…';
  try{const result=await nativeApiAction('native-api-auto-reply-put',{pageId,enabled,replyText});nativeApiAutoReplySettingsByPage.set(pageId,{enabled:result.enabled===true,replyText:String(result.replyText||replyText||NATIVE_API_AUTO_REPLY_DEFAULT)});if(status)status.textContent=`${enabled?'已启用':'已保存并关闭'}：${String(card.querySelector('.native-api-auto-reply-head strong')?.textContent||pageId)}。新设置已生效。`;nativeApiSetStatus(`Facebook 自动回复设置已保存 · ${pageId}`);}
  catch(error){if(status)status.textContent='保存失败：'+(error?.message||error);}
  finally{if(button)button.disabled=false;}
}
async function nativeApiSaveFacebookPage(){
  const pageId=String($('#nativeApiFbPageId')?.value||'').trim(),name=String($('#nativeApiFbPageName')?.value||'').trim(),pageAccessToken=String($('#nativeApiFbPageToken')?.value||'').trim(),enabled=$('#nativeApiFbPageEnabled')?.checked!==false;
  if(!pageId&&!pageAccessToken){nativeApiSetStatus('新增 Facebook Page 时必须填写 Page Access Token');$('#nativeApiFbPageToken')?.focus();return;}
  const btn=$('#nativeApiFbPageSaveBtn');if(btn)btn.disabled=true;const status=$('#nativeApiFbPagesStatus');if(status)status.textContent='正在让 VPS 向 Meta 验证 Token 和 Page ID…';
  try{const result=await nativeApiAction('native-api-meta-page-upsert',{page:{pageId,name,pageAccessToken,enabled}});nativeApiFacebookPages=Array.isArray(result?.pages)?result.pages:(result?.page?[result.page]:nativeApiFacebookPages);nativeApiClearFacebookPageEditor();await nativeApiLoadFacebookPages({quiet:true});nativeApiCustomerRenderSignature='';await refreshNativeApiInbox({quiet:true,hydrate:false});if(status)status.textContent=`已保存：${result?.page?.name||result?.page?.pageId||'Facebook Page'}。发送消息会按客户 pageId 自动选择对应 Token。`;nativeApiSetStatus(`Facebook API Page 已保存 · ${nativeApiFacebookPages.length} 个`);}
  catch(error){if(status)status.textContent='保存失败：'+(error?.message||error);nativeApiSetStatus('Facebook API Page 保存失败：'+(error?.message||error));}
  finally{if(btn)btn.disabled=false;}
}
async function nativeApiToggleFacebookPage(pageId,enabled){
  try{await nativeApiAction('native-api-meta-page-toggle',{pageId,enabled});await nativeApiLoadFacebookPages({quiet:true});nativeApiCustomerRenderSignature='';await refreshNativeApiInbox({quiet:true,hydrate:false});nativeApiSetStatus(`Facebook Page API 已${enabled?'开启':'关闭'}`);}catch(error){nativeApiSetStatus('Facebook Page 开关失败：'+(error?.message||error));}
}
async function nativeApiRemoveFacebookPage(pageId){
  if(!pageId||!window.confirm('确定删除这个 Facebook Page API 配置吗？\n只删除 VPS 上的 Page Token 配置，不会删除 Facebook 页面或本地聊天记录。'))return;
  try{await nativeApiAction('native-api-meta-page-remove',{pageId});if(nativeApiFacebookPageFilter===pageId)nativeApiFacebookPageFilter='all';await nativeApiLoadFacebookPages({quiet:true});nativeApiCustomerRenderSignature='';await refreshNativeApiInbox({quiet:true,hydrate:false});nativeApiSetStatus('Facebook Page API 配置已删除');}catch(error){nativeApiSetStatus('删除 Facebook Page 失败：'+(error?.message||error));}
}

async function refreshNativeApiHealth({quiet=true}={}) {
  if(!nativeApiMasterEnabled)return null;
  try{
    const health=await nativeApiAction('native-api-health');
    const update=(id,label,row)=>{
      const node=$('#'+id);if(!node)return;const ok=!!row?.ok;
      const auto=row?.autoReconcile||{};const echo=row?.messageEchoSubscription||{};
      const isFacebook=label==='Facebook';const autoEnabled=isFacebook&&!!auto?.enabled;
      const echoReady=isFacebook&&!!echo?.lastSuccessAt&&!echo?.lastError;
      const syncLabel=ok&&isFacebook?(echoReady&&autoEnabled?' · 实时+补漏':autoEnabled?' · 自动补漏':''):'';
      const pageCount=isFacebook?Math.max(0,Number(row?.pageCount||row?.pages?.length||0)||0):0;
      node.textContent=`${label} · ${ok?'在线':'异常'}${isFacebook&&pageCount?` · ${pageCount}页`:''}${syncLabel}`;
      node.classList.toggle('ok',ok);node.classList.toggle('error',!ok);
      if(!ok){node.title=String(row?.error||'网关未连接');return;}
      const details=['VPS 官方 API 网关正常'];
      if(autoEnabled){details.push(`自动增量对账：${Math.max(1,Math.round(Number(auto?.intervalMs||60000)/1000))} 秒`);if(auto?.lastSuccessAt)details.push(`最近补漏检查：${auto.lastSuccessAt}`);if(Number(auto?.lastRecoveredMessages||0)>0)details.push(`最近自动追回：${Number(auto.lastRecoveredMessages||0)} 条`);if(auto?.lastError)details.push(`自动补漏异常：${String(auto.lastError)}`);}
      if(isFacebook){if(pageCount)details.push(`Facebook Page API：${pageCount} 个已启用`);if(echoReady)details.push('Meta message_echoes：已订阅');else if(echo?.lastError)details.push(`message_echoes：${String(echo.lastError)}`);}
      node.title=details.join('\n');
    };
    update('nativeApiMetaHealth','Facebook',health?.facebook);update('nativeApiLineHealth','LINE',health?.line);
    let quickSystem=null;
    try{const perf=await window.yoko.getRuntimePerformance?.();quickSystem=buildStabilitySystemSnapshot(perf||{},health,nativeApiTranslationHealthSnapshot());}catch{}
    updateNativeApiDiagnosticsQuickBadge(health,quickSystem);
    if(!quiet&&health?.ok===false)nativeApiSetStatus('官方 API 网关未连接');return health;
  }
  catch(error){for(const id of ['nativeApiMetaHealth','nativeApiLineHealth']){const node=$('#'+id);if(node){node.classList.remove('ok');node.classList.add('error');node.textContent=(id.includes('Meta')?'Facebook':'LINE')+' · 异常';}}updateNativeApiDiagnosticsQuickBadge(null,{overall:'error'});if(!quiet)nativeApiSetStatus('健康检查失败：'+(error?.message||error));return null;}
}
async function refreshNativeApiSelectedMessages({quiet=true,force=false}={}) {
  if(!nativeApiMasterEnabled)return;const target=nativeApiSelected;if(!target)return;const epoch=nativeApiSelectEpoch;
  const receiptSignature=rows=>(Array.isArray(rows)?rows:[]).map(row=>`${nativeApiMessageIdentity(row)}:${String(row.deliveryStatus||'')}:${Number(row.readAtMs||0)}`).join('|');
  const beforeReceipts=receiptSignature(nativeApiMessages);
  const beforeSig=`${nativeApiMessages.length}|${nativeApiMessageIdentity(nativeApiMessages[nativeApiMessages.length-1]||{})}|${String(nativeApiMessages[nativeApiMessages.length-1]?.text||'')}`;
  try{
    const result=await nativeApiAction('native-api-messages',{target,limit:NATIVE_API_HISTORY_PAGE_SIZE});if(epoch!==nativeApiSelectEpoch||!nativeApiSameCustomer(target,nativeApiSelected))return;
    const nextMessages=Array.isArray(result?.items)?result.items:[];
    const afterSig=`${nextMessages.length}|${nativeApiMessageIdentity(nextMessages[nextMessages.length-1]||{})}|${String(nextMessages[nextMessages.length-1]?.text||'')}`;
    const key=nativeApiKey(nativeApiSelected||{});nativeApiMessages=key===nativeApiHistorySelectionKey?nativeApiMergeMessageRows(nativeApiMessages,nextMessages):nextMessages;
    if(key!==nativeApiHistorySelectionKey){nativeApiHistorySelectionKey=key;nativeApiHistoryHasMore=result?.hasMore===true;nativeApiHistoryCursor=result?.nextCursor||null;}
    const translationHits=nativeApiApplyPersistentTranslations(result?.translations,nativeApiKey(nativeApiSelected));
    const changed=beforeSig!==afterSig;
    const receiptChanged=beforeReceipts!==receiptSignature(nativeApiMessages);
    if(force||changed||receiptChanged||translationHits>0)renderNativeApiMessages({keepBottom:!force});
    if(changed||translationHits>0)scheduleNativeApiTranslations({preempt:changed}).catch(()=>{});
    if(!quiet)nativeApiSetStatus(`${target.displayName||'客户'} · ${nativeApiMessages.length} 条消息`);
  }catch(error){if(!quiet)nativeApiSetStatus('聊天刷新失败：'+(error?.message||error));}
}

async function refreshNativeApiInbox({quiet=false,hydrate=false}={}) {
  if(!nativeApiMasterEnabled)return nativeApiInboxState;
  if(nativeApiRefreshBusy)return nativeApiInboxState;nativeApiRefreshBusy=true;const epoch=++nativeApiRefreshEpoch;
  try{
    // V1.27.234: message freshness is the critical path. Facebook profile/avatar
    // enrichment is disabled; only bounded non-Facebook identity hydration remains.
    const shouldHydrate=(hydrate||!nativeApiInboxState.items.length||Date.now()-nativeApiLastHydrateAt>60000)
      && (nativeApiInboxState.items||[]).some(nativeApiProfileNeedsHydration);
    const result=await nativeApiAction('native-api-refresh',{limit:300,hydrate:false});
    if(epoch!==nativeApiRefreshEpoch)return nativeApiInboxState;
    const previous=nativeApiInboxState.items||[];
    const nextItems=mergeNativeApiProfiles(Array.isArray(result?.items)?result.items:[],previous);
    nativeApiRestoreHiddenIfNewIncoming(previous,nextItems);
    nativeApiProcessIncomingChanges(previous,nextItems);
    const customerPatchPlan=nativeApiCustomerPatchPlan(previous,nextItems);
    nativeApiInboxState={...result,items:nextItems,errors:Array.isArray(result?.errors)?result.errors:[]};
    nativeApiScheduleTodayNewResolution(nextItems);
    nativeApiScheduleDayBucketResolution(nextItems).catch(()=>{});
    let selectedHeadChanged=false;
    if(nativeApiSelected){
      const updated=nextItems.find(item=>nativeApiSameCustomer(item,nativeApiSelected));
      if(updated){
        const previousEvent=String(nativeApiSelected.lastEventKey||'');
        const beforeHead=[nativeApiSelected.displayName,nativeApiSelected.avatarUrl,nativeApiSelected.lastTimestampMs,nativeApiSelected.awaitingReply,nativeApiSelected.crmStage,nativeApiSelected.crmServiceStatus].join('|');
        nativeApiSelected={...nativeApiSelected,...updated};
        const afterHead=[nativeApiSelected.displayName,nativeApiSelected.avatarUrl,nativeApiSelected.lastTimestampMs,nativeApiSelected.awaitingReply,nativeApiSelected.crmStage,nativeApiSelected.crmServiceStatus].join('|');
        selectedHeadChanged=beforeHead!==afterHead;
        if(selectedHeadChanged)renderNativeApiChatHead();
        if(String(updated.lastEventKey||'')&&String(updated.lastEventKey||'')!==previousEvent)refreshNativeApiSelectedMessages({quiet:true}).catch(()=>{});
      }
    }
    const nextVisualSignature=nativeApiInboxVisualSignatureFor(nextItems);
    if(nextVisualSignature!==nativeApiInboxVisualSignature){
      nativeApiInboxVisualSignature=nextVisualSignature;
      if(customerPatchPlan.patchable&&customerPatchPlan.keys.length){const patched=nativeApiPatchCustomerRows(customerPatchPlan.keys);if(!patched)renderNativeApiCustomers();}
      else renderNativeApiCustomers();
    }
    if(shouldHydrate){nativeApiLastHydrateAt=Date.now();scheduleNativeApiProfileHydration().catch(()=>{});}
    if(!quiet){const errors=(nativeApiInboxState.errors||[]).map(row=>`${nativeApiPlatformLabel(row.platform)}: ${row.error}`).join(' · ');nativeApiSetStatus(errors||`官方 API 已刷新 · ${nextItems.length} 位客户`);}
    return nativeApiInboxState;
  }
  catch(error){if(!quiet)nativeApiSetStatus('官方 API 刷新失败：'+(error?.message||error));return nativeApiInboxState;}
  finally{nativeApiRefreshBusy=false;}
}

async function syncNativeApiFacebookHistory() {
  const button=$('#nativeApiHistorySyncBtn'); if(button)button.disabled=true; nativeApiSetStatus('正在从 Meta 官方 Conversations API 同步历史客户…');
  try{
    const result=await nativeApiAction('native-api-meta-history-sync',{conversationLimit:1000,messageLimit:60});
    nativeApiLastHydrateAt=0; nativeApiCustomerRenderSignature='';
    await refreshNativeApiInbox({quiet:true,hydrate:true});
    const conversations=Number(result?.conversations||result?.discovered||0)||0; const inserted=Number(result?.insertedConversations||result?.inserted||0)||0;
    nativeApiSetStatus(`Facebook 历史同步完成 · ${conversations} 个会话${inserted?` · 新增 ${inserted}`:''}`);
    return result;
  }catch(error){nativeApiSetStatus('Facebook 历史同步失败：'+(error?.message||error));return null;}finally{if(button)button.disabled=false;}
}
function nativeApiTabKeepsNativeFocus(target) {
  if(!target||typeof target.closest!=='function')return false;
  // CRM is a form: keep ordinary Tab there so data entry remains natural.
  // Modals/dialogs also retain native focus navigation.
  return !!target.closest('.native-api-crm, .modal, dialog');
}
function switchNativeApiCustomerByOffset(direction=1) {
  const visible=nativeApiVisibleItems();
  if(!visible.length){nativeApiSetStatus('Tab切换 · 当前没有可见客户');return false;}
  if(visible.length===1){nativeApiSetStatus('Tab切换 · 当前只有 1 位可见客户');return false;}
  let index=nativeApiSelected?visible.findIndex(item=>nativeApiSameCustomer(item,nativeApiSelected)):-1;
  if(index<0)index=direction<0?0:-1;
  const nextIndex=(index+(direction<0?-1:1)+visible.length)%visible.length;
  const next=visible[nextIndex];
  if(!next)return false;
  closeNativeApiCustomerContextMenu();
  selectNativeApiCustomer(next).then(()=>{
    const key=nativeApiKey(next);
    const row=Array.from(document.querySelectorAll('#nativeApiCustomerList [data-native-api-key]')).find(node=>String(node.dataset.nativeApiKey||'')===key);
    row?.scrollIntoView?.({block:'nearest'});
  }).catch(()=>{});
  return true;
}


function nativeApiResetChatScriptDraft({hide=true}={}) {
  nativeApiChatScriptRequestId='';
  nativeApiChatScriptJa='';
  nativeApiChatScriptZh='';
  nativeApiChatScriptCustomerKey='';
  const wrap=$('#nativeApiChatScriptDraft'); if(wrap&&hide)wrap.classList.add('hidden');
  const ja=$('#nativeApiChatScriptJa'); if(ja)ja.value='';
  const zh=$('#nativeApiChatScriptZh'); if(zh)zh.value='';
  const meta=$('#nativeApiChatScriptMeta'); if(meta)meta.textContent='等待生成';
}
function nativeApiShowChatScriptDraft(result={}) {
  nativeApiChatScriptRequestId=String(result.request_id||'');
  nativeApiChatScriptJa=String(result.reply_ja||'').trim();
  nativeApiChatScriptZh=String(result.reply_zh||'').trim();
  nativeApiChatScriptCustomerKey=nativeApiKey(nativeApiSelected||{});
  const wrap=$('#nativeApiChatScriptDraft'); if(wrap)wrap.classList.remove('hidden');
  const ja=$('#nativeApiChatScriptJa'); if(ja)ja.value=nativeApiChatScriptJa;
  const zh=$('#nativeApiChatScriptZh'); if(zh)zh.value=nativeApiChatScriptZh;
  const bits=[];
  if(result.active_day)bits.push(`Day ${result.active_day}`);
  bits.push(String(result.relationship_label||result.relationship_stage||'关系评估中'));
  if(result.emotion)bits.push(`情绪 ${result.emotion}`);
  if(result.turn_action)bits.push(`本轮 ${result.turn_action}`);
  if(result.boundary?.triggered)bits.push(`⚠ ${result.boundary.type||'边界'} / ${result.boundary.severity||'-'}`);
  if(Number(result.queue_wait_ms||0)>=1000)bits.push(`TPM排队 ${Math.round(Number(result.queue_wait_ms)/1000)}秒`);
  if(Number(result.request_estimated_tokens||0)>0)bits.push(`请求预算 ${Math.round(Number(result.request_estimated_tokens)/100)/10}K`);
  const meta=$('#nativeApiChatScriptMeta'); if(meta)meta.textContent=bits.filter(Boolean).join(' · ');
}
async function nativeApiGenerateChatScriptDraft() {
  const target=nativeApiSelected;
  if(!target){nativeApiSetStatus('请先选择客户');return;}
  const button=$('#nativeApiChatScriptBtn');
  const original=button?.textContent||'Chat Script AI';
  if(button){button.disabled=true;button.textContent='AI思考中…';}
  nativeApiSetStatus(`Chat Script AI 正在读取 ${target.displayName||'客户'} 的长期记忆… 接近 TPM 上限时会自动排队，请不要重复点击。`);
  try{
    const health=await window.yoko.getChatScriptAiHealth?.();
    if(!health?.ok)throw new Error(health?.error||'请先启动 Chat Script AI V3.4.3 或更高版本');
    if(health?.ai?.enabled===false)throw new Error('Chat Script AI 尚未配置可用 API');
    const result=await window.yoko.generateChatScriptAiReply?.({requirements:''});
    if(!result?.ok||!String(result.reply_ja||'').trim())throw new Error(result?.error||'没有生成回复');
    if(!nativeApiSelected||!nativeApiSameCustomer(target,nativeApiSelected)){nativeApiSetStatus('AI草稿已生成，但你已经切换客户；为避免串线没有写入当前输入框。');return;}
    nativeApiShowChatScriptDraft(result);
    const composer=$('#nativeApiComposer');if(composer){composer.value=String(result.reply_ja||'').trim();nativeApiSaveCurrentDraft();composer.focus({preventScroll:true});}
    nativeApiSetStatus(result.deduped?`${target.displayName||'客户'} · 已读取同一消息的既有 Chat Script AI 草稿`:`${target.displayName||'客户'} · Chat Script AI 草稿已生成，确认后再发送`);
  }catch(error){nativeApiSetStatus('Chat Script AI 生成失败：'+(error?.message||error));}
  finally{if(button){button.disabled=false;button.textContent=original;}}
}
async function nativeApiCopyChatScriptJa() {
  const text=String(nativeApiChatScriptJa||$('#nativeApiChatScriptJa')?.value||'').trim();
  if(!text){nativeApiSetStatus('当前没有可复制的日语草稿');return;}
  const btn=$('#nativeApiChatScriptCopyBtn');const old=btn?.textContent||'复制日语';
  try{await navigator.clipboard.writeText(text);if(btn){btn.textContent='已复制 ✓';setTimeout(()=>{if(btn)btn.textContent=old;},1200);}nativeApiSetStatus('已复制 Chat Script AI 日语回复');}
  catch(error){nativeApiSetStatus('复制失败：'+(error?.message||error));}
}
function nativeApiApplyChatScriptDraft() {
  const text=String(nativeApiChatScriptJa||$('#nativeApiChatScriptJa')?.value||'').trim();
  if(!text){nativeApiSetStatus('当前没有可写入的日语草稿');return;}
  const composer=$('#nativeApiComposer');if(composer){composer.value=text;nativeApiSaveCurrentDraft();composer.focus({preventScroll:true});}
  nativeApiSetStatus('Chat Script AI 日语草稿已写入输入框，请确认后发送');
}
async function nativeApiFeedbackChatScript(verdict='effective') {
  if(!nativeApiChatScriptRequestId){nativeApiSetStatus('当前没有可反馈的 Chat Script AI 草稿');return;}
  let reason=verdict==='effective'?'YokoSCRM 官方 API 收件箱人工确认有效':'';
  if(verdict==='reject')reason=window.prompt('为什么不合适？例如：问太多、太甜、没回应重点、边界太软、重复模板')||'YokoSCRM 官方 API 收件箱人工标记不合适';
  try{await window.yoko.feedbackChatScriptAi?.({requestId:nativeApiChatScriptRequestId,verdict:verdict==='reject'?'reject':'effective',reason});nativeApiSetStatus(verdict==='reject'?'已记录为不合适样本':'已加入 Chat Script AI 有效话术资产库');}
  catch(error){nativeApiSetStatus('Chat Script AI 反馈失败：'+(error?.message||error));}
}

async function selectNativeApiCustomer(item,{reassert=false}={}) {
  if(!item)return;
  const requestedKey=nativeApiKey(item);
  if(!reassert&&nativeApiSelected&&nativeApiSameCustomer(item,nativeApiSelected)&&nativeApiMessages.length){
    nativeApiV254Perf.customerSwitch.sameSelectionNoop+=1;nativeApiMarkRead(item);nativeApiPatchCustomerSelection();nativeApiSetStatus(`${item.displayName||'客户'} · 已是当前客户`);return {ok:true,noop:true};
  }
  if(nativeApiSelectionTask&&!nativeApiSelectionTask.done){nativeApiSelectionTask.cancelled=true;nativeApiV254Perf.customerSwitch.staleCancelled+=1;}
  const started=nativeApiPerfNow();
  nativeApiV254Perf.customerSwitch.count+=1;
  nativeApiResetChatScriptDraft();closeNativeApiClipboardPreview({silent:true});nativeApiSaveCurrentDraft();nativeApiMarkRead(item);nativeApiTranslationGeneration++;nativeApiTranslationPriorityEpoch++;nativeApiTranslationReschedule=false;
  const epoch=++nativeApiSelectEpoch;nativeApiSelectionTask={epoch,key:requestedKey,startedAt:started,done:false,cancelled:false};
  nativeApiSelected={...item};nativeApiMessages=[];nativeApiHistorySelectionKey=requestedKey;nativeApiHistoryCursor=null;nativeApiHistoryHasMore=false;nativeApiHistoryLoading=false;nativeApiMessageVirtualRangeKey='';nativeApiMessageVirtualSelectionKey=requestedKey;nativeApiRestoreDraft(nativeApiSelected);nativeApiPatchCustomerSelection();renderNativeApiChatHead();clearNativeApiCrm();
  if($('#nativeApiMessages'))$('#nativeApiMessages').innerHTML='<div class="native-api-chat-placeholder"><strong>正在读取聊天…</strong><span>从 VPS SQLite 读取这个客户的官方 API 历史。</span></div>';nativeApiSetStatus(`正在打开 ${item.displayName||'客户'}…`);
  try{
    const result=await nativeApiAction('native-api-select',{target:item,limit:NATIVE_API_HISTORY_PAGE_SIZE});
    if(!nativeApiSelectionCurrent(epoch,requestedKey)||result?.staleSelection){nativeApiV254Perf.customerSwitch.staleCancelled+=1;return {ok:false,stale:true};}
    nativeApiSelected={...item,...(result?.target||{})};nativeApiMessages=Array.isArray(result?.messages)?result.messages:[];nativeApiHistorySelectionKey=nativeApiKey(nativeApiSelected||{});nativeApiHistoryHasMore=result?.hasMore===true;nativeApiHistoryCursor=result?.nextCursor||null;nativeApiApplyPersistentTranslations(result?.translations,nativeApiKey(nativeApiSelected));
    const idx=(nativeApiInboxState.items||[]).findIndex(row=>nativeApiSameCustomer(row,nativeApiSelected));if(idx>=0)nativeApiInboxState.items[idx]={...nativeApiInboxState.items[idx],...nativeApiSelected};
    nativeApiPatchCustomerRows([requestedKey]);nativeApiPatchCustomerSelection();renderNativeApiChatHead();
    if(!nativeApiSelectionCurrent(epoch,requestedKey))return {ok:false,stale:true};
    renderNativeApiMessages();
    const firstPaint=Math.max(0,nativeApiPerfNow()-started);nativeApiV254Perf.customerSwitch.firstPaintLastMs=Math.round(firstPaint);nativeApiV254Perf.customerSwitch.firstPaintMaxMs=Math.max(nativeApiV254Perf.customerSwitch.firstPaintMaxMs,Math.round(firstPaint));
    if(nativeApiSelectionCurrent(epoch,requestedKey)){scheduleNativeApiTranslations({preempt:true}).catch(()=>{});hydrateNativeApiCrm(nativeApiSelected,epoch).catch(()=>{});nativeApiSetStatus(`${nativeApiSelected.displayName||'客户'} · ${nativeApiMessages.length} 条消息 · 官方 API`);nativeApiRestoreDraft(nativeApiSelected,{focus:true});}
    const elapsed=Math.max(0,nativeApiPerfNow()-started);const perf=nativeApiV254Perf.customerSwitch;perf.completed+=1;perf.lastMs=Math.round(elapsed);perf.maxMs=Math.max(perf.maxMs,Math.round(elapsed));perf.recent.push({at:Date.now(),key:requestedKey,elapsedMs:Math.round(elapsed),firstPaintMs:Math.round(firstPaint)});if(perf.recent.length>20)perf.recent.splice(0,perf.recent.length-20);
    if(nativeApiSelectionTask?.epoch===epoch)nativeApiSelectionTask.done=true;return {ok:true};
  }
  catch(error){if(!nativeApiSelectionCurrent(epoch,requestedKey))return {ok:false,stale:true};nativeApiSetStatus('客户打开失败：'+(error?.message||error));if($('#nativeApiMessages'))$('#nativeApiMessages').innerHTML=`<div class="native-api-empty">${escapeHtml(error?.message||error)}</div>`;return {ok:false,error};}
  finally{if(nativeApiSelectionTask?.epoch===epoch)nativeApiSelectionTask.done=true;}
}

let nativeApiClipboardImageDraft=null;
function nativeApiClipboardFileName(type='image/png',index=0){
  const stamp=new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,14);const ext=/jpeg/i.test(type)?'jpg':/png/i.test(type)?'png':/webp/i.test(type)?'webp':/gif/i.test(type)?'gif':'png';
  return `clipboard-${stamp}${index?`-${index+1}`:''}.${ext}`;
}
function nativeApiClipboardImageFiles(event){
  const clipboard=event?.clipboardData;if(!clipboard)return [];
  // V1.27.106: DataTransfer.files and DataTransfer.items often expose the SAME
  // Windows clipboard bitmap twice. Treat files as the authoritative source;
  // inspect items only as a compatibility fallback when files has no image.
  const direct=Array.from(clipboard.files||[]).filter(file=>file&&String(file.type||'').toLowerCase().startsWith('image/'));
  if(direct.length)return direct.slice(0,5);
  const rows=[];const seen=new Set();
  for(const item of Array.from(clipboard.items||[])){
    if(String(item?.kind||'')!=='file'||!String(item?.type||'').toLowerCase().startsWith('image/'))continue;
    try{
      const raw=item.getAsFile?.();if(!raw)continue;
      const name=String(raw.name||'').trim()||nativeApiClipboardFileName(raw.type,rows.length);
      let file=raw;try{if(typeof File==='function'&&(!raw.name||raw.name==='image.png'))file=new File([raw],name,{type:raw.type||item.type||'image/png',lastModified:Number(raw.lastModified||Date.now())});}catch{}
      const key=[String(file.type||item.type||''),Number(file.size||0),String(file.name||name||'')].join('|');if(seen.has(key))continue;seen.add(key);rows.push(file);
    }catch{}
  }
  return rows.slice(0,5);
}
async function nativeApiClipboardImageFingerprint(file){
  if(!file)return '';
  try{
    const bytes=await file.arrayBuffer();
    if(globalThis.crypto?.subtle){
      const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);
      return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
    }
  }catch{}
  return [String(file.type||''),Number(file.size||0),String(file.name||'')].join('|');
}
async function nativeApiDedupeClipboardImages(files=[]){
  const rows=[];const seen=new Set();
  for(const file of Array.from(files||[])){
    if(!file||!String(file.type||'').toLowerCase().startsWith('image/'))continue;
    const key=await nativeApiClipboardImageFingerprint(file);if(key&&seen.has(key))continue;if(key)seen.add(key);rows.push(file);if(rows.length>=5)break;
  }
  return rows;
}
function ensureNativeApiClipboardPreview(){
  let overlay=document.querySelector('#nativeApiClipboardPreview');if(overlay)return overlay;
  overlay=document.createElement('div');overlay.id='nativeApiClipboardPreview';overlay.className='native-api-clipboard-preview hidden';
  overlay.innerHTML='<div class="native-api-clipboard-card" role="dialog" aria-modal="true" aria-label="粘贴图片预览"><div class="native-api-clipboard-head"><div><strong>粘贴图片预览</strong><small id="nativeApiClipboardMeta">确认后才会发送</small></div><button id="nativeApiClipboardClose" type="button" aria-label="取消">×</button></div><div id="nativeApiClipboardGrid" class="native-api-clipboard-grid"></div><div class="native-api-clipboard-foot"><small>图片尚未发送 · Esc 取消</small><button id="nativeApiClipboardCancel" type="button">取消</button><button id="nativeApiClipboardSend" class="primary" type="button">发送图片</button></div></div>';
  document.body.appendChild(overlay);
  const cancel=()=>closeNativeApiClipboardPreview();
  overlay.querySelector('#nativeApiClipboardClose')?.addEventListener('click',cancel);overlay.querySelector('#nativeApiClipboardCancel')?.addEventListener('click',cancel);overlay.addEventListener('click',event=>{if(event.target===overlay)cancel();});
  overlay.querySelector('#nativeApiClipboardSend')?.addEventListener('click',()=>sendNativeApiClipboardDraft().catch(error=>nativeApiSetStatus('附件发送失败：'+(error?.message||error))));
  return overlay;
}
function closeNativeApiClipboardPreview({silent=false}={}){
  const draft=nativeApiClipboardImageDraft;nativeApiClipboardImageDraft=null;
  for(const url of Array.isArray(draft?.urls)?draft.urls:[]){try{URL.revokeObjectURL(url);}catch{}}
  const overlay=document.querySelector('#nativeApiClipboardPreview');if(overlay){overlay.classList.add('hidden');const grid=overlay.querySelector('#nativeApiClipboardGrid');if(grid)grid.innerHTML='';}
  if(!silent&&draft)nativeApiSetStatus('已取消粘贴图片');
}
function stageNativeApiClipboardImages(files=[]){
  const target=nativeApiSelected;const rows=Array.from(files||[]).filter(file=>file&&String(file.type||'').toLowerCase().startsWith('image/')).slice(0,5);
  if(!target){nativeApiSetStatus('请先选择客户，再粘贴图片');return false;}if(!rows.length)return false;
  const tooLarge=rows.find(file=>Number(file.size||0)>10*1024*1024);if(tooLarge){nativeApiSetStatus(`${tooLarge.name||'图片'} 超过 10MB。`);return false;}
  const total=rows.reduce((sum,file)=>sum+Number(file.size||0),0);if(total>20*1024*1024){nativeApiSetStatus('一次最多发送 20MB 图片，请分批发送。');return false;}
  closeNativeApiClipboardPreview({silent:true});
  const urls=rows.map(file=>URL.createObjectURL(file));nativeApiClipboardImageDraft={files:rows,urls,selectionKey:nativeApiKey(target),targetName:String(target.displayName||'客户')};
  const overlay=ensureNativeApiClipboardPreview(),grid=overlay.querySelector('#nativeApiClipboardGrid'),meta=overlay.querySelector('#nativeApiClipboardMeta');
  if(meta)meta.textContent=`${nativeApiClipboardImageDraft.targetName} · ${rows.length} 张 · 确认后才会发送`;
  if(grid)grid.innerHTML=rows.map((file,index)=>`<figure><img src="${escapeHtml(urls[index])}" alt="${escapeHtml(file.name||`粘贴图片 ${index+1}`)}" /><figcaption>${escapeHtml(file.name||`粘贴图片 ${index+1}`)}</figcaption></figure>`).join('');
  overlay.classList.remove('hidden');overlay.querySelector('#nativeApiClipboardSend')?.focus?.({preventScroll:true});nativeApiSetStatus(`已粘贴 ${rows.length} 张图片 · 预览确认后发送`);return true;
}
async function sendNativeApiClipboardDraft(){
  const draft=nativeApiClipboardImageDraft;if(!draft?.files?.length)return;
  if(!nativeApiSelected||nativeApiKey(nativeApiSelected)!==draft.selectionKey){closeNativeApiClipboardPreview({silent:true});throw new Error('客户已经切换，为避免图片发错客户，本次发送已取消。');}
  const files=Array.from(draft.files);closeNativeApiClipboardPreview({silent:true});await sendNativeApiImages(files);
}
function nativeApiFileDataUrl(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('读取图片失败'));reader.onload=()=>resolve(String(reader.result||''));reader.readAsDataURL(file);});}
function nativeApiLoadBrowserImage(url){return new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('图片解码失败'));img.src=url;});}
function nativeApiDataUrlParts(value=''){const m=/^data:([^;,]+);base64,(.+)$/s.exec(String(value||''));return m?{mime:String(m[1]||'').toLowerCase(),base64:String(m[2]||'')}:null;}
async function nativeApiPrepareImageFile(file){
  if(!file)throw new Error('没有选择图片。');
  if(Number(file.size||0)>10*1024*1024)throw new Error(`${file.name||'图片'} 超过 10MB。`);
  const sourceUrl=await nativeApiFileDataUrl(file);const source=nativeApiDataUrlParts(sourceUrl);if(!source)throw new Error('图片读取失败。');
  let originalUrl=sourceUrl,originalMime=String(file.type||source.mime||'').toLowerCase();
  const needsConvert=!/^image\/(?:jpeg|png)$/.test(originalMime);
  const img=await nativeApiLoadBrowserImage(sourceUrl);
  if(needsConvert){
    const max=4096,scale=Math.min(1,max/Math.max(img.naturalWidth||1,img.naturalHeight||1));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round((img.naturalWidth||1)*scale));canvas.height=Math.max(1,Math.round((img.naturalHeight||1)*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);originalUrl=canvas.toDataURL('image/jpeg',0.9);originalMime='image/jpeg';
  }
  let original=nativeApiDataUrlParts(originalUrl);if(!original)throw new Error('图片转换失败。');
  if(Math.ceil(original.base64.length*3/4)>10*1024*1024)throw new Error(`${file.name||'图片'} 处理后仍超过 10MB。`);
  let maxPreview=1280,quality=0.8,previewUrl='';
  for(let attempt=0;attempt<5;attempt++){
    const scale=Math.min(1,maxPreview/Math.max(img.naturalWidth||1,img.naturalHeight||1));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round((img.naturalWidth||1)*scale));canvas.height=Math.max(1,Math.round((img.naturalHeight||1)*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);previewUrl=canvas.toDataURL('image/jpeg',quality);const parts=nativeApiDataUrlParts(previewUrl);if(parts&&Math.ceil(parts.base64.length*3/4)<=900*1024)break;maxPreview=Math.max(480,Math.round(maxPreview*0.78));quality=Math.max(0.55,quality-0.08);
  }
  const preview=nativeApiDataUrlParts(previewUrl);if(!preview)throw new Error('图片预览生成失败。');
  return {name:String(file.name||'image.jpg').slice(0,300),mime:originalMime,dataBase64:original.base64,previewMime:'image/jpeg',previewBase64:preview.base64};
}
async function sendNativeApiImages(fileList){
  const target=nativeApiSelected;const files=Array.from(fileList||[]).filter(Boolean).slice(0,5);
  if(!target){nativeApiSetStatus('请先选择客户');return;}if(!files.length)return;
  const allowedExt=/\.(?:pdf|doc|docx|xls|xlsx)$/i;
  const documentFiles=files.filter(file=>allowedExt.test(String(file.name||'')));
  if(documentFiles.length&&String(target.platform||'').toLowerCase()!=='facebook'){nativeApiSetStatus('当前文档附件仅支持 Facebook Messenger，LINE 暂不支持。');return;}
  const totalBytes=files.reduce((sum,file)=>sum+Number(file.size||0),0);
  if(totalBytes>20*1024*1024){nativeApiSetStatus('一次附件合计不能超过 20MB，请分批发送。');return;}
  const selectionKey=nativeApiKey(target),imageBtn=$('#nativeApiImageBtn'),sendBtn=$('#nativeApiSendBtn'),composer=$('#nativeApiComposer');
  if(imageBtn?.disabled)return;
  if(imageBtn)imageBtn.disabled=true;if(sendBtn)sendBtn.disabled=true;if(composer)composer.disabled=true;
  nativeApiSetStatus(`正在准备 ${files.length} 个附件…`);
  try{
    let lastResult=null,sent=0;
    for(const file of files){
      if(nativeApiKey(nativeApiSelected||{})!==selectionKey)throw new Error('客户已经切换，为避免附件发错客户，剩余文件已取消。');
      let media;
      if(allowedExt.test(String(file.name||''))){
        const mimeMap={pdf:'application/pdf',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
        const ext=String(file.name||'').split('.').pop().toLowerCase();
        if(!file.size||file.size>6*1024*1024)throw new Error(`${file.name} 必须在 1B～6MB 之间。`);
        const parts=nativeApiDataUrlParts(await nativeApiFileDataUrl(file));if(!parts)throw new Error('文档读取失败');
        media={name:String(file.name).slice(0,180),mime:mimeMap[ext],dataBase64:parts.base64};
      }else if(String(file.type||'').startsWith('image/')){
        media=await nativeApiPrepareImageFile(file);
      }else throw new Error(`暂不支持 ${file.name||'该文件'} 的格式。`);
      nativeApiSetStatus(`正在发送附件 ${sent+1}/${files.length}：${file.name||'图片'}…`);
      lastResult=await nativeApiAction('native-api-send-media',{target,media});sent++;
      if(nativeApiKey(nativeApiSelected||{})===selectionKey){nativeApiMessages=Array.isArray(lastResult?.messages)?lastResult.messages:nativeApiMessages;nativeApiApplyPersistentTranslations(lastResult?.translations,nativeApiKey(nativeApiSelected));renderNativeApiMessages();}
    }
    if(nativeApiKey(nativeApiSelected||{})===selectionKey){nativeApiSelected={...nativeApiSelected,...(lastResult?.target||{}),awaitingReply:false,lastReplyAt:Date.now(),lastDirection:'outgoing',preview:'［附件］',lastTimestampMs:Date.now()};const idx=(nativeApiInboxState.items||[]).findIndex(row=>nativeApiSameCustomer(row,nativeApiSelected));if(idx>=0)nativeApiInboxState.items[idx]={...nativeApiInboxState.items[idx],...nativeApiSelected};renderNativeApiCustomers();renderNativeApiChatHead();renderNativeApiMessages();scheduleNativeApiTranslations({preempt:true}).catch(()=>{});nativeApiSetStatus(`${target.displayName||'客户'} · 已发送 ${sent} 个附件`);}
  }catch(error){nativeApiSetStatus('附件发送失败：'+(error?.message||error)+'（失败文件不会自动重发）');}
  finally{if(imageBtn)imageBtn.disabled=false;if(sendBtn)sendBtn.disabled=false;if(composer){composer.disabled=false;composer.focus();}const input=$('#nativeApiImageInput');if(input)input.value='';}
}

async function sendNativeApiMessage() {
  const target=nativeApiSelected;const composer=$('#nativeApiComposer');const text=String(composer?.value||'').trim();if(!target){nativeApiSetStatus('请先选择客户');return;}if(!text){nativeApiSetStatus('请输入回复内容');return;}nativeApiMarkRead(target);const selectionKey=nativeApiKey(target);const button=$('#nativeApiSendBtn');if(button)button.disabled=true;if(composer)composer.disabled=true;nativeApiSetStatus(`正在通过 ${nativeApiPlatformLabel(target.platform)} 官方 API 发送…`);
  try{const result=await nativeApiAction('native-api-send',{target,text});nativeApiClearDraft(target);if(nativeApiChatScriptRequestId&&nativeApiChatScriptCustomerKey===selectionKey){window.yoko.markChatScriptAiSent?.({requestId:nativeApiChatScriptRequestId,actualText:text,translation:nativeApiChatScriptZh,externalOutgoingId:String(result?.result?.messageId||result?.result?.id||'')}).catch(()=>{});}if(nativeApiKey(nativeApiSelected||{})!==selectionKey){nativeApiSetStatus('发送完成；当前客户已切换');return;}if(composer)composer.value='';nativeApiMessages=Array.isArray(result?.messages)?result.messages:nativeApiMessages;nativeApiSelected={...nativeApiSelected,...(result?.target||{}),awaitingReply:false,lastReplyAt:Date.now(),lastDirection:'outgoing',preview:text,lastTimestampMs:Date.now()};nativeApiApplyPersistentTranslations(result?.translations,nativeApiKey(nativeApiSelected));const idx=(nativeApiInboxState.items||[]).findIndex(row=>nativeApiSameCustomer(row,nativeApiSelected));if(idx>=0)nativeApiInboxState.items[idx]={...nativeApiInboxState.items[idx],...nativeApiSelected};renderNativeApiCustomers();renderNativeApiChatHead();renderNativeApiMessages();scheduleNativeApiTranslations({preempt:true}).catch(()=>{});nativeApiSetStatus(`${target.displayName||'客户'} · 已发送`);nativeApiResetChatScriptDraft();}
  catch(error){nativeApiSetStatus('发送失败：'+(error?.message||error));}finally{if(button)button.disabled=false;if(composer){composer.disabled=false;composer.focus({preventScroll:true});}}
}
function startNativeApiRefreshTimer(){
  stopNativeApiRefreshTimer();if(!nativeApiMasterEnabled)return;
  const activeMs=Math.max(2500,Number(nativeApiRuntimeSettings.activePollMs||2500));
  const healthMs=Math.max(15000,Number(nativeApiRuntimeSettings.healthPollMs||30000));
  nativeApiRefreshTimer=setInterval(()=>{
    if(document.hidden||!nativeApiMasterEnabled||shellSurface!=='native-api')return;
    // Always reconcile the selected conversation, including AI outbound events.
    // Inbox list cursors may not advance for server-originated replies.
    refreshNativeApiInbox({quiet:true,hydrate:false}).catch(()=>{});
    if(nativeApiSelected&&!nativeApiHistoryLoading)refreshNativeApiSelectedMessages({quiet:true}).catch(()=>{});
  },activeMs);
  nativeApiHealthTimer=setInterval(()=>{if(document.hidden||!nativeApiMasterEnabled)return;if(shellSurface==='native-api')refreshNativeApiHealth({quiet:true}).catch(()=>{});},healthMs);
}
function stopNativeApiRefreshTimer(){if(nativeApiRefreshTimer)clearInterval(nativeApiRefreshTimer);if(nativeApiHealthTimer)clearInterval(nativeApiHealthTimer);nativeApiRefreshTimer=null;nativeApiHealthTimer=null;}
async function enterNativeApiWorkspace(){nativeApiRenderNotificationState();nativeApiEnsureNotificationAudio();nativeApiEnsureDesktopNotificationPermission().catch(()=>{});externalGlobalAggregateActive=false;if(externalAggregateRefreshTimer){clearInterval(externalAggregateRefreshTimer);externalAggregateRefreshTimer=null;}appCenterOpen=false;setQuickAddAppMenu(false);setQuickRemoveAppMenu(false);setShellBodyClass('native-api');try{await window.yoko.setNativeViewsVisible?.(false);}catch{}try{await window.yoko.setShellSurface?.('native-api');}catch(error){nativeApiSetStatus('进入官方 API 收件箱失败：'+(error?.message||error));}nativeApiRenderInboxSelector();renderNativeApiCustomers();renderNativeApiChatHead();await syncNativeApiMasterState();await nativeApiLoadServerInboxes({quiet:true}).catch(()=>{});if(nativeApiMasterEnabled){await Promise.all([refreshNativeApiHealth({quiet:true}),refreshNativeApiInbox({quiet:true,hydrate:true}),nativeApiLoadFacebookPages({quiet:true}).catch(()=>null)]);renderNativeApiCustomers();
// V1.27.289: re-entering the API desk from WS must re-assert the selected
// customer as the authoritative GPT target (the external view may have owned it).
// Never copy WS selection or silently retarget to another customer.
if (nativeApiSelected) {
  const selectedNow=(nativeApiInboxState.items||[]).find(row=>nativeApiSameCustomer(row,nativeApiSelected));
  if (selectedNow && nativeApiInboxAllows(selectedNow)) {
    await selectNativeApiCustomer(selectedNow,{reassert:true}).catch(error=>nativeApiSetStatus('GPT 客户身份恢复失败：'+(error?.message||error)));
  }
}
await refreshChatgptWorkbenchState();
nativeApiSetStatus(`Facebook + LINE 官方 API · ${nativeApiInboxState.items.length||0} 位客户`);startNativeApiRefreshTimer();}else{renderNativeApiCustomers();nativeApiSetStatus('官方 API 已关闭 · 当前显示上次缓存数据');}}

$('#shellNativeApiBtn')?.addEventListener('click',()=>enterNativeApiWorkspace());
$('#nativeApiMasterToggleBtn')?.addEventListener('click',()=>toggleNativeApiMaster());
$('#nativeApiAutoReplyBtn')?.addEventListener('click',()=>openNativeApiAutoReplySettings().catch(error=>nativeApiSetStatus('自动回复设置打开失败：'+(error?.message||error))));
$('#nativeApiAutoReplyPages')?.addEventListener('click',event=>{const button=event.target.closest('[data-auto-reply-save]');if(button)saveNativeApiAutoReplySettings(button.closest('[data-auto-reply-page]')).catch(error=>nativeApiSetStatus(error?.message||error));});
$('#nativeApiFbPagesBtn')?.addEventListener('click',()=>openNativeApiFacebookPages().catch(error=>nativeApiSetStatus('Facebook API 账号池打开失败：'+(error?.message||error))));
$('#nativeApiFbPageSaveBtn')?.addEventListener('click',()=>nativeApiSaveFacebookPage());
$('#nativeApiFbPageClearBtn')?.addEventListener('click',()=>nativeApiClearFacebookPageEditor());
$('#nativeApiInboxSelector')?.addEventListener('change',event=>nativeApiSwitchInbox(String(event.currentTarget.value||'all')));
$('#nativeApiInboxManageBtn')?.addEventListener('click',async()=>{nativeApiRenderInboxManagement();await openModal('nativeApiInboxesModal');Promise.allSettled([nativeApiLoadFacebookPages({quiet:true}),nativeApiLoadServerInboxes({quiet:false})]).then(()=>nativeApiRenderInboxManagement());});
$('#nativeApiInboxCreateBtn')?.addEventListener('click',()=>{
 const input=$('#nativeApiNewInboxName'),name=String(input?.value||'').trim().slice(0,60);
 if(!name){nativeApiSetStatus('请输入收件箱名称');return;}
 if(nativeApiInboxLayout.inboxes.some(x=>x.name===name)){nativeApiSetStatus('收件箱名称已存在');return;}
 const id='inbox-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7);
 if(input)input.value='';nativeApiCommitInboxMutation(d=>{if(d.inboxes.some(x=>x.name===name))return false;d.inboxes.push({id,name});});
});
$('#nativeApiInboxManager')?.addEventListener('change',event=>{
 const select=event.target.closest('[data-inbox-page]');if(!select)return;
 const id=String(select.dataset.inboxPage||''),owner=String(select.value||'default');
 if(!id||!nativeApiInboxLayout.inboxes.some(x=>x.id===owner))return;
 nativeApiCommitInboxMutation(d=>{if(!d.inboxes.some(x=>x.id===owner))return false;d.assignments[id]=owner;});
});
$('#nativeApiInboxManager')?.addEventListener('click',event=>{
 const rename=event.target.closest('[data-inbox-rename]');
 if(rename){
   const id=String(rename.dataset.inboxRename||'');const current=nativeApiInboxLayout.inboxes.find(x=>x.id===id);if(!current)return;
   const entered=window.prompt('修改收件箱名称',current.name);if(entered===null)return;
   const name=String(entered).trim();if(!name||name.length>60){nativeApiSetStatus('收件箱名称必须为 1–60 个字符');return;}
   if(nativeApiInboxLayout.inboxes.some(x=>x.id!==id&&x.name===name)){nativeApiSetStatus('收件箱名称已存在');return;}
   if(name!==current.name)nativeApiCommitInboxMutation(d=>{const row=d.inboxes.find(x=>x.id===id);if(!row||d.inboxes.some(x=>x.id!==id&&x.name===name))return false;row.name=name;});
   return;
 }
 const btn=event.target.closest('[data-inbox-delete]');if(!btn)return;
 const id=String(btn.dataset.inboxDelete||'');
 if(!id||id==='default')return;
 if((nativeApiFacebookPages||[]).some(p=>nativeApiInboxOfPage(p.pageId)===id)){nativeApiSetStatus('请先移走此收件箱内的 Facebook Page');return;}
 nativeApiCommitInboxMutation(d=>{if(Object.values(d.assignments).some(x=>x===id))return false;d.inboxes=d.inboxes.filter(x=>x.id!==id);});
});
$('#nativeApiFacebookPageFilter')?.addEventListener('change',event=>{nativeApiFacebookPageFilter=String(event.currentTarget?.value||'all');nativeApiCustomerRenderSignature='';renderNativeApiCustomers({force:true});});
$('#nativeApiCustomerDayBadge')?.addEventListener('change',event=>{
  const target=nativeApiSelected;if(!target)return;const day=Math.max(0,Math.min(10,Number(event.currentTarget?.value||0)||0));
  customerDayCalibrationSet(target,'native',day);nativeApiCustomerRenderSignature='';nativeApiCustomerBaseSignature='';renderNativeApiChatHead();renderNativeApiCustomers({force:true});
  nativeApiSetStatus(day?`${target.displayName||'客户'} · 已校准为第${day}天；下一个日本时间05:00自动进入下一天`:`${target.displayName||'客户'} · 已恢复自动判断客户天数`);
});
$('#nativeApiDayFilter')?.addEventListener('change',event=>{const value=Math.max(0,Math.min(NATIVE_API_CUSTOMER_DAY_MAX,Number(event.currentTarget?.value||0)||0));nativeApiDayFilter=value;nativeApiCustomerRenderSignature='';nativeApiCustomerBaseSignature='';const list=$('#nativeApiCustomerList');if(list)list.scrollTop=0;nativeApiScheduleDayBucketResolution(nativeApiInboxState.items||[]).catch(()=>{});renderNativeApiCustomers({force:true});nativeApiSetStatus(value?`客户天数筛选：${value===NATIVE_API_CUSTOMER_DAY_MAX?'第10天+':`第${value}天`}`:'客户天数筛选：全部');});
$('#nativeApiFbPagesList')?.addEventListener('click',event=>{const row=event.target.closest('[data-fb-page-id]');if(!row)return;const pageId=String(row.dataset.fbPageId||'');const page=(nativeApiFacebookPages||[]).find(item=>String(item.pageId||'')===pageId);if(!page)return;if(event.target.closest('[data-fb-page-edit]')){if($('#nativeApiFbPageId'))$('#nativeApiFbPageId').value=pageId;if($('#nativeApiFbPageName'))$('#nativeApiFbPageName').value=String(page.name||'');if($('#nativeApiFbPageToken'))$('#nativeApiFbPageToken').value='';if($('#nativeApiFbPageEnabled'))$('#nativeApiFbPageEnabled').checked=page.enabled!==false;$('#nativeApiFbPageToken')?.focus();return;}if(event.target.closest('[data-fb-page-toggle]')){nativeApiToggleFacebookPage(pageId,page.enabled===false).catch(()=>{});return;}if(event.target.closest('[data-fb-page-remove]'))nativeApiRemoveFacebookPage(pageId).catch(()=>{});});
$('#nativeApiDiagnosticsBtn')?.addEventListener('click',()=>openStabilityDiagnostics());
$('#nativeApiRefreshBtn')?.addEventListener('click',async()=>{nativeApiCustomerRenderSignature='';await Promise.all([refreshNativeApiHealth({quiet:false}),refreshNativeApiInbox({quiet:false,hydrate:true})]);});
$('#nativeApiHistorySyncBtn')?.addEventListener('click',syncNativeApiFacebookHistory);
$('#nativeApiNotificationBtn')?.addEventListener('click',async()=>{const enabled=!nativeApiNotificationsEnabled();nativeApiSetNotificationsEnabled(enabled);if(enabled){nativeApiEnsureNotificationAudio();await nativeApiEnsureDesktopNotificationPermission();nativeApiSetStatus('新消息通知已开启');}else nativeApiSetStatus('新消息通知已关闭');});
$('#nativeApiClearUnreadBtn')?.addEventListener('click',nativeApiClearAllUnread);
$('#nativeApiWaitingOnlyBtn')?.addEventListener('click',()=>{nativeApiWaitingOnly=!nativeApiWaitingOnly;renderNativeApiCustomers();});
$('#nativeApiSearch')?.addEventListener('input',event=>{nativeApiSearchText=String(event.currentTarget.value||'');renderNativeApiCustomers();});
document.querySelectorAll('[data-native-api-filter]').forEach(button=>button.addEventListener('click',()=>{nativeApiPlatformFilter=String(button.dataset.nativeApiFilter||'all');nativeApiCustomerRenderSignature='';renderNativeApiCustomers({force:true});}));
document.querySelectorAll('[data-native-api-stage-group]').forEach(button=>button.addEventListener('click',()=>{
  const next=String(button.dataset.nativeApiStageGroup||'');
  nativeApiStageGroupFilter=nativeApiStageGroupFilter===next?'':next;
  nativeApiCustomerRenderSignature='';
  renderNativeApiCustomers({force:true});
}));
$('#nativeApiBulkBtn')?.addEventListener('click',()=>{const selectedPlatform=String(nativeApiSelected?.platform||'').toLowerCase(),channel=['facebook','line'].includes(nativeApiPlatformFilter)?nativeApiPlatformFilter:(['facebook','line'].includes(selectedPlatform)?selectedPlatform:'line');openNativeApiBulkModal({channel,stageGroup:nativeApiStageGroupFilter}).catch(error=>nativeApiSetStatus('群发窗口打开失败：'+(error?.message||error)));});
$('#externalBulkSendBtn')?.addEventListener('click',()=>openNativeApiBulkModal().catch(error=>nativeApiSetStatus('群发窗口打开失败：'+(error?.message||error))));
$('#lineBulkSendBtn')?.addEventListener('click',()=>openNativeApiBulkModal({channel:'line',lineGroup:aggregateLineLifecycleFilter}).catch(error=>nativeApiSetStatus('群发窗口打开失败：'+(error?.message||error))));
$('#nativeApiBulkSearch')?.addEventListener('input',event=>{nativeApiBulkSearchText=String(event.currentTarget?.value||'');nativeApiBulkRenderCustomers();});
document.querySelectorAll('[data-native-api-bulk-stage-group]').forEach(button=>button.addEventListener('click',()=>{const raw=String(button.dataset.nativeApiBulkStageGroup||'all'),next=raw==='all'?'':raw;if(next!==nativeApiBulkStageGroupFilter)nativeApiBulkSelectedKeys=new Set();nativeApiBulkStageGroupFilter=next;nativeApiBulkRenderCustomers();}));
$('#nativeApiBulkCrmStage')?.addEventListener('change',event=>{const next=String(event.currentTarget?.value||'all');const normalized=next==='all'?'':next;if(normalized!==nativeApiBulkStageGroupFilter)nativeApiBulkSelectedKeys=new Set();nativeApiBulkStageGroupFilter=normalized;nativeApiBulkRenderCustomers();});
document.querySelectorAll('[data-native-api-bulk-line-group]').forEach(button=>button.addEventListener('click',()=>{const next=String(button.dataset.nativeApiBulkLineGroup||'all');if(next!==nativeApiBulkLineGroupFilter)nativeApiBulkSelectedKeys=new Set();nativeApiBulkLineGroupFilter=next;nativeApiBulkRenderCustomers();}));
$('#nativeApiBulkPlatform')?.addEventListener('change',event=>{const channel=String(event.currentTarget?.value||'line');nativeApiBulkLineGroupFilter='all';nativeApiBulkFacebookAccountFilter='all';nativeApiBulkStageGroupFilter='';nativeApiBulkLoadChannelCustomers(channel,{refresh:true,keepSelection:false}).catch(error=>nativeApiSetStatus('客户列表读取失败：'+(error?.message||error)));});
$('#nativeApiBulkFacebookAccount')?.addEventListener('change',event=>{nativeApiBulkFacebookAccountFilter=String(event.currentTarget?.value||'all');nativeApiBulkSelectedKeys=new Set();nativeApiBulkRenderCustomers();});
$('#nativeApiBulkCustomerList')?.addEventListener('change',event=>{const input=event.target.closest('.native-api-bulk-checkbox');if(!input)return;const row=input.closest('[data-native-api-bulk-key]'),key=String(row?.dataset?.nativeApiBulkKey||'');if(!key)return;if(input.checked)nativeApiBulkSelectedKeys.add(key);else nativeApiBulkSelectedKeys.delete(key);nativeApiBulkRenderCustomers();});
$('#nativeApiBulkSelectVisibleBtn')?.addEventListener('click',()=>{const visible=nativeApiBulkVisibleCustomers(),allSelected=visible.length>0&&visible.every(item=>nativeApiBulkSelectedKeys.has(nativeApiBulkCustomerKey(item)));for(const item of visible){const key=nativeApiBulkCustomerKey(item);if(allSelected)nativeApiBulkSelectedKeys.delete(key);else nativeApiBulkSelectedKeys.add(key);}nativeApiBulkRenderCustomers();});
$('#nativeApiBulkSendMode')?.addEventListener('change',()=>nativeApiBulkUpdateScheduleUi());
$('#nativeApiBulkStartBtn')?.addEventListener('click',()=>startNativeApiBulkSend());
$('#nativeApiBulkPauseBtn')?.addEventListener('click',async()=>{try{nativeApiBulkRenderRuntime(await nativeApiAction('native-api-bulk-pause'));nativeApiSetStatus('群发任务已暂停');}catch(error){nativeApiSetStatus('暂停失败：'+(error?.message||error));}});
$('#nativeApiBulkResumeBtn')?.addEventListener('click',async()=>{try{nativeApiBulkRenderRuntime(await nativeApiAction('native-api-bulk-resume'));nativeApiSetStatus('群发任务已继续');}catch(error){nativeApiSetStatus('继续失败：'+(error?.message||error));}});
$('#nativeApiBulkCancelBtn')?.addEventListener('click',async()=>{try{nativeApiBulkRenderRuntime(await nativeApiAction('native-api-bulk-cancel'));nativeApiSetStatus('群发任务已取消');}catch(error){nativeApiSetStatus('取消失败：'+(error?.message||error));}});
$('#nativeApiCustomerList')?.addEventListener('click',event=>{const button=event.target.closest('[data-native-api-key]');if(!button)return;const item=(nativeApiInboxState.items||[]).find(row=>nativeApiKey(row)===String(button.dataset.nativeApiKey||''));if(item)selectNativeApiCustomer(item);});
$('#nativeApiCustomerList')?.addEventListener('contextmenu',event=>{const button=event.target.closest('[data-native-api-key]');if(!button)return;const item=(nativeApiInboxState.items||[]).find(row=>nativeApiKey(row)===String(button.dataset.nativeApiKey||''));if(item)showNativeApiCustomerContextMenu(event,item);});
$('#nativeApiCustomerList')?.addEventListener('scroll',scheduleNativeApiCustomerVirtualRender,{passive:true});
// V1.27.275: keep long persona/rules modal scrollable even when the pointer is over an inner textarea.
document.querySelectorAll('#chatgptPersonaModal textarea').forEach(area=>area.addEventListener('wheel',event=>{const card=area.closest('.modal-card');if(!card)return;const atTop=area.scrollTop<=0,atBottom=area.scrollTop+area.clientHeight>=area.scrollHeight-2;if((event.deltaY<0&&atTop)||(event.deltaY>0&&atBottom)){card.scrollTop+=event.deltaY;event.preventDefault();}},{passive:false}));

$('#nativeApiImageBtn')?.addEventListener('click',()=>{if(!nativeApiSelected){nativeApiSetStatus('请先选择客户');return;}$('#nativeApiImageInput')?.click();});
$('#nativeApiImageInput')?.addEventListener('change',event=>{sendNativeApiImages(event.currentTarget?.files).catch(error=>nativeApiSetStatus('附件发送失败：'+(error?.message||error)));});
document.addEventListener('paste',event=>{if(shellSurface!=='native-api'||event.defaultPrevented)return;if(event.target?.closest?.('.native-api-crm, .modal, dialog, #nativeApiSearch'))return;const files=nativeApiClipboardImageFiles(event);if(!files.length)return;event.preventDefault();event.stopPropagation();event.stopImmediatePropagation?.();nativeApiDedupeClipboardImages(files).then(unique=>{if(unique.length)stageNativeApiClipboardImages(unique);}).catch(error=>nativeApiSetStatus('粘贴图片读取失败：'+(error?.message||error)));},true);
$('#nativeApiSendBtn')?.addEventListener('click',sendNativeApiMessage);
$('#nativeApiComposer')?.addEventListener('input',event=>{if(!nativeApiSelected)return;const badgeChanged=nativeApiSetDraft(nativeApiSelected,String(event.currentTarget?.value||''),{persist:false});if(badgeChanged)renderNativeApiCustomers();});
$('#nativeApiComposer')?.addEventListener('keydown',event=>{if(event.key!=='Enter'||event.isComposing||event.keyCode===229)return;if(event.shiftKey)return;event.preventDefault();sendNativeApiMessage();});
// V1.27.101: keyboard-first customer switching in Official API Inbox.
// Tab = next customer, Shift+Tab = previous customer. CRM/modal forms keep
// their normal Tab behavior, and IME composition is never interrupted.
document.addEventListener('keydown',event=>{
  if(shellSurface!=='native-api'||event.key!=='Tab'||event.isComposing||event.keyCode===229)return;
  if(event.altKey||event.metaKey||event.ctrlKey)return;
  if(nativeApiTabKeepsNativeFocus(event.target))return;
  event.preventDefault();event.stopPropagation();event.stopImmediatePropagation?.();
  switchNativeApiCustomerByOffset(event.shiftKey?-1:1);
},true);
$('#nativeApiMessages')?.addEventListener('click',event=>{const mediaButton=event.target.closest('[data-native-api-media-url]');if(mediaButton){event.preventDefault();openNativeApiMediaPreview(String(mediaButton.dataset.nativeApiMediaUrl||''),String(mediaButton.dataset.nativeApiMediaName||''));return;}const button=event.target.closest('[data-native-api-retranslate]');if(!button||!nativeApiSelected)return;const id=String(button.dataset.nativeApiRetranslate||'');const row=nativeApiMessages.find(item=>nativeApiMessageIdentity(item)===id);if(!row)return;const selectionKey=nativeApiKey(nativeApiSelected),generation=nativeApiTranslationGeneration;const key=nativeApiTranslationKeyFor(selectionKey,row);nativeApiTranslationCache.delete(key);nativeApiTranslationBusy.delete(key);nativeApiTranslateOne(row,selectionKey,generation,{force:true}).catch(()=>{});});
$('#nativeApiMessages')?.addEventListener('scroll',event=>{scheduleNativeApiMessageVirtualRender();scheduleNativeApiTranslationFromScroll();const box=event.currentTarget;if(box&&box.scrollTop<220&&nativeApiHistoryHasMore&&!nativeApiHistoryLoading)loadOlderNativeApiMessages().catch(()=>{});},{passive:true});
$('#nativeApiCrmSaveBtn')?.addEventListener('click',saveNativeApiCrm);
$('#nativeApiCrmStage')?.addEventListener('change',()=>saveNativeApiStageOnly());
$('#nativeApiTranslationBtn')?.addEventListener('click',()=>openTranslationPanel());
$('#nativeApiSpeechBtn')?.addEventListener('click',async()=>{try{await window.yoko.openSpeechLibraryWindow?.();}catch(error){nativeApiSetStatus('话术库打开失败：'+(error?.message||error));}});
$('#nativeApiChatHistoryBtn')?.addEventListener('click',openChatHistoryCenter);
$('#nativeApiGptToggleBtn')?.addEventListener('click',toggleChatgptWorkbench);
$('#nativeApiGptBindBtn')?.addEventListener('click',bindCurrentCustomerToChatgpt);
$('#nativeApiGptStageBtn')?.addEventListener('click',stageCustomerTurnToChatgpt);
// V1.27.271: cumulative guard for users upgrading directly from 1.27.268.
// Even if an older cached/partial HTML shell still contains the legacy top toolbar
// Chat Script AI button, remove it at renderer startup so the UI matches the new
// two-row toolbar contract. The underlying Chat Script integration is not deleted.
document.querySelectorAll('#nativeApiChatScriptBtn, .native-api-toolbar-actions .native-api-chatscript-btn').forEach(node=>node.remove());
$('#nativeApiChatScriptBtn')?.addEventListener('click',nativeApiGenerateChatScriptDraft);
$('#nativeApiChatScriptCloseBtn')?.addEventListener('click',()=>$('#nativeApiChatScriptDraft')?.classList.add('hidden'));
$('#nativeApiChatScriptCopyBtn')?.addEventListener('click',nativeApiCopyChatScriptJa);
$('#nativeApiChatScriptApplyBtn')?.addEventListener('click',nativeApiApplyChatScriptDraft);
$('#nativeApiChatScriptEffectiveBtn')?.addEventListener('click',()=>nativeApiFeedbackChatScript('effective'));
$('#nativeApiChatScriptRejectBtn')?.addEventListener('click',()=>nativeApiFeedbackChatScript('reject'));

// Persistent app rail: startup/app center is separate from every platform UI.
$('#shellHomeBtn')?.addEventListener('click', () => { setQuickAddAppMenu(false); setQuickRemoveAppMenu(false); openAppCenter('home'); });
$('#shellAppCenterBtn')?.addEventListener('click', () => { setQuickAddAppMenu(false); setQuickRemoveAppMenu(false); openAppCenter('apps'); });
$('#shellUnifiedAggregateBtn')?.addEventListener('click', () => openGlobalExternalAggregate());
$('#shellAddAppBtn')?.addEventListener('click', event => {
  event.stopPropagation();
  setQuickRemoveAppMenu(false);
  setQuickAddAppMenu(!appRailAddMenuOpen);
});
$('#shellQuickAddMenu')?.addEventListener('click', event => {
  event.stopPropagation();
  const button = event.target.closest('[data-quick-install-platform]');
  if (!button) return;
  quickInstallPlatform(String(button.dataset.quickInstallPlatform || ''));
});
$('#shellRemoveAppBtn')?.addEventListener('click', event => {
  event.stopPropagation();
  setQuickAddAppMenu(false);
  const installed = installedPlatformIds();
  if (!installed.length) {
    setQuickRemoveAppMenu(false);
    setStatus('当前没有可移除的应用');
    return;
  }
  setQuickRemoveAppMenu(!appRailRemoveMenuOpen);
});
$('#shellQuickRemoveMenu')?.addEventListener('click', event => {
  event.stopPropagation();
  const button = event.target.closest('[data-quick-remove-platform]');
  if (!button) return;
  quickRemovePlatform(String(button.dataset.quickRemovePlatform || ''));
});
$('#shellLineBtn')?.addEventListener('click', () => {
  setQuickAddAppMenu(false);
  setQuickRemoveAppMenu(false);
  enterLineWorkspace();
});
$('#shellSettingsBtn')?.addEventListener('click', () => { setQuickAddAppMenu(false); setQuickRemoveAppMenu(false); openModal('settingsModal'); });
$('#installedAppRail')?.addEventListener('click', event => {
  setQuickAddAppMenu(false);
  setQuickRemoveAppMenu(false);
  const button = event.target.closest('[data-shell-platform]');
  if (!button) return;
  ensureAndOpenPlatform(String(button.dataset.shellPlatform || ''));
});

function closeNativeApiSelectedChat() {
  if(shellSurface!=='native-api'||!nativeApiSelected)return false;
  nativeApiSaveCurrentDraft();
  nativeApiTranslationGeneration++;
  nativeApiTranslationReschedule=false;
  ++nativeApiSelectEpoch;
  nativeApiSelected=null;
  nativeApiMessages=[];
  const composer=$('#nativeApiComposer');
  if(composer){composer.value='';composer.blur?.();}
  clearNativeApiCrm();
  nativeApiCustomerRenderSignature='';
  renderNativeApiCustomers({force:true});
  renderNativeApiChatHead();
  renderNativeApiMessages();
  nativeApiSetStatus('已关闭当前客户聊天 · 按 Tab 可继续切换客户');
  return true;
}

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.isComposing || event.keyCode===229 || event.defaultPrevented) return;
  // V1.27.102: Esc closes only transient UI or the currently selected Official API
  // customer chat. It must never close the Yoko application itself.
  const clipboardPreview=document.querySelector('#nativeApiClipboardPreview:not(.hidden)');
  if(clipboardPreview){event.preventDefault();event.stopPropagation();event.stopImmediatePropagation?.();closeNativeApiClipboardPreview({silent:true});nativeApiSetStatus('已取消粘贴图片');return;}
  const media=document.querySelector('#nativeApiMediaPreview:not(.hidden)');
  if(media){event.preventDefault();event.stopPropagation();event.stopImmediatePropagation?.();media.classList.add('hidden');return;}
  const contextMenu=document.querySelector('.native-api-customer-context-menu, .aggregate-customer-context-menu');
  if(contextMenu){event.preventDefault();event.stopPropagation();event.stopImmediatePropagation?.();contextMenu.remove();return;}
  if (appRailAddMenuOpen) {
    event.preventDefault();event.stopPropagation();event.stopImmediatePropagation?.();
    setQuickAddAppMenu(false);
    return;
  }
  if (appRailRemoveMenuOpen) {
    event.preventDefault();event.stopPropagation();event.stopImmediatePropagation?.();
    setQuickRemoveAppMenu(false);
    return;
  }
  const openModals=Array.from(document.querySelectorAll('.modal:not(.hidden)'));
  const topModal=openModals[openModals.length-1];
  if(topModal?.id){event.preventDefault();event.stopPropagation();event.stopImmediatePropagation?.();closeModal(topModal.id).catch(()=>{});return;}
  if(closeNativeApiSelectedChat()){
    event.preventDefault();event.stopPropagation();event.stopImmediatePropagation?.();
  }
});
document.addEventListener('click', event => {
  if (appRailAddMenuOpen && !event.target.closest('#shellAddAppBtn, #shellQuickAddMenu')) setQuickAddAppMenu(false);
  if (appRailRemoveMenuOpen && !event.target.closest('#shellRemoveAppBtn, #shellQuickRemoveMenu')) setQuickRemoveAppMenu(false);
});

// Legacy top-bar App Center button is hidden in V1.20.1 but remains harmless for
// upgraded HTML/state restored from older builds.
$('#appCenterBtn')?.addEventListener('click', () => openAppCenter('apps'));
$('#appCenterRefreshBtn')?.addEventListener('click', () => refreshAppCenterState());
$('#appCenterHomeRefreshBtn')?.addEventListener('click', async () => { await refreshAppCenterState({ quiet:true }); await refreshOperationsDashboard(); });
$('#customerNumberVaultRefreshBtn')?.addEventListener('click', () => refreshCustomerNumberVault());
$('#customerNumberVaultExportBtn')?.addEventListener('click', async () => {
  try {
    const result = await window.yoko.exportCustomerNumberCsv?.();
    if (result?.ok) setStatus(`号码 CSV 已导出：${result.count || 0} 条`);
  } catch (error) { setStatus('号码 CSV 导出失败：' + (error?.message || error)); }
});
$('#customerNumberVaultImportBtn')?.addEventListener('click', () => $('#customerNumberVaultFileInput')?.click());
$('#customerNumberVaultFileInput')?.addEventListener('change', event => importCustomerNumberCsvFile(event.target.files?.[0]).finally(() => { event.target.value = ''; }));
$('#customerNumberVaultMarkGroupDeletedBtn')?.addEventListener('click', async () => {
  const groupName = $('#customerNumberVaultGroup')?.value || '';
  if (!String(groupName).trim()) { setStatus('请先填写群组/社群名称。'); return; }
  try {
    const result = await window.yoko.markCustomerGroupDeleted?.({ groupName: String(groupName).trim(), groupType: $('#customerNumberVaultSourceType')?.value === 'community' ? 'community' : 'group' });
    await refreshCustomerNumberVault({ quiet:true });
    setStatus(result?.ok ? '群组已标记为删除，号码记录仍保留。' : '群组标记失败。');
  } catch (error) { setStatus('群组标记失败：' + (error?.message || error)); }
});
$('#customerNumberVaultForm')?.addEventListener('submit', async event => {
  event.preventDefault();
  const phone = $('#customerNumberVaultPhone')?.value || '';
  const sourceType = $('#customerNumberVaultSourceType')?.value || 'import';
  const accountName = $('#customerNumberVaultAccount')?.value || '';
  const groupName = $('#customerNumberVaultGroup')?.value || '';
  try {
    const result = await window.yoko.upsertCustomerNumber?.({ phone, sourceType, type:sourceType, accountName, groupName, groupType:sourceType === 'community' ? 'community' : 'group' });
    if (!result?.ok) { setStatus('号码格式不正确，请使用含国家区号的号码。'); return; }
    $('#customerNumberVaultPhone').value = '';
    await refreshCustomerNumberVault({ quiet:true });
    setStatus(result.inserted ? '号码已保存到独立号码库。' : '号码已去重并更新来源。');
  } catch (error) { setStatus('号码保存失败：' + (error?.message || error)); }
});

$('#appCenterGrid')?.addEventListener('click', event => {
  const lineInstall = event.target.closest('[data-app-install-line]');
  if (lineInstall) { installPlatform('line'); return; }
  const lineRemove = event.target.closest('[data-app-remove-line]');
  if (lineRemove) { removePlatform('line'); return; }
  const line = event.target.closest('[data-app-enter-line]');
  if (line) { enterLineWorkspace(); return; }
  const install = event.target.closest('[data-app-install-platform]');
  if (install) { installPlatform(String(install.dataset.appInstallPlatform || '')); return; }
  const remove = event.target.closest('[data-app-remove-platform]');
  if (remove) { removePlatform(String(remove.dataset.appRemovePlatform || '')); return; }
  const enter = event.target.closest('[data-app-enter-platform]');
  if (enter) { ensureAndOpenPlatform(String(enter.dataset.appEnterPlatform || '')); return; }
  const manage = event.target.closest('[data-app-manage-platform]');
  if (manage) openAppAccountManager(String(manage.dataset.appManagePlatform || ''));
});

$('#appDashboardPlatformList')?.addEventListener('click', event => {
  const row = event.target.closest('[data-dashboard-platform]');
  if (!row) return;
  const platform = String(row.dataset.dashboardPlatform || '');
  if (platform === 'line') { enterLineWorkspace(); return; }
  ensureAndOpenPlatform(platform);
});
function openLeadFunnelPlatformFromRow(event) {
  const row = event.target.closest('[data-lead-funnel-platform]');
  if (!row) return;
  const platform = String(row.dataset.leadFunnelPlatform || '');
  if (!platform) return;
  ensureAndOpenPlatform(platform).then(() => {
    const accountId = String(row.dataset.leadFunnelAccount || '');
    if (!accountId) return;
    const accountRow = document.querySelector(`[data-external-account-id="${CSS.escape(accountId)}"]`);
    accountRow?.click?.();
  }).catch(() => null);
}
$('#leadFunnelPlatformList')?.addEventListener('click', openLeadFunnelPlatformFromRow);
$('#leadFunnelAccountList')?.addEventListener('click', openLeadFunnelPlatformFromRow);

$('#externalLeadCenterBtn')?.addEventListener('click', async () => {
  await openAppCenter('home');
  setTimeout(() => $('#leadFunnelCenter')?.scrollIntoView?.({ behavior:'smooth', block:'start' }), 80);
});

$('#dashboardAccountStatusList')?.addEventListener('click', event => {
  const row = event.target.closest('[data-dashboard-platform]');
  if (!row) return;
  const platform = String(row.dataset.dashboardPlatform || '');
  if (platform === 'line') { enterLineWorkspace(); return; }
  ensureAndOpenPlatform(platform);
});

function installPointerAccountReorder(list, { rowSelector, getId, onSave, canStart = () => true }) {
  if (!list) return;
  let pending = null;
  const interactiveSelector = 'button,input,select,textarea,a,[data-external-sidebar-action],[data-app-account-action],[contenteditable="true"]';
  const finish = async (event, canceled = false) => {
    if (!pending || (event?.pointerId != null && pending.pointerId !== event.pointerId)) return;
    const state = pending;
    pending = null;
    state.row.classList.remove('dragging');
    if (!state.started) return;
    event?.preventDefault?.();
    suppressExternalAccountClickUntil = Date.now() + 500;
    if (state.moved) {
      try {
        const ids = [...list.querySelectorAll(rowSelector)].map(getId).filter(Boolean);
        await onSave(ids, { canceled });
      } catch (error) {
        console.error('账号排序保存失败', error);
        setStatus('账号排序保存失败：' + (error?.message || error));
      }
    }
  };
  list.addEventListener('pointerdown', event => {
    if (pending || event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest(rowSelector);
    if (!row || !list.contains(row) || target.closest(interactiveSelector) || !canStart()) return;
    pending = { row, id: getId(row), pointerId: event.pointerId, x: event.clientX, y: event.clientY, started: false, moved: false };
  }, true);
  document.addEventListener('pointermove', event => {
    if (!pending || pending.pointerId !== event.pointerId) return;
    const state = pending;
    const distance = Math.hypot(event.clientX - state.x, event.clientY - state.y);
    if (!state.started && distance < 6) return;
    if (!state.started) {
      state.started = true;
      state.row.classList.add('dragging');
      document.body.classList.add('account-pointer-dragging');
    }
    event.preventDefault();
    const bounds = list.getBoundingClientRect();
    if (event.clientY < bounds.top + 24) list.scrollTop -= 12;
    else if (event.clientY > bounds.bottom - 24) list.scrollTop += 12;
    let target = document.elementFromPoint(event.clientX, event.clientY)?.closest(rowSelector);
    if (!target || !list.contains(target)) {
      const rows = [...list.querySelectorAll(rowSelector)].filter(row => row !== state.row);
      target = rows.find(row => event.clientY < row.getBoundingClientRect().bottom) || rows.at(-1) || null;
    }
    if (!target || target === state.row) return;
    const rect = target.getBoundingClientRect();
    const insertBefore = event.clientY < rect.top + rect.height / 2;
    const nextSibling = insertBefore ? target : target.nextElementSibling;
    if (state.row.nextElementSibling !== nextSibling) {
      list.insertBefore(state.row, nextSibling);
      state.moved = true;
    }
  }, { capture: true, passive: false });
  document.addEventListener('pointerup', event => { finish(event).finally(() => document.body.classList.remove('account-pointer-dragging')); }, true);
  document.addEventListener('pointercancel', event => { finish(event, true).finally(() => document.body.classList.remove('account-pointer-dragging')); }, true);
}

$('#externalAccountSidebarList')?.addEventListener('contextmenu', event => {
  const customer = event.target.closest('[data-platform-customer-key]');
  if (!customer) return;
  if (!(externalGlobalAggregateActive || (externalPlatformHasAggregateWorkspace(activeExternalPlatform) && externalWorkspaceModeFor(activeExternalPlatform) === 'aggregate'))) return;
  const key = String(customer.dataset.platformCustomerKey || '');
  const item = (externalAggregateInbox.conversations || []).find(row => externalAggregateKey(row) === key);
  if (item) showExternalAggregateCustomerContextMenu(event, item);
});

let suppressExternalAccountClickUntil = 0;

installPointerAccountReorder($('#externalAccountSidebarList'), {
  rowSelector: '[data-external-account-id]',
  getId: row => String(row.dataset.externalAccountId || ''),
  canStart: () => externalWorkspaceModeFor(activeExternalPlatform) !== 'aggregate',
  onSave: async ids => {
    const platform = String(activeExternalPlatform || '').trim();
    if (ids.length !== appCenterAccountsFor(platform).length) return;
    await window.yoko.reorderAppCenterAccounts(platform, ids);
    await refreshAppCenterState({ quiet:true });
    renderExternalWorkspace();
    setExternalStatus('账号顺序已保存');
  }
});

$('#externalAccountSidebarList')?.addEventListener('click', async event => {
  if (Date.now() < suppressExternalAccountClickUntil) { event.preventDefault(); return; }
  const customer = event.target.closest('[data-platform-customer-key]');
  if (customer && (externalGlobalAggregateActive || (externalPlatformHasAggregateWorkspace(activeExternalPlatform) && externalWorkspaceModeFor(activeExternalPlatform) === 'aggregate'))) {
    const key = String(customer.dataset.platformCustomerKey || '');
    const item = (externalAggregateInbox.conversations || []).find(row => externalAggregateKey(row) === key);
    if (item) openExternalAggregateCustomer(item);
    return;
  }
  const row = event.target.closest('[data-external-account-id]');
  if (!row) return;
  const id = String(row.dataset.externalAccountId || '');
  const account = externalAccountById(id);
  if (!account) return;
  const action = event.target.closest('[data-external-sidebar-action]')?.dataset.externalSidebarAction || '';
  if (action) {
    event.preventDefault();
    event.stopPropagation();
    try {
      if (action === 'phone') {
        beginExternalInlineAccountPhoneEdit(account, row);
        return;
      }
      if (action === 'toggle') {
        if (account.isOpen) {
          setExternalStatus(`正在关闭 ${account.name}…`);
          await window.yoko.closeAppCenterAccount(account.id);
          if (account.id === activeExternalAccountId) activeExternalAccountId = '';
          await refreshAppCenterState({ quiet:true });
          renderExternalWorkspace();
          setExternalStatus(`${account.name} 已关闭；再次点击 ▶ 可重新开启`);
        } else {
          setExternalStatus(`正在开启 ${account.name}…`);
          await window.yoko.openAppCenterAccount(account.id);
          activeExternalAccountId = account.id;
          await refreshAppCenterState({ quiet:true });
          renderExternalWorkspace();
          setExternalStatus(`${account.name} 已开启`);
        }
        return;
      }
      if (action === 'delete') {
        if (!window.confirm(`确定删除“${account.name}”吗？\n账号配置和 CRM 绑定会被移除；网页登录 Profile 默认保留。`)) return;
        const wasActive = account.id === activeExternalAccountId;
        await window.yoko.deleteAppCenterAccount(account.id);
        if (wasActive) activeExternalAccountId = '';
        await refreshAppCenterState({ quiet:true });
        renderExternalWorkspace();
        setExternalStatus(`${account.name} 已删除`);
        return;
      }
    } catch (error) {
      setExternalStatus('账号操作失败：' + (error?.message || error));
      return;
    }
  }
  openExternalAccount(id);
});
$('#externalAccountSidebarToggle')?.addEventListener('click', () => {
  applyExternalAccountSidebarState(!externalAccountSidebarCollapsed).catch(() => {});
});

async function runExternalBulkAccountAction(action) {
  const platform = String(activeExternalPlatform || '').trim();
  if (!platform || platform === 'line') return;
  const accounts = appCenterAccountsFor(platform);
  if (!accounts.length) { setExternalStatus('当前平台还没有账号'); return; }
  const buttons = [$('#externalStartAllBtn'), $('#externalCloseAllBtn')].filter(Boolean);
  buttons.forEach(btn => { btn.disabled = true; });
  try {
    let result;
    if (action === 'open') {
      setExternalStatus(`正在启动 ${accounts.length} 个账号…`);
      result = await window.yoko.openAllAppCenterAccounts(platform);
      setExternalStatus(`全部启动完成：${result?.opened ?? 0}/${result?.total ?? accounts.length}`);
    } else if (action === 'close') {
      const running = accounts.filter(item => item.isOpen).length;
      setExternalStatus(`正在关闭 ${running} 个账号…`);
      const closingActive = accounts.some(item => item.id === activeExternalAccountId);
      result = await window.yoko.closeAllAppCenterAccounts(platform);
      if (closingActive) activeExternalAccountId = '';
      setExternalStatus(`全部关闭完成：${result?.closed ?? 0}/${result?.total ?? running}，登录状态已保留`);
    }
    await refreshAppCenterState({ quiet:true });
    renderExternalWorkspace();
  } catch (error) {
    setExternalStatus('批量账号操作失败：' + (error?.message || error));
  } finally {
    buttons.forEach(btn => { btn.disabled = false; });
  }
}
$('#externalStartAllBtn')?.addEventListener('click', () => runExternalBulkAccountAction('open'));
$('#externalCloseAllBtn')?.addEventListener('click', () => runExternalBulkAccountAction('close'));

$('#externalAggregateModeBtn')?.addEventListener('click', () => setExternalPlatformWorkspaceMode('aggregate'));
$('#externalNativeModeBtn')?.addEventListener('click', () => { externalWaitingCenterActive = false; renderExternalWaitingCenterState(); setExternalPlatformWorkspaceMode('native'); });
$('#externalAggregateSearch')?.addEventListener('input', event => {
  externalAggregateSearch = String(event.target.value || '');
  renderExternalAggregateCustomers();
});
$('#externalAggregateAccountFilter')?.addEventListener('change', event => {
  externalAggregateAccountFilter = String(event.target.value || '');
  renderExternalAggregateCustomers();
});
$('#externalAggregatePlatformFilter')?.addEventListener('change', event => {
  externalAggregatePlatformFilter = String(event.target.value || '');
  externalAggregateAccountFilter = '';
  renderExternalAggregateFilters();
  renderExternalAggregateCustomers();
});
async function toggleExternalWaitingCenter() {
  externalWaitingCenterActive = !externalWaitingCenterActive;
  try {
    if (externalGlobalAggregateActive) {
      renderExternalAggregateCustomers();
      setExternalStatus(externalWaitingCenterActive ? `待回复中心 · ${externalWaitingCenterCount()} 位客户 · 已进入回复队列` : `全平台聚合 · ${externalAggregateInbox?.conversations?.length || 0} 个客户`);
      return;
    }
    const platform = String(activeExternalPlatform || '');
    if (!externalPlatformHasAggregateWorkspace(platform)) {
      externalWaitingCenterActive = false;
      renderExternalWaitingCenterState();
      setExternalStatus('当前平台还没有接入待回复中心。');
      return;
    }
    if (externalWaitingCenterActive && externalWorkspaceModeFor(platform) !== 'aggregate') {
      await setExternalPlatformWorkspaceMode('aggregate');
    } else {
      renderExternalAggregateCustomers();
    }
    const short = appCenterPlatformById(platform)?.short || platform.toUpperCase();
    setExternalStatus(externalWaitingCenterActive ? `${short}待回复 · ${externalWaitingCenterCount()} 位客户 · 已进入回复队列` : `${short}聚合 · ${externalAggregateInbox?.conversations?.length || 0} 个客户`);
  } catch (error) {
    setExternalStatus('打开待回复中心失败：' + (error?.message || error));
  }
}

async function openNextExternalRoundRobinCustomer() {
  const queue = externalRoundRobinCandidates();
  if (!queue.length) {
    renderExternalWaitingCenterState();
    setExternalStatus('当前没有待回复客户。');
    return;
  }
  const currentIndex = queue.findIndex(item => externalAggregateKey(item) === externalAggregateSelectedKey);
  const target = currentIndex >= 0 && queue.length > 1 ? queue[(currentIndex + 1) % queue.length] : queue[0];
  await openExternalAggregateCustomer(target);
}

$('#externalWaitingCenterBtn')?.addEventListener('click', toggleExternalWaitingCenter);
$('#externalAggregateWaitingBtn')?.addEventListener('click', toggleExternalWaitingCenter);
$('#externalRoundRobinBtn')?.addEventListener('click', () => {
  externalRoundRobinEnabledState = !externalRoundRobinEnabledState;
  saveExternalRoundRobinState();
  renderExternalAggregateCustomers();
  setExternalStatus(externalRoundRobinEnabledState
    ? `轮回已开启 · ${externalRoundRobinCandidates().length} 位待回复客户按最早等待顺序排列`
    : '轮回已关闭 · 客户恢复普通排序');
});
$('#externalRoundRobinNextBtn')?.addEventListener('click', () => openNextExternalRoundRobinCustomer().catch(error => setExternalStatus('打开下一位失败：' + (error?.message || error))));



$('#lineTeamHandoffBtn')?.addEventListener('click', () => openTeamSyncCenter());
$('#externalTeamHandoffBtn')?.addEventListener('click', () => openTeamSyncCenter());
$('#openStabilityDiagnosticsBtn')?.addEventListener('click', () => openStabilityDiagnostics());
$('#stabilityDiagRefreshBtn')?.addEventListener('click', () => refreshStabilityDiagnostics());
$('#stabilityDiagCopyBtn')?.addEventListener('click', async () => {
  const data=stabilityDiagnosticsLastSnapshot || await refreshStabilityDiagnostics({quiet:true});
  if(!data)return;
  const copied=await copyTextWithFallback(JSON.stringify(data,null,2));
  const msg=copied?'稳定性诊断已复制，可直接粘贴给我':'复制稳定性诊断失败';
  if(shellSurface==='external')setExternalStatus(msg);else setStatus(msg);
});


$('#stabilityBackupBtn')?.addEventListener('click', async () => {
  const btn=$('#stabilityBackupBtn');if(btn)btn.disabled=true;
  try{const result=await window.yoko.createOperationsBackup?.({source:'stability-center-v127266'});if(result?.ok)alert(`关键状态备份完成：${result.filePath||''}`);}catch(error){alert('备份失败：'+(error?.message||error));}finally{if(btn)btn.disabled=false;}
});
$('#stabilityRestoreBtn')?.addEventListener('click', async () => {
  if(!confirm('恢复关键状态会覆盖部分客户资料、Stage、GPT稳定绑定、人设和回复规则。登录Cookie、代理密码和API Key不会被恢复。继续吗？'))return;
  const btn=$('#stabilityRestoreBtn');if(btn)btn.disabled=true;
  try{const result=await window.yoko.restoreOperationsBackup?.();if(result?.ok)alert(`恢复完成。建议现在重启 Yoko。
${result.warning||''}`);}catch(error){alert('恢复失败：'+(error?.message||error));}finally{if(btn)btn.disabled=false;}
});
$('#stabilityStressBtn')?.addEventListener('click', async () => {
  const btn=$('#stabilityStressBtn');if(btn)btn.disabled=true;
  const old=btn?.textContent;if(btn)btn.textContent='压力测试中…';
  try{const result=await window.yoko.runStabilityStressTest?.({iterations:360,targets:18});if(!result?.ok)throw new Error(result?.error||'压力测试失败');const row=result.result||{};alert(row.passed?`压力测试 PASS：${row.iterations||0} 个合成任务，${row.elapsedMs||0}ms。`:`压力测试 FAIL：并发冲突 ${row.overlapViolations||0}。`);await refreshStabilityDiagnostics({quiet:true});}catch(error){alert('压力测试失败：'+(error?.message||error));}finally{if(btn){btn.disabled=false;btn.textContent=old||'运行安全压力测试';}}
});
$('#stabilityExportReportBtn')?.addEventListener('click', async () => {
  const btn=$('#stabilityExportReportBtn');if(btn)btn.disabled=true;
  try{const result=await window.yoko.exportLongRunStabilityReport?.();if(result?.ok)alert(`长期性能报告已导出：${result.filePath||''}`);}catch(error){alert('导出失败：'+(error?.message||error));}finally{if(btn)btn.disabled=false;}
});


$('#lineHandoffHealthBtn')?.addEventListener('click', () => openHandoffHealthCenter());
$('#externalHandoffHealthBtn')?.addEventListener('click', () => openHandoffHealthCenter());
$('#teamSyncHandoffHealthBtn')?.addEventListener('click', async () => { await closeModal('teamSyncModal'); await openHandoffHealthCenter(); });
$('#handoffHealthRefreshBtn')?.addEventListener('click', () => refreshHandoffHealth());
$('#handoffHealthSyncBtn')?.addEventListener('click', () => refreshHandoffHealth({syncFirst:true}));
$('#handoffHealthExportBtn')?.addEventListener('click', async () => {
  const btn=$('#handoffHealthExportBtn');if(btn)btn.disabled=true;
  try{const result=await window.yoko.createDiagnosticPack?.();if(result?.ok)alert(`诊断包已导出：${result.filePath||'完成'}`);}
  catch(error){alert('导出诊断包失败：'+(error?.message||error));}
  finally{if(btn)btn.disabled=false;}
});
$('#handoffHealthSelectProblemsBtn')?.addEventListener('click', () => {
  const boxes=Array.from(document.querySelectorAll('#handoffHealthTraceList .handoff-health-trace.bad input[data-handoff-trace-select]'));
  const shouldSelect=boxes.some(box=>!box.checked);
  boxes.forEach(box=>{box.checked=shouldSelect;});
});
$('#handoffHealthDeleteSelectedBtn')?.addEventListener('click', async () => {
  const boxes=Array.from(document.querySelectorAll('#handoffHealthTraceList input[data-handoff-trace-select]:checked'));
  const traceIds=[...new Set(boxes.flatMap(box=>String(box.dataset.traceIds||'').split(',').map(v=>v.trim()).filter(Boolean)))];
  if(!traceIds.length){alert('请先勾选要删除的链路事件。');return;}
  const ok=confirm(`确定删除所选 ${boxes.length} 条链路事件记录吗？

只会删除诊断历史，不会删除客户、承接任务、LINE绑定或GPT绑定。`);if(!ok)return;
  const btn=$('#handoffHealthDeleteSelectedBtn');if(btn)btn.disabled=true;
  try{
    const result=await window.yoko.bindTeamHandoffCurrentLine?.({action:'delete-health-traces',traceIds});
    if(!result?.ok)throw new Error(result?.error||'删除失败');
    renderHandoffHealth(result.health||null);
  }catch(error){alert('删除链路事件失败：'+(error?.message||error));}
  finally{if(btn)btn.disabled=false;}
});
$('#handoffHealthTaskList')?.addEventListener('click', async event => {
  const deleteBtn=event.target.closest('[data-handoff-task-delete]');
  const repairBtn=event.target.closest('[data-handoff-repair]');
  const button=deleteBtn||repairBtn;if(!button)return;
  const row=button.closest('[data-handoff-task-id]'); const taskId=String(row?.dataset.handoffTaskId||'');
  if(!taskId)return;
  if(deleteBtn){
    const name=String(row?.querySelector('.handoff-health-task-head strong')?.textContent||'这条异常任务').trim();
    const ok=confirm(`确定删除「${name}」对应的承接任务记录吗？\n\n这会让该任务从团队任务列表和链路健康异常统计中移除。不会删除客户CRM、LINE聊天、现有LINE客户关系或GPT历史绑定。\n\n删除后会写入防回流标记，旧电脑不能把这条任务重新同步回来。`);
    if(!ok)return;deleteBtn.disabled=true;
    try{
      const result=await window.yoko.bindTeamHandoffCurrentLine?.({action:'delete-team-task',taskId});
      if(!result?.ok)throw new Error(result?.error||'删除失败');
      renderTeamSyncState(result.state||await window.yoko.getTeamSyncState?.());
      await refreshHandoffHealth({quiet:true});
    }catch(error){alert('删除异常任务失败：'+(error?.message||error));}
    finally{deleteBtn.disabled=false;}
    return;
  }
  const repair=String(repairBtn.dataset.handoffRepair||'');
  if(!['gpt','crm'].includes(repair))return;
  const label=repair==='gpt'?'GPT连续性':'CRM/长期记忆';
  const ok=confirm(`只修复这条已绑定任务的「${label}」异常段，不会重新绑定 LINE 客户。\n\n确认继续？`); if(!ok)return;
  repairBtn.disabled=true;
  try{
    const result=await window.yoko.bindTeamHandoffCurrentLine?.({taskId,action:repair==='gpt'?'repair-gpt':'repair-crm'});
    if(!result?.ok)throw new Error(result?.error||'修复未完成');
    renderHandoffHealth(result.health||null);
    const remaining=Number(result.health?.counts?.unhealthy||0);
    alert(`${label}恢复已执行并重新校验。${remaining?`\n当前仍有 ${remaining} 条异常，请查看红色断点。`:'\n当前承接链已通过完整性检查。'}`);
  }catch(error){alert(`${label}恢复失败：${error?.message||error}`);await refreshHandoffHealth({quiet:true}).catch(()=>{});}
  finally{repairBtn.disabled=false;}
});
$('#teamSyncNowBtn')?.addEventListener('click', async () => {
  const btn=$('#teamSyncNowBtn'); if(btn)btn.disabled=true;
  try { const next=await window.yoko.syncTeamNow?.(); renderTeamSyncState(next); }
  catch(error){ renderTeamSyncState({...(teamSyncUiState||{}),lastError:String(error?.message||error)}); }
  finally{if(btn)btn.disabled=false;}
});
$('#teamSyncCopyConnectionCodeBtn')?.addEventListener('click', async () => {
  try{
    const bundle=teamConnectionBundleFromUi();
    if(!confirm('团队连接码包含同步密钥。只应发送给你自己的团队电脑，确定复制吗？'))return;
    const code=teamConnectionCodeEncode(bundle);
    if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(code);else throw new Error('clipboard-unavailable');
    teamConnectionTransferStatus('✓ 团队连接码已复制。到另一台电脑点击“粘贴连接码并连接”。','ok');
  }catch(error){teamConnectionTransferStatus(`导出失败：${String(error?.message||error)}`,'error');alert('复制团队连接码失败：'+(error?.message||error));}
});
$('#teamSyncExportConnectionFileBtn')?.addEventListener('click', async () => {
  try{
    const bundle=teamConnectionBundleFromUi();
    if(!confirm('连接文件包含团队同步密钥。请只保存到可信位置并用于你自己的团队电脑。继续导出吗？'))return;
    const blob=new Blob([JSON.stringify(bundle,null,2)],{type:'application/json;charset=utf-8'});
    const url=URL.createObjectURL(blob); const a=document.createElement('a');
    a.href=url;a.download='YokoSCRM_Team_Connection.yoko-team.json';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);
    teamConnectionTransferStatus('✓ 团队连接文件已导出。其他电脑选择该文件即可自动连接。','ok');
  }catch(error){teamConnectionTransferStatus(`导出失败：${String(error?.message||error)}`,'error');alert('导出团队连接文件失败：'+(error?.message||error));}
});
$('#teamSyncPasteConnectionCodeBtn')?.addEventListener('click', async () => {
  const btn=$('#teamSyncPasteConnectionCodeBtn');if(btn)btn.disabled=true;
  try{
    let value='';try{value=String(await navigator.clipboard?.readText?.()||'').trim();}catch{}
    if(!value)value=String(prompt('请粘贴主电脑生成的 Yoko SCRM 团队连接码：','')||'').trim();
    if(!value)return;
    await teamConnectionApply(teamConnectionParseInput(value));
  }catch(error){teamConnectionTransferStatus(`导入失败：${String(error?.message||error)}`,'error');alert('导入团队连接码失败：'+(error?.message||error));}
  finally{if(btn)btn.disabled=false;}
});
$('#teamSyncImportConnectionFileBtn')?.addEventListener('click', () => $('#teamSyncImportConnectionFileInput')?.click());
$('#teamSyncImportConnectionFileInput')?.addEventListener('change', async event => {
  const input=event.currentTarget;const file=input?.files?.[0];if(!file)return;
  const btn=$('#teamSyncImportConnectionFileBtn');if(btn)btn.disabled=true;
  try{
    if(Number(file.size||0)>32768)throw new Error('连接文件异常：文件过大。');
    const text=await file.text();await teamConnectionApply(teamConnectionParseInput(text));
  }catch(error){teamConnectionTransferStatus(`导入失败：${String(error?.message||error)}`,'error');alert('导入团队连接文件失败：'+(error?.message||error));}
  finally{if(input)input.value='';if(btn)btn.disabled=false;}
});

$('#teamSyncGenerateBtn')?.addEventListener('click', async () => {
  const btn=$('#teamSyncGenerateBtn'); if(btn)btn.disabled=true;
  try { const next=await window.yoko.generateTeamSyncCredentials?.(); teamSyncUiState=next; renderTeamSyncState(next); }
  catch(error){alert('生成团队凭据失败：'+(error?.message||error));}
  finally{if(btn)btn.disabled=false;}
});
$('#teamSyncSaveBtn')?.addEventListener('click', async () => {
  const btn=$('#teamSyncSaveBtn'); if(btn)btn.disabled=true;
  try {
    const mode=$('#teamSyncMode')?.value||'client'; const port=Number($('#teamSyncServerPort')?.value||17891)||17891;
    let serverUrl=String($('#teamSyncServerUrl')?.value||'').trim();
    let cloudflarePublicUrl=String($('#teamSyncCloudflarePublicUrl')?.value||'').trim();
    if(mode==='server-local'||mode==='server-lan')serverUrl=`http://127.0.0.1:${port}`;
    else if(mode==='server-cloudflare-token'){serverUrl=TEAM_FIXED_PUBLIC_URL;cloudflarePublicUrl=TEAM_FIXED_PUBLIC_URL;}
    else if(mode==='server-cloudflare-quick'){serverUrl='';cloudflarePublicUrl='';}
    const lineMappings={}; document.querySelectorAll('[data-team-line-map]').forEach(input=>{const id=input.getAttribute('data-team-line-map');const value=String(input.value||'').trim();if(id&&value)lineMappings[id]=value;});
    const next=await window.yoko.saveTeamSyncSettings?.({enabled:$('#teamSyncEnabled')?.value==='1',role:$('#teamSyncRole')?.value||'employee',mode,deviceName:String($('#teamSyncDeviceName')?.value||'').trim(),serverUrl,serverPort:port,teamId:String($('#teamSyncTeamId')?.value||'').trim(),apiKey:String($('#teamSyncApiKey')?.value||'').trim(),cloudflaredPath:String($('#teamSyncCloudflaredPath')?.value||'').trim(),cloudflarePublicUrl,cloudflareTunnelToken:'',clearCloudflareTunnelToken:mode==='server-cloudflare-token',lineMappings});
    if($('#teamSyncCloudflareToken'))$('#teamSyncCloudflareToken').value='';
    renderTeamSyncState(next); if(next?.lastError)throw new Error(next.lastError);
  } catch(error){alert('团队同步保存失败：'+(error?.message||error));}
  finally{if(btn)btn.disabled=false;}
});
$('#teamSyncMode')?.addEventListener('change', event => updateTeamSyncModeUi(event.target?.value||'client'));
$('#teamSyncCloudflareDetectBtn')?.addEventListener('click', async () => {
  const btn=$('#teamSyncCloudflareDetectBtn'); if(btn)btn.disabled=true;
  try { const result=await window.yoko.detectTeamCloudflared?.(String($('#teamSyncCloudflaredPath')?.value||'').trim()); if(result?.ok){if(result.command&&result.command.includes('\\'))$('#teamSyncCloudflaredPath').value=result.command;alert(`cloudflared 检测成功。\n${result.version||result.command}`);}else throw new Error(result?.error||'未检测到 cloudflared'); }
  catch(error){alert('cloudflared 检测失败：'+(error?.message||error));}
  finally{if(btn)btn.disabled=false;}
});
$('#teamSyncCloudflareDownloadBtn')?.addEventListener('click', async () => { try{await window.yoko.openTeamCloudflareDownload?.();}catch(error){alert('打开 Cloudflare 安装说明失败：'+(error?.message||error));} });
$('#teamSyncCloudflareTestBtn')?.addEventListener('click', async () => {
  const btn=$('#teamSyncCloudflareTestBtn'); if(btn)btn.disabled=true;
  try { const url=String($('#teamSyncCloudflarePublicUrl')?.value||teamSyncUiState?.cloudflarePublicUrl||'').trim(); const result=await window.yoko.testTeamCloudflarePublicUrl?.(url); if(result?.ok)alert(`Cloudflare 公网连接正常。\n${result.url}\n${result.service||''}`); else throw new Error(result?.error||'连接失败'); }
  catch(error){alert('Cloudflare 公网测试失败：'+(error?.message||error));}
  finally{if(btn)btn.disabled=false;}
});
$('#teamSyncCopyClientConfigBtn')?.addEventListener('click', async () => {
  const state=teamSyncUiState||{}; const currentMode=String($('#teamSyncMode')?.value||state.mode||''); const serverUrl=currentMode==='server-cloudflare-token'?TEAM_FIXED_PUBLIC_URL:String($('#teamSyncCloudflarePublicUrl')?.value||state.cloudflarePublicUrl||state.serverUrl||'').trim();
  if(!serverUrl){alert('还没有 Cloudflare 公网地址。请先保存并启动隧道。');return;}
  const payload={serverUrl,teamId:String($('#teamSyncTeamId')?.value||state.teamId||'').trim(),apiKey:String($('#teamSyncApiKey')?.value||state.apiKey||'').trim(),employeeMode:'client'};
  const text=`Yoko SCRM 员工连接配置\n服务器地址：${payload.serverUrl}\n团队ID：${payload.teamId}\n同步密钥：${payload.apiKey}\n运行模式：连接团队服务器`;
  try{await navigator.clipboard.writeText(text);alert('员工连接配置已复制。\n只包含团队服务器地址、团队ID和同步密钥，不包含 Cloudflare Tunnel Token。');}catch{alert(text);}
});

$('#teamNodeDeviceList')?.addEventListener('click', async event => {
  const button=event.target.closest('[data-team-device-delete]');if(!button)return;
  const deviceId=String(button.dataset.teamDeviceDelete||'').trim();if(!deviceId)return;
  const row=button.closest('[data-team-device-id]');
  const name=String(row?.querySelector('strong')?.textContent||deviceId).trim();
  const online=!row?.classList.contains('offline');
  const note=online?`\n\n这个节点当前仍显示在线；删除后如果设备还在运行，它下次同步时会自动重新出现。`:'';
  const ok=confirm(`确定从团队节点列表删除「${name}」吗？${note}

这不会删除该设备上的账号、Cookie、CRM或承接任务。`);if(!ok)return;
  button.disabled=true;
  try{
    const result=await window.yoko.bindTeamHandoffCurrentLine?.({action:'delete-team-device',deviceId});
    if(!result?.ok)throw new Error(result?.error||'删除失败');
    renderTeamSyncState(result.state||await window.yoko.getTeamSyncState?.());
  }catch(error){alert('删除团队节点失败：'+(error?.message||error));}
  finally{button.disabled=false;}
});

$('#teamSyncTaskList')?.addEventListener('click', async event => {
  const actionBtn=event.target.closest('[data-team-action]'); if(!actionBtn)return;
  const row=actionBtn.closest('[data-task-id]'); const taskId=row?.dataset.taskId||''; const action=actionBtn.dataset.teamAction;
  if(!taskId)return; actionBtn.disabled=true;
  try {
    if(action==='delete') {
      const customerName=String(row?.querySelector('.team-sync-task-main > strong')?.textContent||'这条任务').trim();
      const status=String(row?.className||'').includes('bound')?'已绑定任务':'承接任务';
      const ok=confirm(`确定删除「${customerName}」这条${status}记录吗？

只删除团队云端的承接任务记录，不删除客户CRM、LINE聊天记录、LINE客户绑定、GPT历史绑定或账号登录信息。

删除后会写入防回流标记，其他电脑残留的旧任务不会再次把它同步回来。`);
      if(!ok)return;
      const result=await window.yoko.bindTeamHandoffCurrentLine?.({action:'delete-team-task',taskId});
      if(!result?.ok)throw new Error(result?.error||'删除失败');
      renderTeamSyncState(result.state||await window.yoko.getTeamSyncState?.());
      return;
    }
    if(action==='accept') await window.yoko.acceptTeamHandoffTask?.(taskId);
    else if(action==='bind') {
      const ok=confirm('请确认：员工电脑已经在目标 LINE 账号中打开了刚添加的客户聊天。\n\n现在把这条 TikTok 客户档案绑定到“当前 LINE 客户”？');
      if(!ok)return;
      const result=await window.yoko.bindTeamHandoffCurrentLine?.({taskId});
      if(result?.ok) {
        const local=result.localCommit?.checks||{};
        const gpt=result.gptContinuity||{};
        const gptText=gpt.sourceBindingRequired ? (local.gptContinuity ? (gpt.bindingReplacedExisting?'✓ GPT：已同步原 TikTok 历史对话（旧 LINE 绑定不同，已切换）':(gpt.bindingInherited?'✓ GPT：已继承原 TikTok 历史对话':(gpt.bindingAlreadySame?'✓ GPT：LINE 已是同一历史对话':'✓ GPT：历史对话连续性已确认'))) : '✗ GPT：历史对话 URL 不一致，连续性未确认') : (gpt.destinationBindingExisting?'✓ GPT：来源暂无有效历史绑定，保留 LINE 现有绑定':'✓ GPT：来源客户暂无历史绑定，无需继承');
        const remoteText=result.remoteCommit?.ok?'✓ 云端：任务绑定已确认':'△ 云端：等待确认/下次同步';
        const warning=result.syncWarning?`\n\n云端同步提示：${result.syncWarning}`:'';
        alert(`绑定成功：${result.line?.displayName||'当前LINE客户'}\n\n✓ LINE：当前客户已识别${result.line?.identitySource?`（${result.line.identitySource}）`:''}\n✓ 任务：已绑定到当前 LINE 客户\n✓ CRM：TikTok资料与长期记忆已合并\n${gptText}\n${remoteText}${warning}`);
      }
    }
    const next=await window.yoko.getTeamSyncState?.(); renderTeamSyncState(next);
  } catch(error){alert('团队承接操作失败：'+(error?.message||error));}
  finally{actionBtn.disabled=false;}
});

$('#externalConversionDiagBtn')?.addEventListener('click', async () => {
  const button = $('#externalConversionDiagBtn');
  const old = button?.textContent || '转换诊断';
  if (button) { button.disabled = true; button.textContent = '诊断中…'; }
  try {
    const result = await window.yoko.runConversionDiagnostics?.(activeExternalPlatform || 'tiktok', activeExternalAccountId || '');
    const latest = result?.latest || {};
    const stage = String(latest?.contact?.stage || '');
    const progress = String(latest?.contact?.lineProgress || '');
    setExternalStatus(result?.ok
      ? `转换诊断已复制到剪贴板${stage ? ` · 当前阶段 ${stage}${progress ? ` / ${progress}` : ''}` : ''}，直接粘贴给我即可`
      : '转换诊断失败');
  } catch (error) {
    setExternalStatus('转换诊断失败：' + (error?.message || error));
  } finally {
    if (button) { button.disabled = false; button.textContent = old; }
  }
});

$('#externalLineIdSettingsBtn')?.addEventListener('click', () => openLineIdSettingsModal());
$('#lineIdAddBtn')?.addEventListener('click', () => {
  const lineId = String($('#lineIdValueInput')?.value || '').trim();
  const remark = String($('#lineIdRemarkInput')?.value || '').trim();
  if (!lineId) { setStatus('请先填写 LINE ID'); $('#lineIdValueInput')?.focus(); return; }
  const items = loadConfiguredLineIds();
  if (items.some(item => item.lineId.toLowerCase() === lineId.toLowerCase())) {
    setStatus(`LINE ID 已存在：${lineId}`);
    return;
  }
  items.push({ id:`manual-line-${Date.now()}-${Math.random().toString(36).slice(2,8)}`, lineId, remark });
  saveConfiguredLineIds(items);
  if ($('#lineIdValueInput')) $('#lineIdValueInput').value = '';
  if ($('#lineIdRemarkInput')) $('#lineIdRemarkInput').value = '';
  renderLineIdSettingsList();
  const current = $('#externalCrmTargetLine')?.value || '';
  refreshExternalTargetLineOptions(current, $('#externalCrmTargetLine')?.selectedOptions?.[0]?.textContent || '');
  setStatus(`已添加 LINE ID：${lineId}`);
  $('#lineIdValueInput')?.focus();
});
$('#lineIdSettingsList')?.addEventListener('click', event => {
  const button = event.target.closest('[data-line-id-delete]');
  if (!button) return;
  const key = String(button.dataset.lineIdDelete || '');
  const items = loadConfiguredLineIds();
  const target = items.find(item => item.id === key);
  if (!target) return;
  if (!window.confirm(`确定删除 LINE ID「${configuredLineIdLabel(target)}」吗？\n\n已保存到客户资料中的历史记录不会被删除。`)) return;
  saveConfiguredLineIds(items.filter(item => item.id !== key));
  renderLineIdSettingsList();
  const current = $('#externalCrmTargetLine')?.value || '';
  refreshExternalTargetLineOptions(current, $('#externalCrmTargetLine')?.selectedOptions?.[0]?.textContent || '');
  setStatus(`已删除 LINE ID：${target.lineId}`);
});
['lineIdValueInput','lineIdRemarkInput'].forEach(id => $('#'+id)?.addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); $('#lineIdAddBtn')?.click(); }
}));

$('#externalCrmExtractBtn')?.addEventListener('click', () => extractExternalCrmText());
$('#externalCrmSaveBtn')?.addEventListener('click', () => saveExternalCrmPanel());
$('#externalCrmCollapseBtn')?.addEventListener('click', async () => {
  const crmPlatform = externalGlobalAggregateActive ? EXTERNAL_GLOBAL_PLATFORM.id : activeExternalPlatform;
  if (!externalPlatformHasCrm(crmPlatform)) return;
  if (externalCrmAutoSaveTimer) {
    clearTimeout(externalCrmAutoSaveTimer);
    externalCrmAutoSaveTimer = null;
    await saveExternalCrmPanel().catch(() => {});
  }
  await applyExternalCrmCollapseState(crmPlatform, { persist: true, collapsed: true });
});
$('#externalCrmToolbarToggleBtn')?.addEventListener('click', async () => {
  if (!externalPlatformHasCrm(activeExternalPlatform)) return;
  const next = !externalCrmCollapsedFor(activeExternalPlatform);
  if (next && externalCrmAutoSaveTimer) {
    clearTimeout(externalCrmAutoSaveTimer);
    externalCrmAutoSaveTimer = null;
    await saveExternalCrmPanel().catch(() => {});
  }
  await applyExternalCrmCollapseState(activeExternalPlatform, { persist: true, collapsed: next });
});
for (const id of ['externalCrmName','externalCrmStage','externalCrmTargetLine','externalCrmServiceStatus','externalCrmTags','externalCrmRegion','externalCrmAge','externalCrmInterests','externalCrmOccupation','externalCrmNote']) {
  const node = $('#'+id);
  if (!node) continue;
  const eventName = node.tagName === 'SELECT' ? 'change' : 'input';
  node.addEventListener(eventName, () => {
    if (externalAggregateCrmHydrating || !externalAggregateCrmContext) return;
    if (id === 'externalCrmStage') {
      updateExternalLineStageUi({ autoTag:true, renderSummary:true });
      const preview = externalManualStageLinePreview($('#externalCrmStage')?.value || '新进线');
      if (preview) renderExternalCrmIntelligence({ ...(externalAggregateCrmContext?.crm || {}), ...preview });
    }
    else if (id === 'externalCrmTargetLine') updateExternalLineStageUi({ autoTag:false, renderSummary:true });
    else renderExternalCrmSummary(externalCrmFormSnapshot(), externalAggregateCrmContext);
    if ($('#externalCrmHeadState')) $('#externalCrmHeadState').textContent = '待保存';
    if ($('#externalCrmSaveStatus')) $('#externalCrmSaveStatus').textContent = '修改后自动保存到本机';
    if (externalCrmAutoSaveTimer) clearTimeout(externalCrmAutoSaveTimer);
    externalCrmAutoSaveTimer = setTimeout(() => {
      externalCrmAutoSaveTimer = null;
      saveExternalCrmPanel().catch(() => {});
    }, 700);
  });
}
$('#externalBackBtn')?.addEventListener('click', async () => {
  const accountId = String(activeExternalAccountId || '').trim();
  if (!accountId || activeExternalPlatform !== 'facebook') {
    await openAppCenter('apps');
    return;
  }
  const btn = $('#externalBackBtn');
  if (btn) btn.disabled = true;
  try {
    setExternalStatus('正在返回上一页…');
    const result = await window.yoko.goBackAppCenterAccount?.(accountId);
    if (result?.wentBack) {
      setExternalStatus('已返回 Facebook 上一页');
      return;
    }
    await openAppCenter('apps');
  } catch (error) {
    setExternalStatus('返回失败：' + (error?.message || error));
  } finally {
    if (btn) btn.disabled = false;
  }
});

$('#externalRefreshBtn')?.addEventListener('click', async () => {
  try {
    if (externalGlobalAggregateActive) {
      await refreshGlobalExternalAggregate({ remote:true, quiet:false, deepHarvest:true });
      return;
    }
    if (externalPlatformHasAggregateWorkspace(activeExternalPlatform) && externalWorkspaceModeFor(activeExternalPlatform) === 'aggregate') {
      await refreshExternalAggregate({ remote:true, quiet:false, deepHarvest: activeExternalPlatform === 'metabusiness' });
      return;
    }
    if (!activeExternalAccountId) return;
    setExternalStatus('正在刷新当前应用…');
    await window.yoko.reloadAppCenterAccount(activeExternalAccountId);
    setExternalStatus('刷新完成');
  } catch (error) { setExternalStatus('刷新失败：' + (error?.message || error)); }
});
$('#externalNetworkBtn')?.addEventListener('click', async () => {
  if (!activeExternalAccountId) return;
  try {
    setExternalStatus('正在测试当前线路…');
    const result = await window.yoko.testAppCenterAccountNetwork(activeExternalAccountId);
    setExternalStatus(result?.ok ? `线路正常 · ${result.ip || '-'} · ${result.latencyMs || 0}ms · ${result.mode === 'proxy' ? '代理' : '直连'}` : `线路失败：${result?.error || '未知错误'}`);
  } catch (error) { setExternalStatus('线路测试失败：' + (error?.message || error)); }
});
$('#externalProxyBtn')?.addEventListener('click', () => {
  const accountId = String(externalGlobalAggregateActive ? (externalAggregateSelected?.accountId || activeExternalAccountId || '') : activeExternalAccountId || '');
  if (accountId) openAppProxyModal(accountId);
  else setExternalStatus('请先在左侧选择 WS 账号，再打开代理设置');
});
$('#externalManageBtn')?.addEventListener('click', () => {
  if (activeExternalPlatform) openAppAccountManager(activeExternalPlatform);
});
$('#externalAddAccountBtn')?.addEventListener('click', () => {
  if (activeExternalPlatform) openAppAccountManager(activeExternalPlatform);
});


$('#externalGlobalFlowSettingsBtn')?.addEventListener('click', () => openExternalFlowSettingsModal());
$('#externalGlobalCustomerBtn')?.addEventListener('click', async () => {
  if (!externalGlobalAggregateActive) return;
  const next = !externalCrmCollapsedFor(EXTERNAL_GLOBAL_PLATFORM.id);
  await applyExternalCrmCollapseState(EXTERNAL_GLOBAL_PLATFORM.id, { persist:true, collapsed:next });
});
$('#externalGlobalAvatarBtn')?.addEventListener('click', async () => {
  if (!externalGlobalAggregateActive) return;
  const button = $('#externalGlobalAvatarBtn');
  const old = button?.textContent || '重抓头像';
  if (button) { button.disabled = true; button.textContent = '抓取中…'; }
  try {
    await refreshGlobalExternalAggregate({ remote:true, quiet:true });
    setExternalStatus(`头像重抓完成 · 已刷新 ${externalAggregateInbox?.conversations?.length || 0} 个客户`);
  } finally {
    if (button) { button.disabled = false; button.textContent = old; }
  }
});
$('#externalGlobalOpsBtn')?.addEventListener('click', () => openExternalOpsModal());
$('#externalGlobalDiagBtn')?.addEventListener('click', () => diagnoseExternalGlobalAccount());

$('#externalFlowStageAddBtn')?.addEventListener('click', () => {
  const input = $('#externalFlowStageInput');
  const value = String(input?.value || '').trim();
  if (!value) { input?.focus(); return; }
  const stages = loadExternalFlowStages();
  if (stages.some(stage => stage.toLocaleLowerCase() === value.toLocaleLowerCase())) {
    setExternalStatus(`流程阶段已存在：${value}`);
    input?.focus();
    return;
  }
  saveExternalFlowStages([...stages, value]);
  if (input) input.value = '';
  setExternalStatus(`已添加流程阶段：${value}`);
  input?.focus();
});
$('#externalFlowStageInput')?.addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); $('#externalFlowStageAddBtn')?.click(); }
});
$('#externalFlowStageList')?.addEventListener('click', event => {
  const up = event.target.closest('[data-external-flow-stage-up]');
  const down = event.target.closest('[data-external-flow-stage-down]');
  const del = event.target.closest('[data-external-flow-stage-delete]');
  const target = up || down || del;
  if (!target) return;
  const index = Number(up?.dataset.externalFlowStageUp ?? down?.dataset.externalFlowStageDown ?? del?.dataset.externalFlowStageDelete);
  const stages = loadExternalFlowStages();
  if (!Number.isInteger(index) || index < 0 || index >= stages.length) return;
  if (up && index > 0) [stages[index - 1], stages[index]] = [stages[index], stages[index - 1]];
  else if (down && index < stages.length - 1) [stages[index + 1], stages[index]] = [stages[index], stages[index + 1]];
  else if (del) {
    if (stages[index] === 'LINE已添加') return;
    stages.splice(index, 1);
  } else return;
  saveExternalFlowStages(stages);
});
$('#externalOpsRefreshBtn')?.addEventListener('click', async () => {
  await refreshAppCenterState({ quiet:true });
  renderExternalOps();
});
$('#externalOpsAggregateRefreshBtn')?.addEventListener('click', async () => {
  await refreshGlobalExternalAggregate({ remote:true, quiet:true });
  renderExternalOps();
  setExternalStatus('全平台聚合数据已刷新');
});
$('#externalOpsDiagnosticPackBtn')?.addEventListener('click', async () => {
  const button = $('#externalOpsDiagnosticPackBtn');
  const old = button?.textContent || '导出诊断包';
  if (button) { button.disabled = true; button.textContent = '正在收集…'; }
  try {
    const result = await window.yoko.createDiagnosticPack?.();
    if (result?.ok) setExternalStatus(`诊断包已导出：${result.filePath || '完成'}`);
  } catch (error) {
    setExternalStatus('导出诊断包失败：' + (error?.message || error));
  } finally {
    if (button) { button.disabled = false; button.textContent = old; }
  }
});

$('#appAccountAddBtn')?.addEventListener('click', async () => {
  if (!appAccountManagingPlatform) return;
  try {
    const platform = appAccountManagingPlatform;
    const name = String($('#appAccountNewName')?.value || '').trim();
    const account = await window.yoko.addAppCenterAccount(platform, name);
    $('#appAccountNewName').value = '';
    await refreshAppCenterState({ quiet: true });
    // If account creation was launched from an empty platform workspace, open
    // the newly-created account immediately; otherwise keep account manager open.
    if (shellSurface === 'external' && activeExternalPlatform === platform && !activeExternalAccountId) {
      await closeModal('appAccountModal');
      await openExternalAccount(account.id);
      return;
    }
    renderAppAccountManager();
    setStatus(`${account.name} 已创建 · 可单独配置代理后打开`);
  } catch (error) { setStatus('新增应用账号失败：' + (error?.message || error)); }
});

$('#appAccountList')?.addEventListener('click', async event => {
  if (Date.now() < suppressExternalAccountClickUntil) { event.preventDefault(); return; }
  const renameSave = event.target.closest('[data-app-account-rename-save]');
  const renameCancel = event.target.closest('[data-app-account-rename-cancel]');
  if (renameSave || renameCancel) {
    const renameRow = event.target.closest('[data-app-account-id]');
    const renameInput = renameRow?.querySelector('[data-app-account-rename-input]');
    if (!renameRow || !renameInput) return;
    if (renameCancel) { renderAppAccountManager(); return; }
    const nextName = String(renameInput.value || '').trim();
    if (!nextName) { renameInput.focus(); setStatus('账号名称不能为空'); return; }
    renameSave.disabled = true;
    try {
      await window.yoko.renameAppCenterAccount(renameRow.dataset.appAccountId, nextName);
      await refreshAppCenterState({ quiet:true });
      renderAppAccountManager();
      setStatus(`账号已重命名为：${nextName}`);
    } catch (error) {
      renameSave.disabled = false;
      setStatus('重命名失败：' + (error?.message || error));
    }
    return;
  }
  const actionBtn = event.target.closest('[data-app-account-action]');
  const row = event.target.closest('[data-app-account-id]');
  if (!actionBtn || !row) return;
  const id = String(row.dataset.appAccountId || '');
  const action = String(actionBtn.dataset.appAccountAction || '');
  const account = externalAccountById(id);
  if (!account) return;
  const wasActive = id === activeExternalAccountId;
  try {
    if (action === 'open') {
      await closeModal('appAccountModal');
      await openExternalAccount(id);
      return;
    } else if (action === 'close') {
      await window.yoko.closeAppCenterAccount(id);
    } else if (action === 'proxy') {
      await closeModal('appAccountModal');
      await openAppProxyModal(id);
      return;
    } else if (action === 'rename') {
      const nameNode = row.querySelector('.app-account-name');
      if (!nameNode) return;
      nameNode.innerHTML = `<input class="app-account-rename-input" data-app-account-rename-input maxlength="80" value="${escapeHtml(account.name || '')}" aria-label="新的账号名称"><div class="app-account-rename-actions"><button type="button" data-app-account-rename-save>保存</button><button type="button" data-app-account-rename-cancel>取消</button></div>`;
      const input = nameNode.querySelector('[data-app-account-rename-input]');
      input?.focus(); input?.select();
      return;
    } else if (action === 'delete') {
      if (!window.confirm(`确定从 Yoko 删除“${account.name}”吗？\n本机登录 Profile 默认保留，不会主动擦除网页登录数据。`)) return;
      await window.yoko.deleteAppCenterAccount(id);
    }
    await refreshAppCenterState({ quiet: true });
    if ((action === 'close' || action === 'delete') && wasActive && !appCenterState.activeAccountId) {
      await closeModal('appAccountModal');
      await openAppCenter('apps');
      return;
    }
    renderAppAccountManager();
    if (shellSurface === 'external') renderExternalWorkspace();
  } catch (error) { setStatus('应用账号操作失败：' + (error?.message || error)); }
});

$('#appAccountList')?.addEventListener('keydown', event => {
  const input = event.target.closest('[data-app-account-rename-input]');
  if (!input) return;
  if (event.key === 'Enter') {
    event.preventDefault(); event.stopPropagation();
    input.closest('[data-app-account-id]')?.querySelector('[data-app-account-rename-save]')?.click();
  } else if (event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation();
    input.closest('[data-app-account-id]')?.querySelector('[data-app-account-rename-cancel]')?.click();
  }
});

installPointerAccountReorder($('#appAccountList'), {
  rowSelector: '[data-app-account-id]',
  getId: row => String(row.dataset.appAccountId || ''),
  onSave: async ids => {
    if (ids.length !== appCenterAccountsFor(appAccountManagingPlatform).length) return;
    await window.yoko.reorderAppCenterAccounts(appAccountManagingPlatform, ids);
    await refreshAppCenterState({ quiet:true });
    renderAppAccountManager();
    setStatus('账号顺序已保存');
  }
});

$('#testAppProxyBtn')?.addEventListener('click', async () => {
  const resultBox = $('#appProxyTestResult');
  try {
    if (resultBox) resultBox.textContent = '正在测试…';
    const proxy = collectAppProxyForm();
    if (!proxy.enabled) {
      if (resultBox) resultBox.textContent = '当前未启用代理；保存后将使用直连。';
      return;
    }
    const result = await window.yoko.testAppCenterProxy(proxy);
    if (resultBox) resultBox.textContent = result?.ok ? `代理正常 · ${result.ip || '-'} · ${result.latencyMs || 0}ms` : `代理失败：${result?.error || '未知错误'}`;
  } catch (error) {
    if (resultBox) resultBox.textContent = '代理失败：' + (error?.message || error);
  }
});
$('#saveAppProxyBtn')?.addEventListener('click', async () => {
  if (!appProxyEditingAccountId) return;
  try {
    const proxy = collectAppProxyForm();
    await window.yoko.updateAppCenterAccountProxy(appProxyEditingAccountId, proxy);
    await refreshAppCenterState({ quiet: true });
    await closeModal('appProxyModal');
    if (shellSurface === 'external') renderExternalWorkspace();
    setExternalStatus(proxy.enabled ? '独立代理已保存并重新连接' : '已切换为直连');
  } catch (error) { setStatus('保存应用代理失败：' + (error?.message || error)); }
});
$('#aggregateRefreshBtn')?.addEventListener('click', () => refreshAggregateInbox({ remote: true, quiet: false }));
$('#aggregateSearch')?.addEventListener('input', () => renderAggregateInbox());
$('#aggregateAccountFilter')?.addEventListener('change', () => renderAggregateInbox());
$('#aggregateUnreadOnlyBtn')?.addEventListener('click', event => {
  aggregateUnreadOnly = !aggregateUnreadOnly;
  event.currentTarget.setAttribute('aria-pressed', aggregateUnreadOnly ? 'true' : 'false');
  event.currentTarget.textContent = aggregateUnreadOnly ? '未读 ✓' : '只看未读';
  renderAggregateInbox();
});
$('#aggregateCustomerSearch')?.addEventListener('input', () => {
  renderAggregateCustomerSidebar();
  scheduleAggregateWorkspaceSave();
});
$('#aggregateCustomerAccountFilter')?.addEventListener('change', event => {
  aggregateCustomerAccountFilter = String(event.currentTarget.value || '');
  aggregateCustomerRenderSignature = '';
  renderAggregateCustomerSidebar();
  scheduleAggregateWorkspaceSave();
});
$('#aggregateRecentCustomerSelect')?.addEventListener('change', event => {
  const key = String(event.currentTarget.value || '');
  if (key) openAggregateConversationByKey(key);
  event.currentTarget.value = '';
});
$('#aggregateAccountStats')?.addEventListener('click', event => {
  const button = event.target.closest('[data-account-id]');
  if (!button) return;
  const accountId = String(button.dataset.accountId || '');
  aggregateCustomerAccountFilter = aggregateCustomerAccountFilter === accountId ? '' : accountId;
  aggregateCustomerRenderSignature = '';
  renderAggregateCustomerSidebar();
  scheduleAggregateWorkspaceSave();
});
$('#aggregateNotificationBtn')?.addEventListener('click', async () => {
  await openModal('aggregateNotificationModal');
  renderAggregateNotificationCenter();
});
$('#aggregateNotificationReadAllBtn')?.addEventListener('click', () => markAggregateNotificationsRead(''));
$('#aggregateNotificationClearBtn')?.addEventListener('click', () => {
  aggregateNotificationState.items = [];
  saveAggregateNotificationState();
  renderAggregateNotificationBadge();
  renderAggregateNotificationCenter();
});
$('#aggregateNotificationList')?.addEventListener('click', async event => {
  const button = event.target.closest('[data-conversation-key]');
  if (!button) return;
  const key = String(button.dataset.conversationKey || '');
  markAggregateNotificationsRead(key);
  await closeModal('aggregateNotificationModal');
  if (workspaceMode !== 'aggregate') await setWorkspaceMode('aggregate');
  openAggregateConversationByKey(key);
});
document.querySelectorAll('.aggregate-customer-filter-btn').forEach(button => {
  button.addEventListener('click', () => {
    aggregateCustomerFilter = ['all', 'unread', 'read'].includes(String(button.dataset.filter || ''))
      ? String(button.dataset.filter)
      : 'all';
    renderAggregateCustomerSidebar();
    scheduleAggregateWorkspaceSave();
  });
});
$('#aggregateCustomerRefreshBtn')?.addEventListener('click', () => refreshAggregateInbox({ remote: true, quiet: false }));
document.querySelectorAll('[data-line-lifecycle-group]').forEach(button=>button.addEventListener('click',()=>{
  const next=String(button.dataset.lineLifecycleGroup||'all');
  aggregateLineLifecycleFilter=['all',...LINE_LIFECYCLE_GROUPS.map(group=>group.id)].includes(next)?next:'all';
  aggregateCustomerRenderSignature='';
  renderAggregateCustomerSidebar();
  scheduleAggregateWorkspaceSave();
}));
$('#aggregateCustomerList')?.addEventListener('pointerdown',event=>{if(event.target.closest('[data-line-day-calibration]'))event.stopPropagation();});
$('#aggregateCustomerList')?.addEventListener('click',event=>{
  const badge=event.target.closest('[data-line-day-calibration]');if(!badge)return;event.preventDefault();event.stopPropagation();
  const key=String(badge.dataset.lineDayKey||'');const item=(aggregateInbox?.conversations||[]).find(row=>aggregateConversationKey(row)===key);if(item)openCustomerDayCalibrationPicker(item,badge);
});
$('#aggregateCustomerList')?.addEventListener('scroll', scheduleAggregateWorkspaceSave, { passive: true });
$('#aggregateRoundRobinBtn')?.addEventListener('click', () => {
  aggregateRoundRobinState.enabled = aggregateRoundRobinState.enabled === false;
  saveAggregateRoundRobinState();
  aggregateCustomerRenderSignature = '';
  renderAggregateCustomerSidebar();
  setStatus(aggregateRoundRobinState.enabled !== false
    ? '轮回回复已开启：按消息先后从旧到新排列；真正回复或右键标记已读后进入新轮回，客户新来信会再次排队'
    : '轮回回复已关闭：恢复按未读和最近消息排序');
});
$('#aggregateRoundRobinNextBtn')?.addEventListener('click', () => {
  const current = currentAggregateConversation();
  if (current) markAggregateConversationViewed(current, { quiet: true });
  renderAggregateCustomerSidebar();
  renderAggregateUnreadBadge();
  const candidates = aggregateSmartNextCandidates();
  if (!candidates.length) {
    setStatus('当前没有需要继续处理的客户');
    return;
  }
  const currentIndex = candidates.findIndex(item => aggregateConversationKey(item) === aggregateSelectedConversationKey);
  const target = currentIndex >= 0 && candidates.length > 1
    ? candidates[(currentIndex + 1) % candidates.length]
    : candidates[0];
  const targetKey = aggregateConversationKey(target);
  let node = [...document.querySelectorAll('#aggregateCustomerList .aggregate-customer-item')]
    .find(item => String(item.dataset.conversationKey || '') === String(targetKey));
  if (!node && aggregateCustomerFilter !== 'all') {
    aggregateCustomerFilter = 'all';
    renderAggregateCustomerSidebar();
    node = [...document.querySelectorAll('#aggregateCustomerList .aggregate-customer-item')]
      .find(item => String(item.dataset.conversationKey || '') === String(targetKey));
  }
  if (node) {
    node.scrollIntoView({ block: 'nearest' });
    node.click();
  } else {
    setStatus('智能下一位暂时不可见，请刷新聚合列表后再试');
  }
});
$('#externalCrmMemoryToggle')?.addEventListener('click', () => $('#externalCrmMemoryPanel')?.classList.toggle('hidden'));
$('#crmSideMemoryToggle')?.addEventListener('click', () => $('#crmSideMemoryPanel')?.classList.toggle('hidden'));

const aggregateCrmPanelEditableIds = [
  'crmSideServiceStatus', 'crmSideStage', 'crmSideName', 'crmSideRegion', 'crmSideAge', 'crmSideInterests',
  'crmSideOccupation', 'crmSideTags', 'crmSideNote'
];
for (const id of aggregateCrmPanelEditableIds) {
  const node = $('#' + id);
  if (!node) continue;
  node.addEventListener(['crmSideServiceStatus', 'crmSideStage'].includes(id) ? 'change' : 'input', scheduleAggregateCrmPanelSave);
}
$('#crmSideSaveBtn')?.addEventListener('click', () => saveAggregateCrmPanel({ quiet: false }));
async function toggleLineCrmPanelFromEdge() {
  if (!crmPanelCollapsed && aggregateCrmPanelDirty) {
    await saveAggregateCrmPanel({ quiet: true }).catch(() => {});
  }
  const next = !crmPanelCollapsed;
  await setCrmPanelCollapsed(next, true);
  if (!next) {
    // Refresh the visible current customer after expanding from the persistent edge handle.
    if (workspaceMode === 'aggregate') await openAggregateCustomerCrm().catch(() => {});
    else await syncLineModeCrmPanel({ force:false }).catch(() => {});
  }
}
$('#crmSideCollapseBtn')?.addEventListener('click', toggleLineCrmPanelFromEdge);
$('#crmSideEdgeToggleBtn')?.addEventListener('click', toggleLineCrmPanelFromEdge);
clearAggregateCrmPanel();

$('#aggregateCustomerRestoreHiddenBtn')?.addEventListener('click', () => {
  if (!aggregateHiddenConversationKeys.size) return;
  const count = aggregateHiddenConversationKeys.size;
  if (!window.confirm(`恢复 ${count} 个已删除的聚合会话吗？`)) return;
  aggregateHiddenConversationKeys.clear();
  saveAggregateHiddenConversations();
  renderAggregateCustomerSidebar();
  setStatus(`已恢复 ${count} 个聚合会话`);
});
window.addEventListener('blur', closeAggregateCustomerContextMenu);
window.addEventListener('resize', closeAggregateCustomerContextMenu);
window.addEventListener('blur', closeNativeApiCustomerContextMenu);
window.addEventListener('resize', closeNativeApiCustomerContextMenu);

if (window.yoko.onAggregateUpdated) {
  window.yoko.onAggregateUpdated(payload => {
    if (!payload) return;
    scheduleOperationsDashboardRefresh();
    observeAggregateNotifications(payload);
    aggregateInbox = payload;
    renderAggregateUnreadBadge();
    renderLineCustomerStats();
    if (workspaceMode !== 'aggregate') return;

    // Multiple LINE accounts may publish snapshots almost together. Keep only
    // the newest combined payload and render once, rather than rebuilding the
    // whole customer list for each IPC event.
    if (aggregateUiRenderTimer) clearTimeout(aggregateUiRenderTimer);
    aggregateUiRenderTimer = setTimeout(() => {
      aggregateUiRenderTimer = null;
      if (workspaceMode !== 'aggregate') return;
      renderAggregateInbox();
      renderAggregateReplyDock();
      if (!aggregateCrmPanelContext && currentAggregateConversation()) {
        loadAggregateCrmPanel(currentAggregateConversation(), { quiet: true }).catch(() => {});
      }
    }, 220);
  });
}

if (window.yoko.onAggregateChatSwitch) {
  window.yoko.onAggregateChatSwitch(payload => {
    if (!payload || workspaceMode !== 'aggregate') return;
    const key = `${String(payload.accountId || '')}::${String(payload.chatId || '')}`;
    if (!key || key !== aggregateSelectedConversationKey) return;
    const item = currentAggregateConversation();
    const accountLabel = String(item?.accountRemark || item?.accountName || 'LINE').trim();
    const displayName = String(item?.crmProfile?.name || item?.displayName || payload.displayName || '客户').trim();
    if (payload.status === 'ready') {
      const latency = Math.max(0, Number(payload.latencyMs || 0) || 0);
      const speed = latency > 0 ? ` · ${latency}ms` : '';
      setStatus(`聚合模式 · ${accountLabel} · ${displayName} · 已加载${speed} · Tab下一位 / Ctrl+Tab上一位`);
      setTimeout(() => window.yoko.focusAggregateComposer?.(payload.accountId).catch(() => null), 25);
      refreshAggregateInbox({ remote: false, quiet: true }).catch(() => {});
    } else if (payload.status === 'failed') {
      setStatus(payload.error || `打开 ${displayName} 超时，可直接再点一次重试`);
    }
  });
}

// V1.15.20: when Tab/Ctrl+Tab originates from LINE's native composer, main.js forwards
// it here because only the shell knows the currently filtered/sorted customer
// order. Reusing the same DOM card click keeps all existing safety guards.
if (window.yoko.onAggregateKeyboardNav) {
  window.yoko.onAggregateKeyboardNav(payload => {
    if (workspaceMode !== 'aggregate') return;
    switchAggregateCustomerByOffset(Number(payload?.direction || 1), { source: Number(payload?.direction || 1) < 0 ? 'Ctrl+Tab' : 'Tab' });
  });
}

// V1.15.23 global customer search shortcut. It only activates in Aggregate
// Mode, so normal LINE shortcuts remain untouched.
document.addEventListener('keydown', event => {
  if (shellSurface !== 'line' || workspaceMode !== 'aggregate' || event.isComposing || event.altKey || event.metaKey) return;
  if (!event.ctrlKey || String(event.key || '').toLowerCase() !== 'k') return;
  const search = $('#aggregateCustomerSearch');
  if (!search) return;
  event.preventDefault();
  event.stopPropagation();
  search.focus();
  search.select?.();
  setStatus('全局客户搜索 · 支持姓名 / LINE ID / 地区 / 职业 / 备注 / 最近消息');
}, true);

// When focus is already in the shell customer list/background, provide the same
// shortcut locally. Editable Yoko fields keep their normal form-navigation Tab.
document.addEventListener('keydown', event => {
  if (shellSurface !== 'line' || workspaceMode !== 'aggregate' || event.key !== 'Tab') return;
  if (event.altKey || event.metaKey || event.isComposing) return;
  if (aggregateShellKeepsNativeTab(event.target)) return;

  // V1.15.20 shortcuts in the Yoko shell:
  //   Tab        -> next customer
  //   Ctrl+Tab   -> previous customer
  //   Shift+Tab  -> native reverse-focus navigation
  if (event.shiftKey && !event.ctrlKey) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
  const backwards = event.ctrlKey;
  switchAggregateCustomerByOffset(backwards ? -1 : 1, { source: backwards ? 'Ctrl+Tab' : 'Tab' });
}, true);

// Warm the local aggregate cache even while the user stays in normal LINE mode.
window.yoko.getAggregateInbox?.().then(payload => {
  if (!payload) return;
  observeAggregateNotifications(payload);
  aggregateInbox = payload;
  renderAggregateUnreadBadge();
  renderAggregateNotificationBadge();
  renderLineCustomerStats();
}).catch(() => {});

// V1.16.0: one lightweight operational backup per day. The main process skips
// immediately when today's file already exists, so this adds no recurring load.
setTimeout(() => {
  window.yoko.createAutoOperationsBackup?.(collectOperationsWorkspaceBackup()).catch(error => {
    console.debug('[Yoko automatic backup skipped]', error?.message || error);
  });
}, 5000);

let bulkLineActionRunning = false;

function setBulkLineControlsDisabled(disabled) {
  for (const id of ['startAllLineBtn', 'closeAllLineBtn']) {
    const button = $('#' + id);
    if (button) button.disabled = !!disabled;
  }
}

function summarizeBulkErrors(result) {
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  if (!errors.length) return '';
  const first = errors[0];
  return `；${errors.length} 个账号失败${first?.name ? `（首个：${first.name}）` : ''}`;
}

async function runBulkLineAction(kind) {
  if (bulkLineActionRunning) return;
  if (!state?.config?.accounts?.length) {
    setStatus('当前还没有 LINE 账号');
    return;
  }

  bulkLineActionRunning = true;
  setBulkLineControlsDisabled(true);

  try {
    let result;
    if (kind === 'start') {
      setStatus(`正在依次启动 ${state.config.accounts.length} 个 LINE…`);
      result = await window.yoko.openAllAccountWindows();
      await refreshState();
      setStatus(`全部启动完成：${result?.opened ?? 0}/${result?.total ?? state.config.accounts.length}${summarizeBulkErrors(result)}`);
    } else if (kind === 'close') {
      const running = state.config.accounts.filter(account => account.isOpen !== false).length;
      if (!running) {
        setStatus('当前没有已打开的 LINE');
        return;
      }
      setStatus(`正在关闭 ${running} 个 LINE…`);
      result = await window.yoko.closeAllAccountWindows();
      await refreshState();
      setStatus(`全部关闭完成：${result?.closed ?? 0}/${result?.total ?? running}，登录状态已保留${summarizeBulkErrors(result)}`);
    }
  } catch (error) {
    setStatus('LINE 全局操作失败：' + (error?.message || error));
    await refreshState().catch(() => {});
  } finally {
    bulkLineActionRunning = false;
    setBulkLineControlsDisabled(false);
  }
}

document.addEventListener('click', event => {
  if (!event.target.closest('.account-menu-wrap')) closeAccountActionMenus();
});

$('#startAllLineBtn')?.addEventListener('click', () => runBulkLineAction('start'));
$('#closeAllLineBtn')?.addEventListener('click', () => runBulkLineAction('close'));

$('#accountSidebarToggle').addEventListener('click', async () => {
  await applyAccountSidebarState(!accountSidebarCollapsed, true);
});

if (window.yoko.onTranslationStatus) {
  window.yoko.onTranslationStatus(payload => {
    if (!payload || payload.ok !== false) return;
    const label = payload.providerLabel || payload.engine || 'AI';
    setStatus(`翻译失败 · ${label}：${payload.error || '未知错误'}`);
  });
}

if (window.yoko.onTeamSyncUpdated) {
  window.yoko.onTeamSyncUpdated(payload => {
    const realtime=payload?.__nativeApiRealtime;
    if(realtime){
      if(realtime.type==='meta-receipt'){
        if(!nativeApiMasterEnabled)return;
        const selected=nativeApiSelected;
        const selectedPeer=String(selected?.remoteId||String(selected?.chatId||'').replace(/^fb-api:/,''));
        if(selected?.platform==='facebook'&&String(selected?.pageId||'')===String(realtime.pageId||'')&&selectedPeer===String(realtime.peerId||'')){
          // Requery authoritative SQLite; receipt event itself is not a chat message.
          refreshNativeApiSelectedMessages({quiet:true,force:false}).catch(()=>{});
        }
        return;
      }
      if(!nativeApiMasterEnabled||String(realtime.platform||'facebook')!=='facebook'||String(realtime.direction||'')!=='incoming')return;
      const pageId=String(realtime.pageId||''),peerId=String(realtime.peerId||'');
      const eventKey=String(realtime.eventKey||''),messageId=String(realtime.messageId||'');
      const text=String(realtime.text||'').trim();const timestampMs=Number(realtime.timestampMs||Date.now())||Date.now();
      if(!pageId||!peerId)return;
      const items=Array.isArray(nativeApiInboxState.items)?nativeApiInboxState.items:[];
      let item=items.find(row=>row?.platform==='facebook'&&String(row?.pageId||'')===pageId&&String(row?.remoteId||String(row?.chatId||'').replace(/^fb-api:/,''))===peerId);
      if(!item){
        item={surface:'native-api',platform:'facebook',platformName:'Facebook',source:'meta-api',accountId:`fb-api:${pageId}`,accountName:'Facebook Messenger API',chatId:`fb-api:${peerId}`,remoteId:peerId,pageId,conversationId:'',historyOnly:false,stableKey:`facebook|${pageId}|${peerId}`,displayName:`FB客户 · ${peerId.slice(-7)}`,avatarUrl:'',preview:text,lastTimestampMs:timestampMs,lastIncomingAt:timestampMs,firstIncomingAt:timestampMs,lastReplyAt:0,lastDirection:'incoming',lastEventKey:eventKey,messageCount:1,awaitingReply:true};
        nativeApiInboxState={...nativeApiInboxState,items:[item,...items],count:items.length+1};
      }else{
        const priorEvent=String(item.lastEventKey||'');
        const already=!!eventKey&&priorEvent===eventKey;
        Object.assign(item,{preview:text||item.preview,lastTimestampMs:Math.max(Number(item.lastTimestampMs||0),timestampMs),lastIncomingAt:Math.max(Number(item.lastIncomingAt||0),timestampMs),lastDirection:'incoming',lastEventKey:eventKey||item.lastEventKey,messageCount:Number(item.messageCount||0)+(already?0:1),awaitingReply:true});
      }
      nativeApiRegisterUnread(item,{delta:1,notify:true});
      nativeApiCustomerRenderSignature='';renderNativeApiCustomers({force:true});
      const selected=nativeApiSelected;
      const selectedPeer=String(selected?.remoteId||String(selected?.chatId||'').replace(/^fb-api:/,''));
      if(selected?.platform==='facebook'&&String(selected?.pageId||'')===pageId&&selectedPeer===peerId){
        nativeApiSelected={...selected,...item};renderNativeApiChatHead();
        const seen=nativeApiMessages.some(row=>String(row?.eventKey||'')===eventKey||(messageId&&String(row?.messageId||'')===messageId));
        if(!seen&&(text||eventKey)){
          nativeApiMessages.push({id:messageId||eventKey,eventKey,messageId,direction:'incoming',role:'customer',text,media:[],timestampMs,receivedAt:String(realtime.receivedAt||''),platform:'facebook',remoteId:peerId,pageId});
          nativeApiMessages.sort((a,b)=>Number(a?.timestampMs||0)-Number(b?.timestampMs||0));
          renderNativeApiMessages({keepBottom:true});scheduleNativeApiTranslations({preempt:true}).catch(()=>{});
        }
      }
      // Reconcile against authoritative VPS SQLite after the short legacy read cache expires.
      if(nativeApiRealtimePushTimer)clearTimeout(nativeApiRealtimePushTimer);
      nativeApiRealtimePushTimer=setTimeout(()=>{nativeApiRealtimePushTimer=null;refreshNativeApiInbox({quiet:true,hydrate:false}).catch(()=>{});},3000);
      return;
    }
    renderTeamSyncState(payload || {});
  });
}

window.yoko.onAccountStatus(payload => {
  if (!payload) return;
  scheduleOperationsDashboardRefresh();
  const accountId = String(payload.accountId || '');
  if (accountId) {
    if (['load-error', 'crashed'].includes(String(payload.status || ''))) {
      accountHealthState.set(accountId, { kind: 'error', at: Date.now(), message: payload.message || payload.reason || 'LINE异常' });
    } else if (payload.status === 'loaded') {
      accountHealthState.set(accountId, { kind: 'loaded', at: Date.now(), message: 'LINE已加载' });
    }
    if (state?.config?.accounts) renderAccounts();
  }

  if (payload.status === 'loaded') {
    setStatus('LINE 已加载 · 正在恢复登录…');
  } else if (payload.status === 'auth-ready') {
    const seconds = Math.max(0, Number(payload.startupMs || 0)) / 1000;
    setStatus(`LINE 已登录 · ${seconds.toFixed(1)}s`);
  } else if (payload.status === 'console-error') {
    setStatus(
      `LINE JS错误：${payload.message || 'unknown'}`
    );
  } else if (payload.status === 'load-error') {
    setStatus(
      `LINE 加载错误：${payload.message || 'unknown'}`
    );
  } else if (payload.status === 'crashed') {
    setStatus(
      `LINE 渲染进程异常：${payload.reason || 'unknown'}`
    );
  } else if (payload.status === 'unresponsive') {
    setStatus(payload.message || 'LINE 暂时无响应；运维中心只监控，不会自动重载');
  }
  if (!$('#opsModal')?.classList.contains('hidden')) refreshOpsHealth({ quiet: true }).catch(() => {});
});

window.yoko.onAccountOverview(payload => {
  if (!payload?.accountId || !state?.config?.accounts) return;
  scheduleOperationsDashboardRefresh();
  const account = state.config.accounts.find(a => a.id === payload.accountId);
  if (!account) return;
  account.live = { ...(account.live || {}), ...payload };
  if (payload.online === true) {
    accountHealthState.delete(String(payload.accountId || ''));
    // V1.15.31: startup never auto-enters Aggregate Mode.
  }
  if (payload.displayName || payload.userId || payload.avatarDataUrl || payload.pictureUrl) {
    account.lineProfile = {
      ...(account.lineProfile || {}),
      mid: payload.mid || account.lineProfile?.mid || '',
      userId: payload.userId || account.lineProfile?.userId || '',
      displayName: payload.displayName || account.lineProfile?.displayName || '',
      pictureUrl: payload.pictureUrl || account.lineProfile?.pictureUrl || '',
      avatarDataUrl: payload.avatarDataUrl || account.lineProfile?.avatarDataUrl || ''
    };
  }
  renderAccounts();
  if (workspaceMode === 'aggregate') {
    window.yoko.getAggregateInbox?.().then(payload => {
      if (payload) {
        aggregateInbox = payload;
        renderAggregateUnreadBadge();
        renderLineCustomerStats();
        renderAggregateCustomerSidebar();
      }
    }).catch(() => {});
  }
});


window.yoko.onCrmAutoExtracted?.(payload => {
  if (!payload?.contact) return;
  const platform = String(payload.platform || 'line').toLowerCase();
  const focusedId = String(document.activeElement?.id || '');
  const editingCrm = /^(?:crmSide|externalCrm)(?:Name|Region|Age|Interests|Occupation|Tags|Note)$/.test(focusedId);
  const refresh = async () => {
    if (platform === 'line') {
      if (workspaceMode === 'line') {
        const ctx = aggregateCrmPanelContext?.data || {};
        const same = String(ctx.accountId || $('#crmSideAccountId')?.value || '') === String(payload.accountId || '') &&
          ((payload.chatId && String(ctx.chatId || $('#crmSideChatId')?.value || '') === String(payload.chatId)) || (!payload.chatId && String(ctx.displayName || $('#crmSideDisplayName')?.value || '') === String(payload.displayName || '')));
        if (same) {
          showCrmAutoExtractToast(payload, 'line');
          if (editingCrm || aggregateCrmPanelDirty) return; // never overwrite text while the operator is typing/saving
          const data = { ...ctx, ok:true, accountId:payload.accountId, chatId:payload.chatId, displayName:payload.displayName, contact:payload.contact };
          fillAggregateCrmPanel(data, lineCrmItemFromData(data));
        } else if (!editingCrm && !aggregateCrmPanelDirty) {
          await syncLineModeCrmPanel({ force:true }).catch(() => {});
        }
        return;
      }
      if (workspaceMode === 'aggregate') {
        const item = currentAggregateConversation();
        if (!item) return;
        const same = String(item.accountId || '') === String(payload.accountId || '') &&
          ((payload.chatId && String(item.chatId || '') === String(payload.chatId)) || (!payload.chatId && String(item.displayName || '') === String(payload.displayName || '')));
        if (same) {
          showCrmAutoExtractToast(payload, 'line');
          if (editingCrm || aggregateCrmPanelDirty) return;
          fillAggregateCrmPanel({ ok:true, accountId:item.accountId, accountName:item.accountRemark || item.accountName || 'LINE', chatId:item.chatId, displayName:item.displayName, contact:payload.contact }, item);
        }
      }
      return;
    }
    const item = externalAggregateCrmContext || externalAggregateSelected || externalTikTokCrmLastGoodItem;
    if (!item) {
      queueExternalCrmAutoExtractToast(payload);
      // Ask the live native conversation to rebind immediately. This prevents a
      // LINE-added CRM event from leaving the panel blank until the next mode
      // switch or app restart.
      syncExternalTikTokCrmPanel({ force:true }).catch(() => {});
      return;
    }
    const same = crmAutoExtractCustomerMatches(item, payload);
    if (same) {
      showCrmAutoExtractToast(payload, 'external');
      pendingExternalCrmAutoExtractToast = null;
      if (editingCrm || externalCrmAutoSaveTimer) return;
      await hydrateExternalCrmPanel(item, { ok:true, platform, accountId:payload.accountId, chatId:payload.chatId, displayName:payload.displayName, contact:payload.contact }).catch(() => {});
    } else {
      // The native WebContentsView can report extraction a few hundred ms
      // before the CRM-side customer key finishes hydrating. Preserve the
      // feedback and replay it as soon as the matching panel is hydrated.
      queueExternalCrmAutoExtractToast(payload);
    }
  };
  refresh().catch(() => {});
});

let externalMetaSelectionPendingTimer = null;
let externalMetaSelectionPendingToken = 0;

window.yoko.onExternalNativeChatSelected?.(payload => {
  const platform=String(payload?.platform || '').trim().toLowerCase();
  const accountId=String(payload?.accountId || '').trim();
  if (shellSurface !== 'external' || !['tiktok','metabusiness','telegram'].includes(platform) || activeExternalPlatform !== platform || accountId !== String(activeExternalAccountId || '')) return;
  if (platform === 'metabusiness' && payload?.pending === true) {
    externalTikTokCrmLastKey='';
    externalTikTokCrmMissCount=0;
    // V1.27.83: do not flash “window switching” for a one-frame row-wrapper
    // parse miss. Most Meta selections resolve within the next wake frame. Only
    // show the pending state if it is still unresolved after 180ms.
    const token=++externalMetaSelectionPendingToken;
    if (externalMetaSelectionPendingTimer) clearTimeout(externalMetaSelectionPendingTimer);
    externalMetaSelectionPendingTimer=setTimeout(()=>{
      externalMetaSelectionPendingTimer=null;
      if(token!==externalMetaSelectionPendingToken)return;
      if ($('#externalCrmHeadState')) $('#externalCrmHeadState').textContent='识别新客户…';
      setExternalStatus('正在确认刚刚选择的 Meta Business 客户…');
    },180);
    return;
  }
  if (!payload?.displayName && !payload?.handle) return;

  if (platform === 'metabusiness') {
    // A pending trusted click can briefly be followed by an observer snapshot
    // of the OLD header. Keep the pending fence/UI intact until main confirms a
    // trusted row selection (or its bounded header-resolution fallback).
    if (payload?.selectionGuardPending === true && payload?.trustedCustomerSelection !== true) return;
    externalMetaSelectionPendingToken += 1;
    if (externalMetaSelectionPendingTimer) { clearTimeout(externalMetaSelectionPendingTimer); externalMetaSelectionPendingTimer=null; }
    // V1.27.41 native-only: never resolve the current MB customer through the
    // removed software aggregate inbox. The official native selection payload
    // is the single identity source for the right CRM panel.
    const displayName=String(payload?.displayName || '').trim();
    const handle=String(payload?.handle || '').replace(/^@/,'').trim();
    if (!displayName && !handle) return;
    const item={
      platform:'metabusiness', accountId, accountName:String(payload?.accountName || ''),
      chatId:displayName ? `name:${displayName}` : String(payload?.chatId || ''),
      displayName:displayName || (handle ? `@${handle}` : 'Meta Business 客户'),
      handle,
      avatarUrl:String(payload?.avatarUrl || '')
    };
    externalAggregateSelectedKey=externalAggregateKey(item);
    externalAggregateSelected=item;
    // Load persisted CRM directly for the official current chat. No aggregate
    // selection visual/list rebuild exists for MB anymore.
    hydrateExternalCrmPanel(item).catch(() => {});
    // Only a real trusted row click is allowed to change the GPT route. Meta
    // emits dom-ready/popstate identity hints too; those are observation-only.
    if (String(payload?.reason || '') === 'native-row-click' || payload?.trustedCustomerSelection === true) {
      autoShowChatgptForSelectedCustomer(80).catch(() => null);
    }
    return;
  }

  const item=platform==='telegram'
    ? {
        platform, accountId, accountName:String(payload?.accountName||''),
        chatId:String(payload?.chatId||'').trim() || `name:${String(payload?.displayName||payload?.handle||'Telegram 客户').trim()}`,
        displayName:String(payload?.displayName||'').trim() || (payload?.handle?`@${String(payload.handle).replace(/^@/,'')}`:'Telegram 客户'),
        handle:String(payload?.handle||'').replace(/^@/,'').trim(),
        avatarUrl:String(payload?.avatarUrl||''),
        preview:'', lastMessageAt:'', lastIncomingAt:0, lastReplyAt:''
      }
    : externalCrmItemFromCurrentTikTok({ ok:true, ...payload, platform, accountId });
  const key=externalAggregateKey(item);
  externalTikTokCrmMissCount=0;
  externalTikTokCrmLastSuccessAt=Date.now();
  externalTikTokCrmLastGoodItem=item;
  externalTikTokCrmLastKey=key;
  if (externalWorkspaceModeFor(platform) === 'aggregate' || externalGlobalAggregateActive) {
    externalAggregateSelectedKey=key;
    externalAggregateSelected=item;
    renderExternalAggregateCustomers();
  }
  // Native customer clicks are authoritative and should hydrate immediately,
  // not wait for the 900 ms polling loop. This is the hard rebind path.
  hydrateExternalCrmPanel(item, { ok:true, ...payload, platform, accountId }).catch(() => {});
  // V1.27.221: Telegram native selection must publish a fresh GPT target before
  // the operator sees bind/stage controls; otherwise the shell can keep the
  // previous no-target state until a later poll.
  if(platform==='telegram') refreshChatgptWorkbenchState().catch(()=>{});
  autoShowChatgptForSelectedCustomer(platform==='telegram'?40:80).catch(() => null);
});

window.yoko.onPlatformAggregateUpdated?.(payload => {
  const platform = String(payload?.platform || '');
  if (platform === 'metabusiness') return; // V1.27.41 native-only: no MB aggregate repaint path.
  if (!payload || !externalPlatformHasAggregateWorkspace(platform)) return;
  scheduleOperationsDashboardRefresh();
  if (externalGlobalAggregateActive) {
    externalGlobalPlatformInboxes.set(platform, payload);
    combineExternalGlobalAggregateInbox();
    if (shellSurface === 'external') {
      renderExternalAggregateFilters();
      renderExternalAggregateCustomers();
      renderExternalCustomerStats();
      if ($('#externalWorkspaceAccountLabel')) $('#externalWorkspaceAccountLabel').textContent = `${externalGlobalInstalledPlatforms().length} 个平台 · ${externalAggregateInbox.accounts?.length || 0} 个账号 · ${externalAggregateInbox.conversations?.length || 0} 个客户`;
    }
    return;
  }
  if (platform !== activeExternalPlatform) return;
  externalAggregateInbox = payload;
  if (externalAggregateSelectedKey) {
    const refreshed=(externalAggregateInbox?.conversations || []).find(row => externalAggregateKey(row) === externalAggregateSelectedKey);
    if (refreshed) {
      externalAggregateSelected=refreshed;
      // Explicit selection is the CRM authority. If a prior customer is still
      // shown on the right, rebind it to the selected aggregate row immediately.
      const crmKey=externalAggregateCrmContext ? externalAggregateKey(externalAggregateCrmContext) : '';
      if (crmKey !== externalAggregateSelectedKey) hydrateExternalCrmPanel(refreshed).catch(() => {});
    }
  }
  renderExternalCustomerStats();
  if (shellSurface === 'external' && externalWorkspaceModeFor(platform) === 'aggregate') {
    renderExternalAggregateFilters();
    renderExternalAggregateCustomers();
    if ($('#externalWorkspaceAccountLabel')) $('#externalWorkspaceAccountLabel').textContent = `聚合 ${payload.accounts?.length || 0} 个账号 · ${payload.conversations?.length || 0} 个客户`;
  }
});

// The main process persists visible WhatsApp numbers as soon as the native
// chat/profile probe finds one.  Refresh the dashboard immediately so the
// operator can see that automatic capture happened without pressing Save.
window.yoko.onCustomerNumberVaultUpdated?.(payload => {
  refreshCustomerNumberVault({ quiet: true }).catch(() => {});
  const added = Number(payload?.added || 0) || 0;
  const updated = Number(payload?.updated || 0) || 0;
  if (added || updated) setStatus(`客户号码库已自动记录：新增 ${added}，更新 ${updated}`);
});

window.yoko.onAppCenterResourceWarning?.(payload => {
  if (!payload || String(payload.accountId || '') !== String(activeExternalAccountId || '')) return;
  const message=String(payload.message || '').trim();
  if (message) setExternalStatus(message);
});

// V1.27.216: Esc pressed inside Facebook's embedded Chromium view is captured
// in main.js. When there is no browser history, main asks the shell to perform
// the same App Center fallback as the visible Back button.
window.yoko.onFacebookWorkspaceBackFallback?.(payload => {
  if (!payload) return;
  if (shellSurface !== 'external' || activeExternalPlatform !== 'facebook') return;
  if (String(payload.accountId || '') !== String(activeExternalAccountId || '')) return;
  openAppCenter('apps').catch(error => setExternalStatus('返回应用中心失败：' + (error?.message || error)));
});

window.yoko.onAppCenterUpdated?.(payload => {
  if (!payload) return;
  scheduleOperationsDashboardRefresh();
  appCenterState = payload;
  const backendId = String(payload.activeAccountId || '');
  const backendActive = externalAccountById(backendId);
  if (externalGlobalAggregateActive && shellSurface === 'external') {
    if (externalAggregateSelected) {
      activeExternalPlatform = String(externalAggregateSelected.platform || activeExternalPlatform || '');
      activeExternalAccountId = String(backendId || externalAggregateSelected.accountId || activeExternalAccountId || '');
    } else {
      activeExternalAccountId = '';
    }
  } else if (shellSurface === 'external' && activeExternalPlatform) {
    const current = (payload.accounts || []).find(a => String(a.id || '') === String(activeExternalAccountId || '') && String(a.platform || '') === String(activeExternalPlatform || ''));
    if (backendActive && String(backendActive.platform || '') === String(activeExternalPlatform || '')) {
      activeExternalAccountId = backendId;
    } else if (current) {
      activeExternalAccountId = String(current.id || '');
    } else {
      const fallback = (payload.accounts || []).find(a => String(a.platform || '') === String(activeExternalPlatform || ''));
      activeExternalAccountId = String(fallback?.id || '');
    }
  } else {
    activeExternalAccountId = backendId;
    if (backendActive) activeExternalPlatform = backendActive.platform;
  }
  if (!externalGlobalAggregateActive && shellSurface === 'external' && payload.shellSurface === 'app-center' && !activeExternalAccountId && !activeExternalPlatform) {
    appCenterOpen = true;
    setAppCenterPane('apps');
    setShellBodyClass('app-center');
  }
  renderAppCenter();
  if (shellSurface === 'external') renderExternalWorkspace();
});

window.yoko.onStartupError(message => {
  setStatus('启动账号失败：' + message);
});

refreshLineFlowStageOptions();
document.addEventListener('pointerdown',()=>nativeApiEnsureNotificationAudio(),{once:true,capture:true});
document.addEventListener('keydown',()=>nativeApiEnsureNotificationAudio(),{once:true,capture:true});
window.addEventListener('beforeunload',()=>{nativeApiPersistDraftState();nativeApiPersistFirstIncomingState();});
startRuntimePerformanceMonitor();
window.addEventListener('resize', scheduleWorkspaceLayoutMetrics);
applyWorkspaceLayoutCss();
syncWorkspaceLayoutMetrics().catch(() => {});

let officialApiShellBooted=false;
function officialApiRenderAuth(auth={}){
  const gate=$('#officialApiLoginGate');
  const badge=$('#officialApiUserBadge');
  const name=$('#officialApiUserName');
  const logged=auth?.authenticated===true;
  if(gate)gate.classList.toggle('hidden',logged);
  if(badge)badge.style.display=logged?'inline-flex':'none';
  if(name)name.textContent=logged?`${auth.user?.displayName||auth.user?.username||'已登录'} · 软件账号`:'';
  return logged;
}
function officialApiLoginStatus(message='',error=false){
  const node=$('#officialApiLoginStatus');if(node){node.textContent=String(message||'');node.style.color=error?'#b14635':'#3b7188';}
}
async function bootOfficialApiShell(){
  if(officialApiShellBooted)return;
  officialApiShellBooted=true;
  await applyAccountSidebarState(accountSidebarCollapsed, false);
  await refreshState();
  nativeApiLoadUnreadState();
  nativeApiLoadHiddenState();
  nativeApiLoadManualReadState();
  nativeApiLoadDraftState();
  nativeApiLoadFirstIncomingState();
  nativeApiRenderNotificationState();
  nativeApiRenderTodayNewStat();
  await syncNativeApiMasterState();
  startNativeApiGlobalNotificationMonitor();
  await restoreAggregateWorkspaceAfterStartup();
  await refreshAppCenterState({ quiet: true });
  await refreshChatgptWorkbenchState();
  await openAppCenter('home');
}
async function startOfficialApiLoginGate(){
  const form=$('#officialApiLoginForm');const button=$('#officialApiLoginBtn');
  $('#officialApiLogoutBtn')?.addEventListener('click',async()=>{
    try{await window.yoko.appAuthLogout?.();}catch{}
    window.location.reload();
  });
  window.yoko.onAppAuthUpdated?.(auth=>officialApiRenderAuth(auth));
  // This is the software account gate, not the VPS/Facebook API login.
  // Every process starts locked and must be explicitly unlocked by a local
  // Yoko user before the CRM shell is booted.
  officialApiRenderAuth({authenticated:false});
  officialApiLoginStatus('请输入软件账号和密码');
  form?.addEventListener('submit',async event=>{
    event.preventDefault();if(button)button.disabled=true;officialApiLoginStatus('正在验证软件账号…');
    try{
      const auth=await window.yoko.appAuthLogin({username:$('#officialApiUsername')?.value||'',password:$('#officialApiPassword')?.value||''});
      officialApiRenderAuth(auth);officialApiLoginStatus('登录成功，正在打开应用中心…');
      if($('#officialApiPassword'))$('#officialApiPassword').value='';
      await bootOfficialApiShell();
    }catch(error){officialApiLoginStatus(error?.message||String(error),true);if(button)button.disabled=false;}
  });
}

startOfficialApiLoginGate().catch(error=>officialApiLoginStatus(error?.message||String(error),true));

/*
 * The shell is intentionally booted only after the VPS account gate succeeds.
 * Keeping this sequence in one function prevents background official-API
 * polling from starting while the login page is visible.
 */
/* legacy startup sequence moved into bootOfficialApiShell */
/*
applyAccountSidebarState(accountSidebarCollapsed, false)
  .then(async () => {
    await refreshState();
    nativeApiLoadUnreadState();
    nativeApiLoadHiddenState();
    nativeApiLoadManualReadState();
    nativeApiLoadDraftState();
    nativeApiLoadFirstIncomingState();
    nativeApiRenderNotificationState();
    nativeApiRenderTodayNewStat();
    await syncNativeApiMasterState();
    startNativeApiGlobalNotificationMonitor();
    await restoreAggregateWorkspaceAfterStartup();
    await refreshAppCenterState({ quiet: true });
    await refreshChatgptWorkbenchState();
    // V1.23.6 starts at the operations dashboard. The application center
    // remains available from the left "应用" entry, while LINE continues its
    // authenticated startup off-screen at a real viewport in the main process.
    await openAppCenter('home');
  })
  .catch(error => setStatus(error.message));*/

// V1.23.51 business-engine initial labels.
renderLineBusinessEngineHint($('#crmSideStage')?.value || lineFlowDefaultStage());
renderExternalBusinessEngineHint($('#externalCrmStage')?.value || loadExternalFlowStages()[0] || '新进线');
