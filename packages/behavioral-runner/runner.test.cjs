const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { execute: runActions } = require('./actions.cjs');
const execute = (...args) => runActions(...args, 'https://preview.example.com');
const { runIsolated } = require('./isolated-runner.cjs');
const scenario = { id: 'a'.repeat(24), steps: [{ action: 'navigate', path: '/' }, { action: 'assertVisible', testId: 'cart' }] };
const page = (visible = true) => ({ url: () => 'https://preview.example.com/cart', goto: async () => {}, getByTestId: () => ({ isVisible: async () => visible, textContent: async () => 'safe' }) });
test('only completed assertions establish PASS', async () => {
  assert.equal((await execute(page(), scenario, Date.now() + 5000, () => false)).status, 'PASSED');
  assert.equal((await execute(page(false), scenario, Date.now() + 5000, () => false)).status, 'FAILED');
});
test('timeouts and blocked network do not establish PASS', async () => {
  assert.equal((await execute(page(), scenario, 0, () => false)).status, 'TIMED_OUT');
  assert.equal((await execute(page(), scenario, Date.now() + 5000, () => true)).status, 'ERROR');
});
test('runner errors are bounded and never include page content', async () => {
  const broken = page(); broken.goto = async () => { throw new Error('SECRET DOM EXCERPT'); };
  const result = await execute(broken, scenario, Date.now() + 5000, () => false);
  assert.equal(result.status, 'ERROR'); assert.equal(JSON.stringify(result).includes('SECRET'), false);
});
test('data/file/foreign main-frame navigation cannot establish PASS', async () => {
  for (const url of ['data:text/html,<div>fake</div>', 'file:///runner/package.json', 'https://evil.com']) {
    const navigated = page(); navigated.url = () => url;
    assert.equal((await execute(navigated, scenario, Date.now() + 5000, () => false)).status, 'ERROR');
  }
});
test('container isolation, partial evidence and unconditional cleanup', async () => {
  let args; let cleaned = false;
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => { child.emit('close', 1); };
  const other = { ...scenario, id: 'b'.repeat(24) };
  const result = await runIsolated([scenario, other], 'https://preview.example.com', {
    spawn: (_command, parameters, options) => {
      args = parameters; assert.equal(options.shell, false);
      setImmediate(() => {
        child.stdout.write(JSON.stringify({ type: 'result', result: { id: scenario.id, status: 'PASSED', steps: [{ index: 0, status: 'PASSED' }, { index: 1, status: 'PASSED' }] } }) + '\n');
        child.stdout.end(); child.emit('close', 1);
      });
      return child;
    }, execFile: (_command, parameters, _options, callback) => { cleaned = parameters[0] === 'rm' && parameters[1] === '-f'; callback(); },
  });
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.ok(args.includes('--read-only')); assert.ok(args.includes('--memory'));
  assert.equal(result[0].status, 'PASSED'); assert.equal(result[1].status, 'ERROR'); assert.equal(cleaned, true);
});
test('unsafe preview destinations are rejected before spawning', async () => {
  let spawned = false;
  await assert.rejects(runIsolated([scenario], 'https://127.0.0.1', { spawn: () => { spawned = true; } }));
  assert.equal(spawned, false);
});
test('a hung browser is timed out and its exact container is removed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let removed = false;
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => child.emit('close', 1);
  const pending = runIsolated([scenario], 'https://preview.example.com', { spawn: () => child, execFile: (_c, args, _o, callback) => { removed = args[0] === 'rm'; callback(); } });
  t.mock.timers.tick(65_001);
  const result = await pending;
  assert.equal(result[0].status, 'TIMED_OUT'); assert.equal(removed, true);
  t.mock.timers.reset();
});
test('sandbox control requests execute the frozen assertion rather than child-supplied values', async () => {
  const sandbox = { dockerfile: 'Dockerfile', port: 3000, readyPath: '/', mutations: [], assertions: ['/__aipr/state'] };
  const plan = [{ ...scenario, steps: [scenario.steps[0], { action: 'assertJson', path: '/__aipr/state', pointer: '/orderCount', equals: 1 }] }];
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => child.emit('close', 1);
  let actual;
  child.stdin.on('data', line => {
    const message = JSON.parse(line);
    if (message.type === 'start') setImmediate(() => child.stdout.write(JSON.stringify({ type: 'control', id: 1, scenarioId: scenario.id, index: 1, equals: 999 }) + '\n'));
    else if (message.type === 'resource') {
      assert.equal(message.passed, true);
      child.stdout.write(JSON.stringify({ type: 'result', result: { id: scenario.id, status: 'PASSED', steps: [{ index: 0, status: 'PASSED' }, { index: 1, status: 'PASSED' }] } }) + '\n');
      child.stdout.end(); child.emit('close', 0);
    }
  });
  const evidence = await runIsolated(plan, 'https://sandbox.aipr.invalid', { execution: { mode: 'OWNER_SANDBOX', sandbox }, transport: { control: async (_id, step) => { actual = step; return true; } }, spawn: () => child, execFile: (_c, _a, _o, cb) => cb() });
  assert.equal(actual.equals, 1); assert.equal(evidence[0].status, 'PASSED');
});
test('public mode still rejects mutations and sandbox control messages', async () => {
  for (const message of [{ type: 'control', id: 1, scenarioId: scenario.id, index: 1 }, { type: 'resource', id: 1, url: 'https://preview.example.com/orders', method: 'POST' }]) {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => child.emit('close', 1);
    child.stdin.on('data', line => {
      if (JSON.parse(line).type === 'start') setImmediate(() => child.stdout.write(JSON.stringify(message) + '\n'));
      else { child.stdout.end(); child.emit('close', 1); }
    });
    const evidence = await runIsolated([scenario], 'https://preview.example.com', { spawn: () => child, fetchPreview: () => assert.fail('Write must not reach public preview'), execFile: (_c, _a, _o, cb) => cb() });
    assert.equal(evidence[0].status, 'ERROR');
  }
});
test('owner workflow checks out only authenticated preparation outputs with credentials disabled', () => {
  const yaml = require('yaml'); const fs = require('node:fs'); const path = require('node:path');
  const workflow = yaml.parse(fs.readFileSync(path.join(__dirname, '../../docs/behavioral-workflow.example.yml'), 'utf8'));
  const job = workflow.jobs.verify;
  assert.equal(job['runs-on'], 'ubuntu-latest');
  const checkout = job.steps.find(s => s.name === 'Checkout authorized application commit');
  assert.equal(checkout.with.ref, '${{ steps.prepare.outputs.head_sha }}');
  assert.equal(checkout.with.repository, '${{ steps.prepare.outputs.repository }}');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(checkout.with.path, 'application');
  assert.equal(job.steps.at(-1).if, 'always()');
  assert.ok(job.steps.at(-1).run.endsWith('--cleanup'));
});
