'use strict';

function clean(value,max=1000){ return String(value==null?'':value).replace(/\u0000/g,'').trim().slice(0,max); }
function normalizeGatewayUrl(value=''){
  let raw=clean(value,1000); if(!raw)return '';
  let parsed; try{parsed=new URL(raw);}catch{throw new Error('VPS 共享翻译缓存地址无效。');}
  if(!['http:','https:'].includes(parsed.protocol))throw new Error('VPS 共享翻译缓存只支持 HTTP/HTTPS。');
  return parsed.toString().replace(/\/+$/,'');
}

function canonicalSourceLanguage(value='auto',sourceText=''){
  const raw=clean(value,20).toLowerCase().replace('_','-');
  const aliases={jp:'ja',jpn:'ja',ja_jp:'ja',cn:'zh',zhcn:'zh','zh-cn':'zh','zh-tw':'zh',eng:'en',kr:'ko',kor:'ko'};
  const normalized=aliases[raw]||raw||'auto';
  if(normalized!=='auto'&&normalized!=='detect'&&normalized!=='und')return normalized;
  const text=clean(sourceText,12000);
  if(/[ぁ-ゖァ-ヺー]/u.test(text))return 'ja';
  if(/[가-힣]/u.test(text))return 'ko';
  if(/[Ѐ-ӿ]/u.test(text))return 'ru';
  if(/[؀-ۿ]/u.test(text))return 'ar';
  if(/[฀-๿]/u.test(text))return 'th';
  if(/[㐀-鿿]/u.test(text))return 'zh';
  const latin=(text.match(/[A-Za-z]/g)||[]).length;
  const letters=(text.match(/[A-Za-zÀ-ÿ]/g)||[]).length;
  if(latin>=2&&latin>=letters*0.75)return 'en';
  return 'auto';
}

function gatewayReady(settings={}){
  try{return !!normalizeGatewayUrl(settings.serverUrl)&&!!clean(settings.teamId,100)&&!!clean(settings.apiKey,300)&&settings.enabled!==false;}catch{return false;}
}
function headers(settings={},body=''){
  return {
    'x-yoko-team-id':clean(settings.teamId,100),
    'x-yoko-api-key':clean(settings.apiKey,300),
    'content-type':'application/json; charset=utf-8',accept:'application/json',
    'content-length':Buffer.byteLength(body),'user-agent':'Yoko-SCRM/1.27.131'
  };
}
function timeout(settings={},fallback=900){
  return Math.max(350,Math.min(5000,Number(settings.lookupTimeoutMs||settings.timeoutMs||fallback)||fallback));
}
async function gatewayCacheLookup(settings={},payload={},requestJson){
  if(!gatewayReady(settings))throw new Error('VPS 共享翻译缓存尚未配置。');
  const body=JSON.stringify({items:[{id:'one',text:clean(payload.text,12000),source:canonicalSourceLanguage(payload.source,payload.text),target:clean(payload.target,20)||'zh'}]});
  const data=await requestJson(`${normalizeGatewayUrl(settings.serverUrl)}/api/translation/cache/lookup`,{method:'POST',timeout:timeout(settings,900),hardTimeoutMs:timeout(settings,900)+250,headers:headers(settings,body)},body);
  const row=Array.isArray(data?.items)?data.items[0]:null;
  if(!data?.ok)throw new Error(clean(data?.error||'VPS 共享翻译缓存查询失败。',500));
  if(!row?.hit||!clean(row?.translated,20000))return {hit:false,hash:clean(row?.hash,128)};
  return {hit:true,translated:clean(row.translated,20000),hash:clean(row.hash,128),updatedAt:clean(row.updatedAt,80)};
}
async function gatewayCacheLookupBatch(settings={},items=[],requestJson){
  if(!gatewayReady(settings))throw new Error('VPS 共享翻译缓存尚未配置。');
  const rows=(Array.isArray(items)?items:[]).slice(0,128).map((payload,index)=>({
    id:clean(payload?.id||`row-${index}`,120),
    text:clean(payload?.text,12000),
    source:canonicalSourceLanguage(payload?.source,payload?.text),
    target:clean(payload?.target,20)||'zh'
  })).filter(row=>row.text);
  if(!rows.length)return {ok:true,items:[],hits:0,misses:0};
  const body=JSON.stringify({items:rows});
  const data=await requestJson(`${normalizeGatewayUrl(settings.serverUrl)}/api/translation/cache/lookup`,{method:'POST',timeout:timeout(settings,900),hardTimeoutMs:timeout(settings,900)+250,headers:headers(settings,body)},body);
  if(!data?.ok)throw new Error(clean(data?.error||'VPS 共享翻译缓存批量查询失败。',500));
  const returned=Array.isArray(data?.items)?data.items:[];
  return {
    ok:true,
    items:returned.map((row,index)=>({
      id:clean(row?.id||rows[index]?.id||`row-${index}`,120),
      hit:row?.hit===true&&!!clean(row?.translated,20000),
      translated:clean(row?.translated,20000),
      hash:clean(row?.hash,128),
      updatedAt:clean(row?.updatedAt,80)
    })),
    hits:Number(data?.hits||0),
    misses:Number(data?.misses||0)
  };
}
async function gatewayCachePut(settings={},payload={},requestJson){
  if(!gatewayReady(settings))throw new Error('VPS 共享翻译缓存尚未配置。');
  const body=JSON.stringify({items:[{
    id:'one',
    text:clean(payload.text,12000),
    translated:clean(payload.translated,20000),
    source:canonicalSourceLanguage(payload.source,payload.text),
    target:clean(payload.target,20)||'zh',
    engine:clean(payload.engine,120)
  }]});
  const data=await requestJson(`${normalizeGatewayUrl(settings.serverUrl)}/api/translation/cache/store`,{method:'POST',timeout:Math.max(800,timeout(settings,1800)),hardTimeoutMs:Math.max(800,timeout(settings,1800))+250,headers:headers(settings,body)},body);
  const row=Array.isArray(data?.items)?data.items[0]:null;
  if(!data?.ok||!row?.ok)throw new Error(clean(row?.error||data?.error||'VPS 共享翻译缓存写入失败。',500));
  return {ok:true,hash:clean(row.hash,128),stored:row.stored===true,replaced:row.replaced===true};
}

async function gatewayTranslateOne(settings={},payload={},requestJson){
  if(!gatewayReady(settings))throw new Error('VPS 翻译网关尚未配置。');
  const text=clean(payload.text,12000);
  if(!text)return {ok:false,translated:'',error:'empty-text'};
  const body=JSON.stringify({items:[{
    id:'one',
    text,
    source:canonicalSourceLanguage(payload.source,payload.text),
    target:clean(payload.target,20)||'zh',
    direction:'incoming'
  }]});
  const providerTimeout=Math.max(1200,Math.min(8000,Number(settings.providerTimeoutMs||5000)||5000));
  const data=await requestJson(`${normalizeGatewayUrl(settings.serverUrl)}/api/translation/translate`,{method:'POST',timeout:providerTimeout,hardTimeoutMs:providerTimeout+250,headers:headers(settings,body)},body);
  const row=Array.isArray(data?.items)?data.items[0]:null;
  if(!data?.ok||!row?.ok||!clean(row?.translated,20000))throw new Error(clean(row?.error||data?.error||'VPS DeepL 翻译失败。',500));
  return {
    ok:true,
    translated:clean(row.translated,20000),
    provider:clean(row.provider,80)||'deepl',
    cacheHit:row.cacheHit===true,
    hash:clean(row.hash,128),
    detectedSourceLanguage:clean(row.detectedSourceLanguage,20),
    elapsedMs:Number(row.elapsedMs||data?.elapsedMs||0)||0
  };
}


async function gatewayPretranslateBatch(settings={},items=[],sourceTag='external',requestJson){
  if(!gatewayReady(settings))throw new Error('VPS 服务器预翻译尚未配置。');
  const rows=(Array.isArray(items)?items:[]).slice(0,128).map((payload,index)=>({
    id:clean(payload?.id||payload?.messageId||`row-${index}`,120),
    platform:clean(payload?.platform||sourceTag,40).toLowerCase(),
    direction:'incoming',
    text:clean(payload?.text,12000),
    source:canonicalSourceLanguage(payload?.source,payload?.text),
    target:clean(payload?.target,20)||'zh',
    timestampMs:Number(payload?.timestampMs||Date.now())||Date.now()
  })).filter(row=>row.text);
  if(!rows.length)return {ok:true,queued:0};
  const body=JSON.stringify({sourceTag:clean(sourceTag,40)||'external',items:rows});
  const data=await requestJson(`${normalizeGatewayUrl(settings.serverUrl)}/api/translation/pretranslate`,{method:'POST',timeout:Math.max(800,timeout(settings,1200)),hardTimeoutMs:Math.max(800,timeout(settings,1200))+250,headers:headers(settings,body)},body);
  if(!data?.ok)throw new Error(clean(data?.error||'VPS 服务器预翻译排队失败。',500));
  return {ok:true,queued:Number(data?.queued||0),preTranslation:data?.preTranslation||{}};
}

async function gatewayHealth(settings={},requestJson){
  if(!gatewayReady(settings))return {ok:false,configured:false};
  try{
    const body='';
    const data=await requestJson(`${normalizeGatewayUrl(settings.serverUrl)}/api/translation/health`,{method:'GET',timeout:1800,hardTimeoutMs:2050,headers:{...headers(settings,body),'content-length':0}},body);
    return {configured:true,...(data||{})};
  }catch(error){return {ok:false,configured:true,error:String(error?.message||error)};}
}
module.exports={normalizeGatewayUrl,gatewayReady,gatewayCacheLookup,gatewayCacheLookupBatch,gatewayCachePut,gatewayTranslateOne,gatewayPretranslateBatch,gatewayHealth,canonicalSourceLanguage};
