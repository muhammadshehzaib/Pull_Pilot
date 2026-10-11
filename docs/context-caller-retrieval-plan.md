# Plan: find unchanged callers and related tests

Status: implemented for the bounded first release described below. See
[context-discovery.md](context-discovery.md) for shipped behavior, configuration,
deployment, validation, and resolution limits. A live GitHub/AI smoke test remains
an operator step.

## Goal

When a PR changes a supported source file, give the reviewer useful background from:

- Files that the changed file imports.
- Unchanged files that import the changed file.
- Relevant existing tests, including tests of affected callers.

For example, changing `payment.service.ts` should allow retrieval of
`webhook.ts`, which imports it, and `payment.service.test.ts`, even when neither
file appears in the PR diff. This improves the evidence available to the AI;
it does not guarantee that the model will detect every regression.

## What is wrong today

`context-retrieval.service.ts` already walks imports in both directions, but it
builds edges only from files present in its `contents` map.
`context-builder.ts` initially fills that map with changed files and then files
reachable through their imports. An unchanged caller outside that set is never
read, so its incoming relationship never enters the graph.

The fix must discover imports independently of which files are selected for
the AI prompt. Changing the direction of traversal alone will not fix this.

## Recommended design

Use a small, reusable import index backed by the existing PostgreSQL database
and encrypted source cache. Continue using GitHub tree and blob APIs.

```text
Repository tree at the reviewed commit
                  |
                  v
Read cached imports; fetch and parse missing eligible files within limits
                  |
                  v
Build forward and reverse file relationships for this commit
                  |
                  v
Select direct callers, dependencies, and relevant tests
                  |
                  v
Fetch selected source contents and fit them into the prompt budget
                  |
                  v
AI reviews the diff with supporting evidence
```

Indexing may inspect more files than the prompt includes. Keep these budgets
separate: the existing 25-file prompt limit must not mean that only 25 files
can contribute import relationships.

The first release supports the existing JavaScript/TypeScript extensions. An
import relationship establishes that one file depends on another; it does not
prove that a particular function is called. Describe this accurately in prompts.

## Implementation order

### 1. Add the regression test before changing retrieval

Add a builder-level fixture with a changed payment service, an unchanged webhook
importing it, an unchanged test importing it, and an unrelated file. Start with an
empty cache and assert that the webhook and test reach the final context bundle.

Also test a changed service with no outgoing imports. This exposes the current
failure particularly clearly. Testing only the graph selector with all source
contents preloaded would miss the bug.

### 2. Add a reusable cache of extracted imports

Introduce `repository-import-index.service.ts` and an additive Prisma migration
for a repository-scoped parsed-import cache. Each record contains:

- Repository ID, blob SHA, and parser version as its unique identity.
- An encrypted payload of extracted raw import specifiers and extraction status.
- Creation and expiry timestamps consistent with context retention settings.

Cache empty import lists too. A successfully parsed file with no imports is
different from an unreadable file or a failed extraction.

On a cache miss, use the existing encrypted source cache before fetching a blob
from GitHub. Persist extracted imports only after successful extraction. Parser
version changes invalidate prior parsed results.

Do not cache resolved edges by blob SHA alone. The same bytes can move to a
different directory, and import targets can change when aliases or files change.
Resolve cached raw specifiers against the current path, current tree, and current
supported alias configuration on every review.

### 3. Build the graph from the repository inventory

In `context-builder.ts`, assemble graph inputs from eligible unchanged files as
well as changed files. Build a forward map, such as `webhook -> payment`, and a
reverse map, such as `payment -> webhook`, before selecting context files.

Pass this graph to `selectContextFiles` separately from source contents. Fetch
full contents for selected candidates afterward; the selector must no longer
require a caller's full contents to have already been selected.

Use the review's exact head SHA throughout. Build a fresh path-to-blob map from
that tree, so renamed files use their current location, deleted files do not
leave stale edges, and concurrent reviews cannot overwrite a shared latest graph.
Concurrent cache writes should be idempotent.

Support the existing static imports, re-exports, literal dynamic imports,
`require`, and supported TypeScript aliases. Add regression cases for those
forms. Record unsupported resolution configurations rather than silently claiming
complete dependency coverage. Do not expand this work into a multi-language
symbol or runtime call-graph engine.

### 4. Bring relevant tests into the same selection process

Reuse or extract the pure helpers in
`test-gap/test-discovery.service.ts`; do not duplicate its naming rules.

Find tests through two evidence sources:

- Import relationships: tests importing the changed file or an affected caller.
- Naming conventions: matching `*.test.*`, `*.spec.*`, and existing test layouts
  within the supported source extensions.

Prefer proven import relationships over name-only matches. For name matches,
prefer the same package and nearby directory so two unrelated `service.test.ts`
files in a monorepo do not appear equally relevant. Describe name matches as
likely related tests, not proven coverage.

Keep Phase 5 test-gap behavior compatible. Sharing discovery helpers does not
make missing-test suggestions into executed or verified tests.

### 5. Select useful evidence within the existing prompt limits

Rank direct importers and directly related tests highly, then direct dependencies
and more distant relationships. Keep the existing hop limit, cycle protection,
duplicate removal, and barrel/hub demotion.

When both callers and dependencies are available, selection should avoid filling
the entire budget with only one direction. Tests should not disappear behind a
large dependency list. Use deterministic ordering and redistribution of unused
slots, with regression tests for small budgets.

Apply repository ignore patterns and existing excluded-directory rules before
index fetches, graph assembly, and prompt selection. Skip oversized files and
symlinks using tree metadata before fetching. Pass the necessary ignore policy
from the worker into the builder; changed paths alone do not express that policy.

The final prompt still respects `max_files`, `max_hops`, and `max_tokens`.
Background files remain evidence for findings anchored to changed lines.

### 6. Bound indexing and report incomplete coverage honestly

Add deployment-controlled indexing limits separate from `.aipr.yml` prompt
settings. Suggested initial defaults, to validate with performance fixtures:

| Limit | Initial value |
| --- | --- |
| Eligible files inspected per review | 1,000 |
| New blob downloads for indexing per review | 100 |
| New decoded blob bytes for indexing | 10 MB |
| Indexing deadline | 20 seconds |
| Concurrent blob downloads | 4 |

Prioritize changed files, known relationships, and nearby source/tests when
filling an incomplete index. Inspect already cached imports without spending
download slots, then process missing entries in a stable order. Later reviews
can reuse earlier successful work and advance to missing entries. Do not promise
eventual completeness for repositories beyond the inventory cap.

Track counts and reasons: eligible files, indexed files, missing files, cache
hits, downloads, truncated tree, unsupported resolution, elapsed time, and budget
exhaustion. COMPLETE means all eligible files in the supported indexing scope
were successfully processed with a complete tree; it does not mean complete
semantic understanding of the application.

Persist coverage metadata even when no context files are selected. Otherwise an
empty result hides whether there were no related files or discovery failed.
Update worker results, API metadata, prompt caveats, and context confidence so a
partial index never appears as fully available context. Old review records must
continue to render without the new fields.

Pass cancellation/deadline signals through indexing and GitHub requests. Check
them before starting each batch. Rate limits, fetch failures, or unavailable
storage should preserve whatever usable context exists and allow review to
continue with an explicit partial/unavailable status. Log counts and static
reason codes, not source contents or extracted import payloads.

### 7. Match existing cache lifecycle and deployment behavior

Keep parsed imports isolated by repository, encrypted, and subject to the same
finite or indefinite context-retention policy as source blobs. Extend retention
sweeps and every disconnect path: dashboard disconnect, installation repository
removal, and app uninstall. Database repository deletion must cascade.

Apply the additive migration and regenerate Prisma before deploying the backend.
Update README context claims, configuration documentation, and deployment notes.
If analytics tracks review-generation versions, advance that version when the
new retrieval behavior ships so trend comparisons acknowledge the change.

## Expected code changes

| Area | Work |
| --- | --- |
| `prisma/schema.prisma` and a new migration | Parsed-import cache and indexes |
| New `repository-import-index.service.ts` | Cache lookup, bounded discovery, graph assembly, and coverage |
| `context-builder.ts` | Separate indexing, selection, and selected-content loading |
| `context-retrieval.service.ts` | Consume graph edges without requiring every source body |
| `import-graph.service.ts` | Reuse extraction/resolution; correct issues exposed by supported-form tests |
| `test-gap/test-discovery.service.ts` or a shared helper | Reuse pure test matching with package-aware ranking |
| `repository-context-cache.service.ts` | Reuse encrypted blob reads and enforce size/lifecycle rules |
| `utils/constants.ts` and production configuration | Indexing limits |
| `analysis.worker.ts`, GitHub service, context prompt, job API | Ignore policy, cancellation, persisted coverage, and accurate caveats |
| Retention/disconnect handlers | Remove parsed-import records alongside cached code |
| History UI and types, if needed | Show complete, partial, or unavailable discovery |

## Acceptance checks

1. A cold-cache review of a changed service discovers its unchanged direct
   importer and test, even when the service imports nothing.
2. An integration test importing that caller is discoverable within the configured
   hop limit. Unrelated files do not crowd it out.
3. Re-exports, supported aliases, literal dynamic imports, and CommonJS cases
   produce the expected relationships; cycles terminate.
4. A warm review reuses parsed imports without downloading unchanged indexed
   blobs again while their cache records remain valid.
5. Renames, deletions, alias changes, and concurrent reviews use each review's
   exact tree. A stale edge cannot introduce a nonexistent target.
6. Ignore rules, size limits, fetch failures, truncation, rate limits, cancellation,
   and indexing caps preserve bounded work and report missing evidence.
7. Tight prompt budgets preserve useful caller/test evidence and remain within
   the configured file and character ceilings, including formatting overhead.
8. Cross-repository access is rejected; retention and all disconnect paths remove
   derived import records. Integration tests use the existing disposable-test-DB
   conventions.
9. Existing provider, worker, history, and test-gap tests remain compatible.

Run focused regression suites during implementation, then the backend and
frontend suites and builds for the final change. Validate cold and warm API-call
counts and elapsed time with fixed small and large repository fixtures. Finally,
use an authorized sample PR to confirm caller/test evidence actually appears in
the provider input; a passing graph test alone is insufficient.

## Release boundary and follow-up

This release fixes discovery for supported imports within the indexing and prompt
budgets and makes gaps visible. It does not claim that every caller in every
repository will fit into one review.

Defer function-level call graphs, other programming languages, runtime-generated
imports, complete workspace/package-export resolution, and base/head comparison
for deleted public modules. Deletion-only changes must be reported as unsupported
or partial impact analysis, not treated as proven to have no callers.

If cold indexing remains too slow for large repositories, add a separately
bounded background indexer with resumable progress and exact commit identity.
Treat that as a measured follow-up, rather than making a new queue a prerequisite
for correcting the current retrieval bug.
