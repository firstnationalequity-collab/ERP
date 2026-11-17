import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { env } from './config/env';
import { logger } from './core/logger';
import { errorHandler, notFound } from './core/errors';

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

  // Module routers are mounted here as milestones are built, e.g.:
  // api.use('/core', coreRouter);
  // api.use('/inv', inventoryRouter);

  app.use('/api/v1', api);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
