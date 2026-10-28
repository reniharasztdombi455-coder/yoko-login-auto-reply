'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();
const publish = Array.isArray(pkg.build?.publish) ? pkg.build.publish[0] : null;
const owner = String(publish?.owner || '').trim();
const repo = String(publish?.repo || '').trim();
const token = String(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();

if (!version || !owner || !repo) {
  console.error('[ERROR] package.json 缺少 version 或 GitHub publish.owner/repo。');
  process.exit(1);
}
if (!token) {
  console.error('[ERROR] 未设置 GH_TOKEN。');
  console.error('请先执行：set "GH_TOKEN=你的GitHubToken"');
  process.exit(1);
}

const tag = `v${version}`;
const dist = path.join(root, 'dist');
const setupName = `YokoSCRM-${version}-Setup.exe`;
const blockmapName = `${setupName}.blockmap`;
const latestName = 'latest.yml';
const setupPath = path.join(dist, setupName);
const blockmapPath = path.join(dist, blockmapName);
const latestPath = path.join(dist, latestName);

function runBuild() {
  console.log(`\n[1/4] Building Yoko SCRM ${version} (no publishing)...`);

  // electron-builder 26.x exposes its executable as node_modules/electron-builder/cli.js.
  // Call that JavaScript file with the current Node executable so Windows does not
  // depend on npx.cmd / shell behaviour.
  let builderCli;
  try {
    builderCli = require.resolve('electron-builder/cli.js', { paths: [root] });
  } catch (error) {
    builderCli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
  }

  if (!fs.existsSync(builderCli)) {
    console.error(`[ERROR] electron-builder CLI not found: ${builderCli}`);
    console.error('Run: npm install');
    process.exit(1);
  }

  console.log(`[build] CLI: ${builderCli}`);
  const result = spawnSync(process.execPath, [builderCli, '--win', 'nsis', '--publish', 'never'], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    env: process.env,
    windowsHide: false
  });

  if (result.error) {
    console.error('[ERROR] Failed to start electron-builder:');
    console.error(result.error);
    process.exit(1);
  }
  if (result.signal) {
    console.error(`[ERROR] electron-builder terminated by signal ${result.signal}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[ERROR] electron-builder exited with code ${result.status}`);
    process.exit(result.status || 1);
  }

  // Never treat a silent/empty build as success.
  if (!fs.existsSync(setupPath) || !fs.existsSync(blockmapPath)) {
    console.error('[ERROR] electron-builder returned success but expected artifacts were not created.');
    console.error(`Missing: ${!fs.existsSync(setupPath) ? setupName : ''} ${!fs.existsSync(blockmapPath) ? blockmapName : ''}`.trim());
    console.error('Run the following command manually to inspect the builder output:');
    console.error(`  node "${builderCli}" --win nsis --publish never`);
    process.exit(1);
  }
}
function sha512Base64(file) {
  const hash = crypto.createHash('sha512');
  hash.update(fs.readFileSync(file));
  return hash.digest('base64');
}

function generateLatestYml() {
  if (!fs.existsSync(setupPath)) throw new Error(`缺少 ${setupName}`);
  if (!fs.existsSync(blockmapPath)) throw new Error(`缺少 ${blockmapName}`);

  const stat = fs.statSync(setupPath);
  const sha512 = sha512Base64(setupPath);
  const releaseDate = new Date().toISOString();
  const yaml = [
    `version: ${version}`,
    'files:',
    `  - url: ${setupName}`,
    `    sha512: ${sha512}`,
    `    size: ${stat.size}`,
    `path: ${setupName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    ''
  ].join('\n');
  fs.writeFileSync(latestPath, yaml, 'utf8');
}

function request(method, hostname, pathname, { headers = {}, body = null, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      method,
      hostname,
      path: pathname,
      headers: {
        'User-Agent': 'Yoko-SCRM-Publisher',
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...headers
      }
    };
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (raw) return resolve({ status: res.statusCode, body: buf, headers: res.headers });
          if (!text) return resolve({ status: res.statusCode, data: null, headers: res.headers });
          try { return resolve({ status: res.statusCode, data: JSON.parse(text), headers: res.headers }); }
          catch { return resolve({ status: res.statusCode, data: text, headers: res.headers }); }
        }
        const err = new Error(`GitHub HTTP ${res.statusCode}: ${text || res.statusMessage}`);
        err.statusCode = res.statusCode;
        reject(err);
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function api(method, apiPath, data = null) {
  const body = data == null ? null : Buffer.from(JSON.stringify(data), 'utf8');
  const headers = body ? {
    'Content-Type': 'application/json',
    'Content-Length': body.length
  } : {};
  const res = await request(method, 'api.github.com', apiPath, { headers, body });
  return res.data;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function renderUploadProgress(name, sent, total, startedAt, force = false) {
  const now = Date.now();
  const elapsed = Math.max((now - startedAt) / 1000, 0.001);
  const ratio = total > 0 ? Math.min(sent / total, 1) : 1;
  const percent = ratio * 100;
  const speed = sent / elapsed;
  const eta = speed > 0 ? (total - sent) / speed : NaN;
  const width = 24;
  const done = Math.round(ratio * width);
  const bar = `${'█'.repeat(done)}${'░'.repeat(Math.max(0, width - done))}`;
  const line = `[${bar}] ${percent.toFixed(1).padStart(5)}%  ${formatBytes(sent)} / ${formatBytes(total)}  ${formatBytes(speed)}/s  ETA ${formatDuration(eta)}  ${name}`;
  const padded = line.padEnd(Math.max(line.length, 118), ' ');
  process.stdout.write(`\r${padded}`);
  if (force) process.stdout.write('\n');
}

function uploadAsset(releaseId, filePath, name) {
  return new Promise((resolve, reject) => {
    const total = fs.statSync(filePath).size;
    const uploadPath = `/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
    const startedAt = Date.now();
    let sent = 0;
    let lastPaint = 0;
    let settled = false;

    const options = {
      method: 'POST',
      hostname: 'uploads.github.com',
      path: uploadPath,
      headers: {
        'User-Agent': 'Yoko-SCRM-Publisher',
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/octet-stream',
        'Content-Length': total
      }
    };

    const finishError = error => {
      if (settled) return;
      settled = true;
      process.stdout.write('\n');
      reject(error);
    };

    console.log(`\nUploading ${name}`);
    renderUploadProgress(name, 0, total, startedAt);

    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        if (settled) return;
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          settled = true;
          renderUploadProgress(name, total, total, startedAt, true);
          try {
            resolve(text ? JSON.parse(text) : null);
          } catch {
            resolve(text || null);
          }
          return;
        }
        const err = new Error(`GitHub HTTP ${res.statusCode}: ${text || res.statusMessage}`);
        err.statusCode = res.statusCode;
        finishError(err);
      });
    });

    req.on('error', finishError);
    req.setTimeout(15 * 60 * 1000, () => {
      req.destroy(new Error(`上传超时：${name} 超过 15 分钟没有完成`));
    });

    const input = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
    input.on('error', error => {
      req.destroy();
      finishError(error);
    });
    input.on('data', chunk => {
      sent += chunk.length;
      const now = Date.now();
      if (now - lastPaint >= 250 || sent >= total) {
        lastPaint = now;
        renderUploadProgress(name, sent, total, startedAt);
      }
      if (!req.write(chunk)) {
        input.pause();
        req.once('drain', () => input.resume());
      }
    });
    input.on('end', () => req.end());
  });
}

async function main() {
  runBuild();

  console.log('\n[2/4] Generating and verifying update metadata...');
  generateLatestYml();
  const files = [
    [setupPath, setupName],
    [blockmapPath, blockmapName],
    [latestPath, latestName]
  ];
  for (const [file, name] of files) {
    if (!fs.existsSync(file) || fs.statSync(file).size <= 0) {
      throw new Error(`构建不完整：${name} 不存在或为空`);
    }
    console.log(`[OK] ${name} (${fs.statSync(file).size} bytes)`);
  }

  console.log(`\n[3/4] Preparing one GitHub Draft ${tag}...`);
  const releases = await api('GET', `/repos/${owner}/${repo}/releases?per_page=100`);
  const sameTag = (Array.isArray(releases) ? releases : []).filter(r => r.tag_name === tag);
  const published = sameTag.find(r => !r.draft);
  if (published) {
    throw new Error(`${tag} 已经正式发布。为防止破坏自动更新校验，本脚本不会覆盖已发布 Release。请升级版本号。`);
  }

  const drafts = sameTag.filter(r => r.draft);
  let release = drafts.sort((a, b) => {
    const ac = Array.isArray(a.assets) ? a.assets.length : 0;
    const bc = Array.isArray(b.assets) ? b.assets.length : 0;
    return bc - ac || new Date(b.created_at) - new Date(a.created_at);
  })[0] || null;

  // Remove duplicate old drafts left by the previous concurrent publisher.
  for (const duplicate of drafts) {
    if (release && duplicate.id === release.id) continue;
    console.log(`[cleanup] deleting duplicate Draft id=${duplicate.id}`);
    await api('DELETE', `/repos/${owner}/${repo}/releases/${duplicate.id}`);
  }

  if (!release) {
    release = await api('POST', `/repos/${owner}/${repo}/releases`, {
      tag_name: tag,
      target_commitish: 'main',
      name: version,
      body: `Yoko SCRM ${tag}`,
      draft: true,
      prerelease: false
    });
    console.log(`[OK] created one Draft id=${release.id}`);
  } else {
    console.log(`[OK] reusing Draft id=${release.id}`);
  }

  const targetNames = new Set(files.map(([, name]) => name));
  const fresh = await api('GET', `/repos/${owner}/${repo}/releases/${release.id}`);
  for (const asset of (fresh.assets || [])) {
    if (targetNames.has(asset.name)) {
      console.log(`[replace] deleting old asset ${asset.name}`);
      await api('DELETE', `/repos/${owner}/${repo}/releases/assets/${asset.id}`);
    }
  }

  console.log('\n[4/4] Uploading assets sequentially with live progress...');
  for (const [file, name] of files) {
    await uploadAsset(release.id, file, name);
    console.log(`[OK] ${name}`);
  }

  const verify = await api('GET', `/repos/${owner}/${repo}/releases/${release.id}`);
  const names = new Set((verify.assets || []).map(a => a.name));
  const missing = files.map(([, name]) => name).filter(name => !names.has(name));
  if (missing.length) throw new Error(`Draft 校验失败，缺少：${missing.join(', ')}`);

  console.log('\nVerified assets: 3/3');
  console.log(`  - ${setupName}`);
  console.log(`  - ${blockmapName}`);
  console.log(`  - ${latestName}`);

  // Publish only after the remote Draft itself has been verified to contain all
  // three updater artifacts. Any earlier failure leaves a harmless Draft, so
  // installed clients never see an incomplete latest.yml release.
  console.log('\nPublishing verified Draft automatically...');
  const publishedRelease = await api('PATCH', `/repos/${owner}/${repo}/releases/${release.id}`, {
    draft: false,
    prerelease: false,
    make_latest: 'true'
  });
  if (publishedRelease?.draft === true) {
    throw new Error('GitHub 返回的 Release 仍是 Draft，自动发布未完成。');
  }

  console.log('\n==========================================');
  console.log(`SUCCESS: GitHub Release ${tag} published automatically.`);
  console.log('Verified assets: 3/3');
  console.log(`Latest: ${publishedRelease?.html_url || `https://github.com/${owner}/${repo}/releases/tag/${tag}`}`);
  console.log('无需再手动点击 Publish release。');
  console.log('==========================================\n');

}

main().catch(error => {
  console.error('\nPUBLISH FAILED');
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
