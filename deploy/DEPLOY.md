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
   bot PAT, so third-party repos fail with 404. See step 1b.
4. If ports 8090/8091 are taken on the VPS (`ss -tlnp | grep -E '8090|8091'`),
   change them in `docker-compose.prod.yml` AND the two nginx confs.

## 1. Clone and configure

```bash
ssh root@109.123.244.167
git clone https://github.com/muhammadshehzaib/ai-pr-reviewer.git /opt/ai-pr-reviewer
cd /opt/ai-pr-reviewer
cp .env.prod.example .env.prod
# fill in: POSTGRES_PASSWORD + ENCRYPTION_KEY + JWT_SECRET (openssl rand -hex 32 each),
# prod OAuth app client id/secret, GITHUB_APP_ID, bot PAT, random GITHUB_WEBHOOK_SECRET
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
```

`docker-compose.prod.yml` maps it to `/run/secrets/github-app.pem` read-only, and
`GITHUB_APP_PRIVATE_KEY_PATH` is already set to that path in the compose file, so
there is nothing to add to `.env.prod` for the key itself — only `GITHUB_APP_ID`.

Verify the mount landed:

```bash
docker exec aipr-backend ls -l /run/secrets/
```

On boot the backend logs which mode is active. This is the line to check:

- `🔐 GitHub auth: App mode (App ID ...)` — correct, multi-tenant
- `⚠️  GitHub auth: PAT fallback` — the key is missing or unreadable; check step 1b

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

```bash
cd /opt/ai-pr-reviewer && git pull
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

## Notes

- The backend container runs API + BullMQ worker + repo poller in one process.
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
