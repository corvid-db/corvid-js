// playwright.config.ts — the E2E browser leg (reload persistence,
// cross-tab BUSY). serve.mjs hosts the repo root over http: module
// workers and wasm fetches need real URLs, and OPFS needs a proper
// origin. Chromium only, headless — the supported baseline (SPEC §1.3
// B9); Firefox/Safari legs are documented manual matrix entries.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/browser-e2e',
  timeout: 120000,
  use: {
    headless: true,
    baseURL: 'http://127.0.0.1:8931',
  },
  webServer: {
    command: 'node test/browser-e2e/serve.mjs',
    url: 'http://127.0.0.1:8931',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
