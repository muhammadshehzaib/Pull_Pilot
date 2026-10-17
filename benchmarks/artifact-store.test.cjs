const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJson } = require('./artifact-store.cjs');

test('brief Windows locks are retried without truncating the last checkpoint', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'pullpilot-checkpoint-'));
  try {
    const file = path.join(folder, 'run.json');
    writeJson(file, { completed: 1 });
    let attempts = 0;
    writeJson(file, { completed: 2 }, { ...fs, renameSync(from, to) {
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).completed, 1);
      if (++attempts < 3) throw Object.assign(new Error('temporary lock'), { code: 'UNKNOWN' });
      fs.renameSync(from, to);
    } });
    assert.equal(attempts, 3);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).completed, 2);
    assert.deepEqual(fs.readdirSync(folder), ['run.json']);
  } finally {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('a permanent replacement failure preserves the old result and removes the temp file', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'pullpilot-checkpoint-'));
  try {
    const file = path.join(folder, 'run.json');
    writeJson(file, { completed: 1 });
    assert.throws(() => writeJson(file, { completed: 2 }, { ...fs, renameSync() {
      throw Object.assign(new Error('disk error'), { code: 'ENOSPC' });
    } }), /disk error/);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).completed, 1);
    assert.deepEqual(fs.readdirSync(folder), ['run.json']);
  } finally {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
