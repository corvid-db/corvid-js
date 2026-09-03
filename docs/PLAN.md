# corvid-js — the browser/Worker (wasm) binding plan

Date: 2026-09-01 · Status: bootstrap complete (this document) ·
Controller plan: `docs/superpowers/plans/2026-08-31-corvid-ffi.md` in
the engine repo (corvid-db/corvid).

corvid-js is the JavaScript (browser / Web Worker) binding for
[corvid](https://github.com/corvid-db/corvid), Wave B of the bindings
program — the fifth binding, and the first targeting a non-native
runtime: the engine compiled to `wasm32-unknown-unknown` behind
**wasm-bindgen typed exports**, wrapped in an idiomatic synchronous
OOP layer. It follows the locked program rules: **golden-suite port
before ergonomic sugar**, OOP idiom gate (handles → JS classes, FFI
symbols never in the public API), exact engine-tag
pinning (`v0.4.1`), sync-first (the engine is sync; wasm-bindgen sync
calls, no async anywhere on the data path).

## 1. What shipped in this bootstrap

| Piece | Where |
| --- | --- |
| The wasm crate (engine-binding layer) | `src/*.rs` — `WasmDb`, `WasmCollection`, `WasmQuery` wasm-bindgen classes, value mapping, error mapping |
| The OOP idiom layer | `index.js` — `Db`, `Collection`, `Query` (fluent), `field()`/`and`/`or`/`not`, `CorvidError`, `CorvidFloat`, `init`/`initSync` |
| The Node entry (dev/test/tooling) | `node.mjs` — `initSync` from disk at import, re-exports the surface |
| Public types | `index.d.ts` (handwritten; the wasm-bindgen-generated `pkg/corvid_js.d.ts` is internal) |
| The golden-suite port | `test/golden.spec.ts` driving `test/golden/*.txt` — six files vendored verbatim from the v0.4.1 release (the same fixtures the C smoke suite runs) |
| Binding-local contracts | `test/regressions.spec.ts` — the compact quiescence gate, collections listing, session durability, the accepted-review regressions (B1/M7), the frozen error table |
| Size-budget gate | `scripts/size-gate.sh` — gzipped wasm ≤ 1 MiB (CI-enforced; see §6) |
| Surface manifest | `docs/SURFACE.tsv` (327 engine constructs resolved) + `scripts/surface-gate.sh` |
| CI | `.github/workflows/ci.yml` — lint + surface gate + build + size gate + golden suite + examples tour × node {24, 22, 20} × {ubuntu, macos} |

The golden suite: **230/230 fixture lines** across the 6 vendored
files (values 46, mutations 71, queries 46, schema 28, graph 20, geo
19 — including the v0.3.0 additions `VMAP_KEYS` and `PHRASE`), every
line dispatched and every expectation checked through the OOP surface,
with the same independent pre-scan discipline as the C harness (a
skipped line diverges `executed` from the counted total instead of
silently passing).

## 2. Architecture ruling: wasm-bindgen typed exports over the compiled engine

Architectures on the table:

1. **(chosen)** A Rust crate that compiles the engine to
   `wasm32-unknown-unknown` (`corvid-db = { git = "...", tag = "v0.4.1" }`
   — the engine package is corvid-db with lib ident `corvid` as of
   v0.4.1)
   and exposes **typed wasm-bindgen exports** — real `#[wasm_bindgen]`
   classes (`WasmDb`, `WasmCollection`, `WasmQuery`) with `JsValue`
   crossing points — which a thin JS layer (`index.js`) wraps into the
   fluent, error-carrying OOP surface. Build via wasm-pack
   (`--target web`).
2. A Worker-RPC surface: the engine in a Worker, the API as async
   message-passing proxies (the original docs-site sketch).
3. JS-side reimplementation of the storage/search layer (no engine).

Ruling: **(1)**, because (2) forces every call async — violating the
program's sync-first rule and adding a serialization hop per op — and
(3) abandons the one-behavioral-truth program entirely. With the
engine compiled in, the Rust compiler checks the entire
handle/value/predicate surface against the real engine API at build
time; wasm-bindgen's typed exports give JS real classes (constructors,
methods, GC finalization) rather than a hand-rolled FFI; and one
release artifact (`pkg/corvid_js_bg.wasm`) is byte-identical for
browsers, Workers, and the Node test runtime.

The engine's own `crates/corvid-wasm` size harness already proved the
engine links clean on this target inside the 2 MB gzipped budget; this
binding is that proof turned into a product.

Consequence (documented trade-off): building from source needs Rust +
wasm-pack; `npm run build` regenerates `pkg/`. The published package
will carry the prebuilt `pkg/` via `files` (install-pending, §8).

## 3. The OOP surface (v1)

Handles become JS classes; FFI/engine symbols never leak:

| ABI handle | JS class | Notes |
| --- | --- | --- |
| `corvid_db*` | `Db` | `new Db()` (in-memory — the shipped boundary, §5), `openMemory()` parity alias, `close()` idempotent, `Symbol.dispose` when available |
| `corvid_coll*` | `Collection` | mutations, reads, TTL, indexes (all variants), schema, graph, geo, `query()`, `phraseSearch()` (v0.3.0) |
| `corvid_query*` | `Query` | fluent chaining (`filter().vector().text().fuseRrf().rerankMmr().limit().run()`); terminal ops (`run` + every aggregation) consume it; `close()` is the abandoned-builder path |
| `corvid_rows*`/`_strs*`/`_geohits*`/`_groupiter*`/`_schemaiter*` | native arrays/objects | cursors materialize as `Row[]`, `string[]`, `GeoHit[]`, `Record<string, number>`, `SchemaField[]` — JS-native iteration |
| `corvid_value*` | the value mapping | see §4 |
| `corvid_pred*` | predicate descriptors | `field('a.b').gt(2)`, `and`/`or`/`not` — plain JS objects converted at the single crossing point (`filter`/`deleteWhere`) |
| status + `last_error_*` | `CorvidError` | `code` carries the C-ABI error number (frozen 0–19 table), `message` the engine text |

- **Errors**: wasm-bindgen cannot attach properties to thrown errors,
  so the Rust layer throws with the code+message in the error message
  as JSON and `index.js` rethrows a real `CorvidError` (an `Error`
  subclass) — the same wire form as the corvid-node napi layer.
  `ErrorCode` exports the frozen table.
- **Dispose**: `close()` everywhere (idempotent — the JS analog of
  the ABI's free-NULL no-ops), plus `Symbol.dispose` for `using` when
  the runtime provides it; wasm-bindgen's `FinalizationRegistry`
  glue releases GC'd handles without an explicit close.
- **Compact gate**: `Db.compact()` mirrors the ABI's §4.13 exclusivity
  rule — a derived-handle counter (1 for the db, +1 per live
  Collection/Query, released by close/consume/GC) must be at exactly 1
  AND the engine `Arc` solely owned, else `Busy` (19). Pinned by
  `test/regressions.spec.ts` (the fixture proof lived in admin.txt, a
  file-db scenario — see §5).
- **Sync-first**: every method is synchronous. The ONLY async is
  module instantiation: browsers `await init()` once (fetch +
  instantiate); Node's `node.mjs` entry instantiates synchronously at
  import. No async variants exist to add later on the data path — if
  the FFI bench ever justifies them, that is an additive API decision
  for the whole bindings program, not this repo alone.

## 4. The value mapping (the binding's value contract)

| JS (in) | engine `Value` | engine (out) | JS (out) |
| --- | --- | --- | --- |
| `null` / `undefined` | `Null` | `Null` | `null` |
| `boolean` | `Bool` | `Bool` | `boolean` |
| `number` (integer-valued, not `-0`, ≤2^53) | `Int` | `Int` (safe) | `number` |
| `number` (everything else: `0.5`, `inf`, `NaN`, `-0.0`) | `Float` | `Int` (beyond ±2^53) | `bigint` |
| `bigint` | `Int` (full i64) | `Float` | `number` |
| `string` | `Text` | `Text` | `string` |
| `Uint8Array` (Buffer is one) | `Bytes` | `Bytes` | `Uint8Array` |
| `Float32Array` | `Vector` | `Vector` | `Float32Array` |
| `Array` | `Array` | `Array` | `Array` |
| plain object | `Map` | `Map` | plain object (engine key order) |
| `CorvidFloat(n)` | `Float(n)` — the typed-float escape hatch | | |

Documented corners:

- **NaN fidelity**: the engine preserves f64 NaN payloads, and plain
  JS HeapNumbers do too — but the **JS↔wasm Number boundary
  canonicalizes NaN payloads** (the same class of corner corvid-node
  documents for the N-API boundary; V8/wasm JS-number semantics). A
  JS consumer can observe NaN-as-NaN (semantic equality, ordering,
  and `-0.0`/`±inf` bits are exact), but not f64 payload bits. Vector
  elements are unaffected (Float32Array memory is copied through wasm
  memory, never boxed). The golden port compares NaN expectations as
  NaN-class equality and documents the deviation in the spec header.
- **The Int/Float collapse**: JS numbers are unmarked, so `2` → `Int`.
  The engine's numeric interop (filters, ordering, predicates) treats
  `2` and `2.0` the same; the remaining observable distinction —
  compare-and-set/unique equality against typed floats, and group-key
  tags (`i:2` vs `f:0.5`) — is why `CorvidFloat` exists.
- **Map keys / the v0.3.0 `corvid_value_map_keys` ABI**: engine Maps
  surface as plain objects whose property insertion order IS the
  engine's ascending-key-byte order, so `Object.keys()` of a mapped
  document is the map_keys enumeration (non-maps enumerate empty,
  matching the ABI's inert empty cursor) — proven by the vendored
  `VMAP_KEYS`/`GET_KEYS` fixture lines. JS's integer-like-key hoisting
  can reorder `Object.keys()` for keys like `42` — a JS-observable
  rendering detail documented on the group aggregations, never a
  lookup behavior.
- **Keys** are strings (UTF-8) or Uint8Arrays (raw bytes); keys that
  are not valid UTF-8 come back as Uint8Arrays.
- **Typed-array strictness**: `Float32Array` is the Vector kind,
  `Uint8Array` the Bytes kind; other typed arrays (and `Map`/`Set`/
  `Date` objects) convert to a clean InvalidArgument asking for a
  plain form — silently mapping them would lose their contents.
- **Depth cap**: both directions cap nesting at the engine's
  `corvid::value::MAX_NESTING` (128), taken from the compiled-in
  engine so the two cannot drift — cyclic or pathologically nested
  JS input becomes a clean InvalidArgument instead of unbounded
  recursion toward a wasm stack trap. Capping ENCODE at the engine's
  decode bound (rather than a merely stack-safe larger number like
  the bootstrap-era 512) makes converter-accepted == decodable: a
  value the binding accepts can never encode into bytes the
  engine's decoder rejects.

## 5. The persistence boundary (deferral CLOSED — program executing)

**Shipped behavior: a `Db` is in-memory per session.** That contract
is pinned by `test/regressions.spec.ts` and does not change.

The recorded deferral is now **closed by execution**: the OPFS
persistence program is underway — the binding contract is
`docs/OPFS-SPEC.md` (review-gated, T1 of `docs/OPFS-PLAN.md`):
Worker-hosted engine over a redb `StorageBackend` implemented on OPFS
sync access handles, an async `openOpfs()`/`AsyncDb`/`AsyncCollection`/
`AsyncQuery` mirror alongside the untouched sync surface, cross-tab
single-writer surfaced as `Busy`, quota hygiene, and the two excluded
fixture files (`persist.txt`, `admin.txt`) becoming executable on the
browser conformance leg (267/267 there; the Node leg keeps 230/230 on
the sync surface). Until the program releases (T6), everything in this
section below describes the shipped in-memory reality and remains
true of the sync surface afterward:

documents, every index family (the ondisk-mode indexes included; on
this target "ondisk" is the engine's disk-resident storage mode
inside the session's store), schemas, TTLs, graph edges — live and
answer for the session's lifetime (pinned by the session-durability
regression test).

Fixture consequence, honestly stated: of the engine's eight golden
fixture files, **six are vendored verbatim** (`values`, `mutations`,
`queries`, `schema`, `graph`, `geo` — 230 executable lines); **two are
not yet** (`persist.txt`, `admin.txt`), because every scenario in them
is anchored on FILEDB/REOPEN/DUMP/LOAD — exactly the boundary the OPFS
program closes (SPEC §8). The in-memory-executable contracts those
files also pinned (the compact quiescence gate, the collections
listing, schema/TTL/graph survival across handle churn) are held by
`test/regressions.spec.ts` instead. Nothing is skipped silently: the
golden harness throws on unknown OPs, and its pre-scan/count check
makes any dispatch-loop gap a failure.

## 6. The size budget (a CI-enforced contract)

The engine's own CI gates the wasm-linked engine at **< 2 MB gzipped**
(gzip -9). This binding ships that engine plus wasm-bindgen glue, so
its budget is set **with margin below the reference: 1 MiB (1,048,576
bytes) gzipped**, enforced by `scripts/size-gate.sh` in CI.

- Bootstrap measurement: **362,985 bytes gzipped** (1,206,886 raw) —
  34% of budget, 5.6x under the engine's 2 MB reference.
- OPFS-program measurement (backend + dump/load paths in, T4):
  **379,304 bytes gzipped** (1,269,318 raw) — 36% of budget.
- `wasm-opt` is OFF, by measurement: a binaryen `-O`/`-Oz` pass over
  the cargo output gzips LARGER (400/408 KB vs 363 KB at bootstrap) —
  the budget is on the gzipped size, the same unit the engine's gate
  uses, and cargo's `opt-level="z"` + LTO + `codegen-units=1` +
  `strip` profile (the engine's own `wasm-release` shape) wins it.
  Re-measured at the OPFS program's T4 with binaryen 132 (`--enable-
  bulk-memory --enable-nontrapping-float-to-int`): -O → 418,313 gz,
  -Oz → 420,521 gz — the gap WIDENED (+10/11%); the ruling stands
  with more margin, and the OPFS backend code did not change it.

## 7. Where the suite runs (and why that is legitimate)

The golden suite and the examples run under **node's WebAssembly
runtime** against the node entry (`corvid-js/node`), executing the
same `pkg/corvid_js_bg.wasm` browsers load. Node's and browsers' wasm
engines implement the same core semantics for everything this engine
uses (no wasm threads, no WASI, no host imports beyond the standard
wasm-bindgen shims), so the behavioral truth is identical — the
PACKAGE is browser/Worker-targeted, and the SUITE is a faithful CI
proxy until browser-test infrastructure exists in the bindings
program (at which point this spec runs unchanged against
`await init()`). This choice is recorded here per the bootstrap
brief; it is the same one-binding-truth discipline as the C smoke
suite running the same fixtures.

## 8. Packaging & install (pending first publish)

- `wasm-pack build --release --target web` produces `pkg/corvid_js.js`
  (ESM glue exporting `init`/`initSync` + the raw classes) and
  `pkg/corvid_js_bg.wasm` (the single engine artifact).
- `index.js` is the public ESM entry (browsers/bundlers):
  `import { Db, init } from 'corvid-js'; await init();`.
- `node.mjs` is the Node entry: `initSync` from disk at import, then
  the full surface — zero-config synchronous, like the sibling
  bindings. `exports` conditions route `.` → node/default split;
  `./node` is explicit for bundler configs that resolve the node
  condition.
- `package.json` `files` carries `index.js`, `index.d.ts`,
  `node.mjs`, and the three pkg artifacts.
- Not yet published (`npm publish` pending; `files`/`exports` wired).
  Install-pending is stated in the README, like the sibling bindings.

## 9. Follow-up tasks (post-bootstrap)

1. **Publish wiring**: `npm publish` once reviewed; verify
   `import 'corvid-js'` + `await init()` in a bundler and a plain
   `<script type="module">` page.
2. **Browser-test leg**: when the bindings program stands up
   playwright-style infrastructure, run `test/golden.spec.ts` against
   the browser entry in CI (the spec is entry-agnostic).
3. **OPFS persistence**: the §5 trigger is LIT — executing now per
   `docs/OPFS-PLAN.md` (T1–T6), contract at `docs/OPFS-SPEC.md`:
   `openOpfs`/async mirror surface, byte-stream dump/load, `backupTo`,
   SURFACE.tsv rows flip (annotated ASYNC) with T5, persist.txt/
   admin.txt run on the browser leg, baseline drops by 5 there.
4. **Ergonomic sugar** (only now, per the golden-before-sugar rule):
   `using` examples once `using` is widespread in browser toolchains.
5. **Bench parity**: port the FFI bench shapes through the wasm
   boundary to quantify the JS→wasm crossing cost vs corvid-node's
   napi numbers.

## 10. Decision log

| Decision | Rationale |
| --- | --- |
| wasm-bindgen typed exports, engine compiled to wasm32 (not Worker-RPC, not a JS reimplementation) | §2: sync-first, one behavioral truth, type-checked crossing |
| JS idiom layer in `index.js` wrapping the wasm classes | fluent chaining + real `CorvidError` subclass; keeps the wasm surface minimal; FFI/engine types never leak |
| `--target web` glue + `node.mjs` initSync entry (single artifact) | one wasm binary for browsers, Workers, and the Node test runtime; browsers stay async-init-only at the module level, Node zero-config |
| Predicates as plain descriptor objects | one crossing per engine op, full TS typing, no native predicate handle to manage |
| Vendored golden fixtures (from the v0.4.1 release, 6 of 8 files; persist/admin excluded as file-db scenarios) | §5: the suite must run offline and per-PR; the two excluded files ARE the deferred persistence boundary; their in-memory contracts live in regressions.spec.ts |
| VMAP_KEYS/GET_KEYS proven via `Object.keys()` | the mapped object's insertion order is the engine's ascending key-byte order — the JS-native form of the v0.3.0 additive ABI |
| phrase_search mapped to `Collection.phraseSearch` | the v0.3.0 additive ABI exists to give bindings the direct fn; the query builder keeps the fused form |
| NaN-class comparison in the golden port | the JS↔wasm Number boundary canonicalizes NaN payloads; deviation documented (§4) |
| `CorvidFloat` marker class | typed-float escape hatch for the Int/Float collapse (CAS/unique/group-keys) |
| Counter + Arc exclusivity for `compact` | mirrors the ABI §4.13 gate exactly; pinned by the regressions spec |
| Size budget 1 MiB gzipped; wasm-opt disabled | §6: margin under the engine's 2 MB reference; measured — wasm-opt grows the gzipped artifact on this engine |
| Suite under node's wasm runtime (documented) | §7: same binary, same semantics; browser leg is a follow-up, not a precondition |
