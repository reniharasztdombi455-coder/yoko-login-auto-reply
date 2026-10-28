const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function automationFingerprint(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

class AutomationLogger {
  constructor(fileResolver, { maxBytes = 12 * 1024 * 1024, backups = 2, enabledResolver = null, flushMs = 250, batchMax = 80 } = {}) {
    this.fileResolver = typeof fileResolver === 'function' ? fileResolver : () => String(fileResolver || '');
    this.enabledResolver = typeof enabledResolver === 'function' ? enabledResolver : () => true;
    this.maxBytes = Math.max(256 * 1024, Number(maxBytes) || 12 * 1024 * 1024);
    this.backups = Math.max(1, Math.min(5, Number(backups) || 2));
    this.flushMs = Math.max(50, Math.min(2000, Number(flushMs) || 250));
    this.batchMax = Math.max(10, Math.min(500, Number(batchMax) || 80));
    this.queue = [];
    this.flushTimer = null;
    this.flushing = false;
    this.flushAgain = false;
    this.stats = { queued:0, written:0, batches:0, rotations:0, errors:0, lastFlushMs:0 };
  }

  filePath() {
    try { return String(this.fileResolver() || ''); } catch { return ''; }
  }

  async rotateIfNeeded(file, incomingBytes = 0) {
    try {
      let size = 0;
      try { size = Number((await fs.promises.stat(file)).size || 0); } catch {}
      if (size + Math.max(0, Number(incomingBytes) || 0) < this.maxBytes) return;
      for (let i = this.backups; i >= 1; i -= 1) {
        const from = i === 1 ? file : `${file}.${i - 1}`;
        const to = `${file}.${i}`;
        try { await fs.promises.unlink(to); } catch {}
        try { await fs.promises.rename(from, to); } catch {}
      }
      this.stats.rotations += 1;
    } catch { this.stats.errors += 1; }
  }

  scheduleFlush(delay = this.flushMs) {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(() => null);
    }, Math.max(0, Number(delay) || 0));
    try { this.flushTimer.unref?.(); } catch {}
  }

  write(event, payload = {}) {
    try { if (!this.enabledResolver()) return; } catch {}
    const row = {
      at: new Date().toISOString(),
      event: String(event || 'event').slice(0, 80),
      ...payload
    };
    this.queue.push(row);
    this.stats.queued += 1;
    if (this.queue.length > 2000) this.queue.splice(0, this.queue.length - 1600);
    if (this.queue.length >= this.batchMax) this.scheduleFlush(0);
    else this.scheduleFlush();
  }

  async flush() {
    if (this.flushing) { this.flushAgain = true; return; }
    if (!this.queue.length) return;
    this.flushing = true;
    const started = Date.now();
    let batch = [];
    try {
      const file = this.filePath();
      if (!file) { this.queue.length = 0; return; }
      batch = this.queue.splice(0, this.batchMax);
      const body = `${batch.map(row => JSON.stringify(row)).join('\n')}\n`;
      await fs.promises.mkdir(path.dirname(file), { recursive:true });
      await this.rotateIfNeeded(file, Buffer.byteLength(body));
      await fs.promises.appendFile(file, body, 'utf8');
      this.stats.written += batch.length;
      this.stats.batches += 1;
    } catch {
      if (batch.length) this.queue.unshift(...batch);
      this.stats.errors += 1;
    } finally {
      this.stats.lastFlushMs = Date.now() - started;
      this.flushing = false;
      if (this.queue.length || this.flushAgain) {
        this.flushAgain = false;
        this.scheduleFlush(0);
      }
    }
  }

  status() { return { ...this.stats, pending:this.queue.length, flushing:this.flushing, maxBytes:this.maxBytes, backups:this.backups, flushMs:this.flushMs, batchMax:this.batchMax }; }

  tail(limit = 120) {
    const file = this.filePath();
    const max = Math.max(1, Math.min(500, Number(limit) || 120));
    let disk=[];
    try {
      if (file && fs.existsSync(file)) {
        const text = fs.readFileSync(file, 'utf8');
        const lines = text.split(/\r?\n/).filter(Boolean).slice(-max);
        disk=lines.map(line => { try { return JSON.parse(line); } catch { return { at:'', event:'malformed-log-line' }; } });
      }
    } catch {}
    return [...disk,...this.queue].slice(-max);
  }
}

class SendJobQueue {
  constructor({ logger = null, successDedupeMs = 5000 } = {}) {
    this.logger = logger;
    this.successDedupeMs = Math.max(0, Number(successDedupeMs) || 0);
    this.chains = new Map();
    this.activeDedupe = new Map();
    this.recentSuccess = new Map();
    this.runningByQueue = new Map();
    this.pendingByQueue = new Map();
    this.sequence = 0;
  }

  cleanupRecent(now = Date.now()) {
    for (const [key, at] of this.recentSuccess.entries()) {
      if (now - Number(at || 0) > this.successDedupeMs) this.recentSuccess.delete(key);
    }
  }

  status() {
    let pending = 0;
    for (const n of this.pendingByQueue.values()) pending += Number(n || 0);
    let running = 0;
    for (const n of this.runningByQueue.values()) running += Number(n || 0);
    return {
      queues: this.chains.size,
      pending,
      running,
      activeDedupe: this.activeDedupe.size,
      recentSuccess: this.recentSuccess.size
    };
  }

  enqueue({ queueKey = 'default', dedupeKey = '', meta = {}, task }) {
    if (typeof task !== 'function') return Promise.resolve({ ok:false, error:'发送任务无执行函数。' });
    const qKey = String(queueKey || 'default');
    const dKey = String(dedupeKey || '');
    const now = Date.now();
    this.cleanupRecent(now);

    if (dKey && this.activeDedupe.has(dKey)) {
      const active = this.activeDedupe.get(dKey);
      this.logger?.write?.('send-job-deduped-active', { queueKey:qKey, dedupeKey:dKey.slice(0,16), jobId:active.jobId, ...meta });
      return active.promise;
    }
    if (dKey && this.successDedupeMs > 0 && this.recentSuccess.has(dKey)) {
      this.logger?.write?.('send-job-deduped-recent-success', { queueKey:qKey, dedupeKey:dKey.slice(0,16), ...meta });
      return Promise.resolve({ ok:true, duplicate:true, deduped:true, alreadySent:true, method:'dedupe-recent-success', message:'检测到刚刚已经成功发送过相同内容，已阻止重复发送。' });
    }

    const jobId = `send-${Date.now().toString(36)}-${(++this.sequence).toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
    this.pendingByQueue.set(qKey, Number(this.pendingByQueue.get(qKey) || 0) + 1);
    this.logger?.write?.('send-job-enqueued', { jobId, queueKey:qKey, dedupeKey:dKey.slice(0,16), ...meta });

    const previous = this.chains.get(qKey) || Promise.resolve();
    const run = previous.catch(() => null).then(async () => {
      this.pendingByQueue.set(qKey, Math.max(0, Number(this.pendingByQueue.get(qKey) || 1) - 1));
      this.runningByQueue.set(qKey, Number(this.runningByQueue.get(qKey) || 0) + 1);
      this.logger?.write?.('send-job-started', { jobId, queueKey:qKey, dedupeKey:dKey.slice(0,16), ...meta });
      const started = Date.now();
      try {
        const result = await task({ jobId, queueKey:qKey, dedupeKey:dKey });
        const ok = !!result?.ok;
        if (ok && dKey) this.recentSuccess.set(dKey, Date.now());
        this.logger?.write?.(ok ? 'send-job-succeeded' : 'send-job-failed', {
          jobId,
          queueKey:qKey,
          dedupeKey:dKey.slice(0,16),
          elapsedMs:Date.now() - started,
          method:String(result?.method || ''),
          verified:String(result?.verified || ''),
          targetChanged:!!result?.targetChanged,
          duplicate:!!result?.duplicate,
          error:ok ? '' : String(result?.error || '').slice(0,500),
          ...meta
        });
        return { ...(result || {}), automationJobId:jobId };
      } catch (error) {
        const message = String(error?.message || error || '发送任务异常');
        this.logger?.write?.('send-job-exception', { jobId, queueKey:qKey, dedupeKey:dKey.slice(0,16), elapsedMs:Date.now() - started, error:message.slice(0,500), ...meta });
        return { ok:false, automationJobId:jobId, error:message };
      } finally {
        this.runningByQueue.set(qKey, Math.max(0, Number(this.runningByQueue.get(qKey) || 1) - 1));
      }
    });

    const tracked = run.finally(() => {
      if (dKey && this.activeDedupe.get(dKey)?.jobId === jobId) this.activeDedupe.delete(dKey);
      if (this.chains.get(qKey) === tracked) this.chains.delete(qKey);
    });
    this.chains.set(qKey, tracked);
    if (dKey) this.activeDedupe.set(dKey, { jobId, promise:tracked });
    return tracked;
  }
}

module.exports = { AutomationLogger, SendJobQueue, automationFingerprint };
