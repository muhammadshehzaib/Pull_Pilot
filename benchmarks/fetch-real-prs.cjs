// Explicit refresh only. Benchmark runs use the checked-in pinned snapshots offline.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const definitions = [
  { repo: 'axios/axios', number: 7369, paths: ['lib/core/mergeConfig.js'], category: 'security',
    contract: 'Merge arbitrary own configuration keys without calling an inherited non-function merge strategy.',
    description: 'JSON-parsed __proto__ or constructor config keys can select inherited non-function merge strategies and crash the request.', terms: ['prototype', '__proto__', 'mergeMap', 'function'] },
  { repo: 'expressjs/body-parser', number: 698, paths: ['lib/utils.js'], category: 'security',
    contract: 'Normalize request-body size limits. Invalid values must be rejected instead of disabling size enforcement; zero is valid.',
    description: 'An invalid configured limit parses to null and silently disables the downstream request-body size limit.', terms: ['limit', 'null', 'invalid', 'size'] },
  { repo: 'expressjs/body-parser', number: 716, paths: ['lib/types/urlencoded.js'], category: 'correctness',
    contract: 'Count URL-encoded parameters (including the first one) and return undefined only when their count exceeds the configured maximum.',
    description: 'Counting separators instead of parameters undercounts by one, affecting parameter limits and array handling.', terms: ['count', 'one', 'parameter', 'limit'] },
  { repo: 'expressjs/body-parser', number: 742, paths: ['lib/read.js'], category: 'data-integrity',
    contract: 'Parser options are reused across requests and must not be mutated by reading one request body.',
    description: 'Aliasing the options object and assigning request-specific length/encoding mutates reusable parser configuration.', terms: ['mutat', 'options', 'encoding', 'length'] },
  { repo: 'axios/axios', number: 11216, paths: ['lib/core/AxiosHeaders.js'], category: 'correctness',
    contract: 'Header matcher callbacks run with this bound to the headers instance supplied as context.',
    description: 'filter.call(this, ...) binds an unrelated or undefined this rather than the supplied headers context.', terms: ['this', 'context', 'bind', 'call'] },
  { repo: 'axios/axios', number: 11225, paths: ['lib/adapters/xhr.js'], category: 'resource-management',
    contract: 'Request completion must remove progress listeners and finish remaining cleanup even when final progress callbacks throw.',
    description: 'Completed requests retain progress listeners; a throwing final progress callback can also prevent remaining cancellation cleanup.', terms: ['listener', 'cleanup', 'throw', 'progress'] },
];
const headers = { 'User-Agent': 'PullPilot-quality-benchmark', Accept: 'application/vnd.github+json' };
// Public read-only endpoints; do not load or use the service's customer tokens.
async function get(url, json = true) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Public snapshot fetch failed: HTTP ${response.status}`);
  return json ? response.json() : response.text();
}
async function main() {
  const snapshots = [];
  for (const def of definitions) {
    const pr = await get(`https://api.github.com/repos/${def.repo}/pulls/${def.number}`);
    if (!pr.merged || !/^[0-9a-f]{40}$/.test(pr.head.sha) || !/^[0-9a-f]{40}$/.test(pr.base.sha)) throw new Error('Expected merged PR with pinned commits');
    const files = [];
    for (const filePath of def.paths) {
      const before = await get(`https://raw.githubusercontent.com/${def.repo}/${pr.base.sha}/${filePath}`, false);
      const after = await get(`https://raw.githubusercontent.com/${def.repo}/${pr.head.sha}/${filePath}`, false);
      if (before === after) throw new Error('Selected source file has no changes');
      files.push({ path: filePath, before, after });
    }
    const license = await get(`https://raw.githubusercontent.com/${def.repo}/${pr.head.sha}/LICENSE`, false);
    const id = `${def.repo.replace('/', '-')}-${def.number}`;
    snapshots.push({ id, category: def.category, contract: def.contract, files,
      expectedBugs: [{ id, description: def.description, filePath: def.paths[0], terms: def.terms }],
      provenance: { repository: def.repo, pullNumber: def.number, url: pr.html_url, title: pr.title,
        baseSha: pr.base.sha, headSha: pr.head.sha, mergedAt: pr.merged_at, license: 'MIT', licenseText: license,
        sourceSha256: crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex') },
    });
    console.log(`Pinned ${def.repo}#${def.number}: ${files.length} source file(s)`);
  }
  fs.writeFileSync(path.join(__dirname, 'real-pr-snapshots.json'), JSON.stringify(snapshots, null, 2) + '\n');
}
main().catch(() => { console.error('Snapshot download failed; existing snapshots were preserved.'); process.exitCode = 1; });
