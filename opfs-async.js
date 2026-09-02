// opfs-async.js — the async main-thread facade (docs/OPFS-SPEC.md §4).
//
// The Promise-flavored twin of the sync OOP surface: the same class
// taxonomy (Db/Collection/Query), the same semantics, one worker-hop
// per op. `openOpfs(name)` is the entry (the plan's ruling-6 sketch
// name `CorvidWorker` resolved per the OOP gate — SPEC §4.1); the sync
// surface is untouched. CorvidError is the shared error class; codes
// are the frozen 0–19 table, never extended.
//
// Facade-side contracts this file implements beyond the mechanical
// mirror:
//   - name validation (§5.1): nonempty, no path separators, not
//     ./.., ≤255 UTF-8 bytes → InvalidName (11) before anything async;
//   - the deep CorvidFloat unwrap (§4.4's second wire-level
//     difference): structured clone drops the marker, so every value
//     crossing is unwrapped to the plain-object marker form first;
//   - update() as get → fn → compareAndSet (§4.3): exact under the
//     OPFS single-writer model — no second writer can exist;
//   - scanEach() streaming with early-stop (§4.3);
//   - the poisoned-chain rule (§4.4): chain-op errors reject every
//     later result-carrying terminal; close() is exempt;
//   - GC release of abandoned handles via FinalizationRegistry
//     (§4.5), and the §5.3 close ordering (resolve after the worker
//     acked the full teardown).
//
// The storage-persistence trio (storageEstimate / requestPersistent-
// Storage / isPersistentStorage) calls navigator.storage on the MAIN
// thread — persist() is not available in Workers (SPEC §1.3-B11).

import { CorvidError, CorvidFloat } from './index.js';
import { WorkerLink } from './opfs-link.js';

function err(code, message) {
  return new CorvidError(code, message);
}

// -- names (SPEC §5.1) --------------------------------------------------------

const NAME_MAX_BYTES = 255;

function validateOpfsName(name) {
  const bad = (why) =>
    err(11, `invalid database name: ${JSON.stringify(name)} (${why})`);
  if (typeof name !== 'string' || name.length === 0) throw bad('empty');
  if (name === '.' || name === '..') throw bad('dot component');
  if (name.includes('/') || name.includes('\\')) throw bad('path separator');
  if (new TextEncoder().encode(name).length > NAME_MAX_BYTES) {
    throw bad(`over ${NAME_MAX_BYTES} UTF-8 bytes`);
  }
}

// -- the wire-value pass (SPEC §4.4) --------------------------------------------
//
// StructuredClone preserves primitive wrappers but drops own properties
// and subclass identity, so a CorvidFloat would cross as an unmarked
// boxed Number. The marker protocol's own plain-object form crosses
// verbatim — unwrap every instance, at any depth, in every value that
// rides the wire (documents, patches, CAS operands, predicate values).
//
// The same walk enforces the value mapping's input contract so both
// hosts behave identically: Map/Set/Date, functions, symbols, and
// CYCLIC structures reject with InvalidArgument (12) — exactly the
// inputs the sync surface rejects at the wasm boundary (the typed-array
// strictness note and the MAX_NESTING depth cap), instead of silently
// storing `{}` or overflowing the stack before the wire is reached.
// Plain class instances reconstruct as plain objects (equivalent to the
// sync layer storing their own enumerable properties). Typed arrays and
// null pass through untouched.

function wireValue(v, seen) {
  if (v === null) return v;
  const t = typeof v;
  if (t !== 'object') {
    if (t === 'function' || t === 'symbol') {
      throw err(12, `a ${t} is not a corvid value — use a plain form`);
    }
    return v;
  }
  if (v instanceof CorvidFloat) return { __corvidFloat: v.__corvidFloat };
  if (v instanceof Uint8Array || v instanceof Float32Array) return v;
  if (v instanceof Map || v instanceof Set || v instanceof Date) {
    throw err(
      12,
      `a ${v.constructor?.name ?? 'host object'} is not a corvid value — use a plain form`,
    );
  }
  if (Array.isArray(v)) {
    if (seen.has(v)) throw err(12, 'cyclic value');
    seen.add(v);
    const out = v.map((x) => wireValue(x, seen));
    seen.delete(v);
    return out;
  }
  if (seen.has(v)) throw err(12, 'cyclic value');
  seen.add(v);
  const out = {};
  for (const k of Object.keys(v)) out[k] = wireValue(v[k], seen);
  seen.delete(v);
  return out;
}

/// The public entry: a fresh seen-set per top-level value. The chain-op
/// path calls it inside a synchronous try (§4.4's timing contract);
/// async-op rejections come from the async `_call` wrapper.
function unwrapCorvidFloats(v) {
  return wireValue(v, new Set());
}

// -- GC release (SPEC §4.5) ----------------------------------------------------
//
// Registered for collections, queries, AND the db itself: an abandoned
// AsyncDb otherwise leaks its worker and with it the OPFS exclusive
// lock (every cross-tab open of that name failing 19 until page
// unload). The db's release runs the full close (teardown ack), then
// terminates the link.

const gcRegistry =
  typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry((held) => {
        if (held.terminate) {
          held.link
            .send({ op: 'db.close', h: held.h, ch: 0, a: [] })
            .catch(() => {})
            .finally(() => held.link.terminate());
        } else {
          held.link
            .send({ op: held.op, h: held.h, ch: held.ch ?? 0, a: [] })
            .catch(() => {});
        }
      })
    : null;

// -- open (SPEC §5.2) ----------------------------------------------------------

async function spawnAndOpen(name) {
  if (typeof Worker !== 'function') {
    throw err(
      12,
      'openOpfs requires a browser Worker environment (OPFS persistence); ' +
        "under Node use the sync surface via 'corvid-js/node'",
    );
  }
  const worker = new Worker(new URL('./opfs-worker.js', import.meta.url), {
    type: 'module',
  });
  const link = new WorkerLink(worker);
  try {
    const db = new AsyncDb(link, 1);
    await db._rpc('db.open', [name]);
    return db;
  } catch (e) {
    link.terminate();
    throw e;
  }
}

/**
 * Open (creating if absent) a persistent database backed by one OPFS
 * file (`<OPFS root>/corvid/<name>.corvid`), hosted in a dedicated
 * Worker. The returned facade's methods are Promises (the sync surface
 * stays synchronous and in-memory).
 *
 * `opts.persistent` (default `true`): request persistent storage for
 * the origin at open — best-effort; see `isPersistentStorage()`.
 */
export async function openOpfs(name, opts = {}) {
  validateOpfsName(name);
  if (opts.persistent !== false && globalThis.navigator?.storage?.persist) {
    try {
      await navigator.storage.persist(); // B11: main thread only
    } catch {
      /* best-effort; never fatal */
    }
  }
  return spawnAndOpen(name);
}

// -- AsyncDb (SPEC §4.2) -------------------------------------------------------

/**
 * A persistent OPFS database handle. Every method returns a Promise;
 * after `close()` resolves, later calls reject with code 1.
 */
export class AsyncDb {
  /** `openOpfs` as a static — parity with the sync `Db.openMemory()`. */
  static openOpfs(name, opts) {
    return openOpfs(name, opts);
  }

  /** @internal constructed by openOpfs (and the test links). */
  constructor(link, h) {
    this._link = link;
    this._h = h;
    this._nextHandle = h + 1;
    this._closed = false;
    gcRegistry?.register(this, { link, h, terminate: true }, this);
  }

  /** @internal the §5.3 liveness gate: every facade of a closed db fails with code 1. */
  _live() {
    if (this._closed) throw err(1, 'database is closed');
  }

  /** @internal allocate a derived-handle id. */
  _alloc() {
    const id = this._nextHandle;
    this._nextHandle += 1;
    return id;
  }

  /** @internal one op; closed handles fail fast with code 1. */
  async _rpc(op, a, h = this._h, ch = 0) {
    this._live();
    return this._link.send({ op, h, ch, a });
  }

  /** Acquire a collection handle (lazily created by the engine on first write). */
  async collection(name) {
    const h = this._alloc();
    await this._rpc('coll.create', [name], this._h, h);
    return new AsyncCollection(this, h, name);
  }

  /** The names of the database's collections. */
  collections() {
    return this._rpc('db.collections', []);
  }

  /**
   * Compact the database's storage. Requires quiescence (the
   * worker-side derived-handle gate, engine FFI.md §4.13); a violation
   * rejects with Busy (19).
   */
  compact() {
    return this._rpc('db.compact', []);
  }

  /** The v2 dump stream as bytes — the portable whole-database form. */
  dump() {
    return this._rpc('db.dump', []);
  }

  /** Replay a dump stream into this database (merge semantics). */
  async load(bytes) {
    await this._rpc('db.load', [bytes]);
  }

  /** Replay a dump stream, renaming collections per `renames`. */
  async loadWithRenames(bytes, renames) {
    await this._rpc('db.load', [bytes, renames]);
  }

  /**
   * Physical backup into `name` (a sibling under the `corvid/` OPFS
   * directory). An existing target rejects with code 17; a failed
   * backup leaves no debris. Feature-configuration-sensitive like the
   * native backup — `dump`/`load` is the portable path.
   */
  async backupTo(name) {
    validateOpfsName(name);
    await this._rpc('db.backupTo', [name]);
  }

  /** Origin-wide storage usage estimate (imprecise by design — MDN). */
  async storageEstimate() {
    if (!globalThis.navigator?.storage?.estimate) {
      throw err(18, 'navigator.storage.estimate is unavailable');
    }
    return navigator.storage.estimate();
  }

  /** Best-effort persistent-storage request (main thread — B11). */
  async requestPersistentStorage() {
    if (!globalThis.navigator?.storage?.persist) {
      throw err(18, 'navigator.storage.persist is unavailable');
    }
    return navigator.storage.persist();
  }

  /** Whether the origin's storage is persistent. */
  async isPersistentStorage() {
    if (!globalThis.navigator?.storage?.persisted) {
      throw err(18, 'navigator.storage.persisted is unavailable');
    }
    return navigator.storage.persisted();
  }

  /**
   * Close the database: every derived handle is torn down, the engine
   * drops, the sync handle flushes/closes/unregisters, the worker
   * acks, and only then does this resolve — the OPFS lock is free the
   * moment `close()` does (SPEC §5.3). Idempotent.
   */
  async close() {
    if (this._closed) return;
    this._closed = true;
    gcRegistry?.unregister(this);
    try {
      await this._link.send({ op: 'db.close', h: this._h, ch: 0, a: [] });
    } finally {
      this._link.terminate();
    }
  }

  [Symbol.asyncDispose]() {
    return this.close();
  }
}

// -- AsyncCollection (SPEC §4.3) -----------------------------------------------

/**
 * A collection handle — the 1:1 Promise-flavored mirror of the sync
 * `Collection`, with the three specified deviations: `name` is a sync
 * facade-local getter, `update` composes get→fn→CAS on the main
 * thread (exact under OPFS single-writer), and `scanEach` streams.
 */
export class AsyncCollection {
  /** @internal constructed by AsyncDb.collection(). */
  constructor(db, h, name) {
    this._db = db;
    this._h = h;
    this._name = name;
    this._closed = false;
    gcRegistry?.register(this, { link: db._link, op: 'coll.gc', h });
  }

  /** The collection's name (facade-local — no worker round-trip). */
  get name() {
    return this._name;
  }

  async _call(method, ...args) {
    // Both closed states fail fast with code 1 — the §5.3 rule for
    // every facade of a closed db, and this handle's own close. The
    // async wrapper makes the wire-value pass REJECT (not throw):
    // Map/Set/Date, functions, symbols, and cycles arrive here as
    // InvalidArgument (12), matching the sync surface's wasm-boundary
    // rejections instead of silently storing `{}`.
    this._live();
    return this._db._rpc(
      'coll.call',
      [method, ...args.map(unwrapCorvidFloats)],
      this._h,
    );
  }

  /** @internal both-closed gate. */
  _live() {
    if (this._closed) throw err(1, 'collection handle is closed');
    this._db._live();
  }

  // mutations

  insert(key, doc) {
    return this._call('insert', key, doc);
  }

  /** Bulk atomic insert (`insertMany`): one transaction; a violating pair rolls back the batch. */
  insertMany(entries) {
    return this._call('insertMany', entries);
  }

  /** Insert with an engine-generated key; resolves to the key. */
  insertAuto(doc) {
    return this._call('insertAuto', doc);
  }

  /**
   * Read-modify-write: `fn` receives the current document (or `null`
   * when absent) and returns the new document — `null`/`undefined` to
   * delete. Composed as get → fn → compareAndSet; exact (not a race)
   * because OPFS single-writer means no second writer can interleave.
   * A throwing `fn` rejects with InvalidArgument and writes nothing.
   */
  async update(key, fn) {
    const current = await this.get(key);
    let next;
    try {
      next = await fn(current);
    } catch (e) {
      throw err(12, `update callback threw: ${e?.message ?? e}`);
    }
    if (next === undefined) next = null;
    // `current` is engine output (plain, already decoded) — no unwrap;
    // the single-writer model makes this get→CAS pair exact.
    return this._call('compareAndSet', key, current, next);
  }

  /** Merge the top-level fields of `patch` into the document at `key`. */
  patch(key, patch) {
    return this._call('patch', key, patch);
  }

  /**
   * Write `replacement` only if the current value equals `expected`
   * (`null` = must be absent; `replacement: null` deletes on match).
   * Resolves to whether the write applied.
   */
  compareAndSet(key, expected, replacement) {
    return this._call('compareAndSet', key, expected, replacement);
  }

  /** Delete `key`; resolves to whether it existed. */
  delete(key) {
    return this._call('delete', key);
  }

  /** Delete every document matching `pred`; resolves to the count. */
  deleteWhere(pred) {
    return this._call('deleteWhere', pred);
  }

  /** Delete a batch of keys; resolves to the removed count. */
  deleteBatch(keys) {
    return this._call('deleteBatch', keys);
  }

  // TTL

  insertWithTtl(key, doc, expiresAt) {
    return this._call('insertWithTtl', key, doc, expiresAt);
  }

  setTtl(key, expiresAt) {
    return this._call('setTtl', key, expiresAt);
  }

  getTtl(key) {
    // The glue method is `ttl`; the public name matches the sync surface.
    return this._call('ttl', key);
  }

  purgeExpired(now) {
    return this._call('purgeExpired', now);
  }

  // reads

  get(key) {
    return this._call('get', key);
  }

  scan() {
    return this._call('scanRows');
  }

  /**
   * Stream with `cb(key, doc) => boolean|void`: rows arrive in chunks
   * from the worker; returning `false` stops the walk early (not an
   * error). A THROWING callback cancels the walk and rejects with the
   * callback's own error — the sync surface's propagation, kept
   * identical on both hosts. Resolves to the rows visited; memory
   * stays bounded by the chunk, not the collection.
   */
  async scanEach(cb) {
    this._live();
    let visited = 0;
    let thrown = null;
    await this._db._link.send(
      { op: 'coll.scanEach', h: this._h, ch: 0, a: [] },
      {
        onChunk: async (rows) => {
          for (const row of rows) {
            if (thrown) return 'cancel';
            visited += 1;
            try {
              if (cb(row.key, row.doc) === false) return 'cancel';
            } catch (e) {
              thrown = e; // surfaced after the walk unwinds
              return 'cancel';
            }
          }
          return 'cont';
        },
      },
    );
    if (thrown) throw thrown;
    return visited;
  }

  /** Keyset pagination: `{ rows, next }` — `next` is the resume cursor or `null`. */
  page(after, limit) {
    return this._call('page', after, limit);
  }

  len() {
    return this._call('len');
  }

  isEmpty() {
    return this._call('isEmpty');
  }

  // direct search (v0.3.0 additive ABI)

  phraseSearch(field, phrase, k) {
    return this._call('phraseSearch', field, phrase, k);
  }

  // indexes

  createScalarIndex(field) {
    return this._call('createScalarIndex', field);
  }
  createCompoundIndex(fields) {
    return this._call('createCompoundIndex', fields);
  }
  createTextIndex(field) {
    return this._call('createTextIndex', field);
  }
  createTextIndexOndisk(field) {
    return this._call('createTextIndexOndisk', field);
  }
  createGeoIndex(field) {
    return this._call('createGeoIndex', field);
  }
  createVectorIndex(field, metric) {
    return this._call('createVectorIndex', field, metric);
  }
  createVectorIndexQuantized(field, metric, quant) {
    return this._call('createVectorIndexQuantized', field, metric, quant);
  }
  createVectorIndexOndisk(field, metric) {
    return this._call('createVectorIndexOndisk', field, metric);
  }
  createVectorIndexOndiskQuantized(field, metric, quant) {
    return this._call('createVectorIndexOndiskQuantized', field, metric, quant);
  }
  createVectorIndexPq(field, metric, m, k) {
    return this._call('createVectorIndexPq', field, metric, m, k);
  }
  createVectorIndexOndiskPq(field, metric, m, k) {
    return this._call('createVectorIndexOndiskPq', field, metric, m, k);
  }

  // schema

  setSchema(fields) {
    return this._call('setSchema', fields);
  }

  schema() {
    return this._call('schema');
  }

  // graph

  link(from, relation, to) {
    return this._call('link', from, relation, to);
  }
  linkWeighted(from, relation, to, weight) {
    return this._call('linkWeighted', from, relation, to, weight);
  }
  unlink(from, relation, to) {
    return this._call('unlink', from, relation, to);
  }
  neighbors(from, relation) {
    return this._call('neighbors', from, relation);
  }
  inNeighbors(to, relation) {
    return this._call('inNeighbors', to, relation);
  }
  neighborsWeighted(from, relation) {
    return this._call('neighborsWeighted', from, relation);
  }
  traverse(start, relation, hops) {
    return this._call('traverse', start, relation, hops);
  }

  // geo

  geoWithinRadius(field, lat, lon, radiusKm) {
    return this._call('geoWithinRadius', field, lat, lon, radiusKm);
  }
  geoWithinBBox(field, minLat, minLon, maxLat, maxLon) {
    return this._call('geoWithinBbox', field, minLat, minLon, maxLat, maxLon);
  }
  geoNearest(field, lat, lon, k) {
    return this._call('geoNearest', field, lat, lon, k);
  }

  // queries

  /** Begin a fluent query over this collection (chain synchronously, terminals are Promises). */
  query() {
    return new AsyncQuery(this);
  }

  /** Release the handle (idempotent; also runs on GC). */
  async close() {
    if (this._closed) return;
    this._closed = true;
    gcRegistry?.unregister(this);
    // A closed db (or its terminated worker) must reject, not hang:
    // the §5.3 rule covers every facade op after db.close().
    this._db._live();
    await this._db._link.send({ op: 'coll.close', h: this._h, ch: 0, a: [] });
  }

  [Symbol.asyncDispose]() {
    return this.close();
  }
}

// -- AsyncQuery (SPEC §4.4) ----------------------------------------------------

/**
 * A fluent query builder: chain methods are synchronous and enqueue
 * (errors poison every later result-carrying terminal — the spec's
 * rule, not a surprise); terminal operations return Promises.
 * `close()` is exempt from poisoning and always releases the builder.
 */
export class AsyncQuery {
  /** @internal constructed by AsyncCollection.query(). */
  constructor(coll) {
    this._coll = coll;
    this._db = coll._db;
    this._h = coll._db._alloc();
    this._chain = [];
    this._done = false;
    this._released = false;
    gcRegistry?.register(this, { link: coll._db._link, op: 'query.gc', h: this._h });
  }

  _chainOp(method, ...args) {
    if (this._done) throw err(1, 'query handle is closed');
    this._db._live(); // a closed db rejects here — synchronously
    // §4.4's timing contract: wire-value violations (functions,
    // symbols, Map/Set/Date, cycles) throw AT THE ENQUEUE CALL, not
    // as terminal poison.
    const wired = args.map(unwrapCorvidFloats);
    const p = this._db._link.send({
      op: 'query.op',
      h: this._h,
      ch: this._coll._h,
      a: [method, ...wired],
    });
    // A dropped poisoned chain must not leave an unhandled rejection;
    // Promise.all below still sees the failure through `p`.
    p.catch(() => {});
    this._chain.push(p);
    return this;
  }

  async _release() {
    if (this._released) return;
    this._released = true;
    this._done = true;
    gcRegistry?.unregister(this);
    this._db._live();
    await this._db._link.send({ op: 'query.close', h: this._h, ch: this._coll._h, a: [] });
  }

  async _terminal(method, ...args) {
    // close() is exempt from BOTH guards: after a terminal (consumed
    // builder) and after a poisoned chain, it still resolves — the
    // sync twin's idempotent close, kept for `await using`.
    if (this._done && method !== 'close') throw err(1, 'query handle is closed');
    this._db._live();
    try {
      // Poisoning (§4.4): chain replies arrive before the terminal's
      // (FIFO), so awaiting them first surfaces the chain's own error.
      await Promise.all(this._chain);
    } catch (e) {
      if (method === 'close') {
        await this._release().catch(() => {}); // close is poison-exempt
        return undefined;
      }
      throw e;
    }
    if (method === 'close') {
      await this._release();
      return undefined;
    }
    this._done = true; // terminals consume the builder
    gcRegistry?.unregister(this);
    return this._db._link.send({
      op: 'query.terminal',
      h: this._h,
      ch: this._coll._h,
      a: [method, ...args],
    });
  }

  filter(pred) {
    return this._chainOp('filter', pred); // unwrapped by _chainOp's pass
  }

  vector(field, query, k, metric = 'cosine') {
    return this._chainOp('vector', field, query, k, metric);
  }

  text(field, query, k) {
    return this._chainOp('text', field, query, k);
  }

  fuseRrf(k) {
    return this._chainOp('fuseRrf', k);
  }

  rerankMmr(lambda) {
    return this._chainOp('rerankMmr', lambda);
  }

  approx() {
    return this._chainOp('approx');
  }

  limit(n) {
    return this._chainOp('limit', n);
  }

  offset(n) {
    return this._chainOp('offset', n);
  }

  orderBy(field, descending = false) {
    return this._chainOp('orderBy', field, descending);
  }

  select(fields) {
    return this._chainOp('select', fields);
  }

  run() {
    return this._terminal('run');
  }

  count() {
    return this._terminal('count');
  }

  countDistinct(field) {
    return this._terminal('countDistinct', field);
  }

  sum(field) {
    return this._terminal('sum', field);
  }

  avg(field) {
    return this._terminal('avg', field);
  }

  min(field) {
    return this._terminal('min', field);
  }

  max(field) {
    return this._terminal('max', field);
  }

  groupCount(field) {
    // The raw wasm group aggregations return entries arrays; the sync
    // surface converts with Object.fromEntries — same public shape.
    return this._terminal('groupCount', field).then(Object.fromEntries);
  }

  groupSum(groupField, valueField) {
    return this._terminal('groupSum', groupField, valueField).then(Object.fromEntries);
  }

  groupAvg(groupField, valueField) {
    return this._terminal('groupAvg', groupField, valueField).then(Object.fromEntries);
  }

  /** Abandon the builder without executing (poison-exempt). */
  close() {
    return this._terminal('close');
  }

  [Symbol.asyncDispose]() {
    return this.close();
  }
}
