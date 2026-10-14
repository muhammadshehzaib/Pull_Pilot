// Production runs in the network-disabled CI container. Tests can inject a host
// browser and transport explicitly. Never evaluates model-generated code.
const readline = require('node:readline');
const { chromium } = require('playwright');
const { LIMITS, parsePlan } = require(require('node:fs').existsSync(__dirname + '/contracts.js') ? './contracts.js' : '../../apps/backend/dist/services/behavioral/contracts.js');
const { execute } = require('./actions.cjs');
const pending = new Map();
let nextId = 0;
const ipcSend = message => process.stdout.write(JSON.stringify(message) + '\n');
function ipcResource(payload) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Resource unavailable')); }, 6000);
    pending.set(id, message => { clearTimeout(timer); message.error ? reject(new Error('Resource blocked')) : resolve(message); });
    ipcSend({ type: 'resource', id, ...payload });
  });
}
async function run(message, deps = {}) {
  const resource = deps.resource || ipcResource;
  const send = deps.send || ipcSend;
  const execution = message.execution || { mode: 'PUBLIC_PREVIEW' };
  const plan = parsePlan(message.plan, message.plan.map(s => s.id), execution);
  const origin = new URL(message.previewUrl).origin;
  const browser = await (deps.launch || chromium.launch.bind(chromium))({ headless: true });
  try {
    for (const scenario of plan) {
      let policyFailure = false;
      let inFlight = 0;
      const context = await browser.newContext({ baseURL: origin, serviceWorkers: 'block', acceptDownloads: false, permissions: [], viewport: { width: 1000, height: 700 } });
      let timer;
      try {
        await context.routeWebSocket('**/*', socket => { policyFailure = true; socket.close(); });
        await context.route('**/*', async route => {
          inFlight++;
          try {
            const req = route.request();
            const destination = new URL(req.url());
            if ((execution.mode === 'PUBLIC_PREVIEW' && req.method() !== 'GET') || destination.origin !== origin || ['websocket', 'eventsource', 'manifest'].includes(req.resourceType()) || (req.isNavigationRequest() && req.frame().parentFrame())) throw new Error('Unsupported resource');
            const body = req.postData();
            if (body && Buffer.byteLength(body) > 16_000) throw new Error('Oversized request');
            const fetched = await resource({ url: destination.href, scenarioId: scenario.id, method: req.method(), ...(req.method() !== 'GET' ? { body: body || '', contentType: req.headers()['content-type'] || '' } : {}) });
            await route.fulfill({ status: fetched.status, headers: fetched.headers, body: Buffer.from(fetched.body, 'base64') });
          } catch { policyFailure = true; await route.abort().catch(() => {}); }
          finally { inFlight--; }
        });
        context.on('page', p => { if (context.pages().length > 1) { policyFailure = true; p.close().catch(() => {}); } });
        const page = await context.newPage();
        page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
        page.on('download', download => { policyFailure = true; download.cancel().catch(() => {}); });
        page.on('framenavigated', frame => { if (frame === page.mainFrame() && new URL(frame.url()).origin !== origin) policyFailure = true; });
        const deadline = Date.now() + LIMITS.scenarioMs;
        const result = await Promise.race([
          execute(page, scenario, deadline, () => policyFailure, origin, async index => (await resource({ type: 'control', scenarioId: scenario.id, index })).passed),
          new Promise(resolve => { timer = setTimeout(() => resolve({ id: scenario.id, status: 'TIMED_OUT', steps: [] }), LIMITS.scenarioMs); }),
        ]);
        while (inFlight > 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        if (inFlight > 0) result.status = 'TIMED_OUT';
        if (policyFailure) result.status = 'ERROR';
        send({ type: 'result', result });
      } finally { clearTimeout(timer); await context.close(); }
    }
  } finally { await browser.close(); }
  send({ type: 'done' });
}
if (require.main === module) {
  let started = false;
  readline.createInterface({ input: process.stdin }).on('line', line => {
    try {
      if (line.length > 3_000_000) throw new Error();
      const message = JSON.parse(line);
      if (message.type === 'start' && !started) { started = true; setTimeout(() => process.exit(1), LIMITS.totalMs + 5000); run(message).then(() => process.exit(0)).catch(() => process.exit(1)); }
      else if (message.type === 'resource') { const callback = pending.get(message.id); pending.delete(message.id); callback?.(message); }
    } catch { process.exit(1); }
  });
  process.stdin.on('end', () => process.exit(1));
}

module.exports = { run };
