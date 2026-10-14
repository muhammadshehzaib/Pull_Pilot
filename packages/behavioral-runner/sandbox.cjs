// Trusted parent only. Application code is built/run in Docker, never on this host.
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { realpath, writeFile, readFile, unlink } = require('node:fs/promises');
const { request: httpRequest } = require('node:http');
const path = require('node:path');
const { LIMITS, parseExecution } = require('../../apps/backend/dist/services/behavioral/contracts.js');
const ORIGIN = 'https://sandbox.aipr.invalid';
// No arbitrary upstream: even a page/app sending an absolute URL can reach only
// this invocation's internal application. The relay contains no credentials.
const RELAY = `const http=require('node:http');
http.createServer((req,res)=>{
 if(!req.url.startsWith('/')||req.url.startsWith('//')){res.writeHead(400);res.end();return;}
 const upstream=http.request({hostname:'application',port:Number(process.env.TARGET_PORT),path:req.url,method:req.method,headers:req.headers,agent:false},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
 const timer=setTimeout(()=>upstream.destroy(),5000);
 upstream.on('close',()=>clearTimeout(timer));
 upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
 req.on('error',()=>upstream.destroy());req.pipe(upstream);
}).listen(3000,'0.0.0.0');`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function docker(args, timeout = 30_000) {
  return new Promise((resolve, reject) => execFile('docker', args, {
    timeout, maxBuffer: 64_000, windowsHide: true,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: process.env.HOME },
  }, (error, stdout) => error ? reject(new Error('Sandbox Docker operation failed')) : resolve(stdout.trim())));
}
async function startSandbox(rawConfig, source, deps = {}) {
  const config = parseExecution({ mode: 'OWNER_SANDBOX', sandbox: rawConfig }).sandbox;
  const command = deps.docker || docker;
  const root = await realpath(source);
  const file = await realpath(path.resolve(root, config.dockerfile));
  if (!file.startsWith(root + path.sep)) throw new Error('Dockerfile escaped application checkout');
  const prefix = 'aipr-sandbox-' + randomUUID();
  const app = prefix + '-app'; const db = prefix + '-db'; const relay = prefix + '-relay'; const image = prefix + ':local';
  if (deps.manifest) await writeFile(deps.manifest, JSON.stringify({ prefix }), { mode: 0o600 });
  async function cleanup() {
    // Exact invocation-owned names, never a broad host prune.
    for (const args of [['rm', '-f', '-v', app, db, relay], ['network', 'rm', prefix], ['image', 'rm', '-f', image]]) {
      await command(args).catch(() => {});
    }
    if (deps.manifest) await unlink(deps.manifest).catch(() => {});
  }
  try {
    await command(['build', '--pull', '--tag', image, '--file', file, root], 10 * 60_000);
    const volumes = JSON.parse(await command(['image', 'inspect', image, '--format', '{{json .Config.Volumes}}']));
    if (volumes && Object.keys(volumes).length) throw new Error('Sandbox application images cannot declare persistent volumes');
    await command(['pull', 'postgres:16-alpine'], 5 * 60_000);
    await command(['pull', 'node:22-alpine'], 5 * 60_000);
    await command(['network', 'create', '--internal', prefix]);
    const password = randomUUID();
    await command(['run', '-d', '--name', db, '--user', 'postgres', '--network', prefix, '--network-alias', 'database', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m', '--cpus', '1', '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,nodev,size=256m,uid=70,gid=70,mode=0700', '-e', 'POSTGRES_USER=aipr', '-e', 'POSTGRES_DB=aipr_test', '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:16-alpine']);
    let dbReady = false;
    const databaseDeadline = Date.now() + 30_000;
    for (let i = 0; i < 30 && Date.now() < databaseDeadline; i++) {
      try { await command(['exec', db, 'pg_isready', '-U', 'aipr', '-d', 'aipr_test'], 3000); dbReady = true; break; }
      catch { await (deps.sleep || sleep)(1000); }
    }
    if (!dbReady) throw new Error('Sandbox database unavailable');
    await command(['run', '-d', '--name', app, '--network', prefix, '--network-alias', 'application', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '1g', '--cpus', '1', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '-e', `DATABASE_URL=postgresql://aipr:${password}@database:5432/aipr_test`, '-e', 'AIPR_SANDBOX=1', '-e', 'PAYMENT_MODE=sandbox', '-e', `PORT=${config.port}`, '-e', `AIPR_PREVIEW_ORIGIN=${ORIGIN}`, image]);
    // Internal Docker networks intentionally do not publish ports. A separate
    // trusted fixed-upstream relay bridges loopback to the offline application.
    await command(['run', '-d', '--name', relay, '--network', 'bridge', '--publish', '127.0.0.1::3000', '--user', '65534:65534', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '32', '--memory', '128m', '--cpus', '0.25', '-e', `TARGET_PORT=${config.port}`, '--entrypoint', 'node', 'node:22-alpine', '-e', RELAY]);
    await command(['network', 'connect', prefix, relay]);
    const mapping = await command(['port', relay, '3000/tcp']);
    if (!/^127\.0\.0\.1:\d{1,5}$/.test(mapping)) throw new Error('Unexpected sandbox port binding');
    const endpoint = `http://${mapping}`;
    const transport = createSandboxTransport(config, endpoint, deps.fetch);
    let ready = false;
    const readyDeadline = Date.now() + 60_000;
    for (let i = 0; i < 60 && Date.now() < readyDeadline; i++) {
      try { const r = await transport.request(config.readyPath, 'GET'); if (r.status >= 200 && r.status < 400) { ready = true; break; } }
      catch { /* Bounded startup wait; no application response is logged. */ }
      await (deps.sleep || sleep)(1000);
    }
    if (!ready) throw new Error('Sandbox application unavailable');
    return { origin: ORIGIN, transport, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

function localFetch(url, options) {
  // Node's fetch overwrites Host. Use the HTTP client to retain the virtual
  // browser host while connecting only to the provisioned loopback socket.
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: options.method, headers: options.headers, signal: options.signal, agent: false }, response => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, item);
      }
      resolve({ status: response.statusCode, headers, body: response });
    });
    req.on('error', reject);
    req.end(options.body);
  });
}
function createSandboxTransport(rawConfig, endpoint, fetcher = localFetch) {
  const config = parseExecution({ mode: 'OWNER_SANDBOX', sandbox: rawConfig }).sandbox;
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(endpoint)) throw new Error('Invalid provisioned sandbox endpoint');
  const sessions = new Map();
  const budget = { requests: 0, bytes: 0 };
  async function request(relative, method, body, cookie, contentType) {
    const url = new URL(relative, endpoint);
    if (url.origin !== endpoint || url.username || url.password || url.hash) throw new Error('Invalid local path');
    if (++budget.requests > LIMITS.requests || (body && Buffer.byteLength(body) > 16_000)) throw new Error('Request budget exhausted');
    const headers = { Accept: '*/*', 'Accept-Encoding': 'identity' };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = contentType || 'application/json';
    // Host/Origin describe the virtual browser origin, never a browser-chosen host.
    headers.Host = 'sandbox.aipr.invalid'; headers.Origin = ORIGIN;
    const response = await fetcher(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    const chunks = []; let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.length; budget.bytes += chunk.length;
      if (size > LIMITS.responseBytes || budget.bytes > LIMITS.totalBytes) throw new Error('Response budget exhausted');
      chunks.push(Buffer.from(chunk));
    }
    return { status: response.status, headers: response.headers, body: Buffer.concat(chunks) };
  }
  async function control(scenario, step) {
    if (!sessions.has(scenario)) sessions.set(scenario, { namespace: randomUUID(), cookie: '' });
    const session = sessions.get(scenario);
    if (step.action === 'authenticate') {
      if (!config.sessionPath || step.fixture !== 'CUSTOMER') throw new Error('Authentication unavailable');
      const response = await request(config.sessionPath, 'POST', JSON.stringify({ fixture: 'CUSTOMER', namespace: session.namespace }), '', 'application/json');
      if (response.status !== 200) throw new Error('Synthetic session unavailable');
      const cookies = response.headers.getSetCookie?.() || [];
      const pairs = cookies.map(c => c.split(';', 1)[0]);
      if (!pairs.length || pairs.length > 10 || pairs.some(c => !/^[a-zA-Z0-9_-]+=[a-zA-Z0-9._~%+-]+$/.test(c)) || pairs.join('; ').length > 4096) throw new Error('Invalid synthetic session');
      session.cookie = pairs.join('; ');
      return true;
    }
    if (step.action !== 'assertJson' || !config.assertions.includes(step.path)) throw new Error('Unapproved state assertion');
    const response = await request(step.path, 'GET', undefined, session.cookie);
    if (response.status !== 200 || response.body.length > 64_000) throw new Error('State assertion unavailable');
    let value = JSON.parse(response.body.toString('utf8'));
    for (const key of step.pointer.slice(1).split('/')) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return false;
      value = value[key];
    }
    return value === step.equals;
  }
  async function resource(message) {
    const url = new URL(message.url);
    if (url.origin !== ORIGIN || url.username || url.password || url.hash || url.href.length > 2048) throw new Error('Foreign sandbox resource');
    if ([config.sessionPath, ...config.assertions].includes(url.pathname)) throw new Error('Control endpoint unavailable to page');
    const method = message.method || 'GET';
    if (method !== 'GET' && (url.search || !config.mutations.some(m => m.path === url.pathname && m.method === method))) throw new Error('Unapproved mutation');
    if (method !== 'GET' && !['application/json', 'application/x-www-form-urlencoded'].includes(message.contentType?.split(';')[0])) throw new Error('Unsupported mutation body');
    const body = method === 'GET' ? undefined : message.body;
    if (body !== undefined && typeof body !== 'string') throw new Error('Invalid request body');
    const response = await request(url.pathname + url.search, method, body, sessions.get(message.scenarioId)?.cookie, message.contentType);
    const headers = { 'content-type': response.headers.get('content-type') || 'application/octet-stream', 'content-security-policy': "default-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'" };
    const location = response.headers.get('location');
    if (location) { const target = new URL(location, url); if (target.origin !== ORIGIN) throw new Error('Foreign redirect'); headers.location = target.href; }
    return { status: response.status, headers, body: response.body.toString('base64') };
  }
  return { request, resource, control };
}
async function cleanupManifest(file, command = docker) {
  let prefix;
  try { ({ prefix } = JSON.parse(await readFile(file, 'utf8'))); } catch { return; }
  if (!/^aipr-sandbox-[a-f0-9-]{36}$/.test(prefix)) throw new Error('Invalid cleanup manifest');
  for (const args of [['rm', '-f', '-v', prefix + '-app', prefix + '-db', prefix + '-relay'], ['network', 'rm', prefix], ['image', 'rm', '-f', prefix + ':local']]) await command(args).catch(() => {});
  await unlink(file).catch(() => {});
}
module.exports = { startSandbox, createSandboxTransport, cleanupManifest, ORIGIN };
