# Authenticated browser lane contract

The Web E2E scaffold exchanges DSH's process launch token with Node `fetch`,
seeds the returned session cookie into a fresh Playwright `BrowserContext`, and
navigates only to the clean loopback URL.

Playwright tracing and HAR recording are forbidden for every file in this
lane. Both artifact formats retain authenticated request cookies by design;
redacting test output after capture cannot make those artifacts safe. Do not
enable `BrowserContext.tracing`, `recordHar`, Playwright `trace` options, or
trace/HAR CLI flags for `tests/web/**/*.e2e.ts`.

`npm run test:web` runs `scripts/check-web-auth-capture.mjs` before Vitest. The
guard scans the authenticated browser sources, Web Vitest config, package
script, and CI workflow, and fails closed if trace or HAR capture is enabled.
