'use strict';
const crypto = require('node:crypto');

const DEFAULT_SERVER_URL = 'https://team.dalongvpn.cc.cd';
const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;
const PROFILE_INCOMPLETE_TTL_MS = 6 * 60 * 60 * 1000;

function text(value='', max=20000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}
function number(value=0) { const n=Number(value||0); return Number.isFinite(n) ? n : 0; }
function suffix(value='', n=7) { const s=text(value,300); return s ? s.slice(-Math.max(3,n)) : ''; }

function safeMediaUrl(value='') {
  const url=text(value,4000);
  if(/^https?:\/\//i.test(url)||/^data:image\//i.test(url)||/^blob:/i.test(url))return url;
  return '';
}
function mediaRows(value) {
  if(Array.isArray(value))return value.filter(Boolean);
  if(Array.isArray(value?.data))return value.data.filter(Boolean);
  return [];
}
function metaMessageMedia(row={}) {
  const payload=row?.payload&&typeof row.payload==='object'?row.payload:{};
  const message=payload?.historySync?payload?.conversationMessage:(payload?.message?payload.message:payload);
  const attachments=mediaRows(message?.attachments || payload?.attachments);
  const out=[];
  for(const attachment of attachments.slice(0,12)){
    const payloadRow=attachment?.payload&&typeof attachment.payload==='object'?attachment.payload:{};
    const mime=text(attachment?.mime_type||attachment?.mimetype||payloadRow?.mime_type,240).toLowerCase();
    const rawType=text(attachment?.type||payloadRow?.type,80).toLowerCase();
    let type=rawType;
    if(!type){if(mime.startsWith('image/'))type='image';else if(mime.startsWith('video/'))type='video';else if(mime.startsWith('audio/'))type='audio';else type='file';}
    if(type.includes('image'))type='image'; else if(type.includes('video'))type='video'; else if(type.includes('audio'))type='audio'; else if(type.includes('file'))type='file';
    const url=safeMediaUrl(
      payloadRow?.url || attachment?.url || attachment?.file_url || attachment?.image_url ||
      attachment?.image_data?.url || attachment?.video_data?.url || attachment?.audio_data?.url ||
      attachment?.target?.url || payloadRow?.target?.url
    );
    const previewUrl=type==='image'?url:safeMediaUrl(attachment?.image_data?.url || payloadRow?.preview_url || attachment?.preview_url);
    const name=text(attachment?.name||attachment?.filename||payloadRow?.name,300);
    if(url||previewUrl||name||type)out.push({type:type||'file',url,previewUrl,name,mime});
  }
  const sticker=safeMediaUrl(message?.sticker||payload?.sticker);
  if(sticker&&!out.some(item=>item.url===sticker))out.push({type:'image',url:sticker,previewUrl:sticker,name:'',mime:'image'});
  return out.slice(0,12);
}
function lineMessageMedia(row={}) {
  const payload=row?.payload&&typeof row.payload==='object'?row.payload:{};
  const media=payload?.media&&typeof payload.media==='object'?payload.media:(payload?.outgoingMedia&&typeof payload.outgoingMedia==='object'?payload.outgoingMedia:null);
  if(!media)return [];
  const type=text(media.type,80).toLowerCase()||'file';
  const url=safeMediaUrl(media.url||media.originalContentUrl);
  const previewUrl=safeMediaUrl(media.previewUrl||media.previewImageUrl||url);
  const name=text(media.name,300);const mime=text(media.mime,240).toLowerCase();
  return (url||previewUrl)?[{type,url,previewUrl,name,mime}]:[];
}

function publicTarget(item={}) {
  const pageName=text(item.pageName,120) || text(item.accountName,120);
  return {
    surface:'native-api',
    platform:text(item.platform,30).toLowerCase(),
    platformName:text(item.platformName,80),
    source:text(item.source,40),
    accountId:text(item.accountId,160),
    accountName:text(item.accountName,120) || pageName,
    pageName,
    chatId:text(item.chatId,360),
    displayName:text(item.displayName,180),
    handle:'',
    avatarUrl:text(item.avatarUrl,2400),
    remoteId:text(item.remoteId,240),
    pageId:text(item.pageId,240),
    conversationId:text(item.conversationId,500),
    historyOnly:!!item.historyOnly,
    stableKey:text(item.stableKey,500),
    preview:text(item.preview,1200),
    lastTimestampMs:number(item.lastTimestampMs),
    lastIncomingAt:number(item.lastIncomingAt),
    firstIncomingAt:number(item.firstIncomingAt),
    lastReplyAt:number(item.lastReplyAt),
    lastDirection:text(item.lastDirection,30),
    lastEventKey:text(item.lastEventKey,500),
    messageCount:number(item.messageCount),
    awaitingReply:!!item.awaitingReply
  };
}

function createNativeApiInbox({ fetchImpl=global.fetch, logger=()=>{}, avatarMirrorResolver=null }={}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch-unavailable');
  const profileCache = new Map();
  // V1.27.219: collapse duplicate GETs and keep a tiny read-through cache for
  // high-frequency conversation reads. This reduces VPS SQLite pressure without
  // changing authoritative send/identity checks or adding any extra request.
  const requestInFlight = new Map();
  const responseCache = new Map();
  const perf = { requestCalls:0, networkCalls:0, coalesced:0, cacheHits:0, cacheMisses:0, invalidations:0 };
  function requestCacheTtl(pathname='') {
    const p=String(pathname||'');
    if (/\/api\/(?:meta|line)\/conversations\?/i.test(p)) return 2600;
    if (/\/api\/(?:meta|line)\/conversation\?/i.test(p)) return 900;
    if (/\/api\/(?:meta|line)\/profile\?/i.test(p)) return 1500;
    return 0;
  }
  function invalidateReadCache(platform='') {
    const needle=String(platform||'').toLowerCase();
    for (const key of responseCache.keys()) { if(!needle || key.includes(`/api/${needle==='facebook'?'meta':needle}/`)) responseCache.delete(key); }
    perf.invalidations+=1;
  }
  function performanceStats(){ return {...perf,inFlight:requestInFlight.size,cacheEntries:responseCache.size}; }

  async function applyAvatarMirrors(items=[]) {
    const rows=(Array.isArray(items)?items:[]).map(item=>publicTarget(item));
    if(typeof avatarMirrorResolver!=='function'||!rows.length)return rows;
    try {
      const resolved=await avatarMirrorResolver(rows.map(item=>({...item})));
      return (Array.isArray(resolved)?resolved:rows).map(publicTarget);
    } catch (error) {
      logger('native-api-avatar-mirror-error',{error:String(error?.message||error)});
      return rows;
    }
  }
  function profileLookupNeeded(item={}) {
    const platform=text(item.platform,30).toLowerCase();
    // V1.27.234: Facebook profile/avatar enrichment is intentionally disabled.
    // Meta conversation rows + SQLite are sufficient for customer identity, and
    // cosmetic profile lookups must never spend Graph capacity needed by messages.
    if(platform==='facebook')return false;
    return true;
  }

  function connection(settings={}) {
    const base = text(settings.cloudflarePublicUrl || settings.serverUrl || DEFAULT_SERVER_URL, 600).replace(/\/+$/, '');
    const sessionToken = text(settings.sessionToken || settings.officialApiSessionToken, 2000);
    const teamId = text(settings.teamId, 160);
    const apiKey = text(settings.apiKey, 500);
    if (!base) throw new Error('团队服务器地址为空。');
    if (!sessionToken && (!teamId || !apiKey)) throw new Error('请先登录 VPS 账号，或配置团队服务器 Team ID / API Key。');
    return { base, sessionToken, teamId, apiKey };
  }

  async function request(settings, pathname, { method='GET', body=null, timeoutMs=8000, cache=true }={}) {
    const {base,sessionToken,teamId,apiKey}=connection(settings);
    const upper=String(method||'GET').toUpperCase();
    const authKey=sessionToken?`bearer:${crypto.createHash('sha256').update(sessionToken).digest('hex').slice(0,16)}`:`team:${teamId}`;
    const cacheKey=`${upper}|${base}|${authKey}|${pathname}`;
    const ttl=upper==='GET'&&cache!==false?requestCacheTtl(pathname):0;
    perf.requestCalls+=1;
    if(ttl>0){
      const cached=responseCache.get(cacheKey);
      if(cached && Date.now()-number(cached.at)<ttl){ perf.cacheHits+=1; return cached.value; }
      perf.cacheMisses+=1;
    }
    if(upper==='GET' && requestInFlight.has(cacheKey)){ perf.coalesced+=1; return requestInFlight.get(cacheKey); }
    const run=(async()=>{
      perf.networkCalls+=1;
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),Math.max(1000,number(timeoutMs)||8000));
      try {
        const response=await fetchImpl(`${base}${pathname}`,{
          method:upper,
          headers:{
            'accept':'application/json',
            ...(sessionToken?{authorization:`Bearer ${sessionToken}`}:{'x-yoko-team-id':teamId,'x-yoko-api-key':apiKey}),
            ...(body?{'content-type':'application/json'}:{})
          },
          ...(body?{body:JSON.stringify(body)}:{}),
          signal:controller.signal
        });
        const raw=await response.text();
        let data={}; try { data=raw?JSON.parse(raw):{}; } catch { data={raw:text(raw,4000)}; }
        if (!response.ok || data?.ok === false) {
          const error=new Error(text(data?.error || data?.message || `HTTP ${response.status}`,500) || `HTTP ${response.status}`);
          error.status=response.status; error.details=data; throw error;
        }
        if(ttl>0){
          responseCache.set(cacheKey,{at:Date.now(),value:data});
          if(responseCache.size>256){const oldest=responseCache.keys().next().value;if(oldest)responseCache.delete(oldest);}
        }
        return data;
      } catch (error) {
        if (error?.name === 'AbortError') throw new Error('官方 API 收件箱请求超时。');
        throw error;
      } finally { clearTimeout(timer); }
    })();
    if(upper==='GET')requestInFlight.set(cacheKey,run);
    try { return await run; }
    finally { if(upper==='GET' && requestInFlight.get(cacheKey)===run)requestInFlight.delete(cacheKey); }
  }

  function profileKey(platform, remoteId, pageId='') { return `${text(platform,40)}:${text(pageId,240)}:${text(remoteId,240)}`; }
  function profileAvatar(platform, value={}) {
    const p=value&&typeof value==='object'?value:{};
    return text(platform,40).toLowerCase()==='facebook'
      ? text(p.profile_pic || p?.picture?.data?.url || p.pictureUrl,2400)
      : text(p.pictureUrl || p?.picture?.data?.url,2400);
  }
  function cachedProfile(platform, remoteId, pageId='') {
    const row=profileCache.get(profileKey(platform,remoteId,pageId));
    if(!row)return null;
    const ttl=profileAvatar(platform,row.value)?PROFILE_TTL_MS:PROFILE_INCOMPLETE_TTL_MS;
    return Date.now()-number(row.at) < ttl ? row.value : null;
  }
  function storeProfile(platform, remoteId, pageId, value) {
    const cleanValue = value && typeof value === 'object' ? value : {};
    profileCache.set(profileKey(platform,remoteId,pageId), {at:Date.now(),value:cleanValue});
    return cleanValue;
  }

  async function getProfile(settings, target={}) {
    const platform=text(target.platform,30).toLowerCase();
    const remoteId=text(target.remoteId || (platform==='facebook' ? String(target.chatId||'').replace(/^fb-api:/,'') : String(target.chatId||'').replace(/^line-api:/,'')),240);
    const pageId=platform==='facebook'?text(target.pageId || String(target.accountId||'').replace(/^fb-api:/,''),240):'';
    if (!remoteId) return {};
    const cached=cachedProfile(platform,remoteId,pageId); if (cached) return cached;
    if (platform==='facebook') {
      return storeProfile(platform,remoteId,pageId,{
        id:remoteId,
        name:text(target.displayName,180),
        profile_pic:text(target.avatarUrl,2400),
        profileSource:'conversation-cache',
        profileGraphDisabled:true
      });
    }
    try {
      const path = platform==='facebook'
        ? `/api/meta/profile?userId=${encodeURIComponent(remoteId)}${pageId?`&pageId=${encodeURIComponent(pageId)}`:''}`
        : `/api/line/profile?userId=${encodeURIComponent(remoteId)}`;
      const result=await request(settings,path,{timeoutMs:9000});
      return storeProfile(platform,remoteId,pageId,result?.result||{});
    } catch (error) {
      logger('native-api-profile-error',{platform,remoteId,error:String(error?.message||error)});
      return {};
    }
  }

  function mapMetaConversation(row={}) {
    const pageId=text(row.pageId,240), remoteId=text(row.peerId,240);
    const pageName=text(row.pageName,120) || 'Facebook Messenger API';
    const lastIncomingAt=number(row.lastIncomingAt), lastReplyAt=number(row.lastReplyAt);
    return publicTarget({
      surface:'native-api', platform:'facebook', platformName:'Facebook', source:'meta-api',
      accountId:`fb-api:${pageId}`, accountName:pageName, pageName, chatId:`fb-api:${remoteId}`,
      remoteId,pageId,conversationId:text(row.conversationId,500),historyOnly:!!row.historyOnly,stableKey:`facebook|${pageId}|${remoteId}`,
      displayName:text(row.displayName,180) || `FB客户 · ${suffix(remoteId)}`, avatarUrl:text(row.avatarUrl,2400), preview:row.preview,
      lastTimestampMs:row.lastTimestampMs,lastIncomingAt,firstIncomingAt:row.firstIncomingAt,lastReplyAt,lastDirection:row.lastDirection,
      lastEventKey:row.lastEventKey,messageCount:row.messageCount,awaitingReply:lastIncomingAt>lastReplyAt
    });
  }
  function mapLineConversation(row={}) {
    const remoteId=text(row.userId,240); const lastIncomingAt=number(row.lastIncomingAt), lastReplyAt=number(row.lastReplyAt);
    return publicTarget({
      surface:'native-api', platform:'line', platformName:'LINE', source:'line-api',
      accountId:'line-api:official', accountName:'LINE Official Account API', chatId:`line-api:${remoteId}`,
      remoteId,pageId:'',stableKey:`line|${remoteId}`,
      displayName:`LINE客户 · ${suffix(remoteId)}`,avatarUrl:'',preview:row.preview,
      lastTimestampMs:row.lastTimestampMs,lastIncomingAt,firstIncomingAt:row.firstIncomingAt,lastReplyAt,lastDirection:row.lastDirection,
      lastEventKey:row.lastEventKey,messageCount:row.messageCount,awaitingReply:lastIncomingAt>lastReplyAt
    });
  }
  function applyProfile(item, profile={}) {
    if (item.platform==='facebook') {
      const name=text(profile.name || [profile.first_name,profile.last_name].filter(Boolean).join(' '),180);
      if (name) item.displayName=name;
      const avatar=profileAvatar('facebook',profile);
      if (avatar) item.avatarUrl=avatar;
    } else if (item.platform==='line') {
      if (profile.displayName) item.displayName=text(profile.displayName,180);
      const avatar=profileAvatar('line',profile);
      if (avatar) item.avatarUrl=avatar;
    }
    return item;
  }

  async function hydrateProfiles(settings, items=[], max=24) {
    // V1.27.234: Facebook is skipped entirely by profileLookupNeeded(). LINE
    // profile hydration keeps the existing bounded behavior for customer names.
    const targets=items.slice(0,Math.max(0,Math.min(12,number(max)||12)));
    let cursor=0;
    const worker=async()=>{
      while(cursor<targets.length){
        const item=targets[cursor++];
        if(!profileLookupNeeded(item)) continue;
        const profile=await getProfile(settings,item);
        applyProfile(item,profile);
      }
    };
    await Promise.all(Array.from({length:Math.min(2,targets.length)},worker));
    return items;
  }

  async function hydrateTargets(settings, targets=[], { max=80 }={}) {
    let items=(Array.isArray(targets)?targets:[]).slice(0,Math.max(1,Math.min(120,number(max)||80))).map(publicTarget);
    if(!items.length)return {ok:true,items:[]};
    items=await applyAvatarMirrors(items);
    await hydrateProfiles(settings,items,items.length);
    items=await applyAvatarMirrors(items);
    return {ok:true,items:items.map(publicTarget)};
  }

  async function listConversations(settings,{limit=240,hydrate=true}={}) {
    const safeLimit=Math.max(1,Math.min(500,number(limit)||240));
    const [meta,line]=await Promise.allSettled([
      request(settings,`/api/meta/conversations?limit=${safeLimit}`),
      request(settings,`/api/line/conversations?limit=${safeLimit}`)
    ]);
    const errors=[]; const items=[];
    if (meta.status==='fulfilled') items.push(...(Array.isArray(meta.value?.items)?meta.value.items:[]).map(mapMetaConversation));
    else errors.push({platform:'facebook',error:text(meta.reason?.message||meta.reason,500)});
    if (line.status==='fulfilled') items.push(...(Array.isArray(line.value?.items)?line.value.items:[]).map(mapLineConversation));
    else errors.push({platform:'line',error:text(line.reason?.message||line.reason,500)});
    items.sort((a,b)=>number(b.lastTimestampMs)-number(a.lastTimestampMs));
    let resolvedItems=await applyAvatarMirrors(items);
    if (hydrate && resolvedItems.length) await hydrateProfiles(settings,resolvedItems,24);
    resolvedItems=await applyAvatarMirrors(resolvedItems);
    return {ok:resolvedItems.length>0 || errors.length<2,items:resolvedItems.map(publicTarget),count:resolvedItems.length,errors};
  }

  function resolveRemote(target={}) {
    const platform=text(target.platform,30).toLowerCase();
    const chat=text(target.chatId,360);
    const remoteId=text(target.remoteId || (platform==='facebook'?chat.replace(/^fb-api:/,''):chat.replace(/^line-api:/,'')),240);
    const pageId=text(target.pageId || (platform==='facebook'?String(target.accountId||'').replace(/^fb-api:/,''):''),240);
    return {platform,remoteId,pageId};
  }

  async function getConversation(settings,target,{limit=100,cursor=null}={}) {
    const {platform,remoteId,pageId}=resolveRemote(target);
    if (!remoteId) throw new Error('客户 API 身份为空。');
    const safeLimit=Math.max(1,Math.min(500,number(limit)||100));
    const c=cursor&&typeof cursor==='object'?cursor:{};
    const beforeTimestampMs=Math.max(0,number(c.beforeTimestampMs));
    const beforeReceivedAt=text(c.beforeReceivedAt,120);
    const beforeEventKey=text(c.beforeEventKey,500);
    const cursorQuery=beforeTimestampMs&&beforeReceivedAt&&beforeEventKey
      ? `&beforeTimestampMs=${encodeURIComponent(beforeTimestampMs)}&beforeReceivedAt=${encodeURIComponent(beforeReceivedAt)}&beforeEventKey=${encodeURIComponent(beforeEventKey)}`:'';
    const path=platform==='facebook'
      ? `/api/meta/conversation?pageId=${encodeURIComponent(pageId)}&peerId=${encodeURIComponent(remoteId)}&limit=${safeLimit}${cursorQuery}`
      : `/api/line/conversation?userId=${encodeURIComponent(remoteId)}&limit=${safeLimit}${cursorQuery}`;
    const data=await request(settings,path,{timeoutMs:9000,cache:!beforeTimestampMs});
    const items=(Array.isArray(data?.items)?data.items:[]).map(row=>{
      const media=platform==='facebook'?metaMessageMedia(row):lineMessageMedia(row);
      return {
        id:text(row.messageId || row.eventKey,500),
        eventKey:text(row.eventKey,500), messageId:text(row.messageId,500),
        direction:text(row.direction,30)==='outgoing'?'outgoing':'incoming',
        role:text(row.direction,30)==='outgoing'?'me':'customer',
        text:text(row.text,20000), media, timestampMs:number(row.timestampMs), receivedAt:text(row.receivedAt,100),
        deliveryStatus:platform==='facebook'?text(row.deliveryStatus,20):'', readAtMs:number(row.readAtMs),
        platform, remoteId, pageId
      };
    }).filter(row=>row.text||row.media.length);
    return {ok:true,target:publicTarget(target),items,count:items.length,rawCount:number(data?.count)||items.length,hasMore:data?.hasMore===true,nextCursor:data?.nextCursor&&typeof data.nextCursor==='object'?data.nextCursor:null};
  }

  async function getFirstIncomingAt(settings,target,{limit=500,maxPages=24}={}) {
    const declared=number(target?.firstIncomingAt);
    if(declared>0)return {ok:true,firstIncomingAt:declared,exact:true,source:'conversation-summary',messageCount:number(target?.messageCount),pages:0,scannedCount:0};
    const safeLimit=Math.max(50,Math.min(500,number(limit)||500));
    const safePages=Math.max(1,Math.min(40,number(maxPages)||24));
    let cursor=null,observedFirstIncomingAt=0,scannedCount=0,pages=0,exact=false,lastCursor='';
    while(pages<safePages){
      const conversation=await getConversation(settings,target,{limit:safeLimit,cursor});pages+=1;
      const rows=Array.isArray(conversation?.items)?conversation.items:[];
      scannedCount+=Number(conversation?.rawCount||conversation?.count||rows.length)||0;
      for(const row of rows){
        const role=String(row?.direction||row?.role||'');if(role!=='incoming'&&role!=='customer')continue;
        const at=number(row?.timestampMs);if(at>0&&(!observedFirstIncomingAt||at<observedFirstIncomingAt))observedFirstIncomingAt=at;
      }
      if(conversation?.hasMore!==true||!conversation?.nextCursor){exact=true;break;}
      const next=conversation.nextCursor;const sig=JSON.stringify(next||{});if(!sig||sig===lastCursor)break;lastCursor=sig;cursor=next;
    }
    return {
      ok:true,
      firstIncomingAt:exact?observedFirstIncomingAt:0,
      observedFirstIncomingAt,
      exact,
      source:exact?'conversation-history-complete':'conversation-history-page-cap',
      scannedCount,pages,messageCount:number(target?.messageCount)
    };
  }

  async function canonicalTarget(settings,target={}) {
    const {platform,remoteId,pageId}=resolveRemote(target);
    if(!remoteId) throw new Error('客户 API 身份为空。');
    if(platform==='facebook') {
      const data=await request(settings,'/api/meta/conversations?limit=500',{timeoutMs:9000,cache:false});
      const row=(Array.isArray(data?.items)?data.items:[]).find(item=>text(item.peerId,240)===remoteId&&(!pageId||text(item.pageId,240)===pageId));
      if(!row) throw new Error('Facebook 客户身份已经变化，请刷新官方 API 收件箱后重新选择客户。');
      const mirrored=await applyAvatarMirrors([mapMetaConversation(row)]);
      return mirrored[0]||mapMetaConversation(row);
    }
    if(platform==='line') {
      const data=await request(settings,'/api/line/conversations?limit=500',{timeoutMs:9000,cache:false});
      const row=(Array.isArray(data?.items)?data.items:[]).find(item=>text(item.userId,240)===remoteId);
      if(!row) throw new Error('LINE 客户身份已经变化，请刷新官方 API 收件箱后重新选择客户。');
      return mapLineConversation(row);
    }
    throw new Error('不支持的官方 API 平台。');
  }

  async function syncMetaHistory(settings,{conversationLimit=1000,messageLimit=60}={}) {
    const safeConversationLimit=Math.max(1,Math.min(2000,number(conversationLimit)||1000));
    const safeMessageLimit=Math.max(0,Math.min(100,number(messageLimit)||60));
    const result=await request(settings,'/api/meta/history-sync',{
      method:'POST',
      body:{conversationLimit:safeConversationLimit,messageLimit:safeMessageLimit},
      timeoutMs:120000
    });
    invalidateReadCache('facebook');
    return result;
  }

  async function send(settings,target,messageText) {
    const message=text(messageText,12000); if(!message) throw new Error('发送内容为空。');
    const {platform,remoteId,pageId}=resolveRemote(target); if(!remoteId) throw new Error('客户 API 身份为空。');
    const path=platform==='facebook'?'/api/meta/send/facebook':'/api/line/send';
    const body=platform==='facebook'?{recipientId:remoteId,pageId,text:message}:{recipientId:remoteId,text:message};
    const result=await request(settings,path,{method:'POST',body,timeoutMs:12000});
    invalidateReadCache(platform);
    return {ok:true,method:'official-api',platform,result};
  }

  async function sendMedia(settings,target,media={}) {
    const {platform,remoteId,pageId}=resolveRemote(target); if(!remoteId) throw new Error('客户 API 身份为空。');
    const mime=text(media?.mime,120).toLowerCase();const name=text(media?.name,180)||'attachment';
    const permitted=new Set(['image/jpeg','image/png','application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
    if(!permitted.has(mime))throw new Error('文件格式不受支持。');
    if(platform!=='facebook'&&!mime.startsWith('image/'))throw new Error('LINE 暂不支持文档附件。');
    const dataBase64=String(media?.dataBase64||'');const previewBase64=text(media?.previewBase64,2*1024*1024);
    const previewMime=text(media?.previewMime,120).toLowerCase()||'image/jpeg';
    if(!dataBase64||dataBase64.length>11*1024*1024)throw new Error('附件为空或超过限制。');
    const {base}=connection(settings);const publicBaseUrl=/^https:\/\//i.test(base)?base:'';
    const path=platform==='facebook'?'/api/meta/send-media/facebook':'/api/line/send-media';
    const body={recipientId:remoteId,pageId,name,mime,dataBase64,previewBase64,previewMime,publicBaseUrl};
    const result=await request(settings,path,{method:'POST',body,timeoutMs:45000});
    invalidateReadCache(platform);
    return {ok:true,method:'official-api-media',platform,result};
  }

  async function getWorkspaceSettings(settings,key='chatgpt-rules') {
    return request(settings,'/api/workspace/settings/get',{method:'POST',body:{key:text(key,120)},timeoutMs:7000,cache:false});
  }
  async function putWorkspaceSettings(settings,key='chatgpt-rules',value={},version=0) {
    return request(settings,'/api/workspace/settings/put',{method:'POST',body:{key:text(key,120),value:value&&typeof value==='object'?value:{},version:number(version),writerDeviceId:text(settings?.deviceId,160)},timeoutMs:9000,cache:false});
  }
  async function getCustomerProfile(settings,key='') {
    return request(settings,'/api/customer/profile/get',{method:'POST',body:{key:text(key,160)},timeoutMs:7000,cache:false});
  }
  async function putCustomerProfile(settings,key='',profile={},version=0) {
    return request(settings,'/api/customer/profile/put',{method:'POST',body:{key:text(key,160),profile:profile&&typeof profile==='object'?profile:{},version:number(version),writerDeviceId:text(settings?.deviceId,160)},timeoutMs:9000,cache:false});
  }

  async function health(settings) {
    const [meta,line,metaRecent,lineRecent]=await Promise.allSettled([
      request(settings,'/api/meta/health'),
      request(settings,'/api/line/health'),
      request(settings,'/api/meta/events/recent?limit=1'),
      request(settings,'/api/line/events/recent?limit=1')
    ]);
    const clean=r=>r.status==='fulfilled'?{ok:true,...r.value}:{ok:false,error:text(r.reason?.message||r.reason,500)};
    const recent=r=>{
      if(r.status!=='fulfilled')return {recentEventsOk:false,lastEventAt:'',lastEventType:'',lastDirection:'',recentError:text(r.reason?.message||r.reason,500)};
      const row=Array.isArray(r.value?.items)?r.value.items[0]:null;
      return {
        recentEventsOk:true,
        lastEventAt:text(row?.receivedAt || (number(row?.timestampMs)?new Date(number(row.timestampMs)).toISOString():''),120),
        lastEventType:text(row?.eventType,80),
        lastDirection:text(row?.direction,40),
        recentError:''
      };
    };
    return {
      ok:meta.status==='fulfilled'||line.status==='fulfilled',
      facebook:{...clean(meta),...recent(metaRecent)},
      line:{...clean(line),...recent(lineRecent)}
    };
  }

  return { health,listConversations,hydrateTargets,getConversation,getFirstIncomingAt,getProfile,canonicalTarget,syncMetaHistory,send,sendMedia,getWorkspaceSettings,putWorkspaceSettings,getCustomerProfile,putCustomerProfile,publicTarget,applyProfile,applyAvatarMirrors,performanceStats };
}

module.exports={createNativeApiInbox,DEFAULT_SERVER_URL,publicTarget};
