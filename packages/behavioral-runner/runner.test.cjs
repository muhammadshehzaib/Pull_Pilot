const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { execute } = require('./actions.cjs');
const { runIsolated } = require('./isolated-runner.cjs');
const scenario = { id: 'a'.repeat(24), steps: [{ action: 'navigate', path: '/' }, { action: 'assertVisible', testId: 'cart' }] };
const page = (visible = true) => ({ goto: async () => {}, getByTestId: () => ({ isVisible: async () => visible, textContent: async () => 'safe' }) });
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
