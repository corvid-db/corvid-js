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
// maintainers recommend in #18235. Verified with it on macOS:
// getDirectory, getFileHandle, and WORKER-side createSyncAccessHandle
// (getSize/write/read/flush/close) all succeed — exactly the surface
// openOpfs needs.
//
// CAPABILITY GATE (ubuntu CI, run 33727798807): Playwright's WebKit
// on ubuntu is the GTK build, and THAT BUILD SHIPS NO STORAGE MANAGER
// API AT ALL — `navigator.storage` is undefined, so the context-setup
// wipe and every OPFS test fail with
//
//   TypeError: undefined is not an object (evaluating
//   'navigator.storage.getDirectory')
//
//   (6 E2E failures, all one root; the in-page sync suite — no OPFS —
//   passed there, and chromium/firefox passed everything.)
//
// The gate below probes the CAPABILITY once per worker
// (`typeof navigator?.storage?.getDirectory === 'function'`), never
// the engine name: where the API exists (macOS WebKit: verified, four
// green full runs) the whole suite runs; where it does not (ubuntu's
// GTK build today) the six OPFS-dependent tests SKIP with this
// evidence and the arithmetic test still runs. The day Playwright's
// Linux WebKit grows OPFS, the probe turns true and the tests run
// again — no code change.
//
// State isolation, measured before relying on it (macOS; where OPFS
// exists at all): the profile directory does NOT scope WebKit's OPFS —
// Playwright's WebKit networking process keeps origin-keyed storage
// alive under the system tmpdir
// (com.apple.WebKit.Networking+org.webkit.Playwright), so a file
// written in one run with profile X is still readable in the next run
// with a fresh profile Y (verified directly; deleting X changes
// nothing). A fresh userDataDir therefore does NOT mean empty OPFS.
// Two consequences, both handled here:
//   1. the origin's corvid/ directory is WIPED before the first test
//      (only when the capability probe passed — getDirectory would
//      throw otherwise), restoring the clean slate chromium/firefox
//      ephemeral contexts get by construction (without it, run N+1
//      reads run N's databases: persist.txt fails at its 2nd line
//      with "schema violation: field 'name' is required" — the
//      leftover schema from the previous run);
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
// Set by the context override before any test body can run (page
// depends on context); null means "not probed yet", false means the
// engine build ships no Storage Manager API. Only `false` skips — an
// unprobed value fails loudly rather than skipping silently.
let opfsCapability = null;

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
        // The capability probe (see the header) + the origin wipe,
        // in one page: wipe only when there is anything to wipe with.
        const probe = await ctx.newPage();
        await probe.goto(baseURL);
        opfsCapability = await probe.evaluate(
          `typeof navigator?.storage?.getDirectory === 'function'`,
        );
        if (opfsCapability) {
          // Best-effort removeEntry — an absent directory is the goal
          // anyway (why the wipe exists: see the header comment).
          await probe.evaluate(`
            navigator.storage.getDirectory().then((root) =>
              root.removeEntry('corvid', { recursive: true })
                .catch(() => {}),
            )
          `);
        }
        await probe.close();
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

  // The suite's capability gate (suite.mjs's header): depends on
  // `page` ONLY for ordering — page → context guarantees the probe
  // has already run when this body executes.
  opfs: [
    async ({ page }, use, testInfo) => {
      testInfo.skip(
        opfsCapability === false,
        'this engine build ships no Storage Manager API: ' +
          "navigator.storage is undefined — TypeError: undefined is not " +
          "an object (evaluating 'navigator.storage.getDirectory') " +
          '(Playwright WebKit, ubuntu/GTK build; CI run 33727798807 — ' +
          'macOS WebKit ships OPFS and runs this test green; ' +
          'capability-gated, not engine-named, so a Linux build that ' +
          'gains OPFS runs it again automatically)',
      );
      await use(true);
    },
    { scope: 'test' },
  ],
});

buildSuite(test);
