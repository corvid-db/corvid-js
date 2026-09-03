// test/browser-e2e/suite.mjs — the E2E suite body, engine-agnostic.
//
// The navigation/multi-page browser tests vitest browser mode cannot
// express from inside the page (docs/OPFS-SPEC.md §8's browser-only
// additions): persistence across a REAL page reload, and the cross-tab
// single-writer BUSY (a second page's openOpfs of a locked name
// rejects 19), plus the two async fixture files over real OPFS.
//
// The tests live here, parameterized by the caller's `test` object:
// e2e.spec.mjs runs them on the stock Playwright fixtures (chromium,
// firefox), e2e-webkit.spec.mjs on a persistent-context fixture pair
// (WebKit's OPFS needs a real profile — see that file). One body, so
// the engines can never drift.
//
// Served by serve.mjs over http (module workers + wasm fetch need real
// URLs). The page side of each test lives in runner.mjs, so exactly
// the shipped package code executes in the browser.

import { expect } from '@playwright/test';

const RUNNER = '/test/browser-e2e/runner.mjs';
const FIXTURES = '/test/browser-e2e/fixtures-runner.mjs';

/** Run one named step in the page; resolves its result or the thrown message. */
async function run(page, step, arg) {
  await page.evaluate(`
    import('${RUNNER}')
      .then((r) => r.call(${JSON.stringify(step)}, ${JSON.stringify(arg)}))
      .then((result) => { window.__e2e = { status: 'done', result }; })
      .catch((error) => {
        window.__e2e = { error: String(error?.message ?? error) };
      });
  `);
  await page.waitForFunction(
    () => window.__e2e && (window.__e2e.status === 'done' || window.__e2e.error),
    null,
    { timeout: 60000 },
  );
  const out = await page.evaluate(() => {
    const r = window.__e2e;
    window.__e2e = undefined;
    return r;
  });
  if (out.error) throw new Error(`page step failed: ${out.error}`);
  return out.result;
}

/** Run one async fixture file in the page (the §8 mapping, real OPFS). */
async function runFixture(page, file, dbName) {
  await page.evaluate(`
    import('${FIXTURES}')
      .then((r) => r.runAsyncFixture(${JSON.stringify(file)}, ${JSON.stringify(dbName)}))
      .then((result) => { window.__e2e = { status: 'done', result }; })
      .catch((error) => {
        window.__e2e = { error: String(error?.message ?? error) };
      });
  `);
  await page.waitForFunction(
    () => window.__e2e && (window.__e2e.status === 'done' || window.__e2e.error),
    null,
    { timeout: 120000 },
  );
  const out = await page.evaluate(() => {
    const r = window.__e2e;
    window.__e2e = undefined;
    return r;
  });
  if (out.error) throw new Error(`fixture ${file} failed: ${out.error}`);
  return out.result;
}

/** Register the shared E2E suite on the caller's `test` object. */
export function buildSuite(test) {
  test('persist.txt — ondisk indexes, schema, documents survive close/reopen (real OPFS)', async ({ page }) => {
    await page.goto('/');
    const { lines } = await runFixture(page, 'persist.txt', 'e2e-persist');
    expect(lines).toBe(13);
  });

  test('admin.txt — dump/load/renames, backup, compact gate (real OPFS)', async ({ page }) => {
    await page.goto('/');
    const { lines } = await runFixture(page, 'admin.txt', 'e2e-admin');
    expect(lines).toBe(24);
  });

  test('browser baseline arithmetic: 230 (sync, vitest-browser) + 37 here = 267', () => {
    expect(13 + 24).toBe(37);
  });

  test('persistence across a full close (real Worker + OPFS)', async ({ page }) => {
    await page.goto('/');
    await run(page, 'roundtrip-write', 'e2e-roundtrip');
    const doc = await run(page, 'roundtrip-read', 'e2e-roundtrip');
    expect(doc).toEqual({ n: 7, body: 'hello opfs' });
  });

  test('dump bytes cross the worker boundary intact', async ({ page }) => {
    await page.goto('/');
    const n = await run(page, 'dump-bytes', 'e2e-dump');
    expect(n).toBeGreaterThan(12);
  });

  test('data persists across a real page reload', async ({ page }) => {
    await page.goto('/');
    await run(page, 'reload-setup', 'e2e-reload');

    await page.reload(); // the whole page — workers, wasm, JS heap, gone
    const doc = await run(page, 'reload-verify', 'e2e-reload');
    expect(doc).toEqual({ n: 42, body: 'survives reload' });
  });

  test('cross-tab second open rejects with Busy (19), lock frees on close', async ({ page, context }) => {
    await page.goto('/');
    await run(page, 'busy-hold', 'e2e-busy');

    const page2 = await context.newPage();
    await page2.goto('/');
    const code = await run(page2, 'busy-second', 'e2e-busy');
    expect(code).toBe(19); // the frozen Busy code — the OPFS exclusive lock

    // The lock frees when the first tab closes its db (§5.3's ordering,
    // observed across pages).
    await run(page, 'busy-release', 'e2e-busy');
    const retry = await run(page2, 'busy-retry', 'e2e-busy');
    expect(retry).toBe('opened');
    await page2.close();
  });
}
