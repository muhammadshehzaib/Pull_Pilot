const { spawn, execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');
const path = require('node:path');
const { LIMITS, parsePlan, parseEvidence } = require('../../apps/backend/dist/services/behavioral/contracts.js');
const { fetchPreview, validateDestination } = require('../../apps/backend/dist/services/behavioral/destination-policy.js');

async function runIsolated(rawPlan, previewUrl, deps = {}) {
  const execution = deps.execution || { mode: 'PUBLIC_PREVIEW' };
  const plan = parsePlan(rawPlan, rawPlan.map(s => s.id), execution);
  const host = new URL(previewUrl).hostname;
  if (execution.mode === 'OWNER_SANDBOX') {
    if (previewUrl !== 'https://sandbox.aipr.invalid' || !deps.transport) throw new Error('Sandbox transport unavailable');
  } else validateDestination(previewUrl, host);
  const name = 'aipr-behavioral-' + randomUUID();
  const child = (deps.spawn || spawn)('docker', ['run', '--rm', '-i', '--init', '--user', 'pwuser', '--security-opt', 'seccomp=' + path.join(__dirname, 'chromium-seccomp.json'), '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '1g', '--cpus', '1', '--shm-size', '128m', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', 'aipr-behavioral:local'], { shell: false, stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
  const budget = { requests: 0, bytes: 0 };
  const results = new Map();
  let timedOut = false;
  let outputBytes = 0;
  let requests = 0;
  const send = message => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + '\n'); };
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, LIMITS.totalMs);
  child.stdin.on('error', () => {});
  // JSON escaping can expand a permitted 16 KB request body sixfold. Bound the
  // whole IPC stream while permitting all configured requests at that size.
  child.stdout.on('data', chunk => { outputBytes += chunk.length; if (outputBytes > LIMITS.requests * 100_000 + 128_000) child.kill(); });
  createInterface({ input: child.stdout }).on('line', async line => {
    try {
      if (line.length > 100_000) throw new Error();
      const message = JSON.parse(line);
      if (message.type === 'control') {
        const scenario = plan.find(s => s.id === message.scenarioId);
        const step = scenario?.steps[message.index];
        if (execution.mode !== 'OWNER_SANDBOX' || !Number.isSafeInteger(message.id) || !Number.isSafeInteger(message.index) || !step || !['authenticate', 'assertJson'].includes(step.action) || ++requests > LIMITS.requests) throw new Error();
        try { send({ type: 'resource', id: message.id, passed: await deps.transport.control(scenario.id, step) }); }
        catch { send({ type: 'resource', id: message.id, error: true }); }
      } else if (message.type === 'resource') {
        if (!Number.isSafeInteger(message.id) || typeof message.url !== 'string' || ++requests > LIMITS.requests) { child.kill(); return; }
        try {
          if (!plan.some(s => s.id === message.scenarioId) && execution.mode === 'OWNER_SANDBOX') throw new Error();
          if (execution.mode === 'PUBLIC_PREVIEW' && message.method && message.method !== 'GET') throw new Error();
          const fetched = execution.mode === 'OWNER_SANDBOX' ? await deps.transport.resource(message) : await (deps.fetchPreview || fetchPreview)(message.url, host, budget);
          send({ type: 'resource', id: message.id, ...fetched });
        } catch { send({ type: 'resource', id: message.id, error: true }); }
      } else if (message.type === 'result') {
        const scenario = plan.find(s => s.id === message.result?.id);
        if (!scenario || results.has(scenario.id)) throw new Error();
        results.set(scenario.id, parseEvidence([message.result], [scenario])[0]);
      } else if (message.type !== 'done') throw new Error();
    } catch { child.kill(); }
  });
  try {
    await new Promise(resolve => {
      child.once('error', resolve);
      child.once('close', resolve);
      send({ type: 'start', plan, previewUrl, execution });
    });
  } finally {
    clearTimeout(timer);
    // This exact random container belongs to this invocation. Never retain a
    // browser after a timeout, parent disconnect, or malformed child output.
    await new Promise(resolve => (deps.execFile || execFile)('docker', ['rm', '-f', name], { timeout: 10_000 }, resolve));
  }
  return plan.map(s => results.get(s.id) || { id: s.id, status: timedOut ? 'TIMED_OUT' : 'ERROR', steps: [] });
}
module.exports = { runIsolated };
