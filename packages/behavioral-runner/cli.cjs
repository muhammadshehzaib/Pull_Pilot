// Trusted owner-CI entry point. Only the separate sandbox executor builds PR code.
const { runIsolated } = require('./isolated-runner.cjs');
const { startSandbox, cleanupManifest } = require('./sandbox.cjs');
const { appendFile, realpath } = require('node:fs/promises');
const path = require('node:path');
async function boundedJson(response) {
  if (!response.ok) throw new Error('Service request failed');
  const body = await response.text();
  if (body.length > 40_000) throw new Error('Oversized service response');
  return JSON.parse(body);
}
async function oidc(audience) {
  const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.actions.githubusercontent.com')) throw new Error('Invalid OIDC provider');
  url.searchParams.set('audience', audience);
  return (await boundedJson(await fetch(url, { headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, redirect: 'error', signal: AbortSignal.timeout(10_000) }))).value;
}
async function main() {
  const manifest = path.resolve(__dirname, '.sandbox-cleanup.json');
  if (process.argv.includes('--cleanup')) { await cleanupManifest(manifest); return; }
  const api = new URL(process.env.AIPR_BACKEND_URL);
  if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash || api.pathname !== '/') throw new Error('Use a trusted HTTPS backend origin');
  const id = process.env.AIPR_RUN_ID;
  const dispatchToken = process.env.AIPR_DISPATCH_TOKEN;
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(id) || !/^[a-f0-9]{64}$/.test(dispatchToken)) throw new Error('Invalid dispatch');
  async function post(action, body) {
    const identity = await oidc(process.env.AIPR_OIDC_AUDIENCE);
    return boundedJson(await fetch(`${api.origin}/api/behavioral/ci/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity}` }, body: JSON.stringify({ dispatchToken, ...body }), redirect: 'error', signal: AbortSignal.timeout(15_000) }));
  }
  const claimed = await post('claim', {});
  if (process.argv.includes('--prepare')) {
    if (!/^[a-f0-9]{40}$/.test(claimed.headSha) || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(claimed.repository)) throw new Error('Invalid checkout authority');
    await appendFile(process.env.GITHUB_OUTPUT, `sandbox=${claimed.execution?.mode === 'OWNER_SANDBOX'}\nhead_sha=${claimed.headSha}\nrepository=${claimed.repository}\n`);
    return;
  }
  let evidence;
  let sandbox;
  try {
    if (claimed.execution?.mode === 'OWNER_SANDBOX') {
      const source = await realpath(path.resolve(process.env.GITHUB_WORKSPACE, 'application'));
      const tooling = await realpath(path.resolve(__dirname, '../..'));
      if (source === tooling || !source.startsWith(path.resolve(process.env.GITHUB_WORKSPACE) + path.sep)) throw new Error('Invalid application checkout');
      sandbox = await startSandbox(claimed.execution.sandbox, source, { manifest });
    }
    evidence = await runIsolated(claimed.plan, claimed.previewUrl, { execution: claimed.execution, transport: sandbox?.transport });
  }
  catch { evidence = claimed.plan.map(s => ({ id: s.id, status: 'ERROR', steps: [] })); }
  finally { await sandbox?.cleanup(); }
  await post('finish', { evidence });
  console.log('Behavioral evidence submitted. Review the dashboard for individual outcomes.');
}
if (require.main === module) main().catch(() => { console.error('Behavioral execution or submission unavailable. No PASS is inferred.'); process.exitCode = 1; });
