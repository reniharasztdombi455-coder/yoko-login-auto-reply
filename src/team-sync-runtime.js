'use strict';
const fs = require('fs');
const path = require('path');
const { createTeamSyncServer } = require('./team-sync-server');
const { syncTeam } = require('./team-sync-client');
const { normalizeTeamSettings, sanitizeCrmContact, buildHandoffTask, publicLineEndpoints, text } = require('./team-sync-core');
const {
  DEFAULT_FIXED_TEAM_PUBLIC_URL,
  cloudflareMode,
  cloudflareOriginUrl,
  detectCloudflared,
  startCloudflareTunnel,
  normalizePublicUrl,
  isTryCloudflareUrl,
  resolveFixedTeamPublicUrl,
  testCloudflarePublicHealth,
  detectCloudflaredWindowsService
} = require('./team-cloudflare-tunnel');
const { normalizeNodeCapabilities, isLeadPlatform, loggedAccountIds } = require('./team-node-roles');

class TeamSyncRuntime {
  constructor({
    dataDir,
    getSettings,
    setSettings,
    getLineAccounts,
    getNodeCapabilities,
    getCloudflareToken,
    onUpdated,
    logger,
    publicHealthCheck,
    cloudflaredServiceDetector
  } = {}) {
    this.dataDir = dataDir || process.cwd();
    this.getSettings = getSettings || (() => ({}));
    this.setSettings = setSettings || (() => {});
    this.getLineAccounts = getLineAccounts || (() => []);
    this.dynamicCapabilitiesConfigured = typeof getNodeCapabilities === 'function';
    this.getNodeCapabilities = getNodeCapabilities || (() => ({ accounts:[] }));
    this.getCloudflareToken = getCloudflareToken || (() => '');
    this.onUpdated = onUpdated || (() => {});
    this.logger = logger || (() => {});
    this.publicHealthCheck = publicHealthCheck || testCloudflarePublicHealth;
    this.cloudflaredServiceDetector = cloudflaredServiceDetector || detectCloudflaredWindowsService;
    this.timer = null;
    this.serverRuntime = null;
    this.cloudflareRuntime = null;
    this.cloudflareHealthPromise = null;
    this.lastFixedHealthCheckAt = 0;
    this.cloudflareStatus = {
      running:false,
      publicUrl:'',
      originUrl:'',
      command:'',
      version:'',
      externallyManaged:false,
      serviceInstalled:false,
      serviceRunning:false,
      healthOk:false,
      lastCheckedAt:'',
      lastError:''
    };
    this.syncing = false;
    this.adminActionChain = Promise.resolve();
    this.outbox = { customers:{}, tasks:{} };
    this.inboxTasks = {};
    this.lastStats = { devices:0, customers:0, pending:0, accepted:0, bound:0, acquisitionNodes:0, handoffNodes:0, dualNodes:0 };
    this.lastNodeProfile = null;
    this.lastSyncAt = '';
    this.lastError = '';
    this.consecutiveSyncFailures = 0;
    this.lastRecoveredAt = '';
    this.nodeCapabilities = normalizeNodeCapabilities({ accounts:[] });
    this.teamDevices = [];
    this.loadState();
  }

  stateFile() { return path.join(this.dataDir, 'team-sync-state.json'); }

  loadState() {
    try {
      const d = JSON.parse(fs.readFileSync(this.stateFile(), 'utf8'));
      if (d && typeof d === 'object') {
        this.outbox = d.outbox || this.outbox;
        this.inboxTasks = d.inboxTasks || {};
        this.lastStats = d.lastStats || this.lastStats;
        this.lastSyncAt = text(d.lastSyncAt, 80);
        this.lastError = text(d.lastError, 500);
      }
    } catch {}
  }

  saveState() {
    try {
      fs.mkdirSync(this.dataDir, { recursive:true });
      fs.writeFileSync(this.stateFile(), JSON.stringify({
        version:1,
        outbox:this.outbox,
        inboxTasks:this.inboxTasks,
        lastStats:this.lastStats,
        lastSyncAt:this.lastSyncAt,
        lastError:this.lastError
      }, null, 2));
    } catch (error) { this.logger('save-state-error', error); }
  }

  settings() {
    const s = normalizeTeamSettings(this.getSettings() || {});
    // V1.26.1 one-time migration: an already-running Quick Tunnel should move to
    // the verified Named Tunnel. A newly selected Quick Tunnel with no generated
    // trycloudflare URL is still allowed as a one-session emergency fallback.
    if (s.mode === 'server-cloudflare-quick' && (isTryCloudflareUrl(s.serverUrl) || isTryCloudflareUrl(s.cloudflarePublicUrl))) {
      return { ...s, mode:'server-cloudflare-token', serverUrl:DEFAULT_FIXED_TEAM_PUBLIC_URL, cloudflarePublicUrl:DEFAULT_FIXED_TEAM_PUBLIC_URL };
    }
    // Employee/client nodes that still remember the previous random Quick Tunnel
    // are transparently moved to the permanent team entry.
    if (s.mode === 'client' && isTryCloudflareUrl(s.serverUrl)) {
      return { ...s, serverUrl:DEFAULT_FIXED_TEAM_PUBLIC_URL };
    }
    if (s.mode === 'server-cloudflare-token') {
      const fixed = resolveFixedTeamPublicUrl(s.cloudflarePublicUrl, s.serverUrl);
      return { ...s, serverUrl:fixed, cloudflarePublicUrl:fixed };
    }
    return s;
  }

  lineEndpoints() { return publicLineEndpoints(this.getLineAccounts(), this.settings()); }

  activeLineEndpoints(capabilities = this.nodeCapabilities) {
    if (!this.dynamicCapabilitiesConfigured) return this.lineEndpoints();
    const active = loggedAccountIds(capabilities, 'line');
    return this.lineEndpoints().filter(ep => active.has(String(ep.localAccountId || '')));
  }

  snapshot() {
    const s = this.settings();
    return {
      enabled:s.enabled,
      mode:s.mode,
      serverUrl:s.serverUrl,
      serverPort:s.serverPort,
      teamId:s.teamId,
      deviceId:s.deviceId,
      deviceName:s.deviceName,
      role:s.role,
      dynamicRole:this.nodeCapabilities.dynamicRole,
      nodeCapabilities:this.nodeCapabilities,
      teamDevices:this.teamDevices,
      autoStartServer:s.autoStartServer,
      cloudflarePublicUrl:this.cloudflareStatus.publicUrl || s.cloudflarePublicUrl || '',
      cloudflareTunnelRunning:!!this.cloudflareRuntime || (s.mode === 'server-cloudflare-token' && !!this.cloudflareStatus.running),
      cloudflareStatus:{ ...this.cloudflareStatus },
      cloudflaredPath:s.cloudflaredPath || '',
      cloudflareTokenSet:!!text(this.getCloudflareToken(), 12000),
      connected:!!s.enabled && !!this.lastSyncAt && !this.lastError,
      reconnecting:!!s.enabled && this.consecutiveSyncFailures > 0,
      consecutiveSyncFailures:this.consecutiveSyncFailures,
      reconnectDelayMs:this.lastError ? this.reconnectDelayMs() : 0,
      lastRecoveredAt:this.lastRecoveredAt,
      lastSyncAt:this.lastSyncAt,
      lastError:this.lastError,
      serverRunning:!!this.serverRuntime,
      pendingTasks:Object.values(this.inboxTasks).filter(t => t.status === 'pending' || t.status === 'accepted').length,
      tasks:Object.values(this.inboxTasks).sort((a,b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt))).slice(0,500),
      stats:this.lastStats,
      lineEndpoints:this.lineEndpoints(),
      activeLineEndpoints:this.activeLineEndpoints()
    };
  }

  async configure(raw = {}) {
    const prior = this.settings();
    let merged = { ...prior, ...raw, deviceId:prior.deviceId || raw.deviceId };
    // Fixed Named Tunnel is externally managed by the Windows cloudflared service.
    // Never require or launch with a token from the application.
    if (String(merged.mode || '') === 'server-cloudflare-token') {
      const fixed = resolveFixedTeamPublicUrl(merged.cloudflarePublicUrl, merged.serverUrl);
      merged = { ...merged, serverUrl:fixed, cloudflarePublicUrl:fixed, cloudflareTunnelTokenProtected:'' };
    }
    // Manual emergency Quick Tunnel starts clean and receives a new random URL.
    if (String(merged.mode || '') === 'server-cloudflare-quick') {
      merged = { ...merged, serverUrl:'', cloudflarePublicUrl:'' };
    }
    const next = normalizeTeamSettings(merged);
    this.setSettings(next);
    await this.restart();
    return this.snapshot();
  }

  async restart() {
    await this.stop();
    const s = this.settings();
    // Persist automatic migration without touching the sealed normalization core.
    const stored = normalizeTeamSettings(this.getSettings() || {});
    if (stored.mode !== s.mode || stored.serverUrl !== s.serverUrl || stored.cloudflarePublicUrl !== s.cloudflarePublicUrl) {
      this.setSettings({ ...stored, mode:s.mode, serverUrl:s.serverUrl, cloudflarePublicUrl:s.cloudflarePublicUrl, cloudflareTunnelTokenProtected:s.mode === 'server-cloudflare-token' ? '' : stored.cloudflareTunnelTokenProtected });
    }
    if (!s.enabled) { this.onUpdated(this.snapshot()); return; }
    try {
      if (s.mode === 'server-local' || s.mode === 'server-lan' || cloudflareMode(s.mode) || s.autoStartServer) await this.startServer();
      if (cloudflareMode(s.mode)) await this.startCloudflare();
      this.schedule(100);
    } catch (error) {
      this.cloudflareStatus = { ...this.cloudflareStatus, running:false, lastError:text(error?.message || error, 500) };
      try { await this.stopCloudflare(); } catch {}
      try { await this.stopServer(); } catch {}
      this.onUpdated(this.snapshot());
      throw error;
    }
  }

  async startServer() {
    const s = this.settings();
    if (this.serverRuntime) return;
    if (!s.teamId || !s.apiKey) throw new Error('启动团队服务器前请先设置团队ID和同步密钥。');
    const dataFile = path.join(this.dataDir, 'team-server-store.json');
    const host=s.mode==='server-lan'?'0.0.0.0':'127.0.0.1';
    this.serverRuntime = createTeamSyncServer({ port:s.serverPort, host, teamId:s.teamId, apiKey:s.apiKey, dataFile, logger:this.logger });
    await this.serverRuntime.start();
  }

  async refreshFixedTunnelHealth({ force = false } = {}) {
    const s = this.settings();
    if (s.mode !== 'server-cloudflare-token') return this.cloudflareStatus;
    const now = Date.now();
    if (!force && now - this.lastFixedHealthCheckAt < 30000) return this.cloudflareStatus;
    if (this.cloudflareHealthPromise) return this.cloudflareHealthPromise;
    const fixed = resolveFixedTeamPublicUrl(s.cloudflarePublicUrl, s.serverUrl);
    this.lastFixedHealthCheckAt = now;
    this.cloudflareHealthPromise = (async () => {
      let service = { ok:false, supported:false, installed:false, running:false, state:'unknown' };
      let health = null;
      let healthError = '';
      try { service = await Promise.resolve(this.cloudflaredServiceDetector()); } catch (error) { service = { ...service, error:text(error?.message || error, 500) }; }
      try { health = await this.publicHealthCheck(fixed); } catch (error) { healthError = text(error?.message || error, 500); }
      const healthOk = !!health?.ok;
      this.cloudflareStatus = {
        running:healthOk,
        publicUrl:fixed,
        originUrl:cloudflareOriginUrl(s.serverPort),
        command:'Windows Service',
        version:'',
        externallyManaged:true,
        serviceInstalled:!!service?.installed,
        serviceRunning:!!service?.running,
        serviceState:String(service?.state || ''),
        healthOk,
        lastCheckedAt:new Date().toISOString(),
        lastError:healthOk ? '' : (healthError || (service?.supported && !service?.running ? 'cloudflared Windows 服务未运行。' : '固定公网地址健康检查失败。'))
      };
      this.onUpdated(this.snapshot());
      return this.cloudflareStatus;
    })().finally(() => { this.cloudflareHealthPromise = null; });
    return this.cloudflareHealthPromise;
  }

  async startCloudflare() {
    const s = this.settings();
    if (!cloudflareMode(s.mode)) return this.cloudflareStatus;

    // V1.26.1: Named Tunnel is installed once as a Windows service. The app does
    // not launch a duplicate connector and never needs the Tunnel Token.
    if (s.mode === 'server-cloudflare-token') {
      const fixed = resolveFixedTeamPublicUrl(s.cloudflarePublicUrl, s.serverUrl);
      if (s.serverUrl !== fixed || s.cloudflarePublicUrl !== fixed || text(this.getCloudflareToken(),12000)) {
        this.setSettings({ ...s, serverUrl:fixed, cloudflarePublicUrl:fixed, cloudflareTunnelTokenProtected:'' });
      }
      await this.refreshFixedTunnelHealth({ force:true });
      return this.cloudflareStatus;
    }

    if (this.cloudflareRuntime) return this.cloudflareStatus;
    const detection = await detectCloudflared(s.cloudflaredPath || '');
    if (!detection.ok) throw new Error(detection.error || '未检测到 cloudflared。');
    const runtime = await startCloudflareTunnel({
      mode:s.mode,
      port:s.serverPort,
      publicUrl:s.cloudflarePublicUrl || s.serverUrl,
      token:'',
      cloudflaredPath:s.cloudflaredPath || '',
      detection,
      logger:(event,msg) => this.logger(`cloudflare-${event}`, msg)
    });
    this.cloudflareRuntime = runtime;
    this.cloudflareStatus = {
      running:true,
      publicUrl:runtime.publicUrl || '',
      originUrl:runtime.originUrl || cloudflareOriginUrl(s.serverPort),
      command:runtime.command || '',
      version:runtime.version || '',
      externallyManaged:false,
      serviceInstalled:false,
      serviceRunning:false,
      healthOk:true,
      lastCheckedAt:new Date().toISOString(),
      lastError:''
    };
    if (runtime.publicUrl && (s.serverUrl !== runtime.publicUrl || s.cloudflarePublicUrl !== runtime.publicUrl)) {
      this.setSettings({ ...s, serverUrl:runtime.publicUrl, cloudflarePublicUrl:runtime.publicUrl });
    }
    this.onUpdated(this.snapshot());
    return this.cloudflareStatus;
  }

  async stopCloudflare() {
    if (!this.cloudflareRuntime) {
      // Never stop the externally-managed Windows service when the app closes.
      if (this.settings().mode !== 'server-cloudflare-token') this.cloudflareStatus = { ...this.cloudflareStatus, running:false };
      return;
    }
    const runtime = this.cloudflareRuntime;
    this.cloudflareRuntime = null;
    try { await runtime.stop?.(); }
    finally { this.cloudflareStatus = { ...this.cloudflareStatus, running:false }; }
  }

  async stopServer() {
    if (!this.serverRuntime) return;
    await this.serverRuntime.stop();
    this.serverRuntime = null;
  }

  reconnectDelayMs() {
    const failures = Math.max(0, Number(this.consecutiveSyncFailures || 0));
    if (!failures) return this.settings().syncIntervalMs;
    return [1500, 3000, 6000, 10000, 15000][Math.min(failures - 1, 4)];
  }

  schedule(delay) {
    if (this.timer) clearTimeout(this.timer);
    const s = this.settings();
    if (!s.enabled) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.syncNow().catch(() => {}).finally(() => {
        const nextDelay = this.lastError ? this.reconnectDelayMs() : this.settings().syncIntervalMs;
        this.schedule(nextDelay);
      });
    }, Math.max(100, delay || s.syncIntervalMs));
  }

  async stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.stopCloudflare();
    await this.stopServer();
  }

  queueCrmContact(contact = {}, meta = {}) {
    const s = this.settings();
    if (!s.enabled) return { ok:false, skipped:true };
    const customer = sanitizeCrmContact(contact, meta);
    if (!customer.globalCustomerId) return { ok:false, skipped:true };
    this.outbox.customers[customer.globalCustomerId] = customer;
    const task = isLeadPlatform(customer.sourcePlatform) ? buildHandoffTask(customer, meta) : null;
    if (task) {
      task.publisherDeviceId = s.deviceId;
      task.publisherDeviceName = s.deviceName;
      const prior = this.outbox.tasks[task.taskId] || this.inboxTasks[task.taskId];
      const queuedTask = {
        ...task,
        ...(prior && ['accepted','bound','completed'].includes(prior.status) ? {
          status:prior.status,
          assignedDeviceId:prior.assignedDeviceId,
          assignedDeviceName:prior.assignedDeviceName,
          boundLineAccountId:prior.boundLineAccountId,
          boundLineAccountName:prior.boundLineAccountName,
          boundLineChatId:prior.boundLineChatId,
          boundLineDisplayName:prior.boundLineDisplayName
        } : {}),
        updatedAt:new Date().toISOString()
      };
      this.outbox.tasks[task.taskId] = queuedTask;
      // V1.27.42: show the exact same optimistic pending task in the task list
      // and the top badge immediately. Previously the badge/list could lag until
      // the next cloud round trip because snapshot() only exposed inboxTasks.
      this.inboxTasks[task.taskId] = queuedTask;
    }
    this.saveState();
    this.onUpdated(this.snapshot());
    this.schedule(80);
    return { ok:true, customer, task:task || null };
  }

  markTask(taskId, patch = {}) {
    const id = text(taskId, 120);
    const current = this.inboxTasks[id] || this.outbox.tasks[id];
    if (!current) throw new Error('承接任务不存在。');
    const next = { ...current, ...patch, taskId:id, updatedAt:new Date().toISOString() };
    this.inboxTasks[id] = next;
    this.outbox.tasks[id] = next;
    this.saveState();
    this.schedule(50);
    this.onUpdated(this.snapshot());
    return next;
  }

  async performAdminAction(action = {}) {
    const run = async () => {
      const s = this.settings();
      if (!s.enabled) throw new Error('团队同步尚未启用。');
      if (String(s.role || '') !== 'admin') throw new Error('只有管理员可以删除团队记录。');
      // Never delete the currently connected device. Removing another online
      // device is allowed, but it will naturally register again on its next sync.
      const type = text(action?.type, 80);
      const deviceId = text(action?.deviceId, 120);
      const taskId = text(action?.taskId, 120);
      if (!['delete-device','delete-task'].includes(type)) throw new Error('不支持的团队管理操作。');
      if (type === 'delete-device' && !deviceId) throw new Error('缺少要删除的设备ID。');
      if (type === 'delete-device' && deviceId === String(s.deviceId || '')) throw new Error('不能删除当前正在使用的本机节点。');
      if (type === 'delete-task' && !taskId) throw new Error('缺少要删除的任务ID。');
      while (this.syncing) await new Promise(resolve => setTimeout(resolve, 80));
      this.syncing = true;
      try {
        this.nodeCapabilities = normalizeNodeCapabilities(await Promise.resolve(this.getNodeCapabilities() || {}));
        const actionId = text(action?.actionId, 120) || `admin-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
        const syncSettings = (this.serverRuntime && s.mode !== 'client') ? { ...s, serverUrl:cloudflareOriginUrl(s.serverPort) } : s;
        const result = await syncTeam(syncSettings, {
          lineEndpoints:this.activeLineEndpoints(this.nodeCapabilities),
          nodeCapabilities:this.nodeCapabilities,
          customers:[], tasks:[],
          adminActions:[{ actionId, type, deviceId, taskId }]
        });
        for (const id of Array.isArray(result.deletedTaskIds) ? result.deletedTaskIds : []) { const key=text(id,120); if(key){ delete this.inboxTasks[key]; delete this.outbox.tasks[key]; } }
        const ack = (Array.isArray(result.actionAcks) ? result.actionAcks : []).find(row => String(row?.actionId || '') === actionId) || null;
        if (!ack?.ok) {
          const code = String(ack?.error || 'server-rejected');
          if (code === 'cannot-delete-current-device') throw new Error('不能删除当前正在使用的本机节点。');
          if (code === 'device-has-active-tasks') throw new Error('这个节点还有“已接单待绑定”的任务，请先完成或处理任务后再删除节点。');
          if (code === 'admin-required') throw new Error('服务器拒绝删除：需要管理员权限。');
          throw new Error(`服务器拒绝团队管理操作：${code}`);
        }
        if (type === 'delete-task' && taskId) { delete this.inboxTasks[taskId]; delete this.outbox.tasks[taskId]; }
        for (const t of Array.isArray(result.tasks) ? result.tasks : []) if (t?.taskId) this.inboxTasks[t.taskId] = t;
        this.lastStats = result.stats || this.lastStats;
        this.teamDevices = Array.isArray(result.devices) ? result.devices.slice(0,200) : this.teamDevices;
        this.lastSyncAt = new Date().toISOString();
        this.lastError = '';
        this.saveState();
        this.onUpdated(this.snapshot());
        return { ok:true, ack, state:this.snapshot() };
      } catch (error) {
        this.lastError = text(error?.message || error, 500);
        this.onUpdated(this.snapshot());
        throw error;
      } finally { this.syncing = false; }
    };
    const next = this.adminActionChain.then(run, run);
    this.adminActionChain = next.catch(() => {});
    return next;
  }

  async syncNow() {
    const s = this.settings();
    if (!s.enabled) return this.snapshot();
    if (this.syncing) return this.snapshot();
    this.syncing = true;
    try {
      this.nodeCapabilities = normalizeNodeCapabilities(await Promise.resolve(this.getNodeCapabilities() || {}));
      const customers = Object.values(this.outbox.customers).slice(0,500);
      const tasks = Object.values(this.outbox.tasks).filter(task => {
        // V1.26.1 typo fix: V1.26.0 used a nonexistent property name here,
        // accidentally bypassing the source-login filter for pending tasks.
        if (!this.dynamicCapabilitiesConfigured || String(task?.status || 'pending') !== 'pending') return true;
        const ids = loggedAccountIds(this.nodeCapabilities, String(task?.sourcePlatform || ''));
        return ids.has(String(task?.sourceAccountId || ''));
      }).slice(0,500);
      const syncSettings = (this.serverRuntime && s.mode !== 'client') ? { ...s, serverUrl:cloudflareOriginUrl(s.serverPort) } : s;
      const result = await syncTeam(syncSettings, {
        lineEndpoints:this.activeLineEndpoints(this.nodeCapabilities),
        nodeCapabilities:this.nodeCapabilities,
        customers,
        tasks
      });
      for (const id of Array.isArray(result.deletedTaskIds) ? result.deletedTaskIds : []) { const key=text(id,120); if(key){ delete this.inboxTasks[key]; delete this.outbox.tasks[key]; } }
      for (const t of Array.isArray(result.taskAcks) ? result.taskAcks : []) if (t?.taskId && String(t?.status||'')!=='deleted') this.inboxTasks[t.taskId] = t;
      for (const t of Array.isArray(result.tasks) ? result.tasks : []) if (t?.taskId) this.inboxTasks[t.taskId] = t;
      this.outbox.customers = {};
      this.outbox.tasks = {};
      this.lastStats = result.stats || this.lastStats;
      this.teamDevices = Array.isArray(result.devices) ? result.devices.slice(0,200) : this.teamDevices;
      const recovered = this.consecutiveSyncFailures > 0;
      this.consecutiveSyncFailures = 0;
      this.lastSyncAt = new Date().toISOString();
      if (recovered) this.lastRecoveredAt = this.lastSyncAt;
      this.lastError = '';
      this.saveState();
      this.onUpdated(this.snapshot());
      if (s.mode === 'server-cloudflare-token') this.refreshFixedTunnelHealth({ force:false }).catch(() => {});
      return this.snapshot();
    } catch (error) {
      this.consecutiveSyncFailures += 1;
      this.lastError = text(error?.message || error, 500);
      this.saveState();
      this.onUpdated(this.snapshot());
      this.schedule(this.reconnectDelayMs());
      throw error;
    } finally { this.syncing = false; }
  }
}

module.exports = { TeamSyncRuntime };
