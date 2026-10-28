'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WORKFLOW_STATES = Object.freeze({
  IDLE:'IDLE', SELECTED:'SELECTED', DATA_LOADING:'DATA_LOADING', GPT_PREPARING:'GPT_PREPARING',
  GPT_INITIALIZING:'GPT_INITIALIZING', GPT_BOUND:'GPT_BOUND', TURN_STAGING:'TURN_STAGING',
  GPT_WAITING:'GPT_WAITING', REVIEW_READY:'REVIEW_READY', CUSTOMER_SENDING:'CUSTOMER_SENDING',
  COMPLETED:'COMPLETED', BLOCKED:'BLOCKED', ERROR:'ERROR', RETRYING:'RETRYING', RECOVERY_REQUIRED:'RECOVERY_REQUIRED'
});

const ALLOWED = new Map([
  [WORKFLOW_STATES.IDLE, new Set(Object.values(WORKFLOW_STATES))],
  [WORKFLOW_STATES.SELECTED, new Set([WORKFLOW_STATES.DATA_LOADING,WORKFLOW_STATES.GPT_PREPARING,WORKFLOW_STATES.GPT_BOUND,WORKFLOW_STATES.TURN_STAGING,WORKFLOW_STATES.BLOCKED,WORKFLOW_STATES.ERROR,WORKFLOW_STATES.IDLE])],
  [WORKFLOW_STATES.DATA_LOADING, new Set([WORKFLOW_STATES.GPT_PREPARING,WORKFLOW_STATES.GPT_BOUND,WORKFLOW_STATES.TURN_STAGING,WORKFLOW_STATES.ERROR,WORKFLOW_STATES.BLOCKED])],
  [WORKFLOW_STATES.GPT_PREPARING, new Set([WORKFLOW_STATES.GPT_INITIALIZING,WORKFLOW_STATES.GPT_BOUND,WORKFLOW_STATES.ERROR,WORKFLOW_STATES.BLOCKED])],
  [WORKFLOW_STATES.GPT_INITIALIZING, new Set([WORKFLOW_STATES.GPT_BOUND,WORKFLOW_STATES.ERROR,WORKFLOW_STATES.BLOCKED,WORKFLOW_STATES.RECOVERY_REQUIRED])],
  [WORKFLOW_STATES.GPT_BOUND, new Set([WORKFLOW_STATES.TURN_STAGING,WORKFLOW_STATES.CUSTOMER_SENDING,WORKFLOW_STATES.SELECTED,WORKFLOW_STATES.ERROR,WORKFLOW_STATES.BLOCKED])],
  [WORKFLOW_STATES.TURN_STAGING, new Set([WORKFLOW_STATES.GPT_WAITING,WORKFLOW_STATES.REVIEW_READY,WORKFLOW_STATES.ERROR,WORKFLOW_STATES.BLOCKED,WORKFLOW_STATES.GPT_BOUND])],
  [WORKFLOW_STATES.GPT_WAITING, new Set([WORKFLOW_STATES.TURN_STAGING,WORKFLOW_STATES.REVIEW_READY,WORKFLOW_STATES.CUSTOMER_SENDING,WORKFLOW_STATES.ERROR,WORKFLOW_STATES.BLOCKED,WORKFLOW_STATES.GPT_BOUND])],
  [WORKFLOW_STATES.REVIEW_READY, new Set([WORKFLOW_STATES.CUSTOMER_SENDING,WORKFLOW_STATES.TURN_STAGING,WORKFLOW_STATES.GPT_BOUND,WORKFLOW_STATES.ERROR,WORKFLOW_STATES.BLOCKED])],
  [WORKFLOW_STATES.CUSTOMER_SENDING, new Set([WORKFLOW_STATES.COMPLETED,WORKFLOW_STATES.ERROR,WORKFLOW_STATES.BLOCKED])],
  [WORKFLOW_STATES.COMPLETED, new Set([WORKFLOW_STATES.SELECTED,WORKFLOW_STATES.GPT_BOUND,WORKFLOW_STATES.TURN_STAGING,WORKFLOW_STATES.CUSTOMER_SENDING,WORKFLOW_STATES.IDLE])],
  [WORKFLOW_STATES.BLOCKED, new Set([WORKFLOW_STATES.SELECTED,WORKFLOW_STATES.GPT_BOUND,WORKFLOW_STATES.ERROR,WORKFLOW_STATES.IDLE])],
  [WORKFLOW_STATES.ERROR, new Set([WORKFLOW_STATES.RETRYING,WORKFLOW_STATES.SELECTED,WORKFLOW_STATES.GPT_PREPARING,WORKFLOW_STATES.GPT_BOUND,WORKFLOW_STATES.RECOVERY_REQUIRED,WORKFLOW_STATES.IDLE])],
  [WORKFLOW_STATES.RETRYING, new Set([WORKFLOW_STATES.DATA_LOADING,WORKFLOW_STATES.GPT_PREPARING,WORKFLOW_STATES.GPT_INITIALIZING,WORKFLOW_STATES.GPT_BOUND,WORKFLOW_STATES.TURN_STAGING,WORKFLOW_STATES.GPT_WAITING,WORKFLOW_STATES.REVIEW_READY,WORKFLOW_STATES.CUSTOMER_SENDING,WORKFLOW_STATES.ERROR,WORKFLOW_STATES.BLOCKED,WORKFLOW_STATES.RECOVERY_REQUIRED,WORKFLOW_STATES.IDLE])],
  [WORKFLOW_STATES.RECOVERY_REQUIRED, new Set([WORKFLOW_STATES.SELECTED,WORKFLOW_STATES.GPT_PREPARING,WORKFLOW_STATES.GPT_BOUND,WORKFLOW_STATES.ERROR,WORKFLOW_STATES.IDLE])]
]);

function clean(value, n=180){ return String(value==null?'':value).replace(/[\r\n\t]+/g,' ').trim().slice(0,n); }
function safeResult(result={}) { return {ok:!!result?.ok, method:clean(result?.method,80), bound:!!result?.bound, pending:!!result?.pending, deduped:!!result?.deduped, targetChanged:!!result?.targetChanged, error:clean(result?.error,240)}; }

class WorkflowStabilityCore {
  constructor({fileResolver,version='v127266-workflow-stability-core',flushMs=180,maxJournal=300}={}){
    this.fileResolver=typeof fileResolver==='function'?fileResolver:()=>String(fileResolver||'');
    this.version=version; this.flushMs=flushMs; this.maxJournal=maxJournal;
    this.states=new Map(); this.chains=new Map(); this.pendingByTarget=new Map(); this.runningByTarget=new Map();
    this.inFlight=new Map(); this.recentSuccess=new Map(); this.journal=[]; this.interrupted=[]; this.sequence=0;
    this.dirty=false; this.flushTimer=null; this.retryPolicy={safeReadDelaysMs:[1000,3000,8000],mutatingReplay:'blocked-unless-existing-exactly-once-receipt'}; this.stats={enqueued:0,started:0,succeeded:0,failed:0,joined:0,dedupedRecent:0,illegalTransitions:0,recoveredInterrupted:0,selfHealRuns:0,selfHealActions:0,selfHealStaleStates:0,selfHealStaleIdempotency:0,selfHealZeroCounters:0,lastSelfHealAt:0,lastError:'',lastOperation:null};
  }
  filePath(){try{return String(this.fileResolver()||'')}catch{return ''}}
  loadSync(){
    const file=this.filePath(); if(!file)return;
    try{
      let source=''; for(const candidate of [file,`${file}.bak`]){try{if(fs.existsSync(candidate)){source=candidate;break}}catch{}} if(!source)return; const data=JSON.parse(fs.readFileSync(source,'utf8'));
      this.journal=Array.isArray(data?.journal)?data.journal.slice(-this.maxJournal):[];
      const running=this.journal.filter(x=>x?.status==='running');
      if(running.length){
        const now=Date.now();
        for(const row of running){row.status='interrupted';row.endedAt=now;row.error='application-restarted-before-operation-finished';this.interrupted.push({...row});const key=clean(row.targetKey,220);if(key)this.states.set(key,{state:WORKFLOW_STATES.RECOVERY_REQUIRED,at:now,reason:'restart-recovery',operationId:row.operationId||''});}
        this.stats.recoveredInterrupted=running.length; this.markDirty();
      }
    }catch(error){this.stats.lastError=clean(error?.message||error,240)}
  }
  markDirty(){this.dirty=true;if(this.flushTimer)return;this.flushTimer=setTimeout(()=>{this.flushTimer=null;this.flush().catch(()=>{})},this.flushMs);this.flushTimer.unref?.()}
  async flush(){if(!this.dirty)return;const file=this.filePath();if(!file)return;this.dirty=false;const payload={version:this.version,updatedAt:new Date().toISOString(),journal:this.journal.slice(-this.maxJournal)};try{await fs.promises.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;await fs.promises.writeFile(tmp,JSON.stringify(payload,null,2),'utf8');try{if(fs.existsSync(file))await fs.promises.copyFile(file,`${file}.bak`)}catch{}try{await fs.promises.rename(tmp,file)}catch{try{await fs.promises.unlink(file)}catch{}await fs.promises.rename(tmp,file)}}catch(error){this.dirty=true;this.stats.lastError=clean(error?.message||error,240)}}
  state(targetKey=''){return this.states.get(clean(targetKey,220))||{state:WORKFLOW_STATES.IDLE,at:0,reason:''}}
  setState(targetKey='',next=WORKFLOW_STATES.IDLE,detail={}){
    const key=clean(targetKey,220); if(!key)return false; const prev=this.state(key).state||WORKFLOW_STATES.IDLE;
    const allowed=ALLOWED.get(prev); if(prev!==next && allowed && !allowed.has(next)){this.stats.illegalTransitions+=1;this.stats.lastError=`illegal-transition:${prev}->${next}`;return false}
    this.states.set(key,{state:next,at:Date.now(),reason:clean(detail?.reason||detail?.kind,100),operationId:clean(detail?.operationId,100)});return true;
  }
  cleanupRecent(now=Date.now()){for(const [key,row] of this.recentSuccess){if(now-Number(row?.at||0)>60000)this.recentSuccess.delete(key)}}
  enqueue({targetKey='',kind='operation',idempotencyKey='',startState=WORKFLOW_STATES.DATA_LOADING,successState=WORKFLOW_STATES.COMPLETED,recentSuccessMs=0,task}={}){
    const key=clean(targetKey,220); const idem=clean(idempotencyKey,220); if(typeof task!=='function')return Promise.resolve({ok:false,error:'workflow task missing'});
    this.cleanupRecent();
    if(idem && this.inFlight.has(idem)){this.stats.joined+=1;return this.inFlight.get(idem).promise}
    const recent=idem?this.recentSuccess.get(idem):null;
    if(idem&&recent&&recentSuccessMs>0&&Date.now()-recent.at<recentSuccessMs){this.stats.dedupedRecent+=1;return Promise.resolve({...recent.result,ok:true,deduped:true,workflowDeduped:true,workflowOperationId:recent.operationId})}
    const operationId=`wf-${Date.now().toString(36)}-${(++this.sequence).toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
    this.stats.enqueued+=1; this.pendingByTarget.set(key,Number(this.pendingByTarget.get(key)||0)+1);
    const row={operationId,targetKey:key,kind:clean(kind,100),idempotencyKey:idem,status:'queued',createdAt:Date.now(),startedAt:0,endedAt:0,result:null,error:''};this.journal.push(row);if(this.journal.length>this.maxJournal)this.journal.splice(0,this.journal.length-this.maxJournal);this.markDirty();
    const previous=this.chains.get(key)||Promise.resolve();
    const run=previous.catch(()=>null).then(async()=>{
      const pendingNext=Math.max(0,Number(this.pendingByTarget.get(key)||1)-1);if(pendingNext>0)this.pendingByTarget.set(key,pendingNext);else this.pendingByTarget.delete(key);
      this.runningByTarget.set(key,Number(this.runningByTarget.get(key)||0)+1);
      row.status='running';row.startedAt=Date.now();this.stats.started+=1;
      if(this.state(key).state===WORKFLOW_STATES.ERROR&&startState!==WORKFLOW_STATES.ERROR){this.setState(key,WORKFLOW_STATES.RETRYING,{kind,operationId,reason:'new-operation-supersedes-error'});}
      this.setState(key,startState,{kind,operationId});this.markDirty();
      try{const result=await task({operationId});const ok=!!result?.ok;row.status=ok?'succeeded':'failed';row.result=safeResult(result);row.error=ok?'':clean(result?.error,240);row.endedAt=Date.now();if(ok){this.stats.succeeded+=1;const nextSuccessState=typeof successState==='function'?successState(result):successState;this.setState(key,nextSuccessState||WORKFLOW_STATES.COMPLETED,{kind,operationId});if(idem)this.recentSuccess.set(idem,{at:Date.now(),result:safeResult(result),operationId})}else{this.stats.failed+=1;this.setState(key,result?.circuitOpen?WORKFLOW_STATES.BLOCKED:WORKFLOW_STATES.ERROR,{kind,operationId})}this.stats.lastOperation={operationId,targetKey:key,kind:row.kind,status:row.status,elapsedMs:row.endedAt-row.startedAt,error:row.error};this.markDirty();return {...result,workflowOperationId:operationId}}
      catch(error){row.status='failed';row.error=clean(error?.message||error,240);row.endedAt=Date.now();this.stats.failed+=1;this.setState(key,WORKFLOW_STATES.ERROR,{kind,operationId});this.stats.lastOperation={operationId,targetKey:key,kind:row.kind,status:'failed',elapsedMs:row.endedAt-row.startedAt,error:row.error};this.markDirty();return {ok:false,error:row.error,workflowOperationId:operationId}}
      finally{const runningNext=Math.max(0,Number(this.runningByTarget.get(key)||1)-1);if(runningNext>0)this.runningByTarget.set(key,runningNext);else this.runningByTarget.delete(key)}
    });
    const tracked=run.finally(()=>{if(this.chains.get(key)===tracked)this.chains.delete(key);if(idem&&this.inFlight.get(idem)?.operationId===operationId)this.inFlight.delete(idem);if(Number(this.pendingByTarget.get(key)||0)<=0)this.pendingByTarget.delete(key);if(Number(this.runningByTarget.get(key)||0)<=0)this.runningByTarget.delete(key)});
    this.chains.set(key,tracked);if(idem)this.inFlight.set(idem,{operationId,promise:tracked});return tracked;
  }
  async retry(task,{delays=[1000,3000,8000],classify=null}={}){let last=null;for(let i=0;i<=delays.length;i++){try{const result=await task(i+1);if(result?.ok)return result;last=result;if(typeof classify==='function'&&!classify(result))return result}catch(error){last={ok:false,error:clean(error?.message||error,240)};if(typeof classify==='function'&&!classify(last))return last}if(i<delays.length)await new Promise(r=>setTimeout(r,delays[i]))}return last||{ok:false,error:'retry-exhausted'}}
  selfHeal({now=Date.now(),maxTransientAgeMs=120000}={}){
    const actions=[];let staleStates=0,staleIdempotency=0,zeroCounters=0;
    this.cleanupRecent(now);
    for(const [key,value] of [...this.pendingByTarget]){const n=Math.max(0,Number(value||0));if(n<=0){this.pendingByTarget.delete(key);zeroCounters+=1;actions.push({type:'drop-zero-pending',targetKey:key})}else if(n!==value)this.pendingByTarget.set(key,n)}
    for(const [key,value] of [...this.runningByTarget]){const n=Math.max(0,Number(value||0));if(n<=0){this.runningByTarget.delete(key);zeroCounters+=1;actions.push({type:'drop-zero-running',targetKey:key})}else if(n!==value)this.runningByTarget.set(key,n)}
    const terminal=new Set(['succeeded','failed','interrupted']);
    for(const [idem,row] of [...this.inFlight]){const op=String(row?.operationId||'');const journal=this.journal.find(x=>String(x?.operationId||'')===op);if(journal&&terminal.has(String(journal.status||''))){this.inFlight.delete(idem);staleIdempotency+=1;actions.push({type:'drop-terminal-idempotency',operationId:op})}}
    const transientStates=new Set([WORKFLOW_STATES.DATA_LOADING,WORKFLOW_STATES.GPT_PREPARING,WORKFLOW_STATES.GPT_INITIALIZING,WORKFLOW_STATES.RETRYING,WORKFLOW_STATES.TURN_STAGING,WORKFLOW_STATES.GPT_WAITING,WORKFLOW_STATES.CUSTOMER_SENDING]);
    for(const [targetKey,row] of [...this.states]){const age=Math.max(0,now-Number(row?.at||now));const active=this.chains.has(targetKey)||Number(this.pendingByTarget.get(targetKey)||0)>0||Number(this.runningByTarget.get(targetKey)||0)>0;if(!active&&transientStates.has(row?.state)&&age>Math.max(30000,Number(maxTransientAgeMs)||120000)){this.states.set(targetKey,{state:WORKFLOW_STATES.RECOVERY_REQUIRED,at:now,reason:'v127266-stale-state-recovery',operationId:String(row?.operationId||'')});staleStates+=1;actions.push({type:'stale-state-to-recovery',targetKey,from:row?.state,ageMs:age})}}
    this.stats.selfHealRuns+=1;this.stats.selfHealActions+=actions.length;this.stats.selfHealStaleStates+=staleStates;this.stats.selfHealStaleIdempotency+=staleIdempotency;this.stats.selfHealZeroCounters+=zeroCounters;this.stats.lastSelfHealAt=now;if(actions.length)this.markDirty();
    return {ok:true,actions,staleStates,staleIdempotency,zeroCounters};
  }
  snapshot(){
    let pending=0,running=0;for(const n of this.pendingByTarget.values())pending+=Number(n||0);for(const n of this.runningByTarget.values())running+=Number(n||0);
    const active=[];for(const [targetKey,row] of this.states){if(row.state!==WORKFLOW_STATES.IDLE)active.push({targetKey,state:row.state,ageMs:Math.max(0,Date.now()-Number(row.at||Date.now())),reason:row.reason||'',operationId:row.operationId||''})}
    return {version:this.version,retryPolicy:{...this.retryPolicy,safeReadDelaysMs:[...this.retryPolicy.safeReadDelaysMs]},queue:{targets:this.chains.size,pending,running,inFlightIdempotency:this.inFlight.size,recentSuccess:this.recentSuccess.size},stats:{...this.stats,lastOperation:this.stats.lastOperation?{...this.stats.lastOperation}:null},recovery:{interruptedCount:this.interrupted.length,recent:this.interrupted.slice(-10)},active:active.slice(-20),journal:this.journal.slice(-20).map(x=>({operationId:x.operationId,targetKey:x.targetKey,kind:x.kind,status:x.status,createdAt:x.createdAt,startedAt:x.startedAt,endedAt:x.endedAt,error:x.error}))};
  }
}
module.exports={WorkflowStabilityCore,WORKFLOW_STATES};
