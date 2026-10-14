# Login, checkout and server-state checks in disposable owner CI

`OWNER_SANDBOX` is an opt-in alternative to the existing `PUBLIC_PREVIEW` mode.
It builds the exact reviewed application commit, automatically starts a temporary
preview and PostgreSQL database in GitHub-hosted CI, executes approved scenarios,
and removes the environment. It does not deploy a public site or use production
data. The API/review worker dispatches CI and stores bounded outcomes only.

## Application prerequisites

Provide a Dockerfile that starts the application on the configured port and binds
to `0.0.0.0`. Its startup must migrate/initialize the supplied `DATABASE_URL` and
retry database startup if necessary. The runtime filesystem is read-only except
`/tmp`; application images declaring persistent Docker VOLUME mounts are rejected.
Build dependencies may be downloaded during Docker build; runtime app and
database share an internal network without internet egress. No host directories,
Docker socket, CI credentials or production secrets are mounted or forwarded.

The app receives `PORT`, `AIPR_PREVIEW_ORIGIN=https://sandbox.aipr.invalid`,
a fresh PostgreSQL connection URL, `AIPR_SANDBOX=1` and
`PAYMENT_MODE=sandbox`. It must implement its own mock payment adapter. This
release tests the application's sandbox checkout behavior; it cannot access a
third-party payment page, live gateway, OAuth provider or external test gateway.

For authentication, provide a test-only endpoint such as `POST /__aipr/session`.
It receives `{ "fixture": "CUSTOMER", "namespace": "<random UUID>" }`, seeds a
synthetic customer and returns HTTP 200 with one or more session `Set-Cookie`
headers. It must not need a real password. Cookies are held in trusted parent
memory for that scenario and injected into same-origin app requests; the page
and evidence never receive cookie values. JavaScript that requires reading an
authentication token from localStorage or a CSRF cookie needs a different app
test adapter. Session rotation from ordinary page responses is not supported.
Navigate again after `authenticate` to load an authenticated page. This fixture
checks behavior as a logged-in synthetic customer; it does not verify a real
password form, OAuth exchange, or production cookie configuration.

Provide read-only test assertion endpoints, for example `GET /__aipr/state`
returning `{ "orderCount": 1 }` for the current synthetic customer. Assertions
query this endpoint in the trusted parent, independently of DOM text or browser
JavaScript. Endpoints must query the actual disposable database. Keep all fixture
and state endpoints disabled outside explicit sandbox mode. Never connect them to
customer data. A scenario's assertions cover only its named state and commit.

The runnable [checkout fixture](../packages/behavioral-runner/fixtures/checkout/server.cjs)
provides a complete reference. It uses PostgreSQL, seeds a customer, creates an
order with an idempotent customer checkout key, and queries the persisted count.
It is a test application, not a production login implementation.

## Enable and configure

1. Install the updated [owner workflow](behavioral-workflow.example.yml) on the
   application default branch. Configure the existing tooling repository/SHA,
   backend URL and OIDC audience variables. Use a reviewed immutable tooling SHA
   containing this feature. The workflow uses GitHub-hosted runners only, read-only
   checkout credentials with persistence disabled, and no application secrets.
2. In History, open **Owner CI and preview settings**. Paste the following config,
   replace the workflow SHA with the reviewed application default-branch HEAD,
   adapt paths/port to your application, confirm and save. Public preview host,
   publisher and deployment settings are unnecessary in this mode.
3. Select a suggested scenario and enter explicit steps. Confirm and run in owner
   CI. A deployment ID is unnecessary: CI creates the disposable preview itself.
4. Refresh execution results. Setup errors, disallowed requests or incomplete
   execution never establish PASS. Update both tooling SHA and the application's
   reviewed workflow pin when changing the installed workflow/tooling.

```json
{
  "enabled": true,
  "workflowSha": "REPLACE_WITH_REVIEWED_40_CHARACTER_SHA",
  "execution": {
    "mode": "OWNER_SANDBOX",
    "sandbox": {
      "dockerfile": "Dockerfile",
      "port": 3000,
      "readyPath": "/",
      "sessionPath": "/__aipr/session",
      "mutations": [{ "method": "POST", "path": "/orders" }],
      "assertions": ["/__aipr/state"]
    }
  }
}
```

The backend freezes this execution policy with the run plan. CI's authenticated
prepare step supplies only the authorized repository and exact reviewed SHA to
the application checkout. Changing the execution mode or sandbox settings revokes
claims/results for the old policy. Existing dispatch request keys are never
redispatched automatically, including when the GitHub response is lost.

## Example: exactly one order after duplicate checkout

Use the application's real `data-testid` values and test endpoint paths:

```json
[
  { "action": "navigate", "path": "/" },
  { "action": "authenticate", "fixture": "CUSTOMER" },
  { "action": "navigate", "path": "/" },
  { "action": "click", "testId": "checkout" },
  { "action": "assertText", "testId": "result", "text": "Order created" },
  { "action": "click", "testId": "checkout" },
  { "action": "assertText", "testId": "result", "text": "Order created" },
  { "action": "assertJson", "path": "/__aipr/state", "pointer": "/orderCount", "equals": 1 }
]
```

`assertJson` supports simple JSON pointers such as `/orders/count`, with a string,
finite number, boolean or null expected value. An absent field fails, including
when expected is null. HTTP errors, invalid/oversized JSON and transport problems
produce ERROR. Only expected comparisons return PASSED/FAILED; observed response
values, cookies, screenshots, application logs and raw exceptions are not retained.

Mutation allowlists are exact method/path pairs (up to 20), supporting POST, PUT,
PATCH and DELETE with JSON or URL-encoded bodies up to 16 KB. Query-bearing writes,
multipart uploads, arbitrary headers and unapproved writes are blocked. Ordinary
page requests cannot access the session/state control endpoints. GET resources
remain same-origin; third-party assets, redirects to other origins, WebSockets,
workers, frames and downloads remain unavailable. A blocked request prevents PASS.

The browser still runs in a network-disabled Docker container. A separate trusted
relay joins the internal app network and publishes one loopback port; it forwards
only to the fixed internal application and has no arbitrary upstream or credentials.
The app/database have no external network or published ports. Only the trusted
parent maps the synthetic browser origin to the relay port it provisioned; a
page cannot choose a local host/port. Each scenario has a separate session and
fixture UUID. The database is disposable per run, not per scenario: the application
must scope fixture data by the synthetic customer/namespace.

## Limits, cleanup and verification

Scenario/browser/network limits from [behavioral verification](behavioral-verification.md)
still apply. Sandbox runs have a 30-minute backend deadline and the example CI job
has a 25-minute timeout. Builds have a ten-minute subprocess limit. App and browser
containers each have 1 CPU, 1 GB RAM and 128 processes; PostgreSQL has 512 MB RAM,
1 CPU and temporary 256 MB database storage. The trusted relay has 128 MB RAM,
0.25 CPU and 32 processes, with a read-only filesystem and an unprivileged user. Readiness waits are bounded. All
containers drop capabilities; app/browser filesystems are read-only with temporary
storage. The application needs to work within these limits.

The executor's `finally` removes only its random app/database/relay/network/image names.
A private cleanup manifest lets the final `always()` workflow step repeat cleanup
after interruption; GitHub-hosted VM disposal is the final boundary on hard job
termination. No broad Docker prune occurs. Seven-day plan/evidence retention and
existing job/repository cascade deletion remain unchanged. No Prisma migration is
needed: version 2 policy snapshots use the existing plan JSON column; legacy array
plans continue as public, read-only previews.

Run automated checks from the repository root:

```sh
npm run build --workspace=apps/backend
npm test --workspace=@aipr/behavioral-runner
docker build -t aipr-behavioral:local -f packages/behavioral-runner/Dockerfile .
npm run test:smoke --workspace=@aipr/behavioral-runner
```

The smoke test builds the reference app, uses real PostgreSQL and Chromium,
authenticates, submits duplicate checkout, verifies one persisted order, verifies
a deliberate failing count assertion, and cleans up. A diagnostic fallback,
`node packages/behavioral-runner/sandbox-smoke.cjs --host-browser`, accepts
`AIPR_SMOKE_BROWSER` as an installed browser executable path. It exercises real
app/database/browser behavior but **does not validate Docker browser isolation**.
Production execution always uses the network-disabled browser container.

Implementation validation: 1,310 backend tests and 207 frontend tests passed,
along with both production builds and scoped frontend lint. The runner suite has
18 passing tests, including real HTTP session/mutation/assertion checks. It also
passed with an installed host Chromium, covering passing, deliberately failing,
and unauthenticated scenarios. A real disposable Docker app, trusted relay and
PostgreSQL diagnostic verified one persisted order after duplicate checkout and
a deliberate count failure, followed by cleanup. That diagnostic used cached
Node 20/PostgreSQL 15 system files and host Chromium because fresh image downloads
were too slow. It does not establish the complete production Node 22/PostgreSQL
16/browser-container path. Run the full smoke command and installed GitHub workflow
before production enablement; no live payment gateway or production data was used.

References: [Docker internal networks](https://docs.docker.com/reference/cli/docker/network/create/),
[loopback port publishing](https://docs.docker.com/engine/network/port-publishing/),
[GitHub workflow security](https://docs.github.com/en/actions/reference/security/secure-use).
