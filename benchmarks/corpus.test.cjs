const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { sha } = require('./lib.cjs');
const { inputFor } = require('./run.cjs');
const corpus = require('./corpus.json');
test('92 unique cases contain 40 authored and 6 pinned historical bug/fix pairs', () => {
  assert.equal(corpus.cases.length, 92);
  assert.equal(new Set(corpus.cases.map(c => c.id)).size, 92);
  assert.equal(corpus.cases.reduce((n, c) => n + c.expectedBugs.length, 0), 46);
  for (const item of corpus.cases) {
    const twin = corpus.cases.find(c => c.pairId === item.pairId && c.variant !== item.variant);
    assert.ok(twin);
    assert.deepEqual(item.files.map(f => f.before), twin.files.map(f => f.after));
    assert.deepEqual(item.context, twin.context);
    assert.equal(item.contract, twin.contract);
    if (item.family === 'historical-pr') {
      assert.match(item.provenance.baseSha, /^[a-f0-9]{40}$/);
      assert.match(item.provenance.headSha, /^[a-f0-9]{40}$/);
      assert.match(item.provenance.licenseText, /Permission is hereby granted/);
    }
  }
});
test('reviewer inputs exclude labels, trigger descriptions, IDs and provenance', () => {
  for (const item of corpus.cases) {
    const input = inputFor(item);
    assert.deepEqual(Object.keys(input).sort(), ['context', 'customRules', 'diff']);
    const serialized = JSON.stringify(input);
    assert.ok(!serialized.includes(item.id));
    for (const bug of item.expectedBugs) assert.ok(!serialized.includes(bug.description));
  }
});
test('every patch applies exactly to its frozen before tree', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pullpilot-corpus-check-'));
  try {
    for (const [index, item] of corpus.cases.entries()) {
      const folder = path.join(temp, String(index));
      fs.mkdirSync(folder);
      for (const file of item.files) {
        const target = path.resolve(folder, file.path);
        assert.ok(target.startsWith(folder + path.sep));
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file.before);
      }
      fs.writeFileSync(path.join(folder, 'change.diff'), item.diff);
      execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', '--', 'change.diff'], { cwd: folder, stdio: 'pipe' });
      for (const file of item.files) assert.equal(fs.readFileSync(path.join(folder, file.path), 'utf8'), file.after, item.id);
    }
  } finally {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
test('historical sources match their stored hashes', () => {
  for (const snapshot of require('./real-pr-snapshots.json')) assert.equal(sha(JSON.stringify(snapshot.files)), snapshot.provenance.sourceSha256);
});
