const { test } = require('node:test');
const assert = require('node:assert/strict');

// Independently check the model's proposed remediation, not a new corpus bug.
// Missing IDs are its hypothetical input, not an established supported input.
for (const id of [undefined, null, '']) {
  test(`the suggested fresh-key fallback duplicates a retried payment with id=${String(id)}`, async () => {
    let sequence = 0;
    const chargedKeys = new Set();
    const gateway = { charge: async ({ idempotencyKey }) => chargedKeys.add(idempotencyKey) };
    const order = { id, totalCents: 2500 };
    const randomId = () => `generated-${++sequence}`;
    async function proposedPay() {
      // Transcribed from after-format-batch/run.json, with a fake gateway only.
      const key = typeof order.id === 'string' && order.id.length > 0 ? order.id : randomId();
      return gateway.charge({ amountCents: order.totalCents, idempotencyKey: key });
    }
    await proposedPay();
    await proposedPay();
    assert.equal(chargedKeys.size, 2, 'A fresh key per retry defeats gateway deduplication');
  });
}
