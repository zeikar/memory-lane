import { defineConfig } from 'vitest/config';

// Live-data scoring checks; see scripts/calibrate.test.ts.
export default defineConfig({
  test: {
    include: ['scripts/calibrate.test.ts'],
    environment: 'node',
    testTimeout: 60000,
  },
});
