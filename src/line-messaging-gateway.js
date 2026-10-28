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
function verifyLineSignature(rawBody,signature,channelSecret){
  const sig=clean(signature,500);
  const secret=clean(channelSecret,1000);
  if(!sig||!secret)return false;
  const expected=crypto.createHmac('sha256',secret).update(rawBody).digest('base64');
  return timingSafeStringEqual(expected,sig);
}
function eventText(event={}){
  if(event?.type==='message'){
    const m=event.message||{};
    if(m.type==='text')return clean(m.text,20000);
    if(m.type==='image')return '[image]';
    if(m.type==='video')return '[video]';
    if(m.type==='audio')return '[audio]';
    if(m.type==='file')return `[file] ${clean(m.fileName,500)}`.trim();
    if(m.type==='location')return `[location] ${clean(m.title||m.address,1000)}`.trim();
    if(m.type==='sticker')return `[sticker] ${clean(m.packageId,100)}/${clean(m.stickerId,100)}`;
    return `[message:${clean(m.type,80)||'unknown'}]`;
  }
  if(event?.type==='postback')return clean(event?.postback?.data,4000);
  if(event?.type==='follow')return '[follow]';
  if(event?.type==='unfollow')return '[unfollow]';
  if(event?.type==='join')return '[join]';
  if(event?.type==='leave')return '[leave]';
  if(event?.type==='memberJoined')return '[memberJoined]';
  if(event?.type==='memberLeft')return '[memberLeft]';
  if(event?.type==='unsend')return `[unsend] ${clean(event?.unsend?.messageId,300)}`;
  return clean(event?.type,200);
}
function normalizeEvent(event={}){
  const source=event?.source||{};
  const sourceType=clean(source.type,40);
  const userId=clean(source.userId,180);
  const groupId=clean(source.groupId,180);
  const roomId=clean(source.roomId,180);
  const messageId=clean(event?.message?.id||event?.unsend?.messageId,300);
  const webhookEventId=clean(event?.webhookEventId,300);
  const eventType=clean(event?.type,80)||'other';
  const timestampMs=Number(event?.timestamp||Date.now())||Date.now();
  const payloadJson=JSON.stringify(event||{});
  const sourceId=userId||groupId||roomId;
  const eventKey=webhookEventId
    ? `webhook:${webhookEventId}`
    : messageId
      ? `${eventType}:message:${messageId}`
      : `${eventType}:${sourceType}:${sourceId}:${timestampMs}:${crypto.createHash('sha256').update(payloadJson).digest('hex').slice(0,24)}`;
  return {
    eventKey,
    eventType,
    sourceType,
    userId,
    groupId,
    roomId,
    sourceId,
    direction:'incoming',
    messageId,
    replyToken:clean(event?.replyToken,500),
    text:eventText(event),
    timestampMs,
    payloadJson
  };
}

function createLineMessagingGateway({
  enabled=true,
  channelSecret='',
  channelAccessToken='',
  databaseFile='',
  logger=()=>{}
}={}){
  const cfg={
    enabled:enabled!==false,
    channelSecret:clean(channelSecret,1000),
    channelAccessToken:clean(channelAccessToken,5000)
  };
  const dbFile=databaseFile?path.resolve(databaseFile):'';
  let sqlite=null;
  let sqliteReady=false;
  let insertEvent=null;
  let listRecent=null;
  let listConversations=null;
  let listConversation=null;
  let listConversationBefore=null;
  let countEvents=null;
  try{
    if(dbFile){
      const {DatabaseSync}=require('node:sqlite');
      fs.mkdirSync(path.dirname(dbFile),{recursive:true});
      sqlite=new DatabaseSync(dbFile);
      sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS line_events (
          event_key TEXT PRIMARY KEY,
          event_type TEXT NOT NULL DEFAULT '',
          source_type TEXT NOT NULL DEFAULT '',
          user_id TEXT NOT NULL DEFAULT '',
          group_id TEXT NOT NULL DEFAULT '',
          room_id TEXT NOT NULL DEFAULT '',
          source_id TEXT NOT NULL DEFAULT '',
          direction TEXT NOT NULL DEFAULT '',
          message_id TEXT NOT NULL DEFAULT '',
          reply_token TEXT NOT NULL DEFAULT '',
          text TEXT NOT NULL DEFAULT '',
          timestamp_ms INTEGER NOT NULL DEFAULT 0,
          payload_json TEXT NOT NULL,
          received_at TEXT NOT NULL
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_line_events_received_at ON line_events(received_at);
        CREATE INDEX IF NOT EXISTS idx_line_events_user_id ON line_events(user_id);
        CREATE INDEX IF NOT EXISTS idx_line_events_source_id ON line_events(source_id);
        CREATE INDEX IF NOT EXISTS idx_line_events_message_id ON line_events(message_id);
        -- V1.27.254: accelerate user conversation lists and ordered history reads.
        CREATE INDEX IF NOT EXISTS idx_line_events_message_user_time ON line_events(event_type,user_id,timestamp_ms DESC,received_at DESC,event_key DESC);
        CREATE INDEX IF NOT EXISTS idx_line_events_user_message_time ON line_events(user_id,event_type,timestamp_ms DESC,received_at DESC,event_key DESC);
      `);
      try{sqlite.exec('PRAGMA optimize;');}catch{}
      insertEvent=sqlite.prepare(`INSERT OR IGNORE INTO line_events(
        event_key,event_type,source_type,user_id,group_id,room_id,source_id,direction,message_id,reply_token,text,timestamp_ms,payload_json,received_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      listRecent=sqlite.prepare(`SELECT event_key AS eventKey,event_type AS eventType,source_type AS sourceType,
        user_id AS userId,group_id AS groupId,room_id AS roomId,source_id AS sourceId,direction,message_id AS messageId,
        text,timestamp_ms AS timestampMs,received_at AS receivedAt,payload_json AS payloadJson
        FROM line_events ORDER BY received_at DESC LIMIT ?`);
      listConversations=sqlite.prepare(`
        WITH base AS (
          SELECT event_key,user_id,direction,text,timestamp_ms,received_at
          FROM line_events
          WHERE event_type='message' AND user_id<>''
        ), ranked AS (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY timestamp_ms DESC, received_at DESC, event_key DESC) AS rn
          FROM base
        )
        SELECT user_id AS userId,
          MAX(timestamp_ms) AS lastTimestampMs,
          MAX(CASE WHEN direction='incoming' THEN timestamp_ms ELSE 0 END) AS lastIncomingAt,
          MIN(CASE WHEN direction='incoming' THEN timestamp_ms ELSE NULL END) AS firstIncomingAt,
          MAX(CASE WHEN direction='outgoing' THEN timestamp_ms ELSE 0 END) AS lastReplyAt,
          MAX(CASE WHEN rn=1 THEN direction ELSE '' END) AS lastDirection,
          MAX(CASE WHEN rn=1 THEN text ELSE '' END) AS preview,
          MAX(CASE WHEN rn=1 THEN event_key ELSE '' END) AS lastEventKey,
          COUNT(*) AS messageCount
        FROM ranked
        GROUP BY user_id
        ORDER BY lastTimestampMs DESC
        LIMIT ?`);
      listConversation=sqlite.prepare(`SELECT * FROM (
        SELECT event_key AS eventKey,event_type AS eventType,source_type AS sourceType,
          user_id AS userId,group_id AS groupId,room_id AS roomId,source_id AS sourceId,direction,message_id AS messageId,
          text,timestamp_ms AS timestampMs,received_at AS receivedAt,payload_json AS payloadJson
        FROM line_events
        WHERE event_type='message' AND user_id=?
        ORDER BY timestamp_ms DESC, received_at DESC, event_key DESC
        LIMIT ?
      ) ORDER BY timestampMs ASC, receivedAt ASC, eventKey ASC`);
      listConversationBefore=sqlite.prepare(`SELECT * FROM (
        SELECT event_key AS eventKey,event_type AS eventType,source_type AS sourceType,
          user_id AS userId,group_id AS groupId,room_id AS roomId,source_id AS sourceId,direction,message_id AS messageId,
          text,timestamp_ms AS timestampMs,received_at AS receivedAt,payload_json AS payloadJson
        FROM line_events
        WHERE event_type='message' AND user_id=?
          AND (timestamp_ms < ? OR (timestamp_ms = ? AND received_at < ?) OR (timestamp_ms = ? AND received_at = ? AND event_key < ?))
        ORDER BY timestamp_ms DESC, received_at DESC, event_key DESC
        LIMIT ?
      ) ORDER BY timestampMs ASC, receivedAt ASC, eventKey ASC`);
      countEvents=sqlite.prepare('SELECT COUNT(*) AS count FROM line_events');
      sqliteReady=true;
    }
  }catch(error){logger('line-sqlite-open-error',error);}

  const readBody=(req,maxBytes=2*1024*1024)=>new Promise((resolve,reject)=>{
    const chunks=[];let total=0;let done=false;
    req.on('data',chunk=>{
      if(done)return;total+=chunk.length;
      if(total>maxBytes){done=true;reject(Object.assign(new Error('payload-too-large'),{statusCode:413}));req.destroy();return;}
      chunks.push(chunk);
    });
    req.on('end',()=>{if(!done)resolve(Buffer.concat(chunks));});
    req.on('error',error=>{if(!done)reject(error);});
  });

  const storePayload=payload=>{
    let seen=0,inserted=0;
    const events=Array.isArray(payload?.events)?payload.events:[];
    const now=new Date().toISOString();
    for(const event of events){
      const row=normalizeEvent(event);seen++;
      const result=insertEvent.run(
        row.eventKey,row.eventType,row.sourceType,row.userId,row.groupId,row.roomId,row.sourceId,row.direction,
        row.messageId,row.replyToken,row.text,row.timestampMs,row.payloadJson,now
      );
      inserted+=Number(result?.changes||0);
    }
    return {seen,inserted};
  };

  const lineApi=async(endpoint,{method='GET',body}={})=>{
    if(!cfg.channelAccessToken)throw Object.assign(new Error('line-channel-access-token-not-configured'),{statusCode:503});
    const response=await fetch(`https://api.line.me${endpoint}`,{
      method,
      headers:{
        'authorization':`Bearer ${cfg.channelAccessToken}`,
        ...(body?{'content-type':'application/json'}:{})
      },
      ...(body?{body:JSON.stringify(body)}:{})
    });
    const raw=await response.text();
    const parsed=raw?safeJson(raw)||{raw:clean(raw,4000)}:{};
    if(!response.ok)throw Object.assign(new Error('line-api-failed'),{statusCode:502,lineStatus:response.status,details:parsed});
    return parsed;
  };

  const apiPushText=async(recipientId,messageText)=>lineApi('/v2/bot/message/push',{
    method:'POST',
    body:{to:clean(recipientId,180),messages:[{type:'text',text:clean(messageText,5000)}]}
  });

  const apiProfile=async(userId)=>lineApi(`/v2/bot/profile/${encodeURIComponent(clean(userId,180))}`);

  const persistOutgoingText=(recipientId,messageText,result={})=>{
    if(!sqliteReady||!insertEvent)return null;
    const now=Date.now();
    const messageId=clean(result?.sentMessages?.[0]?.id||result?.messageId,300) || `api-${crypto.randomUUID()}`;
    const eventKey=`api-outgoing:${messageId}`;
    const receivedAt=new Date(now).toISOString();
    const payloadJson=JSON.stringify({apiSend:true,result:result||{}});
    const r=insertEvent.run(eventKey,'message','user',clean(recipientId,180),'','',clean(recipientId,180),'outgoing',messageId,'',clean(messageText,20000),now,payloadJson,receivedAt);
    return {eventKey,messageId,timestampMs:now,receivedAt,inserted:Number(r?.changes||0)};
  };

  const handle=async(req,res,{auth=()=>false}={})=>{
    let url;
    try{url=new URL(req.url,'http://127.0.0.1');}catch{return false;}
    const pathname=url.pathname;
    if(pathname==='/line/webhook'){
      if(!cfg.enabled){text(res,503,'LINE_WEBHOOK_DISABLED');return true;}
      if(req.method!=='POST'){text(res,405,'Method Not Allowed');return true;}
      try{
        if(!cfg.channelSecret){text(res,503,'LINE_CHANNEL_SECRET_NOT_CONFIGURED');return true;}
        if(!sqliteReady){text(res,503,'LINE_STORAGE_NOT_READY');return true;}
        const raw=await readBody(req);
        const signature=req.headers['x-line-signature'];
        if(!verifyLineSignature(raw,signature,cfg.channelSecret)){text(res,403,'INVALID_SIGNATURE');return true;}
        const payload=safeJson(raw.toString('utf8'));
        if(!payload){text(res,400,'INVALID_JSON');return true;}
        const stats=storePayload(payload);
        logger('line-webhook-event',{destination:clean(payload.destination,180),events:Array.isArray(payload.events)?payload.events.length:0,...stats});
        text(res,200,'OK');return true;
      }catch(error){logger('line-webhook-error',error);text(res,Number(error?.statusCode||500),error?.message||'ERROR');return true;}
    }
    if(pathname==='/api/line/health'&&req.method==='GET'){
      if(!auth(req)){json(res,401,{ok:false,error:'unauthorized'});return true;}
      json(res,200,{
        ok:cfg.enabled&&sqliteReady,
        service:'yoko-line-messaging-gateway',
        enabled:cfg.enabled,
        channelSecretConfigured:!!cfg.channelSecret,
        channelAccessTokenConfigured:!!cfg.channelAccessToken,
        storage:sqliteReady?'sqlite':'unavailable',
        databaseFile:dbFile,
        events:sqliteReady?Number(countEvents.get()?.count||0):0,
        time:new Date().toISOString()
      });
      return true;
    }
    if(pathname==='/api/line/events/recent'&&req.method==='GET'){
      if(!auth(req)){json(res,401,{ok:false,error:'unauthorized'});return true;}
      if(!sqliteReady){json(res,503,{ok:false,error:'line-storage-unavailable'});return true;}
      const limit=Math.max(1,Math.min(200,Number(url.searchParams.get('limit')||50)||50));
      const rows=listRecent.all(limit).map(row=>({...row,payload:safeJson(row.payloadJson),payloadJson:undefined}));
      json(res,200,{ok:true,items:rows,count:rows.length});return true;
    }
    if(pathname==='/api/line/conversations'&&req.method==='GET'){
      if(!auth(req)){json(res,401,{ok:false,error:'unauthorized'});return true;}
      if(!sqliteReady){json(res,503,{ok:false,error:'line-storage-unavailable'});return true;}
      const limit=Math.max(1,Math.min(500,Number(url.searchParams.get('limit')||200)||200));
      const rows=listConversations.all(limit).map(row=>({...row,messageCount:Number(row.messageCount||0),lastTimestampMs:Number(row.lastTimestampMs||0),lastIncomingAt:Number(row.lastIncomingAt||0),firstIncomingAt:Number(row.firstIncomingAt||0),lastReplyAt:Number(row.lastReplyAt||0)}));
      json(res,200,{ok:true,items:rows,count:rows.length});return true;
    }
    if(pathname==='/api/line/conversation'&&req.method==='GET'){
      if(!auth(req)){json(res,401,{ok:false,error:'unauthorized'});return true;}
      if(!sqliteReady){json(res,503,{ok:false,error:'line-storage-unavailable'});return true;}
      const userId=clean(url.searchParams.get('userId'),180);
      if(!userId){json(res,400,{ok:false,error:'userId-required'});return true;}
      const limit=Math.max(1,Math.min(500,Number(url.searchParams.get('limit')||200)||200));
      const beforeTimestampMs=Math.max(0,Number(url.searchParams.get('beforeTimestampMs')||0)||0);
      const beforeReceivedAt=clean(url.searchParams.get('beforeReceivedAt'),120);
      const beforeEventKey=clean(url.searchParams.get('beforeEventKey'),500);
      const rawRows=beforeTimestampMs&&beforeReceivedAt&&beforeEventKey
        ? listConversationBefore.all(userId,beforeTimestampMs,beforeTimestampMs,beforeReceivedAt,beforeTimestampMs,beforeReceivedAt,beforeEventKey,limit)
        : listConversation.all(userId,limit);
      const rows=rawRows.map(row=>({...row,payload:safeJson(row.payloadJson),payloadJson:undefined}));
      const oldest=rows[0]||null;
      const nextCursor=oldest?{beforeTimestampMs:Number(oldest.timestampMs||0),beforeReceivedAt:clean(oldest.receivedAt,120),beforeEventKey:clean(oldest.eventKey,500)}:null;
      json(res,200,{ok:true,userId,items:rows,count:rows.length,hasMore:rows.length===limit,nextCursor});return true;
    }
    if(pathname==='/api/line/send'&&req.method==='POST'){
      if(!auth(req)){json(res,401,{ok:false,error:'unauthorized'});return true;}
      try{
        const raw=await readBody(req,256*1024);const input=safeJson(raw.toString('utf8'));
        if(!input){json(res,400,{ok:false,error:'invalid-json'});return true;}
        const recipientId=clean(input.recipientId||input.userId,180);const messageText=clean(input.text,5000);
        if(!recipientId||!messageText){json(res,400,{ok:false,error:'recipientId-and-text-required'});return true;}
        const result=await apiPushText(recipientId,messageText);
        const stored=persistOutgoingText(recipientId,messageText,result);
        json(res,200,{ok:true,result,stored});return true;
      }catch(error){logger('line-send-error',error);json(res,Number(error?.statusCode||500),{ok:false,error:error?.message||'send-failed',lineStatus:error?.lineStatus,details:error?.details});return true;}
    }
    if(pathname==='/api/line/profile'&&req.method==='GET'){
      if(!auth(req)){json(res,401,{ok:false,error:'unauthorized'});return true;}
      try{
        const userId=clean(url.searchParams.get('userId'),180);
        if(!userId){json(res,400,{ok:false,error:'userId-required'});return true;}
        const result=await apiProfile(userId);
        json(res,200,{ok:true,result});return true;
      }catch(error){logger('line-profile-error',error);json(res,Number(error?.statusCode||500),{ok:false,error:error?.message||'profile-failed',lineStatus:error?.lineStatus,details:error?.details});return true;}
    }
    return false;
  };

  return {
    handle,
    status:()=>({enabled:cfg.enabled,channelSecretConfigured:!!cfg.channelSecret,channelAccessTokenConfigured:!!cfg.channelAccessToken,sqliteReady,databaseFile:dbFile}),
    close:()=>{try{sqlite?.exec('PRAGMA optimize;');}catch{}try{sqlite?.close();}catch{}}
  };
}
module.exports={createLineMessagingGateway,verifyLineSignature};
