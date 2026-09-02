// vitest.browser.config.ts — the in-page browser leg: the SAME golden
// spec (entry-agnostic: `await init()` in-browser) in real Chromium via
// Playwright — PLAN.md §7's "runs unchanged against await init()"
// promise, cashed. The async OPFS fixtures + navigation/multi-page
// tests run in the SEPARATE Playwright E2E leg (test/browser-e2e/)
// over plain http, where the canonical Worker construct executes
// exactly as user bundlers ship it — vite's dev-time worker rewrite
// stalls raw module workers in its tester iframe, so the async surface
// is proven on the production-faithful path instead (SPEC §8's
// two-part browser leg, documented there).
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  test: {
    include: ['test/golden.spec.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
