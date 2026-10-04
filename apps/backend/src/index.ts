import path from 'path';
import dotenv from 'dotenv';
import http from 'http';
import { PORT_DEFAULT } from './utils/constants';

// Load root project .env and apps/backend/.env
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

// Read after dotenv.config(): the default lives in utils/constants.ts, but
// process.env must be resolved here, in the module body, so the .env files above
// have already been loaded.
const PORT = process.env.PORT || PORT_DEFAULT;

async function startServer() {
  try {
    const [{ default: app }, { default: prisma }, { SocketService }] = await Promise.all([
      import('./app'),
      import('./config/prisma'),
      import('./config/socket'),
    ]);

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

    // 7. Enforce the short retention window on cached source blobs. This is
    // what keeps cached review context from becoming a long-term copy of
    // customer repositories, so it must not be disabled in production.
    startContextRetentionSweep();
  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }
}

startServer();
