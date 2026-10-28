'use strict';
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');

function clean(value,max=10000){return String(value??'').replace(/\u0000/g,'').trim().slice(0,max);}
function safeJson(raw=''){try{return JSON.parse(String(raw||''));}catch{return null;}}
function json(res,status,payload){
  const raw=JSON.stringify(payload);
  res.writeHead(status,{
    'content-type':'application/json; charset=utf-8',
    'content-length':Buffer.byteLength(raw),
    'cache-control':'no-store'
  });
  res.end(raw);
}
function text(res,status,raw=''){
  raw=String(raw??'');
  res.writeHead(status,{
    'content-type':'text/plain; charset=utf-8',
    'content-length':Buffer.byteLength(raw),
    'cache-control':'no-store'
  });
  res.end(raw);
}
function timingSafeStringEqual(a='',b=''){
  const aa=Buffer.from(String(a));const bb=Buffer.from(String(b));
  return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb);
}
function verifyMetaSignature(rawBody,signature,appSecret){
  const sig=clean(signature,300);
  const secret=clean(appSecret,1000);
  if(!sig||!secret||!sig.startsWith('sha256='))return false;
  const expected='sha256='+crypto.createHmac('sha256',secret).update(rawBody).digest('hex');
  return timingSafeStringEqual(expected,sig);
}
function eventType(row={}){
  if(row.message)return 'message';
  if(row.postback)return 'postback';
  if(row.delivery)return 'delivery';
  if(row.read)return 'read';
  if(row.referral)return 'referral';
  if(row.optin)return 'optin';
  return 'other';
}
function attachmentRows(value){
  if(Array.isArray(value))return value.filter(Boolean);
  if(Array.isArray(value?.data))return value.data.filter(Boolean);
  return [];
}
function attachmentDisplayText(value){
  const rows=attachmentRows(value);
  if(!rows.length)return '';
  let image=false,video=false,audio=false,file=false;
  for(const row of rows){
    const type=clean(row?.type,120).toLowerCase();
    const mime=clean(row?.mime_type||row?.mimetype,240).toLowerCase();
    if(type.includes('image')||mime.startsWith('image/')||row?.image_data||row?.image_url){image=true;continue;}
    if(type.includes('video')||mime.startsWith('video/')||row?.video_data){video=true;continue;}
    if(type.includes('audio')||mime.startsWith('audio/')||row?.audio_data){audio=true;continue;}
    if(type.includes('file')||row?.file_url||row?.name||mime){file=true;}
  }
  if(image)return '［图片］';
  if(video)return '［视频］';
  if(audio)return '［音频］';
  if(file)return '［文件］';
  return '［附件］';
}
function messageDisplayText(message={}){
  return clean(message?.text??message?.message,20000)||attachmentDisplayText(message?.attachments);
}
// Meta webhook timestamps and receipt watermarks are normally milliseconds,
// but recovered/history events may be represented in Unix seconds.
function metaEpochMs(value){
  const n=Number(value);
  if(!Number.isFinite(n)||n<=0)return 0;
  return n<100000000000?Math.round(n*1000):Math.round(n);
}
function normalizeEvent(objectType,entry,row){
  const entryId=clean(entry?.id,180);
  const senderId=clean(row?.sender?.id,180);
  const recipientId=clean(row?.recipient?.id,180);
  const messageId=clean(row?.message?.mid,300);
  const type=eventType(row);
  const timestampMs=metaEpochMs(row?.timestamp)||metaEpochMs(entry?.time)||Date.now();
  const direction=senderId&&entryId&&senderId===entryId?'outgoing':'incoming';
  const messageText=messageDisplayText(row?.message||{});
  const postbackTitle=clean(row?.postback?.title,1000);
  const postbackPayload=clean(row?.postback?.payload,4000);
  const displayText=messageText||postbackTitle||postbackPayload;
  const payloadJson=JSON.stringify(row||{});
  const naturalKey=messageId
    ? `message:${messageId}`
    : `${type}:${entryId}:${senderId}:${recipientId}:${timestampMs}:${crypto.createHash('sha256').update(payloadJson).digest('hex').slice(0,24)}`;
  return {
    eventKey:naturalKey,
    objectType:clean(objectType,80),
    entryId,
    pageId:entryId,
    senderId,
    recipientId,
    direction,
    eventType:type,
    messageId,
    text:displayText,
    timestampMs,
    payloadJson
  };
}

function createMetaMessengerGateway({
  enabled=true,
  verifyToken='',
  appSecret='',
  pageAccessToken='',
  pageAccessTokens=[],
  pageRegistryFile='',
  graphVersion='v26.0',
  databaseFile='',
  autoReconcileIntervalMs=60000,
  autoReconcileStartupDelayMs=8000,
  autoSubscribeEchoes=true,
  activeRecoveryProbeIntervalMs=30000,
  activeRecoveryDesktopTtlMs=12000,
  resolveFacebookInbox=()=> 'default',
  validFacebookInbox=id=>id==='all'||id==='default',
  logger=()=>{}
}={}){
  const cfg={
    enabled:enabled!==false,
    verifyToken:clean(verifyToken,500),
    appSecret:clean(appSecret,1000),
    pageAccessToken:clean(pageAccessToken,4000),
    pageAccessTokens:Array.isArray(pageAccessTokens)?pageAccessTokens:[],
    graphVersion:/^v\d+\.\d+$/.test(clean(graphVersion,20))?clean(graphVersion,20):'v26.0',
    autoReconcileIntervalMs:Math.max(0,Math.min(15*60*1000,Number(autoReconcileIntervalMs)||0)),
    autoReconcileStartupDelayMs:Math.max(1000,Math.min(5*60*1000,Number(autoReconcileStartupDelayMs)||8000)),
    autoSubscribeEchoes:autoSubscribeEchoes!==false,
    activeRecoveryProbeIntervalMs:Math.max(250,Math.min(5*60*1000,Number(activeRecoveryProbeIntervalMs)||30000)),
    activeRecoveryDesktopTtlMs:Math.max(1000,Math.min(2*60*1000,Number(activeRecoveryDesktopTtlMs)||12000))
  };
  const dbFile=databaseFile?path.resolve(databaseFile):'';
  const registryFile=pageRegistryFile?path.resolve(pageRegistryFile):(dbFile?path.join(path.dirname(dbFile),'meta-page-pool.json'):'');
  const pagePool=new Map();
  const normalizePageEntry=(row={})=>({
    pageId:clean(row?.pageId||row?.id,180),
    name:clean(row?.name||row?.pageName,300),
    token:clean(row?.pageAccessToken||row?.token,8000),
    enabled:row?.enabled!==false,
    updatedAt:clean(row?.updatedAt,80)||new Date().toISOString()
  });
  const loadPageRegistry=()=>{
    if(!registryFile)return;
    try{
      const parsed=JSON.parse(fs.readFileSync(registryFile,'utf8'));
      for(const raw of Array.isArray(parsed?.pages)?parsed.pages:[]){const row=normalizePageEntry(raw);if(row.pageId&&row.token)pagePool.set(row.pageId,row);}
    }catch{}
  };
  const seedConfiguredPages=()=>{
    for(const raw of cfg.pageAccessTokens){const row=normalizePageEntry(raw);if(row.pageId&&row.token&&!pagePool.has(row.pageId))pagePool.set(row.pageId,row);}
  };
  const persistPageRegistry=()=>{
    if(!registryFile)return;
    fs.mkdirSync(path.dirname(registryFile),{recursive:true});
    const tmp=`${registryFile}.tmp-${process.pid}-${Date.now()}`;
    const payload={version:1,updatedAt:new Date().toISOString(),pages:[...pagePool.values()].map(row=>({...row}))};
    fs.writeFileSync(tmp,JSON.stringify(payload,null,2),{mode:0o600});
    fs.renameSync(tmp,registryFile);try{fs.chmodSync(registryFile,0o600);}catch{}
  };
  loadPageRegistry();seedConfiguredPages();
  let legacyMigrationPromise=null;
  const ensureLegacyPageRegistered=async()=>{
    if(!cfg.pageAccessToken)return null;
    for(const row of pagePool.values())if(clean(row?.token,8000)===cfg.pageAccessToken&&clean(row?.pageId,180))return row;
    if(legacyMigrationPromise)return legacyMigrationPromise;
    legacyMigrationPromise=(async()=>{
      try{
        const me=await graphFetchWithToken(cfg.pageAccessToken,'me',{fields:'id,name'});
        const pageId=clean(me?.id,180);
        if(!pageId)return null;
        const existing=pagePool.get(pageId);
        if(existing){
          if(!existing.name&&clean(me?.name,300)){
            existing.name=clean(me.name,300);
            existing.updatedAt=new Date().toISOString();
            pagePool.set(pageId,existing);
            persistPageRegistry();
          }
          return existing;
        }
        const row={pageId,name:clean(me?.name,300)||'Legacy Facebook Page',token:cfg.pageAccessToken,enabled:true,updatedAt:new Date().toISOString(),legacyMigrated:true};
        pagePool.set(pageId,row);
        persistPageRegistry();
        logger('meta-legacy-page-migrated-to-pool',{pageId,name:row.name});
        return row;
      }catch(error){
        logger('meta-legacy-page-migration-error',{error:String(error?.details?.error?.message||error?.message||error)});
        return null;
      }finally{
        legacyMigrationPromise=null;
      }
    })();
    return legacyMigrationPromise;
  };
  const enabledPoolRows=()=>[...pagePool.values()].filter(row=>row.enabled!==false&&!!row.token);
  const anyPageTokenConfigured=()=>enabledPoolRows().length>0||!!cfg.pageAccessToken;
  const pageRowFor=(pageId='')=>{
    const id=clean(pageId,180);
    if(id){const row=pagePool.get(id);if(row?.enabled!==false&&row?.token)return row;}
    const active=enabledPoolRows();
    if(!id&&active.length===1)return active[0];
    if(cfg.pageAccessToken)return {pageId:id,name:'Legacy Facebook Page',token:cfg.pageAccessToken,enabled:true,legacy:true};
    throw Object.assign(new Error(id?'page-token-not-configured-for-page':'page-access-token-not-configured'),{statusCode:503,details:id?{pageId:id}:undefined});
  };
  const publicPage=(row={})=>({pageId:clean(row.pageId,180),name:clean(row.name,300),enabled:row.enabled!==false,tokenConfigured:!!clean(row.token,8000),legacy:!!row.legacy,updatedAt:clean(row.updatedAt,80)});
  let sqlite=null;
  let sqliteReady=false;
  let insertEvent=null;
  let upsertHistoryEvent=null;
  let listRecent=null;
  let listDbDeltaEvents=null;
  let latestDbDeltaCursor=null;
  let listConversations=null;
  let listConversation=null;
  let listConversationBefore=null;
  let listConversationReceipts=null;
  let findPageForPeer=null;
  let upsertHistoryConversation=null;
  let findHistoryConversation=null;
  let findHistoryConversationByPeer=null;
  let updateHistoryProfile=null;
  let markHistoryLoaded=null;
  let knownPeerForPage=null;
  let countEvents=null;
  let countHistoryConversations=null;
  let historySyncPromise=null;
  let autoReconcileTimer=null;
  let autoReconcileStartupTimer=null;
  let subscriptionRefreshTimer=null;
  let activeRecoveryWatchdogTimer=null;
  let lastDbDeltaClientAt=0;
  const recoveryWatchdogState={
    enabled:true,runs:0,lastStartedAt:'',lastCompletedAt:'',lastSuccessAt:'',lastError:'',
    lastRecoveredMessages:0,totalRecoveredMessages:0,lastSkippedReason:'',intervalMs:cfg.activeRecoveryProbeIntervalMs,
    desktopTtlMs:cfg.activeRecoveryDesktopTtlMs
  };
  const autoSyncState={
    running:false,runs:0,lastReason:'',lastStartedAt:'',lastCompletedAt:'',lastSuccessAt:'',lastError:'',
    lastRecoveredMessages:0,lastHydratedConversations:0,totalRecoveredMessages:0
  };
  const echoSubscriptionFields=['messages','message_echoes','message_deliveries','message_reads','messaging_postbacks','standby','messaging_handovers'];
  const echoSubscriptionState={
    enabled:cfg.autoSubscribeEchoes,lastAttemptAt:'',lastSuccessAt:'',lastError:'',pageId:'',fields:echoSubscriptionFields.slice()
  };
  // v0.9.3: Webhook is the real-time source of truth. Graph history sync is fallback only.
  // Keep rate-limit/backoff state separate from message ingest so webhook writes never wait on Graph API.
  const realtimeState={
    webhookEvents:0,webhookInserted:0,lastWebhookAt:'',lastWebhookPageId:'',lastIncomingWebhookAt:'',lastIncomingWebhookPageId:'',
    autoSkippedRecentWebhook:0,autoSkippedRateLimit:0
  };
  const appRateLimitState={hits:0,level:0,backoffUntil:0,lastAt:'',lastCode:0,lastMessage:''};
  const pageRateLimitState=new Map();
  const pageSyncState=new Map();
  const pageSyncPromises=new Map();
  // v0.9.11: Facebook profile/avatar Graph enrichment is disabled entirely.
  // Conversation/message Graph capacity is reserved for realtime recovery only.
  // The profile endpoint remains compatibility-safe but is cache/history-only.
  const profileNegativeUntil=new Map();
  const profileBudgetState={windowStartedAt:0,used:0,maxPerMinute:0,deferred:0,negativeHits:0,unsupported:0,graphDisabled:true};
  const rateCodes=new Set([4,17,32,613]);
  const graphErrorInfo=(error)=>{
    const e=error?.details?.error||error?.details||{};
    return {code:Number(e?.code||0)||0,message:clean(e?.message||error?.message,1000),transient:e?.is_transient===true};
  };
  const isRateLimitError=(error)=>{const info=graphErrorInfo(error);return rateCodes.has(info.code)||/request limit|rate limit|too many/i.test(info.message);};
  const isUnavailableProfileError=(error)=>{
    const e=error?.details?.error||error?.details||{};
    const sub=Number(e?.error_subcode||0)||0;
    const msg=clean(e?.message||error?.message,1200);
    return sub===33||/unsupported get request|does not exist|missing permissions|does not support this operation/i.test(msg);
  };
  const takeProfileBudget=()=>{
    const now=Date.now();
    if(!profileBudgetState.windowStartedAt||now-profileBudgetState.windowStartedAt>=60*1000){
      profileBudgetState.windowStartedAt=now;profileBudgetState.used=0;
    }
    if(profileBudgetState.used>=profileBudgetState.maxPerMinute){profileBudgetState.deferred++;return false;}
    profileBudgetState.used++;return true;
  };
  const backoffDelayMs=(level)=>Math.min(15*60*1000,30*1000*Math.pow(2,Math.max(0,Math.min(5,Number(level||1)-1))));
  const pageStateFor=(pageId='')=>{
    const id=clean(pageId,180)||'_unknown';
    if(!pageRateLimitState.has(id))pageRateLimitState.set(id,{hits:0,level:0,backoffUntil:0,lastAt:'',lastCode:0,lastMessage:''});
    return pageRateLimitState.get(id);
  };
  const syncStateFor=(pageId='')=>{
    const id=clean(pageId,180)||'_unknown';
    if(!pageSyncState.has(id))pageSyncState.set(id,{running:false,runs:0,lastStartedAt:'',lastCompletedAt:'',lastSuccessAt:'',lastError:'',lastMode:'',lastRecoveredMessages:0});
    return pageSyncState.get(id);
  };
  const pageIdForToken=(token='')=>{
    const t=clean(token,8000);if(!t)return '';
    for(const row of pagePool.values())if(clean(row?.token,8000)===t)return clean(row?.pageId,180);
    return '';
  };
  const noteRateLimit=(error,pageId='')=>{
    if(error?.__yokoRateNoted)return error.__yokoRateNoted;
    const info=graphErrorInfo(error);if(!isRateLimitError(error))return null;
    const now=Date.now();const isApp=info.code===4;
    const state=isApp?appRateLimitState:pageStateFor(pageId);
    state.hits++;state.level=Math.min(6,Number(state.level||0)+1);state.backoffUntil=now+backoffDelayMs(state.level);state.lastAt=new Date(now).toISOString();state.lastCode=info.code;state.lastMessage=info.message;
    logger('meta-rate-limit-backoff',{scope:isApp?'app':'page',pageId:clean(pageId,180),code:info.code,message:info.message,backoffMs:state.backoffUntil-now,until:new Date(state.backoffUntil).toISOString()});
    const noted={scope:isApp?'app':'page',...state};try{error.__yokoRateNoted=noted;}catch{}return noted;
  };
  const clearRateLimitOnSuccess=(pageId='')=>{
    const now=Date.now();
    if(appRateLimitState.backoffUntil&&appRateLimitState.backoffUntil<=now){appRateLimitState.level=Math.max(0,appRateLimitState.level-1);appRateLimitState.backoffUntil=0;}
    const state=pageStateFor(pageId);if(state.backoffUntil&&state.backoffUntil<=now){state.level=Math.max(0,state.level-1);state.backoffUntil=0;}
  };
  const activeBackoff=(pageId='')=>{
    const now=Date.now();const page=pageStateFor(pageId);const until=Math.max(Number(appRateLimitState.backoffUntil||0),Number(page.backoffUntil||0));
    return until>now?{active:true,until,remainingMs:until-now,scope:Number(appRateLimitState.backoffUntil||0)>=Number(page.backoffUntil||0)?'app':'page'}:{active:false,until:0,remainingMs:0,scope:''};
  };
  const lastWebhookAtByPage=new Map();
  try{
    if(dbFile){
      const {DatabaseSync}=require('node:sqlite');
      fs.mkdirSync(path.dirname(dbFile),{recursive:true});
      sqlite=new DatabaseSync(dbFile);
      sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS meta_events (
          event_key TEXT PRIMARY KEY,
          object_type TEXT NOT NULL,
          entry_id TEXT NOT NULL DEFAULT '',
          page_id TEXT NOT NULL DEFAULT '',
          sender_id TEXT NOT NULL DEFAULT '',
          recipient_id TEXT NOT NULL DEFAULT '',
          direction TEXT NOT NULL DEFAULT '',
          event_type TEXT NOT NULL DEFAULT '',
          message_id TEXT NOT NULL DEFAULT '',
          text TEXT NOT NULL DEFAULT '',
          timestamp_ms INTEGER NOT NULL DEFAULT 0,
          payload_json TEXT NOT NULL,
          received_at TEXT NOT NULL
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_meta_events_received_at ON meta_events(received_at);
        CREATE INDEX IF NOT EXISTS idx_meta_events_sender_id ON meta_events(sender_id);
        CREATE INDEX IF NOT EXISTS idx_meta_events_page_id ON meta_events(page_id);
        -- V1.27.254: composite indexes match the hot inbox/history predicates and sort order.
        CREATE INDEX IF NOT EXISTS idx_meta_events_page_incoming_time ON meta_events(page_id,direction,sender_id,event_type,timestamp_ms DESC,received_at DESC,event_key DESC);
        CREATE INDEX IF NOT EXISTS idx_meta_events_page_outgoing_time ON meta_events(page_id,direction,recipient_id,event_type,timestamp_ms DESC,received_at DESC,event_key DESC);
        CREATE INDEX IF NOT EXISTS idx_meta_events_page_time ON meta_events(page_id,timestamp_ms DESC,received_at DESC,event_key DESC);
        CREATE TABLE IF NOT EXISTS meta_history_conversations (
          page_id TEXT NOT NULL,
          peer_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          updated_time_ms INTEGER NOT NULL DEFAULT 0,
          history_loaded_at_ms INTEGER NOT NULL DEFAULT 0,
          hydrated_updated_time_ms INTEGER NOT NULL DEFAULT 0,
          synced_at TEXT NOT NULL,
          PRIMARY KEY(page_id,peer_id)
        ) WITHOUT ROWID;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_history_conversation_id ON meta_history_conversations(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_meta_history_updated ON meta_history_conversations(updated_time_ms DESC,page_id,peer_id);
        CREATE INDEX IF NOT EXISTS idx_meta_history_peer_updated ON meta_history_conversations(peer_id,updated_time_ms DESC);
      `);
      try{sqlite.exec('PRAGMA optimize;');}catch{}
      const historyColumns=sqlite.prepare('PRAGMA table_info(meta_history_conversations)').all();
      if(!historyColumns.some(row=>String(row?.name||'')==='avatar_url')){
        sqlite.exec("ALTER TABLE meta_history_conversations ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''");
      }
      if(!historyColumns.some(row=>String(row?.name||'')==='hydrated_updated_time_ms')){
        sqlite.exec("ALTER TABLE meta_history_conversations ADD COLUMN hydrated_updated_time_ms INTEGER NOT NULL DEFAULT 0");
      }
      insertEvent=sqlite.prepare(`INSERT OR IGNORE INTO meta_events(
        event_key,object_type,entry_id,page_id,sender_id,recipient_id,direction,event_type,message_id,text,timestamp_ms,payload_json,received_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      upsertHistoryEvent=sqlite.prepare(`INSERT INTO meta_events(
        event_key,object_type,entry_id,page_id,sender_id,recipient_id,direction,event_type,message_id,text,timestamp_ms,payload_json,received_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(event_key) DO UPDATE SET
        text=CASE WHEN meta_events.text='' AND excluded.text<>'' THEN excluded.text ELSE meta_events.text END,
        payload_json=CASE WHEN meta_events.text='' AND excluded.text<>'' THEN excluded.payload_json ELSE meta_events.payload_json END,
        received_at=CASE WHEN meta_events.text='' AND excluded.text<>'' THEN excluded.received_at ELSE meta_events.received_at END
      WHERE meta_events.text='' AND excluded.text<>''`);
      listRecent=sqlite.prepare(`SELECT event_key AS eventKey,object_type AS objectType,entry_id AS entryId,page_id AS pageId,
        sender_id AS senderId,recipient_id AS recipientId,direction,event_type AS eventType,message_id AS messageId,text,timestamp_ms AS timestampMs,
        received_at AS receivedAt,payload_json AS payloadJson FROM meta_events ORDER BY received_at DESC LIMIT ?`);
      listDbDeltaEvents=sqlite.prepare(`SELECT event_key AS eventKey,page_id AS pageId,sender_id AS senderId,recipient_id AS recipientId,
        direction,event_type AS eventType,message_id AS messageId,text,timestamp_ms AS timestampMs,received_at AS receivedAt
        FROM meta_events
        WHERE ((event_type='message' AND text<>'' AND direction='incoming') OR event_type IN ('read','delivery'))
          AND (received_at>? OR (received_at=? AND event_key>?))
        ORDER BY received_at ASC,event_key ASC LIMIT ?`);
      latestDbDeltaCursor=sqlite.prepare(`SELECT received_at AS receivedAt,event_key AS eventKey FROM meta_events
        WHERE ((event_type='message' AND text<>'' AND direction='incoming') OR event_type IN ('read','delivery'))
        ORDER BY received_at DESC,event_key DESC LIMIT 1`);
      listConversations=sqlite.prepare(`
        WITH base AS (
          SELECT event_key,page_id,
            CASE WHEN direction='incoming' THEN sender_id ELSE recipient_id END AS peer_id,
            direction,text,timestamp_ms,received_at
          FROM meta_events
          WHERE event_type='message' AND text<>'' AND (sender_id<>'' OR recipient_id<>'')
        ), valid AS (
          SELECT * FROM base WHERE peer_id<>'' AND peer_id<>page_id
        ), ranked AS (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY page_id,peer_id ORDER BY timestamp_ms DESC, received_at DESC, event_key DESC) AS rn
          FROM valid
        ), event_conv AS (
          SELECT page_id AS pageId,peer_id AS peerId,
            MAX(timestamp_ms) AS lastTimestampMs,
            MAX(CASE WHEN direction='incoming' THEN timestamp_ms ELSE 0 END) AS lastIncomingAt,
            MIN(CASE WHEN direction='incoming' THEN timestamp_ms ELSE NULL END) AS firstIncomingAt,
            MAX(CASE WHEN direction='outgoing' THEN timestamp_ms ELSE 0 END) AS lastReplyAt,
            MAX(CASE WHEN rn=1 THEN direction ELSE '' END) AS lastDirection,
            MAX(CASE WHEN rn=1 THEN text ELSE '' END) AS preview,
            MAX(CASE WHEN rn=1 THEN event_key ELSE '' END) AS lastEventKey,
            COUNT(*) AS messageCount
          FROM ranked
          GROUP BY page_id,peer_id
        ), combined AS (
          SELECT e.pageId,e.peerId,e.lastTimestampMs,e.lastIncomingAt,e.firstIncomingAt,e.lastReplyAt,e.lastDirection,e.preview,e.lastEventKey,e.messageCount,
            COALESCE(h.conversation_id,'') AS conversationId,COALESCE(h.display_name,'') AS displayName,COALESCE(h.avatar_url,'') AS avatarUrl,0 AS historyOnly
          FROM event_conv e LEFT JOIN meta_history_conversations h ON h.page_id=e.pageId AND h.peer_id=e.peerId
          UNION ALL
          SELECT h.page_id AS pageId,h.peer_id AS peerId,h.updated_time_ms AS lastTimestampMs,0 AS lastIncomingAt,0 AS firstIncomingAt,0 AS lastReplyAt,'' AS lastDirection,
            '历史会话 · 点击加载' AS preview,('history:'||h.conversation_id) AS lastEventKey,0 AS messageCount,h.conversation_id AS conversationId,h.display_name AS displayName,h.avatar_url AS avatarUrl,1 AS historyOnly
          FROM meta_history_conversations h
          WHERE NOT EXISTS(SELECT 1 FROM event_conv e WHERE e.pageId=h.page_id AND e.peerId=h.peer_id)
        )
        SELECT * FROM combined ORDER BY lastTimestampMs DESC LIMIT ?`);
      // Receipt events are stored independently; they are never conversation messages.
      // Scope by both Page and peer to prevent cross-Page or cross-customer leakage.
      listConversationReceipts=sqlite.prepare(`SELECT event_type AS eventType,payload_json AS payloadJson,timestamp_ms AS timestampMs
        FROM meta_events WHERE page_id=? AND sender_id=? AND event_type IN ('read','delivery')
        ORDER BY timestamp_ms DESC LIMIT 500`);
      listConversation=sqlite.prepare(`SELECT * FROM (
        SELECT event_key AS eventKey,object_type AS objectType,entry_id AS entryId,page_id AS pageId,
          sender_id AS senderId,recipient_id AS recipientId,direction,event_type AS eventType,message_id AS messageId,text,timestamp_ms AS timestampMs,
          received_at AS receivedAt,payload_json AS payloadJson
        FROM meta_events
        WHERE event_type='message' AND page_id=? AND ((direction='incoming' AND sender_id=?) OR (direction='outgoing' AND recipient_id=?))
        ORDER BY timestamp_ms DESC, received_at DESC, event_key DESC
        LIMIT ?
      ) ORDER BY timestampMs ASC, receivedAt ASC, eventKey ASC`);
      listConversationBefore=sqlite.prepare(`SELECT * FROM (
        SELECT event_key AS eventKey,object_type AS objectType,entry_id AS entryId,page_id AS pageId,
          sender_id AS senderId,recipient_id AS recipientId,direction,event_type AS eventType,message_id AS messageId,text,timestamp_ms AS timestampMs,
          received_at AS receivedAt,payload_json AS payloadJson
        FROM meta_events
        WHERE event_type='message' AND page_id=? AND ((direction='incoming' AND sender_id=?) OR (direction='outgoing' AND recipient_id=?))
          AND (timestamp_ms < ? OR (timestamp_ms = ? AND received_at < ?) OR (timestamp_ms = ? AND received_at = ? AND event_key < ?))
        ORDER BY timestamp_ms DESC, received_at DESC, event_key DESC
        LIMIT ?
      ) ORDER BY timestampMs ASC, receivedAt ASC, eventKey ASC`);
      findPageForPeer=sqlite.prepare(`SELECT page_id AS pageId FROM meta_events WHERE page_id<>'' AND (sender_id=? OR recipient_id=?) ORDER BY timestamp_ms DESC,received_at DESC LIMIT 1`);
      upsertHistoryConversation=sqlite.prepare(`INSERT INTO meta_history_conversations(page_id,peer_id,conversation_id,display_name,avatar_url,updated_time_ms,history_loaded_at_ms,synced_at)
        VALUES(?,?,?,?,?,?,0,?) ON CONFLICT(page_id,peer_id) DO UPDATE SET
          conversation_id=excluded.conversation_id,
          display_name=CASE WHEN excluded.display_name<>'' THEN excluded.display_name ELSE meta_history_conversations.display_name END,
          avatar_url=CASE WHEN excluded.avatar_url<>'' THEN excluded.avatar_url ELSE meta_history_conversations.avatar_url END,
          updated_time_ms=MAX(meta_history_conversations.updated_time_ms,excluded.updated_time_ms),
          synced_at=excluded.synced_at`);
      findHistoryConversation=sqlite.prepare(`SELECT page_id AS pageId,peer_id AS peerId,conversation_id AS conversationId,display_name AS displayName,avatar_url AS avatarUrl,updated_time_ms AS updatedTimeMs,history_loaded_at_ms AS historyLoadedAtMs,hydrated_updated_time_ms AS hydratedUpdatedTimeMs FROM meta_history_conversations WHERE page_id=? AND peer_id=? LIMIT 1`);
      findHistoryConversationByPeer=sqlite.prepare(`SELECT page_id AS pageId,peer_id AS peerId,conversation_id AS conversationId,display_name AS displayName,avatar_url AS avatarUrl,updated_time_ms AS updatedTimeMs,history_loaded_at_ms AS historyLoadedAtMs,hydrated_updated_time_ms AS hydratedUpdatedTimeMs FROM meta_history_conversations WHERE peer_id=? ORDER BY updated_time_ms DESC LIMIT 1`);
      updateHistoryProfile=sqlite.prepare(`UPDATE meta_history_conversations SET display_name=CASE WHEN ?<>'' THEN ? ELSE display_name END,avatar_url=CASE WHEN ?<>'' THEN ? ELSE avatar_url END,synced_at=? WHERE page_id=? AND peer_id=?`);
      markHistoryLoaded=sqlite.prepare(`UPDATE meta_history_conversations SET history_loaded_at_ms=?,hydrated_updated_time_ms=MAX(hydrated_updated_time_ms,?),synced_at=? WHERE page_id=? AND peer_id=?`);
      knownPeerForPage=sqlite.prepare(`SELECT 1 AS ok FROM meta_events WHERE page_id=? AND ((direction='incoming' AND sender_id=?) OR (direction='outgoing' AND recipient_id=?)) LIMIT 1`);
      countEvents=sqlite.prepare('SELECT COUNT(*) AS count FROM meta_events');
      countHistoryConversations=sqlite.prepare('SELECT COUNT(*) AS count FROM meta_history_conversations');
      sqliteReady=true;
    }
  }catch(error){logger('meta-sqlite-open-error',error);}

  // v0.9.4: authenticated server-sent event stream for desktop real-time inbox wakeups.
  // The stream carries only event metadata/text already present in the official inbox;
  // Team ID/API Key stay in request headers and never appear in the URL.
  const realtimeClients=new Map(); // response -> selected inbox (all/default/custom)
  let realtimeHeartbeatTimer=null;
  // v0.9.5: proxy-safe authenticated long-poll fallback. Some reverse proxies
  // keep SSE connections open yet buffer message frames. Long-poll returns
  // ordinary JSON immediately after webhook ingest and never touches Graph API.
  let realtimeSeq=0;
  const realtimeEventLog=[];
  const realtimePollWaiters=new Set();
  const realtimeLogMax=500;
  const sseWrite=(res,event,payload)=>{
    try{res.write(`event: ${event}\ndata: ${JSON.stringify(payload||{})}\n\n`);return true;}catch{return false;}
  };
  const stopRealtimeHeartbeatIfIdle=()=>{if(realtimeClients.size||!realtimeHeartbeatTimer)return;try{clearInterval(realtimeHeartbeatTimer);}catch{}realtimeHeartbeatTimer=null;};
  const ensureRealtimeHeartbeat=()=>{
    if(realtimeHeartbeatTimer)return;
    realtimeHeartbeatTimer=setInterval(()=>{
      const stamp={type:'heartbeat',at:new Date().toISOString()};
      for(const [res] of [...realtimeClients])if(!sseWrite(res,'heartbeat',stamp)){realtimeClients.delete(res);try{res.end();}catch{}}
      stopRealtimeHeartbeatIfIdle();
    },20000);
    realtimeHeartbeatTimer.unref?.();
  };
  const broadcastRealtime=(event,payload)=>{
    if(!realtimeClients.size)return 0;
    let delivered=0;
    for(const [res,inboxId] of [...realtimeClients]){
      if(!matchesInbox(payload,inboxId))continue;
      if(sseWrite(res,event,payload)){try{res.flush?.();}catch{}delivered++;}
      else{realtimeClients.delete(res);try{res.end();}catch{}}
    }
    stopRealtimeHeartbeatIfIdle();
    return delivered;
  };
  const matchesInbox=(event,inboxId='all')=>inboxId==='all'||(!!event?.pageId&&resolveFacebookInbox(event.pageId)===inboxId);
  const requestedInbox=(url)=>{
    const id=String(url.searchParams.get('inboxId')||'all').trim();
    return id&&validFacebookInbox(id)?id:null;
  };
  const realtimeEventsAfter=(after,limit=100,inboxId='all')=>realtimeEventLog.filter(row=>Number(row.seq||0)>Number(after||0)&&matchesInbox(row,inboxId)).slice(0,Math.max(1,Math.min(200,Number(limit||100)||100)));
  const finishRealtimePoll=(waiter,events=[])=>{
    if(!waiter||waiter.done)return;waiter.done=true;realtimePollWaiters.delete(waiter);try{clearTimeout(waiter.timer);}catch{}
    try{json(waiter.res,200,{ok:true,events,latestSeq:realtimeSeq,realtimeVersion:'v0.9.5-long-poll'});}catch{}
  };
  const wakeRealtimePollers=()=>{
    for(const waiter of [...realtimePollWaiters]){const events=realtimeEventsAfter(waiter.after,waiter.limit,waiter.inboxId);if(events.length)finishRealtimePoll(waiter,events);}
  };
  const publishRealtime=(event,payload)=>{
    const wrapped={...(payload||{}),event,seq:++realtimeSeq,publishedAt:new Date().toISOString()};
    realtimeEventLog.push(wrapped);if(realtimeEventLog.length>realtimeLogMax)realtimeEventLog.splice(0,realtimeEventLog.length-realtimeLogMax);
    const sseDelivered=broadcastRealtime(event,wrapped);wakeRealtimePollers();return {seq:wrapped.seq,sseDelivered,pollWaiters:realtimePollWaiters.size};
  };

  // v0.9.7: SQLite is the final authority for desktop inbound delivery.
  // A Graph-history recovery can insert a message after its original webhook window,
  // so desktop must be able to read newly inserted DB rows even when no realtime
  // webhook frame was published for that recovery path. The cursor is opaque to clients.
  const encodeDbDeltaCursor=(receivedAt='',eventKey='')=>Buffer.from(JSON.stringify([String(receivedAt||''),String(eventKey||'')]),'utf8').toString('base64url');
  const decodeDbDeltaCursor=value=>{
    try{const raw=Buffer.from(String(value||''),'base64url').toString('utf8');const row=JSON.parse(raw);return {receivedAt:String(row?.[0]||''),eventKey:String(row?.[1]||'')};}
    catch{return {receivedAt:'',eventKey:''};}
  };
  const currentDbDeltaCursor=()=>{const row=sqliteReady&&latestDbDeltaCursor?latestDbDeltaCursor.get():null;return encodeDbDeltaCursor(row?.receivedAt||'',row?.eventKey||'');};
  const readDbDeltaEvents=(cursor='',limit=100)=>{
    if(!sqliteReady||!listDbDeltaEvents)return {events:[],cursor:String(cursor||''),latestCursor:String(cursor||'')};
    if(String(cursor||'').toLowerCase()==='latest'){const latestCursor=currentDbDeltaCursor();return {events:[],cursor:latestCursor,latestCursor};}
    const decoded=decodeDbDeltaCursor(cursor);
    const rows=listDbDeltaEvents.all(decoded.receivedAt,decoded.receivedAt,decoded.eventKey,Math.max(1,Math.min(200,Number(limit||100)||100)));
    const events=rows.map(row=>({
      type:row.eventType==='read'||row.eventType==='delivery'?'meta-receipt':'meta-message',
      receiptType:row.eventType==='read'||row.eventType==='delivery'?row.eventType:'',
      platform:'facebook',pageId:String(row.pageId||''),peerId:String(row.senderId||''),direction:'incoming',
      eventKey:String(row.eventKey||''),messageId:String(row.messageId||''),text:String(row.text||''),timestampMs:Number(row.timestampMs||0),
      receivedAt:String(row.receivedAt||''),webhookSource:'sqlite-delta',dbRecovered:true
    })).filter(row=>row.pageId&&row.peerId);
    const tail=rows[rows.length-1];
    const nextCursor=tail?encodeDbDeltaCursor(tail.receivedAt,tail.eventKey):String(cursor||'');
    return {events,cursor:nextCursor,latestCursor:currentDbDeltaCursor()};
  };

  const storePayload=(payload)=>{
    if(!sqliteReady||!insertEvent)throw new Error('meta-sqlite-unavailable');
    const objectType=clean(payload?.object,80);
    let inserted=0;let seen=0;let messageEvents=0;let echoEvents=0;let incomingMessageEvents=0;const pageIds=new Set();const events=[];
    const receivedAt=new Date().toISOString();
    let messagingRows=0;let standbyRows=0;
    for(const entry of Array.isArray(payload?.entry)?payload.entry:[]){
      const primary=Array.isArray(entry?.messaging)?entry.messaging:[];
      const standby=Array.isArray(entry?.standby)?entry.standby:[];
      messagingRows+=primary.length;standbyRows+=standby.length;
      const rows=[...primary.map(row=>({row,source:'messaging'})),...standby.map(row=>({row,source:'standby'}))];
      if(!rows.length){
        const generic={sender:{id:''},recipient:{id:entry?.id||''},timestamp:entry?.time||Date.now(),raw_entry:entry};
        const n=normalizeEvent(objectType,entry,generic);seen++;
        const r=insertEvent.run(n.eventKey,n.objectType,n.entryId,n.pageId,n.senderId,n.recipientId,n.direction,'entry',n.messageId,n.text,n.timestampMs,JSON.stringify(entry||{}),receivedAt);
        inserted+=Number(r?.changes||0);
        continue;
      }
      for(const wrapped of rows){
        const row=wrapped.row;
        const n=normalizeEvent(objectType,entry,row);seen++;if(n.pageId)pageIds.add(n.pageId);
        if(n.eventType==='message')messageEvents++;
        if(n.eventType==='message'&&n.direction==='incoming'&&row?.message?.is_echo!==true)incomingMessageEvents++;
        if(n.eventType==='message'&&row?.message?.is_echo===true)echoEvents++;
        const payloadJson=wrapped.source==='standby'?JSON.stringify({...row,__yoko_webhook_source:'standby'}):n.payloadJson;
        const r=insertEvent.run(n.eventKey,n.objectType,n.entryId,n.pageId,n.senderId,n.recipientId,n.direction,n.eventType,n.messageId,n.text,n.timestampMs,payloadJson,receivedAt);
        const changes=Number(r?.changes||0);inserted+=changes;
        if(changes>0&&['message','read','delivery'].includes(n.eventType)){
          const peerId=n.eventType==='message'?(n.direction==='incoming'?n.senderId:n.recipientId):n.senderId;
          if(n.pageId&&peerId)events.push({type:n.eventType==='message'?'meta-message':'meta-receipt',receiptType:n.eventType==='message'?'':n.eventType,platform:'facebook',pageId:n.pageId,peerId,direction:n.direction,eventKey:n.eventKey,messageId:n.messageId,text:n.text,timestampMs:n.timestampMs,receivedAt,webhookSource:wrapped.source});
        }
      }
    }
    const now=Date.now();
    if(seen){
      realtimeState.webhookEvents+=seen;realtimeState.webhookInserted+=inserted;realtimeState.lastWebhookAt=new Date(now).toISOString();
      const ids=[...pageIds];realtimeState.lastWebhookPageId=ids[ids.length-1]||realtimeState.lastWebhookPageId;
      for(const pageId of ids)lastWebhookAtByPage.set(pageId,now);
      if(incomingMessageEvents){realtimeState.lastIncomingWebhookAt=realtimeState.lastWebhookAt;realtimeState.lastIncomingWebhookPageId=realtimeState.lastWebhookPageId;}
    }
    return {seen,inserted,messageEvents,echoEvents,incomingMessageEvents,messagingRows,standbyRows,pageIds:[...pageIds],events};
  };

  const readBody=(req,maxBytes=2*1024*1024)=>new Promise((resolve,reject)=>{
    const chunks=[];let total=0;let done=false;
    req.on('data',chunk=>{
      if(done)return;
      total+=chunk.length;
      if(total>maxBytes){done=true;reject(Object.assign(new Error('payload-too-large'),{statusCode:413}));req.destroy();return;}
      chunks.push(chunk);
    });
    req.on('end',()=>{if(!done)resolve(Buffer.concat(chunks));});
    req.on('error',error=>{if(!done)reject(error);});
  });

  const graphFetchWithToken=async(token,urlOrPath,params={})=>{
    const accessToken=clean(token,8000);
    if(!accessToken)throw Object.assign(new Error('page-access-token-not-configured'),{statusCode:503});
    let target=String(urlOrPath||'');let url;
    if(/^https:\/\/graph\.facebook\.com\//i.test(target))url=new URL(target);
    else{target=target.replace(/^\/+/, '');url=new URL(`https://graph.facebook.com/${cfg.graphVersion}/${target}`);}
    if(url.hostname!=='graph.facebook.com')throw Object.assign(new Error('invalid-graph-pagination-url'),{statusCode:502});
    for(const [key,value] of Object.entries(params||{}))if(value!==undefined&&value!==null&&String(value)!=='')url.searchParams.set(key,String(value));
    const response=await fetch(url,{headers:{'authorization':`Bearer ${accessToken}`,'accept':'application/json'}});
    const raw=await response.text();const parsed=safeJson(raw)||{raw:clean(raw,4000)};
    if(!response.ok){const error=Object.assign(new Error('meta-graph-failed'),{statusCode:502,details:parsed});noteRateLimit(error,pageIdForToken(accessToken));throw error;}
    clearRateLimitOnSuccess(pageIdForToken(accessToken));return parsed;
  };
  const graphPostWithToken=async(token,urlOrPath,params={})=>{
    const accessToken=clean(token,8000);
    if(!accessToken)throw Object.assign(new Error('page-access-token-not-configured'),{statusCode:503});
    let target=String(urlOrPath||'');let url;
    if(/^https:\/\/graph\.facebook\.com\//i.test(target))url=new URL(target);
    else{target=target.replace(/^\/+/, '');url=new URL(`https://graph.facebook.com/${cfg.graphVersion}/${target}`);}
    if(url.hostname!=='graph.facebook.com')throw Object.assign(new Error('invalid-graph-url'),{statusCode:502});
    for(const [key,value] of Object.entries(params||{}))if(value!==undefined&&value!==null&&String(value)!=='')url.searchParams.set(key,String(value));
    const response=await fetch(url,{method:'POST',headers:{'authorization':`Bearer ${accessToken}`,'accept':'application/json'}});
    const raw=await response.text();const parsed=safeJson(raw)||{raw:clean(raw,4000)};
    if(!response.ok){const error=Object.assign(new Error('meta-graph-post-failed'),{statusCode:502,details:parsed});noteRateLimit(error,pageIdForToken(accessToken));throw error;}
    clearRateLimitOnSuccess(pageIdForToken(accessToken));return parsed;
  };
  const graphFetch=async(urlOrPath,params={},pageId='')=>graphFetchWithToken(pageRowFor(pageId).token,urlOrPath,params);
  const graphPost=async(urlOrPath,params={},pageId='')=>graphPostWithToken(pageRowFor(pageId).token,urlOrPath,params);

  const pageIdentity=async(pageHint='')=>{
    const hinted=clean(pageHint,180);const row=pageRowFor(hinted);
    if(hinted&&clean(row?.pageId,180)){return {pageId:clean(row.pageId,180),name:clean(row.name,300)};}
    const me=await graphFetchWithToken(row.token,'me',{fields:'id,name'});
    const pageId=clean(me?.id,180);
    if(!pageId)throw Object.assign(new Error('meta-page-id-unavailable'),{statusCode:502,details:me});
    return {pageId,name:clean(me?.name,300)};
  };

  const ensureWebhookSubscription=async()=>{
    if(!cfg.autoSubscribeEchoes||!anyPageTokenConfigured())return {ok:false,skipped:true};
    const appBackoff=activeBackoff('');if(appBackoff.active)return {ok:false,skipped:true,reason:'rate-limit-backoff',backoffUntil:new Date(appBackoff.until).toISOString()};
    await ensureLegacyPageRegistered();
    echoSubscriptionState.lastAttemptAt=new Date().toISOString();
    const candidates=enabledPoolRows().length?enabledPoolRows():(cfg.pageAccessToken?[{pageId:'',name:'Legacy Facebook Page',token:cfg.pageAccessToken,enabled:true,legacy:true}]:[]);
    const results=[];
    for(const row of candidates){
      try{
        const knownPageId=clean(row?.pageId,180);const me=knownPageId?{id:knownPageId,name:clean(row?.name,300)}:await graphFetchWithToken(row.token,'me',{fields:'id,name'});const pageId=clean(me?.id,180);const name=clean(me?.name,300)||row.name;
        if(!pageId)throw new Error('meta-page-id-unavailable');
        if(!row.legacy&&row.pageId!==pageId){pagePool.delete(row.pageId);row.pageId=pageId;row.name=name;row.updatedAt=new Date().toISOString();pagePool.set(pageId,row);persistPageRegistry();}
        const result=await graphPostWithToken(row.token,`${pageId}/subscribed_apps`,{subscribed_fields:echoSubscriptionFields.join(',')});
        results.push({ok:true,pageId,name,fields:echoSubscriptionFields,result});
      }catch(error){
        results.push({ok:false,pageId:clean(row.pageId,180),name:clean(row.name,300),error:String(error?.details?.error?.message||error?.message||error),rateLimited:isRateLimitError(error)});
        const info=graphErrorInfo(error);if(isRateLimitError(error)&&info.code===4)break;
      }
    }
    const ok=results.filter(row=>row.ok);const bad=results.filter(row=>!row.ok);
    echoSubscriptionState.pageId=ok[0]?.pageId||'';echoSubscriptionState.pages=results.map(row=>({pageId:row.pageId,name:row.name,ok:!!row.ok,error:row.error||''}));
    if(ok.length){echoSubscriptionState.lastSuccessAt=new Date().toISOString();echoSubscriptionState.lastError=bad.length?`${bad.length} page(s) failed`:'';}else echoSubscriptionState.lastError=bad.map(row=>row.error).filter(Boolean).join(' | ')||'subscription-failed';
    logger('meta-webhook-subscription-pool',{ok:ok.length,failed:bad.length,pages:echoSubscriptionState.pages});
    return {ok:ok.length>0,pages:results};
  };

  const persistGraphMessage=(message,pageId,peerId)=>{
    if(!sqliteReady||!upsertHistoryEvent)return 0;
    const messageId=clean(message?.id,300);const body=messageDisplayText(message||{});
    if(!messageId||!body)return 0;
    const fromId=clean(message?.from?.id,180);
    const toRows=Array.isArray(message?.to?.data)?message.to.data:(Array.isArray(message?.to)?message.to:[]);
    const toIds=toRows.map(row=>clean(row?.id,180)).filter(Boolean);
    let direction='incoming',senderId=peerId,recipientId=pageId;
    if(fromId===pageId){direction='outgoing';senderId=pageId;recipientId=peerId;}
    else if(fromId){senderId=fromId;recipientId=toIds.includes(pageId)?pageId:(toIds[0]||pageId);}
    const timestampMs=Number(Date.parse(String(message?.created_time||'')))||Date.now();
    const eventKey=`message:${messageId}`;const receivedAt=new Date().toISOString();
    const payloadJson=JSON.stringify({historySync:true,conversationMessage:message});
    const r=upsertHistoryEvent.run(eventKey,'page',pageId,pageId,senderId,recipientId,direction,'message',messageId,body,timestampMs,payloadJson,receivedAt);
    return Number(r?.changes||0);
  };

  const mapWithConcurrency=async(items,limit,worker)=>{
    const rows=Array.isArray(items)?items:[];let cursor=0;const out=new Array(rows.length);
    const run=async()=>{while(cursor<rows.length){const i=cursor++;try{out[i]=await worker(rows[i],i);}catch(error){out[i]={error};}}};
    await Promise.all(Array.from({length:Math.max(1,Math.min(Number(limit||1)||1,rows.length||1))},run));
    return out;
  };

  const hydrateHistoryConversation=async(pageId,peerId,conversationId,messageLimit=60,observedUpdatedTimeMs=0)=>{
    const safeLimit=Math.max(1,Math.min(100,Number(messageLimit||60)||60));
    let data;
    const richFields=`id,messages.limit(${safeLimit}){id,created_time,message,from,to,attachments}`;
    const plainFields=`id,messages.limit(${safeLimit}){id,created_time,message,from,to}`;
    try{data=await graphFetch(conversationId,{fields:richFields},pageId);}
    catch(error1){
      if(isRateLimitError(error1))throw error1;
      try{data=await graphFetch(conversationId,{fields:plainFields},pageId);}
      catch(error2){if(isRateLimitError(error2))throw error2;data=await graphFetch(conversationId,{fields:`id,messages.limit(${safeLimit})`},pageId);}
    }
    let messages=Array.isArray(data?.messages?.data)?data.messages.data:[];
    const needsDetails=messages.filter(row=>row?.id&&!row?.message&&!attachmentRows(row?.attachments).length);
    if(needsDetails.length){
      const detailRows=await mapWithConcurrency(needsDetails.slice(0,safeLimit),4,async row=>{
        const id=clean(row.id,300);
        try{return await graphFetch(id,{fields:'id,created_time,from,to,message,attachments'},pageId);}
        catch(error){if(isRateLimitError(error))throw error;return graphFetch(id,{fields:'id,created_time,from,to,message'},pageId);}
      });
      const detailed=new Map(detailRows.filter(row=>row&&!row.error&&row.id).map(row=>[String(row.id),row]));
      messages=messages.map(row=>detailed.get(String(row?.id||''))||row);
    }
    let recovered=0;for(const message of messages)recovered+=persistGraphMessage(message,pageId,peerId);
    const observed=Math.max(0,Number(observedUpdatedTimeMs||0)||0);
    markHistoryLoaded?.run(Date.now(),observed,new Date().toISOString(),pageId,peerId);
    return {messages:messages.length,recovered};
  };

  const ensureHistoryConversation=async(pageId,peerId,messageLimit=60)=>{
    if(!sqliteReady||!findHistoryConversation)return {available:false};
    const row=findHistoryConversation.get(pageId,peerId);
    if(!row?.conversationId)return {available:false};
    const needsHydrate=Number(row.historyLoadedAtMs||0)<=0 || Number(row.hydratedUpdatedTimeMs||0)<Number(row.updatedTimeMs||0);
    if(!needsHydrate)return {available:true,loaded:false,conversationId:row.conversationId,upToDate:true};
    try{const result=await hydrateHistoryConversation(pageId,peerId,row.conversationId,messageLimit,row.updatedTimeMs);return {available:true,loaded:true,conversationId:row.conversationId,...result};}
    catch(error){logger('meta-history-lazy-load-error',{pageId,peerId,error:String(error?.message||error),details:error?.details});return {available:true,loaded:false,error:String(error?.message||error),details:error?.details};}
  };

  const graphPictureUrl=(value)=>{
    const p=value&&typeof value==='object'?value:{};
    return clean(p?.profile_pic || p?.picture?.data?.url || p?.picture?.url || p?.pictureUrl || p?.url || '',4000);
  };

  const syncHistoryDirectoryForPage=async(pageHint='',{conversationLimit=1000,messageLimit=60,maxDirectoryPages=20,hydrateTargetLimit=2000,hydrateConcurrency=4}={})=>{
    if(!sqliteReady||!upsertHistoryConversation)throw Object.assign(new Error('meta-storage-unavailable'),{statusCode:503});
    const {pageId,name:pageName}=await pageIdentity(pageHint);
    const safeLimit=Math.max(1,Math.min(2000,Number(conversationLimit||1000)||1000));
    const safeMessageLimit=Math.max(1,Math.min(100,Number(messageLimit||60)||60));
    let next='';let discovered=0,newConversations=0,pages=0;const syncedAt=new Date().toISOString();
    const hydrateTargets=[];
    do{
      const remaining=safeLimit-discovered;if(remaining<=0)break;
      let data;
      if(next)data=await graphFetch(next,{},pageId);
      else{
        // v0.9.11: do not request participant pictures. Names/IDs are sufficient
        // for inbox identity and avoiding picture fields saves Graph work.
        data=await graphFetch(`${pageId}/conversations`,{platform:'messenger',fields:'id,participants{id,name},updated_time',limit:Math.min(100,remaining)},pageId);
      }
      pages++;
      for(const conv of Array.isArray(data?.data)?data.data:[]){
        if(discovered>=safeLimit)break;
        const participants=Array.isArray(conv?.participants?.data)?conv.participants.data:[];
        const peer=participants.find(row=>clean(row?.id,180)&&clean(row?.id,180)!==pageId);
        const peerId=clean(peer?.id,180),conversationId=clean(conv?.id,500);
        if(!peerId||!conversationId)continue;
        discovered++;
        const updatedTimeMs=Number(Date.parse(String(conv?.updated_time||'')))||0;
        const avatarUrl=''; // v0.9.11: no new avatar hydration
        const prior=findHistoryConversation?.get(pageId,peerId)||null;
        if(!prior)newConversations++;
        upsertHistoryConversation.run(pageId,peerId,conversationId,clean(peer?.name,300),avatarUrl,updatedTimeMs,syncedAt);
        const hydratedAt=Math.max(0,Number(prior?.hydratedUpdatedTimeMs||0)||0);
        if(!prior || hydratedAt===0 || updatedTimeMs>hydratedAt){
          hydrateTargets.push({pageId,peerId,conversationId,updatedTimeMs,displayName:clean(peer?.name,300)});
        }
      }
      next=clean(data?.paging?.next,4000);
    }while(next&&discovered<safeLimit&&pages<Math.max(1,Math.min(20,Number(maxDirectoryPages||20)||20)));

    const limitedHydrateTargets=hydrateTargets.slice(0,Math.max(0,Math.min(2000,Number(hydrateTargetLimit??2000)||0)));
    const hydrationResults=await mapWithConcurrency(limitedHydrateTargets,Math.max(1,Math.min(4,Number(hydrateConcurrency||4)||4)),async target=>{
      const result=await hydrateHistoryConversation(target.pageId,target.peerId,target.conversationId,safeMessageLimit,target.updatedTimeMs);
      return {...target,...result};
    });
    let hydratedConversations=0,messagesFetched=0,recoveredMessages=0,hydrateFailed=0;const hydrateErrors=[];
    for(let i=0;i<hydrationResults.length;i++){
      const row=hydrationResults[i];
      if(row?.error){
        hydrateFailed++;
        if(hydrateErrors.length<12)hydrateErrors.push({peerId:limitedHydrateTargets[i]?.peerId||'',displayName:limitedHydrateTargets[i]?.displayName||'',error:String(row.error?.message||row.error)});
        continue;
      }
      hydratedConversations++;messagesFetched+=Number(row?.messages||0)||0;recoveredMessages+=Number(row?.recovered||0)||0;
    }
    return {
      ok:true,pageId,pageName,conversations:discovered,insertedConversations:newConversations,newConversations,pages,
      hydrateCandidates:hydrateTargets.length,hydrateScheduled:limitedHydrateTargets.length,hydratedConversations,hydrateFailed,messagesFetched,recoveredMessages,hydrateErrors
    };
  };

  const syncOnePage=async(pageId,{mode='full',conversationLimit=1000,messageLimit=60,maxDirectoryPages=20,hydrateTargetLimit=2000,hydrateConcurrency=4}={})=>{
    const id=clean(pageId,180);const key=id||'_legacy';
    if(pageSyncPromises.has(key))return pageSyncPromises.get(key);
    const state=syncStateFor(id);state.running=true;state.lastStartedAt=new Date().toISOString();state.lastMode=mode;
    const promise=(async()=>{
      try{
        const result=await syncHistoryDirectoryForPage(id,{conversationLimit,messageLimit,maxDirectoryPages,hydrateTargetLimit,hydrateConcurrency});
        state.runs++;state.lastCompletedAt=new Date().toISOString();state.lastSuccessAt=state.lastCompletedAt;state.lastError='';state.lastRecoveredMessages=Number(result?.recoveredMessages||0)||0;
        clearRateLimitOnSuccess(result?.pageId||id);return result;
      }catch(error){
        state.runs++;state.lastCompletedAt=new Date().toISOString();state.lastError=String(error?.details?.error?.message||error?.message||error);noteRateLimit(error,id);throw error;
      }finally{state.running=false;pageSyncPromises.delete(key);}
    })();pageSyncPromises.set(key,promise);return promise;
  };

  const syncHistoryDirectory=async({conversationLimit=1000,messageLimit=60,mode='full',maxDirectoryPages=20,hydrateTargetLimit=2000,hydrateConcurrency=4,skipRecentWebhookMs=0}={})=>{
    await ensureLegacyPageRegistered();
    const pool=enabledPoolRows();
    const hints=pool.length?pool.map(row=>row.pageId):[''];
    const pages=[];let conversations=0,newConversations=0,hydratedConversations=0,hydrateFailed=0,messagesFetched=0,recoveredMessages=0;
    for(const hint of hints){
      const id=clean(hint,180);const backoff=activeBackoff(id);
      if(backoff.active){realtimeState.autoSkippedRateLimit++;pages.push({ok:true,skipped:true,skipReason:'rate-limit-backoff',pageId:id,backoffUntil:new Date(backoff.until).toISOString(),backoffScope:backoff.scope});continue;}
      const webhookAt=Number(lastWebhookAtByPage.get(id)||0);
      if(mode==='quick'&&skipRecentWebhookMs>0&&webhookAt&&Date.now()-webhookAt<skipRecentWebhookMs){
        realtimeState.autoSkippedRecentWebhook++;pages.push({ok:true,skipped:true,skipReason:'recent-webhook',pageId:id,lastWebhookAt:new Date(webhookAt).toISOString()});continue;
      }
      try{
        const result=await syncOnePage(id,{mode,conversationLimit,messageLimit,maxDirectoryPages,hydrateTargetLimit,hydrateConcurrency});pages.push({...result,ok:true});
        conversations+=Number(result.conversations||0);newConversations+=Number(result.newConversations||0);hydratedConversations+=Number(result.hydratedConversations||0);hydrateFailed+=Number(result.hydrateFailed||0);messagesFetched+=Number(result.messagesFetched||0);recoveredMessages+=Number(result.recoveredMessages||0);
      }catch(error){pages.push({ok:false,pageId:id,error:String(error?.details?.error?.message||error?.message||error),rateLimited:isRateLimitError(error)});}
      // Avoid request bursts across Page tokens even when the app is healthy.
      if(mode==='quick'&&hints.length>1)await new Promise(resolve=>setTimeout(resolve,350));
    }
    const attempted=pages.filter(row=>!row.skipped);
    if(attempted.length&&!attempted.some(row=>row.ok))throw Object.assign(new Error('meta-history-sync-all-pages-failed'),{statusCode:502,details:{pages}});
    if(pages.length===1&&pages[0].ok)return {...pages[0],pages};
    return {ok:true,mode,pages,conversations,insertedConversations:newConversations,newConversations,hydrateCandidates:pages.reduce((n,row)=>n+Number(row.hydrateCandidates||0),0),hydratedConversations,hydrateFailed,messagesFetched,recoveredMessages};
  };

  const runHistoryReconcile=async(reason='manual',options={})=>{
    if(historySyncPromise)return historySyncPromise;
    const isWatchdog=reason==='realtime-watchdog';
    const isBackground=reason==='auto'||reason==='startup'||isWatchdog;
    const policy=isBackground?{
      mode:'quick',
      conversationLimit:isWatchdog?30:50,
      messageLimit:isWatchdog?10:20,
      maxDirectoryPages:1,
      hydrateTargetLimit:isWatchdog?12:8,
      hydrateConcurrency:2,
      skipRecentWebhookMs:0,
      ...options
    }:{mode:'full',conversationLimit:1000,messageLimit:60,maxDirectoryPages:20,hydrateTargetLimit:2000,hydrateConcurrency:4,...options};
    const globalBackoff=activeBackoff('');
    if(isBackground&&globalBackoff.active){realtimeState.autoSkippedRateLimit++;return {ok:true,skipped:true,skipReason:'rate-limit-backoff',backoffUntil:new Date(globalBackoff.until).toISOString(),backoffScope:globalBackoff.scope};}
    autoSyncState.running=true;
    autoSyncState.lastReason=clean(reason,80)||'manual';
    autoSyncState.lastStartedAt=new Date().toISOString();
    historySyncPromise=(async()=>{
      try{
        const result=await syncHistoryDirectory(policy);
        autoSyncState.runs++;
        autoSyncState.lastCompletedAt=new Date().toISOString();
        autoSyncState.lastSuccessAt=autoSyncState.lastCompletedAt;
        autoSyncState.lastError='';
        autoSyncState.lastRecoveredMessages=Number(result?.recoveredMessages||0)||0;
        autoSyncState.lastHydratedConversations=Number(result?.hydratedConversations||0)||0;
        autoSyncState.totalRecoveredMessages+=autoSyncState.lastRecoveredMessages;
        logger(reason==='manual'?'meta-history-sync':'meta-history-auto-sync',{reason,policy:{mode:policy.mode,conversationLimit:policy.conversationLimit,messageLimit:policy.messageLimit,maxDirectoryPages:policy.maxDirectoryPages,hydrateTargetLimit:policy.hydrateTargetLimit},...result});
        return {...result,reconcileReason:reason};
      }catch(error){
        autoSyncState.runs++;
        autoSyncState.lastCompletedAt=new Date().toISOString();
        autoSyncState.lastError=String(error?.details?.error?.message||error?.message||error);
        logger(reason==='manual'?'meta-history-sync-error':'meta-history-auto-sync-error',{reason,error:autoSyncState.lastError,details:error?.details,rateLimited:isRateLimitError(error)});
        throw error;
      }finally{
        autoSyncState.running=false;
        historySyncPromise=null;
      }
    })();
    return historySyncPromise;
  };

  // v0.9.9: while a desktop is actively reading the SQLite delta feed, run a
  // small bounded Graph reconciliation as a safety net for a missing webhook.
  // This never blocks /api/meta/db-events and still honors the existing app/page
  // rate-limit backoff. Healthy webhook delivery remains the instant path.
  const runActiveRecoveryWatchdog=async()=>{
    const now=Date.now();
    if(!cfg.enabled||!sqliteReady||!anyPageTokenConfigured())return {ok:true,skipped:true,reason:'inactive'};
    if(!lastDbDeltaClientAt||now-lastDbDeltaClientAt>cfg.activeRecoveryDesktopTtlMs){
      recoveryWatchdogState.lastSkippedReason='desktop-idle';
      return {ok:true,skipped:true,reason:'desktop-idle'};
    }
    recoveryWatchdogState.runs++;
    recoveryWatchdogState.lastStartedAt=new Date(now).toISOString();
    recoveryWatchdogState.lastSkippedReason='';
    try{
      const result=await runHistoryReconcile('realtime-watchdog',{
        // v0.9.10: keep recovery cheap enough to stay alive for hours. The
        // newest conversations are the only ones relevant to a missed realtime
        // event, so do not fan out across 30 conversations / 12 hydrations.
        conversationLimit:12,messageLimit:8,maxDirectoryPages:1,hydrateTargetLimit:4,hydrateConcurrency:1
      });
      recoveryWatchdogState.lastCompletedAt=new Date().toISOString();
      recoveryWatchdogState.lastSuccessAt=recoveryWatchdogState.lastCompletedAt;
      recoveryWatchdogState.lastError='';
      recoveryWatchdogState.lastRecoveredMessages=Number(result?.recoveredMessages||0)||0;
      recoveryWatchdogState.totalRecoveredMessages+=recoveryWatchdogState.lastRecoveredMessages;
      if(result?.skipped)recoveryWatchdogState.lastSkippedReason=String(result?.skipReason||'skipped');
      logger('meta-active-recovery-watchdog',{...recoveryWatchdogState,result});
      return result;
    }catch(error){
      recoveryWatchdogState.lastCompletedAt=new Date().toISOString();
      recoveryWatchdogState.lastError=String(error?.details?.error?.message||error?.message||error);
      logger('meta-active-recovery-watchdog-error',{error:recoveryWatchdogState.lastError,details:error?.details});
      return {ok:false,error:recoveryWatchdogState.lastError};
    }
  };

  const apiSendFacebook=async(recipientId,messageText,pageId='')=>{
    const page=clean(pageId,180);
    const pageRow=pageRowFor(page);
    const url=`https://graph.facebook.com/${cfg.graphVersion}/${encodeURIComponent(page||'me')}/messages`;
    const response=await fetch(url,{
      method:'POST',
      headers:{'content-type':'application/json','authorization':`Bearer ${pageRow.token}`},
      body:JSON.stringify({recipient:{id:clean(recipientId,180)},message:{text:clean(messageText,20000)},messaging_type:'RESPONSE'})
    });
    const raw=await response.text();const parsed=safeJson(raw)||{raw:clean(raw,4000)};
    if(!response.ok){const error=Object.assign(new Error('meta-send-failed'),{statusCode:502,details:parsed});noteRateLimit(error,page);throw error;}
    clearRateLimitOnSuccess(page);return parsed;
  };

  // V1.27.299: Page-scoped Messenger multipart attachments, no base64 stored in SQLite.
  const apiSendFacebookImage=async(recipientId,pageId,media)=>{
    const page=clean(pageId,180),pageRow=pageRowFor(page);
    const mime=clean(media?.mime,120).toLowerCase(),filename=clean(media?.name,180);
    const kinds={
      'image/jpeg':['image','jpg'],'image/png':['image','png'],
      'application/pdf':['file','pdf'],'application/msword':['file','doc'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document':['file','docx'],
      'application/vnd.ms-excel':['file','xls'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':['file','xlsx']
    };
    const kind=kinds[mime];if(!kind)throw Object.assign(new Error('unsupported-attachment-type'),{statusCode:415});
    if(!filename||!filename.toLowerCase().endsWith('.'+kind[1]))throw Object.assign(new Error('attachment-filename-mismatch'),{statusCode:415});
    const encoded=String(media?.dataBase64||'');
    if(!encoded||encoded.length>11*1024*1024||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)||encoded.length%4!==0)throw Object.assign(new Error('invalid-attachment-data'),{statusCode:413});
    const bytes=Buffer.from(encoded,'base64'),max=kind[0]==='image'?8*1024*1024:6*1024*1024;
    if(!bytes.length||bytes.length>max)throw Object.assign(new Error('attachment-too-large'),{statusCode:413});
    const signatures={jpg:bytes.subarray(0,3).equals(Buffer.from('ffd8ff','hex')),png:bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')),pdf:bytes.subarray(0,5).equals(Buffer.from('%PDF-')),doc:bytes.subarray(0,8).equals(Buffer.from('d0cf11e0a1b11ae1','hex')),xls:bytes.subarray(0,8).equals(Buffer.from('d0cf11e0a1b11ae1','hex')),docx:bytes.subarray(0,4).equals(Buffer.from('504b0304','hex')),xlsx:bytes.subarray(0,4).equals(Buffer.from('504b0304','hex'))};
    if(!signatures[kind[1]])throw Object.assign(new Error('attachment-signature-mismatch'),{statusCode:415});
    const form=new FormData();form.append('recipient',JSON.stringify({id:clean(recipientId,180)}));form.append('messaging_type','RESPONSE');
    form.append('message',JSON.stringify({attachment:{type:kind[0],payload:{is_reusable:false}}}));
    form.append('filedata',new Blob([bytes],{type:mime}),filename);
    const response=await fetch(`https://graph.facebook.com/${cfg.graphVersion}/${encodeURIComponent(page||'me')}/messages`,{method:'POST',headers:{authorization:`Bearer ${pageRow.token}`},body:form});
    const raw=await response.text(),parsed=safeJson(raw)||{raw:clean(raw,2000)};
    if(!response.ok){const error=Object.assign(new Error('meta-attachment-send-failed'),{statusCode:502,details:parsed});noteRateLimit(error,page);throw error;}
    clearRateLimitOnSuccess(page);return parsed;
  };

  const apiProfile=async(userId,pageId='')=>{
    const target=clean(userId,180);const page=clean(pageId,180);
    const history=(page&&findHistoryConversation?findHistoryConversation.get(page,target):null)||findHistoryConversationByPeer?.get(target)||null;
    // v0.9.11: compatibility endpoint only. Never call Graph for customer profile
    // or avatar enrichment; return whatever the conversation directory already has.
    return {
      id:target,
      name:clean(history?.displayName,300),
      profile_pic:clean(history?.avatarUrl,4000),
      profileSource:'history-cache-only',
      profileGraphDisabled:true
    };
  };

  const persistOutgoingText=(recipientId,messageText,result={},explicitPageId='')=>{
    if(!sqliteReady||!insertEvent)return null;
    const peerId=clean(recipientId,180);
    const pageId=clean(explicitPageId,180)||clean(findPageForPeer?.get(peerId,peerId)?.pageId,180);
    const now=Date.now();
    const messageId=clean(result?.message_id,300) || `api-${crypto.randomUUID()}`;
    const eventKey=`message:${messageId}`;
    const receivedAt=new Date(now).toISOString();
    const payloadJson=JSON.stringify({sender:{id:pageId},recipient:{id:peerId},message:{mid:messageId,text:clean(messageText,20000),is_echo:true},apiSend:true,result:result||{}});
    const r=insertEvent.run(eventKey,'page',pageId,pageId,pageId,peerId,'outgoing','message',messageId,clean(messageText,20000),now,payloadJson,receivedAt);
    return {eventKey,messageId,pageId,timestampMs:now,receivedAt,inserted:Number(r?.changes||0)};
  };

  const handle=async(req,res,{auth=()=>false}={})=>{
    let url;
    try{url=new URL(req.url,'http://127.0.0.1');}catch{return false;}
    const pathname=url.pathname;
    if(pathname==='/meta/webhook'){
      if(!cfg.enabled){text(res,503,'META_WEBHOOK_DISABLED');return true;}
      if(req.method==='GET'){
        const mode=url.searchParams.get('hub.mode')||'';
        const token=url.searchParams.get('hub.verify_token')||'';
        const challenge=url.searchParams.get('hub.challenge')||'';
        if(mode==='subscribe'&&cfg.verifyToken&&timingSafeStringEqual(token,cfg.verifyToken)){
          text(res,200,challenge);logger('meta-webhook-verified',null);return true;
        }
        text(res,403,'Forbidden');return true;
      }
      if(req.method==='POST'){
        try{
          if(!cfg.appSecret){text(res,503,'META_APP_SECRET_NOT_CONFIGURED');return true;}
          if(!sqliteReady){text(res,503,'META_STORAGE_NOT_READY');return true;}
          const raw=await readBody(req);
          const signature=req.headers['x-hub-signature-256'];
          if(!verifyMetaSignature(raw,signature,cfg.appSecret)){text(res,403,'INVALID_SIGNATURE');return true;}
          const payload=safeJson(raw.toString('utf8'));
          if(!payload){text(res,400,'INVALID_JSON');return true;}
          const stats=storePayload(payload);
          const events=Array.isArray(stats?.events)?stats.events:[];
          const publicStats={...stats};delete publicStats.events;
          logger('meta-webhook-event',{object:payload.object,entries:Array.isArray(payload.entry)?payload.entry.length:0,...publicStats,realtimeClients:realtimeClients.size});
          for(const event of events)publishRealtime(event.type==='meta-receipt'?'receipt':'message',event);
          text(res,200,'EVENT_RECEIVED');return true;
        }catch(error){logger('meta-webhook-error',error);text(res,Number(error?.statusCode||500),error?.message||'ERROR');return true;}
      }
      text(res,405,'Method Not Allowed');return true;
    }
    if(pathname==='/api/meta/db-events'&&req.method==='GET'){
      if(!auth(req)){json(res,401,{ok:false,error:'unauthorized'});return true;}
      lastDbDeltaClientAt=Date.now();
      const inboxId=requestedInbox(url);if(!inboxId){json(res,400,{ok:false,error:'invalid-inbox-id'});return true;}
      const after=String(url.searchParams.get('after')||'latest').trim();
      const limit=Math.max(1,Math.min(200,Number(url.searchParams.get('limit')||100)||100));
      // Advance the database cursor past non-matching messages too: no replay/stall.
      const delta=readDbDeltaEvents(after,limit);
      if(inboxId!=='all')delta.events=delta.events.filter(row=>matchesInbox(row,inboxId));
      json(res,200,{ok:true,...delta,realtimeVersion:'v0.9.11-no-facebook-profile-graph',recoveryWatchdog:{...recoveryWatchdogState,desktopActive:true,lastDbDeltaClientAt:new Date(lastDbDeltaClientAt).toISOString()}});return true;
    }
    if(pathname==='/api/meta/poll'&&req.method==='GET'){
      if(!auth(req)){json(res,401,{ok:false,error:'unauthorized'});return true;}
      const inboxId=requestedInbox(url);if(!inboxId){json(res,400,{ok:false,error:'invalid-inbox-id'});return true;}
      const afterRaw=String(url.searchParams.get('after')||'latest').trim().toLowerCase();
      const limit=Math.max(1,Math.min(200,Number(url.searchParams.get('limit')||100)||100));
      if(afterRaw==='latest'){json(res,200,{ok:true,events:[],latestSeq:realtimeSeq,realtimeVersion:'v0.9.5-long-poll'});return true;}
      const after=Math.max(0,Number(afterRaw)||0);const existing=realtimeEventsAfter(after,limit,inboxId);
      if(existing.length){json(res,200,{ok:true,events:existing,latestSeq:realtimeSeq,realtimeVersion:'v0.9.5-long-poll'});return true;}
      const timeoutMs=Math.max(1000,Math.min(30000,Number(url.searchParams.get('timeout')||25000)||25000));
      const waiter={req,res,after,limit,inboxId,done:false,timer:null};
      waiter.timer=setTimeout(()=>finishRealtimePoll(waiter,[]),timeoutMs);waiter.timer.unref?.();
      realtimePollWaiters.add(waiter);
      const cleanup=()=>{if(waiter.done)return;waiter.done=true;realtimePollWaiters.delete(waiter);try{clearTimeout(waiter.timer);}catch{}};
      req.on('aborted',cleanup);res.on('close',cleanup);return true;
    }
    if(pathname==='/api/meta/stream'&&req.method==='GET'){
      if(!auth(req)){json(res,401,{ok:false,error:'unauthorized'});return true;}
      const inboxId=requestedInbox(url);if(!inboxId){json(res,400,{ok:false,error:'invalid-inbox-id'});return true;}
      res.writeHead(200,{
        'content-type':'text/event-stream; charset=utf-8',
        'cache-control':'no-cache, no-store, no-transform',
        'connection':'keep-alive',
        'x-accel-buffering':'no',
        'access-control-allow-origin':'*',
        'access-control-allow-headers':'x-yoko-team-id,x-yoko-api-key'
      });
      res.socket?.setNoDelay?.(true);res.flushHeaders?.();
      realtimeClients.set(res,inboxId);ensureRealtimeHeartbeat();
      sseWrite(res,'ready',{type:'ready',service:'yoko-meta-realtime',version:'v0.9.5',at:new Date().toISOString(),latestSeq:realtimeSeq});try{res.write(': '+'.'.repeat(2048)+'\n\n');res.flush?.();}catch{}
      const cleanup=()=>{realtimeClients.delete(res);stopRealtimeHeartbeatIfIdle();};
      req.on('close',cleanup);req.on('aborted',cleanup);res.on('close',cleanup);
      return true;
    }
    if(pathname==='/api/meta/pages'&&req.method==='GET'){
      if(!auth(req)){json(res,401,{ok:false,error:'unauthorized'});return true;}
      await ensureLegacyPageRegistered();
      const rows=[...pagePool.values()].map(publicPage);
      if(!rows.length&&cfg.pageAccessToken){
        try{const me=await graphFetchWithToken(cfg.pageAccessToken,'me',{fields:'id,name'});rows.push({pageId:clean(me?.id,180),name:clean(me?.name,300)||'Legacy Facebook Page',enabled:true,tokenConfigured:true,legacy:true,updatedAt:''});}
        catch{rows.push({pageId:'',name:'Legacy Facebook Page',enabled:true,tokenConfigured:true,legacy:true,updatedAt:''});}
      }
      json(res,200,{ok:true,pages:rows,count:rows.length});return true;
    }
    if(pathname==='/api/meta/pages/upsert'&&req.method==='POST'){
      if(!auth(req)){json(res,401,{ok:false,error:'unauthorized'});return true;}
      try{
        const raw=await readBody(req,256*1024);const input=safeJson(raw.toString('utf8'))||{};
        const suppliedToken=clean(input.pageAccessToken||input.token,8000);const requestedId=clean(input.pageId,180);let current=requestedId?pagePool.get(requestedId):null;
        const token=suppliedToken||clean(current?.token,8000);if(!token){json(res,400,{ok:false,error:'page-access-token-required'});return true;}
        const me=await graphFetchWithToken(token,'me',{fields:'id,name'});const pageId=clean(me?.id,180);if(!pageId)throw new Error('meta-page-id-unavailable');
        if(requestedId&&requestedId!==pageId){json(res,409,{ok:false,error:'page-id-token-mismatch',expected:requestedId,actual:pageId});return true;}
        const row={pageId,name:clean(input.name,300)||clean(me?.name,300)||clean(current?.name,300),token,enabled:input.enabled!==false,updatedAt:new Date().toISOString()};
        pagePool.set(pageId,row);persistPageRegistry();
        refreshBackgroundWorkers();if(cfg.autoSubscribeEchoes){const t=setTimeout(()=>ensureWebhookSubscription().catch(()=>{}),20);t.unref?.();}
        json(res,200,{ok:true,page:publicPage(row),pages:[...pagePool.values()].map(publicPage)});return true;
      }catch(error){json(res,Number(error?.statusCode||500),{ok:false,error:error?.message||'page-upsert-failed',details:error?.details});return true;}
    }
    if(pathname==='/api/meta/pages/toggle'&&req.method==='POST'){
      if(!auth(req)){json(res,401,{ok:false,error:'unauthorized'});return true;}
      const raw=await readBody(req,128*1024);const input=safeJson(raw.toString('utf8'))||{};const pageId=clean(input.pageId,180);const row=pagePool.get(pageId);
      if(!row){json(res,404,{ok:false,error:'page-not-found'});return true;}row.enabled=input.enabled!==false;row.updatedAt=new Date().toISOString();pagePool.set(pageId,row);persistPageRegistry();refreshBackgroundWorkers();json(res,200,{ok:true,page:publicPage(row),pages:[...pagePool.values()].map(publicPage)});return true;
    }
    if(pathname==='/api/meta/pages/remove'&&req.method==='POST'){
      if(!auth(req)){json(res,401,{ok:false,error:'unauthorized'});return true;}
      const raw=await readBody(req,128*1024);const input=safeJson(raw.toString('utf8'))||{};const pageId=clean(input.pageId,180);const existed=pagePool.delete(pageId);persistPageRegistry();refreshBackgroundWorkers();json(res,200,{ok:true,removed:existed,pageId,pages:[...pagePool.values()].map(publicPage)});return true;
    }
    if(pathname==='/api/meta/health'&&req.method==='GET'){
      if(!auth(req)){json(res,401,{ok:false,error:'unauthorized'});return true;}
      await ensureLegacyPageRegistered();
      json(res,200,{
        ok:cfg.enabled&&sqliteReady,
        service:'yoko-meta-messenger-gateway',
        enabled:cfg.enabled,
        verifyTokenConfigured:!!cfg.verifyToken,
        appSecretConfigured:!!cfg.appSecret,
        pageAccessTokenConfigured:anyPageTokenConfigured(),
        pageCount:enabledPoolRows().length || (cfg.pageAccessToken?1:0),
        pages:enabledPoolRows().map(publicPage),
        graphVersion:cfg.graphVersion,
        storage:sqliteReady?'sqlite':'unavailable',
        databaseFile:dbFile,
        events:sqliteReady?Number(countEvents.get()?.count||0):0,
        historyConversations:sqliteReady?Number(countHistoryConversations?.get()?.count||0):0,
        autoReconcile:{
          enabled:cfg.enabled&&sqliteReady&&anyPageTokenConfigured()&&cfg.autoReconcileIntervalMs>0,
          intervalMs:cfg.autoReconcileIntervalMs,
          policy:'webhook-first-quick-fallback',
          ...autoSyncState
        },
        realtime:{...realtimeState,streamVersion:'v0.9.11-messaging-watchdog-no-profile-graph',streamClients:realtimeClients.size,webhookPages:[...lastWebhookAtByPage.entries()].map(([pageId,at])=>({pageId,lastWebhookAt:new Date(at).toISOString()})),recoveryWatchdog:{...recoveryWatchdogState,desktopActive:!!lastDbDeltaClientAt&&Date.now()-lastDbDeltaClientAt<=cfg.activeRecoveryDesktopTtlMs,lastDbDeltaClientAt:lastDbDeltaClientAt?new Date(lastDbDeltaClientAt).toISOString():''},profileBudget:{...profileBudgetState,negativeCacheEntries:profileNegativeUntil.size}},
        rateLimit:{
          app:{...appRateLimitState,backoffActive:Number(appRateLimitState.backoffUntil||0)>Date.now(),backoffRemainingMs:Math.max(0,Number(appRateLimitState.backoffUntil||0)-Date.now())},
          pages:[...pageRateLimitState.entries()].map(([pageId,state])=>({pageId,...state,backoffActive:Number(state.backoffUntil||0)>Date.now(),backoffRemainingMs:Math.max(0,Number(state.backoffUntil||0)-Date.now())}))
        },
        pageSync:[...pageSyncState.entries()].map(([pageId,state])=>({pageId,...state})),
        messageEchoSubscription:{...echoSubscriptionState},
        time:new Date().toISOString()
      });
      return true;
    }
    if(pathname==='/api/meta/events/recent'&&req.method==='GET'){
      if(!auth(req)){json(res,401,{ok:false,error:'unauthorized'});return true;}
      if(!sqliteReady){json(res,503,{ok:false,error:'meta-storage-unavailable'});return true;}
      const limit=Math.max(1,Math.min(200,Number(url.searchParams.get('limit')||50)||50));
      const rows=listRecent.all(limit).map(row=>({...row,payload:safeJson(row.payloadJson),payloadJson:undefined}));
      json(res,200,{ok:true,items:rows,count:rows.length});return true;
    }
    if(pathname==='/api/meta/conversations'&&req.method==='GET'){
      if(!auth(req)){json(res,401,{ok:false,error:'unauthorized'});return true;}
      if(!sqliteReady){json(res,503,{ok:false,error:'meta-storage-unavailable'});return true;}
      const limit=Math.max(1,Math.min(500,Number(url.searchParams.get('limit')||200)||200));
      const rows=listConversations.all(limit).map(row=>({...row,pageName:clean(pagePool.get(clean(row.pageId,180))?.name,300),messageCount:Number(row.messageCount||0),lastTimestampMs:Number(row.lastTimestampMs||0),lastIncomingAt:Number(row.lastIncomingAt||0),firstIncomingAt:Number(row.firstIncomingAt||0),lastReplyAt:Number(row.lastReplyAt||0)}));
      json(res,200,{ok:true,items:rows,count:rows.length});return true;
    }
    if(pathname==='/api/meta/conversation'&&req.method==='GET'){
      if(!auth(req)){json(res,401,{ok:false,error:'unauthorized'});return true;}
      if(!sqliteReady){json(res,503,{ok:false,error:'meta-storage-unavailable'});return true;}
      const pageId=clean(url.searchParams.get('pageId'),180);
      const peerId=clean(url.searchParams.get('peerId'),180);
      if(!pageId||!peerId){json(res,400,{ok:false,error:'pageId-and-peerId-required'});return true;}
      const limit=Math.max(1,Math.min(500,Number(url.searchParams.get('limit')||200)||200));
      const beforeTimestampMs=Math.max(0,Number(url.searchParams.get('beforeTimestampMs')||0)||0);
      const beforeReceivedAt=clean(url.searchParams.get('beforeReceivedAt'),120);
      const beforeEventKey=clean(url.searchParams.get('beforeEventKey'),500);
      const history=beforeTimestampMs?null:await ensureHistoryConversation(pageId,peerId,Math.min(100,limit));
      const rawRows=beforeTimestampMs&&beforeReceivedAt&&beforeEventKey
        ? listConversationBefore.all(pageId,peerId,peerId,beforeTimestampMs,beforeTimestampMs,beforeReceivedAt,beforeTimestampMs,beforeReceivedAt,beforeEventKey,limit)
        : listConversation.all(pageId,peerId,peerId,limit);
      const receipts=listConversationReceipts.all(pageId,peerId);
      const deliveryIds=new Set();let readWatermark=0,readAt=0,deliveryWatermark=0,readReceiptCount=0,deliveryReceiptCount=0;
      for(const receipt of receipts){
        const data=safeJson(receipt.payloadJson)||{};
        if(receipt.eventType==='read'){readReceiptCount++;
          const watermark=metaEpochMs(data?.read?.watermark);
          if(Number.isFinite(watermark)&&watermark>readWatermark){readWatermark=watermark;readAt=Number(receipt.timestampMs)||0;}
        } else if(receipt.eventType==='delivery'){deliveryReceiptCount++;
          const mids=Array.isArray(data?.delivery?.mids)?data.delivery.mids:[];
          for(const mid of mids)if(typeof mid==='string'&&mid.length<=500)deliveryIds.add(mid);
          const watermark=metaEpochMs(data?.delivery?.watermark);
          if(Number.isFinite(watermark)&&watermark>deliveryWatermark)deliveryWatermark=watermark;
        }
      }
      // A read watermark proves messages at or before that timestamp were read;
      // absent receipts must never be interpreted as unread.
      const rows=rawRows.map(row=>{
        const mine=row.direction==='outgoing';const sentAt=metaEpochMs(row.timestampMs);
        const delivered=mine&&((row.messageId&&deliveryIds.has(row.messageId))||(deliveryWatermark>0&&sentAt>0&&sentAt<=deliveryWatermark));
        const read=mine&&readWatermark>0&&sentAt>0&&sentAt<=readWatermark;
        return {...row,payload:safeJson(row.payloadJson),payloadJson:undefined,
          deliveryStatus:!mine?'':read?'read':delivered?'delivered':'unknown',
          readAtMs:read?readAt:0};
      });
      const oldest=rows[0]||null;
      const nextCursor=oldest?{beforeTimestampMs:Number(oldest.timestampMs||0),beforeReceivedAt:clean(oldest.receivedAt,120),beforeEventKey:clean(oldest.eventKey,500)}:null;
      const receiptDiagnostics={readReceiptCount,deliveryReceiptCount,readWatermarkMs:readWatermark,deliveryWatermarkMs:deliveryWatermark,latestReadEventAtMs:readAt,matchedReadMessages:rows.filter(r=>r.deliveryStatus==='read').length,matchedDeliveredMessages:rows.filter(r=>r.deliveryStatus==='delivered').length,outgoingMessages:rows.filter(r=>r.direction==='outgoing').length};
      json(res,200,{ok:true,pageId,peerId,items:rows,count:rows.length,history,hasMore:rows.length===limit,nextCursor,receiptDiagnostics});return true;
    }
    if(pathname==='/api/meta/history-sync'&&req.method==='POST'){
      if(!auth(req)){json(res,401,{ok:false,error:'unauthorized'});return true;}
      try{
        const raw=await readBody(req,256*1024);const input=safeJson(raw.toString('utf8'))||{};
        const result=await runHistoryReconcile('manual',{conversationLimit:Number(input?.conversationLimit||1000),messageLimit:Number(input?.messageLimit||60)});
        json(res,200,result);return true;
      }catch(error){json(res,Number(error?.statusCode||500),{ok:false,error:error?.message||'meta-history-sync-failed',details:error?.details});return true;}
    }
    if(pathname==='/api/meta/profile'&&req.method==='GET'){
      if(!auth(req)){json(res,401,{ok:false,error:'unauthorized'});return true;}
      try{
        const userId=clean(url.searchParams.get('userId'),180);
        if(!userId){json(res,400,{ok:false,error:'userId-required'});return true;}
        const pageId=clean(url.searchParams.get('pageId'),180);
        const result=await apiProfile(userId,pageId);
        json(res,200,{ok:true,result});return true;
      }catch(error){logger('meta-profile-error',error);json(res,Number(error?.statusCode||500),{ok:false,error:error?.message||'profile-failed',details:error?.details});return true;}
    }
    if(pathname==='/api/meta/send-media/facebook'&&req.method==='POST'){
      if(!auth(req)){json(res,401,{ok:false,error:'unauthorized'});return true;}
      try{
        const raw=await readBody(req,12*1024*1024),input=safeJson(raw.toString('utf8'));
        if(!input){json(res,400,{ok:false,error:'invalid-json'});return true;}
        const recipientId=clean(input.recipientId,180),requestedPageId=clean(input.pageId,180);
        if(!recipientId){json(res,400,{ok:false,error:'recipientId-required'});return true;}
        const historyKnown=requestedPageId?findHistoryConversation?.get(requestedPageId,recipientId):null;
        const eventKnown=requestedPageId?knownPeerForPage?.get(requestedPageId,recipientId,recipientId):null;
        if(requestedPageId&&!historyKnown&&!eventKnown){json(res,409,{ok:false,error:'meta-recipient-not-in-inbox'});return true;}
        const pageId=requestedPageId||clean(findPageForPeer?.get(recipientId,recipientId)?.pageId,180);
        const result=await apiSendFacebookImage(recipientId,pageId,input);
        const stored=persistOutgoingText(recipientId,String(input.mime||'').startsWith('image/')?'［图片］':'［文件］ '+clean(input.name,120),result,pageId);
        json(res,200,{ok:true,result,stored});return true;
      }catch(error){logger('meta-send-facebook-media-error',{message:error?.message,details:error?.details});json(res,Number(error?.statusCode||500),{ok:false,error:error?.message||'send-media-failed',details:error?.details});return true;}
    }
    if(pathname==='/api/meta/send/facebook'&&req.method==='POST'){
      if(!auth(req)){json(res,401,{ok:false,error:'unauthorized'});return true;}
      try{
        const raw=await readBody(req,256*1024);const input=safeJson(raw.toString('utf8'));
        if(!input){json(res,400,{ok:false,error:'invalid-json'});return true;}
        const recipientId=clean(input.recipientId,180);const messageText=clean(input.text,20000);const requestedPageId=clean(input.pageId,180);
        if(!recipientId||!messageText){json(res,400,{ok:false,error:'recipientId-and-text-required'});return true;}
        const historyKnown=requestedPageId?findHistoryConversation?.get(requestedPageId,recipientId):null;
        const eventKnown=requestedPageId?knownPeerForPage?.get(requestedPageId,recipientId,recipientId):null;
        if(requestedPageId&&!historyKnown&&!eventKnown){json(res,409,{ok:false,error:'meta-recipient-not-in-inbox',message:'Facebook 客户身份已过期，请刷新官方 API 收件箱后重新选择客户。'});return true;}
        const pageId=requestedPageId||clean(findPageForPeer?.get(recipientId,recipientId)?.pageId,180)||clean(historyKnown?.pageId,180);
        const result=await apiSendFacebook(recipientId,messageText,pageId);
        const stored=persistOutgoingText(recipientId,messageText,result,pageId);
        json(res,200,{ok:true,result,stored});return true;
      }catch(error){logger('meta-send-facebook-error',error);json(res,Number(error?.statusCode||500),{ok:false,error:error?.message||'send-failed',details:error?.details});return true;}
    }
    return false;
  };

  const refreshBackgroundWorkers=()=>{
    const active=cfg.enabled&&sqliteReady&&anyPageTokenConfigured();
    if(!active){
      try{if(autoReconcileStartupTimer)clearTimeout(autoReconcileStartupTimer);}catch{}autoReconcileStartupTimer=null;
      try{if(autoReconcileTimer)clearInterval(autoReconcileTimer);}catch{}autoReconcileTimer=null;
      try{if(subscriptionRefreshTimer)clearInterval(subscriptionRefreshTimer);}catch{}subscriptionRefreshTimer=null;
      try{if(activeRecoveryWatchdogTimer)clearInterval(activeRecoveryWatchdogTimer);}catch{}activeRecoveryWatchdogTimer=null;
      return false;
    }
    if(cfg.autoSubscribeEchoes&&!subscriptionRefreshTimer){
      const firstSubscriptionDelay=Math.min(cfg.autoReconcileStartupDelayMs,5000);
      const t=setTimeout(()=>ensureWebhookSubscription().catch(()=>{}),firstSubscriptionDelay);t.unref?.();
      subscriptionRefreshTimer=setInterval(()=>ensureWebhookSubscription().catch(()=>{}),15*60*1000);subscriptionRefreshTimer.unref?.();
    }
    if(cfg.autoReconcileIntervalMs>0&&!autoReconcileTimer){
      autoReconcileStartupTimer=setTimeout(()=>runHistoryReconcile('startup').catch(()=>{}),cfg.autoReconcileStartupDelayMs);autoReconcileStartupTimer.unref?.();
      autoReconcileTimer=setInterval(()=>{if(anyPageTokenConfigured())runHistoryReconcile('auto').catch(()=>{});},cfg.autoReconcileIntervalMs);autoReconcileTimer.unref?.();
    }
    if(cfg.activeRecoveryProbeIntervalMs>0&&!activeRecoveryWatchdogTimer){
      activeRecoveryWatchdogTimer=setInterval(()=>{runActiveRecoveryWatchdog().catch(()=>{});},cfg.activeRecoveryProbeIntervalMs);
      activeRecoveryWatchdogTimer.unref?.();
    }
    return true;
  };
  refreshBackgroundWorkers();

  // R54: fail-closed, strictly page-bound Graph revalidation for ONE authorized test.
  // Uses read-only Graph GET; never runs the multi-Page history sync.
  const r54VerifySingleCustomer=async(page,peer,expectedSourceMessageId)=>{
    if(page!=='1349998201533172'||peer!=='40032465993018581')throw Error('r54-target-denied');
    const row=pagePool.get(page);
    if(!row||row.enabled===false||!row.token||row.legacy||clean(row.pageId,180)!==page)
      throw Error('r54-strict-page-token-unavailable');
    const conv=findHistoryConversation?.get(page,peer);
    if(!conv?.conversationId)throw Error('r54-conversation-unavailable');
    const expected=clean(expectedSourceMessageId,300).replace(/^facebook:message:/,'').replace(/^message:/,'');
    if(!expected)throw Error('r54-source-id-missing');
    // A single conversation only. If Graph cannot supply a trustworthy recent window, deny.
    const fields='id,messages.limit(50){id,created_time,from,to}';
    const result=await graphFetchWithToken(row.token,conv.conversationId,{fields});
    if(clean(result?.id,500)!==clean(conv.conversationId,500))throw Error('r54-graph-conversation-mismatch');
    const messages=result?.messages?.data;
    if(!Array.isArray(messages)||!messages.length)throw Error('r54-graph-messages-unavailable');
    const ordered=messages.map(m=>({
      id:clean(m?.id,300),from:clean(m?.from?.id,180),
      at:Date.parse(String(m?.created_time||''))
    }));
    if(ordered.some(m=>!m.id||!Number.isFinite(m.at)||!m.from))throw Error('r54-graph-message-incomplete');
    ordered.sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id));
    const newest=ordered[0];
    if(newest.from!==peer||newest.id!==expected)throw Error('r54-graph-newer-or-outgoing-message');
    const age=Date.now()-newest.at;
    if(age<0||age>=24*60*60*1000)throw Error('r54-graph-outside-24h-window');
    // The visible Graph page must include the exact source; no fallback to cached SQLite.
    if(!ordered.some(m=>m.id===expected&&m.from===peer))throw Error('r54-source-not-in-graph');
    return true;
  };

  // R55: fail closed for every individually approved Auto Page. No legacy token,
  // no multi-Page scan, and no delivery if a new incoming or human outgoing exists.
  const r55VerifyAutoCustomer=async(page,peer,expectedSourceMessageId)=>{
    if(!/^\d{5,30}$/.test(page)||!/^\d{5,30}$/.test(peer))throw Error('r55-target-invalid');
    const row=pagePool.get(page);
    if(!row||row.enabled===false||row.legacy||!row.token||row.pageId!==page)
      throw Error('r55-strict-page-token-unavailable');
    const conv=findHistoryConversation?.get(page,peer);
    if(!conv?.conversationId)throw Error('r55-conversation-unavailable');
    const expected=clean(expectedSourceMessageId,300).replace(/^facebook:message:/,'').replace(/^message:/,'');
    if(!expected)throw Error('r55-source-id-missing');
    const result=await graphFetchWithToken(row.token,conv.conversationId,
      {fields:'id,messages.limit(50){id,created_time,from,to}'});
    if(clean(result?.id,500)!==clean(conv.conversationId,500))throw Error('r55-conversation-mismatch');
    const messages=result?.messages?.data;
    if(!Array.isArray(messages)||!messages.length)throw Error('r55-messages-unavailable');
    const ordered=messages.map(m=>({id:clean(m?.id,300),from:clean(m?.from?.id,180),at:Date.parse(String(m?.created_time||''))}));
    if(ordered.some(m=>!m.id||!m.from||!Number.isFinite(m.at)))throw Error('r55-message-incomplete');
    ordered.sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id));
    if(ordered[0].from!==peer||ordered[0].id!==expected)throw Error('r55-newer-or-outgoing-message');
    // Meta timestamps are not guaranteed to uniquely order messages. A different
    // message at the exact source timestamp could be a later human reply; fail closed.
    if(ordered.some(m=>m.id!==expected&&m.at>=ordered[0].at))throw Error('r55-ambiguous-message-order');
    const age=Date.now()-ordered[0].at;
    if(age<0||age>=24*3600*1000)throw Error('r55-outside-24h-window');
    return true;
  };

  // R20: reuse the existing official Meta sender; never expose page tokens.
  // Caller must have an authorized, server-side AI delivery claim.
  const sendAiText=async({pageId,recipientId,text:messageText,r54SingleCustomerTest=false,r55AutoReply=false,expectedSourceMessageId=""}={})=>{
    const page=clean(pageId,180),peer=clean(recipientId,180),message=clean(messageText,20000);
    if(!page||!peer||!message)throw new Error('ai-send-invalid-recipient-or-text');
    if(!findHistoryConversation?.get(page,peer)&&!knownPeerForPage?.get(page,peer,peer))throw new Error('meta-recipient-not-in-inbox');
    if(r54SingleCustomerTest||r55AutoReply){
      if(r54SingleCustomerTest)await r54VerifySingleCustomer(page,peer,expectedSourceMessageId);
      else await r55VerifyAutoCustomer(page,peer,expectedSourceMessageId);
      const strictRow=pagePool.get(page);
      if(!strictRow||strictRow.enabled===false||strictRow.legacy||!strictRow.token||strictRow.pageId!==page)
        throw Error('r54-strict-page-token-unavailable');
      const response=await fetch(`https://graph.facebook.com/${cfg.graphVersion}/${encodeURIComponent(page)}/messages`,{
        method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${strictRow.token}`},
        body:JSON.stringify({recipient:{id:peer},message:{text:message},messaging_type:'RESPONSE'})
      });
      if(!response.ok)throw Error('r54-meta-provider-rejected');
      const result=safeJson(await response.text())||{};
      const providerMessageId=clean(result?.message_id||result?.messageId,180);
      if(!providerMessageId)throw Error('meta-send-missing-message-id');
      persistOutgoingText(peer,message,result,page);
      return {providerMessageId};
    }
    const result=await apiSendFacebook(peer,message,page);
    const providerMessageId=clean(result?.message_id||result?.messageId,180);
    if(!providerMessageId)throw new Error('meta-send-missing-message-id');
    persistOutgoingText(peer,message,result,page);
    return {providerMessageId};
  };
  return {
    handle,
    sendAiText,
    status:()=>({
      enabled:cfg.enabled,verifyTokenConfigured:!!cfg.verifyToken,appSecretConfigured:!!cfg.appSecret,pageAccessTokenConfigured:anyPageTokenConfigured(),pageCount:enabledPoolRows().length||(cfg.pageAccessToken?1:0),pages:enabledPoolRows().map(publicPage),
      sqliteReady,databaseFile:dbFile,graphVersion:cfg.graphVersion,
      autoReconcile:{enabled:cfg.autoReconcileIntervalMs>0,intervalMs:cfg.autoReconcileIntervalMs,policy:'webhook-first-quick-fallback',...autoSyncState},
      realtime:{...realtimeState,streamVersion:'v0.9.11-messaging-watchdog-no-profile-graph',streamClients:realtimeClients.size,webhookPages:[...lastWebhookAtByPage.entries()].map(([pageId,at])=>({pageId,lastWebhookAt:new Date(at).toISOString()})),recoveryWatchdog:{...recoveryWatchdogState,desktopActive:!!lastDbDeltaClientAt&&Date.now()-lastDbDeltaClientAt<=cfg.activeRecoveryDesktopTtlMs,lastDbDeltaClientAt:lastDbDeltaClientAt?new Date(lastDbDeltaClientAt).toISOString():''},profileBudget:{...profileBudgetState,negativeCacheEntries:profileNegativeUntil.size}},
      rateLimit:{
          app:{...appRateLimitState,backoffActive:Number(appRateLimitState.backoffUntil||0)>Date.now(),backoffRemainingMs:Math.max(0,Number(appRateLimitState.backoffUntil||0)-Date.now())},
          pages:[...pageRateLimitState.entries()].map(([pageId,state])=>({pageId,...state,backoffActive:Number(state.backoffUntil||0)>Date.now(),backoffRemainingMs:Math.max(0,Number(state.backoffUntil||0)-Date.now())}))
        },
      pageSync:[...pageSyncState.entries()].map(([pageId,state])=>({pageId,...state})),
      messageEchoSubscription:{...echoSubscriptionState}
    }),
    close:()=>{
      try{if(autoReconcileStartupTimer)clearTimeout(autoReconcileStartupTimer);}catch{}
      try{if(autoReconcileTimer)clearInterval(autoReconcileTimer);}catch{}
      try{if(subscriptionRefreshTimer)clearInterval(subscriptionRefreshTimer);}catch{}
      try{if(activeRecoveryWatchdogTimer)clearInterval(activeRecoveryWatchdogTimer);}catch{}
      try{if(realtimeHeartbeatTimer)clearInterval(realtimeHeartbeatTimer);}catch{}realtimeHeartbeatTimer=null;
      for(const res of [...realtimeClients]){try{res.end();}catch{}}realtimeClients.clear();for(const waiter of [...realtimePollWaiters])finishRealtimePoll(waiter,[]);
      try{sqlite?.exec('PRAGMA optimize;');}catch{}try{sqlite?.close();}catch{}
    }
  };
}
module.exports={createMetaMessengerGateway,verifyMetaSignature};
