import { defineConfig } from 'vitest/config';

// Vitest 5 no longer reads vitest.workspace.ts; projects live in the root config.
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      { test: { name: 'shared', root: './shared', environment: 'node' } },
      { test: { name: 'server', root: './server', environment: 'node' } },
      // The client project extends the client's Vite config so tests get the same React plugin as the app.
      { extends: './client/vite.config.ts', test: { name: 'client', root: './client', environment: 'jsdom' } },
    ],
  },
});
