'use strict';
// Client adapter for existing Yoko team sync base URL. Keep bearer token in process memory,
// never write it to logs or renderer localStorage.
class AiServiceClient {
  constructor(baseUrl){this.baseUrl=String(baseUrl||'').replace(/\/$/,'');this.token='';}
  async request(route, data, method='POST'){
    if(!/^https:\/\//i.test(this.baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(this.baseUrl))throw Error('HTTPS required for remote server');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),route==='/api/ai/meta/simulate'?30000:20000);
    try{const response=await fetch(this.baseUrl+route,{method,headers:{'content-type':'application/json',...(this.token?{authorization:'Bearer '+this.token}:{})},...(method==='GET'?{}:{body:JSON.stringify(data||{})}),signal:controller.signal});const output=await response.json();if(!response.ok)throw Error(output.error||`HTTP ${response.status}`);return output;}finally{clearTimeout(timer);}
  }
  async login(username,password){const r=await this.request('/api/ai/accounts/login',{username,password});this.token=r.token;return r.user;}
  me(){return this.request('/api/ai/accounts/me',undefined,'GET');}
  users(){return this.request('/api/ai/accounts/users',undefined,'GET');}
  createUser(input){return this.request('/api/ai/accounts/users',input);}
  manageUser(userId,action,fields={}){return this.request('/api/ai/accounts/manage',{userId,action,...fields});}
  accountAudit(limit=30){return this.request('/api/ai/accounts/audit?limit='+Math.max(1,Math.min(100,Number(limit)||30)),undefined,'GET');}
  metaInboxPreview(limit=30,pageId=''){return this.request(`/api/ai/meta/inbox-preview?limit=${Math.max(1,Math.min(100,Number(limit)||30))}&pageId=${encodeURIComponent(pageId)}`,undefined,'GET');}
  providerSettings(){return this.request('/api/ai/provider/settings',undefined,'GET');}
  saveProviderSettings(input){return this.request('/api/ai/provider/settings',input);}
  testProvider(){return this.request('/api/ai/provider/test',{});}
  simulateReception(pageId,turns){return this.request('/api/ai/meta/simulate',{pageId,turns});}
  metaPages(){return this.request('/api/ai/meta/pages',undefined,'GET');}
  metaCustomers(pageId,offset=0){return this.request('/api/ai/meta/customers?pageId='+encodeURIComponent(pageId)+'&offset='+offset,undefined,'GET');}
  getReceptionFlow(pageId){return this.request('/api/ai/meta/reception-flow?pageId='+encodeURIComponent(pageId),undefined,'GET');}
  saveReceptionFlow(flow){return this.request('/api/ai/meta/reception-flow',flow);}
  setPageMode(pageId,mode,expectedRevision){return this.request('/api/ai/meta/page-mode',{pageId,mode,expectedRevision});}
  processMetaInbox(limit=3,{locale='auto',useAi=false,pageId=''}={}){return this.request('/api/ai/meta/process',{limit,locale,useAi,pageId});}
  getCustomerMode(customerId){return this.request('/api/ai/customer/mode?customerId='+encodeURIComponent(customerId),undefined,'GET');}
  setCustomerMode(customerId,mode,expectedRevision){return this.request('/api/ai/customer/mode',{customerId,mode,expectedRevision});}
  draftReply(input){return this.request('/api/ai/reply',input);}
  claimDelivery(interactionId,owner){return this.request('/api/ai/delivery/claim',{interactionId,owner});}
  completeDelivery(interactionId,claimToken,result,providerMessageId='',error=''){return this.request('/api/ai/delivery/complete',{interactionId,claimToken,result,providerMessageId,error});}
  deliveryStatus(interactionId){return this.request('/api/ai/delivery/status?interactionId='+encodeURIComponent(interactionId),undefined,'GET');}
  readyDeliveryQueue(limit=20){return this.request('/api/ai/delivery/ready-queue?limit='+Math.max(1,Math.min(50,Number(limit)||20)),undefined,'GET');}
  reconcileDeliveryQueue(limit=30){return this.request('/api/ai/delivery/reconcile-queue?limit='+Math.max(1,Math.min(100,Number(limit)||30)),undefined,'GET');}
  dispatchApprovedAnswer(interactionId){return this.request('/api/ai/delivery/dispatch',{interactionId});}
  queueAnswer(input){return this.request('/api/ai/qa',input);}
  approveAnswer(id){return this.request('/api/ai/qa/approve',{id});}
  rejectAnswer(id){return this.request('/api/ai/qa/reject',{id});}
  batchReviewAnswers(ids,status){return this.request('/api/ai/qa/batch-review',{ids,status});}
  qaAudit(limit=30){return this.request('/api/ai/qa/audit?limit='+Math.max(1,Math.min(100,Number(limit)||30)),undefined,'GET');}
  getWorkspaceState(key){return this.request('/api/ai/workspace/state?key='+encodeURIComponent(key),undefined,'GET');}
  putWorkspaceState(key,value,expectedRevision){return this.request('/api/ai/workspace/state',{key,value,expectedRevision});}
  claimHandoff(id,action='claim'){return this.request('/api/ai/handoffs/claim',{id,action});}
  handoffHistory(limit=30){return this.request('/api/ai/handoffs/history?limit='+Math.max(1,Math.min(100,Number(limit)||30)),undefined,'GET');}
  resolveHandoff(id,answer=''){return this.request('/api/ai/handoffs/resolve',{id,answer});}
  listAnswers(filters={}){const params=new URLSearchParams();for(const k of ['q','status','locale','limit'])if(filters[k])params.set(k,String(filters[k]));return this.request('/api/ai/qa'+(params.size?'?'+params.toString():''),undefined,'GET');}
  handoffs(){return this.request('/api/ai/handoffs',undefined,'GET');}
  healthSummary(){return this.request('/api/ai/health/summary',undefined,'GET');}
  recoveryHistory({limit=25}={}){return this.request('/api/ai/recovery/history?limit='+encodeURIComponent(limit),undefined,'GET');}
  daemonStatus(){return this.request('/api/ai/daemon/status',undefined,'GET');}
  usageSummary(limit=10){return this.request('/api/ai/usage/summary?limit='+Math.max(1,Math.min(50,Number(limit)||10)),undefined,'GET');}
  daemonHistory(limit=25){return this.request('/api/ai/daemon/history?limit='+Math.max(1,Math.min(100,Number(limit)||25)),undefined,'GET');}
  async logout(){try{if(this.token)await this.request('/api/ai/accounts/logout',{});}finally{this.token='';}}
}
module.exports={AiServiceClient};
