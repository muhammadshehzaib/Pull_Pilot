# AI PR Reviewer

An AI-powered GitHub Pull Request reviewer. Connect a repo, drop in an AI API key, and every PR (or push) gets reviewed automatically — with inline comments posted back to GitHub and a real-time dashboard streaming progress.

Supports **OpenAI**, **Google Gemini**, **Anthropic Claude**, and **xAI Grok** out of the box.

<p align="center">
  <a href="https://REPLACE-WITH-YOUR-VPS-URL"><img src="https://img.shields.io/badge/Live%20Demo-Visit-2ea44f?style=for-the-badge&logo=vercel&logoColor=white" alt="Live Demo"></a>
  <a href="https://github.com/muhammadshehzaib/ai-pr-reviewer"><img src="https://img.shields.io/badge/Source-GitHub-181717?style=for-the-badge&logo=github&logoColor=white" alt="GitHub"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Next.js%2016-000000?logo=nextdotjs&logoColor=white" alt="Next.js 16">
  <img src="https://img.shields.io/badge/Express%205-000000?logo=express&logoColor=white" alt="Express 5">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Prisma-2D3748?logo=prisma&logoColor=white" alt="Prisma">
  <img src="https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/Redis-DC382D?logo=redis&logoColor=white" alt="Redis">
  <img src="https://img.shields.io/badge/Socket.IO-010101?logo=socketdotio&logoColor=white" alt="Socket.IO">
</p>

> 📸 **Add a screenshot of the live dashboard / an example PR review here.** Drop an image at `docs/screenshot.png` and uncomment the block below.
<!--
<p align="center">
  <img src="docs/screenshot.png" alt="AI PR Reviewer dashboard" width="850">
</p>
-->

---

## Features

- **Auto-review on every PR / push** — registers a webhook on your repo, queues a job, and posts inline review comments back to GitHub
- **Repository context beyond the diff** ? indexes imports from eligible changed and unchanged JS/TS files to find dependencies, incoming importers, and related tests. Discovery and prompt limits are separate; partial coverage is disclosed. See [context discovery](docs/context-discovery.md).
- **Repository rules via `.aipr.yml`** — define engineering guidelines ("Never log secrets", "All public functions need explicit return types") and severity thresholds; the reviewer enforces them on every PR and quotes the broken rule in the finding
- **Multi-provider AI** — pick OpenAI, Gemini, Claude, or Grok per user; switch any time
- **Encrypted key vault** — your AI API key is stored AES-256-GCM encrypted; the plaintext only exists in memory during a job
- **GitHub OAuth login** — sign in with GitHub, no passwords
- **CSRF-protected GitHub OAuth** — validates a one-time OAuth `state` value before establishing a session
- **User-linked GitHub App installations** — installation claims are tied to the authenticated GitHub user and verified against GitHub's signed installation webhook before repositories are linked
- **Per-user repo management** — repositories are scoped to their owner and GitHub repository ID; webhook routing refuses ambiguous ownership instead of crossing tenants
- **Manual review trigger** — fire off a review for any PR on demand from the dashboard
- **Live dashboard** — Socket.IO streams every step (`fetching diff → building context → AI dispatching → posting comments`) in real time
- **GitHub App Integration (Pull Pilot)** — 1-click installation across individual repositories or entire organizations with automated PR & push webhooks
- **Review lifecycle and retries** — persisted progress states, cancellation and timeout handling, and a distinct retrying state for transient failures
- **Webhook idempotency** — review identity includes the repository, event/reference, and commit SHA so duplicate deliveries do not enqueue duplicate reviews
- **Quota reservations** — review paths reserve usage atomically when accepted, including manual, webhook, and polling-triggered reviews
- **Background processing** — BullMQ + Redis with retries, exponential backoff, and bounded concurrency

---

## Architecture

Review comment delivery now uses encrypted saved plans, per-comment receipts, and GitHub recovery markers. Retries reuse the original review and confirmed comments; ambiguous sends are reconciled without automatically posting them again. History shows delivery status and supports checking existing comments. Apply the comment-delivery migration and stop old workers before cutover; see [behavior, recovery, deployment, and limits](docs/comment-delivery.md).

Engineering Health (Phase 10) adds tenant-scoped metric cards, 7/30/90-day UTC reporting, daily/weekly risk trends, repository breakdowns, and supporting-review drilldowns while preserving the live feed and usage meter. Completion-time numeric snapshots are immutable and idempotent. Missing evidence and approximate legacy dates are disclosed rather than counted as passing scans. Fix counts are developer-reported, not independently verified prevention; risk trends are not claims of overall code-quality improvement. Apply the engineering-health migration before deploying the new API/worker; see [metric definitions, deployment, backfill, limits, and tests](docs/engineering-health.md).

Behavioral verification (Phase 6) supports owner-approved scenarios in repository-owner CI with a network-disabled browser container. Public mode uses an existing trusted preview; the opt-in [sandbox executor](docs/behavioral-sandbox.md) automatically builds a disposable preview/database and supports synthetic login, approved data changes, mock checkout and server-state assertions. Explainable PR risk (Phase 7) adds a versioned advisory score, per-signal explanations and separate evidence coverage/confidence. Existing reports remain compatible. Enabling execution requires an owner-installed workflow, GitHub App permissions, OIDC configuration and the database migration; see [setup, limits and verification](docs/behavioral-verification.md).

Historical intelligence (Phase 8) adds explicit finding feedback, recurring cross-PR patterns, and opt-in repository memory. History now exposes feedback and insights, with durable finding snapshots, concurrent-edit protection, bounded retention, and untrusted historical context separated from owner rules. Apply the historical integrity migration before deploying; see [setup, safety boundaries, and tests](docs/historical-intelligence.md). Historical context is not independent verification or demonstrated improvement in review accuracy.

The developer feedback loop (Phase 9) adds Helpful / Not useful, independent dismissal and reported-fix workflows, confirmed finding-to-rule conversion, and opt-in explainable presentation adaptation. Original findings, severity, security evidence, and risk scores remain unchanged. Apply the developer-feedback-loop migration and deploy the updated rule editor/API together; see [deployment, behavior, safety, and verification](docs/developer-feedback-loop.md).

```
┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
│   Next.js Web    │◄──────│  Express API     │──────►│   PostgreSQL     │
│   (dashboard)    │ HTTP  │  (auth, vault,   │       │   (Prisma)       │
│                  │       │   repos, hooks)  │       └──────────────────┘
└────────┬─────────┘       └────────┬─────────┘
         │                          │
         │  Socket.IO               │ enqueue
         │  (job updates)           ▼
         │                 ┌──────────────────┐       ┌──────────────────┐
         └─────────────────│   BullMQ Queue   │◄──────│   Redis          │
                           └────────┬─────────┘       └──────────────────┘
                                    │ dequeue
                                    ▼
                           ┌──────────────────┐
                           │ Analysis Worker  │──────► GitHub (fetch diff,
                           │                  │        repo tree, post review)
                           │ ├ context engine │──────► AI Provider
                           │ │ (import graph, │        (OpenAI/Gemini/Claude/Grok)
                           │ │  related files)│
                           └──────────────────┘
```

### How a review runs

1. GitHub webhook (or manual trigger) enqueues a job
2. Worker fetches the PR diff and filters it through your `ignore` globs
3. **Context engine**: reads the exact commit tree, reuses encrypted parsed imports, and indexes missing eligible source files within deployment limits. It selects incoming importers, dependencies, and related tests before loading their contents under the prompt file/token budgets.
4. Diff + related context + your `.aipr.yml` guidelines are sent to the configured AI provider
5. Findings are deduped, severity-filtered, and posted as inline PR comments + a summary comment
6. Results are persisted and streamed to the dashboard over Socket.IO

### Review lifecycle

Each accepted review is persisted through the worker lifecycle:

```text
QUEUED → FETCHING → ANALYZING → GENERATING → POSTING → COMPLETED
                         │             │           │
                         └──── transient failure ──→ RETRYING → FETCHING
```

`FAILED` is used when attempts are exhausted. `CANCELLED` and `TIMEOUT` represent reviews stopped by a user or by the configured review timeout; `SKIPPED` is used when a review cannot or should not proceed (for example, a quota or eligibility check). Retries keep the job non-terminal while another attempt is scheduled.

Webhook-triggered reviews are deduplicated by repository, event type, reference, and commit SHA. Usage is reserved atomically when a review is accepted, rather than charged again when the worker completes it. Installation ownership is established through the authenticated GitHub App setup flow and checked against the signed installation webhook before repository access is linked.

### Stack

- **Backend:** Node.js, Express 5, TypeScript, Prisma, PostgreSQL, Redis, BullMQ, Socket.IO, Octokit
- **Frontend:** Next.js 16, React 19, Framer Motion, Lucide icons, socket.io-client
- **AI SDKs:** `openai`, `@google/generative-ai`, `@anthropic-ai/sdk`, xAI via OpenAI-compatible API
- **Auth:** GitHub OAuth + JWT (httpOnly cookies)
- **Crypto:** AES-256-GCM for vault encryption (Node `crypto`)

---

## Getting Started

### Prerequisites

- Node.js 20+
- Docker (for Postgres + Redis)
- A GitHub OAuth App ([create one](https://github.com/settings/developers))
- A GitHub Personal Access Token with `repo` + `admin:repo_hook` scopes (the bot account used to register webhooks and post review comments)
- An AI API key (OpenAI, Gemini, Claude, or Grok)

### 1. Clone and install

```bash
git clone https://github.com/muhammadshehzaib/ai-pr-reviewer.git
cd ai-pr-reviewer
npm install
```

### 2. Start Postgres + Redis

```bash
docker compose up -d
```

This starts:

- Postgres on `localhost:5432` (db: `ai_reviewer_db`, user: `reviewer_user`)
- Redis on `localhost:6379`

### 3. Configure environment

```bash
cp apps/backend/.env.example apps/backend/.env
cp apps/web/.env.example apps/web/.env.local
```

Fill in `apps/backend/.env`:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Pre-filled to match docker-compose |
| `REDIS_HOST` / `REDIS_PORT` | yes | Defaults are fine |
| `ENCRYPTION_KEY` | yes | 32+ char random string for vault crypto |
| `JWT_SECRET` | yes | Random string for signing auth cookies |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | yes | From your GitHub OAuth App |
| `GITHUB_ACCESS_TOKEN` | yes | Bot PAT used to install webhooks and comment |
| `GITHUB_WEBHOOK_SECRET` | yes | Shared secret for HMAC verification of inbound webhooks |
| `BACKEND_URL` / `FRONTEND_URL` | yes | `http://localhost:4000` / `http://localhost:3000` |
| `CLAUDE_MODEL`, `GROK_MODEL`, `GROK_BASE_URL` | no | Override defaults |
| `CONTEXT_MAX_HOPS` / `CONTEXT_MAX_FILES` / `CONTEXT_MAX_TOKENS` | no | Platform ceilings for the context engine (defaults: `2` / `25` / `30000`) |
| `CONTEXT_RETENTION_HOURS` | no | How long cached repo files are kept; `0` = keep until disconnect (default) |

When creating the GitHub OAuth App, set the **Authorization callback URL** to:

```
http://localhost:4000/api/auth/github/callback
```

### 4. Initialize the database

```bash
npm run -w apps/backend prisma:generate
npm run -w apps/backend prisma:migrate
```

### 5. Run the apps

In two separate terminals:

```bash
npm run dev:backend     # API on http://localhost:4000
npm run dev:web         # Web on http://localhost:3000
```

### 6. Try it

1. Visit `http://localhost:4000/api/auth/github` → log in with GitHub
2. Save your AI API key:
   ```bash
   curl -X PUT http://localhost:4000/api/vault \
     -H "Content-Type: application/json" \
     -b cookies.txt \
     -d '{"provider":"OPENAI","apiKey":"sk-..."}'
   ```
3. Connect a repo:
   ```bash
   curl -X POST http://localhost:4000/api/repositories \
     -H "Content-Type: application/json" \
     -b cookies.txt \
     -d '{"fullName":"your-username/your-repo"}'
   ```
4. Open `http://localhost:3000/dashboard` and either open a PR on that repo or click **Initiate Audit** to trigger one manually.

---

## API Reference

All endpoints under `/api`. Auth-protected routes require either the `auth_token` cookie (set by OAuth) or `Authorization: Bearer <jwt>`.

### Auth

| Method | Path | Description |
|---|---|---|
| GET | `/auth/github` | Start GitHub OAuth |
| GET | `/auth/github/callback` | Validates OAuth `state`, sets the session cookie, and redirects to the dashboard |
| GET | `/auth/github-app/install` | Start or continue the authenticated GitHub App installation flow |
| GET | `/auth/github-app/callback` | Validate and complete the GitHub App installation claim |
| GET | `/auth/me` | Current user 🔒 |
| POST | `/auth/logout` | Clear auth cookie |

### Vault

| Method | Path | Description |
|---|---|---|
| GET | `/vault` | Get current provider (never returns the key) 🔒 |
| PUT | `/vault` | Set/update `{provider, apiKey}` 🔒 |
| DELETE | `/vault` | Remove saved key 🔒 |

### Repositories

| Method | Path | Description |
|---|---|---|
| GET | `/repositories` | List your connected repos 🔒 |
| POST | `/repositories` | Connect `{fullName: "owner/repo"}` — installs the GitHub webhook 🔒 |
| DELETE | `/repositories/:id` | Disconnect (removes webhook + deactivates) 🔒 |
| POST | `/repositories/:id/analyze` | Manually trigger a review for `{pullNumber}` or `{headSha, baseSha}` 🔒 |

### Webhooks

| Method | Path | Description |
|---|---|---|
| POST | `/webhooks/github` | GitHub sends `pull_request` + `push` events here. HMAC-verified. |

### Billing

| Method | Path | Description |
|---|---|---|
| GET | `/billing/plans` | Available plans |
| GET | `/billing/usage` | Current usage 🔒 |
| POST | `/billing/checkout` | Start a Polar checkout session 🔒 |
| POST | `/billing/webhook` | Polar billing webhook (HMAC-verified) |

---

## Project Structure

```
ai-pr-reviewer/
├── apps/
│   ├── backend/                    # Express API + BullMQ worker
│   │   ├── prisma/schema.prisma    # User, Vault, Subscription, Installation,
│   │   │                           # Repository, CachedFile, AnalysisJob, UsageLedger
│   │   └── src/
│   │       ├── config/             # prisma, redis, queue, socket
│   │       ├── controllers/        # auth, vault, repository, webhook, billing
│   │       ├── middlewares/        # auth (JWT), github-verify (HMAC)
│   │       ├── routes/             # express routers
│   │       ├── services/
│   │       │   ├── ai/             # ai-factory, providers (gemini, openai,
│   │       │   │                   # claude, grok), finding taxonomy/dedupe,
│   │       │   │                   # context-prompt
│   │       │   ├── auth.service.ts
│   │       │   ├── config.service.ts          # .aipr.yml parsing
│   │       │   ├── context-builder.ts         # context orchestration
│   │       │   ├── import-graph.service.ts    # import extraction + resolution
│   │       │   ├── context-retrieval.service.ts # related-file discovery (BFS)
│   │       │   ├── repository-context-cache.service.ts # encrypted file cache
│   │       │   ├── diff-filter.service.ts     # ignore globs
│   │       │   ├── encryption.service.ts
│   │       │   └── github.service.ts
│   │       ├── workers/            # analysis, repo-poller, retention sweeps
│   │       └── index.ts
│   └── web/                        # Next.js dashboard
│       └── src/app/                # dashboard, repositories, history, vault, ...
├── docker-compose.yml              # Postgres + Redis
└── package.json                    # npm workspaces root
```

---

## Data Model

- **User** — GitHub identity (`githubId`, `username`, `email`, `avatarUrl`)
- **Vault** — encrypted AI API key + provider preference (one per user)
- **Subscription** — Polar subscription state and plan information
- **Installation** — GitHub App installation linked to its owning user, with the GitHub account that initiated installation recorded for verification
- **InstallationClaim** — short-lived, one-time OAuth-style claim used to bind GitHub App setup to the signed-in user
- **Repository** — GitHub repo scoped by stable GitHub repository ID and installation/owner (`fullName`, `webhookId`, `isActive`)
- **CachedFile** — encrypted source-file cache used by the context engine, keyed by git blob SHA
- **AnalysisJob** — one row per review (PR or commit). Tracks lifecycle status (`QUEUED`, `FETCHING`, `ANALYZING`, `GENERATING`, `POSTING`, `RETRYING`, `COMPLETED`, `FAILED`, `SKIPPED`, `CANCELLED`, or `TIMEOUT`; `RUNNING` remains for legacy jobs), commit SHA, and findings
- **UsageLedger** — per-installation or per-user monthly usage counters, reserved atomically when a review is accepted

---

## Repository Configuration (`.aipr.yml`)

Place at the repo root (or `.github/.aipr.yml`):

```yaml
min_severity: medium          # findings below this are dropped
ignore:
  - "dist/**"
  - "package-lock.json"
guidelines:                   # enforced as user rules on every review
  - "Never log secrets or PII"
  - "All public functions must have explicit return types"
context:                      # codebase context engine
  enabled: true
  max_hops: 2                 # dependency-graph walk depth
  max_files: 25
  max_tokens: 30000
```

See [docs/aipr-config.md](docs/aipr-config.md) for the full reference.

---

## Security Notes

- AI API keys are encrypted at rest with AES-256-GCM, using a key derived from `ENCRYPTION_KEY` via scrypt. The encryption key itself is never persisted.
- JWT auth cookies are `httpOnly`, `sameSite=lax`, and `secure` in production.
- Inbound GitHub webhooks are HMAC-verified using `GITHUB_WEBHOOK_SECRET` (timing-safe compare).
- CORS is scoped to `FRONTEND_URL` with credentials enabled.
- The shared `GITHUB_ACCESS_TOKEN` (bot PAT) needs `admin:repo_hook` on the target repos — grant it minimum required access.

---

## License

[AGPL-3.0](LICENSE) - GNU Affero General Public License v3.0
