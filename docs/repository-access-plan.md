# Verify GitHub repository access

## Problem and security rule

Manual repository registration currently treats the server token's ability to
read a repository as permission for the signed-in user to connect it. Database
ownership then permits that user to request and read reviews. Database ownership
alone must never establish permission to read private GitHub code.

Before connecting/reconnecting, processing a review, or returning repository
review content, verify access against GitHub for the authenticated user's stable
GitHub account ID. Never accept a username or account ID from the request body.
Do not use the server token's repository `permissions` field as user permission.

## Implementation

1. Add a shared GitHub access check. Read fresh repository metadata, resolve the
   user's current login from their numeric account ID, and ask GitHub for that
   user's effective repository permission. Require `read`, `write`, or `admin`
   for private repositories. GitHub maps triage/maintain and team/organization
   grants to these base permissions. Bind the permission response to the same
   numeric account ID. Public repositories remain readable without membership.
2. Fail closed on absent/invalid identity, unknown visibility, missing/revoked
   permissions, identity/repository-ID mismatches, or unavailable GitHub checks.
   Return sanitized denial/unavailable messages, never raw upstream errors or
   credentials. Bound network calls with timeouts and worker cancellation.
3. Authorize registration before creating webhooks or saving ownership. Validate
   `owner/repo` strictly. Reconnects must pass the same check. Keep the existing
   cross-account ownership conflict protection.
4. Add ownership-scoped route guards to repository details/insights/rules, review
   details/findings, behavioral settings, and generated test drafts. This prevents
   old unauthorized connections from exposing saved review content. For a
   repository recorded as private, still require membership if it later becomes
   public, because saved review content may describe its earlier private state.
   Listing endpoints return metadata/counts, not review bodies.
5. Recheck in the worker before fetching source or resuming saved comment
   delivery. Resolve the repository and GitHub identity from persisted ownership,
   not queue-supplied installation/account fields. Cover old queued jobs and
   automatic webhook/polling paths as well as manual triggers.
6. Add regression tests for strangers, read-only collaborators, owners/team roles,
   renamed accounts, forged/mismatched identity, public repositories, changed
   visibility, reconnects, GitHub failures, guarded historical results/drafts,
   and worker denial before any source/AI/comment operation. Run relevant tests,
   the backend test suite, and the backend TypeScript build.

## Rollout and limits

No database migration or new OAuth scope/token storage is required. Deploy the
API and workers together, restarting old workers. Server credentials must support
GitHub's repository-permission lookup (Metadata read for GitHub App/fine-grained
tokens); inability to verify denies access. Permission
results are not cached, so revocations are checked on each protected operation.
GitHub calls add latency and rate-limit usage; outages temporarily prevent access.
Authorization is a point-in-time check, not an atomic lock with GitHub permissions.
Previously downloaded/leaked content cannot be recalled. No saved user data is
deleted by this fix; administrators should separately investigate any suspected
past unauthorized connections.

The permission lookup follows GitHub's effective base roles, including repository,
team, organization, and enterprise grants. OAuth login remains `read:user
user:email`: the server asks GitHub about the specific authenticated account's
permission, rather than retaining a user's OAuth token or inspecting the server
credential's own repository permissions.

References:
- https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user
- Installed Octokit `users.getById` and `repos.getCollaboratorPermissionLevel` APIs.

## Validation results

Implementation complete.

- `npm.cmd run test --workspace=backend`: 90 test files passed; 1,410 tests
  passed. Five existing PostgreSQL integration suites (62 tests) were skipped
  because their dedicated test database URLs are not configured.
- `npm.cmd run build --workspace=backend`: passed.
- `git diff --check`: passed.
- HTTP regression coverage verifies denial/allow behavior across 22 protected
  routes, anonymous denial, sanitized upstream failures, and disconnect after
  revocation. Service/controller/worker tests cover identity binding, role grants,
  public access, old private snapshots, reconnection, no cached grants, repository
  replacement, rate limits, and denial before source/AI/comment delivery.
- GitHub responses and database boundaries are mocked; no live private-repository
  request or production deployment was performed.
