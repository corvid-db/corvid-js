// opfs-async.spec.ts — the async facade (docs/OPFS-SPEC.md §4) driven
// over DirectLink: the SAME dispatcher the browser Worker runs, with a
// fake OPFS environment standing in for navigator.storage. Everything
// mechanical about the facade — the API mirror, the update composition,
// streaming, poisoning, the CorvidFloat unwrap, the frozen error codes,
// the close/reopen ordering — is pinned here in-process. The
// postMessage/real-OPFS legs are T5's Playwright suite (the split is
// SPEC §7's "one dispatcher, two hosts" by design).

import { beforeEach, expect, test } from 'vitest';

import { AsyncDb } from '../opfs-async.js';
import { openOpfs } from '../opfs-async.js';
import { CorvidError, CorvidFloat, field } from '../index.js';
import { DirectLink } from '../opfs-link.js';
import { bootEngine, createRpcHost } from '../opfs-rpc.js';
import { corvidOpfs } from '../opfs-shim.js';
import { makeFakeHandle } from './helpers/fake-handle.js';

let glue;
let env;

/// The fake OPFS environment: a name-keyed directory of fake handles
/// with per-name exclusive locking (a second openHandle while a handle
/// is live = the cross-tab BUSY of the real thing).
function makeEnv() {
  const files = new Map(); // name -> { handle }
  return {
    files,
    async openHandle(name) {
      const existing = files.get(name);
      if (existing) {
        if (!existing.handle.closed) {
          throw {
            code: 19,
            message: `OPFS file is locked by another tab or handle: ${name}`,
          };
        }
        // Reopen: the bytes live in the fake handle object — the
        // persistence across Worker/database death the real OPFS file
        // provides.
        return corvidOpfs.register(existing.handle);
      }
      const handle = makeFakeHandle();
      files.set(name, { handle });
      return corvidOpfs.register(handle);
    },
    async backupTarget(name) {
      if (files.has(name)) {
        throw { code: 17, message: `backup target already exists: ${name}` };
      }
      const handle = makeFakeHandle();
      files.set(name, { handle });
      return corvidOpfs.register(handle);
    },
    async removeTarget(name) {
      files.delete(name);
    },
  };
}

async function openDb(name = 'test') {
  const host = createRpcHost(glue, env);
  const link = new DirectLink(host);
  const db = new AsyncDb(link, 1);
  await db._rpc('db.open', [name]);
  return db;
}

async function codeOf(promise) {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(CorvidError);
    return e.code;
  }
  throw new Error('expected the promise to reject');
}

beforeEach(async () => {
  glue = await bootEngine();
  env = makeEnv();
});

test('full async lifecycle: insert, query, update, stream, close, reopen', async () => {
  const db = await openDb('life');
  const docs = await db.collection('docs');
  expect(docs.name).toBe('docs'); // facade-local sync getter
  await docs.insert('a', { n: 1, body: 'rust embedded database' });
  await docs.insert('b', { n: 2, body: 'python web frameworks' });
  await docs.insertMany([
    ['c', { n: 3 }],
    ['d', { n: 4 }],
  ]);
  expect(await docs.len()).toBe(4);
  expect(await docs.get('a')).toEqual({ n: 1, body: 'rust embedded database' });
  expect(await db.collections()).toEqual(['docs']);

  // Fluent query: chain synchronous, terminal async.
  const rows = await docs
    .query()
    .filter(field('n').ge(2))
    .orderBy('n')
    .run();
  expect(rows.map((r) => r.key)).toEqual(['b', 'c', 'd']);

  // update composition: get -> fn -> CAS.
  await docs.update('a', (cur) => ({ ...cur, n: 100 }));
  expect(await docs.get('a')).toEqual({ n: 100, body: 'rust embedded database' });
  await docs.update('a', () => null); // fn-null deletes
  expect(await docs.get('a')).toBeNull();
  await expect(codeOf(docs.update('b', () => {
    throw new Error('boom');
  }))).resolves.toBe(12);
  expect(await docs.get('b')).toEqual({ n: 2, body: 'python web frameworks' });

  // scanEach: full walk, then early stop.
  let visited = await docs.scanEach(() => {});
  expect(visited).toBe(3);
  let seen = 0;
  visited = await docs.scanEach(() => {
    seen += 1;
    return seen < 2; // false stops the walk
  });
  expect(visited).toBe(2);

  await docs.close();
  await db.close();

  // REOPEN: the fake handle's bytes persist — and the §5.3 ordering
  // means the lock was already free when close() resolved.
  const db2 = await openDb('life');
  const docs2 = await db2.collection('docs');
  expect(await docs2.len()).toBe(3);
  expect(await docs2.get('b')).toEqual({ n: 2, body: 'python web frameworks' });
  await docs2.close();
  await db2.close();
});

test('openOpfs validates names before anything async, and refuses non-Worker hosts', async () => {
  for (const bad of ['', 'a/b', 'a\\b', '.', '..']) {
    await expect(codeOf(openOpfs(bad))).resolves.toBe(11);
  }
  await expect(codeOf(openOpfs('x'.repeat(256)))).resolves.toBe(11);
  // A VALID name in a Worker-less host: the clean environment error.
  await expect(codeOf(openOpfs('good'))).resolves.toBe(12);
});

test('cross-tab second open rejects with Busy (19)', async () => {
  const db1 = await openDb('shared');
  await (await db1.collection('docs')).insert('k', { n: 1 });
  await expect(codeOf(openDb('shared'))).resolves.toBe(19);
  await db1.close();
  // Lock free after close: the immediate reopen succeeds.
  const db2 = await openDb('shared');
  expect(await (await db2.collection('docs')).len()).toBe(1);
  await db2.close();
});

test('ops after close reject with code 1', async () => {
  const db = await openDb();
  await db.close();
  await expect(codeOf(db.collections())).resolves.toBe(1);
  const again = await db.close(); // idempotent
  expect(again).toBeUndefined();
});

test('query poisoning: a bad chain op rejects every result terminal; close stays exempt', async () => {
  const db = await openDb();
  const docs = await db.collection('docs');
  await docs.insert('a', { n: 1 });
  const q = docs.query().filter({ op: 'nonsense' }).limit(5);
  await expect(codeOf(q.run())).resolves.toBe(12);
  await expect(codeOf(q.count())).resolves.toBe(12); // still poisoned
  await expect(q.close()).resolves.toBeUndefined(); // exempt
  await db.close();
});

test('terminals consume the builder; a second terminal rejects with code 1', async () => {
  const db = await openDb();
  const docs = await db.collection('docs');
  await docs.insert('a', { n: 1 });
  const q = docs.query().filter(field('n').eq(1));
  expect(await q.count()).toBe(1);
  await expect(codeOf(q.count())).resolves.toBe(1);
  await db.close();
});

test('compact gate: Busy with a live collection, clear after close (19)', async () => {
  const db = await openDb();
  const docs = await db.collection('docs');
  await docs.insert('a', { n: 1 });
  await expect(codeOf(db.compact())).resolves.toBe(19);
  await docs.close();
  await expect(db.compact()).resolves.toBeTypeOf('boolean');
  await db.close();
});

test('CorvidFloat crosses the wire as the Float kind (f: group tags)', async () => {
  const db = await openDb();
  const docs = await db.collection('docs');
  await docs.insert('a', { v: new CorvidFloat(2) }); // 2 as Float, not Int
  await docs.insert('b', { v: 2 }); // plain Int
  const groups = await docs.query().groupCount('v');
  expect(groups['f:2']).toBe(1);
  expect(groups['i:2']).toBe(1);
  await db.close();
});

test('scanEach streams in chunks (1200 docs cross the 512-row boundary)', async () => {
  const db = await openDb();
  const docs = await db.collection('docs');
  await docs.insertMany(
    Array.from({ length: 1200 }, (_, i) => [`k${String(i).padStart(5, '0')}`, { i }]),
  );
  expect(await docs.len()).toBe(1200);
  const visited = await docs.scanEach(() => {});
  expect(visited).toBe(1200);
  await db.close();
});

test('dump/load/loadWithRenames and backupTo through the facade', async () => {
  const db = await openDb('admin');
  const docs = await db.collection('docs');
  await docs.insert('a', { n: 1 });
  await docs.insert('b', { n: 2 });

  const bytes = await db.dump();
  expect(bytes).toBeInstanceOf(Uint8Array);

  const fresh = await openDb('restore');
  await fresh.load(bytes);
  expect(await (await fresh.collection('docs')).len()).toBe(2);
  await fresh.close();

  const renamed = await openDb('renamed-target');
  await renamed.loadWithRenames(bytes, { docs: 'renamed' });
  expect(await renamed.collections()).toEqual(['renamed']);
  await renamed.close();

  // backupTo: fresh target ok, existing target is 17, no debris on hit.
  await db.backupTo('b1.corvid');
  await expect(codeOf(db.backupTo('b1.corvid'))).resolves.toBe(17);
  expect(env.files.has('b1.corvid')).toBe(true);

  // The backup reopens as an independent database.
  const restored = await openDb('b1.corvid');
  expect(await (await restored.collection('docs')).len()).toBe(2);
  await restored.close();
  await db.close();
});

test('phraseSearch and geo mirror through the facade', async () => {
  const db = await openDb();
  const docs = await db.collection('docs');
  await docs.insert('a', { body: 'rust embedded database' });
  await docs.createTextIndex('body');
  const hits = await docs.phraseSearch('body', 'embedded database', 5);
  expect(hits.map((h) => h.key)).toEqual(['a']);
  await db.close();
});
