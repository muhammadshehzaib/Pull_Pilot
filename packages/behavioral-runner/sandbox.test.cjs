const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandboxTransport, startSandbox, cleanupManifest, ORIGIN } = require('./sandbox.cjs');
const config = { dockerfile: 'Dockerfile', port: 3000, readyPath: '/', sessionPath: '/__aipr/session', mutations: [{ method: 'POST', path: '/orders' }, { method: 'DELETE', path: '/cart' }], assertions: ['/__aipr/state'] };
test('synthetic sessions stay in parent and are isolated per scenario', async () => {
  const calls = [];
  const transport = createSandboxTransport(config, 'http://127.0.0.1:32123', async (url, opts) => {
    calls.push({ url, ...opts });
    return new Response('{}', { headers: { 'Set-Cookie': 'session=test-only; HttpOnly' } });
  });
  await transport.control('a', { action: 'authenticate', fixture: 'CUSTOMER' });
  const response = await transport.resource({ scenarioId: 'a', url: ORIGIN + '/orders', method: 'POST', contentType: 'application/json', body: '{}' });
  assert.equal(calls[1].headers.Cookie, 'session=test-only');
  assert.equal(JSON.stringify(response).includes('test-only'), false);
  await transport.resource({ scenarioId: 'b', url: ORIGIN + '/' });
  assert.equal(calls[2].headers.Cookie, undefined);
  assert.equal(calls[1].redirect, 'manual');
});
test('state assertions read the server and return only an equality result', async () => {
  const t = createSandboxTransport(config, 'http://127.0.0.1:32123', async () => new Response('{"orderCount":1,"customer":"private"}'));
  assert.equal(await t.control('a', { action: 'assertJson', path: '/__aipr/state', pointer: '/orderCount', equals: 1 }), true);
  assert.equal(await t.control('a', { action: 'assertJson', path: '/__aipr/state', pointer: '/orderCount', equals: 2 }), false);
  assert.equal(await t.control('a', { action: 'assertJson', path: '/__aipr/state', pointer: '/missing', equals: null }), false);
});
test('foreign origins, control resources, unapproved writes and oversized bodies never reach the app', async () => {
  let calls = 0;
  const t = createSandboxTransport(config, 'http://127.0.0.1:32123', async () => { calls++; return new Response('{}'); });
  for (const input of [
    { url: 'http://127.0.0.1:1234/' }, { url: ORIGIN + '/__aipr/session' }, { url: ORIGIN + '/__aipr/state' },
    { url: ORIGIN + '/production', method: 'DELETE' }, { url: ORIGIN + '/orders?admin=1', method: 'POST' },
    { url: ORIGIN + '/orders', method: 'POST', contentType: 'text/plain' },
    { url: ORIGIN + '/orders', method: 'POST', contentType: 'application/json', body: 'x'.repeat(16_001) },
  ]) await assert.rejects(t.resource(input));
  assert.equal(calls, 0);
  assert.throws(() => createSandboxTransport(config, 'http://192.168.1.1:80'));
});
test('redirects, oversized responses and HTTP errors cannot establish passing assertions', async () => {
  let response = new Response('{}', { status: 302, headers: { Location: 'https://evil.example' } });
  const t = createSandboxTransport(config, 'http://127.0.0.1:32123', async () => response);
  await assert.rejects(t.resource({ url: ORIGIN + '/' }));
  response = new Response('{}', { status: 401 });
  await assert.rejects(t.control('a', { action: 'assertJson', path: '/__aipr/state', pointer: '/count', equals: 1 }));
  response = new Response('x'.repeat(2_000_001));
  await assert.rejects(t.resource({ url: ORIGIN + '/' }));
});
test('sandbox provisions bounded containers and cleans exact names even after startup rejection', async () => {
  const calls = [];
  await assert.rejects(startSandbox(config, path.join(__dirname, 'fixtures/checkout'), { docker: async args => {
    calls.push(args);
    if (args[0] === 'image' && args[1] === 'inspect') return 'null';
    if (args[0] === 'port') throw new Error('Untrusted application log must not escape');
    return '';
  } }));
  const app = calls.find(a => a[0] === 'run' && a.includes('--network-alias') && a.includes('application'));
  assert.ok(app.includes('--cap-drop')); assert.ok(app.includes('--memory')); assert.ok(app.includes('--pids-limit'));
  assert.equal(app.includes('--mount'), false); assert.equal(app.includes('--volume'), false);
  assert.equal(app.includes('--publish'), false);
  const relay = calls.find(a => a[0] === 'run' && a.includes('--entrypoint'));
  assert.equal(relay[relay.indexOf('--publish') + 1], '127.0.0.1::3000');
  assert.ok(calls.some(a => a[0] === 'network' && a[1] === 'connect'));
  assert.equal(calls.find(a => a[0] === 'network' && a[1] === 'create')[2], '--internal');
  assert.ok(calls.some(a => a[0] === 'rm' && a[1] === '-f'));
  assert.ok(calls.some(a => a[0] === 'network' && a[1] === 'rm'));
  assert.equal(JSON.stringify(calls).includes('ACTIONS_ID_TOKEN'), false);
});
test('application-declared volumes are rejected before startup and image cleanup is attempted', async () => {
  const calls = [];
  await assert.rejects(startSandbox(config, path.join(__dirname, 'fixtures/checkout'), { docker: async args => {
    calls.push(args); return args[0] === 'image' && args[1] === 'inspect' ? '{"/persistent":{}}' : '';
  } }), /persistent volumes/);
  assert.equal(calls.some(a => a[0] === 'run'), false);
  assert.ok(calls.some(a => a[0] === 'image' && a[1] === 'rm'));
});
test('invalid cleanup manifests cannot select another container', async () => {
  const fs = require('node:fs/promises'); const os = require('node:os');
  const file = path.join(os.tmpdir(), 'aipr-cleanup-' + require('node:crypto').randomUUID());
  await fs.writeFile(file, JSON.stringify({ prefix: 'production' }));
  try { await assert.rejects(cleanupManifest(file, async () => assert.fail())); } finally { await fs.unlink(file); }
});
test(`${process.env.AIPR_SMOKE_BROWSER ? 'real browser and HTTP' : 'real HTTP'} session and duplicate submission are verified from independent server state`, async () => {
  const http = require('node:http');
  const orders = new Set(); const sessions = new Set();
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.host, 'sandbox.aipr.invalid');
    if (req.url === '/' && req.method === 'GET') { res.setHeader('Content-Type', 'text/html'); res.end(require('node:fs').readFileSync(path.join(__dirname, 'fixtures/checkout/checkout.html'))); return; }
    const customer = req.headers.cookie?.split('=')[1];
    if (req.url === '/__aipr/session' && req.method === 'POST') {
      let text = ''; for await (const chunk of req) text += chunk;
      const body = JSON.parse(text); sessions.add(body.namespace);
      res.setHeader('Set-Cookie', `session=${body.namespace}; HttpOnly`); res.end('{}'); return;
    }
    if (!sessions.has(customer)) { res.writeHead(401); res.end('{}'); return; }
    if (req.url === '/orders') orders.add(customer);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ orderCount: Number(orders.has(customer)) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const t = createSandboxTransport(config, `http://127.0.0.1:${server.address().port}`);
    await t.control('a', { action: 'authenticate', fixture: 'CUSTOMER' });
    for (let i = 0; i < 2; i++) assert.equal((await t.resource({ scenarioId: 'a', url: ORIGIN + '/orders', method: 'POST', contentType: 'application/json', body: '{}' })).status, 200);
    assert.equal(await t.control('a', { action: 'assertJson', path: '/__aipr/state', pointer: '/orderCount', equals: 1 }), true);
    assert.equal(await t.control('a', { action: 'assertJson', path: '/__aipr/state', pointer: '/orderCount', equals: 2 }), false);
    await assert.rejects(t.control('b', { action: 'assertJson', path: '/__aipr/state', pointer: '/orderCount', equals: 1 }));
    if (process.env.AIPR_SMOKE_BROWSER) {
      const plan = [{ id: 'c'.repeat(24), steps: [{ action: 'navigate', path: '/' }, { action: 'authenticate', fixture: 'CUSTOMER' }, { action: 'click', testId: 'checkout' }, { action: 'assertText', testId: 'result', text: 'Order created' }, { action: 'click', testId: 'checkout' }, { action: 'assertJson', path: '/__aipr/state', pointer: '/orderCount', equals: 1 }] }];
      async function verify(scenarios) {
        const results = [];
        await require('./browser-child.cjs').run({ plan: scenarios, previewUrl: ORIGIN, execution: { mode: 'OWNER_SANDBOX', sandbox: config } }, {
          launch: opts => require('playwright').chromium.launch({ ...opts, executablePath: process.env.AIPR_SMOKE_BROWSER }),
          send: message => { if (message.type === 'result') results.push(message.result); },
          resource: message => message.type === 'control' ? t.control(message.scenarioId, scenarios.find(s => s.id === message.scenarioId).steps[message.index]).then(passed => ({ passed })) : t.resource(message),
        });
        return results;
      }
      assert.equal((await verify(plan))[0].status, 'PASSED');
      const failure = [{ ...plan[0], id: 'd'.repeat(24), steps: [...plan[0].steps.slice(0, -1), { ...plan[0].steps.at(-1), equals: 2 }] }];
      assert.equal((await verify(failure))[0].status, 'FAILED');
      const blocked = [{ ...plan[0], id: 'e'.repeat(24), steps: [plan[0].steps[0], { action: 'click', testId: 'checkout' }, { action: 'assertJson', path: '/__aipr/state', pointer: '/orderCount', equals: 0 }] }];
      assert.equal((await verify(blocked))[0].status, 'ERROR');
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
