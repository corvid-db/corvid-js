# corvid-js

The browser / Web Worker binding for
[corvid](https://github.com/corvid-db/corvid) — the embedded database
with vector (HNSW), full-text (BM25 + CJK bigrams), hybrid RRF/MMR
retrieval, graph edges, and geo — compiled to WebAssembly and exposed
as **idiomatic OOP**: a synchronous in-memory surface (`Db`,
`Collection`, a fluent `Query` builder, `field()` predicates) plus an
**async OPFS-persistent surface** (`openOpfs()` / `AsyncDb`) hosted in
a dedicated Worker. No SQL, no JSON, no serialization on the data
path; values cross the boundary natively.

- Engine pin: [`corvid-db` git dep](Cargo.toml), exact release tags
  per the bindings program (the engine PACKAGE is corvid-db — lib ident
  `corvid`).
- npm: **live** — `npm install corvid-js` (published via the repo's
  release workflow; the prebuilt wasm ships in the package).

## Use (browsers / bundlers) — in-memory, synchronous

```js
import { Db, field, init } from 'corvid-js';

await init(); // fetch + instantiate the wasm module (the only async part)

const db = new Db();            // in-memory per session
const docs = db.collection('docs');

docs.insert('s1', {
  kind: 'doc',
  body: 'rust embedded database',
  v: new Float32Array([1.0, 0.0]),      // the Vector kind
});

// Hybrid retrieval: filter + vector + BM25, RRF fusion, MMR rerank.
const rows = docs
  .query()
  .filter(field('kind').eq('doc'))
  .vector('v', new Float32Array([1.0, 0.0]), 2, 'cosine')
  .text('body', 'rust database', 2)
  .fuseRrf(60)
  .rerankMmr(1.0)
  .limit(2)
  .run(); // [{ key, doc, score }]

// Phrase search: consecutive in-order tokens, BM25 scores.
docs.phraseSearch('body', 'embedded database', 10);
```

## Use (browsers) — persistent, async (OPFS)

```js
import { openOpfs, field } from 'corvid-js';

const db = await openOpfs('notes');   // one OPFS file, one Worker
const docs = await db.collection('docs');

await docs.insert('k1', { body: 'survives reloads', n: 1 });

const rows = await docs
  .query()
  .filter(field('n').ge(1))
  .run();

await docs.close();
await db.close();   // the OPFS lock frees the moment this resolves
```

Every `AsyncDb`/`AsyncCollection`/`AsyncQuery` method returns a
Promise and mirrors the sync surface (the three documented deviations:
`name` is a sync getter, `update(key, fn)` composes get→fn→CAS — exact
under OPFS single-writer — and `scanEach` streams in chunks). Also on
the async surface: `dump()`/`load()`/`loadWithRenames()` (portable
byte streams), `backupTo(name)` (physical copy), and the storage
trio `storageEstimate()` / `requestPersistentStorage()` /
`isPersistentStorage()`.

**Single writer, by design.** OPFS grants the database file
exclusively per origin: a second tab's `openOpfs` of an open name
rejects with `Busy` (19). The lock frees the moment `close()`
resolves.

**Storage is evictable unless persisted.** Browser storage under
pressure is evicted whole-origin (LRU); Safari may additionally evict
script-created data after 7 idle days. `openOpfs` requests persistent
storage by default (best-effort — check `isPersistentStorage()`), and
`storageEstimate()` monitors usage (deliberately imprecise, per
platform design).

## Use (Node — tests, tooling, CLIs)

```js
import { Db, field } from 'corvid-js/node'; // synchronous init at import

const db = new Db();
```

The node entry loads the same wasm binary browsers do; every call is
identical. The async OPFS surface is browser-only (no binding is
exported under Node — OPFS and Web Workers do not exist there).

## The value mapping

| JS | engine |
| --- | --- |
| `null`, `boolean`, `string` | Null / Bool / Text |
| `number` (integer-valued, ≤ 2^53) | Int — `2` and `2.0` collapse; `CorvidFloat(n)` forces the Float kind |
| `number` (`0.5`, `inf`, `NaN`, `-0.0`), `bigint` | Float / Int (full i64) |
| `Uint8Array` (Buffer included) | Bytes |
| `Float32Array` | Vector |
| `Array` / plain object | Array / Map |

Reading back: Int → `number` (or `bigint` beyond ±2^53); Float →
`number` — f64 bits preserved **except NaN payloads**, which
canonicalize across the JS↔wasm Number boundary (`-0.0`, `±inf` are
exact; vector elements keep their f32 bits). Keys are strings (UTF-8)
or Uint8Arrays. `Object.keys()` of a mapped document enumerates the
engine's ascending key-byte order (the v0.3.0 `map_keys` surface).
The async surface additionally rejects `Map`/`Set`/`Date`, functions,
symbols, and cyclic values with `InvalidArgument` (12) before they
cross the worker boundary.

Errors are `CorvidError` (`e.code` = the C ABI's frozen 0–19 table,
`e.message` = the engine text). The sync surface is fully synchronous;
the async surface is fully Promise-based.

## Build from source

```sh
npm install            # wasm-pack wrapper deps + vitest + playwright (Rust >= 1.88 + wasm32 target)
npm run build          # wasm-pack build --release --target web  -> pkg/
npm test               # the golden suite (230 lines) + regressions + OPFS suites
npm run test:browser   # the golden suite in real Chromium, Firefox, and WebKit (await init())
npm run test:e2e       # async OPFS fixtures + reload/cross-tab (Playwright, 3 engines)
npm run size-gate      # gzipped wasm <= 1 MiB (engine reference: 2 MiB)
npm run surface-gate   # docs/SURFACE.tsv vs the pinned engine surface
npm run examples       # the six-example tour
npm run lint           # cargo fmt --check + clippy -D warnings
```

## Correctness story

The binding replays the engine's **golden suite** — the same fixture
files the C ABI smoke harness runs — against its public API on every
CI run: **267/267 executable lines across all eight fixture files**.
The six in-memory files (`values`, `mutations`, `queries`, `schema`,
`graph`, `geo`; 230 lines) run against the sync surface — in Node AND
in real browsers (`await init()`, same spec, unchanged: Chromium,
Firefox, and WebKit). The two file-backed files (`persist.txt`,
`admin.txt`; 37 lines) run against the async OPFS surface in all
three engines end to end: real Worker, real OPFS file, real
postMessage. Browser-only contracts are pinned too: persistence
across a real page reload, and the cross-tab single-writer `Busy`
with the lock freeing exactly when `close()` resolves
(docs/OPFS-SPEC.md §8 — the full enforced matrix, no skipped
engines; the per-engine harness notes live there too).

Six runnable examples (`examples/`) — quickstart, hybrid, vector
index families, text+CJK+phrase, graph, geo — execute on every CI leg
with deterministic output, and run identically in a browser (only the
loader line differs).

The binding contract for persistence is
[docs/OPFS-SPEC.md](docs/OPFS-SPEC.md) (review-gated, like the C ABI's
FFI.md); the architecture ruling, value contract, and size budget are
in [docs/PLAN.md](docs/PLAN.md), and every engine construct is
resolved to a binding API or a documented N/A in
[docs/SURFACE.tsv](docs/SURFACE.tsv).

License: MIT.
