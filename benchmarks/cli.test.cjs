const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sha } = require('./lib.cjs');
const { inputFor } = require('./run.cjs');
const corpus = require('./corpus.json');
const cli = path.join(__dirname, 'run.cjs');
const item = corpus.cases[0];
test('external imports preserve failures and refuse missing cases, wrong input or invalid cost', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pullpilot-import-check-'));
  try {
    const external = { corpusSha256: sha(fs.readFileSync(path.join(__dirname, 'corpus.json'), 'utf8')), reviewer: 'Fake vendor (harness test only)', timingScope: 'end-to-end', results: [
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
