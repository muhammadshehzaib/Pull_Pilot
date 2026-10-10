import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import webhookRoutes from './routes/webhook.routes';
import authRoutes from './routes/auth.routes';
import vaultRoutes from './routes/vault.routes';
import repositoryRoutes from './routes/repository.routes';
import rulesRoutes from './routes/rules.routes';
import jobRoutes from './routes/job.routes';
import testDraftRoutes from './routes/test-draft.routes';
import billingRoutes from './routes/billing.routes';

const app: Application = express();

// 1. Global Middlewares
app.use(helmet());
app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  }),
);
app.use(
  express.json({
    // Keep the exact wire bytes: GitHub signs the raw payload, and a
    // parse→stringify round-trip is not byte-stable (unicode escapes, key
    // order), so webhook HMAC verification must run against these bytes.
    verify: (req, _res, buf) => {
      (req as Request).rawBody = buf;
    },
  }),
);
app.use(cookieParser());
app.use(morgan('dev'));

// 2. Health Check
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() });
});

// 3. Route Wireframe
app.use('/api/webhooks', webhookRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/vault', vaultRoutes);
app.use('/api/repositories', repositoryRoutes);
app.use('/api/repositories', rulesRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/test-drafts', testDraftRoutes);
app.use('/api/billing', billingRoutes);

export default app;

