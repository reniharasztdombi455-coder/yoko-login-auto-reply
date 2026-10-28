'use strict';
const http=require('http');
const https=require('https');
const { URL }=require('url');
const { normalizeTeamSettings, text }=require('./team-sync-core');

function postJson(urlString, headers, payload, timeoutMs=6000){
  return new Promise((resolve,reject)=>{
    let u; try{u=new URL(urlString);}catch{return reject(new Error('团队服务器地址无效。'));}
    const lib=u.protocol==='https:'?https:http; const raw=JSON.stringify(payload||{});
    const req=lib.request({protocol:u.protocol,hostname:u.hostname,port:u.port||undefined,path:u.pathname+u.search,method:'POST',headers:{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(raw),...headers},timeout:timeoutMs},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>{let data={};try{data=JSON.parse(body||'{}');}catch{}if(res.statusCode<200||res.statusCode>=300)return reject(new Error(data.error||`HTTP ${res.statusCode}`));resolve(data);});});
    req.on('timeout',()=>req.destroy(new Error('团队服务器连接超时。'))); req.on('error',reject); req.end(raw);
  });
}
async function syncTeam(settingsRaw={}, payload={}){
  const settings=normalizeTeamSettings(settingsRaw); if(!settings.enabled) return {ok:false,skipped:true,error:'团队同步未启用'};
  if(!settings.teamId||!settings.apiKey) throw new Error('请先设置团队ID和同步密钥。');
  const base=settings.serverUrl.replace(/\/+$/,'');
  return postJson(`${base}/api/v1/sync`,{'x-yoko-team-id':settings.teamId,'x-yoko-api-key':settings.apiKey},{...payload,device:{deviceId:settings.deviceId,deviceName:settings.deviceName,role:settings.role}});
}
module.exports={postJson,syncTeam};
