const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDomains, reproduce } = require('./domains/support.cjs');
const fixtures = loadDomains();

test('domain targets have distinct IDs, contracts and reproducible known failures', () => {
  assert.equal(new Set(fixtures.map(item => item.id)).size, fixtures.length);
  for (const item of fixtures) {
    assert.ok(item.trigger && item.contract && item.terms.length && item.proof);
    assert.notEqual(item.safe, item.buggy);
    assert.ok(item.path.endsWith('.js'));
  }
});
for (const fixture of fixtures) {
  test(`${fixture.domain}: ${fixture.id} fails before fix and passes after fix`, async () => {
    assert.equal(await reproduce(fixture, 'buggy'), true, fixture.trigger);
    assert.equal(await reproduce(fixture, 'safe'), false, `Fixed version still fails: ${fixture.trigger}`);
  });
}
