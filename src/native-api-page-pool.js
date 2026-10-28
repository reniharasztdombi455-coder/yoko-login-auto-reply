'use strict';

const DEFAULT_SERVER_URL='https://team.dalongvpn.cc.cd';
function text(value='',max=20000){return String(value??'').replace(/\u0000/g,'').trim().slice(0,max);}
function createNativeApiPagePoolClient({fetchImpl=global.fetch,logger=()=>{}}={}){
  if(typeof fetchImpl!=='function')throw new Error('fetch-unavailable');
  let cache={at:0,pages:[]};
  function connection(settings={}){
    const base=text(settings.cloudflarePublicUrl||settings.serverUrl||DEFAULT_SERVER_URL,600).replace(/\/+$/,'');
    const sessionToken=text(settings.sessionToken||settings.officialApiSessionToken,2000);
    const teamId=text(settings.teamId,160),apiKey=text(settings.apiKey,500);
    if(!base)throw new Error('团队服务器地址为空。');
    if(!sessionToken&&(!teamId||!apiKey))throw new Error('请先登录 VPS 账号，或配置团队服务器 Team ID / API Key。');
    return {base,sessionToken,teamId,apiKey};
  }
  async function request(settings,pathname,{method='GET',body=null,timeoutMs=10000}={}){
    const {base,sessionToken,teamId,apiKey}=connection(settings);const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),Math.max(1000,Number(timeoutMs)||10000));
    try{
      const response=await fetchImpl(`${base}${pathname}`,{method:String(method||'GET').toUpperCase(),headers:{accept:'application/json',...(sessionToken?{authorization:`Bearer ${sessionToken}`}:{'x-yoko-team-id':teamId,'x-yoko-api-key':apiKey}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal});
      const raw=await response.text();let data={};try{data=raw?JSON.parse(raw):{};}catch{data={raw:text(raw,4000)};}
      if(!response.ok||data?.ok===false){const error=new Error(text(data?.message||data?.error||`HTTP ${response.status}`,500)||`HTTP ${response.status}`);error.status=response.status;error.details=data;throw error;}
      return data;
    }catch(error){if(error?.name==='AbortError')throw new Error('Facebook API 账号池请求超时。');throw error;}finally{clearTimeout(timer);}
  }
  async function inboxGet(settings){return request(settings,'/api/workspace/inboxes/get',{method:'POST',body:{},timeoutMs:12000});}
  async function inboxPut(settings,{layout,expectedVersion}){return request(settings,'/api/workspace/inboxes/put',{method:'POST',body:{layout,expectedVersion},timeoutMs:12000});}
  function normalizePages(value=[]){return (Array.isArray(value)?value:[]).map(row=>({pageId:text(row?.pageId,180),name:text(row?.name,300),enabled:row?.enabled!==false,tokenConfigured:!!row?.tokenConfigured,legacy:!!row?.legacy,updatedAt:text(row?.updatedAt,80)})).filter(row=>row.pageId||row.legacy);}
  async function list(settings,{fresh=false}={}){
    if(!fresh&&cache.pages.length&&Date.now()-cache.at<30000)return {ok:true,pages:cache.pages,count:cache.pages.length,cached:true};
    const result=await request(settings,'/api/meta/pages',{timeoutMs:9000});cache={at:Date.now(),pages:normalizePages(result?.pages)};return {...result,pages:cache.pages,count:cache.pages.length};
  }
  async function upsert(settings,page={}){
    const body={pageId:text(page?.pageId,180),name:text(page?.name,300),pageAccessToken:text(page?.pageAccessToken||page?.token,8000),enabled:page?.enabled!==false};
    const result=await request(settings,'/api/meta/pages/upsert',{method:'POST',body,timeoutMs:15000});cache={at:0,pages:[]};return {...result,page:result?.page?normalizePages([result.page])[0]:null,pages:normalizePages(result?.pages)};
  }
  async function toggle(settings,pageId,enabled=true){const result=await request(settings,'/api/meta/pages/toggle',{method:'POST',body:{pageId:text(pageId,180),enabled:enabled!==false},timeoutMs:9000});cache={at:0,pages:[]};return {...result,page:result?.page?normalizePages([result.page])[0]:null,pages:normalizePages(result?.pages)};}
  async function remove(settings,pageId){const result=await request(settings,'/api/meta/pages/remove',{method:'POST',body:{pageId:text(pageId,180)},timeoutMs:9000});cache={at:0,pages:[]};return {...result,pages:normalizePages(result?.pages)};}
  async function autoReplySettings(settings){return request(settings,'/api/meta/auto-reply/settings',{timeoutMs:10000});}
  async function saveAutoReplySettings(settings,{pageId,enabled,replyText}={}){return request(settings,'/api/meta/auto-reply/settings',{method:'POST',body:{pageId:text(pageId,180),enabled:enabled===true,replyText:String(replyText??'').replace(/\u0000/g,'').trim().slice(0,2000)},timeoutMs:10000});}
  
async function decorateConversations(settings,result={}){
    const items=Array.isArray(result?.items)?result.items:[];if(!items.some(row=>String(row?.platform||'').toLowerCase()==='facebook'))return result;
    try{
      const pages=(await list(settings)).pages;const names=new Map(pages.map(row=>[String(row.pageId||''),String(row.name||'')]).filter(([id])=>id));
      return {...result,items:items.map(row=>{if(String(row?.platform||'').toLowerCase()!=='facebook')return row;const pageId=String(row?.pageId||'');const name=names.get(pageId)||String(row?.accountName||'');return name?{...row,accountName:name}:row;})};
    }catch(error){logger('native-api-page-pool-decorate-error',{error:String(error?.message||error)});return result;}
  }
  return {list,upsert,toggle,remove,inboxGet,inboxPut,autoReplySettings,saveAutoReplySettings,decorateConversations,invalidate:()=>{cache={at:0,pages:[]};}};
}
module.exports={createNativeApiPagePoolClient,DEFAULT_SERVER_URL};
