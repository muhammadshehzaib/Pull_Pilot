const { defineDomain } = require('./support.cjs');
module.exports = defineDomain('test-cases', [
  {
    id: 'unawaited-payment', path: 'test/payments/charge.test.js', category: 'testing',
    contract: 'This async payment test must stay pending until its charge assertion runs. A resolved declined payment must fail the test.',
    safe: `export async function paymentTest(charge, assert) {
  const result = await charge();
  assert.equal(result.status, "succeeded");
}`,
    buggy: `export async function paymentTest(charge, assert) {
  charge().then(result => assert.equal(result.status, "succeeded"));
}`,
    trigger: 'The test finishes before the asynchronous payment assertion, so a declined payment can escape the test result.', terms: ['await', 'promise', 'assert', 'finish'],
    proof: '(async()=>{const tasks=[];const charge=()=>({then(resolve,reject){tasks.push(()=>{try{resolve({status:"declined"});}catch(error){reject?.(error);}});}});let finished=false;const run=f(charge,assert).then(()=>{finished=true;},()=>{finished=true;});await Promise.resolve();await Promise.resolve();const early=finished;tasks.forEach(task=>task());await run;return early;})()',
  },
  {
    id: 'unawaited-rejection-assertion', path: 'test/payments/refund.test.js', category: 'testing',
    contract: 'The async assertion that a refund rejects must be awaited so its completion contributes to the test result.',
    safe: `export async function refundTest(refund, assert) {
  await assert.rejects(() => refund(-1));
}`,
    buggy: `export async function refundTest(refund, assert) {
  assert.rejects(() => refund(-1));
}`,
    trigger: 'The test returns before its rejects assertion completes and can falsely pass for a successful invalid refund.', terms: ['await', 'reject', 'assert', 'promise'],
    proof: '(async()=>{let release;const assertions={rejects:()=>new Promise(resolve=>{release=resolve;})};let finished=false;const run=f(()=>Promise.resolve(),assertions).then(()=>{finished=true;});await Promise.resolve();await Promise.resolve();const early=finished;release();await run;return early;})()',
  },
  {
    id: 'swallowed-assertion', path: 'test/orders/totals.test.js', category: 'testing',
    contract: 'An incorrect order total must make this test throw; assertion failures must not be swallowed.',
    safe: `export function totalTest(total, assert) {
  assert.equal(total(), 2500);
}`,
    buggy: `export function totalTest(total, assert) {
  try { assert.equal(total(), 2500); } catch {}
}`,
    trigger: 'The test catches its own assertion error and passes with an incorrect order total.', terms: ['catch', 'swallow', 'assert', 'pass'],
    proof: '(()=>{try{f(()=>1,assert);return true;}catch{return false;}})()',
  },
  {
    id: 'truthiness-money', path: 'test/payments/amount.test.js', category: 'testing',
    contract: 'The test must verify the charged amount is exactly 2500 cents, not merely a nonzero value.',
    safe: `export function amountTest(payment, assert) {
  assert.equal(payment.amountCents, 2500);
}`,
    buggy: `export function amountTest(payment, assert) {
  assert.ok(payment.amountCents);
}`,
    trigger: 'An undercharge of one cent passes a truthiness assertion.', terms: ['truth', 'amount', 'equal', 'assert'],
    proof: '(()=>{try{f({amountCents:1},assert);return true;}catch{return false;}})()',
  },
  {
    id: 'tautological-expectation', path: 'test/products/pricing.test.js', category: 'testing',
    contract: 'The known fixture product costs 2500 cents. Assert the result against that independent expected value.',
    safe: `export function priceTest(price, assert) {
  const actual = price();
  assert.equal(actual, 2500);
}`,
    buggy: `export function priceTest(price, assert) {
  const actual = price();
  assert.equal(actual, actual);
}`,
    trigger: 'Comparing the computed price to itself passes for any incorrect value.', terms: ['itself', 'tautolog', 'expected', 'assert'],
    proof: '(()=>{try{f(()=>1,assert);return true;}catch{return false;}})()',
  },
  {
    id: 'mock-system-under-test', path: 'test/payments/service.test.js', category: 'testing',
    contract: 'Test the actual service.charge implementation; mocking the function under test must not replace the behavior being verified.',
    safe: `export async function serviceTest(service, assert) {
  const payment = await service.charge();
  assert.equal(payment.status, "succeeded");
}`,
    buggy: `export async function serviceTest(service, assert) {
  service.charge = async () => ({ status: "succeeded" });
  const payment = await service.charge();
  assert.equal(payment.status, "succeeded");
}`,
    trigger: 'The test replaces a broken charge implementation with a successful mock and only tests the mock.', terms: ['mock', 'implementation', 'service', 'test'],
    proof: '(async()=>{try{await f({charge:async()=>({status:"declined"})},assert);return true;}catch{return false;}})()',
  },
  {
    id: 'missing-assertion', path: 'test/orders/create.test.js', category: 'testing',
    contract: 'An order creation test must verify status="pending" rather than pass just because create resolves.',
    safe: `export async function createTest(create, assert) {
  const order = await create();
  assert.equal(order.status, "pending");
}`,
    buggy: `export async function createTest(create, assert) {
  const order = await create();
}`,
    trigger: 'An incorrectly pre-shipped order passes because the test has no assertion.', terms: ['assert', 'status', 'missing', 'test'],
    proof: '(async()=>{try{await f(async()=>({status:"shipped"}),assert);return true;}catch{return false;}})()',
  },
  {
    id: 'boundary-coverage-removed', path: 'test/orders/quantity.test.js', category: 'testing',
    contract: 'This regression test must verify that zero quantity is rejected. A successful positive-quantity example is insufficient.',
    safe: `export function quantityTest(create, assert) {
  assert.throws(() => create(0));
}`,
    buggy: `export function quantityTest(create, assert) {
  assert.equal(create(2).quantity, 2);
}`,
    trigger: 'Replacing the zero-quantity regression with a happy-path example lets a missing quantity guard pass.', terms: ['zero', 'boundary', 'coverage', 'regression'],
    proof: '(()=>{try{f(quantity=>({quantity}),assert);return true;}catch{return false;}})()',
  },
  {
    id: 'skipped-regression', path: 'test/orders/receipt.test.js', category: 'testing',
    contract: 'The receipt regression must execute during the normal test run and fail when its total is wrong.',
    safe: `export function register(test, total, assert) {
  test("receipt total", () => assert.equal(total(), 2500));
}`,
    buggy: `export function register(test, total, assert) {
  test.skip("receipt total", () => assert.equal(total(), 2500));
}`,
    trigger: 'Skipping the only receipt regression lets an incorrect total produce a green suite.', terms: ['skip', 'regression', 'test', 'run'],
    proof: '(()=>{const test=(_name,callback)=>callback();test.skip=()=>{};try{f(test,()=>1,assert);return true;}catch{return false;}})()',
  },
  {
    id: 'shared-state', path: 'test/products/catalog.test.js', category: 'testing',
    contract: 'Each registered product test must receive a fresh catalog fixture. The first test removes one product; the second expects the original two products.',
    safe: `export function register(test, assert) {
  const catalog = () => ["apple", "pear"];
  test("remove product", () => { const products = catalog(); products.pop(); assert.equal(products.length, 1); });
  test("list products", () => { const products = catalog(); assert.equal(products.length, 2); });
}`,
    buggy: `export function register(test, assert) {
  const products = ["apple", "pear"];
  test("remove product", () => { products.pop(); assert.equal(products.length, 1); });
  test("list products", () => { assert.equal(products.length, 2); });
}`,
    trigger: 'Two tests share a mutable array, so running the removal test first breaks the list test.', terms: ['shared', 'state', 'order', 'fixture'],
    proof: '(()=>{const tests=[];f((_name,callback)=>tests.push(callback),assert);try{tests.forEach(run=>run());return false;}catch{return true;}})()',
  },
]);
