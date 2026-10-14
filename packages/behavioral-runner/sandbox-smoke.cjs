// Opt-in real Docker/PostgreSQL/Chromium smoke; no GitHub or production services.
const path = require('node:path');
const assert = require('node:assert/strict');
const { startSandbox } = require('./sandbox.cjs');
const { runIsolated } = require('./isolated-runner.cjs');
const config = { dockerfile: 'Dockerfile', port: 3000, readyPath: '/', sessionPath: '/__aipr/session', mutations: [{ method: 'POST', path: '/orders' }], assertions: ['/__aipr/state'] };
const scenario = { id: 'a'.repeat(24), steps: [
  { action: 'navigate', path: '/' }, { action: 'authenticate', fixture: 'CUSTOMER' },
  { action: 'click', testId: 'checkout' }, { action: 'assertText', testId: 'result', text: 'Order created' },
  { action: 'click', testId: 'checkout' }, { action: 'assertText', testId: 'result', text: 'Order created' },
  { action: 'assertJson', path: '/__aipr/state', pointer: '/orderCount', equals: 1 },
] };
async function main() {
  const sandbox = await startSandbox(config, path.join(__dirname, 'fixtures/checkout'));
  try {
    const execution = { mode: 'OWNER_SANDBOX', sandbox: config };
    async function verify(plan) {
      if (!process.argv.includes('--host-browser')) return runIsolated(plan, sandbox.origin, { execution, transport: sandbox.transport });
      // Diagnostic fallback exercises the real browser and app but does not
      // validate Docker browser isolation. Production never uses this branch.
      const evidence = [];
      const { chromium } = require('playwright');
      await require('./browser-child.cjs').run({ plan, execution, previewUrl: sandbox.origin }, {
        launch: options => chromium.launch({ ...options, executablePath: process.env.AIPR_SMOKE_BROWSER }),
        send: message => { if (message.type === 'result') evidence.push(message.result); },
        resource: async message => message.type === 'control' ? { passed: await sandbox.transport.control(message.scenarioId, plan.find(s => s.id === message.scenarioId).steps[message.index]) } : sandbox.transport.resource(message),
      });
      return evidence;
    }
    const evidence = await verify([scenario]);
    assert.equal(evidence[0].status, 'PASSED', JSON.stringify(evidence));
    const failed = { ...scenario, id: 'b'.repeat(24), steps: [...scenario.steps.slice(0, -1), { ...scenario.steps.at(-1), equals: 2 }] };
    const failure = await verify([failed]);
    assert.equal(failure[0].status, 'FAILED', JSON.stringify(failure));
    console.log(`Real app/database and ${process.argv.includes('--host-browser') ? 'host' : 'container'} browser smoke passed: synthetic login, duplicate checkout, one persisted order, deliberate assertion failure.`);
  } finally { await sandbox.cleanup(); }
}
main().catch(error => { console.error('Sandbox smoke failed; no PASS is inferred.', error.message); process.exitCode = 1; });
