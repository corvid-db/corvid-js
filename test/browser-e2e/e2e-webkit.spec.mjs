// test/browser-e2e/e2e-webkit.spec.mjs — the SAME E2E suite (suite.mjs,
// one body for every engine) on a persistent WebKit context.
//
// Why this file exists — an environment fact, not a WebKit engine gap:
// Playwright's default browser context is EPHEMERAL, and WebKit
// treats ephemeral sessions like Safari's private browsing, where the
// whole StorageManager is unavailable:
//
//   navigator.storage.getDirectory() rejects
//   UnknownError: The operation failed for an unknown transient
//   reason (e.g. out of memory).
//
//   — observed headless AND headed on Playwright WebKit 26.5 / 1.62.1,
//   on the main thread AND inside workers, before any corvid code
//   runs; microsoft/playwright#18235 documents it, and MDN's
//   getDirectory() page attributes the private-browsing UnknownError.
//   Real Safari (SPEC §1.3 B9 baseline: Safari 15.2+) runs a real
//   profile, where OPFS works.
//
// The runner's built-in fixtures only expose browserType.launch() +
// newContext() (no persistent-context option), so this entry overrides
// `context`/`page` for the webkit project with
// webkit.launchPersistentContext — the same API the Playwright
// maintainers recommend in #18235. Verified with it: getDirectory,
// getFileHandle, and WORKER-side createSyncAccessHandle (getSize/
// write/read/flush/close) all succeed, which is exactly the surface
// openOpfs needs.
//
// State isolation, measured before relying on it: the profile
// directory does NOT scope WebKit's OPFS — Playwright's WebKit
// networking process keeps origin-keyed storage alive under the
// system tmpdir (com.apple.WebKit.Networking+org.webkit.Playwright),
// so a file written in one run with profile X is still readable in
// the next run with a fresh profile Y (verified directly; deleting X
// changes nothing). A fresh userDataDir therefore does NOT mean empty
// OPFS. Two consequences, both handled here:
//   1. the origin's corvid/ directory is WIPED before the first test,
//      restoring the clean slate chromium/firefox ephemeral contexts
//      get by construction (without it, run N+1 reads run N's
//      databases: persist.txt fails at its 2nd line with
//      "schema violation: field 'name' is required" — the leftover
//      schema from the previous run);
//   2. the wipe touches the WHOLE origin, so two live webkit workers
//      could delete each other's in-flight databases —
//      playwright.config.ts pins workers: 1.
//
// Pages are closed per test (the shared context otherwise accumulates
// them across the worker's tests).
import { test as base, webkit } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSuite } from './suite.mjs';

// parallelIndex identifies the worker process; one profile each.
const profiles = new Map(); // parallelIndex -> { ctx, dir }

const test = base.extend({
  // Worker-scoped teardown: close the persistent contexts and delete
  // their profile dirs when the worker exits. Requested by the
  // context override below so it is always alive beneath it.
  _webkitProfiles: [
    async ({}, use) => {
      await use();
      for (const { ctx, dir } of profiles.values()) {
        await ctx.close().catch(() => {});
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
    { scope: 'worker', auto: true },
  ],

  context: [
    async ({ _webkitProfiles }, use, testInfo) => {
      const key = testInfo.parallelIndex;
      let entry = profiles.get(key);
      if (!entry) {
        const dir = await mkdtemp(join(tmpdir(), 'corvid-e2e-webkit-'));
        const baseURL =
          testInfo.project.use.baseURL ?? testInfo.config.use.baseURL;
        const ctx = await webkit.launchPersistentContext(dir, {
          headless: true,
          baseURL,
        });
        // The origin wipe (see the header comment): best-effort
        // removeEntry — an absent directory is the goal anyway.
        const wipe = await ctx.newPage();
        await wipe.goto(baseURL);
        await wipe.evaluate(`
          navigator.storage.getDirectory().then((root) =>
            root.removeEntry('corvid', { recursive: true })
              .catch(() => {}),
          )
        `);
        await wipe.close();
        entry = { ctx, dir };
        profiles.set(key, entry);
      }
      await use(entry.ctx); // shared across this worker's tests, on purpose
    },
    { scope: 'test' },
  ],

  page: [
    async ({ context }, use) => {
      const page = await context.newPage();
      await use(page);
      await page.close();
    },
    { scope: 'test' },
  ],
});

buildSuite(test);
