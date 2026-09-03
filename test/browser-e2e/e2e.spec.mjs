// test/browser-e2e/e2e.spec.mjs — the E2E suite on the stock Playwright
// fixtures. Runs under the chromium and firefox projects (playwright
// .config.ts's testIgnore keeps the webkit-only twin out); the shared
// test bodies live in suite.mjs.
//
// The `opfs` capability fixture (suite.mjs's gate) is provided as
// always-available here: chromium and firefox ship the Storage
// Manager API on every platform the suite runs on (ubuntu CI legs
// green end to end).
import { test as base } from '@playwright/test';
import { buildSuite } from './suite.mjs';

const test = base.extend({
  opfs: [async ({}, use) => use(true), { scope: 'test' }],
});

buildSuite(test);
