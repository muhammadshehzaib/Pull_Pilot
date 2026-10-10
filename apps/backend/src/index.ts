import path from 'path';
import dotenv from 'dotenv';
import http from 'http';

// Load root project .env and apps/backend/.env.
//
// This must run before any module that reads process.env at import time, which
// is most of them: utils/constants.ts snapshots limits such as
// CONTEXT_MAX_TOKENS and JOB_RETENTION_DAYS at module scope. ES imports are
// hoisted above this code, so a static `import { PORT_DEFAULT } from
// './utils/constants'` would be evaluated first and would freeze every
// env-derived constant to its default in local development. App modules are
// therefore loaded with dynamic import inside startServer(), below.
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

async function startServer() {
  try {
    const [{ default: app }, { default: prisma }, { SocketService }, { PORT_DEFAULT }] =
      await Promise.all([
        import('./app'),
        import('./config/prisma'),
        import('./config/socket'),
        import('./utils/constants'),
      ]);

    // Resolved here so the .env files above are in effect.
    const PORT = process.env.PORT || PORT_DEFAULT;

    // Pre-initialize our background tasks immediately on boot, after env is loaded.
    await import('./workers/analysis.worker');
    const { startRepoPoller } = await import('./workers/repo-poller');
    const { startJobRetentionSweep } = await import('./workers/job-retention');
    const { startContextRetentionSweep } = await import('./workers/context-retention');

    // Wrap Express with HTTP Server required for WebSockets
    const server = http.createServer(app);

    // 1. Validate Database Connection
    console.log('🔌 Connecting to Database...');
    await prisma.$connect();
    console.log('✅ Database connected successfully.');

    // 2. Initialize Socket.IO layer
    SocketService.init(server);

    // 3. Report which GitHub auth path is live (App vs PAT fallback)
    const { GitHubAppService } = await import('./services/github-app.service');
    GitHubAppService.logAuthMode();

    // 4. Fire up listening socket
    server.listen(PORT, () => {
      console.log(`🚀 Server launched at http://localhost:${PORT}`);
    });

    // 5. Poll webhook-less repos for new commits/PRs (local-dev webhook substitute)
    startRepoPoller();

    // 6. Drop aged-out failed jobs from Redis and the database
    startJobRetentionSweep();

    // 7. Enforce the configured retention on cached source blobs. With the
    // default (indefinite) it collects rows left behind by an earlier finite
    // policy; with a finite policy it deletes expired context. Either way this
    // is what keeps cached review context from outliving its setting.
    startContextRetentionSweep();
    const { startBehavioralRetentionSweep } = await import('./workers/behavioral-retention');
    startBehavioralRetentionSweep();
    const { startHistoricalMaintenance } = await import('./workers/historical-maintenance');
    startHistoricalMaintenance();
  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }
}

startServer();
