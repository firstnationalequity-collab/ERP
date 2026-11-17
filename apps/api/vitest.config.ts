import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    // DB tests share one test database; run files one at a time.
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
    },
  },
});
