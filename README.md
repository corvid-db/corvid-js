# corvid-js

The browser / Web Worker binding for
[corvid](https://github.com/corvid-db/corvid) — the embedded database
with vector (HNSW), full-text (BM25 + CJK bigrams), hybrid RRF/MMR
retrieval, graph edges, and geo — compiled to WebAssembly and exposed
as **idiomatic, synchronous OOP**: `Db`, `Collection`, a fluent
`Query` builder, and `field()` predicates. No SQL, no JSON, no
serialization on the data path; values cross the boundary natively.

**The persistence boundary, stated plainly: a `Db` is in-memory per
session.** wasm has no filesystem, so nothing survives a page reload
today — OPFS-backed persistence is a *decided, trigger-based* future
addition (see [docs/PLAN.md §5](docs/PLAN.md)). Everything else the
engine does — every index family, schemas, TTL, graph, geo, hybrid
queries — works and is pinned by the engine's golden fixtures.

- Engine pin: [`corvid` git dep, tag `v0.3.1`](Cargo.toml) (exact
  release tags, per the bindings program).
- Install status: **pending first npm publish** — build from source
  meanwhile (below).

## Use (browsers / bundlers)

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

// Phrase search (v0.3.1): consecutive in-order tokens, BM25 scores.
docs.phraseSearch('body', 'embedded database', 10);
```

## Use (Node — tests, tooling, CLIs)

```js
import { Db, field } from 'corvid-js/node'; // synchronous init at import

const db = new Db();
```

The node entry loads the same wasm binary browsers do; every call is
identical.

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
engine's ascending key-byte order (the v0.3.1 `map_keys` surface).

Errors are `CorvidError` (`e.code` = the C ABI's frozen 0–19 table,
`e.message` = the engine text). Everything is synchronous — no
callbacks, no promises on the data path.

## Build from source

```sh
npm install            # wasm-pack wrapper deps + vitest (Rust >= 1.88 + wasm32-unknown-unknown target required)
npm run build          # wasm-pack build --release --target web  -> pkg/
npm test               # the golden suite (230 fixture lines) + regressions
npm run size-gate      # gzipped wasm <= 1 MiB (engine reference: 2 MiB)
npm run surface-gate   # docs/SURFACE.tsv vs the pinned engine surface
npm run examples       # the six-example tour
npm run lint           # cargo fmt --check + clippy -D warnings
```

## Correctness story

The binding replays the engine's **golden suite** — the same fixture
files the C ABI smoke harness runs — against its public API on every
CI run: 230/230 executable lines across the six in-memory fixture
files (`values`, `mutations`, `queries`, `schema`, `graph`, `geo`),
including the v0.3.0 `VMAP_KEYS` and `PHRASE` additions. The two
file-backed fixture files (`persist.txt`, `admin.txt`) are not
vendored — their scenarios are exactly the deferred persistence
boundary; their in-memory-executable contracts (the compact
quiescence gate, collections listing, session durability) are pinned
by `test/regressions.spec.ts`. The suite runs under node's wasm
runtime against the same binary browsers load (docs/PLAN.md §7).

Six runnable examples (`examples/`) — quickstart, hybrid, vector
index families, text+CJK+phrase, graph, geo — execute on every CI leg
with deterministic output, and run identically in a browser (only the
loader line differs).

## Repository layout

```
src/            the wasm crate (wasm-bindgen classes over the engine)
index.js        the OOP surface (public ESM entry, browsers/bundlers)
node.mjs        the Node entry (synchronous init, re-exports the surface)
index.d.ts      handwritten public types
pkg/            wasm-pack output (built, not committed)
docs/PLAN.md    architecture ruling, value contract, budget, deferrals
docs/SURFACE.tsv  every engine construct: mapped here or N/A + reason
scripts/        size-gate.sh, surface-gate.sh
test/           golden.spec.ts (+ vendored fixtures), regressions.spec.ts
```

License: MIT.
