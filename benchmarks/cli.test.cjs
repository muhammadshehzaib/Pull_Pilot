const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sha, corpusHash } = require('./lib.cjs');
const { inputFor } = require('./run.cjs');
const corpus = require('./corpus.json');
const cli = path.join(__dirname, 'run.cjs');
const item = corpus.cases[0];

test('failure limit checkpoints the failed attempt and retains the unattempted plan', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pullpilot-stop-check-'));
  try {
    const planned = corpus.cases.filter(c => c.domain === 'payments');
    const input = path.join(temp, 'external.json');
    fs.writeFileSync(input, JSON.stringify({ corpusSha256: corpusHash(corpus), reviewer: 'Harness only', timingScope: 'review-core',
      results: planned.map(c => ({ caseId: c.id, repetition: 1, inputSha256: sha(inputFor(c)), status: 'error', durationMs: 1, costUsd: null, findings: [] })) }));
    const output = path.join(temp, 'result');
    const result = spawnSync(process.execPath, [cli, '--mode', 'import', '--domain', 'payments', '--input', input, '--max-failures', '1', '--out', output], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
    const run = JSON.parse(fs.readFileSync(path.join(output, 'run.json'), 'utf8'));
    assert.equal(run.plannedCases.length, 20);
    assert.equal(run.results.length, 1);
    assert.equal(run.results[0].status, 'error');
    assert.equal(run.stoppedEarly, true);
    assert.equal(run.stopReason, 'failure-limit');
    const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'));
    assert.equal(report.overall.cases, 1);
    assert.equal(report.overall.failures, 1);
    const rendered = fs.readFileSync(path.join(output, 'report.md'), 'utf8');
    assert.match(rendered, /PARTIAL RUN: 19 selected reviews were not attempted/);
    assert.match(rendered, /20 \/ 1 \/ 19/);
  } finally {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
test('external imports preserve failures and refuse missing cases, wrong input or invalid cost', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pullpilot-import-check-'));
  try {
    const external = { corpusSha256: corpusHash(corpus), reviewer: 'Fake vendor (harness test only)', timingScope: 'end-to-end', results: [
      { caseId: item.id, repetition: 1, inputSha256: sha(inputFor(item)), status: 'error', durationMs: 123, costUsd: null, findings: [] },
    ] };
    function run(value, name) {
      const input = path.join(temp, `${name}.json`);
      fs.writeFileSync(input, JSON.stringify(value));
      return spawnSync(process.execPath, [cli, '--mode', 'import', '--case', item.id, '--input', input, '--out', path.join(temp, name)], { encoding: 'utf8' });
    }
    assert.equal(run(external, 'valid-failure').status, 2);
    const report = JSON.parse(fs.readFileSync(path.join(temp, 'valid-failure', 'report.json'), 'utf8'));
    assert.equal(report.overall.failures, 1); assert.equal(report.overall.recall, 0); assert.equal(report.overall.costUsd, null);
    assert.equal(run({ ...external, results: [] }, 'missing').status, 1);
    assert.equal(run({ ...external, results: [{ ...external.results[0], inputSha256: 'wrong' }] }, 'mismatch').status, 1);
    assert.equal(run({ ...external, results: [{ ...external.results[0], costUsd: -1 }] }, 'invalid-cost').status, 1);
  } finally {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
test('domain exports select one group and the frozen corpus remains selectable', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pullpilot-domain-export-'));
  try {
    const output = path.join(temp, 'payments');
    const exported = spawnSync(process.execPath, [cli, '--mode', 'export', '--domain', 'payments', '--out', output], { encoding: 'utf8' });
    assert.equal(exported.status, 0, exported.stderr);
    const mapping = JSON.parse(fs.readFileSync(path.join(output, 'mapping.private.json'), 'utf8'));
    assert.equal(mapping.mapping.length, 20);
    assert.ok(mapping.mapping.every(item => item.caseId.startsWith('seed-payments-')));
    const windowsCorpus = path.join(temp, 'corpus-crlf.json');
    fs.writeFileSync(windowsCorpus, (JSON.stringify(corpus, null, 2) + '\n').replaceAll('\n', '\r\n'));
    const windowsOutput = path.join(temp, 'windows');
    const windowsExport = spawnSync(process.execPath, [cli, '--mode', 'export', '--domain', 'payments', '--corpus', windowsCorpus, '--out', windowsOutput], { encoding: 'utf8' });
    assert.equal(windowsExport.status, 0, windowsExport.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(windowsOutput, 'mapping.private.json'), 'utf8')).corpusSha256, corpusHash(corpus));
    const oldOutput = path.join(temp, 'v1');
    const archived = spawnSync(process.execPath, [cli, '--mode', 'export', '--corpus', path.join(__dirname, 'corpora/v1.json'), '--out', oldOutput], { encoding: 'utf8' });
    assert.equal(archived.status, 0, archived.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(oldOutput, 'mapping.private.json'), 'utf8')).mapping.length, 92);
    const unknown = spawnSync(process.execPath, [cli, '--mode', 'export', '--domain', 'unknown', '--out', path.join(temp, 'unknown')], { encoding: 'utf8' });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /No matching cases/);
  } finally {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
