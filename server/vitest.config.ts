import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    testTimeout: 30_000,
    // The first run downloads a MongoDB binary for the in-memory server.
    hookTimeout: 300_000,
  },
});
