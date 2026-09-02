/**
 * golden.spec.ts — the golden-suite port for corvid-js.
 *
 * Replays the engine's committed fixture suite (test/golden/*.txt —
 * vendored verbatim from the corvid v0.3.0 release, the same files the
 * C smoke suite drives) against this binding's public OOP surface
 * (index.js): one OP<TAB>args<TAB>expected line at a time, every line
 * dispatched, every expectation checked. The fixtures are test-time
 * inputs — the binding itself parses nothing.
 *
 * Which files are vendored, and why six of eight: values, mutations,
 * queries, schema, graph, geo run on in-memory databases and are
 * vendored whole (230 executable lines, including the v0.3.0
 * VMAP_KEYS and PHRASE additions). persist.txt and admin.txt are NOT
 * vendored: every scenario in them is anchored on FILEDB/REOPEN/
 * DUMP/LOAD — the wasm persistence boundary (docs/PLAN.md §5: wasm
 * has no filesystem; OPFS persistence is a decided, trigger-based
 * deferral). The in-memory-executable contracts those files also
 * pinned (the compact quiescence gate, collections listing, session
 * durability) are held by test/regressions.spec.ts instead. A fixture
 * line this harness cannot run is NOT silently skipped — unknown OPs
 * throw, and the pre-scan/count divergence check below turns any
 * dispatch-loop skip into a failure.
 *
 * Where the suite runs: node's wasm runtime, via the package's node
 * entry (`corvid-js/node`) — the same wasm binary browsers load. The
 * engine's semantics under node's WebAssembly and a browser's are
 * identical (both instantiate the same module); browser-test
 * infrastructure, when it exists, will run this same spec against
 * `await init()` — documented as the CI choice in docs/PLAN.md §7.
 *
 * Port conventions (mirroring c/smoke.c in the engine repo):
 *   - '#' lines and blank lines are ignored (not counted executable);
 *     an independent pre-scan counts executable lines so a dispatch
 *     loop that silently skips a line diverges from `executed`.
 *   - Value literals: null true false | -123 | 3.5 | inf -inf |
 *     bits:0x… (f64 from bits) | bits32:0x… (f32) | t(text) | b(bytes)
 *     | vec(1.5,bits32:0x…,2) | [a,b] | {k=v,k2=v2}.
 *   - Computed doubles (distances, scores, sums) expect `~x` (1e-6
 *     relative tolerance); stored literals compare bit-exactly where
 *     JS can observe bits — NaN payloads are the documented exception
 *     (V8/wasm canonicalize them across the Number boundary, like the
 *     N-API boundary corvid-node documents), so NaN expectations
 *     compare as NaN-class equality; `-0.0`/`±inf` and Float32Array
 *     element bits are exact.
 *   - Value ops round-trip through a scratch in-memory db (insert +
 *     get): the JS↔engine value mapping lives inside the wasm layer,
 *     so crossing the boundary is what the values.txt lines prove.
 *   - VMAP_KEYS/GET_KEYS (the v0.3.0 additive ABI's
 *     corvid_value_map_keys) map onto `Object.keys()` of the mapped
 *     document — plain objects, engine insertion order (ascending key
 *     bytes); non-maps enumerate empty, matching the ABI's inert
 *     empty cursor.
 *   - VPUSH/VPUT mutate the materialized JS copy (vacuous w.r.t. the
 *     binding — the stored engine value is untouched — but the
 *     legitimate analog of the fixture's in-place value mutation).
 *   - PHRASE (the v0.3.0 additive ABI's corvid_phrase_search) runs
 *     through `Collection.phraseSearch` — the direct fn, BM25
 *     phrase-sum scores, not the builder's RRF.
 */

import { afterAll, beforeAll, expect, test } from 'vitest';

// The fixture language (tokenizing, literals, comparison) lives in the
// shared helper so the browser conformance harness parses with the
// SAME grammar — one language, two hosts.
import {
  bytesOf,
  checkValue,
  doubleMatches,
  errCode,
  isDigits,
  isPlainObject,
  listBody,
  mapKeysOf,
  numbersEqual,
  parseDouble,
  parseLiteral,
  render,
  splitTop,
  textBody,
  valuesEqual,
  walkPath,
} from './helpers/fixture-lang.js';

// Entry-agnostic (docs/PLAN.md §7's promise cashed): Node runs against
// the synchronous node entry; the browser leg (vitest --browser) runs
// the SAME spec against the browser entry after `await init()`. The
// wasm binary, the classes, and the calls are identical either way.
import type { Db, Collection } from '../index.js';

const isBrowser = typeof window !== 'undefined';
const surface = isBrowser
  ? await import('../index.js').then(async (m) => {
      await m.init();
      return m;
    })
  : await import('../node.mjs');
const { Db: DbC, CorvidError, CorvidFloat, field, and, or, not, ffiVersion } = surface;

// Fixture texts via vite's raw glob — works identically in Node and
// browser vitest runs (no node:fs in the spec).
const fixtureTexts = import.meta.glob('./golden/*.txt', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const FILES = [
  'values.txt',
  'mutations.txt',
  'queries.txt',
  'schema.txt',
  'graph.txt',
  'geo.txt',
];

// ---------------------------------------------------------------------------
// Predicate helpers over the literal grammar
// ---------------------------------------------------------------------------

type Cmp = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge';

function cmpPred(path: string, op: string, valLit: string) {
  const f = field(path) as Record<string, (v: unknown) => unknown>;
  return f[op as Cmp](parseLiteral(valLit)) as object;
}

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

const scenarios: string[] = [];

class Scenario {
  db: Db | null = null;
  coll: Collection | null = null;
  scratch: Db;

  constructor(public file: string) {
    // values.txt runs against no scenario db (the scratch db below is
    // harness-internal: the mapping needs a boundary crossing).
    this.scratch = new DbC();
  }

  closeColl(): void {
    if (this.coll) {
      this.coll.close();
      this.coll = null;
    }
  }

  closeDb(): void {
    this.closeColl();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  docs(): Collection {
    if (!this.coll) {
      if (!this.db) throw new Error(`no database open (${this.file})`);
      this.coll = this.db.collection('docs');
    }
    return this.coll;
  }

  openMemory(): void {
    this.closeDb();
    this.db = new DbC();
    this.docs();
  }

  /** Round-trip a literal through the engine (the boundary crossing). */
  rt(litTok: string): unknown {
    const coll = this.scratch.collection('v');
    coll.insert('k', parseLiteral(litTok));
    const got = coll.get('k');
    coll.close();
    return got;
  }
}

function expectError(fn: () => unknown, code: number, ctx: string): void {
  let threw: unknown = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  if (!threw) throw new Error(`${ctx}: expected a CorvidError with code ${code}, nothing threw`);
  if (!(threw instanceof CorvidError)) throw new Error(`${ctx}: threw ${String(threw)} (not a CorvidError)`);
  expect(threw.code, `${ctx}: error code`).toBe(code);
  expect(typeof threw.message === 'string' && threw.message.length > 0, `${ctx}: error message present`).toBe(true);
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'bigint') return 'int';
  if (typeof v === 'number') return 'float';
  if (typeof v === 'string') return 'text';
  if (v instanceof Uint8Array) return 'bytes';
  if (v instanceof Float32Array) return 'vector';
  if (Array.isArray(v)) return 'array';
  if (isPlainObject(v)) return 'map';
  throw new Error(`no type name for ${render(v)}`);
}

function lengthOf(v: unknown): number {
  if (typeof v === 'string') return v.length; // UTF-16 units (ASCII fixtures)
  if (Array.isArray(v) || v instanceof Uint8Array || v instanceof Float32Array) return v.length;
  if (isPlainObject(v)) return Object.keys(v).length;
  return 0;
}

function parseMetric(s: string): 'cosine' | 'dot' | 'l2' {
  if (s === 'cosine' || s === 'dot' || s === 'l2') return s;
  throw new Error(`bad metric '${s}'`);
}

function parseQuant(s: string): 'none' | 'binary' | 'scalar' {
  if (s === 'none' || s === 'binary' || s === 'scalar') return s;
  throw new Error(`bad quant '${s}'`);
}

const FIELD_TYPES = ['any', 'bool', 'int', 'float', 'text', 'bytes', 'vector', 'array', 'map'] as const;

function parseFieldType(s: string): (typeof FIELD_TYPES)[number] {
  const i = FIELD_TYPES.indexOf(s as (typeof FIELD_TYPES)[number]);
  if (i < 0) throw new Error(`bad field type '${s}'`);
  return FIELD_TYPES[i];
}

function rowKeys(rows: { key: unknown }[]): string[] {
  return rows.map((r) => String(r.key));
}

function checkKeys(keys: string[], expected: string, ctx: string): void {
  const want = listBody(expected);
  const wanted = want === '' ? [] : splitTop(want);
  expect(keys, `${ctx}: row keys`).toEqual(wanted);
}

function checkScores(scores: number[], suffix: string, ctx: string): void {
  if (!suffix) return;
  if (!suffix.startsWith('|')) throw new Error(`score suffix must start with |`);
  const body = suffix.slice(1);
  if (!body) return;
  const toks = splitTop(body);
  expect(scores.length, `${ctx}: score count`).toBe(toks.length);
  toks.forEach((tok, i) => {
    expect(doubleMatches(scores[i], tok), `${ctx}: row ${i} score ${scores[i]} vs '${tok}'`).toBe(true);
  });
}

function splitExpected(expected: string): { keyPart: string; suffix: string } {
  const at = expected.indexOf('|');
  return at < 0 ? { keyPart: expected, suffix: '' } : { keyPart: expected.slice(0, at), suffix: expected.slice(at) };
}

function groupPairs(expected: string): [string, string][] {
  if (!expected.startsWith('g(') || !expected.endsWith(')')) throw new Error(`group expectation must be g(...), got '${expected}'`);
  return splitTop(expected.slice(2, -1)).map((pair) => {
    const at = pair.indexOf('=');
    if (at < 0) throw new Error(`group pair needs key=val, got '${pair}'`);
    return [pair.slice(0, at), pair.slice(at + 1)];
  });
}

function checkGroups(obj: Record<string, number>, expected: string, ctx: string): void {
  const pairs = groupPairs(expected);
  const gotKeys = Object.keys(obj);
  expect(gotKeys, `${ctx}: group keys`).toEqual(pairs.map(([k]) => k));
  pairs.forEach(([k, v]) => {
    expect(doubleMatches(obj[k], v), `${ctx}: group '${k}' value ${obj[k]} vs '${v}'`).toBe(true);
  });
}

// ---------------------------------------------------------------------------
// OP dispatch
// ---------------------------------------------------------------------------

function runLine(s: Scenario, op: string, args: string[], expected: string, ctx: string): void {
  const a = args;

  // ---- pure value ops (boundary crossings through the scratch db) ----
  if (op === 'VERSION') {
    expect(ffiVersion(), `${ctx}: FFI version`).toBe(1);
    return;
  }
  if (op === 'VTYPE') {
    expect(typeName(s.rt(a[0])), `${ctx}: type`).toBe(expected);
    return;
  }
  if (op === 'VLEN') {
    expect(lengthOf(s.rt(a[0])), `${ctx}: length`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'VAS_INT') {
    // Engine Ints surface as JS numbers when safe and BigInts at the
    // extremes; the fixture's ok-cases are the extremes, so bigint-ness
    // is the as-int probe (a Float literal maps to an unmarked number).
    const got = s.rt(a[0]);
    if (expected === 'fail') {
      expect(typeof got === 'bigint', `${ctx}: as_int unexpectedly ok (${render(got)})`).toBe(false);
    } else {
      expect(typeof got, `${ctx}: as_int type`).toBe('bigint');
      expect(`ok:${got}`, `${ctx}: as_int`).toBe(expected);
    }
    return;
  }
  if (op === 'VAS_FLOAT') {
    const got = s.rt(a[0]);
    if (expected === 'fail') {
      expect(typeof got === 'number', `${ctx}: as_float unexpectedly ok`).toBe(false);
    } else {
      expect(typeof got, `${ctx}: as_float type`).toBe('number');
      expect(doubleMatches(got, expected.slice(3)), `${ctx}: as_float bits`).toBe(true);
    }
    return;
  }
  if (op === 'VAS_BOOL') {
    const got = s.rt(a[0]);
    if (expected === 'fail') {
      expect(typeof got === 'boolean', `${ctx}: as_bool unexpectedly ok`).toBe(false);
    } else {
      expect(typeof got, `${ctx}: as_bool type`).toBe('boolean');
      expect(`ok:${got ? 1 : 0}`, `${ctx}: as_bool`).toBe(expected);
    }
    return;
  }
  if (op === 'VTEXT_REF') {
    const got = s.rt(a[0]);
    expect(typeof got === 'string' && got === textBody(expected), `${ctx}: text bytes differ`).toBe(true);
    return;
  }
  if (op === 'VBYTES_REF') {
    const got = s.rt(a[0]);
    expect(
      got instanceof Uint8Array && valuesEqual(got, bytesOf(expected.slice(2, -1))),
      `${ctx}: bytes differ`,
    ).toBe(true);
    return;
  }
  if (op === 'VVECTOR_REF') {
    const got = s.rt(a[0]);
    const rebuilt = parseLiteral(a[0]);
    expect(valuesEqual(got, rebuilt), `${ctx}: vector bits differ`).toBe(true);
    return;
  }
  if (op === 'VNEST' || op === 'VCLONE') {
    // VCLONE round-trips twice: the second materialization is the
    // clone-analog (independent JS objects from the same stored value).
    const got = s.rt(a[0]);
    if (op === 'VCLONE') void s.rt(a[0]);
    const child = walkPath(got, a[1]);
    if (expected === 'absent') expect(child, `${ctx}: unexpectedly present`).toBeUndefined();
    else checkValue(child, expected, ctx);
    return;
  }
  if (op === 'VMAP_KEYS') {
    // The v0.3.0 additive ABI's map_keys: ascending key-byte order on
    // the mapped object; non-maps enumerate empty (inert, not error).
    checkKeys(mapKeysOf(s.rt(a[0])), expected, ctx);
    return;
  }
  if (op === 'VPUSH') {
    const arr = s.rt(a[0]) as unknown[];
    arr.push(parseLiteral(a[1]));
    expect(arr.length, `${ctx}: array length`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'VPUT') {
    const obj = s.rt(a[0]) as Record<string, unknown>;
    obj[a[1]] = parseLiteral(a[2]);
    expect(Object.keys(obj).length, `${ctx}: map size`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'NULLFREES') {
    // Every close()/dispose is idempotent — the free(NULL) analog.
    const db2 = new DbC();
    const c2 = db2.collection('x');
    c2.close();
    c2.close();
    db2.close();
    db2.close();
    return;
  }

  // ---- db-required ops ----
  if (op === 'COLL') {
    s.closeColl();
    s.coll = s.db!.collection(a[0]);
    expect(s.coll.name, `${ctx}: collection_name round trip`).toBe(a[0]);
    return;
  }
  if (op === 'INSERT' || op === 'INSERT_ERR') {
    const docs = s.docs();
    const fn = () => docs.insert(a[0], parseLiteral(a[1]));
    if (op === 'INSERT_ERR') expectError(fn, errCode(expected), ctx);
    else fn();
    return;
  }
  if (op === 'LEN') {
    expect(s.docs().len(), `${ctx}: len`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'GET' || op === 'GETFIELD') {
    const got = s.docs().get(a[0]);
    if (op === 'GETFIELD') {
      if (got === null) throw new Error(`${ctx}: GETFIELD on an absent document`);
      const child = walkPath(got, a[1]);
      if (expected === 'absent') expect(child, `${ctx}: field unexpectedly present`).toBeUndefined();
      else checkValue(child, expected, ctx);
    } else if (expected === 'absent') {
      expect(got, `${ctx}: expected absence`).toBeNull();
    } else {
      if (got === null) throw new Error(`${ctx}: expected a document, got absence`);
      checkValue(got, expected, ctx);
    }
    return;
  }
  if (op === 'GET_KEYS') {
    // map_keys over a DECODED document: every key survives the storage
    // round trip, ascending byte order.
    const got = s.docs().get(a[0]);
    if (got === null) throw new Error(`${ctx}: GET_KEYS on an absent document`);
    checkKeys(mapKeysOf(got), expected, ctx);
    return;
  }
  if (op === 'PUTMANY' || op === 'PUTMANY_ROLLBACK') {
    if (a.length % 2 !== 0) throw new Error(`${ctx}: PUTMANY wants key/literal pairs`);
    const entries: [string, unknown][] = [];
    for (let i = 0; i < a.length; i += 2) entries.push([a[i], parseLiteral(a[i + 1])]);
    const docs = s.docs();
    const fn = () => docs.insertMany(entries);
    if (op === 'PUTMANY_ROLLBACK') expectError(fn, errCode(expected), ctx);
    else fn();
    return;
  }
  if (op === 'INSERT_AUTO') {
    const key = s.docs().insertAuto(parseLiteral(a[0]));
    expect(typeof key === 'string' && /^\d{20}$/.test(key), `${ctx}: auto key format (${key})`).toBe(true);
    return;
  }
  if (op === 'UPDATE') {
    s.docs().update(a[0], (cur) => ({ n: ((cur as { n: number } | null)?.n ?? 0) + 1 }));
    return;
  }
  if (op === 'UPDATE_ABORT') {
    expectError(
      () => s.docs().update(a[0], () => { throw new Error('abort'); }),
      12,
      ctx,
    );
    return;
  }
  if (op === 'PATCH') {
    s.docs().patch(a[0], parseLiteral(a[1]));
    return;
  }
  if (op === 'CAS') {
    const applied = s.docs().compareAndSet(
      a[0],
      a[1] === 'absent' ? null : parseLiteral(a[1]),
      a[2] === 'absent' ? null : parseLiteral(a[2]),
    );
    expect(applied ? 'applied:1' : 'applied:0', `${ctx}: CAS applied`).toBe(expected);
    return;
  }
  if (op === 'DELETE') {
    const existed = s.docs().delete(a[0]);
    expect(existed ? 'existed:1' : 'existed:0', `${ctx}: delete existed`).toBe(expected);
    return;
  }
  if (op === 'DELETE_WHERE') {
    const removed = s.docs().deleteWhere(cmpPred(a[0], a[1], a[2]));
    expect(`removed:${removed}`, `${ctx}: removed count`).toBe(expected);
    return;
  }
  if (op === 'DELETE_IN') {
    const removed = s.docs().deleteWhere(field(a[0]).in(a.slice(1).map((t) => parseLiteral(t))));
    expect(`removed:${removed}`, `${ctx}: removed count`).toBe(expected);
    return;
  }
  if (op === 'DELETE_BATCH') {
    const removed = s.docs().deleteBatch(a);
    expect(`removed:${removed}`, `${ctx}: removed count`).toBe(expected);
    return;
  }
  if (op === 'INSERT_TTL') {
    s.docs().insertWithTtl(a[0], parseLiteral(a[1]), parseInt(a[2], 10));
    return;
  }
  if (op === 'GET_TTL') {
    const ttl = s.docs().getTtl(a[0]);
    expect(ttl === null ? 'nottl' : `ttl:${ttl}`, `${ctx}: ttl`).toBe(expected);
    return;
  }
  if (op === 'SET_TTL') {
    s.docs().setTtl(a[0], parseInt(a[1], 10));
    return;
  }
  if (op === 'PURGE') {
    const purged = s.docs().purgeExpired(parseInt(a[0], 10));
    expect(`purged:${purged}`, `${ctx}: purged count`).toBe(expected);
    return;
  }
  if (op === 'SCAN' || op === 'SCAN_STOP') {
    const stop = op === 'SCAN_STOP' ? parseInt(a[0], 10) : 0;
    let visited = 0;
    const n = s.docs().scanEach(() => {
      visited++;
      return !(stop > 0 && visited >= stop);
    });
    expect(n, `${ctx}: scanned`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'PAGE') {
    const after = a[0] === '-' ? null : a[0];
    const limit = parseInt(a[1], 10);
    const page = s.docs().page(after, limit);
    const { keyPart, suffix } = splitExpected(expected);
    checkKeys(rowKeys(page.rows), keyPart, ctx);
    expect(page.next === null ? '|end' : '|more', `${ctx}: page cursor`).toBe(suffix);
    return;
  }

  // ---- predicates + queries ----
  const filteredCount = (pred: object): number => s.docs().query().filter(pred).count();
  if (op === 'QF_COUNT') {
    expect(filteredCount(cmpPred(a[0], a[1], a[2])), `${ctx}: filtered count`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'QF_EXISTS') {
    expect(filteredCount(field(a[0]).exists()), `${ctx}: filtered count`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'QF_BETWEEN') {
    expect(filteredCount(field(a[0]).between(parseLiteral(a[1]), parseLiteral(a[2]))), `${ctx}: filtered count`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'QF_STARTS' || op === 'QF_CONTAINS') {
    const body = textBody(a[1]);
    const pred = op === 'QF_STARTS' ? field(a[0]).startsWith(body) : field(a[0]).contains(body);
    expect(filteredCount(pred), `${ctx}: filtered count`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'QF_GEO') {
    expect(filteredCount(field(a[0]).withinKm(parseDouble(a[1]), parseDouble(a[2]), parseDouble(a[3]))), `${ctx}: filtered count`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'QF_AND' || op === 'QF_OR') {
    const pred = op === 'QF_AND'
      ? and(cmpPred(a[0], a[1], a[2]), cmpPred(a[3], a[4], a[5]))
      : or(cmpPred(a[0], a[1], a[2]), cmpPred(a[3], a[4], a[5]));
    expect(filteredCount(pred), `${ctx}: filtered count`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'QF_NOT') {
    expect(filteredCount(not(cmpPred(a[0], a[1], a[2]))), `${ctx}: filtered count`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'PRED_FREE') {
    // The never-consumed-root free path: in JS the descriptor is plain
    // garbage — building it and dropping it must be a no-op.
    void cmpPred(a[0], a[1], a[2]);
    return;
  }
  if (op === 'Q_ABANDON') {
    s.docs().query().close(); // the abandoned-builder free path
    return;
  }
  if (op === 'QVEC' || op === 'APPROX') {
    const q = s.docs().query();
    if (op === 'APPROX') q.approx();
    q.vector(a[0], parseLiteral(a[1]) as Float32Array, parseInt(a[2], 10), 'cosine');
    const rows = q.run();
    const { keyPart, suffix } = splitExpected(expected);
    checkKeys(rowKeys(rows), keyPart, ctx);
    checkScores(rows.map((r) => r.score), suffix, ctx);
    return;
  }
  if (op === 'QTEXT') {
    const rows = s.docs().query().text(a[0], textBody(a[1]), parseInt(a[2], 10)).run();
    checkKeys(rowKeys(rows), expected, ctx);
    return;
  }
  if (op === 'PHRASE' || op === 'PHRASE_K0') {
    // The v0.3.0 additive ABI's direct phrase search: BM25 phrase-sum
    // scores (TextHit's scale), order-sensitive adjacency, k==0 inert.
    const hits = s.docs().phraseSearch(a[0], textBody(a[1]), parseInt(a[2], 10));
    const { keyPart, suffix } = splitExpected(expected);
    checkKeys(rowKeys(hits), keyPart, ctx);
    checkScores(hits.map((r) => r.score), suffix, ctx);
    return;
  }
  if (op === 'HYBRID' || op === 'HYBRID_F') {
    const tagged = op === 'HYBRID_F';
    const vk = parseInt(a[2], 10);
    const tk = parseInt(a[5], 10);
    const limit = parseInt(tagged ? a[7] : a[6], 10);
    const q = s.docs().query();
    q.filter(tagged ? field('tag').eq(parseLiteral(a[6])) : field('kind').eq('doc'));
    q.vector(a[0], parseLiteral(a[1]) as Float32Array, vk, 'cosine');
    q.text(a[3], textBody(a[4]), tk);
    q.fuseRrf(60);
    q.rerankMmr(1.0);
    q.limit(limit);
    const rows = q.run();
    const { keyPart, suffix } = splitExpected(expected);
    checkKeys(rowKeys(rows), keyPart, ctx);
    checkScores(rows.map((r) => r.score), suffix, ctx);
    return;
  }
  if (op === 'ORDER_BY') {
    const rows = s.docs()
      .query()
      .orderBy(a[0], parseInt(a[1], 10) === 1)
      .offset(parseInt(a[2], 10))
      .limit(parseInt(a[3], 10))
      .run();
    checkKeys(rowKeys(rows), expected, ctx);
    return;
  }
  if (op === 'SELECT') {
    if (!a[0].startsWith('(') || !a[0].endsWith(')')) throw new Error(`${ctx}: SELECT's first arg must be a (field,...) group`);
    const fields = splitTop(a[0].slice(1, -1));
    const wantKey = listBody(a[1]);
    const rows = s.docs().query().select(fields).run();
    const row = rows.find((r) => String(r.key) === wantKey);
    if (!row) throw new Error(`${ctx}: row '${wantKey}' not in the result`);
    checkValue(row.doc, expected, ctx);
    return;
  }
  if (op === 'AGG_COUNT') {
    expect(s.docs().query().count(), `${ctx}: count`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'AGG_DISTINCT') {
    expect(s.docs().query().countDistinct(a[0]), `${ctx}: countDistinct`).toBe(parseInt(expected, 10));
    return;
  }
  if (op === 'AGG_SUM') {
    expect(doubleMatches(s.docs().query().sum(a[0]), expected), `${ctx}: sum`).toBe(true);
    return;
  }
  if (op === 'AGG_AVG') {
    const avg = s.docs().query().avg(a[0]);
    if (expected === 'none') expect(avg, `${ctx}: avg none`).toBeNull();
    else expect(doubleMatches(avg as number, expected), `${ctx}: avg`).toBe(true);
    return;
  }
  if (op === 'AGG_MIN' || op === 'AGG_MAX') {
    const got = op === 'AGG_MIN' ? s.docs().query().min(a[0]) : s.docs().query().max(a[0]);
    if (expected === 'absent') expect(got, `${ctx}: expected absence`).toBeNull();
    else {
      if (got === null) throw new Error(`${ctx}: expected a value`);
      checkValue(got, expected, ctx);
    }
    return;
  }
  if (op === 'AGG_GCOUNT' || op === 'AGG_GSUM' || op === 'AGG_GAVG') {
    const q = s.docs().query();
    const obj =
      op === 'AGG_GCOUNT' ? q.groupCount(a[0])
      : op === 'AGG_GSUM' ? q.groupSum(a[0], a[1])
      : q.groupAvg(a[0], a[1]);
    checkGroups(obj, expected, ctx);
    return;
  }

  // ---- graph ----
  if (op === 'LINK') {
    s.docs().link(a[0], a[1], a[2]);
    return;
  }
  if (op === 'LINK_W') {
    s.docs().linkWeighted(a[0], a[1], a[2], parseDouble(a[3]));
    return;
  }
  if (op === 'UNLINK') {
    const removed = s.docs().unlink(a[0], a[1], a[2]);
    expect(removed ? 'removed:1' : 'removed:0', `${ctx}: unlink removed`).toBe(expected);
    return;
  }
  if (op === 'NEIGHBORS' || op === 'IN_NEIGHBORS') {
    const keys = op === 'NEIGHBORS' ? s.docs().neighbors(a[0], a[1]) : s.docs().inNeighbors(a[0], a[1]);
    checkKeys(keys.map(String), expected, ctx);
    return;
  }
  if (op === 'NEIGHBORS_W') {
    const pairs = s.docs().neighborsWeighted(a[0], a[1]);
    checkGroups(Object.fromEntries(pairs.map((p) => [p.key, p.weight])), expected, ctx);
    return;
  }
  if (op === 'TRAVERSE') {
    const keys = s.docs().traverse(a[0], a[1], parseInt(a[2], 10));
    checkKeys(keys.map(String), expected, ctx);
    return;
  }

  // ---- geo ----
  if (op === 'GINSERT' || op === 'GINSERT_M') {
    const loc = op === 'GINSERT_M'
      ? { lat: parseDouble(a[1]), lon: parseDouble(a[2]) }
      : [parseDouble(a[1]), parseDouble(a[2])];
    s.docs().insert(a[0], { loc });
    return;
  }
  if (op === 'RADIUS' || op === 'NEAREST' || op === 'BBOX') {
    const hits =
      op === 'RADIUS' ? s.docs().geoWithinRadius(a[0], parseDouble(a[1]), parseDouble(a[2]), parseDouble(a[3]))
      : op === 'NEAREST' ? s.docs().geoNearest(a[0], parseDouble(a[1]), parseDouble(a[2]), parseInt(a[3], 10))
      : s.docs().geoWithinBBox(a[0], parseDouble(a[1]), parseDouble(a[2]), parseDouble(a[3]), parseDouble(a[4]));
    const { keyPart, suffix } = splitExpected(expected);
    checkKeys(hits.map((h) => String(h.key)), keyPart, ctx);
    if (suffix) {
      const toks = splitTop(suffix.slice(1));
      expect(hits.length, `${ctx}: distance count`).toBe(toks.length);
      toks.forEach((tok, i) => {
        expect(doubleMatches(hits[i].distanceKm, tok), `${ctx}: hit ${i} distance`).toBe(true);
      });
    }
    return;
  }
  if (op === 'BBOX_ERR') {
    expectError(
      () => s.docs().geoWithinBBox(a[0], parseDouble(a[1]), parseDouble(a[2]), parseDouble(a[3]), parseDouble(a[4])),
      errCode(expected),
      ctx,
    );
    return;
  }

  // ---- schema & indexes ----
  if (op === 'SET_SCHEMA') {
    const defs = a.map((spec) => {
      const [name, ty, required, unique] = spec.split('#');
      return { name, type: parseFieldType(ty), required: required === '1', unique: unique === '1' };
    });
    s.docs().setSchema(defs);
    return;
  }
  if (op === 'SCHEMA') {
    const schema = s.docs().schema();
    if (!schema) throw new Error(`${ctx}: a schema must be declared first`);
    const got = schema.map((f) => `${f.name}/${f.type}/${f.required ? 1 : 0}/${f.unique ? 1 : 0}`).join(',');
    expect(got, `${ctx}: schema round trip`).toBe(expected);
    return;
  }
  if (op === 'SCHEMA9') {
    const names = ['f_any', 'f_bool', 'f_int', 'f_float', 'f_text', 'f_bytes', 'f_vector', 'f_array', 'f_map'];
    const types = FIELD_TYPES;
    s.docs().setSchema(names.map((name, i) => ({ name, type: types[i], required: i === 1, unique: i === 8 })));
    const schema = s.docs().schema();
    if (!schema) throw new Error(`${ctx}: the 9-field schema must be declared`);
    const got = schema.map((f) => FIELD_TYPES.indexOf(f.type as (typeof FIELD_TYPES)[number])).join(',');
    expect(schema.length, `${ctx}: exactly 9 fields`).toBe(9);
    expect(got, `${ctx}: schema9 discriminants`).toBe(expected);
    return;
  }
  if (op === 'SCHEMA_ERR') {
    expectError(() => s.docs().insert(a[0], parseLiteral(a[1])), errCode(expected), ctx);
    return;
  }
  if (op === 'IDX_SCALAR') { s.docs().createScalarIndex(a[0]); return; }
  if (op === 'IDX_COMPOUND') { s.docs().createCompoundIndex(a); return; }
  if (op === 'IDX_TEXT') { s.docs().createTextIndex(a[0]); return; }
  if (op === 'IDX_TEXT_DISK') { s.docs().createTextIndexOndisk(a[0]); return; }
  if (op === 'IDX_GEO') { s.docs().createGeoIndex(a[0]); return; }
  if (op === 'IDX_VEC') { s.docs().createVectorIndex(a[0], parseMetric(a[1])); return; }
  if (op === 'IDX_VEC_Q') { s.docs().createVectorIndexQuantized(a[0], parseMetric(a[1]), parseQuant(a[2])); return; }
  if (op === 'IDX_VEC_DISK') { s.docs().createVectorIndexOndisk(a[0], parseMetric(a[1])); return; }
  if (op === 'IDX_VEC_DISK_Q') { s.docs().createVectorIndexOndiskQuantized(a[0], parseMetric(a[1]), parseQuant(a[2])); return; }
  if (op === 'IDX_PQ' || op === 'IDX_PQ_DISK' || op === 'IDX_PQ_ERR') {
    const fn = () =>
      op === 'IDX_PQ_DISK'
        ? s.docs().createVectorIndexOndiskPq(a[0], parseMetric(a[1]), parseInt(a[2], 10), parseInt(a[3], 10))
        : s.docs().createVectorIndexPq(a[0], parseMetric(a[1]), parseInt(a[2], 10), parseInt(a[3], 10));
    if (op === 'IDX_PQ_ERR') expectError(fn, errCode(expected), ctx);
    else fn();
    return;
  }

  // File-backed OPs (FILEDB/REOPEN/DUMP/LOAD/BACKUP/...) are
  // deliberately NOT dispatched: this binding has no filesystem (the
  // persisted fixtures are not vendored — see the header). An unknown
  // OP must fail loudly, never pass silently.
  throw new Error(`${ctx}: unknown OP '${op}'`);
}

// ---------------------------------------------------------------------------
// The fixture driver
// ---------------------------------------------------------------------------

function startsWithDb(file: string): boolean {
  return file !== 'values.txt';
}

function runScenario(file: string): void {
  const text = fixtureTexts[`./golden/${file}`];
  if (typeof text !== 'string') throw new Error(`fixture not found: ${file}`);
  const s = new Scenario(file);

  if (startsWithDb(file)) s.openMemory();

  // Independent pre-scan of executable lines (blank / '#' skipped).
  const lines = text.split('\n').filter((l) => {
    const t = l.replace(/[\r ]+$/, '').trimStart();
    return t.length > 0 && !t.startsWith('#');
  });

  let executed = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.length === 0 || line[0] === '#') continue;
    const ctx = `${file}:${executed + 1} OP=`;
    // OP \t ARGS \t EXPECTED
    let op = line;
    let argsStr = '';
    let expected = '';
    const tab1 = line.indexOf('\t');
    if (tab1 >= 0) {
      op = line.slice(0, tab1);
      const tab2 = line.indexOf('\t', tab1 + 1);
      if (tab2 >= 0) {
        argsStr = line.slice(tab1 + 1, tab2);
        expected = line.slice(tab2 + 1);
      } else {
        argsStr = line.slice(tab1 + 1);
      }
    }
    const args = argsStr ? splitTop(argsStr) : [];
    runLine(s, op, args, expected, `${ctx}${op}`);
    executed++;
  }

  s.closeDb();
  s.scratch.close();

  // A dispatch loop that skipped a counted line diverges here instead
  // of silently passing.
  expect(executed, `${file}: dispatched lines`).toBe(lines.length);
  scenarios.push(`${file} lines=${lines.length} executed=${executed}`);
}

beforeAll(() => {
  // The wasm module is initialized synchronously by the node entry at
  // import time; nothing to do here but keep the shape symmetric.
});

afterAll(() => {
  console.log(`GOLDEN ${scenarios.length} files\n${scenarios.map((x) => `  ${x}`).join('\n')}`);
});

test.each(FILES)('golden suite: %s', (file) => {
  runScenario(file);
});

test('golden suite totals (230 lines)', () => {
  const total = scenarios.reduce((n, x) => n + parseInt(x.split('lines=')[1], 10), 0);
  expect(scenarios.length, 'all fixture files ran').toBe(FILES.length);
  expect(total, 'total executable fixture lines').toBe(230);
});
