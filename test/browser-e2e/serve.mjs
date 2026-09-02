// test/browser-e2e/serve.mjs — a minimal static server over the repo
// root for the Playwright E2E leg (navigation and multi-page tests
// vitest browser mode cannot express from inside the page). Module
// workers and wasm fetches need real http URLs; this serves them with
// correct MIME types.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
// ROOT ends in '/'; normalize it away so the guard compares against
// `<root>/` exactly (no sibling-directory prefix matches, no double
// slash rejecting everything).
const ROOT_PREFIX = normalize(ROOT).replace(/\/+$/, '');
const MIME = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/javascript',
  '.html': 'text/html',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // A minimal root document: the E2E page needs a same-origin HTML
    // shell to evaluate module steps in.
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>corvid-js e2e</title>\n');
      return;
    }
    let path = join(ROOT, decodeURIComponent(url.pathname));
    if (!normalize(path).startsWith(ROOT_PREFIX + '/')) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (url.pathname.endsWith('/')) path = join(path, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': MIME[extname(path)] ?? 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

const port = Number(process.env.PORT ?? 8931);
server.listen(port, '127.0.0.1', () => {
  console.log(`serving ${ROOT} at http://127.0.0.1:${port}`);
});
