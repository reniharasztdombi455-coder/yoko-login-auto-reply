'use strict';

// V1.27.229 — intraday stage gate.
// Day selection remains owned by daily-flow-clock.js. This module only resolves
// the current in-day phase and exposes a bounded, non-future timeline slice.

const STAGES = Object.freeze([
  Object.freeze({ key:'dawn', label:'清晨', startMinute:5*60, endMinute:7*60 }),
  Object.freeze({ key:'morning', label:'早晨', startMinute:7*60, endMinute:9*60 }),
  Object.freeze({ key:'late-morning', label:'上午', startMinute:9*60, endMinute:11*60+50 }),
  Object.freeze({ key:'lunch-rest', label:'午餐／午休', startMinute:11*60+50, endMinute:13*60+30 }),
  Object.freeze({ key:'early-afternoon', label:'下午前段', startMinute:13*60+30, endMinute:15*60+30 }),
  Object.freeze({ key:'afternoon', label:'下午', startMinute:15*60+30, endMinute:18*60 }),
  Object.freeze({ key:'evening', label:'傍晚', startMinute:18*60, endMinute:20*60 }),
  Object.freeze({ key:'night', label:'晚上', startMinute:20*60, endMinute:21*60+45 }),
  Object.freeze({ key:'close', label:'睡前收尾', startMinute:21*60+45, endMinute:23*60 })
]);

function minuteOfDay(value=Date.now()){
  const d=new Date(Number(value)||Date.now());
  return d.getHours()*60+d.getMinutes();
}
function pad2(v){return String(Number(v)||0).padStart(2,'0');}
function clockText(value=Date.now()){
  const d=new Date(Number(value)||Date.now());
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function resolveStage(value=Date.now()){
  const minute=minuteOfDay(value);
  const index=STAGES.findIndex(s=>minute>=s.startMinute&&minute<s.endMinute);
  if(index<0){
    return {active:false,key:'',label:'',index:-1,minute,clockText:clockText(value),completedKeys:[],completedLabels:[],nextKey:'',nextLabel:''};
  }
  const stage=STAGES[index];
  return {
    active:true,
    ...stage,
    index,
    minute,
    clockText:clockText(value),
    completedKeys:STAGES.slice(0,index).map(s=>s.key),
    completedLabels:STAGES.slice(0,index).map(s=>s.label),
    nextKey:STAGES[index+1]?.key||'',
    nextLabel:STAGES[index+1]?.label||''
  };
}

function timelineMarker(line=''){
  const text=String(line||'').trim();
  const m=/^(?:[#>*\-–—\s]*)?(\d{1,2}):([0-5]\d)(?:\s*(?:[｜|—–-].*)?)?$/.exec(text);
  if(!m)return null;
  const h=Number(m[1]),min=Number(m[2]);
  if(h<0||h>23)return null;
  return {hour:h,minute:min,minuteOfDay:h*60+min,label:`${pad2(h)}:${pad2(min)}`};
}

function splitTimeline(flowText=''){
  const lines=String(flowText||'').replace(/\r\n?/g,'\n').split('\n');
  const markers=[];
  for(let i=0;i<lines.length;i+=1){
    const marker=timelineMarker(lines[i]);
    if(marker)markers.push({...marker,lineIndex:i});
  }
  const segments=[];
  for(let i=0;i<markers.length;i+=1){
    const current=markers[i],next=markers[i+1];
    const end=next?next.lineIndex:lines.length;
    const text=lines.slice(current.lineIndex,end).join('\n').trim();
    segments.push({...current,endLineIndex:end,text});
  }
  return {lines,markers,segments};
}

// Auto-progression may schedule ordinary conversation, but it must not turn a
// relationship flow into automated financial solicitation. If the currently
// selected source segment contains money/investment execution cues, the segment
// is withheld and the model is told to stay with ordinary conversation instead.
function isFinancialExecutionSegment(text=''){
  const t=String(text||'');
  if(!t.trim())return false;
  const direct=/(充值|入金|出金|提现|提款|转账|轉帳|送金|振込|钱包|錢包|ウォレット|开户|開戶|口座開設|加大金额|增加金额|追加.*(?:金额|金額|資金)|投资金额|投資金額|本金|保证金|証拠金|USDT|[0-9０-９]+\s*万(?:日元|円)|[0-9０-９]+\s*万円)/i;
  if(direct.test(t))return true;
  const finance=/(投资|投資|黄金|金取引|金の取引|交易|取引|市場|market|收益|利益|盈利|損益|亏损|損失|余额|残高|账户|口座|资金|資金|平台|ブローカー|exchange)/ig;
  const hits=t.match(finance)||[];
  return hits.length>=2;
}

function timelineAt(flowText='', value=Date.now(), {maxChars=4200}={}){
  const minute=minuteOfDay(value);
  const parsed=splitTimeline(flowText);
  if(!parsed.segments.length){
    return {hasTimeline:false,minute,clockText:clockText(value),segment:null,next:null,blocked:false,text:''};
  }
  let current=null,next=null;
  for(const seg of parsed.segments){
    if(seg.minuteOfDay<=minute)current=seg;
    else {next=seg;break;}
  }
  if(!current){
    next=parsed.segments[0]||null;
    return {hasTimeline:true,minute,clockText:clockText(value),segment:null,next,blocked:false,text:''};
  }
  const blocked=isFinancialExecutionSegment(current.text);
  const text=blocked?'':String(current.text||'').slice(0,Math.max(600,Number(maxChars)||4200));
  return {hasTimeline:true,minute,clockText:clockText(value),segment:current,next,blocked,text};
}

module.exports={STAGES,minuteOfDay,clockText,resolveStage,timelineMarker,splitTimeline,isFinancialExecutionSegment,timelineAt};
