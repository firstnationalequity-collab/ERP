import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : 'info',
  // Secrets never reach the logs: tokens, cookies, passwords (CLAUDE.md: a hash must never reach logs).
  redact: [
    'req.headers.authorization',
    'req.headers.cookie',
    'res.headers["set-cookie"]',
    '*.password',
    '*.currentPassword',
    '*.newPassword',
    '*.passwordHash',
    '*.password_hash',
  ],
});
