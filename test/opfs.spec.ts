// opfs.spec.ts — the OPFS storage backend, proven in Node against a
// fake FileSystemSyncAccessHandle through the REAL host shim
// (opfs-shim.js — the same module the Worker runtime imports; one
// shim, two hosts, so what this suite proves is what the browser
// runs). This is T2's deliverable per docs/OPFS-SPEC.md §3: the raw
// wasm layer (WasmDb.openOpfs / dump / load / loadWithRenames /
// backupOpfs) over the engine's v0.3.4 backend seam.
//
// The browser-only behaviors the fake cannot prove (real sync-handle
// exclusivity, persistence across a page reload) are the T5
// Playwright leg's job; everything mechanical about the seam is pinned
// here.

import { readFileSync } from 'node:fs';

import { beforeAll, expect, test } from 'vitest';

import { corvidOpfs } from '../opfs-shim.js';
// The RAW wasm layer, not the OOP wrapper — this suite is about the
// backend seam. Importing the glue directly also lets us capture the
// initSync return (the wasm exports, whose .memory the shim needs).
import * as glue from '../pkg/corvid_js.js';

let wasmExports;

beforeAll(() => {
  wasmExports = glue.initSync({
    module: readFileSync(new URL('../pkg/corvid_js_bg.wasm', import.meta.url)),
  });
  corvidOpfs.install(wasmExports.memory);
});

/**
 * A fake FileSystemSyncAccessHandle over a growing byte buffer.
 * `quotaAt` simulates the browser quota: writes that would grow the
 * file past it throw a QuotaExceededError DOMException-alike (name +
 * message, exactly what the shim's wrapper stringifies).
 */
function fakeHandle({ quotaAt = Infinity } = {}) {
  const h = {
    data: new Uint8Array(0),
    flushes: 0,
    closed: false,
    read(buf, { at }) {
      let i = 0;
      while (i < buf.length && at + i < h.data.length) {
        buf[i] = h.data[at + i];
        i += 1;
      }
      return i;
    },
    write(buf, { at }) {
      const end = at + buf.length;
      if (end > quotaAt) {
        const e = new Error('The operation exceeded the storage quota');
        e.name = 'QuotaExceededError';
        throw e;
      }
      if (end > h.data.length) {
        const grown = new Uint8Array(end);
        grown.set(h.data.subarray(0, Math.min(at, h.data.length)));
        h.data = grown;
      }
      h.data.set(buf, at);
      return buf.length;
    },
    truncate(n) {
      if (n > h.data.length) {
        const grown = new Uint8Array(n);
        grown.set(h.data);
        h.data = grown;
      } else {
        h.data = h.data.subarray(0, n);
      }
    },
    getSize() {
      return h.data.length;
    },
    flush() {
      h.flushes += 1;
    },
    close() {
      h.closed = true;
    },
  };
  return h;
}

/** Run `fn`, expect it to throw, return the CorvidErr wire code. */
function thrownCode(fn) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    const parsed = JSON.parse(e.message);
    expect(parsed).toHaveProperty('corvidCode');
    return parsed.corvidCode;
  }
  throw new Error('expected fn to throw');
}

test('openOpfs persists documents across close and reopen over the same handle bytes', () => {
  const handle = fakeHandle();
  const id = corvidOpfs.register(handle);

  {
    const db = glue.WasmDb.openOpfs(id);
    const docs = db.collection('docs');
    docs.insert('strong', { body: 'rust embedded database', n: 1 });
    docs.insert('weak', { body: 'python web frameworks', n: 2 });
    expect(docs.len()).toBe(2);
    docs.close();
    db.close();
  }

  // The backend's close fired: handle flushed, closed, unregistered.
  expect(handle.closed).toBe(true);
  expect(handle.flushes).toBeGreaterThan(0);
  // A raw SHIM call on the dead id throws a plain host Error (the shim
  // layer, not the engine wire form).
  expect(() => corvidOpfs.sync(id)).toThrow(/unknown or closed handle/);
  expect(() => corvidOpfs.closeHandle(id)).not.toThrow(); // no-op on unregistered ids

  // Reopen: re-register the (fake) handle, open the engine again —
  // the real Worker's REOPEN sequence minus the lock re-acquire.
  const id2 = corvidOpfs.register(handle);
  const db = glue.WasmDb.openOpfs(id2);
  const docs = db.collection('docs');
  expect(docs.len()).toBe(2);
  expect(docs.get('strong')).toEqual({ body: 'rust embedded database', n: 1 });
  expect(db.collections()).toEqual(['docs']);
  docs.close();
  db.close();
  expect(handle.closed).toBe(true);
});

test('a write while another handle id is registered is isolated per id', () => {
  const a = corvidOpfs.register(fakeHandle());
  const b = corvidOpfs.register(fakeHandle());

  const dbA = glue.WasmDb.openOpfs(a);
  dbA.collection('docs').insert('k', { n: 1 });
  const dbB = glue.WasmDb.openOpfs(b);
  expect(dbB.collection('docs').len()).toBe(0);
  expect(dbA.collection('docs').len()).toBe(1);
  dbA.close();
  dbB.close();
});

test('dump and load roundtrip the portable stream; loadWithRenames renames', () => {
  const src = corvidOpfs.register(fakeHandle());
  const db = glue.WasmDb.openOpfs(src);
  db.collection('docs').insert('k1', { n: 1 });
  db.collection('docs').insert('k2', { n: 2 });
  const bytes = db.dump();
  expect(bytes instanceof Uint8Array).toBe(true);
  expect(bytes.length).toBeGreaterThan(12);

  // Plain load into a fresh in-memory db: merge semantics.
  const mem = new glue.WasmDb();
  mem.load(bytes);
  expect(mem.collections()).toEqual(['docs']);
  expect(mem.collection('docs').len()).toBe(2);

  // Rename load: docs -> renamed.
  const mem2 = new glue.WasmDb();
  mem2.loadWithRenames(bytes, ['docs'], ['renamed']);
  expect(mem2.collections()).toEqual(['renamed']);
  expect(mem2.collection('renamed').get('k1')).toEqual({ n: 1 });

  // Non-parallel rename arrays are rejected before the stream is read.
  expect(thrownCode(() => mem2.loadWithRenames(bytes, ['docs'], []))).toBe(12);

  // Garbage is a clean InvalidDump.
  expect(thrownCode(() => mem2.load(new Uint8Array([1, 2, 3, 4])))).toBe(16);
  db.close();
});

test('backupOpfs copies into an independent reopenable backend', () => {
  const srcHandle = fakeHandle();
  const dstHandle = fakeHandle();
  const src = corvidOpfs.register(srcHandle);
  const db = glue.WasmDb.openOpfs(src);
  db.collection('docs').insert('k', { n: 1 });
  db.collection('docs').insert('k2', { n: 2 });

  const dst = corvidOpfs.register(dstHandle);
  db.backupOpfs(dst);
  // The backup destination Database dropped: its handle closed + unregistered.
  expect(dstHandle.closed).toBe(true);

  const dst2 = corvidOpfs.register(dstHandle);
  const restored = glue.WasmDb.openOpfs(dst2);
  expect(restored.collections()).toEqual(['docs']);
  expect(restored.collection('docs').len()).toBe(2);
  expect(restored.collection('docs').get('k')).toEqual({ n: 1 });
  restored.close();
  db.close();
});

test('quota exhaustion surfaces as a frozen code with the DOM text', () => {
  // redb over-allocates ~1 MiB at open, then SHRINKS on the first
  // commits (measured: 1,056,768 → 315,392 after 5 inserts) — so the
  // quota must sit at the probed open PEAK, and the corpus must be big
  // enough to grow past it again (32 KiB docs do).
  const probeId = corvidOpfs.register(fakeHandle());
  const probeDb = glue.WasmDb.openOpfs(probeId);
  const quotaAt = corvidOpfs.length(probeId);
  probeDb.close();
  expect(quotaAt).toBeGreaterThan(512 * 1024); // the over-allocation is real

  const id = corvidOpfs.register(fakeHandle({ quotaAt }));
  const db = glue.WasmDb.openOpfs(id);
  const docs = db.collection('docs');
  let err = null;
  try {
    for (let i = 0; i < 100; i += 1) {
      docs.insert(`k${i}`, { padding: 'x'.repeat(32768), n: i });
    }
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  const parsed = JSON.parse(err.message);
  // redb surfaces the failed write either at commit (5) or as storage
  // (4); both are frozen-table codes and the DOM text must ride along.
  expect([4, 5]).toContain(parsed.corvidCode);
  expect(parsed.corvidMessage).toMatch(/QuotaExceededError/);
  db.close();
});

test('register rejects legacy async sync-handles cleanly', () => {
  const legacy = fakeHandle();
  legacy.getSize = () => Promise.resolve(0);
  expect(() => corvidOpfs.register(legacy)).toThrow(/legacy asynchronous/);
});

test('openOpfs on an unknown handle id fails cleanly', () => {
  // The shim's unknown-id error crosses redb's OPEN path, which wraps
  // it as a DatabaseError — engine code 1, with the host text.
  expect(thrownCode(() => glue.WasmDb.openOpfs(9999))).toBe(1);
});
