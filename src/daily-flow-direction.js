'use strict';

const { timelineAt, splitTimeline, isFinancialExecutionSegment, resolveStage } = require('./daily-flow-stage');

// V1.27.230 — day direction + node objective + completed/touched objective memory.
// This module intentionally refuses to turn relationship-flow text into automated
// financial solicitation. Financial execution sections are summarized as a safe
// fallback direction instead of becoming an objective.

const SAFE_FALLBACK = '保持自然、真实的普通交流；优先围绕客户当前内容、生活、兴趣、工作或日常感受展开，不推进任何资金行为。';

function cleanLine(value=''){
  return String(value||'').replace(/^\s*[#>*\-–—]+\s*/,'').replace(/\s+/g,' ').trim();
}
function clip(value='', n=280){
  const t=String(value||'').trim();
  return t.length>n?`${t.slice(0,n-1)}…`:t;
}
function looksLikeTimeLine(line=''){
  return /^\s*(?:[#>*\-–—\s]*)?\d{1,2}:[0-5]\d/.test(String(line||''));
}
function looksLikeHeading(line=''){
  const t=cleanLine(line);
  return !!t && (/(核心目标|当天目标|今日目标|完整主线|主题|关键词|核心人物印象|任务)/.test(t) || /^DAY\s*\d+/i.test(t));
}
function riskText(text=''){
  const t=String(text||'');
  if(isFinancialExecutionSegment(t))return true;
  return /(诱导|降低.*戒心|让.*投资|引导.*投资|追加.*资金|加大.*金额|入金|充值|提现|转账|送金|振込|开户|口座開設|保证金|証拠金)/i.test(t);
}
function safeGoal(text=''){
  const t=clip(String(text||'').replace(/\n{3,}/g,'\n\n'),420);
  if(!t)return {text:'',blocked:false};
  if(riskText(t))return {text:SAFE_FALLBACK,blocked:true};
  return {text:t,blocked:false};
}

function blockAfterHeading(lines, startIndex, maxLines=14){
  const out=[];
  for(let i=startIndex+1;i<lines.length && out.length<maxLines;i+=1){
    const raw=String(lines[i]||'').trim();
    if(!raw){ if(out.length) out.push(''); continue; }
    if(looksLikeTimeLine(raw))break;
    if(i>startIndex+1 && looksLikeHeading(raw))break;
    out.push(raw);
  }
  while(out.length && !String(out[out.length-1]||'').trim())out.pop();
  return out.join('\n').trim();
}

function extractDayGoal(flowText=''){
  const lines=String(flowText||'').replace(/\r\n?/g,'\n').split('\n');
  const priority=[/核心目标/,/当天目标|今日目标/,/核心人物印象/,/完整主线/,/第?\s*\d+天.*任务|任务/];
  for(const re of priority){
    const idx=lines.findIndex(line=>re.test(cleanLine(line)));
    if(idx>=0){
      let body=blockAfterHeading(lines,idx);
      const heading=cleanLine(lines[idx]);
      // If the heading itself contains meaningful text after a separator, retain it.
      const inline=heading.split(/[｜|：:]/).slice(1).join('｜').trim();
      const merged=[inline,body].filter(Boolean).join('\n').trim();
      const goal=safeGoal(merged||heading);
      if(goal.text)return {...goal,source:heading};
    }
  }
  const title=lines.map(cleanLine).find(t=>t && !looksLikeTimeLine(t))||'';
  return {...safeGoal(title),source:title?'title':'none'};
}

function segmentTitle(segment=null){
  if(!segment?.text)return '';
  const lines=String(segment.text).replace(/\r\n?/g,'\n').split('\n');
  const first=String(lines[0]||'').trim();
  const inline=/^\s*\d{1,2}:[0-5]\d\s*(?:[—–\-｜|]\s*)?(.+?)\s*$/.exec(first);
  if(inline?.[1])return cleanLine(inline[1]);
  for(const line of lines.slice(1,8)){
    const t=cleanLine(line);
    if(!t)continue;
    if(/^(Yuki|Yoko|佐藤|客户|客戶)\s*[：:]/i.test(t))continue;
    if(t.length<=80)return t;
  }
  return '';
}

function segmentKey(day=0, segment=null){
  if(!segment)return '';
  return `d${Math.max(0,Number(day||0)||0)}@${String(segment.label||'')}`;
}

function normalizeProgress(value=null, day=0){
  const src=value&&typeof value==='object'?value:{};
  const safeDay=Math.max(0,Number(day||0)||0);
  if(Number(src.day||0)!==safeDay){
    return {version:'v127230-direction-progress',day:safeDay,touchedSegmentKeys:[],touchedSegmentLabels:[],touchedObjectives:[],lastTouchedAt:'',lastTouchedStageKey:'',lastTouchedObjective:''};
  }
  const keys=[...new Set((Array.isArray(src.touchedSegmentKeys)?src.touchedSegmentKeys:[]).map(String).filter(Boolean))].slice(-16);
  const labels=[...new Set((Array.isArray(src.touchedSegmentLabels)?src.touchedSegmentLabels:[]).map(String).filter(Boolean))].slice(-16);
  const objectives=[...new Set((Array.isArray(src.touchedObjectives)?src.touchedObjectives:[]).map(v=>clip(v,120)).filter(Boolean))].slice(-12);
  return {
    version:'v127230-direction-progress', day:safeDay,
    touchedSegmentKeys:keys,touchedSegmentLabels:labels,touchedObjectives:objectives,
    lastTouchedAt:String(src.lastTouchedAt||''),lastTouchedStageKey:String(src.lastTouchedStageKey||''),lastTouchedObjective:clip(src.lastTouchedObjective||'',160)
  };
}

function objectiveForSegment(segment=null){
  if(!segment)return {text:'',blocked:false};
  if(isFinancialExecutionSegment(segment.text)||riskText(segment.text))return {text:SAFE_FALLBACK,blocked:true};
  const title=segmentTitle(segment);
  if(title)return {text:clip(title,180),blocked:false};
  const body=String(segment.text||'').split('\n').slice(1).map(cleanLine).filter(Boolean).slice(0,2).join('；');
  return safeGoal(body);
}

function markTouched(flowText='', day=0, now=Date.now(), value=null){
  const progress=normalizeProgress(value,day);
  const timeline=timelineAt(flowText,now,{maxChars:2600});
  if(!timeline?.segment || timeline.blocked)return progress;
  const objective=objectiveForSegment(timeline.segment);
  if(objective.blocked)return progress;
  const key=segmentKey(day,timeline.segment);
  const next={...progress};
  if(key&&!next.touchedSegmentKeys.includes(key))next.touchedSegmentKeys=[...next.touchedSegmentKeys,key].slice(-16);
  if(timeline.segment.label&&!next.touchedSegmentLabels.includes(timeline.segment.label))next.touchedSegmentLabels=[...next.touchedSegmentLabels,String(timeline.segment.label)].slice(-16);
  if(objective.text&&!next.touchedObjectives.includes(objective.text))next.touchedObjectives=[...next.touchedObjectives,objective.text].slice(-12);
  next.lastTouchedAt=new Date(Number(now)||Date.now()).toISOString();
  next.lastTouchedStageKey=String(resolveStage(now)?.key||'');
  next.lastTouchedObjective=objective.text||'';
  return next;
}

function directionSnapshot(flowText='', day=0, now=Date.now(), progressValue=null){
  const stage=resolveStage(now);
  const timeline=timelineAt(flowText,now,{maxChars:4200});
  const dayGoal=extractDayGoal(flowText);
  const current=timeline?.segment?objectiveForSegment(timeline.segment):{text:'',blocked:false};
  const progress=normalizeProgress(progressValue,day);
  const currentKey=segmentKey(day,timeline?.segment||null);
  const alreadyTouched=!!currentKey && progress.touchedSegmentKeys.includes(currentKey);
  let nextObjective='';
  if(timeline?.next){
    const n=objectiveForSegment(timeline.next);
    if(!n.blocked)nextObjective=n.text;
  }
  return {
    version:'v127230-day-direction-memory',
    day:Math.max(0,Number(day||0)||0),
    stageKey:String(stage?.key||''),stageLabel:String(stage?.label||''),clockText:String(stage?.clockText||''),
    dayGoal:dayGoal.text||SAFE_FALLBACK,dayGoalBlocked:!!dayGoal.blocked,
    currentSegmentLabel:String(timeline?.segment?.label||''),currentObjective:current.text||'',currentObjectiveBlocked:!!current.blocked,
    currentAlreadyTouched:alreadyTouched,
    nextSegmentLabel:String(timeline?.next?.label||''),nextObjective,
    touchedSegmentLabels:[...progress.touchedSegmentLabels],touchedObjectives:[...progress.touchedObjectives],
    lastTouchedAt:progress.lastTouchedAt,lastTouchedObjective:progress.lastTouchedObjective,
    hasTimeline:!!timeline?.hasTimeline
  };
}

module.exports={SAFE_FALLBACK,extractDayGoal,segmentTitle,segmentKey,normalizeProgress,objectiveForSegment,markTouched,directionSnapshot,riskText};
