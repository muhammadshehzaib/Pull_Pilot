const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('compiled review dependencies never implicitly read environment files or import generated Prisma', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    const original = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if (typeof file === 'string' && /^\\.env(?:\\.|$)/i.test(path.basename(file))) {
        throw new Error('Unexpected implicit environment file read');
      }
      return original.call(this, file, ...args);
    };
    for (const file of ['utils/constants.js', 'services/config.service.js',
      'services/diff-filter.service.js', 'services/ai/providers/grok.provider.js']) {
      require(path.resolve('apps/backend/dist', file));
    }
    if (Object.keys(require.cache).some(p => p.includes(path.sep + '.prisma' + path.sep))) {
      throw new Error('Unexpected generated database runtime');
    }
  `], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
