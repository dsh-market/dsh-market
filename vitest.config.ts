import { defineConfig } from 'vitest/config'

// Unit lane: fast, no network, no real pnpm. The real-pnpm matrix lives in
// tests/*.compat.spec.ts and runs through vitest.compat.config.ts instead
// (`npm run test:compat`).
export default defineConfig({
  test: {
    // Strips the developer's proxy variables first: with one exported, the
    // fetch stubs below marketFetch never see a request (tests/setup/no-proxy.ts).
    setupFiles: ['tests/setup/no-proxy.ts'],
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    exclude: ['tests/**/*.compat.spec.ts', '**/node_modules/**'],
    pool: 'forks',
    testTimeout: 20_000,
    server: {
      deps: {
        // ui-primitives (and its katex dependency) ship raw .css imports;
        // inlining routes them through vite's transform for the jsdom lane.
        inline: [/@deepseek-ai\/dsh-client-/, /katex/],
      },
    },
  },
})
