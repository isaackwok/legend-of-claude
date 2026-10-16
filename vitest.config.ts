import { defineConfig } from 'vitest/config';

// Vitest 5 no longer reads vitest.workspace.ts; projects live in the root config.
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      { test: { name: 'shared', root: './shared', environment: 'node' } },
      { test: { name: 'server', root: './server', environment: 'node' } },
      { test: { name: 'client', root: './client', environment: 'jsdom' } },
    ],
  },
});
