'use strict';
function text(value,max=500){return String(value==null?'':value).replace(/\u0000/g,'').trim().slice(0,max);}
function score(value){return Math.max(0,Math.min(100,Number(value||0)||0));}
function clone(value){return value&&typeof value==='object'&&!Array.isArray(value)?{...value}:{};}
function stageState(base,prior,now,{intent,progress,value,evidence,added=false}){
  const n=Math.max(0,Math.min(100,Number(value||0)||0));
  return {
    ...base,
    lineIntent:intent,
    lineIntentScore:n,
    lineProgress:progress,
    lineEvidence:evidence,
    _lineJourney:{...prior,intent,progress,score:n,added:!!added,updatedAt:text(now,80),...(added?{addedAt:text(prior?.addedAt||now,80)}:{})}
  };
}
// V1.27.44: a MANUAL follow-up-stage change is authoritative for the visible
// LINE intent/progress badge. Before this, only the three LINE terminal stages
// updated lineIntent, so downgrading/advancing the stage could leave a stale
// "高意向 / 已添加" badge. Keep pause semantics in the sealed
// crm-line-stage-sync layer, then deterministically map every normal lead stage.
function applyLeadStageLineTerminalState(contact={},stage='',baseState={},now=new Date().toISOString()){
  const normalized=text(stage,40);
  const base={...(baseState||{})};
  const prior=clone(contact?._lineJourney);
  if(normalized==='无效/暂停'||normalized==='无效') return base; // sealed pause state stays authoritative
  if(normalized==='待回复') return stageState(base,prior,now,{intent:'none',progress:'not_started',value:0,evidence:'手工跟进阶段：待回复。'});
  if(normalized==='有意向') return stageState(base,prior,now,{intent:'positive',progress:'interested',value:55,evidence:'手工跟进阶段：有意向。'});
  // 已对接ws并非LINE已添加，禁止伪造LINE对接状态。
  if(normalized==='已对接ws') return base;
  if(normalized==='新进线') return stageState(base,prior,now,{intent:'none',progress:'not_started',value:0,evidence:'手工跟进阶段：新进线；LINE 意向尚未建立。'});
  if(normalized==='已接待') return stageState(base,prior,now,{intent:'none',progress:'not_started',value:20,evidence:'手工跟进阶段：已接待；继续观察 LINE 意向。'});
  if(normalized==='有效聊天') return stageState(base,prior,now,{intent:'positive',progress:'interested',value:55,evidence:'手工跟进阶段：有效聊天；客户进入 LINE 意向观察。'});
  if(normalized==='准备引导LINE') return stageState(base,prior,now,{intent:'positive',progress:'interested',value:70,evidence:'已进入 LINE 引导准备阶段。'});
  if(normalized==='已邀请LINE') return stageState(base,prior,now,{intent:'high',progress:'waiting_add',value:90,evidence:'已发送 LINE 邀请，等待客户添加。'});
  if(normalized==='LINE已添加') return stageState(base,prior,now,{intent:'high',progress:'added',value:100,evidence:text(contact?.lineEvidence,360)||'操作员已将跟进阶段标记为 LINE已添加。',added:true});
  return base;
}
module.exports={applyLeadStageLineTerminalState};
