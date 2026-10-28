'use strict';
const { postJson } = require('./team-sync-client');
const { normalizeTeamSettings } = require('./team-sync-core');

const VERSION='v127237-gpt-lite-stage3';
const STATE_KEYS=['bindings','customerMessageDeliveryReceipts','replyDeliveryReceipts','replyFreshnessLocks','replyDirectSendReceipts','customerChatModes','pendingAutoBinds','manualCustomerDrafts'];

function settingsFor(raw={}){
  const s=normalizeTeamSettings(raw||{});
  return s.enabled&&s.serverUrl&&s.teamId&&s.apiKey?s:null;
}
function baseHeaders(s){return {'x-yoko-team-id':s.teamId,'x-yoko-api-key':s.apiKey};}
function scopeFor(s){return `device:${String(s.deviceId||'desktop').replace(/[^A-Za-z0-9._:@-]/g,'').slice(0,120)||'desktop'}`;}
function endpoint(s,path=''){return `${s.serverUrl.replace(/\/+$/,'')}${path}`;}
async function getState(raw={},keys=STATE_KEYS,timeoutMs=2800){
  const s=settingsFor(raw);if(!s)return {ok:false,skipped:true,error:'team-sync-disabled'};
  const wanted=(Array.isArray(keys)?keys:STATE_KEYS).filter(k=>STATE_KEYS.includes(String(k))).slice(0,16);
  return postJson(endpoint(s,'/api/gpt-orchestrator/state/get'),baseHeaders(s),{scope:scopeFor(s),keys:wanted},timeoutMs);
}
async function putState(raw={},items=[],timeoutMs=2800){
  const s=settingsFor(raw);if(!s)return {ok:false,skipped:true,error:'team-sync-disabled'};
  const rows=(Array.isArray(items)?items:[]).filter(row=>row&&STATE_KEYS.includes(String(row.key))).slice(0,16);
  if(!rows.length)return {ok:true,skipped:true,stored:0};
  return postJson(endpoint(s,'/api/gpt-orchestrator/state/put'),baseHeaders(s),{scope:scopeFor(s),writerDeviceId:String(s.deviceId||''),items:rows},timeoutMs);
}
async function putContext(raw={},targetKey='',snapshot={},historyIndex=[],timeoutMs=1800){
  const s=settingsFor(raw);if(!s)return {ok:false,skipped:true,error:'team-sync-disabled'};
  return postJson(endpoint(s,'/api/gpt-orchestrator/context/put'),baseHeaders(s),{
    scope:scopeFor(s),targetKey:String(targetKey||''),snapshot:snapshot&&typeof snapshot==='object'?snapshot:{},historyIndex:Array.isArray(historyIndex)?historyIndex:[],writerDeviceId:String(s.deviceId||'')
  },timeoutMs);
}
async function getContext(raw={},targetKey='',timeoutMs=1600){
  const s=settingsFor(raw);if(!s)return {ok:false,skipped:true,error:'team-sync-disabled'};
  return postJson(endpoint(s,'/api/gpt-orchestrator/context/get'),baseHeaders(s),{scope:scopeFor(s),targetKey:String(targetKey||'')},timeoutMs);
}

async function recentContexts(raw={},limit=8,timeoutMs=1500){
  const s=settingsFor(raw);if(!s)return {ok:false,skipped:true,error:'team-sync-disabled'};
  const safeLimit=Math.max(1,Math.min(24,Number(limit||8)||8));
  return postJson(endpoint(s,'/api/gpt-orchestrator/context/recent'),baseHeaders(s),{scope:scopeFor(s),limit:safeLimit},timeoutMs);
}
async function composePrompt(raw={},payload={},timeoutMs=1200){
  const s=settingsFor(raw);if(!s)return {ok:false,skipped:true,error:'team-sync-disabled'};
  return postJson(endpoint(s,'/api/gpt-orchestrator/prompt/compose'),baseHeaders(s),{scope:scopeFor(s),...(payload&&typeof payload==='object'?payload:{})},timeoutMs);
}
async function enqueueTask(raw={},task={},timeoutMs=1400){
  const s=settingsFor(raw);if(!s)return {ok:false,skipped:true,error:'team-sync-disabled'};
  return postJson(endpoint(s,'/api/gpt-orchestrator/task/enqueue'),baseHeaders(s),{scope:scopeFor(s),writerDeviceId:String(s.deviceId||''),task:task&&typeof task==='object'?task:{}},timeoutMs);
}
async function updateTask(raw={},task={},timeoutMs=1400){
  const s=settingsFor(raw);if(!s)return {ok:false,skipped:true,error:'team-sync-disabled'};
  return postJson(endpoint(s,'/api/gpt-orchestrator/task/update'),baseHeaders(s),{scope:scopeFor(s),writerDeviceId:String(s.deviceId||''),task:task&&typeof task==='object'?task:{}},timeoutMs);
}
async function listTasks(raw={},query={},timeoutMs=1400){
  const s=settingsFor(raw);if(!s)return {ok:false,skipped:true,error:'team-sync-disabled'};
  return postJson(endpoint(s,'/api/gpt-orchestrator/task/list'),baseHeaders(s),{scope:scopeFor(s),...(query&&typeof query==='object'?query:{})},timeoutMs);
}
async function health(raw={},timeoutMs=2200){
  const s=settingsFor(raw);if(!s)return {ok:false,skipped:true,error:'team-sync-disabled'};
  // GET health is intentionally avoided here because the shared team client is POST-only.
  // A zero-key state lookup is an authenticated readiness probe and also works through older proxies.
  const result=await postJson(endpoint(s,'/api/gpt-orchestrator/state/get'),baseHeaders(s),{scope:scopeFor(s),keys:[]},timeoutMs);
  return {...result,service:'yoko-gpt-orchestrator',version:VERSION};
}
module.exports={VERSION,STATE_KEYS,settingsFor,scopeFor,getState,putState,putContext,getContext,recentContexts,composePrompt,enqueueTask,updateTask,listTasks,health};
