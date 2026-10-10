// Trusted CI entry point. No checkout/build/deployment of PR code occurs here.
const { runIsolated } = require('./isolated-runner.cjs');
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
  let evidence;
  try { evidence = await runIsolated(claimed.plan, claimed.previewUrl); }
  catch { evidence = claimed.plan.map(s => ({ id: s.id, status: 'ERROR', steps: [] })); }
  await post('finish', { evidence });
  console.log('Behavioral evidence submitted. Review the dashboard for individual outcomes.');
}
if (require.main === module) main().catch(() => { console.error('Behavioral execution or submission unavailable. No PASS is inferred.'); process.exitCode = 1; });
