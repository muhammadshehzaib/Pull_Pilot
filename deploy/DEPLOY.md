# Deploy to the Contabo VPS

Topology (same pattern as the other apps on this VPS): Docker containers bound to
`127.0.0.1`, fronted by the host Nginx on two subdomains with certbot TLS.

- `reviewer.shehzaib.com`    → web (127.0.0.1:8091)
- `reviewerapi.shehzaib.com` → API + Socket.IO + GitHub webhooks (127.0.0.1:8090)

## 0. One-time prerequisites

1. **DNS**: two A records → `109.123.244.167`: `reviewer` and `reviewerapi`.
2. **GitHub OAuth App** for production (an OAuth app has ONE callback URL, so keep
   the local one separate). Create at github.com/settings/developers with callback:
   `https://reviewerapi.shehzaib.com/api/auth/github/callback`
3. **GitHub App** (optional but recommended). Without it every review runs as the
   bot PAT, so third-party repos fail with 404. Set the App's **Setup URL** to
   `https://reviewerapi.shehzaib.com/api/auth/github-app/callback` and set
   `GITHUB_APP_SLUG` to the App's URL slug. Users must sign in before installing
   the App so its one-time state can link the installation to their account.
   See step 1b.
4. If ports 8090/8091 are taken on the VPS (`ss -tlnp | grep -E '8090|8091'`),
   change them in `docker-compose.prod.yml` AND the two nginx confs.

## 1. Clone and configure

```bash
ssh root@109.123.244.167
git clone https://github.com/muhammadshehzaib/ai-pr-reviewer.git /opt/ai-pr-reviewer
cd /opt/ai-pr-reviewer
cp .env.prod.example .env.prod
# fill in: POSTGRES_PASSWORD + ENCRYPTION_KEY + JWT_SECRET (openssl rand -hex 32 each),
# prod OAuth app client id/secret, GITHUB_APP_ID/GITHUB_APP_SLUG, bot PAT, random GITHUB_WEBHOOK_SECRET,
# and the Polar token/secret/product ids (see step 1c)
nano .env.prod
```

## 1b. GitHub App private key

The backend runs inside a container and cannot see files on the VPS host, so the
key is mounted in explicitly. `secrets/` is gitignored, so `git pull` leaves it alone.

```bash
mkdir -p secrets && chmod 700 secrets
# scp the .pem from your machine, or paste its contents:
nano secrets/github-app.pem      # then Ctrl-D
chmod 600 secrets/github-app.pem
chown 1000:1000 secrets/github-app.pem
```

`docker-compose.prod.yml` maps it to `/run/secrets/github-app.pem` read-only, and
`GITHUB_APP_PRIVATE_KEY_PATH` is already set to that path in the compose file, so
there is nothing to add to `.env.prod` for the key itself — only `GITHUB_APP_ID`.

The backend now runs as the image's `node` user (UID/GID 1000), including database
migrations. The mounted key must be readable by that UID, not world-readable.
After deployment, verify `docker exec aipr-backend id -u` prints `1000` and
`docker exec aipr-backend test -r /run/secrets/github-app.pem` succeeds. Never fix
permissions by reverting the backend to root.

Verify the mount landed:

```bash
docker exec aipr-backend ls -l /run/secrets/
```

On boot the backend logs which mode is active. This is the line to check:

- `🔐 GitHub auth: App mode (App ID ...)` — correct, multi-tenant
- `⚠️  GitHub auth: PAT fallback` — the key is missing or unreadable; check step 1b

## 1c. Polar billing setup

Billing runs through Polar as merchant of record. Do this once, before the first
paid user, and again whenever a price changes.

1. In the Polar dashboard, create four **products** (one per tier per cycle) with
   these prices: Indie `$2/month`, Indie `$10/year`, Team `$5/month`,
   Team `$50/year`. Copy each product id.
2. Add to `.env.prod`:
   - `POLAR_ACCESS_TOKEN` — Polar → Settings → Developers → Access tokens
     (organization token with Checkouts write + webhooks).
   - `POLAR_WEBHOOK_SECRET` — created in the next step.
   - `POLAR_PRODUCT_INDIE_MONTHLY`, `POLAR_PRODUCT_INDIE_YEARLY`,
     `POLAR_PRODUCT_TEAM_MONTHLY`, `POLAR_PRODUCT_TEAM_YEARLY` — the product ids.
   - leave `POLAR_SANDBOX=false`.
3. In Polar → Settings → Webhooks, add endpoint
   `https://reviewerapi.shehzaib.com/api/billing/webhook` and subscribe to the
   `subscription.*` events. Copy the signing secret into `POLAR_WEBHOOK_SECRET`.
4. Redeploy (step 2), then verify checkout end-to-end with a real card in
   sandbox first (`POLAR_SANDBOX=true`) before switching it to production.

Anything Polar fails to deliver is retried by Polar; the handler returns 500 on a
persistence error and 202 on success so retries stop once the row is written.

## 2. Build and start

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
# backend runs `prisma migrate deploy` automatically on boot
curl -s http://127.0.0.1:8090/health   # {"status":"UP",...}
curl -sI http://127.0.0.1:8091 | head -1
```

Confirm both stores are persistent:

```bash
docker volume ls | grep aipr        # aipr_aipr_pgdata and aipr_redisdata
docker exec aipr-redis redis-cli config get appendonly   # expect: appendonly yes
```

## 3. Nginx + TLS

```bash
cp deploy/nginx/reviewer.shehzaib.com.conf /etc/nginx/sites-available/reviewer.shehzaib.com
cp deploy/nginx/reviewerapi.shehzaib.com.conf /etc/nginx/sites-available/reviewerapi.shehzaib.com
ln -s /etc/nginx/sites-available/reviewer.shehzaib.com /etc/nginx/sites-enabled/
ln -s /etc/nginx/sites-available/reviewerapi.shehzaib.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d reviewer.shehzaib.com -d reviewerapi.shehzaib.com
```

## 4. Smoke test

1. `https://reviewer.shehzaib.com` → log in with GitHub (prod OAuth app).
2. Vault page → save the AI key (Groq key goes under provider **GROK**).
3. Connect a repo you own → webhook installs for real here (public URL), so
   pushes and PRs auto-review via webhook. Third-party repos still work via the
   poller (PRs you author).
4. Check `docker logs -f aipr-backend` while pushing a commit.

## Update to a new version

The unchanged-caller context update adds migration
`20261020000000_context_import_index`. Apply it before the updated backend starts
(the production container already runs `prisma migrate deploy`). Deploy frontend
and backend together to expose discovery coverage in History. New optional
`CONTEXT_INDEX_*` limits are listed in `.env.prod.example`; see
[context discovery](../docs/context-discovery.md) for limits and validation.

```bash
cd /opt/ai-pr-reviewer && git pull
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

## Notes

The comment-delivery update adds migration `20261021000000_comment_delivery`.
Stop/drain the old backend before rebuilding so old and new posting workers do
not overlap. Keep both database and Redis volumes. The production image generates
Prisma and runs `prisma migrate deploy` before startup. Deploy the frontend with
the backend to show delivery status and the read-only GitHub reconciliation action.
Existing unfinished PR jobs are marked legacy/untracked and skipped; start a new
manual review when needed. Roll back by pausing delivery rather than restarting
an old worker that bypasses tracking. See [comment delivery](../docs/comment-delivery.md)
for recovery, retention, and test-PR verification.

- API and BullMQ worker now run in separate containers. Deploy both `backend`
  and `worker`; the API alone does not consume reviews. See
  [worker isolation](../docs/worker-isolation.md) for local commands, progress
  transport, resource budgets, and the RE2 pattern compatibility change.
- Webhook signature verification is HMAC over the raw body; NODE_ENV=production
  fails closed if GITHUB_WEBHOOK_SECRET is unset.
- Losing ENCRYPTION_KEY makes saved vault keys unrecoverable (users re-save).
- Postgres data persists in the `aipr_pgdata` volume; it is never exposed publicly.
- The BullMQ queue persists in `aipr_redisdata` with `appendonly yes`. If a job is
  ever lost, the matching Postgres row stays QUEUED with no reaper to retry it —
  re-trigger the review from the UI rather than restarting the backend.
- Failed jobs are retained for `JOB_RETENTION_DAYS` (default 7) in both Redis and
  Postgres, then removed by the sweep that runs every `JOB_SWEEP_INTERVAL_MS`.
  Completed jobs are never swept — they are the review history. Raising
  `JOB_RETENTION_DAYS` keeps failure diagnostics for longer at the cost of disk.
- `secrets/github-app.pem` lives only on the VPS. Back it up separately — if it is
  lost, generate a new key in the App settings and repeat step 1b.
