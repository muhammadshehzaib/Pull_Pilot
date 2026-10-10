# Behavioral verification and explainable risk

Phase 6 executes **explicit, developer-approved scenarios** in repository-owner GitHub Actions. Phase 5 remains the source of suggested scenarios. The API and review worker never execute PR code, browser code, generated tests, builds or deployments. No preview is created automatically.

## Enable owner CI

1. Deploy the Prisma migration with `prisma migrate deploy` in the backend workspace. Generate the client and rebuild the backend.
2. Set `BEHAVIORAL_OIDC_AUDIENCE` on the backend to an application-specific value (for example `aipr-behavioral-production`). The backend must be reachable through a public HTTPS origin.
3. Review and copy [the workflow template](behavioral-workflow.example.yml) into the **application repository's default branch** at `.github/workflows/aipr-behavioral.yml`. No API writes or installs this workflow for you.
4. Configure repository Actions variables: `AIPR_RUNNER_REPOSITORY` (the trusted AI PR Reviewer tooling repository), `AIPR_RUNNER_SHA` (a reviewed, immutable 40-character tooling commit), `AIPR_BACKEND_URL` (the backend HTTPS origin), and `AIPR_OIDC_AUDIENCE` (exactly the backend value). Use GitHub-hosted `ubuntu-latest`, never a self-hosted runner. For private tooling repositories, arrange a narrowly scoped checkout credential in your trusted workflow; the template's default repository token cannot read a different private repository.
5. The GitHub App needs **Actions write**, **Deployments read**, and existing metadata/content/PR read permissions. Reapprove the installation if its permissions change.
6. In review history, open **Owner CI and preview settings**. Set `enabled`, `workflowSha` (the current reviewed application default-branch HEAD, including the installed workflow), one exact `previewHost`, `environment`, and up to five approved deployment-status publisher logins. Confirm and save. This setting cannot be enabled through an untrusted PR's `.aipr.yml`.
7. Arrange your existing owner-controlled deployment integration to publish a **successful GitHub deployment status** whose deployment SHA exactly matches the reviewed job's commit, whose environment/publisher match the settings, and whose `environment_url` is a credential-free HTTPS origin on the approved host. A URL pasted into a PR comment or an API request is never preview authority. Providers deploying a synthetic merge SHA need a separately reviewed job for that SHA; it is not silently treated as the PR head.
8. Select a suggested Phase 5 scenario, enter its concrete actions using the actual preview's `data-testid` values, enter the GitHub deployment ID, confirm, and run. Refresh execution results to retrieve outcomes and the updated risk explanation.

The workflow is dispatched from the pinned application default branch and checks out only the separately pinned **trusted tooling**, never the PR. Any change to application default-branch HEAD requires reviewing and updating `workflowSha`. OIDC signatures, issuer, audience, repository ID, exact workflow ref/SHA, dispatch event, run ID and attempt 1 are verified, together with a random dispatch proof. The proof and OIDC token are never sent to the browser. Changing/revoking owner settings invalidates claims. A lost dispatch response is not resent automatically: the same request key returns the original run. Wait for its deadline before creating a new request.

## Scenario language and limits

```json
[
  { "action": "navigate", "path": "/cart" },
  { "action": "click", "testId": "open-cart" },
  { "action": "assertVisible", "testId": "empty-cart" },
  { "action": "assertText", "testId": "cart-count", "text": "0" }
]
```

Supported actions are `navigate`, `click`, `fill`, `assertVisible`, and `assertText`. `fill` accepts only synthetic `EMPTY`, `TEXT`, or `EMAIL` fixtures. Actions never accept shell, JavaScript, arbitrary selectors or code. Every scenario starts with a simple relative navigation and contains an assertion. The current UI submits one scenario at a time; the API accepts up to three. Do not invent DOM selectors from a backend-only test gap; such a scenario cannot currently be executed through this browser interface.

Limits: 3 scenarios/run, 12 steps/scenario, 20 seconds/scenario, 65 seconds/container, 10-minute claim/result deadline including CI queuing, zero automatic execution retries, 100 resource requests, 2 MB/resource, 12 MB total resources, 5 runs/job, 10 runs/repository/day and one active run/repository. Docker caps memory (1 GB), CPU (1 core), process count (128) and writable temporary storage (256 MB). The workflow has a five-minute job timeout. Runner records/plans/step evidence expire after seven days; a minute-level bounded sweep removes expired rows. Content-free scenario outcome summaries remain in normal review history. Deleting the job/repository cascades its runs.

## Network and evidence boundaries

The browser runs in a read-only, capability-dropped Docker container with `--network none`, no host mounts, no application credentials, and bounded temporary storage. The trusted parent fetcher permits only GET over HTTPS to the one approved preview host. Every request resolves DNS, rejects any non-public result (IPv4 and IPv6), pins the checked address to that connection, and disables connection reuse. Redirects are never followed by the fetcher; every redirect destination must satisfy the same origin policy and is rechecked when the browser requests it. DNS rebinding cannot change the address used by an already validated socket. Cookies, authorization, page-supplied headers and sensitive response headers are not forwarded. Service workers, WebSockets, frames, downloads, worker scripts, external origins and form submissions are blocked. A blocked resource prevents PASS.

This intentionally supports **public, same-origin, read-only preview flows**. Authenticated flows, POST/PUT/DELETE APIs, third-party assets and cross-origin flows are not supported. Add a separately reviewed executor/policy for those requirements rather than relaxing this boundary silently. Assertions describe only their selected scenario; they do not establish comprehensive regression or security coverage.

Results distinguish generated, executed and verified scenarios. Only all passing steps and assertions establish `PASSED`/`VERIFIED`. Missing previews are `NOT_RUN`; assertion mismatches are `FAILED`; limits are `TIMED_OUT`; runner/policy errors are `ERROR`. Partial runs retain per-scenario outcomes. Later missing/error evidence does not erase an earlier assertion failure for the same reviewed commit. Stored evidence contains only scenario IDs, bounded step indexes/statuses and static reason codes. No screenshots, DOM dumps, console logs, response bodies, observed assertion values or raw runner exception messages are stored or logged. Synthetic input avoids sending customer credentials to previews.

## Risk report v2

The legacy `results.risk` report remains available. New jobs additionally persist `riskV2` and baseline behavioral metadata. Job detail returns the current behavioral summary and recomputes v2 from those durable results; it does not reinterpret old v1-only records as fully scanned reviews.

Direction: **0 = lower indicated risk, 100 = higher indicated risk**. Score is the capped sum of explained contributions. Severity weights remain CRITICAL 30, HIGH 15, MEDIUM 6, LOW 2, INFO 0. Repeated findings count once at strongest severity. All surviving detector sources are retained; corroboration adds no duplicate points. HIGH/MEDIUM/LOW confidence suggested gaps contribute 2/1/0 points. Executed behavioral assertion failures contribute 15, replacing that scenario's advisory gap contribution. A verified scenario removes only its own advisory gap points, never unrelated findings. A precisely matching finding/scenario uses the stronger contribution once. Unrepresented failed deterministic rule checks contribute 6; represented rule violations are not added again. Missing/error/timed-out execution never counts as a pass or a measured test failure.

Thresholds: REVIEW at 25; advisory BLOCK at 75. HIGH/CRITICAL findings, executed assertion failures and failed rules require REVIEW even below 25. Critical deterministic security findings and credential findings under the existing enabled secret policy force advisory BLOCK below 75. No GitHub status check or branch protection is installed; **BLOCK does not prevent merging**.

Coverage/confidence is separate from score: changed-file scope, ignored files, per-probe FULL/PARTIAL/NOT_RUN states, context completeness, deterministic rule execution, test-gap discovery and behavioral execution. Missing evidence is listed explicitly and never creates negative risk points. HIGH confidence means the listed scoped evidence is available, not that a repository is comprehensively secure. The UI renders both v1 and v2 reports and tolerates old jobs without test-gap/behavioral fields.

## Verification and rollout

Unit/integration tests use mocked GitHub/DNS/browser/Prisma boundaries and cover tenant ownership, OIDC bindings, stale commits, destination checks, pinning, redirects, dispatch ambiguity/idempotency, result validation/persistence, timeouts, partial evidence, score thresholds, duplicate/corroborated findings, confirmation UI and legacy data. Run backend and frontend tests/builds, then `npm test --workspace=@aipr/behavioral-runner` after the backend build.

Before enabling production execution, run the installed owner workflow against a disposable, approved public preview containing known passing and failing assertions; exercise a timeout, missing preview and blocked third-party request. Apply the migration in a staging database and test the callback/retention path there. This environment has no running Docker engine or configured owner-CI deployment, so a live container/CI/database smoke test must be recorded separately; automated mocks do not establish it.

References: [GitHub OIDC claims](https://docs.github.com/en/actions/reference/security/oidc), [Playwright routing and service-worker boundaries](https://playwright.dev/docs/api/class-browsercontext).
