const { defineDomain } = require('./support.cjs');
module.exports = defineDomain('payments', [
  {
    id: 'client-amount', path: 'src/payments/checkout.js',
    contract: 'Charge the server-owned order total in integer cents. The request body is untrusted.',
    safe: `export async function charge(order, body, gateway) {
  return gateway.charge({ orderId: order.id, amountCents: order.totalCents });
}`,
    buggy: `export async function charge(order, body, gateway) {
  return gateway.charge({ orderId: order.id, amountCents: body.amountCents });
}`,
    trigger: 'A buyer submits amountCents=1 for a server-priced 2500-cent order and is charged one cent.',
    terms: ['amount', 'client', 'price', 'untrusted'],
    proof: '(async()=>{let amount;await f({id:"order-1",totalCents:2500},{amountCents:1},{charge:async p=>{amount=p.amountCents;}});return amount!==2500;})()',
  },
  {
    id: 'retry-idempotency', path: 'src/payments/charge.js',
    contract: 'Retries of the same order must create one charge. The gateway deduplicates by idempotencyKey; randomId returns a new ID each call.',
    safe: `export async function pay(order, gateway, randomId) {
  return gateway.charge({ amountCents: order.totalCents, idempotencyKey: order.id });
}`,
    buggy: `export async function pay(order, gateway, randomId) {
  return gateway.charge({ amountCents: order.totalCents, idempotencyKey: randomId() });
}`,
    trigger: 'Retrying an order uses a new gateway key and creates a second charge.', terms: ['retry', 'idempot', 'duplicate', 'charge'],
    proof: '(async()=>{let n=0;const charges=new Map();const gateway={charge:async p=>{charges.set(p.idempotencyKey,p.amountCents);}};const order={id:"o1",totalCents:2500};await f(order,gateway,()=>String(++n));await f(order,gateway,()=>String(++n));return charges.size!==1;})()',
  },
  {
    id: 'signature-bypass', path: 'src/payments/webhooks.js', category: 'security',
    contract: 'Verify the webhook signature against rawBody before marking any order paid. verify returns a boolean.',
    safe: `export async function webhook(rawBody, signature, verify, markPaid) {
  if (!verify(rawBody, signature)) throw new Error("invalid signature");
  const event = JSON.parse(rawBody);
  return markPaid(event.orderId);
}`,
    buggy: `export async function webhook(rawBody, signature, verify, markPaid) {
  const event = JSON.parse(rawBody);
  return markPaid(event.orderId);
}`,
    trigger: 'An unsigned forged webhook marks an unpaid order paid.', terms: ['signature', 'webhook', 'forg', 'verify'],
    proof: '(async()=>{let paid=false;try{await f(JSON.stringify({orderId:"o1"}),"forged",()=>false,async()=>{paid=true;});}catch{}return paid;})()',
  },
  {
    id: 'declined-as-paid', path: 'src/payments/confirmation.js',
    contract: 'The gateway resolves declined payments with status="declined". Only status="succeeded" may mark an order paid.',
    safe: `export async function confirm(order, gateway, markPaid) {
  const payment = await gateway.charge(order);
  if (payment.status !== "succeeded") return false;
  await markPaid(order.id);
  return true;
}`,
    buggy: `export async function confirm(order, gateway, markPaid) {
  const payment = await gateway.charge(order);
  await markPaid(order.id);
  return true;
}`,
    trigger: 'A resolved declined gateway result still marks the order paid.', terms: ['declin', 'status', 'paid', 'success'],
    proof: '(async()=>{let paid=false;await f({id:"o1"},{charge:async()=>({status:"declined"})},async()=>{paid=true;});return paid;})()',
  },
  {
    id: 'partial-refund-limit', path: 'src/payments/refunds.js',
    contract: 'Sequential partial refunds must not exceed capturedCents in total. refund updates refundedCents after a successful gateway call.',
    safe: `export async function refund(payment, amountCents, gateway) {
  if (amountCents > payment.capturedCents - payment.refundedCents) throw new Error("refund exceeds remaining");
  await gateway.refund(amountCents);
  payment.refundedCents += amountCents;
}`,
    buggy: `export async function refund(payment, amountCents, gateway) {
  if (amountCents > payment.capturedCents) throw new Error("refund exceeds captured");
  await gateway.refund(amountCents);
  payment.refundedCents += amountCents;
}`,
    trigger: 'After refunding 700 of 1000 cents, a second 700-cent refund is accepted.', terms: ['refund', 'remaining', 'cumul', 'captur'],
    proof: '(async()=>{const p={capturedCents:1000,refundedCents:0};const gateway={refund:async()=>{}};await f(p,700,gateway);try{await f(p,700,gateway);}catch{}return p.refundedCents>p.capturedCents;})()',
  },
  {
    id: 'currency-mismatch', path: 'src/payments/reconciliation.js',
    contract: 'A settled payment must match both the order currency and its integer minor-unit amount.',
    safe: `export function matches(order, payment) {
  return payment.amount === order.amount && payment.currency === order.currency;
}`,
    buggy: `export function matches(order, payment) {
  return payment.amount === order.amount;
}`,
    trigger: 'A 1000 JPY payment is accepted for a 1000 USD-minor-unit order.', terms: ['currency', 'amount', 'match'],
    proof: 'f({amount:1000,currency:"USD"},{amount:1000,currency:"JPY"})',
  },
  {
    id: 'out-of-order-webhook', path: 'src/payments/status.js',
    contract: 'Payment status succeeded is terminal; a delayed processing event must not downgrade it.',
    safe: `export function applyEvent(payment, event) {
  if (payment.status === "succeeded" && event.status !== "succeeded") return;
  payment.status = event.status;
}`,
    buggy: `export function applyEvent(payment, event) {
  payment.status = event.status;
}`,
    trigger: 'A delayed processing event changes a succeeded payment back to processing.', terms: ['event', 'order', 'downgrad', 'terminal'],
    proof: '(()=>{const p={status:"succeeded"};f(p,{status:"processing"});return p.status!=="succeeded";})()',
  },
  {
    id: 'zero-decimal-currency', path: 'src/payments/currency.js',
    contract: 'Amounts are major currency units. JPY has zero decimal places; USD has two. Return integer gateway minor units.',
    safe: `export function minorUnits(amount, currency) {
  const factor = currency === "JPY" ? 1 : 100;
  return Math.round(amount * factor);
}`,
    buggy: `export function minorUnits(amount, currency) {
  return Math.round(amount * 100);
}`,
    trigger: 'A 2500 JPY purchase is charged 250000 JPY.', terms: ['JPY', 'decimal', '100', 'currency'],
    proof: 'f(2500,"JPY")!==2500',
  },
  {
    id: 'webhook-replay', path: 'src/payments/fulfillment.js',
    contract: 'Sequential deliveries of the same gateway event ID must fulfill its order once. fulfill resolves after completion.',
    safe: `export async function processEvent(event, seen, fulfill) {
  if (seen.has(event.id)) return;
  await fulfill(event.orderId);
  seen.add(event.id);
}`,
    buggy: `export async function processEvent(event, seen, fulfill) {
  await fulfill(event.orderId);
  seen.add(event.id);
}`,
    trigger: 'A retried signed event fulfills and ships the same order twice.', terms: ['replay', 'duplicate', 'fulfill', 'event'],
    proof: '(async()=>{let shipments=0;const seen=new Set(),event={id:"evt-1",orderId:"o1"};await f(event,seen,async()=>{shipments++;});await f(event,seen,async()=>{shipments++;});return shipments!==1;})()',
  },
  {
    id: 'negative-refund', path: 'src/payments/refund-validation.js',
    contract: 'A refund amount must be a positive safe integer number of cents before any gateway call.',
    safe: `export async function refund(amountCents, gateway) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error("invalid amount");
  return gateway.refund(amountCents);
}`,
    buggy: `export async function refund(amountCents, gateway) {
  if (!Number.isSafeInteger(amountCents)) throw new Error("invalid amount");
  return gateway.refund(amountCents);
}`,
    trigger: 'A negative refund amount reaches the gateway and can reverse the intended accounting direction.', terms: ['negative', 'positive', 'refund', 'amount'],
    proof: '(async()=>{let sent=false;try{await f(-100,{refund:async()=>{sent=true;}});}catch{}return sent;})()',
  },
]);
