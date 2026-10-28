'use strict';
const http=require('http');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const { text, lineIdentityAliases }=require('./team-sync-core');
const { normalizeNodeCapabilities, dynamicRoleLabel }=require('./team-node-roles');
const { createMetaMessengerGateway }=require('./meta-messenger-gateway');
const { createLineMessagingGateway }=require('./line-messaging-gateway');
const { createAiService }=require('./ai-service-module');

function safeJson(body='') { try { return JSON.parse(body||'{}'); } catch { return null; } }
function serverStoreDefault(){ return {version:2,devices:{},customers:{},customerProfiles:{},workspaceSettings:{},tasks:{},deletedTasks:{},updatedAt:''}; }
function mergeOrigins(a=[],b=[]){
  const out=[];const seen=new Set();
  for(const row of [...(Array.isArray(a)?a:[]),...(Array.isArray(b)?b:[])]){
    if(!row||typeof row!=='object')continue;
    const platform=text(row.platform||row.sourcePlatform,30).toLowerCase();
    if(!platform)continue;
    const accountId=text(row.accountId||row.sourceAccountId,128);
    const handle=text(row.handle||row.sourceHandle,180).replace(/^@+/, '');
    const chatId=text(row.chatId||row.sourceChatId,300);
    const displayName=text(row.displayName||row.sourceDisplayName,180);
    const key=`${platform}|${accountId}|${handle||chatId||displayName.toLocaleLowerCase()}`;
    if(seen.has(key))continue;seen.add(key);
    out.push({platform,accountId,accountName:text(row.accountName||row.sourceAccountName,160),chatId,displayName,handle,linkedAt:text(row.linkedAt,80)});
  }
  return out.slice(-12);
}
function mergeTokens(a='',b='',max=400){
  const out=[];const seen=new Set();
  for(const part of `${text(a,max)}，${text(b,max)}`.split(/[,，、;；/\n]+/)){const v=text(part,120);const k=v.toLocaleLowerCase();if(!v||seen.has(k))continue;seen.add(k);out.push(v);}
  return out.join('，').slice(0,max);
}
function mergeMemory(a=[],b=[]){
  const out=[];const seen=new Set();
  for(const row of [...(Array.isArray(a)?a:[]),...(Array.isArray(b)?b:[])]){const t=text(row?.text,260);const key=`${text(row?.type,40)}|${t}`.toLocaleLowerCase();if(!t||seen.has(key))continue;seen.add(key);out.push({...row,text:t});}
  return out.slice(-80);
}
function mergeCustomerSnapshot(prior,incoming,now){
  if(!prior)return {...incoming,serverUpdatedAt:now};
  const newer=String(incoming?.updatedAt||'')>=String(prior?.updatedAt||'');
  const base=newer?{...prior,...incoming}:{...incoming,...prior};
  for(const field of ['name','region','age','occupation','interests','note','summary','memorySummary','language']){
    const preferred=newer?incoming?.[field]:prior?.[field]; const fallback=newer?prior?.[field]:incoming?.[field];
    base[field]=text(preferred,field==='note'?4000:(field==='summary'||field==='memorySummary'?1600:600))||text(fallback,field==='note'?4000:(field==='summary'||field==='memorySummary'?1600:600));
  }
  base.tags=mergeTokens(prior?.tags,incoming?.tags,400);
  base.memoryItems=mergeMemory(prior?.memoryItems,incoming?.memoryItems);
  base.origins=mergeOrigins(prior?.origins,incoming?.origins);
  if((!Array.isArray(base.sourceRecentMessages)||!base.sourceRecentMessages.length)){
    base.sourceRecentMessages=(Array.isArray(incoming?.sourceRecentMessages)&&incoming.sourceRecentMessages.length?incoming.sourceRecentMessages:prior?.sourceRecentMessages)||[];
  }
  base.globalCustomerId=text(incoming?.globalCustomerId||prior?.globalCustomerId,120);
  base.serverUpdatedAt=now;
  return base;
}
function createTeamSyncServer({port=17891,host='127.0.0.1',teamId='',apiKey='',dataFile='',translationCacheFile='',translationCacheDbFile='',translationGateway={},metaMessaging={},lineMessaging={},logger=()=>{}}={}) {
  let store=serverStoreDefault();
  const file=dataFile?path.resolve(dataFile):'';
  if(file){ try{ const parsed=JSON.parse(fs.readFileSync(file,'utf8')); if(parsed&&typeof parsed==='object')store={...serverStoreDefault(),...parsed}; }catch{} }
  // V1.27.48: production shared translation cache uses SQLite rather than a
  // monolithic JSON file. This keeps lookup O(1) via the primary-key hash index,
  // makes each store an incremental transaction instead of rewriting the entire
  // cache, and lets the VPS retain hundreds of thousands of original+translated
  // pairs without making normal team-sync saves heavier.
  const legacyTranslationCache=store.translationCache&&typeof store.translationCache==='object'?store.translationCache:{};
  if(Object.prototype.hasOwnProperty.call(store,'translationCache'))delete store.translationCache;
  const legacyCacheFile=translationCacheFile?path.resolve(translationCacheFile):(file?path.join(path.dirname(file),'translation-cache.json'):'');
  const defaultDbFile=legacyCacheFile?legacyCacheFile.replace(/\.json$/i,'')+'.sqlite':(file?path.join(path.dirname(file),'translation-cache.sqlite'):'');
  const cacheDbFile=translationCacheDbFile?path.resolve(translationCacheDbFile):defaultDbFile;
  const tg={
    enabled:translationGateway?.enabled!==false,
    cacheMax:Math.max(10000,Math.min(1000000,Number(translationGateway?.cacheMax||500000)||500000))
  };
  // VPS v0.11.1 / YokoSCRM V1.27.131: one server-side DeepL credential serves all desktop clients.
  // The credential never leaves the VPS and is never emitted by health or translation responses.
  // Desktop clients authenticate only to this Team VPS; provider calls are incoming-message only.
  const deeplTranslation={
    apiKey:String(process.env.YOKO_DEEPL_API_KEY||translationGateway?.deeplApiKey||'').trim().slice(0,2048),
    endpoint:String(process.env.YOKO_DEEPL_ENDPOINT||translationGateway?.deeplEndpoint||'https://api.deepl.com/v2/translate').trim().slice(0,2048),
    timeoutMs:Math.max(1500,Math.min(20000,Number(process.env.YOKO_DEEPL_TIMEOUT_MS||translationGateway?.deeplTimeoutMs||7000)||7000))
  };
  const deeplProviderStats={calls:0,items:0,characters:0,errors:0,lastAt:'',lastOkAt:'',lastErrorAt:'',lastLatencyMs:0,dedupeWaits:0,maxInFlight:0};
  const deeplTranslationInFlight=new Map();
  const deeplProviderReady=()=>!!(tg.enabled&&deeplTranslation.apiKey&&/^https?:\/\//i.test(deeplTranslation.endpoint));
  const normalizeTranslationText=(value,max)=>String(value??'').replace(/\u0000/g,'').replace(/\r\n?/g,'\n').trim().slice(0,max);
  const normalizeLanguage=(value,fallback)=>text(value,20).toLowerCase().replace('_','-')||fallback;
  const canonicalSourceLanguage=(value='auto',sourceText='')=>{
    const raw=normalizeLanguage(value,'auto');
    const aliases={jp:'ja',jpn:'ja',cn:'zh',zhcn:'zh','zh-cn':'zh','zh-tw':'zh',eng:'en',kr:'ko',kor:'ko'};
    const normalized=aliases[raw]||raw;
    if(normalized!=='auto'&&normalized!=='detect'&&normalized!=='und')return normalized;
    const source=normalizeTranslationText(sourceText,12000);
    if(/[ぁ-ゖァ-ヺー]/u.test(source))return 'ja';
    if(/[가-힣]/u.test(source))return 'ko';
    if(/[\u0400-\u04ff]/u.test(source))return 'ru';
    if(/[\u0600-\u06ff]/u.test(source))return 'ar';
    if(/[\u0e00-\u0e7f]/u.test(source))return 'th';
    if(/[\u3400-\u9fff]/u.test(source))return 'zh';
    const latin=(source.match(/[A-Za-z]/g)||[]).length;
    const letters=(source.match(/[A-Za-zÀ-ÿ]/g)||[]).length;
    if(latin>=2&&latin>=letters*0.75)return 'en';
    return 'auto';
  };
  const translationKey=(item={})=>crypto.createHash('sha256').update([
    'yoko-shared-cache-v2-lang-canonical',
    canonicalSourceLanguage(item.source,item.text),
    normalizeLanguage(item.target,'zh'),
    normalizeTranslationText(item.text,12000)
  ].join('\u001f')).digest('hex');

  let sqlite=null;
  let sqliteStorage='sqlite';
  if(cacheDbFile){
    try{
      const {DatabaseSync}=require('node:sqlite');
      fs.mkdirSync(path.dirname(cacheDbFile),{recursive:true});
      sqlite=new DatabaseSync(cacheDbFile);
      sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=5000;');
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS translation_cache (
          hash TEXT PRIMARY KEY,
          source_text TEXT NOT NULL,
          translated_text TEXT NOT NULL,
          source_lang TEXT NOT NULL,
          target_lang TEXT NOT NULL,
          engine TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_hit_at TEXT,
          hit_count INTEGER NOT NULL DEFAULT 0
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_translation_cache_updated_at ON translation_cache(updated_at);
        CREATE INDEX IF NOT EXISTS idx_translation_cache_last_hit_at ON translation_cache(last_hit_at);
        CREATE TABLE IF NOT EXISTS translation_cache_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) WITHOUT ROWID;
      `);
    }catch(error){
      sqliteStorage='unavailable';
      logger('translation-cache-sqlite-open-error',error);
    }
  }
  const dbSelect=sqlite?.prepare('SELECT translated_text, engine, created_at, updated_at, hit_count FROM translation_cache WHERE hash=?');
  const dbInsert=sqlite?.prepare(`INSERT INTO translation_cache(hash,source_text,translated_text,source_lang,target_lang,engine,created_at,updated_at,last_hit_at,hit_count)
    VALUES(?,?,?,?,?,?,?,?,NULL,0)
    ON CONFLICT(hash) DO UPDATE SET
      source_text=excluded.source_text,
      translated_text=excluded.translated_text,
      source_lang=excluded.source_lang,
      target_lang=excluded.target_lang,
      engine=CASE WHEN excluded.engine<>'' THEN excluded.engine ELSE translation_cache.engine END,
      updated_at=excluded.updated_at`);
  const dbTouch=sqlite?.prepare('UPDATE translation_cache SET last_hit_at=?, hit_count=hit_count+1 WHERE hash=?');
  const dbCount=sqlite?.prepare('SELECT COUNT(*) AS count FROM translation_cache');
  const dbMetaGet=sqlite?.prepare('SELECT value FROM translation_cache_meta WHERE key=?');
  const dbMetaSet=sqlite?.prepare('INSERT INTO translation_cache_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  let cacheCount=sqlite?Number(dbCount.get()?.count||0):0;


  // V1.27.254 / VPS v0.9.16 — preserve GPT Lite Stage 3 and add SQLite inbox index acceleration.
  // Keep high-churn ChatGPT workflow state out of the desktop config hot path.
  // The server stores only bounded JSON state (bindings / receipts / Day state),
  // never ChatGPT cookies, session storage, passwords or page HTML.
  const gptOrchestratorDbFile=file?path.join(path.dirname(file),'gpt-orchestrator.sqlite'):'';
  let gptSqlite=null;
  let gptStorage='sqlite';
  try{
    if(gptOrchestratorDbFile){
      const {DatabaseSync}=require('node:sqlite');
      fs.mkdirSync(path.dirname(gptOrchestratorDbFile),{recursive:true});
      gptSqlite=new DatabaseSync(gptOrchestratorDbFile);
      gptSqlite.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=5000;');
      gptSqlite.exec(`
        CREATE TABLE IF NOT EXISTS gpt_orchestrator_state (
          scope TEXT NOT NULL,
          state_key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          writer_device_id TEXT NOT NULL DEFAULT '',
          PRIMARY KEY(scope,state_key)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_gpt_orchestrator_updated_at ON gpt_orchestrator_state(updated_at);
      `);
    }
  }catch(error){
    gptStorage='unavailable';
    logger('gpt-orchestrator-sqlite-open-error',error);
  }
  const gptGetStmt=gptSqlite?.prepare('SELECT state_key,value_json,updated_at,writer_device_id FROM gpt_orchestrator_state WHERE scope=? AND state_key=?');
  const gptPutStmt=gptSqlite?.prepare(`INSERT INTO gpt_orchestrator_state(scope,state_key,value_json,updated_at,writer_device_id)
    VALUES(?,?,?,?,?)
    ON CONFLICT(scope,state_key) DO UPDATE SET
      value_json=excluded.value_json,
      updated_at=excluded.updated_at,
      writer_device_id=excluded.writer_device_id
    WHERE excluded.updated_at>=gpt_orchestrator_state.updated_at`);
  const gptCountStmt=gptSqlite?.prepare('SELECT COUNT(*) AS count FROM gpt_orchestrator_state');
  if(gptSqlite){
    gptSqlite.exec(`
      CREATE TABLE IF NOT EXISTS gpt_customer_context (
        scope TEXT NOT NULL,
        target_key TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        history_index_json TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL,
        writer_device_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(scope,target_key)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_gpt_customer_context_updated_at ON gpt_customer_context(updated_at);
      CREATE TABLE IF NOT EXISTS gpt_task_queue (
        scope TEXT NOT NULL,
        task_id TEXT NOT NULL,
        target_key TEXT NOT NULL DEFAULT '',
        task_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'queued',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        writer_device_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(scope,task_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_gpt_task_queue_status_updated ON gpt_task_queue(scope,status,updated_at);
    `);
  }
  const gptContextGetStmt=gptSqlite?.prepare('SELECT target_key,snapshot_json,history_index_json,updated_at,writer_device_id FROM gpt_customer_context WHERE scope=? AND target_key=?');
  const gptContextPutStmt=gptSqlite?.prepare(`INSERT INTO gpt_customer_context(scope,target_key,snapshot_json,history_index_json,updated_at,writer_device_id)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(scope,target_key) DO UPDATE SET
      snapshot_json=excluded.snapshot_json,
      history_index_json=excluded.history_index_json,
      updated_at=excluded.updated_at,
      writer_device_id=excluded.writer_device_id
    WHERE excluded.updated_at>=gpt_customer_context.updated_at`);
  const gptContextCountStmt=gptSqlite?.prepare('SELECT COUNT(*) AS count FROM gpt_customer_context');
  const gptContextRecentStmt=gptSqlite?.prepare('SELECT target_key,snapshot_json,history_index_json,updated_at,writer_device_id FROM gpt_customer_context WHERE scope=? ORDER BY updated_at DESC LIMIT ?');
  const gptContextPruneStmt=gptSqlite?.prepare('DELETE FROM gpt_customer_context WHERE scope=? AND target_key NOT IN (SELECT target_key FROM gpt_customer_context WHERE scope=? ORDER BY updated_at DESC LIMIT ?)');
  const gptTaskPruneStmt=gptSqlite?.prepare("DELETE FROM gpt_task_queue WHERE scope=? AND status IN ('done','failed','cancelled') AND updated_at<?");
  let gptMaintenanceWrites=0;
  const gptRunMaintenance=(scope='')=>{
    if(!gptSqlite||!scope)return;
    gptMaintenanceWrites+=1;if(gptMaintenanceWrites%32!==0)return;
    try{gptContextPruneStmt?.run(scope,scope,600);gptTaskPruneStmt?.run(scope,Date.now()-7*24*60*60*1000);}catch(error){logger('gpt-orchestrator-maintenance-error',error);}
  };
  const gptTaskGetStmt=gptSqlite?.prepare('SELECT task_id,target_key,task_type,payload_json,status,created_at,updated_at,writer_device_id FROM gpt_task_queue WHERE scope=? AND task_id=?');
  const gptTaskPutStmt=gptSqlite?.prepare(`INSERT INTO gpt_task_queue(scope,task_id,target_key,task_type,payload_json,status,created_at,updated_at,writer_device_id)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(scope,task_id) DO UPDATE SET
      target_key=excluded.target_key,
      task_type=excluded.task_type,
      payload_json=excluded.payload_json,
      status=excluded.status,
      updated_at=excluded.updated_at,
      writer_device_id=excluded.writer_device_id`);
  const gptTaskListAllStmt=gptSqlite?.prepare('SELECT task_id,target_key,task_type,payload_json,status,created_at,updated_at,writer_device_id FROM gpt_task_queue WHERE scope=? ORDER BY updated_at DESC LIMIT ?');
  const gptTaskListStatusStmt=gptSqlite?.prepare('SELECT task_id,target_key,task_type,payload_json,status,created_at,updated_at,writer_device_id FROM gpt_task_queue WHERE scope=? AND status=? ORDER BY updated_at DESC LIMIT ?');
  const gptTaskCountStmt=gptSqlite?.prepare('SELECT COUNT(*) AS count FROM gpt_task_queue');
  const gptScope=(value='')=>text(value,180).replace(/[^A-Za-z0-9._:@-]/g,'').slice(0,180);
  const gptStateKey=(value='')=>text(value,120).replace(/[^A-Za-z0-9._:-]/g,'').slice(0,120);
  const gptTargetKey=(value='')=>text(value,360).replace(/[\r\n\t]/g,' ').trim().slice(0,360);
  const gptTaskId=(value='')=>text(value,180).replace(/[^A-Za-z0-9._:@-]/g,'').slice(0,180);
  const gptTaskType=(value='')=>text(value,80).replace(/[^A-Za-z0-9._:-]/g,'').slice(0,80);
  const gptTaskStatus=(value='queued')=>{const v=text(value,30).toLowerCase();return ['queued','running','done','failed','cancelled'].includes(v)?v:'queued';};
  const gptAllowedKeys=new Set(['bindings','customerMessageDeliveryReceipts','replyDeliveryReceipts','replyFreshnessLocks','replyDirectSendReceipts','customerChatModes','pendingAutoBinds','manualCustomerDrafts']);
  const gptSafeJson=(value)=>{
    let raw='';try{raw=JSON.stringify(value??{});}catch{return null;}
    if(Buffer.byteLength(raw)>700*1024)return null;
    return raw;
  };
  const gptSafeText=(value='',max=30000)=>String(value??'').replace(/\u0000/g,'').replace(/\r\n?/g,'\n').trim().slice(0,max);
  const gptHistoryIndex=(rows=[])=>{
    const out=[];
    for(const row of (Array.isArray(rows)?rows:[]).slice(-80)){
      if(!row||typeof row!=='object')continue;
      out.push({id:text(row.id||row.messageId,160),role:text(row.role,24),at:Number(row.at||row.ts||row.timestamp||0)||0,hash:text(row.hash||row.textHash,96),preview:gptSafeText(row.preview||'',240)});
    }
    return out;
  };
  const gptPromptCompose=(input={})=>{
    const flow=gptSafeText(input.flowSyncText||'',12000);
    const messages=(Array.isArray(input.messages)?input.messages:[]).map(v=>gptSafeText(v,4000)).filter(Boolean).slice(-40);
    const contract=gptSafeText(input.contract||'',12000);
    const supplement=input.includeSupplement===false?'':gptSafeText(input.supplementLabel||'补充：',80);
    const blocks=[];
    if(flow)blocks.push(flow);
    if(messages.length)blocks.push(['客户消息：',messages.join('\n\n')].join('\n'));
    if(contract)blocks.push(contract);
    if(supplement)blocks.push(supplement);
    const maxChars=Math.max(4000,Math.min(40000,Number(input.maxChars||30000)||30000));
    const prompt=blocks.join('\n\n').trim().slice(0,maxChars);
    const fingerprint=crypto.createHash('sha256').update(prompt).digest('hex');
    return {prompt,fingerprint,messageCount:messages.length,charCount:prompt.length,byteCount:Buffer.byteLength(prompt)};
  };

  const importLegacyJsonCache=()=>{
    if(!sqlite||!legacyCacheFile||!fs.existsSync(legacyCacheFile))return 0;
    let stat=null;try{stat=fs.statSync(legacyCacheFile);}catch{return 0;}
    const fingerprint=`${stat.size}:${Math.floor(stat.mtimeMs)}`;
    if(String(dbMetaGet.get('legacy-json-fingerprint')?.value||'')===fingerprint)return 0;
    let parsed=null;try{parsed=JSON.parse(fs.readFileSync(legacyCacheFile,'utf8'));}catch(error){logger('translation-cache-json-migration-read-error',error);return 0;}
    const rows=Object.values(parsed?.entries&&typeof parsed.entries==='object'?parsed.entries:{});
    if(!rows.length){dbMetaSet.run('legacy-json-fingerprint',fingerprint);return 0;}
    let imported=0;
    try{
      sqlite.exec('BEGIN IMMEDIATE');
      for(const row of rows){
        if(!row||typeof row!=='object')continue;
        const sourceText=normalizeTranslationText(row.sourceText,12000);
        const translatedText=normalizeTranslationText(row.translatedText,20000);
        if(!sourceText||!translatedText)continue;
        const sourceLang=canonicalSourceLanguage(row.sourceLang||'auto',sourceText);
        const targetLang=normalizeLanguage(row.targetLang,'zh');
        const hash=translationKey({text:sourceText,source:sourceLang,target:targetLang});
        const createdAt=text(row.createdAt,80)||new Date().toISOString();
        const updatedAt=text(row.updatedAt,80)||createdAt;
        dbInsert.run(hash,sourceText,translatedText,sourceLang,targetLang,text(row.engine,120),createdAt,updatedAt);
        imported++;
      }
      dbMetaSet.run('legacy-json-fingerprint',fingerprint);
      dbMetaSet.run('schema-version','4');
      sqlite.exec('COMMIT');
      cacheCount=Number(dbCount.get()?.count||0);
      if(imported)logger('translation-cache-json-migrated',`${imported} rows -> ${cacheDbFile}`);
    }catch(error){
      try{sqlite.exec('ROLLBACK');}catch{}
      logger('translation-cache-json-migration-error',error);
      return 0;
    }
    return imported;
  };
  const migratedJsonRows=importLegacyJsonCache();

  // Preserve any old V1.27.44 cloud-Qwen hash cache before removing it from the
  // team store. Those legacy rows have no original text and cannot be safely
  // converted into the local-model shared cache.
  if(legacyCacheFile&&Object.keys(legacyTranslationCache).length){
    try{
      const legacyFile=path.join(path.dirname(legacyCacheFile),'translation-cache.legacy-v12744.json');
      if(!fs.existsSync(legacyFile)){
        fs.mkdirSync(path.dirname(legacyFile),{recursive:true});
        fs.writeFileSync(legacyFile,JSON.stringify({version:1,entries:legacyTranslationCache,archivedAt:new Date().toISOString()},null,2));
      }
    }catch(error){logger('translation-cache-legacy-backup-error',error);}
  }
  const pruneTranslationCache=()=>{
    if(!sqlite||cacheCount<=tg.cacheMax)return 0;
    const remove=Math.max(0,cacheCount-tg.cacheMax);
    if(!remove)return 0;
    try{
      sqlite.prepare(`DELETE FROM translation_cache WHERE hash IN (
        SELECT hash FROM translation_cache
        ORDER BY COALESCE(last_hit_at,updated_at) ASC, updated_at ASC
        LIMIT ?
      )`).run(remove);
      cacheCount=Number(dbCount.get()?.count||0);
      return remove;
    }catch(error){logger('translation-cache-prune-error',error);return 0;}
  };
  if(cacheCount>tg.cacheMax)pruneTranslationCache();
  const translationLookup=(item={})=>{
    const cleanItem={id:text(item.id,120),text:normalizeTranslationText(item.text,12000),source:canonicalSourceLanguage(item.source,item.text),target:normalizeLanguage(item.target,'zh')};
    if(!cleanItem.text)return {id:cleanItem.id,ok:false,hit:false,error:'empty-text'};
    const hash=translationKey(cleanItem);
    if(!sqlite)return {id:cleanItem.id,ok:true,hit:false,hash,error:'sqlite-unavailable'};
    const cached=dbSelect.get(hash);
    if(!cached?.translated_text)return {id:cleanItem.id,ok:true,hit:false,hash};
    const now=new Date().toISOString();
    try{dbTouch.run(now,hash);}catch(error){logger('translation-cache-touch-error',error);}
    return {id:cleanItem.id,ok:true,hit:true,hash,translated:text(cached.translated_text,20000),updatedAt:text(cached.updated_at,80)};
  };
  let storesSincePrune=0;
  const translationStore=(item={})=>{
    const cleanItem={
      id:text(item.id,120),
      text:normalizeTranslationText(item.text,12000),
      translated:normalizeTranslationText(item.translated,20000),
      source:canonicalSourceLanguage(item.source,item.text),
      target:normalizeLanguage(item.target,'zh'),
      engine:text(item.engine,120)
    };
    if(!cleanItem.text)return {id:cleanItem.id,ok:false,error:'empty-text'};
    if(!cleanItem.translated)return {id:cleanItem.id,ok:false,error:'empty-translation'};
    if(!sqlite)return {id:cleanItem.id,ok:false,error:'sqlite-unavailable'};
    const hash=translationKey(cleanItem);const now=new Date().toISOString();const prior=dbSelect.get(hash);
    const replaced=!!prior?.translated_text&&String(prior.translated_text)!==cleanItem.translated;
    const createdAt=text(prior?.created_at,80)||now;
    try{
      dbInsert.run(hash,cleanItem.text,cleanItem.translated,cleanItem.source,cleanItem.target,cleanItem.engine||text(prior?.engine,120),createdAt,now);
      if(!prior)cacheCount++;
      storesSincePrune++;
      if(cacheCount>tg.cacheMax&&(storesSincePrune>=256||cacheCount>tg.cacheMax+1000)){storesSincePrune=0;pruneTranslationCache();}
      return {id:cleanItem.id,ok:true,hash,stored:true,replaced};
    }catch(error){logger('translation-cache-store-error',error);return {id:cleanItem.id,ok:false,error:'sqlite-write-failed'};}
  };
  const mapLimit=async(rows,limit,fn)=>{const out=new Array(rows.length);let next=0;const worker=async()=>{while(true){const i=next++;if(i>=rows.length)return;out[i]=await fn(rows[i],i);}};await Promise.all(Array.from({length:Math.min(limit,rows.length)},()=>worker()));return out;};
  const deeplLanguage=(value='',target=false)=>{
    const lang=normalizeLanguage(value,target?'zh':'auto');
    if(!lang||lang==='auto'||lang==='detect'||lang==='und')return '';
    const key=lang.toLowerCase();
    if(key==='zh'||key==='zh-cn'||key==='zh-hans')return target?'ZH-HANS':'ZH';
    if(key==='zh-tw'||key==='zh-hant')return target?'ZH-HANT':'ZH';
    if(key==='en'||key==='en-us')return target?'EN-US':'EN';
    if(key==='en-gb')return target?'EN-GB':'EN';
    if(key==='pt'||key==='pt-br')return target?'PT-BR':'PT';
    if(key==='pt-pt')return target?'PT-PT':'PT';
    return key.toUpperCase();
  };
  const deeplTranslateRows=async(rows=[])=>{
    const list=(Array.isArray(rows)?rows:[]).slice(0,128).map(item=>({
      text:normalizeTranslationText(item?.text,12000),
      source:canonicalSourceLanguage(item?.source,item?.text),
      target:normalizeLanguage(item?.target,'zh')
    })).filter(item=>item.text);
    if(!list.length)return [];
    if(!deeplProviderReady())throw new Error('deepl-translation-not-configured');
    const targetLang=deeplLanguage(list[0].target||'zh',true)||'ZH-HANS';
    const sourceLang=deeplLanguage(list[0].source||'auto',false);
    const body={text:list.map(item=>item.text),target_lang:targetLang};
    if(sourceLang)body.source_lang=sourceLang;
    const started=Date.now();
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),deeplTranslation.timeoutMs);
    deeplProviderStats.calls+=1;
    deeplProviderStats.items+=list.length;
    deeplProviderStats.characters+=list.reduce((sum,item)=>sum+[...item.text].length,0);
    deeplProviderStats.lastAt=new Date().toISOString();
    try{
      if(typeof fetch!=='function')throw new Error('fetch-unavailable');
      const response=await fetch(deeplTranslation.endpoint,{
        method:'POST',
        headers:{'content-type':'application/json','authorization':`DeepL-Auth-Key ${deeplTranslation.apiKey}`},
        body:JSON.stringify(body),
        signal:controller.signal
      });
      if(!response.ok)throw new Error(`deepl-http-${response.status}`);
      const payload=await response.json();
      const translated=Array.isArray(payload?.translations)?payload.translations:[];
      if(translated.length!==list.length)throw new Error('deepl-result-count-mismatch');
      deeplProviderStats.lastLatencyMs=Math.max(0,Date.now()-started);
      deeplProviderStats.lastOkAt=new Date().toISOString();
      return translated.map((row,index)=>({
        ok:true,
        translated:normalizeTranslationText(row?.text,20000),
        detectedSourceLanguage:normalizeLanguage(row?.detected_source_language,list[index].source||'auto'),
        elapsedMs:deeplProviderStats.lastLatencyMs
      }));
    }catch(error){
      deeplProviderStats.errors+=1;
      deeplProviderStats.lastLatencyMs=Math.max(0,Date.now()-started);
      deeplProviderStats.lastErrorAt=new Date().toISOString();
      // Never log source text, translated text, request body, or API key.
      logger('translation-deepl-provider-error',String(error?.name||'provider-error'));
      throw new Error(error?.name==='AbortError'?'deepl-timeout':String(error?.message||'deepl-provider-error').replace(deeplTranslation.apiKey,'[redacted]').slice(0,120));
    }finally{clearTimeout(timer);}
  };
  // V1.27.133: one shared provider ownership map covers both background
  // pre-translation and operator on-demand translation. If the same source
  // text/language pair races in from both paths, only the owner calls DeepL;
  // every waiter reuses that exact result. This keeps quota use exactly-once
  // at the translation-key level without exposing message text in diagnostics.
  const deeplTranslateAndStoreRows=async(rows=[],engine='deepl')=>{
    const list=(Array.isArray(rows)?rows:[]).slice(0,128).map((raw,index)=>({
      index,
      id:text(raw?.id,120),
      text:normalizeTranslationText(raw?.text,12000),
      source:canonicalSourceLanguage(raw?.source,raw?.text),
      target:normalizeLanguage(raw?.target,'zh')
    })).filter(row=>row.text);
    const results=new Array(list.length);
    const owners=[];const waiters=[];
    for(let i=0;i<list.length;i++){
      const row=list[i];
      const hit=translationLookup(row);
      if(hit.hit){results[i]={id:row.id,ok:true,translated:hit.translated,cacheHit:true,provider:'shared-cache',hash:hit.hash,detectedSourceLanguage:row.source,elapsedMs:0};continue;}
      const hash=hit.hash||translationKey(row);
      const existing=deeplTranslationInFlight.get(hash);
      if(existing){deeplProviderStats.dedupeWaits+=1;waiters.push({i,row,hash,promise:existing});continue;}
      let resolveOwner;const promise=new Promise(resolve=>{resolveOwner=resolve;});
      deeplTranslationInFlight.set(hash,promise);
      deeplProviderStats.maxInFlight=Math.max(deeplProviderStats.maxInFlight,deeplTranslationInFlight.size);
      owners.push({i,row,hash,promise,resolve:resolveOwner});
    }
    const groups=new Map();
    for(const owner of owners){const key=`${owner.row.source}\u001f${owner.row.target}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(owner);}
    for(const group of groups.values()){
      let translated=[];let providerError='';
      try{translated=await deeplTranslateRows(group.map(owner=>owner.row));}
      catch(error){providerError=String(error?.message||'deepl-provider-error').slice(0,120);}
      for(let i=0;i<group.length;i++){
        const owner=group[i],result=translated[i]||{};let finalResult;
        if(!providerError&&result.ok&&result.translated){
          const stored=translationStore({...owner.row,translated:result.translated,engine});
          finalResult=stored?.ok
            ? {id:owner.row.id,ok:true,translated:result.translated,cacheHit:false,provider:'deepl',hash:stored.hash||owner.hash,detectedSourceLanguage:result.detectedSourceLanguage||owner.row.source,elapsedMs:Number(result.elapsedMs||0)}
            : {id:owner.row.id,ok:false,cacheHit:false,provider:'deepl',hash:owner.hash,error:String(stored?.error||'translation-store-failed').slice(0,120)};
        }else finalResult={id:owner.row.id,ok:false,cacheHit:false,provider:'deepl',hash:owner.hash,error:providerError||'empty-translation'};
        results[owner.i]=finalResult;owner.resolve(finalResult);
        if(deeplTranslationInFlight.get(owner.hash)===owner.promise)deeplTranslationInFlight.delete(owner.hash);
      }
    }
    await Promise.all(waiters.map(async waiter=>{
      const shared=await waiter.promise;
      results[waiter.i]={...shared,id:waiter.row.id,deduped:true};
    }));
    return results;
  };
  // V1.27.133 / VPS v0.12: server-side pre-translation.
  // Official API incoming messages are translated as soon as they land in the
  // VPS SQLite inbox databases, before any desktop operator opens the customer.
  // Browser/app-center surfaces can also enqueue incoming text through the
  // authenticated /api/translation/pretranslate endpoint. Only the shared VPS
  // cache and DeepL are used here; local Ollama remains a desktop-only fallback.
  const serverPreTranslation={
    enabled:String(process.env.YOKO_TRANSLATION_PRETRANSLATE_ENABLED ?? translationGateway?.serverPreTranslation ?? 'true')!=='false',
    intervalMs:Math.max(350,Math.min(10000,Number(process.env.YOKO_TRANSLATION_PRETRANSLATE_INTERVAL_MS||translationGateway?.pretranslateIntervalMs||750)||750)),
    batchSize:Math.max(1,Math.min(32,Number(process.env.YOKO_TRANSLATION_PRETRANSLATE_BATCH||translationGateway?.pretranslateBatchSize||12)||12)),
    target:normalizeLanguage(process.env.YOKO_TRANSLATION_PRETRANSLATE_TARGET||translationGateway?.pretranslateTarget||'zh','zh')
  };
  const serverPreTranslationStats={
    version:'v127133-server-pretranslation-v0.12',
    runs:0,scanned:0,queued:0,cacheHits:0,translated:0,failures:0,lastRunAt:'',lastSuccessAt:'',lastErrorAt:'',lastError:'',lastLatencyMs:0,
    metaDatabaseFile:text(metaMessaging?.databaseFile,1000),lineDatabaseFile:text(lineMessaging?.databaseFile,1000),externalQueued:0
  };
  let pretranslationRunning=false,pretranslationTimer=null,pretranslationStartupTimer=null;
  let pretranslationMetaDb=null,pretranslationLineDb=null,pretranslationMetaQuery=null,pretranslationLineQuery=null;
  const pretranslationDone=new Set();
  const pretranslationRetry=new Map();
  const pretranslationExternalQueue=new Map();
  const boundedSetAdd=(set,key,max=20000)=>{set.add(key);if(set.size>max){let remove=set.size-max;for(const value of set){set.delete(value);if(--remove<=0)break;}}};
  const safeIncomingText=value=>{
    const clean=normalizeTranslationText(value,12000);
    if(!clean)return '';
    if(/^[［\[](?:图片|image|视频|video|音频|audio|文件|file|附件|attachment|位置|location|贴纸|sticker)[］\]]$/i.test(clean))return '';
    return clean;
  };
  const openPretranslationSources=()=>{
    let DatabaseSync=null;try{({DatabaseSync}=require('node:sqlite'));}catch{return;}
    if(!pretranslationMetaQuery){
      const file=text(metaMessaging?.databaseFile,1000);
      if(file&&fs.existsSync(file))try{
        pretranslationMetaDb=new DatabaseSync(path.resolve(file));
        pretranslationMetaDb.exec('PRAGMA busy_timeout=2500;');
        pretranslationMetaQuery=pretranslationMetaDb.prepare(`SELECT event_key AS id,text,timestamp_ms AS timestampMs FROM meta_events WHERE event_type='message' AND direction='incoming' AND text<>'' ORDER BY timestamp_ms DESC LIMIT ?`);
      }catch(error){serverPreTranslationStats.lastError=`meta-source:${String(error?.message||error).slice(0,120)}`;}
    }
    if(!pretranslationLineQuery){
      const file=text(lineMessaging?.databaseFile,1000);
      if(file&&fs.existsSync(file))try{
        pretranslationLineDb=new DatabaseSync(path.resolve(file));
        pretranslationLineDb.exec('PRAGMA busy_timeout=2500;');
        pretranslationLineQuery=pretranslationLineDb.prepare(`SELECT event_key AS id,text,timestamp_ms AS timestampMs FROM line_events WHERE event_type='message' AND direction='incoming' AND text<>'' ORDER BY timestamp_ms DESC LIMIT ?`);
      }catch(error){serverPreTranslationStats.lastError=`line-source:${String(error?.message||error).slice(0,120)}`;}
    }
  };
  const queueServerPretranslation=(items=[],sourceTag='external')=>{
    let queued=0;
    for(const item of (Array.isArray(items)?items:[]).slice(0,128)){
      const direction=text(item?.direction,20).toLowerCase();
      if(direction&&direction!=='incoming')continue;
      const sourceText=safeIncomingText(item?.text);if(!sourceText)continue;
      const id=text(item?.id||item?.messageId||crypto.createHash('sha256').update(sourceText).digest('hex').slice(0,24),240);
      const platform=text(item?.platform||sourceTag,40).toLowerCase()||'external';
      const key=`${platform}:${id}`;
      if(pretranslationDone.has(key))continue;
      pretranslationExternalQueue.set(key,{key,id,platform,text:sourceText,source:canonicalSourceLanguage(item?.source,sourceText),target:normalizeLanguage(item?.target,serverPreTranslation.target),timestampMs:Number(item?.timestampMs||Date.now())||Date.now()});
      queued++;
    }
    while(pretranslationExternalQueue.size>3000)pretranslationExternalQueue.delete(pretranslationExternalQueue.keys().next().value);
    serverPreTranslationStats.externalQueued=pretranslationExternalQueue.size;
    serverPreTranslationStats.queued+=queued;
    if(queued)queueMicrotask(()=>runServerPretranslation('enqueue'));
    return queued;
  };
  const pretranslationRowsFromSources=()=>{
    openPretranslationSources();
    const limit=Math.max(serverPreTranslation.batchSize*3,24);const rows=[];
    try{if(pretranslationMetaQuery)for(const row of pretranslationMetaQuery.all(limit))rows.push({key:`facebook:${text(row?.id,240)}`,id:text(row?.id,240),platform:'facebook',text:safeIncomingText(row?.text),source:'auto',target:serverPreTranslation.target,timestampMs:Number(row?.timestampMs||0)||0});}catch(error){serverPreTranslationStats.lastError=`meta-scan:${String(error?.message||error).slice(0,120)}`;}
    try{if(pretranslationLineQuery)for(const row of pretranslationLineQuery.all(limit))rows.push({key:`line:${text(row?.id,240)}`,id:text(row?.id,240),platform:'line',text:safeIncomingText(row?.text),source:'auto',target:serverPreTranslation.target,timestampMs:Number(row?.timestampMs||0)||0});}catch(error){serverPreTranslationStats.lastError=`line-scan:${String(error?.message||error).slice(0,120)}`;}
    for(const row of pretranslationExternalQueue.values())rows.push(row);
    const seen=new Set();
    return rows.filter(row=>row.key&&row.text&&!seen.has(row.key)&&seen.add(row.key)).sort((a,b)=>Number(b.timestampMs||0)-Number(a.timestampMs||0));
  };
  async function runServerPretranslation(reason='timer'){
    if(pretranslationRunning||!serverPreTranslation.enabled||!tg.enabled||!sqlite||!deeplProviderReady())return false;
    pretranslationRunning=true;const started=Date.now();serverPreTranslationStats.runs++;serverPreTranslationStats.lastRunAt=new Date().toISOString();
    try{
      const now=Date.now();const candidates=[];
      for(const row of pretranslationRowsFromSources()){
        if(candidates.length>=serverPreTranslation.batchSize)break;
        serverPreTranslationStats.scanned++;
        if(pretranslationDone.has(row.key)){pretranslationExternalQueue.delete(row.key);continue;}
        const retry=pretranslationRetry.get(row.key);if(retry&&Number(retry.nextAt||0)>now)continue;
        const source=canonicalSourceLanguage(row.source,row.text),target=normalizeLanguage(row.target,serverPreTranslation.target);
        if(source==='zh'&&target.startsWith('zh')){boundedSetAdd(pretranslationDone,row.key);pretranslationExternalQueue.delete(row.key);continue;}
        const hit=translationLookup({id:row.id,text:row.text,source,target});
        if(hit.hit){serverPreTranslationStats.cacheHits++;boundedSetAdd(pretranslationDone,row.key);pretranslationRetry.delete(row.key);pretranslationExternalQueue.delete(row.key);continue;}
        candidates.push({...row,source,target});
      }
      if(candidates.length){
        const translated=await deeplTranslateAndStoreRows(candidates,'deepl-pretranslation');
        for(let i=0;i<candidates.length;i++){
          const row=candidates[i],result=translated[i]||{};
          if(result.ok&&result.translated){
            boundedSetAdd(pretranslationDone,row.key);pretranslationRetry.delete(row.key);pretranslationExternalQueue.delete(row.key);serverPreTranslationStats.translated++;serverPreTranslationStats.lastSuccessAt=new Date().toISOString();
          }else{
            const message=String(result.error||'pretranslation-failed').slice(0,120);serverPreTranslationStats.failures+=1;serverPreTranslationStats.lastErrorAt=new Date().toISOString();serverPreTranslationStats.lastError=message;
            const prior=pretranslationRetry.get(row.key)||{attempts:0};const attempts=Number(prior.attempts||0)+1;pretranslationRetry.set(row.key,{attempts,nextAt:Date.now()+Math.min(5*60*1000,5000*Math.pow(2,Math.min(6,attempts-1))),error:message});
          }
        }
      }
      serverPreTranslationStats.externalQueued=pretranslationExternalQueue.size;serverPreTranslationStats.lastLatencyMs=Math.max(0,Date.now()-started);return true;
    }catch(error){serverPreTranslationStats.lastErrorAt=new Date().toISOString();serverPreTranslationStats.lastError=String(error?.message||error).slice(0,120);return false;}
    finally{pretranslationRunning=false;}
  }
  if(serverPreTranslation.enabled){
    pretranslationStartupTimer=setTimeout(()=>runServerPretranslation('startup').catch(()=>{}),500);pretranslationStartupTimer.unref?.();
    pretranslationTimer=setInterval(()=>runServerPretranslation('timer').catch(()=>{}),serverPreTranslation.intervalMs);pretranslationTimer.unref?.();
  }

  const save=()=>{ 
    if(!file)return; 
    try{
      fs.mkdirSync(path.dirname(file),{recursive:true});
      const tmp=`${file}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp,JSON.stringify(store,null,2));
      fs.renameSync(tmp,file);
    }catch(error){logger('save-error',error);}
  };
  let aiService=null;
  const auth=req=>{
    const legacy=text(req.headers['x-yoko-team-id'],100)===text(teamId,100)&&text(req.headers['x-yoko-api-key'],200)===text(apiKey,200)&&!!text(teamId,100)&&!!text(apiKey,200);
    if(legacy)return true;
    try{return !!aiService?.authenticate?.(req);}catch{return false;}
  };
  const respond=(res,status,payload)=>{const raw=JSON.stringify(payload);res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(raw),'access-control-allow-origin':'*','access-control-allow-headers':'content-type,authorization,x-yoko-team-id,x-yoko-api-key'});res.end(raw);};
  const readJsonBody=(req,maxBytes=512*1024)=>new Promise((resolve,reject)=>{let body='';let done=false;req.on('data',c=>{if(done)return;body+=String(c||'');if(Buffer.byteLength(body)>maxBytes){done=true;reject(Object.assign(new Error('payload-too-large'),{statusCode:413}));try{req.destroy();}catch{}}});req.on('end',()=>{if(done)return;done=true;const parsed=safeJson(body);if(parsed===null)return reject(Object.assign(new Error('invalid-json'),{statusCode:400}));resolve(parsed||{});});req.on('error',reject);});
  const customerProfileClean=(raw={})=>{const out={};for(const [key,max] of Object.entries({key:160,platform:40,accountId:180,chatId:420,displayName:220,name:220,region:160,age:40,occupation:220,interests:1200,tags:1200,note:12000,stage:120,serviceStatus:40,language:40,memorySummary:3000,summary:3000,conversationSummary:3600,conversationSummaryVersion:120,globalCustomerId:180,updatedAt:100,createdAt:100}))out[key]=text(raw?.[key],max);out.memoryItems=Array.isArray(raw?.memoryItems)?raw.memoryItems.slice(-80).map(x=>({type:text(x?.type,60),label:text(x?.label,120),text:text(x?.text,600),at:text(x?.at,100)})):[];return out;};
  const metaGateway=createMetaMessengerGateway({...metaMessaging,logger});
  const lineGateway=createLineMessagingGateway({...lineMessaging,logger});
  aiService=createAiService({dataFile:file,logger,metaDatabaseFile:metaMessaging?.databaseFile,sendMetaAiText:input=>metaGateway.sendAiText(input)});
  const server=http.createServer(async(req,res)=>{
    if(await aiService.handle(req,res))return;
    if(await metaGateway.handle(req,res,{auth}))return;
    if(await lineGateway.handle(req,res,{auth}))return;
    if(req.method==='OPTIONS') return respond(res,200,{ok:true});
    if(req.url==='/health') return respond(res,200,{ok:true,service:'yoko-team-sync',time:new Date().toISOString()});
    // VPS v0.9.17 / YokoSCRM V1.27.257: server-authoritative customer profile + reply-rule store.
    if(req.url==='/api/workspace/settings/get'&&req.method==='POST'){
      if(!auth(req))return respond(res,401,{ok:false,error:'unauthorized'});
      try{const input=await readJsonBody(req,256*1024);const key=text(input?.key,120);if(!key)return respond(res,400,{ok:false,error:'key-required'});const row=store.workspaceSettings?.[key]||null;return respond(res,200,{ok:true,key,found:!!row,value:row?.value||null,version:Number(row?.version||0),updatedAt:text(row?.updatedAt,100)});}catch(error){return respond(res,Number(error?.statusCode||500),{ok:false,error:String(error?.message||error)});}
    }
    if(req.url==='/api/workspace/settings/put'&&req.method==='POST'){
      if(!auth(req))return respond(res,401,{ok:false,error:'unauthorized'});
      try{const input=await readJsonBody(req,512*1024);const key=text(input?.key,120);if(!key)return respond(res,400,{ok:false,error:'key-required'});const value=input?.value&&typeof input.value==='object'?input.value:{};const raw=JSON.stringify(value);if(Buffer.byteLength(raw)>220*1024)return respond(res,413,{ok:false,error:'settings-too-large'});store.workspaceSettings=store.workspaceSettings&&typeof store.workspaceSettings==='object'?store.workspaceSettings:{};const prior=store.workspaceSettings[key]||{};const version=Math.max(Number(prior.version||0)+1,Number(input?.version||0)||0,1);const updatedAt=new Date().toISOString();store.workspaceSettings[key]={value,version,updatedAt,writerDeviceId:text(input?.writerDeviceId,160)};store.updatedAt=updatedAt;save();return respond(res,200,{ok:true,key,value,version,updatedAt});}catch(error){return respond(res,Number(error?.statusCode||500),{ok:false,error:String(error?.message||error)});}
    }
    if(req.url==='/api/customer/profile/get'&&req.method==='POST'){
      if(!auth(req))return respond(res,401,{ok:false,error:'unauthorized'});
      try{const input=await readJsonBody(req,128*1024);const key=text(input?.key,160);if(!key)return respond(res,400,{ok:false,error:'key-required'});const row=store.customerProfiles?.[key]||null;return respond(res,200,{ok:true,key,found:!!row,profile:row?.profile||null,version:Number(row?.version||0),updatedAt:text(row?.updatedAt,100)});}catch(error){return respond(res,Number(error?.statusCode||500),{ok:false,error:String(error?.message||error)});}
    }
    if(req.url==='/api/customer/profile/put'&&req.method==='POST'){
      if(!auth(req))return respond(res,401,{ok:false,error:'unauthorized'});
      try{const input=await readJsonBody(req,512*1024);const key=text(input?.key,160);if(!key)return respond(res,400,{ok:false,error:'key-required'});store.customerProfiles=store.customerProfiles&&typeof store.customerProfiles==='object'?store.customerProfiles:{};const prior=store.customerProfiles[key]||{};const incoming=customerProfileClean(input?.profile||{});const priorProfile=customerProfileClean(prior?.profile||{});const incomingAt=Date.parse(incoming.updatedAt||'')||0,priorAt=Date.parse(priorProfile.updatedAt||'')||0;const profile=incomingAt>=priorAt?{...priorProfile,...incoming}:{...incoming,...priorProfile};const updatedAt=new Date().toISOString();const version=Math.max(Number(prior.version||0)+1,Number(input?.version||0)||0,1);store.customerProfiles[key]={profile,version,updatedAt,writerDeviceId:text(input?.writerDeviceId,160)};store.updatedAt=updatedAt;save();return respond(res,200,{ok:true,key,profile,version,updatedAt});}catch(error){return respond(res,Number(error?.statusCode||500),{ok:false,error:String(error?.message||error)});}
    }
    if(req.url==='/api/translation/health'&&req.method==='GET'){
      if(!auth(req))return respond(res,401,{ok:false,error:'unauthorized'});
      return respond(res,200,{
        ok:!!sqlite,
        service:'yoko-translation-gateway',
        enabled:tg.enabled,
        cacheOnly:!deeplProviderReady(),
        storesOriginalText:true,
        cloudProvider:deeplProviderReady(),
        deeplConfigured:!!deeplTranslation.apiKey,
        cloudConfigured:!!deeplTranslation.apiKey,
        inboundOnly:true,
        provider:deeplProviderReady()?'deepl-translate-v2':'shared-cache',
        providerStats:{...deeplProviderStats,inFlight:deeplTranslationInFlight.size},
        preTranslation:{enabled:serverPreTranslation.enabled,running:pretranslationRunning,intervalMs:serverPreTranslation.intervalMs,batchSize:serverPreTranslation.batchSize,target:serverPreTranslation.target,...serverPreTranslationStats},
        canonicalLanguageKeys:true,
        storage:sqliteStorage,
        databaseFile:cacheDbFile,
        migratedJsonRows,
        sqliteReady:!!sqlite,
        error:sqlite?'':'sqlite-unavailable',
        cacheEntries:cacheCount,
        cacheMax:tg.cacheMax,
        time:new Date().toISOString()
      });
    }
    if(req.url==='/api/translation/pretranslate'&&req.method==='POST'){
      if(!auth(req))return respond(res,401,{ok:false,error:'unauthorized'});
      if(!serverPreTranslation.enabled)return respond(res,503,{ok:false,error:'server-pretranslation-disabled'});
      let body='';req.on('data',c=>{body+=c;if(body.length>2*1024*1024)req.destroy();});
      req.on('end',()=>{
        const input=safeJson(body);if(!input)return respond(res,400,{ok:false,error:'invalid-json'});
        const queued=queueServerPretranslation(Array.isArray(input.items)?input.items:[],text(input.sourceTag,40)||'external');
        return respond(res,202,{ok:true,queued,inboundOnly:true,preTranslation:{enabled:serverPreTranslation.enabled,running:pretranslationRunning,externalQueued:pretranslationExternalQueue.size}});
      });
      return;
    }
    if(req.url==='/api/translation/translate'&&req.method==='POST'){
      if(!auth(req))return respond(res,401,{ok:false,error:'unauthorized'});
      if(!tg.enabled)return respond(res,503,{ok:false,error:'translation-gateway-disabled'});
      let body='';req.on('data',c=>{body+=c;if(body.length>2*1024*1024)req.destroy();});
      req.on('end',async()=>{
        const input=safeJson(body);if(!input)return respond(res,400,{ok:false,error:'invalid-json'});
        const rows=(Array.isArray(input.items)?input.items:[]).slice(0,128);
        const items=new Array(rows.length);
        const misses=[];
        for(let index=0;index<rows.length;index++){
          const row=rows[index]&&typeof rows[index]==='object'?rows[index]:{};
          const id=text(row.id,120);
          const direction=text(row.direction,20).toLowerCase();
          if(direction!=='incoming'){
            items[index]={id,ok:false,disabled:true,outgoingSkipped:direction==='outgoing',error:'incoming-only'};
            continue;
          }
          const clean={id,text:normalizeTranslationText(row.text,12000),source:canonicalSourceLanguage(row.source,row.text),target:normalizeLanguage(row.target,'zh')};
          if(!clean.text){items[index]={id,ok:false,error:'empty-text'};continue;}
          const hit=translationLookup(clean);
          if(hit.hit){
            items[index]={id,ok:true,translated:hit.translated,cacheHit:true,provider:'shared-cache',hash:hit.hash,detectedSourceLanguage:clean.source,elapsedMs:0};
          }else misses.push({index,row:clean,hash:hit.hash});
        }
        let providerCalls=0;
        if(misses.length){
          if(!deeplProviderReady()){
            for(const miss of misses)items[miss.index]={id:miss.row.id,ok:false,cacheHit:false,provider:'deepl',error:'deepl-translation-not-configured',hash:miss.hash};
          }else{
            const callsBefore=deeplProviderStats.calls;
            const translated=await deeplTranslateAndStoreRows(misses.map(miss=>miss.row),'deepl');
            providerCalls=Math.max(0,deeplProviderStats.calls-callsBefore);
            for(let i=0;i<misses.length;i++){
              const miss=misses[i],result=translated[i]||{};
              items[miss.index]={...result,id:miss.row.id,hash:result.hash||miss.hash};
            }
          }
        }
        const cacheHits=items.filter(x=>x?.cacheHit===true).length;
        const translatedCount=items.filter(x=>x?.ok===true).length;
        return respond(res,200,{ok:true,items,cacheHits,translated:translatedCount,providerCalls,inboundOnly:true});
      });
      return;
    }
    if(req.url==='/api/translation/cache/lookup'&&req.method==='POST'){
      if(!auth(req))return respond(res,401,{ok:false,error:'unauthorized'});
      let body='';req.on('data',c=>{body+=c;if(body.length>1024*1024)req.destroy();});
      req.on('end',()=>{
        const input=safeJson(body);if(!input)return respond(res,400,{ok:false,error:'invalid-json'});
        const rows=(Array.isArray(input.items)?input.items:[]).slice(0,128);
        const items=rows.map(translationLookup);const hits=items.filter(x=>x.hit===true).length;
        return respond(res,200,{ok:true,items,hits,misses:Math.max(0,items.length-hits)});
      });
      return;
    }
    if(req.url==='/api/translation/cache/store'&&req.method==='POST'){
      if(!auth(req))return respond(res,401,{ok:false,error:'unauthorized'});
      if(!tg.enabled)return respond(res,503,{ok:false,error:'translation-cache-disabled'});
      let body='';req.on('data',c=>{body+=c;if(body.length>2*1024*1024)req.destroy();});
      req.on('end',()=>{
        const input=safeJson(body);if(!input)return respond(res,400,{ok:false,error:'invalid-json'});
        const rows=(Array.isArray(input.items)?input.items:[]).slice(0,128);
        const items=rows.map(translationStore);const stored=items.filter(x=>x.ok).length;
        return respond(res,200,{ok:true,items,stored,cacheEntries:cacheCount});
      });
      return;
    }
    // Backward compatibility for V1.27.44/45 desktop clients. The old endpoint
    // is now cache-lookup-only: a miss returns row.ok=false so the old client
    // naturally falls back to its configured local translation engine.
    if(req.url==='/api/translation/batch'&&req.method==='POST'){
      if(!auth(req))return respond(res,401,{ok:false,error:'unauthorized'});
      let body='';req.on('data',c=>{body+=c;if(body.length>1024*1024)req.destroy();});
      req.on('end',()=>{
        const input=safeJson(body);if(!input)return respond(res,400,{ok:false,error:'invalid-json'});
        const rows=(Array.isArray(input.items)?input.items:[]).slice(0,64);
        const looked=rows.map(translationLookup);
        const items=looked.map(row=>row.hit
          ? {id:row.id,ok:true,translated:row.translated,cacheHit:true,provider:'shared-cache',model:'local-model-contributed'}
          : {id:row.id,ok:false,error:'cache-miss',cacheHit:false,provider:'shared-cache',model:'local-model-contributed'});
        const cacheHits=items.filter(x=>x.cacheHit).length;
        return respond(res,200,{ok:true,items,cacheHits,providerCalls:0,cacheOnly:true});
      });
      return;
    }

    // VPS v0.9.14 — unified route truth. Meta + LINE gateway handlers above
    // remain authoritative; GPT state routes live beside them on the same server.
    if(req.url==='/api/gpt-orchestrator/health'&&req.method==='GET'){
      if(!auth(req))return respond(res,401,{ok:false,error:'unauthorized'});
      return respond(res,200,{ok:!!gptSqlite,service:'yoko-gpt-orchestrator',version:'v127237-gpt-lite-stage3',routerVersion:'v0.9.16-sqlite-index-acceleration',storage:gptStorage,databaseFile:gptOrchestratorDbFile,entries:gptSqlite?Number(gptCountStmt.get()?.count||0):0,time:new Date().toISOString()});
    }
    if(req.url==='/api/gpt-orchestrator/state/get'&&req.method==='POST'){
      if(!auth(req))return respond(res,401,{ok:false,error:'unauthorized'});
      if(!gptSqlite)return respond(res,503,{ok:false,error:'gpt-orchestrator-unavailable'});
      let body='';req.on('data',c=>{body+=c;if(body.length>512*1024)req.destroy();});
      req.on('end',()=>{
        const input=safeJson(body);if(!input)return respond(res,400,{ok:false,error:'invalid-json'});
        const scope=gptScope(input.scope);if(!scope)return respond(res,400,{ok:false,error:'scope-required'});
        const keys=(Array.isArray(input.keys)?input.keys:[]).map(gptStateKey).filter(key=>gptAllowedKeys.has(key)).slice(0,16);
        const items=[];
        for(const key of keys){
          const row=gptGetStmt.get(scope,key);if(!row)continue;
          let value={};try{value=JSON.parse(String(row.value_json||'{}'));}catch{continue;}
          items.push({key,value,updatedAt:Number(row.updated_at||0),writerDeviceId:text(row.writer_device_id,120)});
        }
        return respond(res,200,{ok:true,scope,items,version:'v127237-gpt-lite-stage3',routerVersion:'v0.9.16-sqlite-index-acceleration'});
      });
      return;
    }
    if(req.url==='/api/gpt-orchestrator/state/put'&&req.method==='POST'){
      if(!auth(req))return respond(res,401,{ok:false,error:'unauthorized'});
      if(!gptSqlite)return respond(res,503,{ok:false,error:'gpt-orchestrator-unavailable'});
      let body='';req.on('data',c=>{body+=c;if(body.length>2*1024*1024)req.destroy();});
      req.on('end',()=>{
        const input=safeJson(body);if(!input)return respond(res,400,{ok:false,error:'invalid-json'});
        const scope=gptScope(input.scope);if(!scope)return respond(res,400,{ok:false,error:'scope-required'});
        const writerDeviceId=text(input.writerDeviceId,120);
        const rows=(Array.isArray(input.items)?input.items:[]).slice(0,16);
        let stored=0;const items=[];
        for(const row of rows){
          const key=gptStateKey(row?.key);if(!gptAllowedKeys.has(key)){items.push({key,ok:false,error:'unsupported-key'});continue;}
          const raw=gptSafeJson(row?.value);if(raw===null){items.push({key,ok:false,error:'state-too-large-or-invalid'});continue;}
          const updatedAt=Math.max(1,Number(row?.updatedAt||0)||Date.now());
          try{gptPutStmt.run(scope,key,raw,updatedAt,writerDeviceId);stored+=1;items.push({key,ok:true,updatedAt});}
          catch(error){logger('gpt-orchestrator-state-put-error',error);items.push({key,ok:false,error:'sqlite-write-failed'});}
        }
        return respond(res,200,{ok:true,scope,stored,items,version:'v127237-gpt-lite-stage3',routerVersion:'v0.9.16-sqlite-index-acceleration'});
      });
      return;
    }

    if(req.url==='/api/gpt-orchestrator/context/get'&&req.method==='POST'){
      if(!auth(req))return respond(res,401,{ok:false,error:'unauthorized'});
      if(!gptSqlite)return respond(res,503,{ok:false,error:'gpt-orchestrator-unavailable'});
      let body='';req.on('data',c=>{body+=c;if(body.length>256*1024)req.destroy();});
      req.on('end',()=>{
        const input=safeJson(body);if(!input)return respond(res,400,{ok:false,error:'invalid-json'});
        const scope=gptScope(input.scope),targetKey=gptTargetKey(input.targetKey);if(!scope||!targetKey)return respond(res,400,{ok:false,error:'scope-and-target-required'});
        const row=gptContextGetStmt.get(scope,targetKey);if(!row)return respond(res,200,{ok:true,scope,targetKey,found:false,version:'v127237-gpt-lite-stage3'});
        let snapshot={},historyIndex=[];try{snapshot=JSON.parse(String(row.snapshot_json||'{}'));}catch{}try{historyIndex=JSON.parse(String(row.history_index_json||'[]'));}catch{}
        return respond(res,200,{ok:true,scope,targetKey,found:true,snapshot,historyIndex,updatedAt:Number(row.updated_at||0),writerDeviceId:text(row.writer_device_id,120),version:'v127237-gpt-lite-stage3'});
      });return;
    }
    if(req.url==='/api/gpt-orchestrator/context/recent'&&req.method==='POST'){
      if(!auth(req))return respond(res,401,{ok:false,error:'unauthorized'});
      if(!gptSqlite)return respond(res,503,{ok:false,error:'gpt-orchestrator-unavailable'});
      let body='';req.on('data',c=>{body+=c;if(body.length>128*1024)req.destroy();});
      req.on('end',()=>{
        const input=safeJson(body);if(!input)return respond(res,400,{ok:false,error:'invalid-json'});
        const scope=gptScope(input.scope);if(!scope)return respond(res,400,{ok:false,error:'scope-required'});
        const limit=Math.max(1,Math.min(24,Number(input.limit||8)||8));
        const rows=gptContextRecentStmt.all(scope,limit);
        const items=rows.map(row=>{let snapshot={},historyIndex=[];try{snapshot=JSON.parse(String(row.snapshot_json||'{}'));}catch{}try{historyIndex=JSON.parse(String(row.history_index_json||'[]'));}catch{}return {targetKey:String(row.target_key||''),snapshot,historyIndex,updatedAt:Number(row.updated_at||0),writerDeviceId:text(row.writer_device_id,120)};});
        return respond(res,200,{ok:true,scope,items,limit,version:'v127237-gpt-lite-stage3'});
      });return;
    }
    if(req.url==='/api/gpt-orchestrator/context/put'&&req.method==='POST'){
      if(!auth(req))return respond(res,401,{ok:false,error:'unauthorized'});
      if(!gptSqlite)return respond(res,503,{ok:false,error:'gpt-orchestrator-unavailable'});
      let body='';req.on('data',c=>{body+=c;if(body.length>700*1024)req.destroy();});
      req.on('end',()=>{
        const input=safeJson(body);if(!input)return respond(res,400,{ok:false,error:'invalid-json'});
        const scope=gptScope(input.scope),targetKey=gptTargetKey(input.targetKey);if(!scope||!targetKey)return respond(res,400,{ok:false,error:'scope-and-target-required'});
        const snapshotRaw=gptSafeJson(input.snapshot&&typeof input.snapshot==='object'?input.snapshot:{});const historyRaw=gptSafeJson(gptHistoryIndex(input.historyIndex));
        if(snapshotRaw===null||historyRaw===null||Buffer.byteLength(snapshotRaw)>220*1024||Buffer.byteLength(historyRaw)>160*1024)return respond(res,413,{ok:false,error:'context-too-large'});
        const updatedAt=Math.max(1,Number(input.updatedAt||0)||Date.now()),writerDeviceId=text(input.writerDeviceId,120);
        try{gptContextPutStmt.run(scope,targetKey,snapshotRaw,historyRaw,updatedAt,writerDeviceId);gptRunMaintenance(scope);}catch(error){logger('gpt-orchestrator-context-put-error',error);return respond(res,500,{ok:false,error:'sqlite-write-failed'});}
        return respond(res,200,{ok:true,scope,targetKey,stored:true,updatedAt,contextEntries:Number(gptContextCountStmt.get()?.count||0),version:'v127237-gpt-lite-stage3'});
      });return;
    }
    if(req.url==='/api/gpt-orchestrator/prompt/compose'&&req.method==='POST'){
      if(!auth(req))return respond(res,401,{ok:false,error:'unauthorized'});
      let body='';req.on('data',c=>{body+=c;if(body.length>700*1024)req.destroy();});
      req.on('end',()=>{
        const input=safeJson(body);if(!input)return respond(res,400,{ok:false,error:'invalid-json'});
        const result=gptPromptCompose(input);
        return respond(res,200,{ok:true,...result,version:'v127237-gpt-lite-stage3'});
      });return;
    }
    if(req.url==='/api/gpt-orchestrator/task/enqueue'&&req.method==='POST'){
      if(!auth(req))return respond(res,401,{ok:false,error:'unauthorized'});
      if(!gptSqlite)return respond(res,503,{ok:false,error:'gpt-orchestrator-unavailable'});
      let body='';req.on('data',c=>{body+=c;if(body.length>512*1024)req.destroy();});
      req.on('end',()=>{
        const input=safeJson(body);if(!input)return respond(res,400,{ok:false,error:'invalid-json'});const scope=gptScope(input.scope);if(!scope)return respond(res,400,{ok:false,error:'scope-required'});
        const task=input.task&&typeof input.task==='object'?input.task:{};const taskId=gptTaskId(task.taskId)||crypto.randomUUID();const targetKey=gptTargetKey(task.targetKey);const taskType=gptTaskType(task.type||'workflow');const status='queued';const payloadRaw=gptSafeJson(task.payload&&typeof task.payload==='object'?task.payload:{});if(payloadRaw===null||Buffer.byteLength(payloadRaw)>220*1024)return respond(res,413,{ok:false,error:'task-too-large'});
        const now=Date.now(),writerDeviceId=text(input.writerDeviceId,120);try{gptTaskPutStmt.run(scope,taskId,targetKey,taskType,payloadRaw,status,now,now,writerDeviceId);gptRunMaintenance(scope);}catch(error){logger('gpt-orchestrator-task-enqueue-error',error);return respond(res,500,{ok:false,error:'sqlite-write-failed'});}
        return respond(res,200,{ok:true,taskId,status,queued:Number(gptTaskCountStmt.get()?.count||0),version:'v127237-gpt-lite-stage3'});
      });return;
    }
    if(req.url==='/api/gpt-orchestrator/task/update'&&req.method==='POST'){
      if(!auth(req))return respond(res,401,{ok:false,error:'unauthorized'});
      if(!gptSqlite)return respond(res,503,{ok:false,error:'gpt-orchestrator-unavailable'});
      let body='';req.on('data',c=>{body+=c;if(body.length>512*1024)req.destroy();});
      req.on('end',()=>{
        const input=safeJson(body);if(!input)return respond(res,400,{ok:false,error:'invalid-json'});const scope=gptScope(input.scope),task=input.task&&typeof input.task==='object'?input.task:{},taskId=gptTaskId(task.taskId);if(!scope||!taskId)return respond(res,400,{ok:false,error:'scope-and-task-required'});
        const prior=gptTaskGetStmt.get(scope,taskId);if(!prior)return respond(res,404,{ok:false,error:'task-not-found'});let priorPayload={};try{priorPayload=JSON.parse(String(prior.payload_json||'{}'));}catch{}
        const nextPayload=task.payload&&typeof task.payload==='object'?{...priorPayload,...task.payload}:priorPayload;const payloadRaw=gptSafeJson(nextPayload);if(payloadRaw===null)return respond(res,413,{ok:false,error:'task-too-large'});const status=gptTaskStatus(task.status||prior.status),targetKey=gptTargetKey(task.targetKey||prior.target_key),taskType=gptTaskType(task.type||prior.task_type),now=Date.now(),writerDeviceId=text(input.writerDeviceId||prior.writer_device_id,120);
        try{gptTaskPutStmt.run(scope,taskId,targetKey,taskType,payloadRaw,status,Number(prior.created_at||now),now,writerDeviceId);gptRunMaintenance(scope);}catch(error){logger('gpt-orchestrator-task-update-error',error);return respond(res,500,{ok:false,error:'sqlite-write-failed'});}
        return respond(res,200,{ok:true,taskId,status,updatedAt:now,version:'v127237-gpt-lite-stage3'});
      });return;
    }
    if(req.url==='/api/gpt-orchestrator/task/list'&&req.method==='POST'){
      if(!auth(req))return respond(res,401,{ok:false,error:'unauthorized'});
      if(!gptSqlite)return respond(res,503,{ok:false,error:'gpt-orchestrator-unavailable'});
      let body='';req.on('data',c=>{body+=c;if(body.length>128*1024)req.destroy();});
      req.on('end',()=>{
        const input=safeJson(body);if(!input)return respond(res,400,{ok:false,error:'invalid-json'});const scope=gptScope(input.scope);if(!scope)return respond(res,400,{ok:false,error:'scope-required'});const limit=Math.max(1,Math.min(100,Number(input.limit||30)||30));const requested=String(input.status||'').toLowerCase();const rows=requested?gptTaskListStatusStmt.all(scope,gptTaskStatus(requested),limit):gptTaskListAllStmt.all(scope,limit);const items=rows.map(row=>{let payload={};try{payload=JSON.parse(String(row.payload_json||'{}'));}catch{}return {taskId:String(row.task_id||''),targetKey:String(row.target_key||''),type:String(row.task_type||''),payload,status:String(row.status||''),createdAt:Number(row.created_at||0),updatedAt:Number(row.updated_at||0),writerDeviceId:text(row.writer_device_id,120)};});return respond(res,200,{ok:true,items,version:'v127237-gpt-lite-stage3'});
      });return;
    }

    if(req.url!=='/api/v1/sync'||req.method!=='POST') return respond(res,404,{ok:false,error:'not-found'});
    if(!auth(req)) return respond(res,401,{ok:false,error:'unauthorized'});
    let body=''; req.on('data',c=>{body+=c;if(body.length>2*1024*1024)req.destroy();});
    req.on('end',()=>{
      const input=safeJson(body); if(!input)return respond(res,400,{ok:false,error:'invalid-json'});
      const now=new Date().toISOString();
      const device=input.device&&typeof input.device==='object'?input.device:{}; const deviceId=text(device.deviceId,120);
      const nodeCapabilities=normalizeNodeCapabilities(input.nodeCapabilities&&typeof input.nodeCapabilities==='object'?input.nodeCapabilities:{});
      const adminActions=Array.isArray(input.adminActions)?input.adminActions.slice(0,50):[];
      const actionAcks=[];
      if(adminActions.length){
        const isAdmin=text(device.role,30)==='admin';
        for(const action of adminActions){
          const actionId=text(action?.actionId,120) || `action-${Date.now()}`;
          const type=text(action?.type,80);
          if(!isAdmin){ actionAcks.push({actionId,type,ok:false,error:'admin-required'}); continue; }
          if(type==='delete-device'){
            const targetId=text(action?.deviceId,120);
            if(!targetId){ actionAcks.push({actionId,type,ok:false,error:'device-id-required'}); continue; }
            if(targetId===deviceId){ actionAcks.push({actionId,type,ok:false,error:'cannot-delete-current-device'}); continue; }
            const hasActiveAssignedTask=Object.values(store.tasks).some(task=>text(task?.assignedDeviceId,120)===targetId && text(task?.status,30)==='accepted');
            if(hasActiveAssignedTask){ actionAcks.push({actionId,type,ok:false,error:'device-has-active-tasks'}); continue; }
            const existed=!!store.devices[targetId];
            if(existed) delete store.devices[targetId];
            actionAcks.push({actionId,type,ok:true,deviceId:targetId,deleted:existed});
            continue;
          }
          if(type==='delete-task'){
            const taskId=text(action?.taskId,120);
            if(!taskId){ actionAcks.push({actionId,type,ok:false,error:'task-id-required'}); continue; }
            const prior=store.tasks[taskId];
            if(!prior){ actionAcks.push({actionId,type,ok:true,taskId,deleted:false}); continue; }
            const status=text(prior?.status,30)||'pending';
            delete store.tasks[taskId];
            if(!store.deletedTasks || typeof store.deletedTasks!=='object') store.deletedTasks={};
            store.deletedTasks[taskId]={taskId,deletedAt:now,deletedByDeviceId:deviceId,deletedStatus:status};
            actionAcks.push({actionId,type,ok:true,taskId,deleted:true,status});
            continue;
          }
          actionAcks.push({actionId,type,ok:false,error:'unsupported-action'});
        }
      }
      const loggedLeadAccounts=new Set(nodeCapabilities.accounts.filter(row=>row.loggedIn===true&&['tiktok','metabusiness','facebook','instagram'].includes(String(row.platform||''))).map(row=>`${String(row.platform||'')}|${String(row.accountId||'')}`));
      const hasDynamicCapabilityInventory=Array.isArray(nodeCapabilities.accounts)&&nodeCapabilities.accounts.length>0;
      if(deviceId){store.devices[deviceId]={deviceId,deviceName:text(device.deviceName,120),role:text(device.role,30),dynamicRole:nodeCapabilities.dynamicRole,dynamicRoleLabel:dynamicRoleLabel(nodeCapabilities.dynamicRole),nodeCapabilities,lineEndpoints:Array.isArray(input.lineEndpoints)?input.lineEndpoints.slice(0,100):[],lastSeenAt:now};}
      for(const c of Array.isArray(input.customers)?input.customers:[]){const id=text(c?.globalCustomerId,120);if(!id)continue;store.customers[id]=mergeCustomerSnapshot(store.customers[id],{...c,globalCustomerId:id},now);}
      const taskAcks=[];
      for(const t of Array.isArray(input.tasks)?input.tasks:[]){
        const id=text(t?.taskId,120);if(!id)continue;
        if(store.deletedTasks && store.deletedTasks[id]){taskAcks.push({...t,taskId:id,status:'deleted',serverRejected:true,rejectReason:'task-deleted'});continue;}
        const prior=store.tasks[id];
        if(!prior){
          const sourceKey=`${text(t?.sourcePlatform,30).toLowerCase()}|${text(t?.sourceAccountId,128)}`;
          const canPublish=!hasDynamicCapabilityInventory || loggedLeadAccounts.has(sourceKey);
          if(!canPublish){taskAcks.push({...t,taskId:id,status:'rejected',serverRejected:true,rejectReason:'source-account-not-logged-as-lead'});continue;}
          store.tasks[id]={...t,taskId:id,publisherDeviceId:text(t?.publisherDeviceId||deviceId,120),publisherDeviceName:text(t?.publisherDeviceName||device.deviceName,120),createdAt:t.createdAt||now,updatedAt:now};taskAcks.push(store.tasks[id]);continue;
        }
        const incomingStatus=text(t.status,30)||'pending';
        const priorStatus=text(prior.status,30)||'pending';
        const currentEndpointKeys=new Set((Array.isArray(input.lineEndpoints)?input.lineEndpoints:[]).flatMap(ep=>lineIdentityAliases([ep?.logicalKey,ep?.mappedName,ep?.displayName,ep?.localAccountId])));
        const priorTargetAliases=lineIdentityAliases([prior.targetLineLogicalKey,prior.targetLineAccountName]);
        const canReceiveTask=priorTargetAliases.some(key=>currentEndpointKeys.has(key));
        const rank={pending:1,accepted:2,bound:3,completed:4,cancelled:5};
        const incomingDevice=text(t.assignedDeviceId,120); const priorDevice=text(prior.assignedDeviceId,120);
        let allow=false;
        if((rank[incomingStatus]||0)>(rank[priorStatus]||0)){
          if(incomingStatus==='accepted' && priorStatus!=='pending') allow=false;
          else if(['bound','completed'].includes(incomingStatus) && priorDevice && incomingDevice && priorDevice!==incomingDevice) allow=false;
          else allow=true;
        }else if(incomingStatus===priorStatus){
          if(priorStatus==='accepted' && priorDevice && incomingDevice && priorDevice!==incomingDevice) allow=false;
          else if(String(t.updatedAt||'')>=String(prior.updatedAt||'')) allow=true;
        }
        if(['accepted','bound','completed'].includes(incomingStatus) && !canReceiveTask) allow=false;
        if(allow) store.tasks[id]={...prior,...t,taskId:id,updatedAt:now};
        taskAcks.push(store.tasks[id]);
      }
      if(!store.deletedTasks || typeof store.deletedTasks!=='object') store.deletedTasks={};
      const tombstoneEntries=Object.entries(store.deletedTasks).sort((a,b)=>String(b[1]?.deletedAt||'').localeCompare(String(a[1]?.deletedAt||'')));
      if(tombstoneEntries.length>2000) store.deletedTasks=Object.fromEntries(tombstoneEntries.slice(0,2000));
      store.updatedAt=now; save();
      const deletedTaskIds=Object.keys(store.deletedTasks).slice(0,2000);
      const endpointKeys=new Set((Array.isArray(input.lineEndpoints)?input.lineEndpoints:[]).flatMap(ep=>lineIdentityAliases([ep?.logicalKey,ep?.mappedName,ep?.displayName,ep?.localAccountId])));
      const role=text(device.role,30); const currentDeviceId=deviceId;
      const visibleTasks=Object.values(store.tasks).filter(t=>{
        const targetAliases=lineIdentityAliases([t.targetLineLogicalKey,t.targetLineAccountName]);
        const targetMatches=targetAliases.some(key=>endpointKeys.has(key));
        const publishedByMe=text(t.publisherDeviceId,120)===currentDeviceId;
        if(role==='admin' || publishedByMe) return true;
        if(!endpointKeys.size || !targetMatches) return false;
        // Return the matching task even when another employee has already claimed
        // it. The client renders that state read-only, which also clears stale
        // pending cards after a competing device wins the claim.
        return true;
      }).map(t=>{
        // The task is the routing envelope. The customer snapshot is always
        // refreshed from the team-wide customer store so edits made after the
        // initial handoff (including on the bound LINE computer) travel back to
        // every device without creating a second customer.
        const latestCustomer=store.customers[text(t.globalCustomerId,120)] || t.customer || {};
        const targetAliases=lineIdentityAliases([t.targetLineLogicalKey,t.targetLineAccountName]);
        const eligibleOnThisDevice=targetAliases.some(key=>endpointKeys.has(key));
        return {...t,customer:latestCustomer,eligibleOnThisDevice};
      }).sort((a,b)=>String(b.updatedAt||b.createdAt).localeCompare(String(a.updatedAt||a.createdAt))).slice(0,500);
      const nowMs=Date.parse(now)||Date.now();
      const devices=Object.values(store.devices).map(row=>{
        const lastSeenAt=text(row?.lastSeenAt,80); const ageMs=Math.max(0,nowMs-(Date.parse(lastSeenAt)||0));
        return {deviceId:text(row?.deviceId,120),deviceName:text(row?.deviceName,120),role:text(row?.role,30),dynamicRole:text(row?.dynamicRole,30),dynamicRoleLabel:text(row?.dynamicRoleLabel,80),nodeCapabilities:normalizeNodeCapabilities(row?.nodeCapabilities||{}),lineEndpoints:Array.isArray(row?.lineEndpoints)?row.lineEndpoints.slice(0,100):[],lastSeenAt,online:ageMs<=30000};
      }).sort((a,b)=>String(b.lastSeenAt||'').localeCompare(String(a.lastSeenAt||''))).slice(0,200);
      const onlineDevices=devices.filter(d=>d.online);
      const stats={devices:onlineDevices.length,devicesTotal:devices.length,acquisitionNodes:onlineDevices.filter(d=>['lead','dual'].includes(d.dynamicRole)).length,handoffNodes:onlineDevices.filter(d=>['handoff','dual'].includes(d.dynamicRole)).length,dualNodes:onlineDevices.filter(d=>d.dynamicRole==='dual').length,customers:Object.keys(store.customers).length,pending:Object.values(store.tasks).filter(t=>t.status==='pending').length,accepted:Object.values(store.tasks).filter(t=>t.status==='accepted').length,bound:Object.values(store.tasks).filter(t=>t.status==='bound'||t.status==='completed').length};
      respond(res,200,{ok:true,serverTime:now,tasks:visibleTasks,taskAcks,deletedTaskIds,actionAcks,stats,devices});
    });
  });
  return {
    server,
    start:()=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.off('error',reject);resolve({ok:true,port:Number(server.address()?.port||port)});});}),
    stop:()=>new Promise(resolve=>{
      try{
        server.close(()=>{try{if(pretranslationStartupTimer)clearTimeout(pretranslationStartupTimer);}catch{} try{if(pretranslationTimer)clearInterval(pretranslationTimer);}catch{} try{pretranslationMetaDb?.close();}catch{} try{pretranslationLineDb?.close();}catch{} try{sqlite?.exec('PRAGMA optimize;');}catch{} try{sqlite?.close();}catch{} try{gptSqlite?.exec('PRAGMA optimize;');}catch{} try{gptSqlite?.close();}catch{} try{aiService.close();}catch{} try{metaGateway.close();}catch{} try{lineGateway.close();}catch{} resolve({ok:true});});
      }catch{resolve({ok:true});}
    }),
    getStore:()=>store,
    getTranslationCache:()=>({version:4,storage:sqliteStorage,databaseFile:cacheDbFile,cacheEntries:cacheCount,cacheMax:tg.cacheMax}),
    getGptOrchestrator:()=>({version:'v127237-gpt-lite-stage3',routerVersion:'v0.9.18-server-offload-phase2',storage:gptStorage,databaseFile:gptOrchestratorDbFile,entries:gptSqlite?Number(gptCountStmt.get()?.count||0):0,contextEntries:gptSqlite?Number(gptContextCountStmt.get()?.count||0):0,taskEntries:gptSqlite?Number(gptTaskCountStmt.get()?.count||0):0}),
    getGatewayStatus:()=>({version:'v0.9.18-server-offload-phase2',meta:metaGateway.status?.()||{},line:lineGateway.status?.()||{}})
  };
}
module.exports={createTeamSyncServer};
