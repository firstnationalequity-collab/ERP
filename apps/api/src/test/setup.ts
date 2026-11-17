// Runs before every test file (vitest setupFiles): start from a freshly migrated test database.
import { beforeAll } from 'vitest';
import { resetTestDatabase } from './db';

beforeAll(async () => {
  await resetTestDatabase();
}, 30_000);
