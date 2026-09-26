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
- **Multi-provider AI** — pick OpenAI, Gemini, Claude, or Grok per user; switch any time
- **Encrypted key vault** — your AI API key is stored AES-256-GCM encrypted; the plaintext only exists in memory during a job
- **GitHub OAuth login** — sign in with GitHub, no passwords
- **Per-user repo management** — connect/disconnect repos; we manage the webhook lifecycle for you
- **Manual review trigger** — fire off a review for any PR on demand from the dashboard
- **Live dashboard** — Socket.IO streams every step (`fetching diff → AI dispatching → posting comments`) in real time
- **GitHub App Integration (Pull Pilot)** — 1-click installation across individual repositories or entire organizations with automated PR & push webhooks
- **Background processing** — BullMQ + Redis with retries, exponential backoff, and bounded concurrency

---

## Architecture

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
                           │ (AI provider     │        post review comments)
                           │  factory)        │──────► AI Provider
                           └──────────────────┘        (OpenAI/Gemini/Claude/Grok)
```

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
| GET | `/auth/github/callback` | OAuth callback (sets cookie, redirects to dashboard) |
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

---

## Project Structure

```
ai-pr-reviewer/
├── apps/
│   ├── backend/                    # Express API + BullMQ worker
│   │   ├── prisma/schema.prisma    # User, Vault, Repository, AnalysisJob
│   │   └── src/
│   │       ├── config/             # prisma, redis, queue, socket
│   │       ├── controllers/        # auth, vault, repository, webhook
│   │       ├── middlewares/        # auth (JWT), github-verify (HMAC)
│   │       ├── routes/             # express routers
│   │       ├── services/
│   │       │   ├── ai/
│   │       │   │   ├── ai-factory.ts
│   │       │   │   └── providers/  # gemini, openai, claude, grok
│   │       │   ├── auth.service.ts
│   │       │   ├── encryption.service.ts
│   │       │   └── github.service.ts
│   │       ├── workers/analysis.worker.ts
│   │       └── index.ts
│   └── web/                        # Next.js dashboard
│       └── src/app/dashboard/page.tsx
├── docker-compose.yml              # Postgres + Redis
└── package.json                    # npm workspaces root
```

---

## Data Model

- **User** — GitHub identity (`githubId`, `username`, `email`, `avatarUrl`)
- **Vault** — encrypted AI API key + provider preference (one per user)
- **Repository** — connected GitHub repo (`fullName`, `webhookId`, `isActive`)
- **AnalysisJob** — one row per review (PR or commit). Tracks `status` (`QUEUED` / `RUNNING` / `COMPLETED` / `FAILED`) and stores AI findings in a JSON column

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
