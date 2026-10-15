# Review worker isolation and safe custom patterns

The API entry point `dist/index.js` no longer imports the analysis worker or
starts polling/maintenance. Run `dist/worker.js` separately. Production compose
starts one API container and one worker container from the same image, both as
UID 1000, with separate CPU/memory limits. The worker starts after API health
confirms migration/startup. Locally run `npm run dev:backend` and
`npm run dev:worker` in separate terminals.

Workers publish progress on a fixed Redis channel. API instances validate the
message envelope and session revocation, then deliver updates only to the job
owner's connected clients. Redis remains private to the deployment. Progress is
ephemeral; durable job state stays in PostgreSQL and can be reread after reconnect.

Customer-defined deterministic patterns use pinned `re2-wasm` 1.0.2. They are
never evaluated by JavaScript's backtracking regex engine. RE2 does not support
backreferences or lookarounds. Unsupported new rules are rejected; unsupported
legacy/database-written rules are marked SKIPPED rather than PASS. Edit those
patterns to supported [RE2 syntax](https://github.com/google/re2/wiki/Syntax).

Pattern length is capped at 500 characters. Batch matching has a one-second
budget; incomplete checks are SKIPPED and existing findings are retained. This
budget is checked between linear-time matches, not a timer pretending to
interrupt a synchronous JavaScript regex. Broader scanner input/work limits are
handled separately.

Redeploy both services. Starting only the API will leave reviews queued. Stop and
drain the old combined backend before migration so it cannot keep consuming jobs.
The compose file disables the development fallback poller by default; GitHub App
webhooks remain the production trigger. Set `REPO_POLL_ENABLED=true` deliberately
only when fallback polling is needed.

One worker and explicit resource budgets are isolation controls, not a claim of
capacity for thousands of active customers. Large-scale deployment still needs
the staging measurements described in the customer-capacity report.
