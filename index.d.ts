/**
 * corvid-js — public types for the idiomatic OOP surface.
 *
 * Value mapping (JS ↔ engine):
 * - `null`/`undefined` ↔ Null; `boolean` ↔ Bool; `string` ↔ Text
 * - `number` ↔ Int when integer-valued (not `-0`, within ±2^53), else
 *   Float; `bigint` ↔ Int (full i64 range); `CorvidFloat` forces Float
 * - `Uint8Array` (Buffer included) ↔ Bytes; `Float32Array` ↔ Vector;
 *   `Array` ↔ Array; plain object ↔ Map (string keys)
 * - Reading back: Int → `number` (or `bigint` beyond ±2^53), Float →
 *   `number` — f64 bits preserved **except NaN payloads**, which
 *   canonicalize across the JS↔wasm Number boundary (`-0.0`, `inf`,
 *   `-inf` survive bit-exactly; vector elements keep their f32 bits).
 *
 * Persistence: the sync surface (Db/Collection/Query) is in-memory per
 * session; OPFS persistence is the async surface (`openOpfs` /
 * AsyncDb / AsyncCollection / AsyncQuery, docs/OPFS-SPEC.md) — one OPFS
 * file per database hosted in a dedicated Worker.
 */

/** Initialize the wasm module synchronously (Node/deno hosts with the bytes on disk). */
export function initSync(bytes: BufferSource): void;

/**
 * Initialize the wasm module (browsers): `await init(input?)` —
 * `input` is a `URL | Request | Response | BufferSource`; by default
 * the `.wasm` asset next to the module. The only async part of the
 * API; every database call after it is synchronous.
 */
export function init(input?: URL | Request | Response | BufferSource): Promise<void>;

/** A dotted field path for predicate building. */
export interface FieldRef {
  eq(value: unknown): Predicate;
  ne(value: unknown): Predicate;
  lt(value: unknown): Predicate;
  le(value: unknown): Predicate;
  gt(value: unknown): Predicate;
  ge(value: unknown): Predicate;
  exists(): Predicate;
  in(values: unknown[]): Predicate;
  between(low: unknown, high: unknown): Predicate;
  startsWith(prefix: string): Predicate;
  contains(substring: string): Predicate;
  withinKm(lat: number, lon: number, radiusKm: number): Predicate;
}

/** An opaque predicate (built via {@link field}, {@link and}, {@link or}, {@link not}). */
export declare class Predicate {
  private constructor();
}

/** Engine error codes (the C ABI's frozen `corvid_err` table). */
export declare const ErrorCode: Readonly<{
  Database: 1;
  Transaction: 2;
  Table: 3;
  Storage: 4;
  Commit: 5;
  SetDurability: 6;
  Compaction: 7;
  Decode: 8;
  CorruptIndex: 9;
  ReservedCollection: 10;
  InvalidName: 11;
  InvalidArgument: 12;
  IncompatibleFormat: 13;
  EmptyIndexTraining: 14;
  SchemaViolation: 15;
  InvalidDump: 16;
  BackupTargetExists: 17;
  Io: 18;
  Busy: 19;
}>;

/** Every engine failure: `code` (see {@link ErrorCode}) + the engine message. */
export declare class CorvidError extends Error {
  readonly code: number;
}

/**
 * Forces the engine Float kind for an integer-valued double (JS `2`
 * maps to Int). The distinction is observable in compare-and-set /
 * unique equality against stored floats and in group-aggregation key
 * tags. Escape-hatch cost: a plain object whose single own key is
 * `__corvidFloat` is consumed by the marker protocol, so such an
 * object cannot itself be stored as a Map (rename the field or add a
 * second key).
 */
export declare class CorvidFloat {
  constructor(value: number);
}

export type Metric = 'cosine' | 'dot' | 'l2';
export type Quantization = 'none' | 'binary' | 'scalar';
export type FieldType =
  | 'any'
  | 'bool'
  | 'int'
  | 'float'
  | 'text'
  | 'bytes'
  | 'vector'
  | 'array'
  | 'map';

/** A document key: a string (UTF-8) or a Uint8Array (raw bytes). */
export type Key = string | Uint8Array;

export interface SchemaField {
  name: string;
  type: FieldType;
  required?: boolean;
  unique?: boolean;
}

export interface Row {
  key: Key;
  doc: any;
  score: number;
}

export interface GeoHit {
  key: Key;
  doc: any;
  distanceKm: number;
}

export interface Page {
  rows: { key: Key; doc: any }[];
  next: Key | null;
}

/**
 * An in-memory database handle — the shipped persistence boundary:
 * wasm has no filesystem, so every `Db` lives for the session (OPFS
 * persistence is a decided, trigger-based future addition).
 */
export declare class Db {
  /** Open a private, in-memory database. */
  constructor();

  /** Open a private, in-memory database (parity alias for `new Db()`). */
  static openMemory(): Db;

  /** Acquire a collection handle (lazily created by the engine on first write). */
  collection(name: string): Collection;

  /** The names of the database's collections. */
  collections(): string[];

  /**
   * Compact the database's storage. Requires quiescence: every
   * Collection / Query derived from this db must be closed or
   * executed, otherwise a `Busy` CorvidError is thrown. Returns
   * whether any data was moved out.
   */
  compact(): boolean;

  /** Close the handle (idempotent). Derived handles may outlive it. */
  close(): void;

  [Symbol.dispose](): void;
}

/** A collection handle: mutations, reads, TTL, indexes, schema, graph, geo, queries. */
export declare class Collection {
  private constructor();

  /** The collection's name. */
  get name(): string;

  // mutations

  insert(key: Key, doc: unknown): void;

  /** Bulk atomic insert (`put_many`): one transaction; a violating pair rolls the whole batch back. */
  insertMany(entries: [Key, unknown][]): void;

  /** Insert with an engine-generated key (20-digit, strictly monotonic per collection); returns the key. */
  insertAuto(doc: unknown): Key;

  /**
   * Read-modify-write: the callback receives the current document (or
   * `null` when absent) and returns the new document — `null`/
   * `undefined` to delete. A throwing callback aborts
   * (InvalidArgument) and writes nothing.
   */
  update(key: Key, fn: (current: unknown) => unknown): void;

  /** Merge the top-level fields of `patch` into the document at `key` (creating it if absent). */
  patch(key: Key, patch: unknown): void;

  /**
   * Atomically write `replacement` only if the current value equals
   * `expected` (`null` = must be absent; `replacement: null` deletes on
   * match). Returns whether the write was applied.
   */
  compareAndSet(key: Key, expected: unknown, replacement: unknown): boolean;

  /** Delete `key`; returns whether it existed. */
  delete(key: Key): boolean;

  /** Delete every document matching `pred` (see {@link field}); returns the removed count. */
  deleteWhere(pred: Predicate): number;

  /** Delete a batch of keys; returns the removed count. */
  deleteBatch(keys: Key[]): number;

  // TTL

  /** Insert with an expiry instant (`expiresAt`, epoch units of your choosing). */
  insertWithTtl(key: Key, doc: unknown, expiresAt: number): void;

  /** Set (or replace) the expiry for an existing key (epoch units of your choosing). */
  setTtl(key: Key, expiresAt: number): void;

  /** The key's expiry instant, or `null` when it has no TTL. */
  getTtl(key: Key): number | null;

  /** Remove every expired key as of `now`; returns the purged count. */
  purgeExpired(now: number): number;

  // reads

  /** The document at `key`, or `null` when absent. */
  get(key: Key): unknown;

  /** Every `{ key, doc }` in key order. */
  scan(): { key: Key; doc: unknown }[];

  /**
   * Stream with a callback `(key, doc) => boolean` — returning `false`
   * stops the walk early (not an error). Returns the rows visited.
   */
  scanEach(cb: (key: Key, doc: unknown) => boolean | void): number;

  /**
   * Keyset pagination: up to `limit` rows strictly after `after`
   * (`null` starts at the beginning). Returns `{ rows, next }` —
   * `next` is the resume cursor or `null` at the end.
   */
  page(after: Key | null, limit: number): Page;

  /** The number of documents. */
  len(): number;

  /** Whether the collection is empty. */
  isEmpty(): boolean;

  // direct search (v0.3.0 additive ABI)

  /**
   * Phrase search: up to `k` documents whose `field` contains `phrase`
   * as a consecutive, in-order run of analyzed tokens, most relevant
   * first — `Row[]` with the BM25 phrase-sum score (the direct fn's
   * scale, not the builder's RRF). `k: 0` answers empty, never errors.
   */
  phraseSearch(field: string, phrase: string, k: number): Row[];

  // indexes

  createScalarIndex(field: string): void;
  createCompoundIndex(fields: string[]): void;
  createTextIndex(field: string): void;
  createTextIndexOndisk(field: string): void;
  createGeoIndex(field: string): void;
  createVectorIndex(field: string, metric: Metric): void;
  createVectorIndexQuantized(field: string, metric: Metric, quant: Quantization): void;
  createVectorIndexOndisk(field: string, metric: Metric): void;
  createVectorIndexOndiskQuantized(field: string, metric: Metric, quant: Quantization): void;
  createVectorIndexPq(field: string, metric: Metric, m: number, k: number): void;
  createVectorIndexOndiskPq(field: string, metric: Metric, m: number, k: number): void;

  // schema

  /**
   * Declare the schema: `[{ name, type, required, unique }]` with
   * `type` one of `any|bool|int|float|text|bytes|vector|array|map`.
   * Replaces any previous declaration.
   */
  setSchema(fields: SchemaField[]): void;

  /** The declared schema, or `null` when none. */
  schema(): SchemaField[] | null;

  // graph

  link(from: Key, relation: string, to: Key): void;
  linkWeighted(from: Key, relation: string, to: Key, weight: number): void;

  /** Remove an edge; returns whether it existed. */
  unlink(from: Key, relation: string, to: Key): boolean;

  neighbors(from: Key, relation: string): Key[];
  inNeighbors(to: Key, relation: string): Key[];

  /** Weighted out-edges as `[{ key, weight }]`. */
  neighborsWeighted(from: Key, relation: string): { key: Key; weight: number }[];

  /** BFS `hops` out over `relation` (cycle-safe). */
  traverse(start: Key, relation: string, hops: number): Key[];

  // geo

  /** Radius search, nearest first (ties by key). */
  geoWithinRadius(field: string, lat: number, lon: number, radiusKm: number): GeoHit[];

  /** Bounding-box search (key order; no center, so distances are 0). */
  geoWithinBBox(field: string, minLat: number, minLon: number, maxLat: number, maxLon: number): GeoHit[];

  /** The `k` nearest points. */
  geoNearest(field: string, lat: number, lon: number, k: number): GeoHit[];

  // queries

  /** Begin a fluent query over this collection. */
  query(): Query;

  /** Release the handle (idempotent); also runs on GC. */
  close(): void;

  [Symbol.dispose](): void;
}

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
export declare class Query {
  private constructor();

  /** Restrict to documents matching `pred` (multiple filters AND together). */
  filter(pred: Predicate): this;

  /** Add a vector source over `field` (`query` is a Float32Array), contributing up to `k` candidates. */
  vector(field: string, query: Float32Array, k: number, metric?: Metric): this;

  /** Add a BM25 text source over `field`, contributing up to `k` candidates. */
  text(field: string, query: string, k: number): this;

  /** Set the Reciprocal Rank Fusion constant (default 60; validated at execution). */
  fuseRrf(k: number): this;

  /** Rerank fused candidates for diversity (lambda in [0, 1]; validated at execution). */
  rerankMmr(lambda: number): this;

  /** Prefer index-backed approximate execution where available. */
  approx(): this;

  limit(n: number): this;
  offset(n: number): this;

  /** Order by `field` (numbers first in value order, missing-field rows last, ties by key). */
  orderBy(field: string, descending?: boolean): this;

  /** Project results to the named top-level fields. */
  select(fields: string[]): this;

  /** Execute; rows as `{ key, doc, score }[]` (score 0 for pure filter/order queries). */
  run(): Row[];

  /** Count matching documents (sources/ranking/limit ignored). */
  count(): number;

  countDistinct(field: string): number;
  sum(field: string): number;

  /** The filtered mean, or `null` when no document has the field. */
  avg(field: string): number | null;

  min(field: string): unknown;
  max(field: string): unknown;

  /**
   * Group counts; the returned object's keys are the engine's group-key
   * formatting (text bare, int/float type-tagged `i:1` / `f:0.5`), in
   * ascending order — except that array-index-like text keys (e.g.
   * `42`) are hoisted to the front by JS numeric-key ordering; lookups
   * by key are unaffected.
   */
  groupCount(field: string): Record<string, number>;
  groupSum(groupField: string, valueField: string): Record<string, number>;
  groupAvg(groupField: string, valueField: string): Record<string, number>;

  /** Abandon the builder without executing. */
  close(): void;

  [Symbol.dispose](): void;
}

/** Build a predicate over a dotted field path. */
export function field(path: string): FieldRef;

/** Logical AND of predicates. */
export function and(...preds: Predicate[]): Predicate;

/** Logical OR of predicates. */
export function or(...preds: Predicate[]): Predicate;

/** Logical NOT of a predicate. */
export function not(pred: Predicate): Predicate;

/** The FFI-ABI generation this binding covers (docs/FFI.md §1.3). */
export function ffiVersion(): number;

// -- OPFS persistence (docs/OPFS-SPEC.md §4) -----------------------------------
//
// The async mirror of the sync surface: persistent databases over OPFS
// (one file per database, `<OPFS root>/corvid/<name>.corvid`), hosted
// in a dedicated Worker. Every method returns a Promise; the sync
// classes above stay synchronous and in-memory. `field`/`and`/`or`/
// `not`, `CorvidFloat`, `ErrorCode`, and the value mapping are shared
// with the sync surface. Browser-only: under Node import the sync
// surface from 'corvid-js/node'.

/** Options for {@link openOpfs}. */
export interface OpenOpfsOptions {
  /**
   * Request persistent storage for the origin at open (best-effort,
   * default `true`; see {@link AsyncDb.isPersistentStorage}). Never
   * fatal when the browser refuses.
   */
  persistent?: boolean;
}

/**
 * Open (creating if absent) a persistent OPFS database. A second open
 * of the same name while the first is live rejects with `Busy` (19) —
 * the cross-tab single-writer contract. The database lives until
 * `close()` resolves; after that, the lock is free and the file can be
 * reopened.
 */
export function openOpfs(name: string, opts?: OpenOpfsOptions): Promise<AsyncDb>;

/**
 * A persistent OPFS database handle — the Promise-flavored twin of
 * {@link Db}. After `close()` resolves, later calls reject with code 1.
 */
export declare class AsyncDb {
  /** {@link openOpfs} as a static — parity with `Db.openMemory()`. */
  static openOpfs(name: string, opts?: OpenOpfsOptions): Promise<AsyncDb>;

  private constructor();

  /** Acquire a collection handle (lazily created by the engine on first write). */
  collection(name: string): Promise<AsyncCollection>;

  /** The names of the database's collections. */
  collections(): Promise<string[]>;

  /**
   * Compact the database's storage. Requires quiescence (every
   * AsyncCollection/AsyncQuery derived from this db closed or
   * executed), otherwise rejects with `Busy` (19).
   */
  compact(): Promise<boolean>;

  /** The v2 dump stream as bytes — the portable whole-database form. */
  dump(): Promise<Uint8Array>;

  /** Replay a dump stream into this database (merge semantics). */
  load(bytes: Uint8Array): Promise<void>;

  /** Replay a dump stream, renaming collections per `renames`. */
  loadWithRenames(bytes: Uint8Array, renames: Record<string, string>): Promise<void>;

  /**
   * Physical backup into `name` (a sibling under the `corvid/` OPFS
   * directory). An existing target rejects with code 17; a failed
   * backup leaves no debris. Feature-configuration-sensitive like the
   * native backup — `dump`/`load` is the portable path.
   */
  backupTo(name: string): Promise<void>;

  /**
   * Origin-wide storage estimate (`{usage, quota}`) — deliberately
   * imprecise by platform design; includes OPFS usage.
   */
  storageEstimate(): Promise<{ usage: number; quota: number }>;

  /** Best-effort persistent-storage request; whether it was granted. */
  requestPersistentStorage(): Promise<boolean>;

  /** Whether the origin's storage is currently persistent. */
  isPersistentStorage(): Promise<boolean>;

  /**
   * Close the database and release the OPFS lock. Resolves only after
   * the worker has torn everything down (SPEC §5.3) — the moment this
   * resolves, the file can be reopened. Idempotent.
   */
  close(): Promise<void>;

  [Symbol.asyncDispose](): Promise<void>;
}

/** A collection handle — the Promise-flavored mirror of {@link Collection}. */
export declare class AsyncCollection {
  private constructor();

  /** The collection's name (facade-local — no round-trip). */
  get name(): string;

  // mutations

  insert(key: Key, doc: unknown): Promise<void>;
  insertMany(entries: [Key, unknown][]): Promise<void>;
  insertAuto(doc: unknown): Promise<Key>;

  /**
   * Read-modify-write: the callback receives the current document (or
   * `null` when absent) and returns the new document — `null`/
   * `undefined` to delete. Exact (not a race) under OPFS single-writer.
   * A throwing callback rejects with `InvalidArgument` and writes nothing.
   */
  update(key: Key, fn: (current: unknown) => unknown): Promise<boolean>;

  patch(key: Key, patch: unknown): Promise<void>;
  compareAndSet(key: Key, expected: unknown, replacement: unknown): Promise<boolean>;
  delete(key: Key): Promise<boolean>;
  deleteWhere(pred: Predicate): Promise<number>;
  deleteBatch(keys: Key[]): Promise<number>;

  // TTL

  insertWithTtl(key: Key, doc: unknown, expiresAt: number): Promise<void>;
  /**
   * Set (or replace) `key`'s expiry instant (`expiresAt`, epoch units
   * of your choosing — the engine keeps no clock; `purgeExpired`
   * compares against your `now`). There is no clear-TTL operation in
   * the engine or the C ABI: passing `null` coerces to `0` (an expiry
   * at instant 0), exactly as the sync surface does.
   */
  setTtl(key: Key, expiresAt: number): Promise<void>;
  getTtl(key: Key): Promise<number | null>;
  purgeExpired(now: number): Promise<number>;

  // reads

  get(key: Key): Promise<unknown>;
  scan(): Promise<{ key: Key; doc: unknown }[]>;

  /**
   * Stream with a callback `(key, doc) => boolean` — returning `false`
   * stops the walk early (not an error). Resolves to the rows visited;
   * memory stays bounded by the transport chunk, not the collection.
   */
  scanEach(cb: (key: Key, doc: unknown) => boolean | void): Promise<number>;

  page(after: Key | null, limit: number): Promise<Page>;
  len(): Promise<number>;
  isEmpty(): Promise<boolean>;

  // direct search

  phraseSearch(field: string, phrase: string, k: number): Promise<Row[]>;

  // indexes (all eleven variants, same semantics as the sync surface)

  createScalarIndex(field: string): Promise<void>;
  createCompoundIndex(fields: string[]): Promise<void>;
  createTextIndex(field: string): Promise<void>;
  createTextIndexOndisk(field: string): Promise<void>;
  createGeoIndex(field: string): Promise<void>;
  createVectorIndex(field: string, metric: Metric): Promise<void>;
  createVectorIndexQuantized(field: string, metric: Metric, quant: Quantization): Promise<void>;
  createVectorIndexOndisk(field: string, metric: Metric): Promise<void>;
  createVectorIndexOndiskQuantized(field: string, metric: Metric, quant: Quantization): Promise<void>;
  createVectorIndexPq(field: string, metric: Metric, m: number, k: number): Promise<void>;
  createVectorIndexOndiskPq(field: string, metric: Metric, m: number, k: number): Promise<void>;

  // schema

  setSchema(fields: SchemaField[]): Promise<void>;
  schema(): Promise<SchemaField[] | null>;

  // graph

  link(from: Key, relation: string, to: Key): Promise<void>;
  linkWeighted(from: Key, relation: string, to: Key, weight: number): Promise<void>;
  unlink(from: Key, relation: string, to: Key): Promise<boolean>;
  neighbors(from: Key, relation: string): Promise<Key[]>;
  inNeighbors(to: Key, relation: string): Promise<Key[]>;
  neighborsWeighted(from: Key, relation: string): Promise<{ key: Key; weight: number }[]>;
  traverse(start: Key, relation: string, hops: number): Promise<Key[]>;

  // geo

  geoWithinRadius(field: string, lat: number, lon: number, radiusKm: number): Promise<GeoHit[]>;
  geoWithinBBox(field: string, minLat: number, minLon: number, maxLat: number, maxLon: number): Promise<GeoHit[]>;
  geoNearest(field: string, lat: number, lon: number, k: number): Promise<GeoHit[]>;

  // queries

  /** Begin a fluent query (chain synchronously; terminals are Promises). */
  query(): AsyncQuery;

  /** Release the handle (idempotent; also runs on GC). */
  close(): Promise<void>;

  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * A fluent query builder — the async twin of {@link Query}. Chain
 * methods are synchronous and return `this`; a chain method whose
 * argument the sync layer would reject instead poisons the chain (the
 * first error rejects every later result-carrying terminal).
 * `close()` is exempt from poisoning.
 */
export declare class AsyncQuery {
  private constructor();

  filter(pred: Predicate): this;
  vector(field: string, query: Float32Array, k: number, metric?: Metric): this;
  text(field: string, query: string, k: number): this;
  fuseRrf(k: number): this;
  rerankMmr(lambda: number): this;
  approx(): this;
  limit(n: number): this;
  offset(n: number): this;
  orderBy(field: string, descending?: boolean): this;
  select(fields: string[]): this;

  run(): Promise<Row[]>;
  count(): Promise<number>;
  countDistinct(field: string): Promise<number>;
  sum(field: string): Promise<number>;
  avg(field: string): Promise<number | null>;
  min(field: string): Promise<unknown>;
  max(field: string): Promise<unknown>;
  groupCount(field: string): Promise<Record<string, number>>;
  groupSum(groupField: string, valueField: string): Promise<Record<string, number>>;
  groupAvg(groupField: string, valueField: string): Promise<Record<string, number>>;

  /** Abandon the builder without executing (poison-exempt). */
  close(): Promise<void>;

  [Symbol.asyncDispose](): Promise<void>;
}
