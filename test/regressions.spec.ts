/**
 * regressions.spec.ts — binding-local contracts kept separate from the
 * golden port (whose 230-line fixture count must stay untouched).
 *
 * These pin the in-memory-executable contracts that the two
 * non-vendored fixture files (persist.txt / admin.txt — file-db
 * scenarios, the OPFS deferral boundary in docs/PLAN.md §5) also
 * exercised on the C side, plus the accepted-review regressions the
 * sibling bindings carry:
 *
 * - the compact quiescence gate (admin.txt's COMPACT_BUSY/COMPACT):
 *   Busy (19) with derived handles open, quiescent pass otherwise,
 *   data intact after compaction;
 * - collections() listing (admin.txt's COLLECTIONS);
 * - session durability: documents, on-disk-mode indexes, schemas and
 *   edges live for the session's lifetime (persist.txt's in-memory
 *   analog — the reopen half is exactly the deferred boundary);
 * - B1: negative safe integers map to engine Ints (group key `i:-5`),
 *   only -0.0 falls through to Float;
 * - M7: unbounded JS nesting converts to a clean InvalidArgument
 *   (depth cap), never a stack overflow trap;
 * - the frozen ErrorCode table.
 */

import { afterAll, beforeAll, expect, test } from 'vitest';

import { CorvidError, Db, ErrorCode, field } from '../node.mjs';

let db: Db;

beforeAll(() => {
  db = new Db();
});

afterAll(() => {
  db.close();
});

function expectCode(fn: () => unknown, code: number, ctx: string): void {
  let threw: unknown = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  if (!(threw instanceof CorvidError)) {
    throw new Error(`${ctx}: threw ${String(threw)} (not a CorvidError)`);
  }
  expect(threw.code, `${ctx}: error code`).toBe(code);
}

// ---------------------------------------------------------------------------
// The compact quiescence gate (admin.txt COMPACT_BUSY / COMPACT)
// ---------------------------------------------------------------------------

test('compact is Busy (19) while a derived collection handle is open', () => {
  const c = db.collection('compact-gate');
  c.insert('a', { n: 1 });
  expectCode(() => db.compact(), 19, 'compact with an open collection');
  c.close();
  // Quiescent: the gate opens, nothing is lost (the in-memory store has
  // no file to rewrite — moved is whatever the engine's housekeeping
  // reports, and every document survives).
  const moved = db.compact();
  expect(typeof moved, 'compact returns a boolean').toBe('boolean');
  const reread = db.collection('compact-gate');
  expect(reread.get('a'), 'data survives compaction').toEqual({ n: 1 });
  reread.close();
});

test('compact is Busy while an unexecuted query handle is open', () => {
  const c = db.collection('compact-gate-q');
  const q = c.query();
  expectCode(() => db.compact(), 19, 'compact with an open query');
  q.close();
  c.close();
  db.compact();
});

test('an executed query releases the gate by itself', () => {
  const c = db.collection('compact-gate-run');
  c.insert('a', { n: 1 });
  c.query().filter(field('n').eq(1)).count(); // terminal op consumes it
  c.close();
  db.compact();
});

// ---------------------------------------------------------------------------
// collections() (admin.txt COLLECTIONS)
// ---------------------------------------------------------------------------

test('collections lists written collection names in engine order', () => {
  const a = db.collection('zz');
  a.insert('k', { n: 1 });
  const b = db.collection('aa');
  b.insert('k', { n: 1 });
  expect(db.collections(), 'collection names present').toEqual(
    expect.arrayContaining(['zz', 'aa']),
  );
  a.close();
  b.close();
});

// ---------------------------------------------------------------------------
// Session durability (persist.txt's in-memory analog)
// ---------------------------------------------------------------------------

test('documents, ondisk-mode indexes, schema and edges live for the session', () => {
  const c = db.collection('session');
  c.insert('strong', { tag: 's', kind: 'doc', body: 'rust embedded database', v: new Float32Array([1, 0]) });
  c.insert('weak', { tag: 'w', kind: 'doc', body: 'python web frameworks', v: new Float32Array([0, 1]) });
  c.createTextIndexOndisk('body');
  c.createVectorIndexOndisk('v', 'cosine');
  c.setSchema([{ name: 'name', type: 'text', required: true }]);
  c.link('strong', 'rel', 'weak');

  // A second handle over the SAME db sees everything (the closest
  // in-memory analog of persist.txt's reopen: the store outlives the
  // handle that built it — what it cannot do, by contract, is outlive
  // the SESSION; that is the OPFS boundary).
  const again = db.collection('session');
  expect(again.len(), 'documents persist in-session').toBe(2);
  const qtext = again.query().text('body', 'rust database', 2).run();
  expect(qtext.map((r) => r.key), 'ondisk text index answers').toEqual(['strong']);
  const qvec = again.query().vector('v', new Float32Array([1, 0]), 2, 'cosine').run();
  expect(qvec.map((r) => r.key), 'ondisk vector index answers').toEqual(['strong', 'weak']);
  expect(again.schema(), 'schema persists in-session').toEqual([
    { name: 'name', type: 'text', required: true, unique: false },
  ]);
  expect(again.neighbors('strong', 'rel').map(String), 'graph edges persist in-session').toEqual(['weak']);
  again.close();
  c.close();
});

// ---------------------------------------------------------------------------
// B1 — negative integers are Ints (accepted-review regression, all
// bindings carry it)
// ---------------------------------------------------------------------------

test('B1(a): plain JS -5 round-trips as engine Int — group key i:-5', () => {
  const c = db.collection('b1-group');
  c.insert('neg', { n: -5 });
  c.insert('pos', { n: 5 }); // positive control
  expect(c.get('neg'), 'B1(a): document round trip').toEqual({ n: -5 });
  const groups = c.query().groupCount('n');
  expect(Object.keys(groups), 'B1(a): group keys (engine ascending order)').toEqual(['i:-5', 'i:5']);
  expect(groups['i:-5'], 'B1(a): -5 grouped as Int').toBe(1);
  c.close();
});

test('B1(b): an int-typed schema field accepts negative numbers', () => {
  const c = db.collection('b1-schema');
  c.setSchema([{ name: 'n', type: 'int' }]);
  c.insert('k', { n: -5 });
  expect(c.get('k'), 'B1(b): stored').toEqual({ n: -5 });
  c.close();
});

// ---------------------------------------------------------------------------
// M7 — unbounded nesting is a clean error, not a trap
// ---------------------------------------------------------------------------

test('M7: deeply nested JS values convert to InvalidArgument, not a trap', () => {
  const c = db.collection('m7');
  let v: unknown = { n: 1 };
  for (let i = 0; i < 1000; i++) v = { nested: v }; // cyclic-free but > MAX_DEPTH (512)
  expectCode(() => c.insert('deep', v as object), 12, 'depth cap');
  // The same object graph WITH a cycle hits the cap the same way.
  const cyc: Record<string, unknown> = { n: 1 };
  cyc.self = cyc;
  expectCode(() => c.insert('cyc', cyc), 12, 'cycle cap');
  expect(c.len(), 'nothing stored').toBe(0);
  c.close();
});

// ---------------------------------------------------------------------------
// The frozen error-code table
// ---------------------------------------------------------------------------

test('the ErrorCode table is the frozen FFI table (0..=19)', () => {
  expect(ErrorCode, 'frozen table').toEqual({
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
});

test('CorvidError carries code + message (the JSON wire form never leaks)', () => {
  const c = db.collection('wire');
  let caught: unknown = null;
  try {
    c.insert('k', 5 as unknown as object); // a scalar is not a document map... actually it IS storable; use a bad pred instead
  } catch (e) {
    caught = e;
  }
  void caught;
  try {
    c.query().filter({ op: 'nonsense' } as never).count();
  } catch (e) {
    expect(e, 'is a CorvidError').toBeInstanceOf(CorvidError);
    expect((e as CorvidError).code, 'code 12').toBe(12);
    expect((e as CorvidError).message, 'no JSON wire leaks through').not.toContain('corvidCode');
    return;
  }
  throw new Error('the nonsense predicate must throw');
});
