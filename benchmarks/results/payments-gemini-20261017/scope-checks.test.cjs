// Validate broader observations without changing the frozen benchmark or treating
// pre-existing/out-of-contract risks as newly introduced target regressions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fixtures = require('../../domains/payments.fixtures.cjs');
function implementation(id, variant) {
  const fixture = fixtures.find(item => item.id === `payments-${id}`);
  const name = /export (?:async )?function (\w+)/.exec(fixture[variant])[1];
  return vm.runInNewContext(fixture[variant].replace(/export /g, '') + `\n${name};`);
}
test('JPY/USD control is correct; KWD limitation predates the reviewed fix', () => {
  const fixed = implementation('zero-decimal-currency', 'safe');
  assert.equal(fixed(2500, 'JPY'), 2500);
  assert.equal(fixed(25, 'USD'), 2500);
  const expected = 10 ** new Intl.NumberFormat('en-US', { style: 'currency', currency: 'KWD' }).resolvedOptions().maximumFractionDigits;
  assert.equal(expected, 1000);
  assert.equal(fixed(1, 'KWD'), 100);
  assert.equal(implementation('zero-decimal-currency', 'buggy')(1, 'KWD'), 100);
});
test('sequential replay is fixed; concurrent fulfillment risk is pre-existing', async () => {
  const fixed = implementation('webhook-replay', 'safe');
  const event = { id: 'evt-1', orderId: 'o1' };
  let sequential = 0;
  const seen = new Set();
  await fixed(event, seen, async () => { sequential++; });
  await fixed(event, seen, async () => { sequential++; });
  assert.equal(sequential, 1);
  for (const variant of ['safe', 'buggy']) {
    const run = implementation('webhook-replay', variant), concurrentSeen = new Set();
    let deliveries = 0;
    await Promise.all([run(event, concurrentSeen, async () => { deliveries++; }), run(event, concurrentSeen, async () => { deliveries++; })]);
    assert.equal(deliveries, 2);
  }
});
test('sequential refund cap is fixed; concurrent over-refund risk is pre-existing', async () => {
  const fixed = implementation('partial-refund-limit', 'safe');
  const payment = { capturedCents: 1000, refundedCents: 0 }, gateway = { refund: async () => {} };
  await fixed(payment, 700, gateway);
  await assert.rejects(() => fixed(payment, 700, gateway));
  assert.equal(payment.refundedCents, 700);
  for (const variant of ['safe', 'buggy']) {
    const run = implementation('partial-refund-limit', variant);
    const concurrent = { capturedCents: 1000, refundedCents: 0 };
    await Promise.all([run(concurrent, 700, gateway), run(concurrent, 700, gateway)]);
    assert.equal(concurrent.refundedCents, 1400);
  }
});
