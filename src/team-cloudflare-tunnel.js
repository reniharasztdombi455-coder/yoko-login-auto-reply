'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const https = require('https');

function clean(value, max = 1000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function stripWrappingQuotes(value = '') {
  const raw = clean(value, 2000);
  if (raw.length >= 2 && ((raw.startsWith('\"') && raw.endsWith('\"')) || (raw.startsWith("'") && raw.endsWith("'")))) return raw.slice(1, -1).trim();
  return raw;
}

function expandWindowsEnv(value = '', env = process.env) {
  return String(value || '').replace(/%([^%]+)%/g, (_m, key) => env?.[key] ?? env?.[String(key).toUpperCase()] ?? _m);
}

function normalizeExplicitCloudflaredPath(value = '', { platform = process.platform, fsImpl = fs, env = process.env } = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  let raw = stripWrappingQuotes(value);
  if (!raw) return '';
  if (platform === 'win32') raw = expandWindowsEnv(raw, env).replace(/\//g, '\\');
  try {
    const stat = fsImpl.statSync(raw);
    if (stat?.isDirectory?.()) {
      const child = pathApi.join(raw, platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
      if (fsImpl.existsSync(child)) return child;
    }
  } catch {}
  return raw;
}

function normalizePublicUrl(value = '') {
  const raw = clean(value, 500).replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return '';
    return u.toString().replace(/\/+$/, '');
  } catch { return ''; }
}


const DEFAULT_FIXED_TEAM_PUBLIC_URL = 'https://team.dalongvpn.cc.cd';

function isTryCloudflareUrl(value = '') {
  const url = normalizePublicUrl(value);
  return !!url && /\.trycloudflare\.com$/i.test(new URL(url).hostname || '');
}

function resolveFixedTeamPublicUrl(publicUrl = '', serverUrl = '') {
  for (const candidate of [publicUrl, serverUrl]) {
    const normalized = normalizePublicUrl(candidate);
    if (normalized && !isTryCloudflareUrl(normalized)) return normalized;
  }
  return DEFAULT_FIXED_TEAM_PUBLIC_URL;
}

function testCloudflarePublicHealth(publicUrl = '', { timeoutMs = 8000, getImpl = https.get } = {}) {
  return new Promise((resolve, reject) => {
    const base = normalizePublicUrl(publicUrl);
    if (!base) return reject(new Error('请填写有效的 HTTPS Cloudflare 公网地址。'));
    let target;
    try { target = new URL(`${base}/health`); }
    catch { return reject(new Error('Cloudflare 公网地址格式无效。')); }
    let req;
    try {
      req = getImpl(target, { timeout:Math.max(1000, Number(timeoutMs || 8000)), headers:{'user-agent':'YokoSCRM-TeamHealth/1.26.2'} }, res => {
        let body='';
        res.on?.('data', c => body += String(c || ''));
        res.on?.('end', () => {
          let parsed={}; try { parsed=JSON.parse(body||'{}'); } catch {}
          if (res.statusCode >= 200 && res.statusCode < 300 && parsed?.service === 'yoko-team-sync') {
            return resolve({ok:true,url:base,statusCode:res.statusCode,service:parsed.service,time:parsed.time||''});
          }
          reject(new Error(`Cloudflare 固定地址未连到 Yoko 团队服务器（HTTP ${res.statusCode}）。`));
        });
      });
    } catch (error) { return reject(error); }
    req?.on?.('timeout', () => req.destroy?.(new Error('Cloudflare 固定地址健康检查超时。')));
    req?.on?.('error', reject);
  });
}

function detectCloudflaredWindowsService({ platform = process.platform, spawnImpl = spawn, timeoutMs = 4500, env = process.env } = {}) {
  if (platform !== 'win32') return Promise.resolve({ok:false,supported:false,installed:false,running:false,state:'unsupported'});
  return new Promise(resolve => {
    let child; let output=''; let done=false;
    const finish = result => { if(done)return; done=true; clearTimeout(timer); try{child?.kill?.();}catch{} resolve(result); };
    const timer=setTimeout(()=>finish({ok:false,supported:true,installed:false,running:false,state:'timeout',error:'cloudflared Windows 服务检测超时'}),Math.max(1000,Number(timeoutMs||4500)));
    try {
      const comspec=env.ComSpec||env.COMSPEC||'sc.exe';
      const useCmd=/cmd(?:\.exe)?$/i.test(String(comspec));
      const command=useCmd?comspec:'sc.exe';
      const args=useCmd?['/d','/s','/c','sc.exe query cloudflared']:['query','cloudflared'];
      child=spawnImpl(command,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
      child.stdout?.on('data',c=>output+=String(c||'')); child.stderr?.on('data',c=>output+=String(c||''));
      child.once('error',error=>finish({ok:false,supported:true,installed:false,running:false,state:'error',error:clean(error?.message||error,700)}));
      child.once('close',code=>{
        const normalized=String(output||'').replace(/\r/g,'');
        const installed=/SERVICE_NAME\s*:\s*cloudflared/i.test(normalized)||/STATE\s*:/i.test(normalized);
        const running=/STATE\s*:\s*4\s+RUNNING/i.test(normalized)||/\bRUNNING\b/i.test(normalized);
        const stopped=/STATE\s*:\s*1\s+STOPPED/i.test(normalized)||/\bSTOPPED\b/i.test(normalized);
        finish({ok:installed,supported:true,installed,running,state:running?'running':(stopped?'stopped':(installed?'installed':'not-installed')),code:Number(code||0),raw:clean(normalized.replace(/\s+/g,' '),900)});
      });
    } catch(error){finish({ok:false,supported:true,installed:false,running:false,state:'error',error:clean(error?.message||error,700)});}
  });
}

function parseQuickTunnelUrl(text = '') {
  const match = String(text || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/ig);
  return match && match.length ? normalizePublicUrl(match[match.length - 1]) : '';
}

function cloudflareMode(mode = '') {
  return ['server-cloudflare-quick', 'server-cloudflare-token'].includes(String(mode || ''));
}

function cloudflareOriginUrl(port = 17891) {
  const p = Math.max(1024, Math.min(65535, Number(port || 17891) || 17891));
  return `http://127.0.0.1:${p}`;
}

function commandCandidates(explicitPath = '', options = {}) {
  const { platform = process.platform, fsImpl = fs, env = process.env } = options;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const out = [];
  const explicit = normalizeExplicitCloudflaredPath(explicitPath, { platform, fsImpl, env });
  const envExplicit = normalizeExplicitCloudflaredPath(env.CLOUDFLARED_PATH, { platform, fsImpl, env });
  const push = value => { const v = clean(value, 1000); if (v && !out.includes(v)) out.push(v); };

  // A user-supplied executable path is authoritative. Do NOT discard it merely because
  // Node/Electron fs.existsSync() returns false on a Windows host. Security software,
  // virtualized Desktop folders and path-normalization edge cases can make the JS-level
  // preflight disagree with CreateProcess/cmd.exe. The actual version probe below is the
  // source of truth and gives a useful native error if the file truly cannot be launched.
  push(explicit);
  push(envExplicit);

  const optionalAbsolute = [];
  try { optionalAbsolute.push(pathApi.join(process.resourcesPath || '', platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')); } catch {}
  try { optionalAbsolute.push(pathApi.join(__dirname, '..', 'vendor', 'cloudflared', platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')); } catch {}
  if (platform === 'win32') {
    optionalAbsolute.push(pathApi.join(env.LOCALAPPDATA || '', 'cloudflared', 'cloudflared.exe'));
    optionalAbsolute.push(pathApi.join(env.ProgramFiles || 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'));
  } else {
    optionalAbsolute.push('/usr/local/bin/cloudflared', '/usr/bin/cloudflared');
  }
  for (const candidate of optionalAbsolute) {
    if (!candidate) continue;
    if (!pathApi.isAbsolute(candidate) || fsImpl.existsSync(candidate)) push(candidate);
  }
  if (platform === 'win32') { push('cloudflared.exe'); push('cloudflared'); }
  else push('cloudflared');
  return out;
}

function versionResultFromOutput(command, output = '', code = 0, launchMode = 'direct') {
  const normalized = clean(String(output || '').replace(/\s+/g, ' '), 1000);
  if (code === 0 && /cloudflared/i.test(normalized)) return { ok:true, command, version:clean(normalized, 300), launchMode };
  return { ok:false, command, error:clean(normalized || `exit ${code}`, 700), launchMode };
}

function probeSpawn(command, args, spawnCommand, spawnArgs, { timeoutMs = 4500, spawnImpl = spawn, launchMode = 'direct' } = {}) {
  return new Promise(resolve => {
    let child;
    let output = '';
    let done = false;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); try { child?.kill?.(); } catch {} resolve(result); };
    const timer = setTimeout(() => finish({ ok:false, command, error:'cloudflared 版本检测超时', launchMode }), timeoutMs);
    try {
      child = spawnImpl(spawnCommand, spawnArgs, { windowsHide:true, stdio:['ignore','pipe','pipe'] });
      child.stdout?.on('data', chunk => { output += String(chunk || ''); });
      child.stderr?.on('data', chunk => { output += String(chunk || ''); });
      child.once('error', error => finish({ ok:false, command, error:clean(error?.message || error, 700), code:error?.code || '', launchMode }));
      child.once('close', code => finish(versionResultFromOutput(command, output, code, launchMode)));
    } catch (error) { finish({ ok:false, command, error:clean(error?.message || error, 700), code:error?.code || '', launchMode }); }
  });
}

async function probeOne(command, { timeoutMs = 4500, spawnImpl = spawn, platform = process.platform, env = process.env } = {}) {
  const direct = await probeSpawn(command, ['--version'], command, ['--version'], { timeoutMs, spawnImpl, launchMode:'direct' });
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (direct.ok || platform !== 'win32' || !pathApi.isAbsolute(command)) return direct;

  // Windows fallback: some Electron/AV combinations reject a direct CreateProcess call for a freshly-downloaded EXE
  // while cmd.exe can still launch it normally. Keep the original path as the trusted executable target.
  const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe';
  const commandLine = `\"${String(command).replace(/\"/g, '\\\"')}\" --version`;
  const viaCmd = await probeSpawn(command, ['--version'], comspec, ['/d','/s','/c', commandLine], { timeoutMs, spawnImpl, launchMode:'cmd' });
  if (viaCmd.ok) return viaCmd;
  return {
    ok:false, command, launchMode:'direct',
    error:`直接启动失败：${clean(direct.error, 420)}；Windows 兼容启动失败：${clean(viaCmd.error, 420)}`,
    directError:direct.error || '', cmdError:viaCmd.error || ''
  };
}

async function detectCloudflared(explicitPath = '', options = {}) {
  const platform = options.platform || process.platform;
  const fsImpl = options.fsImpl || fs;
  const env = options.env || process.env;
  const normalizedExplicit = normalizeExplicitCloudflaredPath(explicitPath, { platform, fsImpl, env });
  const errors = [];
  const candidates = commandCandidates(explicitPath, { platform, fsImpl, env });
  for (const command of candidates) {
    const result = await probeOne(command, { ...options, platform, env });
    if (result.ok) return result;
    errors.push(`${command}: ${result.error}`);
  }
  let prefix = '未检测到 cloudflared。';
  if (normalizedExplicit) {
    const pathApi = platform === 'win32' ? path.win32 : path.posix;
    const exists = !pathApi.isAbsolute(normalizedExplicit) || fsImpl.existsSync(normalizedExplicit);
    prefix = exists
      ? `已找到 cloudflared 文件，但实际启动失败：${normalizedExplicit}`
      : `Node 路径预检未识别该文件，但已经实际尝试启动：${normalizedExplicit}`;
  }
  return { ok:false, command:normalizedExplicit || '', version:'', error:`${prefix}${errors.length ? `\n${errors[0]}` : ''}`, details:errors.slice(0,8) };
}

function spawnCloudflaredRuntime(found, args, { spawnImpl = spawn, env = process.env, platform = process.platform } = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32' && found?.launchMode === 'cmd' && pathApi.isAbsolute(found.command || '')) {
    const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe';
    const escaped = [found.command, ...args].map(v => `"${String(v).replace(/"/g, '\\"')}"`).join(' ');
    return spawnImpl(comspec, ['/d','/s','/c', escaped], { windowsHide:true, env, stdio:['ignore','pipe','pipe'] });
  }
  return spawnImpl(found.command, args, { windowsHide:true, env, stdio:['ignore','pipe','pipe'] });
}

function startCloudflareTunnel({
  mode = '', port = 17891, publicUrl = '', token = '', cloudflaredPath = '',
  logger = () => {}, spawnImpl = spawn, detection = null, timeoutMs = 20000
} = {}) {
  return new Promise(async (resolve, reject) => {
    if (!cloudflareMode(mode)) return reject(new Error('当前不是 Cloudflare Tunnel 模式。'));
    if (mode === 'server-cloudflare-token' && !clean(token, 12000)) return reject(new Error('固定 Cloudflare Tunnel 需要 Tunnel Token。'));
    const normalizedPublicUrl = normalizePublicUrl(publicUrl);
    if (mode === 'server-cloudflare-token' && !normalizedPublicUrl) return reject(new Error('固定 Cloudflare Tunnel 需要填写 HTTPS 公网地址，例如 https://crm.example.com。'));

    const found = detection && detection.ok ? detection : await detectCloudflared(cloudflaredPath, { spawnImpl });
    if (!found.ok) return reject(new Error(found.error || '未检测到 cloudflared。'));

    const origin = cloudflareOriginUrl(port);
    const args = mode === 'server-cloudflare-quick'
      ? ['tunnel', '--no-autoupdate', '--url', origin]
      : ['tunnel', '--no-autoupdate', 'run'];
    const env = { ...process.env };
    if (mode === 'server-cloudflare-token') env.TUNNEL_TOKEN = clean(token, 12000);

    let child;
    let combined = '';
    let quickUrl = '';
    let settled = false;
    let stopped = false;
    const cleanupTimer = () => { if (timer) clearTimeout(timer); };
    const finishOk = url => {
      if (settled) return;
      settled = true; cleanupTimer();
      const resultUrl = mode === 'server-cloudflare-quick' ? normalizePublicUrl(url) : normalizedPublicUrl;
      resolve({
        ok:true, mode, originUrl:origin, publicUrl:resultUrl,
        command:found.command, version:found.version, process:child,
        stop:() => stopChild(child),
        getLog:() => clean(combined, 12000)
      });
    };
    const fail = error => {
      if (settled) return;
      settled = true; cleanupTimer(); try { child?.kill?.(); } catch {}
      reject(error instanceof Error ? error : new Error(clean(error, 1000)));
    };
    const timer = setTimeout(() => {
      if (mode === 'server-cloudflare-token' && child && !child.killed) return finishOk(normalizedPublicUrl);
      fail(new Error(mode === 'server-cloudflare-quick' ? 'Cloudflare 快速隧道启动超时，未取得 trycloudflare.com 地址。' : 'Cloudflare 固定隧道启动超时。'));
    }, Math.max(5000, Number(timeoutMs || 20000)));

    try {
      child = spawnCloudflaredRuntime(found, args, { spawnImpl, env, platform:process.platform });
      const onData = chunk => {
        const line = String(chunk || ''); combined = (combined + line).slice(-24000); logger('cloudflared', clean(line, 1800));
        if (mode === 'server-cloudflare-quick') {
          const parsed = parseQuickTunnelUrl(combined);
          if (parsed) { quickUrl = parsed; finishOk(parsed); }
        } else if (/registered tunnel connection|connection .* registered|tunnel.*ready|starting metrics server/i.test(combined)) {
          finishOk(normalizedPublicUrl);
        }
      };
      child.stdout?.on('data', onData); child.stderr?.on('data', onData);
      child.once('error', error => fail(new Error(`cloudflared 启动失败：${clean(error?.message || error, 700)}`)));
      child.once('close', code => {
        if (stopped) return;
        if (!settled) fail(new Error(`cloudflared 已退出（code ${code}）：${clean(combined, 1200)}`));
      });
    } catch (error) { fail(error); }
  });
}

function stopChild(child) {
  return new Promise(resolve => {
    if (!child || child.killed) return resolve({ ok:true });
    let done = false;
    const finish = () => { if (done) return; done = true; resolve({ ok:true }); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(); }, 2200);
    child.once?.('close', () => { clearTimeout(timer); finish(); });
    try { child.kill(); } catch { clearTimeout(timer); finish(); }
  });
}

module.exports = {
  DEFAULT_FIXED_TEAM_PUBLIC_URL,
  normalizePublicUrl,
  isTryCloudflareUrl,
  resolveFixedTeamPublicUrl,
  testCloudflarePublicHealth,
  detectCloudflaredWindowsService,
  parseQuickTunnelUrl,
  cloudflareMode,
  cloudflareOriginUrl,
  stripWrappingQuotes,
  expandWindowsEnv,
  normalizeExplicitCloudflaredPath,
  commandCandidates,
  probeOne,
  spawnCloudflaredRuntime,
  detectCloudflared,
  startCloudflareTunnel,
  stopChild
};
