const DEFAULT_START_MINUTE = 5 * 60;
const DEFAULT_END_MINUTE = 23 * 60;
const DAY_COUNT = 10;

function pad2(value){ return String(Number(value)||0).padStart(2,'0'); }
function localDateKey(value=Date.now()){
  const d=new Date(Number(value)||Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}
function localMinuteOfDay(value=Date.now()){
  const d=new Date(Number(value)||Date.now());
  return d.getHours()*60+d.getMinutes();
}
function parseDateKey(key=''){
  const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key||''));
  if(!m)return null;
  const y=Number(m[1]),mo=Number(m[2]),d=Number(m[3]);
  const dt=new Date(y,mo-1,d,12,0,0,0);
  if(dt.getFullYear()!==y||dt.getMonth()!==mo-1||dt.getDate()!==d)return null;
  return dt;
}
function addLocalDays(key='',days=0){
  const d=parseDateKey(key);if(!d)return '';
  d.setDate(d.getDate()+Number(days||0));
  return localDateKey(d.getTime());
}
function diffLocalCalendarDays(fromKey='',toKey=''){
  const a=parseDateKey(fromKey),b=parseDateKey(toKey);if(!a||!b)return 0;
  const au=Date.UTC(a.getFullYear(),a.getMonth(),a.getDate());
  const bu=Date.UTC(b.getFullYear(),b.getMonth(),b.getDate());
  return Math.round((bu-au)/86400000);
}
function localBoundaryIso(dateKey='',minute=0){
  const d=parseDateKey(dateKey);if(!d)return '';
  const safe=Math.max(0,Math.min(1439,Number(minute)||0));
  d.setHours(Math.floor(safe/60),safe%60,0,0);
  return d.toISOString();
}
function normalizeClockSettings(value={}){
  const src=value&&typeof value==='object'?value:{};
  let startMinute=Math.max(0,Math.min(1439,Number(src.startMinute??DEFAULT_START_MINUTE)||DEFAULT_START_MINUTE));
  let endMinute=Math.max(1,Math.min(1440,Number(src.endMinute??DEFAULT_END_MINUTE)||DEFAULT_END_MINUTE));
  if(endMinute<=startMinute){startMinute=DEFAULT_START_MINUTE;endMinute=DEFAULT_END_MINUTE;}
  return {enabled:src.enabled!==false,startMinute,endMinute};
}
function inferEnrollmentDateKey(state={},now=Date.now(),settings={}){
  const cfg=normalizeClockSettings(settings),today=localDateKey(now),minute=localMinuteOfDay(now);
  const currentDay=Math.max(0,Math.min(DAY_COUNT,Number(state?.currentDay||0)||0));
  const existing=String(state?.enrollmentDateKey||state?.newCustomerDateKey||'').trim();
  if(parseDateKey(existing))return existing;
  if(currentDay<=0)return today;
  const offset=currentDay+(minute<cfg.startMinute?1:0);
  return addLocalDays(today,-offset)||today;
}
function schedulePosition(enrollmentDateKey='',now=Date.now(),settings={}){
  const cfg=normalizeClockSettings(settings),today=localDateKey(now),minute=localMinuteOfDay(now);
  const diff=diffLocalCalendarDays(enrollmentDateKey,today);
  if(diff<=0)return {today,minute,diff,currentDay:0,phase:'new-customer',active:false,finished:false};
  const currentDay=Math.max(0,diff-(minute<cfg.startMinute?1:0));
  if(currentDay<=0)return {today,minute,diff,currentDay:0,phase:'new-customer',active:false,finished:false};
  if(currentDay>DAY_COUNT)return {today,minute,diff,currentDay:DAY_COUNT,phase:'finished',active:false,finished:true};
  if(currentDay===DAY_COUNT && minute>=cfg.endMinute)return {today,minute,diff,currentDay:DAY_COUNT,phase:'finished',active:false,finished:true};
  if(minute>=cfg.startMinute&&minute<cfg.endMinute)return {today,minute,diff,currentDay,phase:'active',active:true,finished:false};
  return {today,minute,diff,currentDay,phase:'waiting-window',active:false,finished:false};
}
function reconcileScheduledState(inputState={},now=Date.now(),settings={}){
  const cfg=normalizeClockSettings(settings);
  const state=inputState&&typeof inputState==='object'?{...inputState}:{};
  const enrollmentDateKey=inferEnrollmentDateKey(state,now,cfg);
  const pos=schedulePosition(enrollmentDateKey,now,cfg);
  const previousDay=Math.max(0,Math.min(DAY_COUNT,Number(state.currentDay||0)||0));
  const previousStatus=String(state.status||'');
  let currentDay=pos.currentDay,status='waiting-morning';
  if(pos.finished)status='finished';
  else if(pos.active)status='active';
  const changed=currentDay!==previousDay||status!==previousStatus||String(state.enrollmentDateKey||'')!==enrollmentDateKey;
  const dayDateKey=currentDay>0?addLocalDays(enrollmentDateKey,currentDay):'';
  const startedAt=currentDay>0?localBoundaryIso(dayDateKey,cfg.startMinute):'';
  const completedAt=status==='active'?'':(currentDay>0?localBoundaryIso(dayDateKey,cfg.endMinute):'');
  return {
    ...state,
    enrollmentDateKey,
    newCustomerDateKey:enrollmentDateKey,
    currentDay,
    status,
    waitingNextMorning:status==='waiting-morning',
    schedulePhase:pos.phase,
    scheduleDateKey:pos.today,
    dayDateKey,
    startedAt:status==='active'?startedAt:String(state.startedAt||startedAt||''),
    completedAt:status==='finished'||(status==='waiting-morning'&&currentDay>0&&pos.minute>=cfg.endMinute)?completedAt:String(state.completedAt||''),
    scheduleStartMinute:cfg.startMinute,
    scheduleEndMinute:cfg.endMinute,
    lastScheduleReconciledAt:new Date(Number(now)||Date.now()).toISOString(),
    _scheduleChanged:changed,
    _previousDay:previousDay,
    _previousStatus:previousStatus
  };
}

module.exports={
  DEFAULT_START_MINUTE,DEFAULT_END_MINUTE,DAY_COUNT,
  localDateKey,localMinuteOfDay,addLocalDays,diffLocalCalendarDays,localBoundaryIso,
  normalizeClockSettings,inferEnrollmentDateKey,schedulePosition,reconcileScheduledState
};
