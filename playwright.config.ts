// playwright.config.ts — the E2E browser leg (reload persistence,
// cross-tab BUSY). serve.mjs hosts the repo root over http: module
// workers and wasm fetches need real URLs, and OPFS needs a proper
// origin. All three engines (chromium/firefox/webkit) run the SAME
// suite body (test/browser-e2e/suite.mjs) — the enforced matrix for
// SPEC §1.3 B9's baseline. Per-engine environment needs, documented
// at the point they apply: firefox auto-answers the storage-persist
// permission prompt (launchOptions below); webkit runs the
// persistent-context twin spec (e2e-webkit.spec.mjs) because
// Playwright's ephemeral contexts disable WebKit's OPFS entirely.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/browser-e2e',
  timeout: 120000,
  // One worker at a time: the webkit leg wipes this origin's whole
  // OPFS directory before its first test (see e2e-webkit.spec.mjs —
  // Playwright's WebKit keeps origin-keyed OPFS alive across profile
  // directories), so two concurrent webkit workers could delete each
  // other's in-flight databases. The suite is 21 short tests;
  // serialization costs ~nothing and makes failures deterministic.
  workers: 1,
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
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
      // The webkit-only twin spec (persistent-context fixtures) is
      // scoped to the webkit project below.
      testIgnore: /e2e-webkit\.spec\.mjs$/,
    },
    {
      name: 'firefox',
      use: {
        browserName: 'firefox',
        // openOpfs() awaits navigator.storage.persist() by default
        // (SPEC §5.2 step 2). Firefox gates persist() behind a
        // PERMISSION PROMPT; in automation nobody answers it, so the
        // promise stays pending forever and every OPFS test hangs
        // (observed: `persist()->HANG` headless AND headed, Playwright
        // firefox 153 / 1.62.1 — while `persisted()` resolves fine and
        // WebKit's persist() resolves `false` unprompted). These prefs
        // are Firefox's own testing switches for exactly this: auto-
        // answer the storage-permission prompt so persist() resolves
        // `true` like a user granting it. Test-environment fix only —
        // the shipped default path (prompt the real user) is unchanged.
        launchOptions: {
          firefoxUserPrefs: {
            'dom.storageManager.prompt.testing': true,
            'dom.storageManager.prompt.testing.allow': true,
          },
        },
      },
      testIgnore: /e2e-webkit\.spec\.mjs$/,
    },
    {
      name: 'webkit',
      use: { browserName: 'webkit' },
      // WebKit's OPFS needs a persistent profile (ephemeral contexts
      // are private-browsing to WebKit, where getDirectory() rejects
      // UnknownError) — the webkit twin spec overrides the fixtures
      // with launchPersistentContext; see e2e-webkit.spec.mjs.
      testIgnore: /e2e\.spec\.mjs$/,
    },
  ],
});
