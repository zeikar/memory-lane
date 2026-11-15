import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Served from https://zeikar.dev/memory-lane/ like the owner's other project sites.
  base: '/memory-lane/',
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
