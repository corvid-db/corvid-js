// vitest.config.ts — the Node leg. Excludes the Playwright E2E specs
// (their `test()` is Playwright's, not vitest's — without this the
// default *.spec.* include tries to run them under vitest and fails).
// The browser legs use vitest.browser.config.ts and playwright.config.ts.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      'test/browser-e2e/**',
    ],
  },
});
