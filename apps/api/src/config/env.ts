import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url().default('postgres://albert:albert@localhost:5432/albert_erp'),
  DATABASE_URL_TEST: z.string().url().default('postgres://albert:albert@localhost:5432/albert_erp_test'),
  JWT_ACCESS_SECRET: z.string().min(32).default('dev-only-access-secret-change-me-0000000'),
  JWT_REFRESH_SECRET: z.string().min(32).default('dev-only-refresh-secret-change-me-000000'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  COMPANY_TIMEZONE: z.string().default('Asia/Karachi'),
  FBR_MODE: z.enum(['sandbox', 'production']).default('sandbox'),
  FBR_API_URL: z.string().optional(),
  FBR_API_TOKEN: z.string().optional(),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

if (env.NODE_ENV === 'production' && env.JWT_ACCESS_SECRET.startsWith('dev-only')) {
  throw new Error('Set real JWT secrets in production');
}

export const databaseUrl = env.NODE_ENV === 'test' ? env.DATABASE_URL_TEST : env.DATABASE_URL;
