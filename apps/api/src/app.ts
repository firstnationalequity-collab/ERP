import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { env } from './config/env';
import { logger } from './core/logger';
import { errorHandler, notFound } from './core/errors';
import { authRouter } from './core/auth/auth.routes';
import { authenticate, requireCurrentPassword } from './core/auth/middleware';
import { accessRouter } from './core/access/access.routes';
import { settingsRouter } from './core/settings/settings.routes';
import { approvalsRouter } from './core/approvals/approvals.routes';
import { attachmentsRouter } from './core/attachments/attachments.routes';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(pinoHttp({ logger }));

  const api = express.Router();
  api.get('/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Public auth endpoints (login/refresh/logout) and the password-change path.
  api.use('/core/auth', authRouter);
  // Every other router is mounted behind authenticate + requireCurrentPassword; each route checks its permission.
  api.use('/core', authenticate, requireCurrentPassword, accessRouter, settingsRouter, approvalsRouter, attachmentsRouter);

  app.use('/api/v1', api);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
