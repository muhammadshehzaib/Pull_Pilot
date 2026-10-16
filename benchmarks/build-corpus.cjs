const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function diffFor(filePath, before, after) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pullpilot-diff-'));
  try {
    fs.writeFileSync(path.join(temp, 'before'), before);
    fs.writeFileSync(path.join(temp, 'after'), after);
    const result = spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-ext-diff', '--no-color', '--unified=8', '--', 'before', 'after'], { cwd: temp, encoding: 'utf8' });
    if (result.status !== 1 || result.error) throw new Error('Expected a nonempty git diff');
    return result.stdout.replace(/^diff --git .*$/m, `diff --git a/${filePath} b/${filePath}`)
      .replace(/^--- .*$/m, `--- a/${filePath}`).replace(/^\+\+\+ .*$/m, `+++ b/${filePath}`);
  } finally {
    // Only the concrete directory created by mkdtemp is removed.
    if (path.dirname(path.resolve(temp)) !== path.resolve(os.tmpdir())) throw new Error('Refusing cleanup outside temp root');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function buildCorpus() {
  const records = [];
  const seeded = require('./seeded.cjs');
  for (const item of seeded) {
    for (const variant of ['bug', 'clean']) {
      const before = variant === 'bug' ? item.safe : item.buggy;
      const after = variant === 'bug' ? item.buggy : item.safe;
      records.push({ id: `seed-${item.id}-${variant}`, family: 'seeded', pairId: item.id, variant,
        category: item.category, contract: item.contract,
        diff: diffFor(item.path, before, after),
        context: item.context,
        files: [{ path: item.path, before, after }],
        expectedBugs: variant === 'bug' ? [{ id: item.id, description: item.trigger, filePath: item.path, terms: item.terms }] : [],
        provenance: { kind: 'authored', license: 'AGPL-3.0-only' },
      });
    }
  }
  const realPath = path.join(__dirname, 'real-pr-snapshots.json');
  if (fs.existsSync(realPath)) {
    for (const item of JSON.parse(fs.readFileSync(realPath, 'utf8'))) {
      for (const variant of ['bug', 'clean']) {
        const files = item.files.map(file => ({ path: file.path,
          before: variant === 'bug' ? file.after : file.before,
          after: variant === 'bug' ? file.before : file.after }));
        records.push({ id: `real-${item.id}-${variant}`, family: 'historical-pr', pairId: item.id, variant,
          category: item.category, contract: item.contract, context: item.context ?? [],
          diff: files.map(f => diffFor(f.path, f.before, f.after)).join('\n'), files,
          expectedBugs: variant === 'bug' ? item.expectedBugs : [],
          provenance: { ...item.provenance, kind: variant === 'bug' ? 'reversed-source-fix' : 'source-fix',
            exclusions: 'Selected implementation files only; regression tests, changelogs and other files excluded. Fixed controls mean no labelled target regression, not proof of globally bug-free code.' },
        });
      }
    }
  }
  const corpus = { schemaVersion: 1, description: 'Paired authored mutations and selected source changes from pinned historical bug-fix PRs. Ground truth is never passed to the reviewer.', cases: records };
  const output = JSON.stringify(corpus, null, 2) + '\n';
  fs.writeFileSync(path.join(__dirname, 'corpus.json'), output);
  console.log(JSON.stringify({ cases: records.length, knownBugs: records.reduce((n, c) => n + c.expectedBugs.length, 0), sha256: sha(output) }));
}
if (require.main === module) buildCorpus();
module.exports = { diffFor, buildCorpus };
