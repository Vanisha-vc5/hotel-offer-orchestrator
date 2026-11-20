import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'] },
      },
      {
        extends: true,
        // Time-skipping test server; first run downloads the test-server binary.
        test: {
          name: 'workflow',
          include: ['test/workflow/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        extends: true,
        // Needs a reachable Redis (REDIS_URL, default redis://localhost:6379).
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 20_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
