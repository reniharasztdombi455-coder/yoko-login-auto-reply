'use strict';

const crypto = require('crypto');

function text(value, max = 5000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}
function slug(value, max = 160) {
  return text(value, max).toLowerCase().replace(/^@+/, '').replace(/\s+/g, ' ').trim();
}
function uniqStrings(values, max = 80) {
  const out=[]; const seen=new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const v=text(value, 300); if (!v) continue; const key=v.toLocaleLowerCase();
    if (seen.has(key)) continue; seen.add(key); out.push(v); if (out.length>=max) break;
  }
  return out;
}
function hashId(...parts) {
  return crypto.createHash('sha256').update(parts.map(v=>String(v ?? '')).join('\u001f')).digest('hex');
}
function randomId(prefix='id') { return `${prefix}-${crypto.randomUUID()}`; }
function normalizeTeamSettings(raw={}) {
  return {
    enabled: raw.enabled === true,
    mode: ['client','server-local','server-lan','server-cloudflare-quick','server-cloudflare-token'].includes(String(raw.mode||'')) ? String(raw.mode) : (String(raw.mode||'') === 'server' ? 'server-local' : 'client'),
    serverUrl: text(raw.serverUrl || 'http://127.0.0.1:17891', 500).replace(/\/+$/, ''),
    serverPort: Math.max(1024, Math.min(65535, Number(raw.serverPort || 17891) || 17891)),
    teamId: text(raw.teamId, 100),
    apiKey: text(raw.apiKey, 200),
    deviceId: text(raw.deviceId, 120) || randomId('device'),
    deviceName: text(raw.deviceName, 120) || 'Yoko设备',
    role: ['admin','employee'].includes(String(raw.role||'')) ? String(raw.role) : 'employee',
    syncIntervalMs: Math.max(3000, Math.min(60000, Number(raw.syncIntervalMs || 6000) || 6000)),
    autoStartServer: raw.autoStartServer === true,
    cloudflarePublicUrl: text(raw.cloudflarePublicUrl || '', 500).replace(/\/+$/, ''),
    cloudflaredPath: text(raw.cloudflaredPath || '', 1000),
    cloudflareTunnelTokenProtected: text(raw.cloudflareTunnelTokenProtected || '', 20000),
    lineMappings: raw.lineMappings && typeof raw.lineMappings === 'object' ? { ...raw.lineMappings } : {},
    lastSyncAt: text(raw.lastSyncAt, 80),
    lastError: text(raw.lastError, 500)
  };
}
function lineLogicalKey(name='') {
  return slug(name, 180).replace(/[·•・\s]+/g,'').trim();
}
// V1.25.8: a configured routing label may be rendered as
// "备注 · LINE_ID" (for example "日本04 · yumi_ko0517"), while the
// employee-side endpoint mapping intentionally uses only the stable logical
// remark ("日本04"). Treat both halves as aliases without rewriting the
// existing task id/logical key, so already-synced handoff tasks remain valid.
function lineIdentityAliases(values=[]) {
  const source=Array.isArray(values)?values:[values];
  const out=[]; const seen=new Set();
  const push=value=>{ const key=lineLogicalKey(value); if(!key||seen.has(key))return; seen.add(key); out.push(key); };
  for(const value of source){
    const raw=text(value,300); if(!raw)continue;
    push(raw);
    const parts=raw.split(/\s*[·•・｜|]\s*/).map(part=>text(part,180)).filter(Boolean);
    if(parts.length>1) for(const part of parts) push(part);
  }
  return out;
}
function lineIdentityMatches(targetValues=[], endpointValues=[]) {
  const target=lineIdentityAliases(targetValues);
  const endpoint=new Set(lineIdentityAliases(endpointValues));
  return target.some(key=>endpoint.has(key));
}

function sanitizeRecentMessages(rows=[]) {
  return (Array.isArray(rows)?rows:[]).slice(-16).map((row,index)=>({
    role:String(row?.role||'')==='me'?'me':'customer',
    text:text(row?.text,700),
    at:text(row?.capturedAt||row?.at||row?.timeText||'',80),
    id:text(row?.id||row?.sourceKey||`m-${index}`,120)
  })).filter(row=>row.text);
}
function sanitizeMemoryItems(items=[]) {
  return (Array.isArray(items) ? items : []).slice(-80).map(row=>({
    type:text(row?.type,40), label:text(row?.label,60), text:text(row?.text,260), updatedAt:text(row?.updatedAt,80)
  })).filter(row=>row.text);
}
function sanitizeCrmContact(contact={}, meta={}) {
  const platform=text(meta.platform || contact.platform,30).toLowerCase();
  const sourceAccountId=text(meta.accountId || contact.accountId,128);
  const chatId=text(meta.chatId || contact.chatId,300);
  const displayName=text(meta.displayName || contact.displayName,180);
  const handle=text(meta.handle || contact.handle,180).replace(/^@+/, '');
  const identityKey = handle ? `handle:${slug(handle,180)}` : (chatId ? `chat:${text(chatId,300)}` : `name:${slug(displayName,180)}`);
  const globalCustomerId = text(contact.globalCustomerId,120) || hashId('customer', platform, sourceAccountId, identityKey);
  const origins=[];
  const pushOrigin=row=>{
    if(!row||typeof row!=='object')return;
    const origin={platform:text(row.platform||row.sourcePlatform,30).toLowerCase(),accountId:text(row.accountId||row.sourceAccountId,128),accountName:text(row.accountName||row.sourceAccountName,160),chatId:text(row.chatId||row.sourceChatId,300),displayName:text(row.displayName||row.sourceDisplayName,180),handle:text(row.handle||row.sourceHandle,180).replace(/^@+/,''),linkedAt:text(row.linkedAt,80)};
    if(!origin.platform)return;
    const key=`${origin.platform}|${origin.accountId}|${origin.handle||origin.chatId||slug(origin.displayName,180)}`;
    if(origins.some(x=>x._key===key))return;
    origins.push({...origin,_key:key});
  };
  pushOrigin({platform,accountId:sourceAccountId,accountName:meta.accountName,chatId,displayName,handle});
  for(const row of Array.isArray(contact.origins)?contact.origins:[])pushOrigin(row);
  if(contact.crossPlatform&&typeof contact.crossPlatform==='object')pushOrigin({platform:contact.crossPlatform.sourcePlatform,accountName:contact.crossPlatform.sourceAccountName,displayName:contact.crossPlatform.sourceDisplayName,handle:contact.crossPlatform.sourceHandle,linkedAt:contact.crossPlatform.linkedAt});
  return {
    globalCustomerId,
    origins:origins.map(({_key,...row})=>row).slice(-12),
    sourcePlatform:platform,
    sourceAccountId,
    sourceAccountName:text(meta.accountName,160),
    sourceChatId:chatId,
    sourceDisplayName:displayName,
    sourceHandle:handle,
    name:text(contact.name,160), region:text(contact.region,100), age:text(contact.age,20),
    occupation:text(contact.occupation,160), interests:text(contact.interests,500),
    tags:text(contact.tags,400), note:text(contact.note,4000), summary:text(contact.summary,1200),
    memoryItems:sanitizeMemoryItems(contact.memoryItems), memorySummary:text(contact.memorySummary,1600),
    sourceRecentMessages:sanitizeRecentMessages(meta.recentMessages || contact?.crossPlatform?.recentMessages || []),
    language:text(contact.language,20), stage:text(contact.stage,60), serviceStatus:text(contact.serviceStatus,30),
    lineIntent:text(contact.lineIntent,40), lineIntentScore:Math.max(0,Math.min(100,Number(contact.lineIntentScore||0)||0)),
    lineProgress:text(contact.lineProgress,40), lineEvidence:text(contact.lineEvidence,500),
    targetLineAccountId:text(contact.targetLineAccountId,128), targetLineAccountName:text(contact.targetLineAccountName,180),
    targetLineLogicalKey:lineLogicalKey(contact.targetLineAccountName || meta.targetLineAccountName || ''),
    relationshipStartedAt:text(contact.relationshipStartedAt || contact.firstContactAt || contact.createdAt,80),
    relationshipStartedAtSource:text(contact.relationshipStartedAtSource,80),
    updatedAt:text(contact.updatedAt,80) || new Date().toISOString(), createdAt:text(contact.createdAt,80)
  };
}
function buildHandoffTask(contactSnapshot={}, meta={}) {
  const c=sanitizeCrmContact(contactSnapshot, meta);
  if (c.sourcePlatform === 'line' || c.stage !== 'LINE已添加' || !c.targetLineLogicalKey) return null;
  const taskId=hashId('handoff', c.globalCustomerId, c.targetLineLogicalKey);
  return {
    taskId,
    globalCustomerId:c.globalCustomerId,
    type:'lead-to-line',
    status:'pending',
    sourcePlatform:c.sourcePlatform,
    sourceAccountId:c.sourceAccountId,
    sourceAccountName:c.sourceAccountName,
    sourceChatId:c.sourceChatId,
    sourceDisplayName:c.sourceDisplayName,
    sourceHandle:c.sourceHandle,
    targetLineLogicalKey:c.targetLineLogicalKey,
    targetLineAccountName:c.targetLineAccountName,
    customer:c,
    assignedDeviceId:'', assignedDeviceName:'',
    boundLineAccountId:'', boundLineAccountName:'', boundLineChatId:'', boundLineDisplayName:'',
    createdAt:new Date().toISOString(), updatedAt:new Date().toISOString()
  };
}
function publicLineEndpoints(accounts=[], settings={}) {
  const mappings=settings?.lineMappings && typeof settings.lineMappings==='object' ? settings.lineMappings : {};
  return (Array.isArray(accounts)?accounts:[]).filter(a=>a && a.id).map(a=>{
    const defaultName=text(a.displayNameOverride || a.remark || a.name || '',180);
    const mapped=text(mappings[a.id],180) || defaultName;
    return { localAccountId:text(a.id,128), displayName:defaultName, logicalKey:lineLogicalKey(mapped), mappedName:mapped };
  }).filter(x=>x.logicalKey);
}
function taskMatchesLineEndpoints(task={}, endpoints=[]) {
  const target=[task.targetLineLogicalKey, task.targetLineAccountName];
  return (Array.isArray(endpoints)?endpoints:[]).some(ep=>lineIdentityMatches(target,[ep?.logicalKey,ep?.mappedName,ep?.displayName,ep?.localAccountId]));
}
function mergeCustomerIntoLineContact(existing={}, remote={}) {
  const r=remote?.customer || remote || {};
  const merged={...existing};
  for (const field of ['name','region','age','occupation','interests','language']) {
    if (!text(merged[field],1000) && text(r[field],1000)) merged[field]=text(r[field], field==='interests'?500:180);
  }
  const tagParts=uniqStrings(`${text(existing.tags,400)}，${text(r.tags,400)}，跨平台承接`.split(/[,，、;；/\n]+/));
  merged.tags=tagParts.join('，').slice(0,400);
  if (!text(merged.note,4000) && text(r.note,4000)) merged.note=text(r.note,4000);
  const localMem=Array.isArray(existing.memoryItems)?existing.memoryItems:[];
  const remoteMem=sanitizeMemoryItems(r.memoryItems);
  const mem=[]; const seen=new Set();
  for (const row of [...localMem,...remoteMem]) { const k=`${text(row?.type,40)}|${text(row?.text,260)}`.toLocaleLowerCase(); if (!row?.text||seen.has(k)) continue; seen.add(k); mem.push(row); }
  merged.memoryItems=mem.slice(-80);
  merged.memorySummary=text(existing.memorySummary,1600) || text(r.memorySummary,1600);
  const relationshipCandidates=[
    {value:existing.relationshipStartedAt || existing.firstContactAt || existing.createdAt, source:text(existing.relationshipStartedAtSource,80) || 'line-local'},
    {value:r.relationshipStartedAt || r.firstContactAt || r.createdAt, source:text(r.relationshipStartedAtSource,80) || 'cross-platform-source'}
  ].map(row=>({ ...row, ms:Date.parse(text(row.value,80))||0 })).filter(row=>row.ms>0).sort((a,b)=>a.ms-b.ms);
  if(relationshipCandidates.length){
    merged.relationshipStartedAt=new Date(relationshipCandidates[0].ms).toISOString();
    merged.relationshipStartedAtSource=relationshipCandidates[0].source;
  }
  const priorCross=existing.crossPlatform && typeof existing.crossPlatform==='object' ? existing.crossPlatform : {};
  const nextGlobalId=text(r.globalCustomerId || remote.globalCustomerId,120);
  const nextTaskId=text(remote.taskId || priorCross.handoffTaskId,120);
  const sameBinding=!!nextGlobalId && text(priorCross.globalCustomerId,120)===nextGlobalId && (!nextTaskId || text(priorCross.handoffTaskId,120)===nextTaskId);
  merged.crossPlatform = {
    globalCustomerId:nextGlobalId,
    sourcePlatform:text(r.sourcePlatform || remote.sourcePlatform || priorCross.sourcePlatform,30),
    sourceAccountName:text(r.sourceAccountName || remote.sourceAccountName || priorCross.sourceAccountName,180),
    sourceDisplayName:text(r.sourceDisplayName || remote.sourceDisplayName || priorCross.sourceDisplayName,180),
    sourceHandle:text(r.sourceHandle || remote.sourceHandle || priorCross.sourceHandle,180),
    handoffTaskId:nextTaskId,
    recentMessages:sanitizeRecentMessages(r.sourceRecentMessages || remote.sourceRecentMessages || priorCross.recentMessages || []),
    relationshipStartedAt:text(merged.relationshipStartedAt || r.relationshipStartedAt || priorCross.relationshipStartedAt,80),
    relationshipStartedAtSource:text(merged.relationshipStartedAtSource || r.relationshipStartedAtSource || priorCross.relationshipStartedAtSource,80),
    linkedAt:sameBinding ? text(priorCross.linkedAt,80) || new Date().toISOString() : new Date().toISOString()
  };
  return merged;
}
module.exports={text,slug,hashId,randomId,normalizeTeamSettings,lineLogicalKey,lineIdentityAliases,lineIdentityMatches,sanitizeRecentMessages,sanitizeCrmContact,buildHandoffTask,publicLineEndpoints,taskMatchesLineEndpoints,mergeCustomerIntoLineContact};
