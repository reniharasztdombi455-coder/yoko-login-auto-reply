'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { WorkflowStabilityCore, WORKFLOW_STATES } = require('./workflow-stability-core');

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function clean(value, limit = 240) {
  return String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim().slice(0, limit);
}
function percentile(values = [], p = 0.95) {
  const rows = values.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  if (!rows.length) return 0;
  const index = Math.min(rows.length - 1, Math.max(0, Math.ceil(rows.length * p) - 1));
  return rows[index];
}
function average(values = []) {
  const rows = values.map(Number).filter(Number.isFinite);
  return rows.length ? rows.reduce((a,b)=>a+b,0) / rows.length : 0;
}

function regressionSlopePerHour(rows = []) {
  const cleanRows = rows.filter(row => Number.isFinite(Number(row?.at)) && Number.isFinite(Number(row?.memoryMb)));
  if (cleanRows.length < 8) return 0;
  const origin = Number(cleanRows[0].at);
  const xs = cleanRows.map(row => (Number(row.at) - origin) / 3600000);
  const ys = cleanRows.map(row => Number(row.memoryMb));
  const xAvg = average(xs), yAvg = average(ys);
  let nume = 0, den = 0;
  for (let i = 0; i < xs.length; i += 1) { const dx = xs[i] - xAvg; nume += dx * (ys[i] - yAvg); den += dx * dx; }
  if (!den) return 0;
  return Math.round((nume / den) * 10) / 10;
}

class LongRunStabilityCore {
  constructor({ fileResolver, version = 'v127266-long-run-stability-self-recovery', maxSamples = 1440, maxIncidents = 240, flushMs = 1200 } = {}) {
    this.fileResolver = typeof fileResolver === 'function' ? fileResolver : () => String(fileResolver || '');
    this.version = version;
    this.maxSamples = Math.max(120, Math.min(10000, num(maxSamples, 1440)));
    this.maxIncidents = Math.max(60, Math.min(2000, num(maxIncidents, 240)));
    this.flushMs = Math.max(200, Math.min(5000, num(flushMs, 1200)));
    this.startedAt = Date.now();
    this.samples = [];
    this.incidents = [];
    this.stressRuns = [];
    this.selfHeal = { runs:0, actions:0, staleStates:0, staleIdempotency:0, zeroCounters:0, lastAt:0, lastActions:[] };
    this.dirty = false;
    this.flushTimer = null;
    this.lastError = '';
  }
  filePath() { try { return String(this.fileResolver() || ''); } catch { return ''; } }
  loadSync() {
    const file = this.filePath();
    if (!file) return;
    try {
      let source = '';
      for (const candidate of [file, `${file}.bak`]) {
        try { if (fs.existsSync(candidate)) { source = candidate; break; } } catch {}
      }
      if (!source) return;
      const data = JSON.parse(fs.readFileSync(source, 'utf8'));
      this.startedAt = num(data?.startedAt, this.startedAt);
      this.samples = Array.isArray(data?.samples) ? data.samples.slice(-this.maxSamples) : [];
      this.incidents = Array.isArray(data?.incidents) ? data.incidents.slice(-this.maxIncidents) : [];
      this.stressRuns = Array.isArray(data?.stressRuns) ? data.stressRuns.slice(-20) : [];
      if (data?.selfHeal && typeof data.selfHeal === 'object') this.selfHeal = { ...this.selfHeal, ...data.selfHeal };
    } catch (error) { this.lastError = clean(error?.message || error); }
  }
  markDirty() {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush().catch(()=>{}); }, this.flushMs);
    this.flushTimer.unref?.();
  }
  async flush() {
    if (!this.dirty) return;
    const file = this.filePath();
    if (!file) return;
    this.dirty = false;
    const payload = {
      version:this.version, updatedAt:new Date().toISOString(), startedAt:this.startedAt,
      samples:this.samples.slice(-this.maxSamples), incidents:this.incidents.slice(-this.maxIncidents),
      stressRuns:this.stressRuns.slice(-20), selfHeal:this.selfHeal
    };
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive:true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
      try { if (fs.existsSync(file)) await fs.promises.copyFile(file, `${file}.bak`); } catch {}
      try { await fs.promises.rename(tmp, file); }
      catch { try { await fs.promises.unlink(file); } catch {} await fs.promises.rename(tmp, file); }
    } catch (error) { this.dirty = true; this.lastError = clean(error?.message || error); }
  }
  noteIncident(type, detail = {}) {
    const row = { at:Date.now(), type:clean(type,80), ...detail };
    this.incidents.push(row);
    if (this.incidents.length > this.maxIncidents) this.incidents.splice(0, this.incidents.length - this.maxIncidents);
    this.markDirty();
    return row;
  }
  sample(snapshot = {}) {
    const now = Date.now();
    const runtime = snapshot.runtime || {};
    const workflow = snapshot.workflow || {};
    const gpt = snapshot.gpt || {};
    const logger = snapshot.logger || {};
    const mainLoop = snapshot.mainLoop || {};
    const sample = {
      at:now,
      memoryMb:Math.max(0, Math.round(num(runtime.memoryMb))),
      cpuPercent:Math.max(0, Math.round(num(runtime.cpuPercent) * 10) / 10),
      processCount:Math.max(0, Math.round(num(runtime.processCount))),
      eventLoopLagMs:Math.max(0, Math.round(num(mainLoop.lastLagMs ?? mainLoop.lagMs))),
      eventLoopMaxLagMs:Math.max(0, Math.round(num(mainLoop.maxLagMs))),
      workflowPending:Math.max(0, Math.round(num(workflow?.queue?.pending))),
      workflowRunning:Math.max(0, Math.round(num(workflow?.queue?.running))),
      workflowTargets:Math.max(0, Math.round(num(workflow?.queue?.targets))),
      workflowIllegal:Math.max(0, Math.round(num(workflow?.stats?.illegalTransitions))),
      workflowRecovery:Math.max(0, Math.round(num(workflow?.recovery?.interruptedCount))),
      gptVisible:!!gpt.visible,
      gptReady:!!gpt.ready,
      gptLoading:!!gpt.loading,
      gptHealthFailures:Math.max(0, Math.round(num(gpt.healthFailures))),
      gptCircuitOpen:!!gpt?.loadFailureCircuit?.active,
      logPending:Math.max(0, Math.round(num(logger.pending))),
      logErrors:Math.max(0, Math.round(num(logger.errors)))
    };
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) this.samples.splice(0, this.samples.length - this.maxSamples);

    const prev = this.samples[this.samples.length - 2];
    if (sample.memoryMb >= 3000 && (!prev || prev.memoryMb < 3000)) this.noteIncident('memory-high',{memoryMb:sample.memoryMb});
    if (sample.eventLoopLagMs >= 800) this.noteIncident('event-loop-severe',{lagMs:sample.eventLoopLagMs});
    if (sample.workflowPending >= 20) this.noteIncident('workflow-backlog',{pending:sample.workflowPending,running:sample.workflowRunning});
    if (sample.gptCircuitOpen && (!prev || !prev.gptCircuitOpen)) this.noteIncident('gpt-load-circuit-open',{});
    if (sample.logErrors > (prev?.logErrors || 0)) this.noteIncident('async-log-error',{errors:sample.logErrors});
    this.markDirty();
    return sample;
  }
  noteSelfHeal(result = {}) {
    const actions = Array.isArray(result?.actions) ? result.actions : [];
    this.selfHeal.runs += 1;
    this.selfHeal.actions += actions.length;
    this.selfHeal.staleStates += num(result?.staleStates);
    this.selfHeal.staleIdempotency += num(result?.staleIdempotency);
    this.selfHeal.zeroCounters += num(result?.zeroCounters);
    this.selfHeal.lastAt = Date.now();
    this.selfHeal.lastActions = actions.slice(-20);
    if (actions.length) this.noteIncident('self-heal',{count:actions.length,actions:actions.slice(-8)});
    this.markDirty();
  }
  report({ windowMs = 12 * 60 * 60 * 1000 } = {}) {
    const now = Date.now();
    const rows = this.samples.filter(row => now - num(row.at) <= Math.max(60000, num(windowMs, 12*60*60*1000)));
    const mem = rows.map(row=>row.memoryMb);
    const cpu = rows.map(row=>row.cpuPercent);
    const lag = rows.map(row=>row.eventLoopLagMs);
    const pending = rows.map(row=>row.workflowPending);
    const trendStart = Math.max(this.startedAt + 15 * 60 * 1000, now - 2 * 60 * 60 * 1000);
    let trendRows = rows.filter(row => num(row.at) >= trendStart);
    if (trendRows.length < 8) trendRows = rows.filter(row => now - num(row.at) <= 60 * 60 * 1000);
    const memoryGrowthMbPerHour = regressionSlopePerHour(trendRows);
    const trendWindowMinutes = trendRows.length >= 2 ? Math.round((num(trendRows[trendRows.length-1].at)-num(trendRows[0].at))/60000) : 0;
    return {
      version:this.version,
      generatedAt:new Date(now).toISOString(),
      monitoredForMs:Math.max(0, now - this.startedAt),
      sampleCount:rows.length,
      memory:{currentMb:mem[mem.length-1]||0,avgMb:Math.round(average(mem)),maxMb:Math.max(0,...mem),growthMbPerHour:memoryGrowthMbPerHour,trendWindowMinutes,trendSamples:trendRows.length,trendMethod:'rolling-2h-linear-regression-after-15m-warmup'},
      cpu:{avgPercent:Math.round(average(cpu)*10)/10,p95Percent:Math.round(percentile(cpu,.95)*10)/10,maxPercent:Math.max(0,...cpu)},
      eventLoop:{avgLagMs:Math.round(average(lag)),p95LagMs:Math.round(percentile(lag,.95)),maxLagMs:Math.max(0,...lag)},
      workflow:{maxPending:Math.max(0,...pending),lastPending:pending[pending.length-1]||0,illegalTransitions:rows[rows.length-1]?.workflowIllegal||0,recoveryRequired:rows[rows.length-1]?.workflowRecovery||0},
      selfHeal:{...this.selfHeal,lastActions:Array.isArray(this.selfHeal.lastActions)?this.selfHeal.lastActions.slice(-20):[]},
      incidents:this.incidents.filter(row=>now-num(row.at)<=windowMs).slice(-50),
      stressRuns:this.stressRuns.slice(-10),
      host:{platform:process.platform,arch:process.arch,cpuCount:(os.cpus?.()||[]).length,totalMemoryMb:Math.round(os.totalmem()/1024/1024)},
      lastError:this.lastError
    };
  }
  snapshot() {
    const last = this.samples[this.samples.length - 1] || null;
    return { ...this.report({windowMs:12*60*60*1000}), lastSample:last, storedSamples:this.samples.length, storedIncidents:this.incidents.length };
  }
  async runSyntheticStress({ iterations = 360, targets = 18 } = {}) {
    iterations = Math.max(60, Math.min(2000, Math.round(num(iterations,360))));
    targets = Math.max(2, Math.min(64, Math.round(num(targets,18))));
    const startedAt = Date.now();
    const beforeMem = process.memoryUsage().rss;
    const core = new WorkflowStabilityCore({ version:'v127266-synthetic-stress', maxJournal:Math.max(400,iterations+50) });
    const active = new Map();
    let overlapViolations = 0;
    const promises = [];
    for (let i=0;i<iterations;i+=1) {
      const targetKey = `stress:${i % targets}`;
      const idem = `stress:${targetKey}:${Math.floor(i/targets)}`;
      const task = core.enqueue({
        targetKey, kind:'synthetic-stress', idempotencyKey:idem,
        startState:WORKFLOW_STATES.TURN_STAGING, successState:WORKFLOW_STATES.GPT_BOUND,
        task:async()=>{
          const count=num(active.get(targetKey));
          if (count > 0) overlapViolations += 1;
          active.set(targetKey,count+1);
          await new Promise(resolve=>setTimeout(resolve,1));
          active.set(targetKey,Math.max(0,num(active.get(targetKey))-1));
          return {ok:true,method:'synthetic'};
        }
      });
      promises.push(task);
      if (i % 23 === 0) promises.push(core.enqueue({
        targetKey, kind:'synthetic-stress-duplicate', idempotencyKey:idem,
        startState:WORKFLOW_STATES.TURN_STAGING, successState:WORKFLOW_STATES.GPT_BOUND,
        task:async()=>({ok:true,method:'should-join'})
      }));
    }
    const safeRetry = await core.retry(async attempt => attempt < 3 ? {ok:false,error:'synthetic-transient'} : {ok:true,attempt}, { delays:[5,10], classify:()=>true });
    await Promise.all(promises);
    const snap = core.snapshot();
    const elapsedMs = Date.now() - startedAt;
    const afterMem = process.memoryUsage().rss;
    const result = {
      at:Date.now(), passed:overlapViolations===0 && snap.queue.pending===0 && snap.queue.running===0 && snap.stats.illegalTransitions===0 && safeRetry?.ok===true,
      iterations,targets,elapsedMs,operationsPerSecond:elapsedMs?Math.round((iterations*1000/elapsedMs)*10)/10:iterations,
      overlapViolations,queue:snap.queue,stats:snap.stats,safeRetryOk:!!safeRetry?.ok,
      memoryDeltaMb:Math.round(((afterMem-beforeMem)/1024/1024)*10)/10
    };
    this.stressRuns.push(result);
    if (this.stressRuns.length > 20) this.stressRuns.splice(0,this.stressRuns.length-20);
    if (!result.passed) this.noteIncident('synthetic-stress-failed',{overlapViolations,queue:snap.queue,illegalTransitions:snap.stats.illegalTransitions});
    this.markDirty();
    return result;
  }
}

module.exports = { LongRunStabilityCore };
