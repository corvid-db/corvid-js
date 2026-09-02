// test/browser-e2e/runner.mjs — the in-page side of the E2E specs:
// small named steps over the real package surface. Exactly the shipped
// modules execute (index.js/opfs-async.js/opfs-worker.js/pkg/*);
// results surface on window.__e2e for the Playwright side to await.

import { openOpfs } from '../../opfs-async.js';

const held = new Map(); // name -> AsyncDb, held across evaluate() calls

async function step(name, arg) {
  switch (name) {
    case 'reload-setup': {
      const db = await openOpfs(arg);
      const docs = await db.collection('docs');
      await docs.insert('k', { n: 42, body: 'survives reload' });
      await docs.close();
      await db.close();
      return 'written';
    }
    case 'reload-verify': {
      const db = await openOpfs(arg);
      const docs = await db.collection('docs');
      const doc = await docs.get('k');
      await docs.close();
      await db.close();
      return doc;
    }
    case 'busy-hold': {
      const db = await openOpfs(arg);
      held.set(arg, db);
      return 'held';
    }
    case 'busy-second': {
      try {
        await openOpfs(arg);
        return 'unexpectedly opened';
      } catch (e) {
        return e.code;
      }
    }
    case 'busy-release': {
      const db = held.get(arg);
      await db.close();
      held.delete(arg);
      return 'released';
    }
    case 'busy-retry': {
      const db = await openOpfs(arg);
      const docs = await db.collection('docs');
      const len = await docs.len();
      await docs.close();
      await db.close();
      return len === 0 ? 'opened' : `opened,len=${len}`;
    }
    case 'roundtrip-write': {
      const db = await openOpfs(arg);
      const docs = await db.collection('docs');
      await docs.insert('k', { n: 7, body: 'hello opfs' });
      await docs.close();
      await db.close();
      return 'written';
    }
    case 'roundtrip-read': {
      const db = await openOpfs(arg);
      const docs = await db.collection('docs');
      const doc = await docs.get('k');
      await docs.close();
      await db.close();
      return doc;
    }
    case 'dump-bytes': {
      const db = await openOpfs(arg);
      const docs = await db.collection('docs');
      await docs.insert('a', { n: 1 });
      const bytes = await db.dump();
      await docs.close();
      await db.close();
      return bytes.length;
    }
    default:
      throw new Error(`unknown step: ${name}`);
  }
}

// The module namespace IS the protocol target: `import(RUNNER).then(r =>
// r.call(...))`. The `held` Map above persists across evaluate() calls
// (one cached module instance per document), which is what the
// cross-tab hold/release steps rely on.
export const call = step;
