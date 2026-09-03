// test/browser-e2e/e2e.spec.mjs — the E2E suite on the stock Playwright
// fixtures. Runs under the chromium and firefox projects (playwright
// .config.ts's testIgnore keeps the webkit-only twin out); the shared
// test bodies live in suite.mjs.
import { test } from '@playwright/test';
import { buildSuite } from './suite.mjs';

buildSuite(test);
