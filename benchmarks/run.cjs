const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { sha, findingId, estimateCost, labelTemplate, score, markdown } = require('./lib.cjs');
const root = path.resolve(__dirname, '..');
const corpusPath = path.join(__dirname, 'corpus.json');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!/^--[a-z-]+$/.test(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--') || result[argv[i].slice(2)] !== undefined) throw new Error('Expected unique --option value pairs');
    result[argv[i].slice(2)] = argv[i + 1];
  }
  const allowed = new Set(['mode', 'out', 'provider', 'limit', 'repetitions', 'timeout-ms', 'family', 'case', 'rates', 'run', 'labels', 'input', 'seed', 'left', 'right']);
  for (const key of Object.keys(result)) if (!allowed.has(key)) throw new Error(`Unknown option: ${key}`);
  return result;
}
function integer(value, fallback, max) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error('Invalid bounded integer option');
  return n;
}
function inputFor(item) {
  return { diff: item.diff, customRules: [], context: { files: [
    { path: 'docs/review-contract.md', content: item.contract, reasons: ['Documented behavior supplied equally to all reviewers'], hops: 0 },
    ...item.context.map(f => ({ ...f, reasons: ['Frozen related file'], hops: 1 })),
  ], droppedPaths: [], treeTruncated: false, incomplete: false } };
}
function implementationHash() {
  const base = path.join(root, 'apps/backend/src');
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push([path.relative(base, target).replaceAll('\\', '/'), sha(fs.readFileSync(target))]);
    }
  }
  visit(base);
  return sha(files);
}
function ensureBuilt() {
  const marker = path.join(root, 'apps/backend/dist/services/ai/usage.js');
  if (!fs.existsSync(marker)) throw new Error('Build the backend first: npm run build --workspace=apps/backend');
  // Refuse stale compiled production code; the benchmark must test this checkout.
  const dist = path.join(root, 'apps/backend/dist');
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const source = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(source);
      else if (entry.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry.name) && !source.includes(`${path.sep}test-utils${path.sep}`)) {
        const output = path.join(dist, path.relative(path.join(root, 'apps/backend/src'), source)).replace(/\.ts$/, '.js');
        if (!fs.existsSync(output) || fs.statSync(source).mtimeMs > fs.statSync(output).mtimeMs) throw new Error('Compiled backend is stale; rebuild first');
      }
    }
  }
  visit(path.join(root, 'apps/backend/src'));
}
async function main() {
  const opts = args(process.argv.slice(2));
  const mode = opts.mode || 'scanners';
  if (!['scanners', 'live', 'score', 'import', 'export', 'compare'].includes(mode)) throw new Error('Invalid mode');
  const corpus = read(corpusPath);
  if (mode === 'compare') {
    if (!opts.left || !opts.right) throw new Error('Compare requires --left and --right run directories');
    const left = read(path.join(opts.left, 'run.json')), right = read(path.join(opts.right, 'run.json'));
    const leftReport = score(left, corpus, read(path.join(opts.left, 'labels.json')));
    const rightReport = score(right, corpus, read(path.join(opts.right, 'labels.json')));
    const comparison = require('./lib.cjs').compare(left, right, leftReport, rightReport);
    const destination = path.resolve(opts.out || path.join(root, '.benchmark-runs', `comparison-${Date.now()}`));
    fs.mkdirSync(destination, { recursive: true });
    write(path.join(destination, 'comparison.json'), comparison);
    console.log(JSON.stringify(comparison, null, 2));
    return;
  }
  if (mode === 'score') {
    if (!opts.run || !opts.labels) throw new Error('Score requires --run and --labels');
    const run = read(opts.run), labels = read(opts.labels);
    const report = score(run, corpus, labels);
    const dir = path.dirname(path.resolve(opts.run));
    write(path.join(dir, 'report.json'), report);
    fs.writeFileSync(path.join(dir, 'report.md'), markdown(run, report, corpus));
    console.log(JSON.stringify(report.overall));
    return;
  }
  let selected = corpus.cases.filter(c => (!opts.family || c.family === opts.family) && (!opts.case || c.id === opts.case));
  if (!selected.length) throw new Error('No matching cases');
  // Stable blind ordering; no conversational state is shared across cases.
  const seed = opts.seed || 'pullpilot-v1';
  selected.sort((a, b) => sha([seed, a.id]).localeCompare(sha([seed, b.id])));
  selected = selected.slice(0, integer(opts.limit, selected.length, corpus.cases.length));
  const repetitions = integer(opts.repetitions, 1, 10);
  const timeoutMs = integer(opts['timeout-ms'], 90_000, 600_000);
  const dir = path.resolve(opts.out || path.join(root, '.benchmark-runs', `${mode}-${Date.now()}`));
  fs.mkdirSync(dir, { recursive: true });
  if (mode === 'export') {
    const mapping = [];
    for (const [index, item] of selected.entries()) {
      const blindId = `case-${String(index + 1).padStart(4, '0')}`;
      const input = inputFor(item);
      const folder = path.join(dir, 'inputs', blindId);
      fs.mkdirSync(folder, { recursive: true });
      write(path.join(folder, 'review-input.json'), input);
      fs.writeFileSync(path.join(folder, 'change.diff'), item.diff);
      for (const phase of ['before', 'after']) for (const file of [...item.files, ...input.context.files.map(f => ({ path: f.path, before: f.content, after: f.content }))]) {
        // Corpus paths are data, never an arbitrary filesystem destination.
        const target = path.resolve(folder, phase, file.path);
        if (!target.startsWith(path.resolve(folder, phase) + path.sep)) throw new Error('Unsafe fixture path');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file[phase]);
      }
      fs.writeFileSync(path.join(folder, 'THIRD-PARTY-NOTICE.txt'), item.provenance.licenseText || 'Authored PullPilot benchmark fixture; AGPL-3.0-only. See the project LICENSE.');
      mapping.push({ blindId, caseId: item.id, inputSha256: sha(input) });
    }
    write(path.join(dir, 'mapping.private.json'), { corpusSha256: sha(fs.readFileSync(corpusPath, 'utf8')), seed, mapping });
    console.log(`Exported ${mapping.length} blinded inputs. Keep mapping.private.json out of reviewer repositories.`);
    return;
  }
  if (fs.existsSync(path.join(dir, 'run.json'))) throw new Error('Output already contains a run; choose a fresh directory');
  const rates = opts.rates ? read(opts.rates) : null;
  if (rates && (!rates.source || !rates.asOf || !rates.models)) throw new Error('Rates need source, asOf, and model entries');
  let commit;
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { commit = null; }
  const run = { schemaVersion: 1, id: crypto.randomUUID(), mode,
    startedAt: new Date().toISOString(), corpusSha256: sha(fs.readFileSync(corpusPath, 'utf8')),
    gitCommit: commit, implementationSha256: implementationHash(), lockfileSha256: sha(fs.readFileSync(path.join(root, 'package-lock.json'))),
    runtime: process.version, seed, repetitions, timingScope: 'review-core', provider: opts.provider || null,
    scope: 'Diff filtering, frozen supplied context, provider analyzeCode (live only), built-in offline scanners, anchoring, severity filtering, deduplication, risk. Excludes context discovery, repository rules, test-gap calls, queue/API/GitHub delivery.',
    config: { timeoutMs, osv: false, semgrep: false, minSeverity: 'low' }, pricing: rates,
    plannedCases: selected.map(c => c.id), results: [] };
  let imported = null;
  if (mode === 'import') {
    if (!opts.input) throw new Error('Import needs --input vendor-results.json');
    imported = read(opts.input);
    if (imported.corpusSha256 !== run.corpusSha256 || !imported.reviewer || !Array.isArray(imported.results) || !imported.timingScope) throw new Error('External results need matching corpus, reviewer and timingScope');
    run.provider = imported.reviewer;
    run.timingScope = imported.timingScope;
    run.scope = imported.scope || 'External reviewer; see input file';
    if (imported.results.length !== selected.length * repetitions) throw new Error('External results must include every planned case/repetition, including failures');
  }
  let provider, runSecurityProbes, deduplicate, bindFindingAnchors, assessRisk, config, DiffFilterService;
  if (mode !== 'import') {
    // Load model configuration before modules which snapshot process.env.
    if (mode === 'live') require('dotenv').config({ path: path.join(root, '.env.benchmark'), quiet: true });
    ensureBuilt();
    const backend = file => require(path.join(root, 'apps/backend/dist', file));
    ({ runSecurityProbes } = backend('services/security/run-probes.js'));
    ({ deduplicate } = backend('services/ai/finding-dedup.service.js'));
    ({ bindFindingAnchors } = backend('services/ai/review-anchors.js'));
    ({ assessRisk } = backend('services/security/risk-engine.js'));
    ({ DiffFilterService } = backend('services/diff-filter.service.js'));
    config = backend('services/config.service.js').DEFAULT_AIPR_CONFIG;
    if (mode === 'live') {
      const choices = { OPENAI: ['OPENAI_API_KEY', 'openai', 'OpenAi'], GEMINI: ['GEMINI_API_KEY', 'gemini', 'Gemini'],
        CLAUDE: ['ANTHROPIC_API_KEY', 'claude', 'Claude'], GROK: ['GROK_API_KEY', 'grok', 'Grok'] };
      const choice = choices[opts.provider?.toUpperCase()];
      if (!choice) throw new Error('Live mode requires --provider OPENAI|GEMINI|CLAUDE|GROK');
      const key = process.env[choice[0]] || (opts.provider.toUpperCase() === 'GEMINI' ? process.env.GOOGLE_API_KEY : opts.provider.toUpperCase() === 'GROK' ? process.env.XAI_API_KEY : null);
      if (!key) throw new Error(`Live mode needs ${choice[0]} in environment or .env.benchmark`);
      const Provider = backend(`services/ai/providers/${choice[1]}.provider.js`)[`${choice[2]}Provider`];
      provider = new Provider(key);
      run.provider = opts.provider.toUpperCase();
    }
  }
  write(path.join(dir, 'run.json'), run);
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (const item of selected) {
      const input = inputFor(item);
      const start = performance.now();
      const result = { caseId: item.id, repetition, inputSha256: sha(input), status: 'ok', durationMs: 0,
        aiDurationMs: null, usage: [], costUsd: mode === 'scanners' ? 0 : null, findings: [], checks: [] };
      try {
        if (imported) {
          const matches = imported.results.filter(r => r.caseId === item.id && r.repetition === repetition);
          const external = matches[0];
          if (matches.length !== 1 || external.inputSha256 !== result.inputSha256 || !['ok', 'error', 'timeout'].includes(external.status) || !Array.isArray(external.findings)) throw new Error('External result does not match frozen input');
          if (!Number.isFinite(external.durationMs) || external.durationMs < 0 ||
            (external.costUsd !== null && (!Number.isFinite(external.costUsd) || external.costUsd < 0))) throw new Error('External duration/cost missing or invalid');
          for (const finding of external.findings) if (typeof finding.issue !== 'string' || !finding.issue.trim() || typeof finding.suggestion !== 'string' || typeof finding.filePath !== 'string' || !Number.isInteger(finding.lineNumber)) throw new Error('External finding fields are invalid');
          Object.assign(result, { status: external.status, durationMs: external.durationMs, costUsd: external.costUsd,
            findings: external.findings, evidenceUrl: external.evidenceUrl || null });
        } else {
          const filtered = DiffFilterService.filterDiff(input.diff, config).filteredDiff;
          const scan = await runSecurityProbes({ ...config.security, osv: false, semgrep: false }, filtered);
          result.checks = scan.checks;
          let modelFindings = [];
          if (provider) {
            const aiStart = performance.now();
            try {
              modelFindings = await provider.analyzeCode(filtered, input.customRules, input.context,
                { signal: AbortSignal.timeout(timeoutMs), onUsage: usage => result.usage.push(usage) });
            } finally { result.aiDurationMs = performance.now() - aiStart; }
          }
          const findings = deduplicate(bindFindingAnchors([
            ...modelFindings.filter(f => DiffFilterService.isSeverityMet(f.priority, config.min_severity)), ...scan.findings,
          ], filtered));
          result.findings = assessRisk(findings, { blockOnCriticalSecret: true }).findings;
          if (scan.checks.some(check => check.status === 'DEGRADED')) result.status = 'degraded';
          result.modelFindingCount = modelFindings.length;
          result.scannerFindingCount = scan.findings.length;
        }
      } catch (error) {
        if (imported) throw error; // Reject malformed competitor imports instead of inventing failed runs.
        result.status = /timeout/i.test(error?.reason || error?.name || '') ? 'timeout' : 'error';
        result.error = error?.reason || 'benchmark-case-error'; // Never persist SDK errors/headers/keys.
      }
      if (!imported) {
        result.durationMs = performance.now() - start;
        if (mode === 'live') result.costUsd = estimateCost(result.usage, rates);
      }
      run.results.push(result);
      write(path.join(dir, 'run.json'), run); // Checkpoint completed paid calls; never retry them automatically.
      console.log(`${run.results.length}/${selected.length * repetitions} ${item.id} ${result.status} ${result.findings.length} finding(s)`);
    }
  }
  run.finishedAt = new Date().toISOString();
  write(path.join(dir, 'run.json'), run);
  const labels = labelTemplate(run, corpus);
  write(path.join(dir, 'labels.json'), labels);
  const report = score(run, corpus, labels);
  write(path.join(dir, 'report.json'), report);
  fs.writeFileSync(path.join(dir, 'report.md'), markdown(run, report, corpus));
  console.log(`Saved ${dir}`);
  if (run.results.some(r => r.status !== 'ok')) process.exitCode = 2;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { args, inputFor, implementationHash };
