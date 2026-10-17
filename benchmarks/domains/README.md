# Commerce and test-code bug lab

The lab adds **50 deliberately faulty changes and 50 paired fixed controls** to
PullPilot's review corpus. These are authored learning/evaluation fixtures. They
do not change the application's production payments, customers or repositories.

Each `.fixtures.cjs` entry contains a documented contract, realistic filename,
`buggy` and `safe` implementations, a concrete failure trigger and an executable
`proof`. Expected-finding hints are used only for adjudication.

`domains.test.cjs` runs each proof against both versions: the faulty behavior
must reproduce and the fixed version must avoid it. The harness stays green when
it demonstrates both outcomes. A passing proof does not establish that an AI
reviewer found the bug. Labels, proof code and trigger descriptions are excluded
from the reviewer input.

## Payments — 10 targets

Source: [payments.fixtures.cjs](payments.fixtures.cjs).

| Scenario | Demonstrated failure |
| --- | --- |
| Client-owned amount | Buyer pays one cent for a server-priced order. |
| Retry idempotency | A fresh gateway key creates a second charge on retry. |
| Webhook signature | An unsigned event marks an order paid. |
| Declined payment | A resolved declined result is treated as success. |
| Partial refunds | Sequential refunds exceed the captured amount. |
| Currency reconciliation | An amount match hides a currency mismatch. |
| Delayed gateway event | Processing overwrites a terminal succeeded status. |
| Zero-decimal currency | JPY is multiplied by 100 and overcharged. |
| Event replay | One event fulfills an order twice. |
| Negative refund | A nonpositive amount reaches the gateway. |

The gateway is a deterministic in-memory double. Idempotency/event tests cover
the sequential retries in their contracts; they do not prove distributed
concurrency safety or real gateway integration.

## Orders — 10 targets

Source: [orders.fixtures.cjs](orders.fixtures.cjs).

| Scenario | Demonstrated failure |
| --- | --- |
| Negative quantity | An order line receives a negative total. |
| Cancellation owner | One customer cancels another customer's order. |
| Invalid transition | A cancelled order is shipped. |
| Cancellation retry | Reserved stock is restored twice. |
| Receipt snapshot | A catalog edit changes an old receipt. |
| Discount floor | An oversized coupon creates a negative payable amount. |
| Mixed basket | A physical item skips shipping because another item is digital. |
| Creation retry | A repeated request inserts another order. |
| Shipping calculation | A per-order shipping fee is charged per line. |
| Partial fulfillment | Fulfilling one line marks every line fulfilled. |

## Products — 10 targets

Source: [products.fixtures.cjs](products.fixtures.cjs).

| Scenario | Demonstrated failure |
| --- | --- |
| Variant stock | An unavailable size appears available due to aggregate stock. |
| Variant price | A premium variant uses the cheaper base price. |
| Zero-price update | A truthiness guard prevents making a product free. |
| Unpublish cache | A public cached copy remains published. |
| Soft deletion | Deleted products remain in public results. |
| Moderation | A pending draft is published without approval. |
| Literal search | Search text becomes an unintended regular expression. |
| Free-product filter | maxCents=0 is treated as no price limit. |
| Stock boundary | A zero-stock product has an enabled buy button. |
| Tenant SKU | A merchant reads another merchant's matching SKU. |

## Database operations — 10 targets

Source: [database.fixtures.cjs](database.fixtures.cjs).

These proofs execute actual SQL using `node:sqlite` and a fresh `:memory:`
database per variant. The harness closes every database. It does not connect to
the project's PostgreSQL database or use customer connection strings.

| Scenario | Demonstrated failure |
| --- | --- |
| Tenant UPDATE | An invoice update affects another tenant. |
| Transfer rollback | A failed destination constraint leaves a committed debit. |
| Foreign keys | A nonexistent parent order is accepted. |
| Optimistic concurrency | A stale snapshot overwrites a newer wallet balance. |
| SQL NULL semantics | `= NULL` hides active rows. |
| Scoped DELETE | One logout deletes every user's sessions. |
| Cursor ties | Timestamp-only pagination skips a tied row permanently. |
| Email uniqueness | Case variants create duplicate account identities. |
| Parameter binding | A crafted email changes the SQL predicate. |
| Delete cascade | Deleting an order leaves detached line items. |

These demonstrate SQLite data invariants. They do not validate PostgreSQL
isolation levels, multi-process locks, migrations or throughput. The lost-update
proof deterministically applies two stale snapshots instead of depending on a
timing-sensitive race.

## Faulty tests — 10 targets

Source: [test-cases.fixtures.cjs](test-cases.fixtures.cjs).

Here the reviewed change is test code. Proofs show that a defective test accepts
a broken implementation, finishes before its assertions, or fails due to shared
state.

| Scenario | Demonstrated failure |
| --- | --- |
| Unawaited payment | The test completes before its payment assertion. |
| Unawaited rejection check | A `rejects` assertion escapes the test lifecycle. |
| Swallowed assertion | A catch block turns a failure into a pass. |
| Truthiness money check | One cent satisfies a test intended to assert 2500 cents. |
| Tautological expectation | Comparing a value to itself cannot verify its price. |
| Mocked system under test | The charge implementation is replaced before testing. |
| Missing assertion | A pre-shipped order passes a creation test. |
| Removed boundary coverage | A happy-path example replaces the zero-quantity regression. |
| Skipped regression | An incorrect receipt escapes the normal suite. |
| Shared mutable fixture | Test order changes the second test's outcome. |

Async lifecycle cases use controlled thenables/promises to avoid nondeterministic
unhandled rejections in the benchmark process.

## Run one area at a time

```powershell
# Prove all 50 bugs and their fixes.
npm run benchmark:test:domains

# Prove payments only; substitute orders/products/database/test-cases as needed.
node --test --test-name-pattern "^payments:" benchmarks/domains.test.cjs

# Review ten payment bugs and ten fixed controls with the built-in scanners.
npm run benchmark -- --mode scanners --domain payments --out .benchmark-runs/payments

# With a configured local AI key, review the same payment diffs with the AI.
npm run benchmark -- --mode live --provider GEMINI --domain payments --out .benchmark-runs/payments-ai

# Export one domain for blinded review with another tool.
npm run benchmark -- --mode export --domain orders --out .benchmark-runs/orders-export
```

Read the source before adjudicating findings. Different wording does not imply a
miss; inspect whether the finding explains the same failure mechanism. See the
[benchmark guide](../README.md) for scoring, pricing and comparison instructions.

The project history keeps separate commits for the foundation, payments, orders,
products, database bugs, faulty tests, integration and measured results. The
fixture runner does not push or publish anything.
