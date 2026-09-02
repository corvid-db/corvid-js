'use strict';

/**
 * corvid-js — the idiomatic OOP surface over the wasm engine binding
 * (docs/PLAN.md §3): `Db`, `Collection`, `Query` fluent builder,
 * `field()` predicate builders, `CorvidError`.
 *
 * The engine is compiled to `wasm32-unknown-unknown` behind
 * wasm-bindgen typed exports (`./pkg/corvid_js.js`, built by
 * `npm run build`); this file wraps those classes with fluent
 * chaining, real `CorvidError`s, and the `CorvidFloat` marker.
 *
 * Initialization (the only async part of the API — every database
 * call is synchronous):
 * - Browsers / bundlers: `import { Db, init } from 'corvid-js';`
 *   `await init();` — then `new Db()`.
 * - Node (tests, examples, tooling): `import { Db } from
 *   'corvid-js/node'` — the node entry initializes the module
 *   synchronously from disk on import; no `init()` call needed.
 *
 * Persistence boundary: a `Db` is in-memory per session. wasm has no
 * filesystem; OPFS-backed persistence is a decided, trigger-based
 * future addition (README, docs/PLAN.md §5).
 */

import * as wasm from './pkg/corvid_js.js';
import initRaw from './pkg/corvid_js.js';

export function initSync(bytes) {
  return wasm.initSync(bytes);
}

/**
 * Initialize the wasm module (browsers): `await init(input?)` where
 * `input` is a `URL | Request | Response | ArrayBuffer | Uint8Array`;
 * by default the `.wasm` asset next to this module (via
 * `import.meta.url` — bundlers resolve that to an asset URL).
 */
export async function init(input) {
  return initRaw(input);
}

// -- errors ------------------------------------------------------------------

/** Engine error codes (the C ABI's frozen `corvid_err` table). */
export const ErrorCode = Object.freeze({
  Database: 1,
  Transaction: 2,
  Table: 3,
  Storage: 4,
  Commit: 5,
  SetDurability: 6,
  Compaction: 7,
  Decode: 8,
  CorruptIndex: 9,
  ReservedCollection: 10,
  InvalidName: 11,
  InvalidArgument: 12,
  IncompatibleFormat: 13,
  EmptyIndexTraining: 14,
  SchemaViolation: 15,
  InvalidDump: 16,
  BackupTargetExists: 17,
  Io: 18,
  Busy: 19,
});

/**
 * Every engine failure surfaces as a `CorvidError` carrying the C-ABI
 * error code (`e.code`, see {@link ErrorCode}) and the engine message.
 */
export class CorvidError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CorvidError';
    this.code = code;
  }
}

// The wasm layer throws plain Errors whose message carries the code as
// JSON (wasm-bindgen cannot attach properties to thrown errors).
function toCorvidError(e) {
  if (e instanceof CorvidError) return e;
  try {
    const wire = JSON.parse(e?.message ?? '');
    if (wire && typeof wire.corvidCode === 'number') {
      return new CorvidError(wire.corvidCode, String(wire.corvidMessage ?? ''));
    }
  } catch {
    /* not our wire form */
  }
  return e;
}

function call(fn, thisArg, args) {
  try {
    return fn.apply(thisArg, args);
  } catch (e) {
    throw toCorvidError(e);
  }
}

// -- typed floats --------------------------------------------------------------

/**
 * The value mapping sends integer-valued JS numbers to engine Ints
 * (`2` → Int). `CorvidFloat` forces the engine Float kind — the corner
 * where the distinction is observable: compare-and-set / unique
 * equality against stored `-0.0`-typed floats, and group-aggregation
 * key tags (`f:2` vs `i:2`).
 */
export class CorvidFloat extends Number {
  constructor(value) {
    super(value);
    /** Internal marker consumed by the wasm value mapping. */
    this.__corvidFloat = Number(value);
  }
}

// -- predicates ---------------------------------------------------------------

/**
 * Build a predicate over a (dotted) field path. Compose with
 * {@link and}/{@link or}/{@link not}: `and(field('n').gt(2), field('tag').eq('x'))`.
 *
 * @param {string} path
 */
export function field(path) {
  if (typeof path !== 'string') throw new CorvidError(ErrorCode.InvalidArgument, 'field() wants a dotted path string');
  return {
    eq: (value) => ({ op: 'cmp', path, cmp: 'eq', value }),
    ne: (value) => ({ op: 'cmp', path, cmp: 'ne', value }),
    lt: (value) => ({ op: 'cmp', path, cmp: 'lt', value }),
    le: (value) => ({ op: 'cmp', path, cmp: 'le', value }),
    gt: (value) => ({ op: 'cmp', path, cmp: 'gt', value }),
    ge: (value) => ({ op: 'cmp', path, cmp: 'ge', value }),
    exists: () => ({ op: 'exists', path }),
    in: (values) => ({ op: 'in', path, values }),
    between: (low, high) => ({ op: 'between', path, low, high }),
    startsWith: (prefix) => ({ op: 'startsWith', path, prefix }),
    contains: (substring) => ({ op: 'contains', path, substring }),
    withinKm: (lat, lon, radiusKm) => ({ op: 'geoWithin', path, lat, lon, radiusKm }),
  };
}

/** Logical AND of predicates. @param {...object} preds */
export function and(...preds) {
  if (preds.length === 0) throw new CorvidError(ErrorCode.InvalidArgument, 'and() needs at least one predicate');
  return { op: 'and', children: preds };
}

/** Logical OR of predicates. @param {...object} preds */
export function or(...preds) {
  if (preds.length === 0) throw new CorvidError(ErrorCode.InvalidArgument, 'or() needs at least one predicate');
  return { op: 'or', children: preds };
}

/** Logical NOT of a predicate. @param {object} pred */
export function not(pred) {
  return { op: 'not', child: pred };
}

// -- Db ------------------------------------------------------------------------

/**
 * An in-memory database handle — the shipped persistence boundary:
 * wasm has no filesystem, so every `Db` lives for the session (OPFS
 * persistence is a decided, trigger-based future addition; README).
 */
export class Db {
  #node;

  /**
   * Open a private, in-memory database (the constructor IS the
   * openMemory factory here — there is no file-backed form on wasm).
   */
  constructor() {
    this.#node = call(() => new wasm.WasmDb(), null, []);
  }

  /** Open a private, in-memory database (parity alias for `new Db()`). */
  static openMemory() {
    return new Db();
  }

  /** Acquire a collection handle (lazily created by the engine on first write). */
  collection(name) {
    return new Collection(call(this.#node.collection, this.#node, [name]));
  }

  /** The names of the database's collections. */
  collections() {
    return call(this.#node.collections, this.#node, []);
  }

  /**
   * Compact the database's storage. Requires quiescence: every
   * Collection / Query derived from this db must be closed or
   * executed, otherwise a `Busy` CorvidError is thrown. Returns
   * whether any data was moved out (on the in-memory store this is
   * the engine's housekeeping pass — there is no durability to flush).
   */
  compact() {
    return call(this.#node.compact, this.#node, []);
  }

  /** Close the handle (idempotent). Derived handles may outlive it. */
  close() {
    call(this.#node.close, this.#node, []);
  }

  [Symbol.for('Symbol.dispose')]() {
    this.close();
  }
}

// `using` support (TS 5.2+ / explicit-resource-management runtimes).
if (typeof Symbol.dispose === 'symbol') {
  Db.prototype[Symbol.dispose] = Db.prototype[Symbol.for('Symbol.dispose')];
}

// -- Collection ------------------------------------------------------------------

/** A collection handle: mutations, reads, TTL, indexes, schema, graph, geo, queries. */
export class Collection {
  #node;

  /** @private */
  constructor(node) {
    this.#node = node;
  }

  /** The collection's name. */
  get name() {
    return call(() => this.#node.name, null, []);
  }

  // mutations

  insert(key, doc) {
    call(this.#node.insert, this.#node, [key, doc]);
  }

  /** Bulk atomic insert (`put_many`): one transaction; a violating pair rolls the whole batch back. */
  insertMany(entries) {
    call(this.#node.insertMany, this.#node, [entries.map((e) => [e[0], e[1]])]);
  }

  /** Insert with an engine-generated key (20-digit, strictly monotonic per collection); returns the key. */
  insertAuto(doc) {
    return call(this.#node.insertAuto, this.#node, [doc]);
  }

  /**
   * Read-modify-write: the callback receives the current document (or
   * `null` when absent) and returns the new document — `null`/
   * `undefined` to delete. A throwing callback aborts
   * (InvalidArgument) and writes nothing.
   */
  update(key, fn) {
    call(this.#node.update, this.#node, [key, fn]);
  }

  /** Merge the top-level fields of `patch` into the document at `key` (creating it if absent). */
  patch(key, patch) {
    call(this.#node.patch, this.#node, [key, patch]);
  }

  /**
   * Atomically write `replacement` only if the current value equals
   * `expected` (`null` = must be absent; `replacement: null` deletes on
   * match). Returns whether the write was applied.
   */
  compareAndSet(key, expected, replacement) {
    return call(this.#node.compareAndSet, this.#node, [key, expected, replacement]);
  }

  /** Delete `key`; returns whether it existed. */
  delete(key) {
    return call(this.#node.delete, this.#node, [key]);
  }

  /** Delete every document matching `pred` (see {@link field}); returns the removed count. */
  deleteWhere(pred) {
    return call(this.#node.deleteWhere, this.#node, [pred]);
  }

  /** Delete a batch of keys; returns the removed count. */
  deleteBatch(keys) {
    return call(this.#node.deleteBatch, this.#node, [keys]);
  }

  // TTL

  /** Insert with an expiry instant (`expiresAt`, epoch units of your choosing). */
  insertWithTtl(key, doc, expiresAt) {
    call(this.#node.insertWithTtl, this.#node, [key, doc, expiresAt]);
  }

  /** Set (or clear, with `null`) the expiry for an existing key. */
  setTtl(key, expiresAt) {
    call(this.#node.setTtl, this.#node, [key, expiresAt]);
  }

  /** The key's expiry instant, or `null` when it has no TTL. */
  getTtl(key) {
    return call(this.#node.ttl, this.#node, [key]);
  }

  /** Remove every expired key as of `now`; returns the purged count. */
  purgeExpired(now) {
    return call(this.#node.purgeExpired, this.#node, [now]);
  }

  // reads

  /** The document at `key`, or `null` when absent. */
  get(key) {
    return call(this.#node.get, this.#node, [key]);
  }

  /** Every `{ key, doc }` in key order. */
  scan() {
    return call(this.#node.scanRows, this.#node, []);
  }

  /**
   * Stream with a callback `(key, doc) => boolean` — returning `false`
   * stops the walk early (not an error). Returns the rows visited.
   */
  scanEach(cb) {
    return call(this.#node.scanCb, this.#node, [cb]);
  }

  /**
   * Keyset pagination: up to `limit` rows strictly after `after`
   * (`null` starts at the beginning). Returns
   * `{ rows: [{key, doc}], next }` — `next` is the resume cursor or
   * `null` at the end.
   */
  page(after, limit) {
    return call(this.#node.page, this.#node, [after ?? null, limit]);
  }

  /** The number of documents. */
  len() {
    return call(this.#node.len, this.#node, []);
  }

  /** Whether the collection is empty. */
  isEmpty() {
    return call(this.#node.isEmpty, this.#node, []);
  }

  // direct search (v0.3.0 additive ABI)

  /**
   * Phrase search: up to `k` documents whose `field` contains `phrase`
   * as a consecutive, in-order run of analyzed tokens, most relevant
   * first — `[{ key, doc, score }]` with the BM25 phrase-sum score.
   * Order-sensitive adjacency; `k: 0` answers the empty result, never
   * an error.
   */
  phraseSearch(field, phrase, k) {
    return call(this.#node.phraseSearch, this.#node, [field, phrase, k]);
  }

  // indexes

  createScalarIndex(field) {
    call(this.#node.createScalarIndex, this.#node, [field]);
  }

  createCompoundIndex(fields) {
    call(this.#node.createCompoundIndex, this.#node, [fields]);
  }

  createTextIndex(field) {
    call(this.#node.createTextIndex, this.#node, [field]);
  }

  createTextIndexOndisk(field) {
    call(this.#node.createTextIndexOndisk, this.#node, [field]);
  }

  createGeoIndex(field) {
    call(this.#node.createGeoIndex, this.#node, [field]);
  }

  /** @param {'cosine'|'dot'|'l2'} metric */
  createVectorIndex(field, metric) {
    call(this.#node.createVectorIndex, this.#node, [field, metric]);
  }

  /** @param {'cosine'|'dot'|'l2'} metric @param {'none'|'binary'|'scalar'} quant */
  createVectorIndexQuantized(field, metric, quant) {
    call(this.#node.createVectorIndexQuantized, this.#node, [field, metric, quant]);
  }

  /** @param {'cosine'|'dot'|'l2'} metric */
  createVectorIndexOndisk(field, metric) {
    call(this.#node.createVectorIndexOndisk, this.#node, [field, metric]);
  }

  /** @param {'cosine'|'dot'|'l2'} metric @param {'none'|'binary'|'scalar'} quant */
  createVectorIndexOndiskQuantized(field, metric, quant) {
    call(this.#node.createVectorIndexOndiskQuantized, this.#node, [field, metric, quant]);
  }

  /** @param {'cosine'|'dot'|'l2'} metric */
  createVectorIndexPq(field, metric, m, k) {
    call(this.#node.createVectorIndexPq, this.#node, [field, metric, m, k]);
  }

  /** @param {'cosine'|'dot'|'l2'} metric */
  createVectorIndexOndiskPq(field, metric, m, k) {
    call(this.#node.createVectorIndexOndiskPq, this.#node, [field, metric, m, k]);
  }

  // schema

  /**
   * Declare the schema: `[{ name, type, required, unique }]` with
   * `type` one of `any|bool|int|float|text|bytes|vector|array|map`.
   * Replaces any previous declaration.
   */
  setSchema(fields) {
    call(this.#node.setSchema, this.#node, [
      fields.map((f) => ({ name: f.name, type: f.type, required: !!f.required, unique: !!f.unique })),
    ]);
  }

  /** The declared schema (`[{ name, type, required, unique }]`), or `null` when none. */
  schema() {
    return call(this.#node.schema, this.#node, []);
  }

  // graph

  link(from, relation, to) {
    call(this.#node.link, this.#node, [from, relation, to]);
  }

  linkWeighted(from, relation, to, weight) {
    call(this.#node.linkWeighted, this.#node, [from, relation, to, weight]);
  }

  /** Remove an edge; returns whether it existed. */
  unlink(from, relation, to) {
    return call(this.#node.unlink, this.#node, [from, relation, to]);
  }

  neighbors(from, relation) {
    return call(this.#node.neighbors, this.#node, [from, relation]);
  }

  inNeighbors(to, relation) {
    return call(this.#node.inNeighbors, this.#node, [to, relation]);
  }

  /** Weighted out-edges as `[{ key, weight }]`. */
  neighborsWeighted(from, relation) {
    return call(this.#node.neighborsWeighted, this.#node, [from, relation]);
  }

  /** BFS `hops` out over `relation` (cycle-safe). */
  traverse(start, relation, hops) {
    return call(this.#node.traverse, this.#node, [start, relation, hops]);
  }

  // geo

  /** Radius search, nearest first (ties by key): `[{ key, doc, distanceKm }]`. */
  geoWithinRadius(field, lat, lon, radiusKm) {
    return call(this.#node.geoWithinRadius, this.#node, [field, lat, lon, radiusKm]);
  }

  /** Bounding-box search (key order; no center, so distances are 0). */
  geoWithinBBox(field, minLat, minLon, maxLat, maxLon) {
    return call(this.#node.geoWithinBbox, this.#node, [field, minLat, minLon, maxLat, maxLon]);
  }

  /** The `k` nearest points: `[{ key, doc, distanceKm }]`. */
  geoNearest(field, lat, lon, k) {
    return call(this.#node.geoNearest, this.#node, [field, lat, lon, k]);
  }

  // queries

  /** Begin a fluent query over this collection. */
  query() {
    return new Query(call(this.#node.query, this.#node, []));
  }

  /** Release the handle (idempotent); also runs on GC. */
  close() {
    call(this.#node.close, this.#node, []);
  }

  [Symbol.for('Symbol.dispose')]() {
    this.close();
  }
}

if (typeof Symbol.dispose === 'symbol') {
  Collection.prototype[Symbol.dispose] = Collection.prototype[Symbol.for('Symbol.dispose')];
}

// -- Query -----------------------------------------------------------------------

/**
 * A fluent query builder (one per execution). Filter, add vector/text
 * sources, fuse (RRF) and rerank (MMR), then run a terminal operation:
 *
 * ```js
 * db.collection('docs')
 *   .query()
 *   .filter(field('kind').eq('doc'))
 *   .vector('v', probe, 10, 'cosine')
 *   .text('body', 'rust database', 10)
 *   .fuseRrf(60)
 *   .rerankMmr(1.0)
 *   .limit(5)
 *   .run(); // [{ key, doc, score }]
 * ```
 *
 * Terminal operations (`run` and every aggregation) consume the builder.
 */
export class Query {
  #node;

  /** @private */
  constructor(node) {
    this.#node = node;
  }

  /** Restrict to documents matching `pred` (multiple filters AND together). */
  filter(pred) {
    call(this.#node.filter, this.#node, [pred]);
    return this;
  }

  /** Add a vector source over `field` (`query` is a Float32Array), contributing up to `k` candidates. */
  vector(field, query, k, metric = 'cosine') {
    call(this.#node.vector, this.#node, [field, query, k, metric]);
    return this;
  }

  /** Add a BM25 text source over `field`, contributing up to `k` candidates. */
  text(field, query, k) {
    call(this.#node.text, this.#node, [field, query, k]);
    return this;
  }

  /** Set the Reciprocal Rank Fusion constant (default 60; validated at execution). */
  fuseRrf(k) {
    call(this.#node.fuseRrf, this.#node, [k]);
    return this;
  }

  /** Rerank fused candidates for diversity (lambda in [0, 1]; validated at execution). */
  rerankMmr(lambda) {
    call(this.#node.rerankMmr, this.#node, [lambda]);
    return this;
  }

  /** Prefer index-backed approximate execution where available. */
  approx() {
    call(this.#node.approx, this.#node, []);
    return this;
  }

  limit(n) {
    call(this.#node.limit, this.#node, [n]);
    return this;
  }

  offset(n) {
    call(this.#node.offset, this.#node, [n]);
    return this;
  }

  /** Order by `field` (numbers first in value order, missing-field rows last, ties by key). */
  orderBy(field, descending = false) {
    call(this.#node.orderBy, this.#node, [field, descending]);
    return this;
  }

  /** Project results to the named top-level fields. */
  select(fields) {
    call(this.#node.select, this.#node, [fields]);
    return this;
  }

  /** Execute; rows as `{ key, doc, score }[]` (score 0 for pure filter/order queries). */
  run() {
    return call(this.#node.run, this.#node, []);
  }

  /** Count matching documents (sources/ranking/limit ignored). */
  count() {
    return call(this.#node.count, this.#node, []);
  }

  countDistinct(field) {
    return call(this.#node.countDistinct, this.#node, [field]);
  }

  sum(field) {
    return call(this.#node.sum, this.#node, [field]);
  }

  /** The filtered mean, or `null` when no document has the field. */
  avg(field) {
    return call(this.#node.avg, this.#node, [field]);
  }

  min(field) {
    return call(this.#node.min, this.#node, [field]);
  }

  max(field) {
    return call(this.#node.max, this.#node, [field]);
  }

  /**
   * Group counts; the returned object's keys are the engine's group-key
   * formatting (text bare, int/float type-tagged `i:1` / `f:0.5`),
   * in ascending order — `Object.keys()`/entries preserve that order,
   * except that array-index-like text keys (e.g. `42`) are hoisted to
   * the front by JS numeric-key ordering; lookups by key are
   * unaffected.
   */
  groupCount(field) {
    return call(() => Object.fromEntries(this.#node.groupCount(field)), null, []);
  }

  groupSum(groupField, valueField) {
    return call(() => Object.fromEntries(this.#node.groupSum(groupField, valueField)), null, []);
  }

  groupAvg(groupField, valueField) {
    return call(() => Object.fromEntries(this.#node.groupAvg(groupField, valueField)), null, []);
  }

  /** Abandon the builder without executing. */
  close() {
    call(this.#node.close, this.#node, []);
  }

  [Symbol.for('Symbol.dispose')]() {
    this.close();
  }
}

if (typeof Symbol.dispose === 'symbol') {
  Query.prototype[Symbol.dispose] = Query.prototype[Symbol.for('Symbol.dispose')];
}

/** The FFI-ABI generation this binding covers (docs/FFI.md §1.3). */
export function ffiVersion() {
  return call(wasm.ffi_version, null, []);
}

// -- OPFS persistence (docs/OPFS-SPEC.md) --------------------------------------
//
// The async surface: persistent databases over OPFS, hosted in a
// dedicated Worker, Promises on every op. The sync classes above are
// untouched (in-memory per session — their contract stays pinned by
// regressions.spec.ts). `openOpfs` is browser-only; under Node use the
// sync surface via 'corvid-js/node'.

export { openOpfs, AsyncDb, AsyncCollection, AsyncQuery } from './opfs-async.js';
