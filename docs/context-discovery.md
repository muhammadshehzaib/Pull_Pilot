# Repository context and unchanged callers

The context engine inspects imports from eligible unchanged JavaScript/TypeScript
files as well as changed files. This lets a review of `payment.service.ts` include
an unchanged `webhook.ts` that imports it, tests importing either file, and likely
related tests found by filename within the same package.

Discovery and AI prompt selection have separate limits. Indexing a file does not
mean sending that entire file to the AI. Selected caller, test, and dependency
contents are background evidence; findings still belong on changed lines.
Import relationships do not prove that a specific function is called or that a
test covers a particular behavior.

## Cache and commit identity

`cached_imports` stores encrypted raw import specifiers and extraction metadata
under `(repositoryId, blobSha, parserVersion)`. Empty import lists are cached.
The existing encrypted source cache is reused too. Cached raw imports are
resolved using the reviewed commit's current paths, tree, and supported aliases.
Resolved edges are never reused blindly across renames, alias changes, or commits.

Repository ignore globs, excluded directories, symlinks, and oversized source
files are filtered before indexing downloads. Supported source extensions are
`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, and `.cjs`.

Derived imports follow `CONTEXT_RETENTION_HOURS`, including indefinite retention
when it is zero. Finite expiry is enforced on reads and by the context sweep.
Switching from indefinite to finite retention gives previously unexpired records
a deadline. Dashboard disconnect, installation repository removal, and app
uninstall clear both caches. Writes lock/check the active repository so late
operations cannot recreate cached data after deactivation. Repository deletion
cascades to import-cache records.

## Deployment controls

These limits belong to the deployment, not an untrusted PR's `.aipr.yml`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONTEXT_INDEX_MAX_FILES` | `1000` | Eligible file paths inspected per review |
| `CONTEXT_INDEX_MAX_DOWNLOADS` | `100` | New blob downloads during import indexing |
| `CONTEXT_INDEX_MAX_BYTES` | `10485760` | Decoded-byte reservation budget for indexing downloads |
| `CONTEXT_INDEX_TIMEOUT_MS` | `20000` | Import indexing deadline, including cache work |
| `CONTEXT_INDEX_CONCURRENCY` | `4` | Parallel indexing reads, capped at 8 |

Invalid/nonpositive deployment values use their defaults. Prompt limits remain
`context.max_files`, `context.max_hops`, and `context.max_tokens`, clamped by the
existing platform ceilings. Selected contents may require additional reads after
indexing, bounded by the prompt file count and file-size ceiling. Inventory,
configuration and selected-content IO have separate ten-second deadlines; the
review worker's overall deadline and cancellation also apply.

A cold review can spend more GitHub calls than the previous dependency-only
walk. Warm indexing reuses encrypted import records without downloading those
blobs again. A warm review may still fetch selected source content if its separate
source-cache entry is missing or expired. Successful partial indexing is reusable
on later reviews, allowing download slots to advance to missing blobs. Repositories
above the inventory cap are not guaranteed eventual complete indexing.

## Evidence reporting

New review results persist `contextDiscovery`, returned by the job API as
`metadata.contextDiscovery`. It contains version, reviewed SHA, eligible/indexed/
missing/selected file counts, cache-hit counts, indexing downloads/decoded bytes,
elapsed time, status, and static reason codes. Raw index payloads and source
contents are not copied into this metadata or logs.

History shows discovery status even when no background files were selected:

- `COMPLETE`: all eligible files in the supported indexing scope were processed
  with a complete tree. This is not full semantic or application coverage.
- `PARTIAL`: useful indexing was attempted, but limits, missing files, unsupported
  resolution, unavailable storage, or an incomplete tree reduce the evidence.
- `UNAVAILABLE`: repository inventory or the relevant changed files could not
  support discovery.

Partial discovery is passed to the AI as a caveat and reflected in context risk
coverage. An empty list is not interpreted as proof that a file has no callers.
Old reviews without discovery metadata remain readable. New review publication
uses `review_pipeline_2` in analytics configuration to distinguish the changed
generation behavior; the risk scoring formula remains unchanged.

## Current resolution limits

Supported forms include static/type imports, re-exports, literal dynamic imports,
CommonJS `require`, relative modules, directory indexes, `.js` to `.ts` resolution,
and simple root aliases from `tsconfig.json` or `packages/tsconfig.json`.

Nested project configs, JSON-with-comments configs, `extends`/project references,
computed imports, and unresolved supported local references are disclosed as
partial resolution. Complete workspace/package-export resolution, other source
languages, runtime call graphs, and base/head impact analysis for deleted modules
remain outside this release. Missing/deleted changed source files explicitly
reduce discovery coverage.

## Deploy and validate

Apply migration `20261020000000_context_import_index` and regenerate Prisma before
starting the updated backend. The production container's existing startup command
applies migrations. For a manual deployment:

```powershell
npm.cmd exec --workspace=backend -- prisma migrate deploy --schema prisma/schema.prisma
npm.cmd run prisma:generate
npm.cmd run build --workspace=apps/backend
npm.cmd run build --workspace=apps/web
```

Run ordinary suites, using fewer frontend workers on memory-constrained machines:

```powershell
npm.cmd test --workspace=apps/backend
npm.cmd test --workspace=apps/web -- --maxWorkers=2
```

The PostgreSQL suite is opt-in. Select an explicitly disposable localhost database
whose name ends in `_test`, apply migrations, and set `DATABASE_URL` and
`CONTEXT_TEST_DATABASE_URL` to that same URL before running:

```powershell
npm.cmd test --workspace=apps/backend -- src/services/context-index.integration.test.ts --maxWorkers=1
```

Validation includes the original cold-cache caller failure, callers' tests,
same-package name matches, ignored paths, tight prompt budgets, renames/deletions,
alias changes, cache reuse, indexing limits, partial results, cancellation,
provider input, metadata persistence, encrypted storage, concurrent upserts,
expiry/version isolation, disconnect cleanup and database cascades. A live
GitHub/AI review against a deployed installation is a separate smoke test.
