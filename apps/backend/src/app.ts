import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createAccessLogger } from './middlewares/access-log.middleware';
import cookieParser from 'cookie-parser';
import webhookRoutes from './routes/webhook.routes';
import authRoutes from './routes/auth.routes';
import vaultRoutes from './routes/vault.routes';
import repositoryRoutes from './routes/repository.routes';
import rulesRoutes from './routes/rules.routes';
import jobRoutes from './routes/job.routes';
import testDraftRoutes from './routes/test-draft.routes';
import billingRoutes from './routes/billing.routes';
import behavioralRoutes from './routes/behavioral.routes';
import dashboardRoutes from './routes/dashboard.routes';
import { apiErrorHandler } from './middlewares/api-error.middleware';
import { installRequestBodyParsers } from './middlewares/request-body.middleware';

const app: Application = express();

// 1. Global Middlewares
app.use(helmet());
app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  }),
);
// Log before parsing so malformed/oversized deliveries are visible too.
app.use(createAccessLogger());
installRequestBodyParsers(app);
app.use(cookieParser());

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
app.use('/api/behavioral', behavioralRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use(apiErrorHandler);

export default app;

