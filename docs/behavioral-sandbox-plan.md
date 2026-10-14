# Authenticated and state-changing behavioral verification

Status: implemented. See [setup and shipped behavior](behavioral-sandbox.md).
Automated validation and a real Docker app/database plus host-browser diagnostic
passed. Full browser-container and installed GitHub owner-CI smoke tests remain
deployment validation steps; image downloads prevented the full local container
smoke. Existing application repositories need their Dockerfile/test adapters and
the updated, reviewed workflow before enabling this mode.

## Intended result

Keep the existing public, read-only preview checker. Add an explicitly selected
`OWNER_SANDBOX` executor that builds the reviewed commit in GitHub-hosted owner CI,
starts a disposable application and PostgreSQL database, runs approved browser
steps, verifies application state, and destroys the environment. No production
deployment or customer account is needed.

For example: seed a synthetic customer, open checkout, submit twice, and assert
that an application test endpoint returns `orderCount: 1`. A visible success page
alone must not establish that the order was created correctly.

## 1. Owner configuration and immutable authority

- Add a backwards-compatible execution mode to owner-confirmed repository settings.
- Sandbox settings specify a relative Dockerfile, application port, readiness
  path, optional synthetic-session path, exact allowed mutation methods/paths,
  and exact readable assertion endpoints. No shell, credentials or arbitrary URLs.
- Freeze configuration alongside the existing plan in each run; revoke CI access
  when settings change. Retain workflow SHA, OIDC, repository identity, reviewed
  commit, idempotent dispatch, ownership and resource limits.
- Existing public-preview runs retain their original network restrictions.

## 2. Automatic disposable preview

- Extend the trusted workflow with an authenticated prepare step. Only its
  backend-authorized commit may be checked out into a separate application folder.
- Build using Docker, without host secrets, checkout credentials, host mounts or
  a Docker socket in the application. Do not execute application scripts on host.
- Start a fresh internal Docker network, temporary PostgreSQL, and bounded app
  container. Give the application only disposable database credentials and
  `AIPR_SANDBOX=1` / `PAYMENT_MODE=sandbox`.
- Add a bounded trusted relay with a fixed internal application upstream, and
  publish only that relay on a random loopback port for the trusted parent fetcher.
  Browser requests use a synthetic HTTPS origin and cannot choose a local target.
- Readiness and build failures produce ERROR, never PASS. Always remove exact
  task-owned containers, network and image, including failed startup. A final
  workflow cleanup covers process termination. Allow 30 minutes for claim/build.

## 3. Synthetic authentication and controlled mutations

- Add `authenticate` using a fixed synthetic fixture. An owner-approved test
  endpoint creates/seeds a test-only user and returns a session cookie.
- Keep the cookie in the trusted fetcher, scoped to one scenario; never persist
  or emit credentials. Each scenario gets a new fixture namespace.
- Forward only approved same-origin POST/PUT/PATCH/DELETE paths, bounded request
  bodies and content types. Browser headers cannot select credentials or origins.
- Support same-origin HTML form submissions in this mode; continue blocking
  external resources, frames, workers, downloads and WebSockets.
- Sandbox payments must be application-provided simulated payments; real payment
  gateways and live credentials remain unavailable on the internal network.

## 4. Server-state assertions

- Add `assertJson` with an approved GET path, bounded JSON pointer and primitive
  expected value. Execute in the trusted parent, not page JavaScript.
- Return only pass/fail/error to the browser and backend; never retain response
  bodies or observed values. Authentication and assertion control endpoints are
  not available to ordinary page resource requests.
- Require a real assertion, preserve existing evidence validation and score rules.

## 5. Product, documentation and compatibility

- Explain mode selection, automatic preview, synthetic sessions, mutations and
  server assertions in the existing owner settings and scenario editor.
- Document application prerequisites: Dockerfile starts/migrates the app against
  supplied DATABASE_URL; test-only session/state endpoints; mock payment adapter.
- Include a small runnable checkout fixture showing duplicate submission and an
  independently queried order count. Do not invent endpoints for arbitrary apps.
- No database migration: snapshot mode/settings in the existing plan JSON.

## 6. Acceptance and validation

- Validate malformed configuration/actions, endpoint allowlists, frozen settings,
  disabled/revoked config, legacy public mode, stale SHA, and dispatch identity.
- Exercise authentication, mutations, state assertions, duplicate checkout,
  failed assertions, response limits, redirect blocking and credential isolation.
- Verify Docker arguments, checkout identity, readiness errors and unconditional
  cleanup. Run runner tests, backend/frontend suites and both production builds.
- Run a real disposable Docker/browser smoke test when Docker is available;
  clearly record if it cannot run. Live owner-CI enablement requires the repository
  owner to install/pin the workflow and adapt the application fixture endpoints.

References: [Docker internal networks](https://docs.docker.com/reference/cli/docker/network/create/),
[loopback publishing](https://docs.docker.com/engine/network/port-publishing/),
[GitHub workflow security](https://docs.github.com/en/actions/reference/security/secure-use).
