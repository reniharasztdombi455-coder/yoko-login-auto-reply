const http = require('node:http');
const { URL } = require('node:url');

const DEFAULT_PORTS = Array.from({ length: 31 }, (_, i) => 3188 + i);
let cachedBase = '';
let cachedUntil = 0;

function requestJson(base, pathname, { method='GET', body=null, timeoutMs=90000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, base);
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: `${u.pathname}${u.search}`,
      method,
      headers: data ? { 'Content-Type':'application/json', 'Content-Length':data.length } : {}
    }, res => {
      const chunks=[];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw=Buffer.concat(chunks).toString('utf8');
        let parsed={};
        try { parsed=raw ? JSON.parse(raw) : {}; } catch { return reject(new Error(`Chat Script AI 返回了无效 JSON (${res.statusCode})`)); }
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(parsed?.error || `Chat Script AI HTTP ${res.statusCode}`));
        resolve(parsed);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('连接 Chat Script AI 超时')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function discover() {
  const env = String(process.env.CHAT_SCRIPT_AI_URL || '').trim();
  if (env) {
    const base = env.endsWith('/') ? env : `${env}/`;
    const h = await requestJson(base, '/api/integration/yokoscrm/health', { timeoutMs:1000 });
    if (h?.ok) { cachedBase=base; cachedUntil=Date.now()+60000; return { base, health:h }; }
  }
  if (cachedBase && cachedUntil > Date.now()) {
    try { const h=await requestJson(cachedBase,'/api/integration/yokoscrm/health',{timeoutMs:700}); if(h?.ok)return {base:cachedBase,health:h}; } catch {}
    cachedBase=''; cachedUntil=0;
  }
  // Default port first, then the remaining launcher range in parallel.
  const bases = DEFAULT_PORTS.map(p => `http://127.0.0.1:${p}/`);
  for (const group of [bases.slice(0,1), bases.slice(1)]) {
    const attempts = group.map(async base => {
      const health = await requestJson(base, '/api/integration/yokoscrm/health', { timeoutMs:650 });
      if (!health?.ok) throw new Error('not chatscript');
      return { base, health };
    });
    try {
      const found = await Promise.any(attempts);
      cachedBase=found.base; cachedUntil=Date.now()+60000; return found;
    } catch {}
  }
  throw new Error('未检测到 Chat Script AI。请先启动 Chat Script AI V3.4.3 或更高版本。');
}

async function call(path, options={}) {
  const found=await discover();
  try { return await requestJson(found.base,path,options); }
  catch (e) { cachedBase=''; cachedUntil=0; throw e; }
}

module.exports = {
  async health(){ try { const x=await discover(); return {ok:true,baseUrl:x.base,...x.health}; } catch(e){ return {ok:false,error:e.message}; } },
  async resolveCustomer(payload){ return call('/api/integration/yokoscrm/resolve-customer',{method:'POST',body:payload,timeoutMs:5000}); },
  async draft(payload){ return call('/api/integration/yokoscrm/draft',{method:'POST',body:payload,timeoutMs:300000}); },
  async markSent(payload){ return call('/api/integration/yokoscrm/mark-sent',{method:'POST',body:payload,timeoutMs:5000}); },
  async feedback(payload){ return call('/api/integration/yokoscrm/feedback',{method:'POST',body:payload,timeoutMs:5000}); },
  async status(externalCustomerId){ return call(`/api/integration/yokoscrm/status?external_customer_id=${encodeURIComponent(externalCustomerId)}`,{timeoutMs:3000}); },
  clearCache(){ cachedBase=''; cachedUntil=0; }
};
