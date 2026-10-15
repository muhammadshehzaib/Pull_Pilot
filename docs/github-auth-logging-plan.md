# Keep GitHub authentication credentials out of server logs

## Confirmed problem

The OAuth callback passes the complete caught error to `console.error`. Axios
errors can include the token-exchange request body (`client_secret` and OAuth
code), the profile request's bearer token, response bodies, and nested request
objects. The GitHub App linking catch does the same, and installation-token
exchange logs an upstream body/message. Morgan's default access format also
prints callback query strings containing OAuth codes and state.

## Implementation plan

1. Add a small error-metadata helper that constructs a fresh allowlisted object:
   an integer HTTP status in 100–599 and a recognized transport/HTTP error code.
   Exclude arbitrary messages, stacks, URLs, request/response bodies, headers,
   causes, and unknown fields. Never serialize the original error.
2. Replace full-error logging in the OAuth callback, GitHub App linking, and
   installation-token exchange. Use fixed event messages and explicit OAuth
   stages (token exchange, profile fetch, user save, session issue). Keep client
   error responses generic and preserve the existing success/failure behavior.
3. Configure access logging to record the request path without query strings.
   Keep the method, response status, response time, and response size for useful
   diagnostics. Do not log request bodies, cookies, or authorization headers.
4. Add regression tests with fake credentials embedded in Axios-style request
   config, headers, bodies, messages, stacks, response data, and nested causes.
   Cover token/profile/database/session failures, installation linking and token
   failures, malformed metadata, and real access-logger output for callback URLs.
   Verify safe diagnostics remain and no session cookie/redirect occurs on login
   failure. First reproduce the current leaks before applying the fix.
5. Run focused auth/logger/GitHub App tests and the TypeScript check; inspect the
   final diff. Commit only this change and push it to the current GitHub branch.

## Acceptance criteria and limits

- The affected error logs contain only fixed labels/stages and validated metadata.
- Client secrets, GitHub tokens, OAuth codes/state, and arbitrary upstream text
  from the regression fixtures appear in neither logs nor failure responses.
- Login successes, OAuth state checks, cookie handling, and generic failures keep
  their current behavior. Access logs retain useful timing/status information.
- The change prevents future leaks from these paths. It does not scrub existing
  logs or change credentials. If historical logs exposed real credentials, rotate
  those credentials and handle retained log copies through the deployment owner.

## Validation

- Regression tests reproduced credential leakage before the implementation.
- All 74 focused authentication, GitHub App, safe-metadata, and access-logger
  tests pass after the fix, including real local HTTP requests for access logs.
- Backend TypeScript validation (`tsc --noEmit`) passes.
