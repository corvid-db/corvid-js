# corvid-js OPFS persistence — the binding contract (SPEC-1)

Date: 2026-09-02 · Status: **REVIEWED — gate PASSED 2026-09-02**
(adversarial review + fix round + delta re-check; implementation may
begin) · Parent plan: `docs/OPFS-PLAN.md` (locked rulings 1–6, Tasks
T1–T6; this file is T1's deliverable) · Engine pin at authoring: v0.3.3;
this program ships against **engine v0.3.4** (additive APIs, §2).

Every factual claim below carries its source. Sources used: the redb
4.2.0 crate source (the version this repo's `Cargo.lock` resolves — the
engine's own lock holds 4.1.0; the engine's `redb = "4.1"` caret admits
both), the corvid engine source at the v0.3.3 tag, MDN Web Docs, and the
WHATWG File System standard where MDN is silent. Facts MDN does NOT
document are marked as such and never asserted on MDN's authority.

---

## 1. Verified foundations (what the whole program stands on)

### 1.1 redb's storage seam is public, small, and already exercised by the engine

`redb::StorageBackend` (redb 4.2.0, `src/db.rs`), quoted verbatim:

```rust
pub trait StorageBackend: 'static + Debug + Send + Sync {
    fn len(&self) -> core::result::Result<u64, io::Error>;
    fn read(&self, offset: u64, out: &mut [u8]) -> core::result::Result<(), io::Error>;
    fn set_len(&self, len: u64) -> core::result::Result<(), io::Error>;
    fn sync_data(&self) -> core::result::Result<(), io::Error>;
    fn write(&self, offset: u64, data: &[u8]) -> core::result::Result<(), io::Error>;
    fn close(&self) -> core::result::Result<(), io::Error> { Ok(()) }   // default
}
```

- `io::Error` **is `std::io::Error`** on std builds (`redb::io`, re-export).
  `wasm32-unknown-unknown` has std, so a backend written against
  `std::io::Error` is correct on this target.
- `Builder::create_with_backend(&self, backend: impl StorageBackend) ->
  Result<Database, DatabaseError>` is public — same builder path as
  `create_file`.
- redb calls `close()` **exactly once**, in one of three cases (redb's own
  trait doc): when the `Database` drops, or — if a `WriteTransaction`
  was live at that point — when that transaction completes, **or when
  opening the database fails**. All three are lifecycle-meaningful to
  OPFS (§5.2 step 6, §5.3); this is the deterministic handle-release
  point.
- redb's durable commits invoke `sync_data()` — the flush-on-commit hook.
- Implementation note: `redb::io` is a *private* module on std builds —
  the backend writes `std::io::Error` directly (the two are the same
  type on this target).
- The engine already opens redb through this seam:
  `Store::open_in_memory` = `Database::builder().create_with_backend(
  redb::backends::InMemoryBackend::new())` (`crates/corvid/src/store.rs:105`
  at v0.3.3). OPFS is a second backend through the same, proven door.
- redb does not require mmap (engine DESIGN decision log 2026-05-29) —
  pread/pwrite suffice, which is exactly what a sync OPFS handle gives.

**The plan's "largest unverified assumption" is now verified: no fork,
no cargo-patch, no redb change is needed.**

### 1.2 The engine's persistence surface, itemized by what crosses to wasm

| Engine API (v0.3.3) | Signature shape | OPFS story |
| --- | --- | --- |
| `Store::open` / `Db::open` | `path: impl AsRef<Path>` | **needs a backend twin** (§2.1) |
| `Store::open_in_memory` / `Db::open_in_memory` | — | exists, unrelated |
| `Db::dump` | `dump<W: Write>(&self, w: W)` | **works as-is** — wasm passes `Vec<u8>` (implements `Write`) |
| `Db::load` / `Db::load_with_renames` | `load<R: Read>(&self, r: R)` | **works as-is** — wasm passes `&[u8]` (implements `Read`) |
| `Store::backup` | `path: impl AsRef<Path>` (+ exists-check, cleanup) | **needs a backend twin** (§2.2) |
| `Store::flush` | durable commit | works — becomes `sync_data` → `handle.flush()` |

### 1.3 Browser facts (MDN-verified 2026-09-02; gaps attributed to WHATWG)

| # | Fact | Authority |
| --- | --- | --- |
| B1 | `FileSystemFileHandle.createSyncAccessHandle()` returns `Promise<FileSystemSyncAccessHandle>`; usable **only inside Dedicated Workers, for OPFS files** (IDL `[Exposed=DedicatedWorker]`, WHATWG). On the main thread the method **does not exist** — a plain `TypeError`, *not* a DOMException; the spec never claims one. | MDN + fs.spec.whatwg.org |
| B2 | All sync-handle methods are synchronous: `read(buffer,{at})`, `write(buffer,{at})`, `truncate(n)`, `getSize()`, `flush()`, `close()`. Older spec revisions wrongly made close/flush/getSize/truncate async; some old browsers shipped that — we detect, not assume (§5.6). | MDN (explicit history note) |
| B3 | `read` returns bytes-read into the buffer; `at` = byte offset. **EOF/partial-read behavior is NOT documented on MDN** — our shim loops until the buffer is full and treats a 0-byte read as `UnexpectedEof` (redb requires a full read or an error). | MDN read page + trait contract |
| B4 | `write` returns bytes-written; `at` = offset. **Partial failure may NOT throw** (`InvalidStateError` is documented only for *complete* failure) — the shim must verify `bytesWritten === len`. | MDN write page |
| B5 | `truncate(n)` resizes synchronously; growth beyond quota throws `QuotaExceededError`. Growth **zero-fills** (redb requires new positions zero-initialized; WHATWG resize semantics; verified per-browser in the T3 matrix). | MDN truncate + redb trait doc |
| B6 | `getSize()` → byte length, synchronous. | MDN |
| B7 | `flush()` persists `write()` changes to disk; **MDN makes no fsync-grade durability claim** — our durability wording is bounded by this (§5.4). `close()` does not document flushing; the pattern is explicit `flush()` then `close()`. | MDN flush page |
| B8 | A default-mode sync handle takes an **exclusive lock** on the file: further `createSyncAccessHandle`s *and* `createWritable()` streams reject with `NoModificationAllowedError` until it closes. OPFS storage is origin-scoped and shared across same-origin tabs (WHATWG), so the lock is effectively cross-tab. (A `mode` option now exists — read-only/readwrite-unsafe allow sharing; we use default `readwrite` exclusively.) | MDN createSyncAccessHandle + WHATWG |
| B9 | Baseline: Chrome/Edge 102+, Firefox 111+, Safari 15.2+ (desktop and iOS); "widely available" since March 2023. Secure context required. | MDN browser-compat |
| B10 | `navigator.storage.getDirectory()` → OPFS root handle; `getFileHandle(name,{create:true})` creates-or-opens; `create:false` + absent → `NotFoundError`; invalid names (path separators) → `TypeError`. | MDN |
| B11 | `navigator.storage.persist()` is **NOT available in Workers** (MDN: "not available in Web Workers, though the StorageManager interface is") — the main thread makes the persistence request (§5.2). OPFS data is evictable under storage pressure (LRU, whole-origin); `persist()` exempts the origin; Safari ITP may evict script-created data after 7 idle days; `estimate()` includes OPFS usage and is deliberately imprecise. | MDN StorageManager + eviction guide |
| B12 | `QuotaExceededError` is documented on sync-handle `write` and growth `truncate`; not on `read`. | MDN |

---

## 2. Engine-side additions (additive Rust APIs, engine v0.3.4)

The engine gains **four** public constructors and **zero** behavior
changes. None touch the C ABI (native consumers keep real files; FFI.md
is untouched — the drift gate stays quiet). All are pure delegations
through the redb seam the engine already uses.

### 2.1 `Store::open_with_backend` / `Db::open_with_backend`

```rust
// crates/corvid/src/store.rs
impl Store {
    /// Open (creating if absent) a store over a caller-supplied redb
    /// storage backend. The backend must be initially empty or contain a
    /// valid redb database (redb's own precondition for
    /// `Builder::create_with_backend`); cleanup-on-failure is the
    /// backend's concern, not the engine's.
    pub fn open_with_backend(backend: impl redb::StorageBackend) -> Result<Self>;

// crates/corvid/src/db.rs
impl Db {
    /// Open (creating if absent) a database over a caller-supplied redb
    /// storage backend.
    pub fn open_with_backend(backend: impl redb::StorageBackend) -> Result<Self>;
}
```

Identical body shape to `open_in_memory`: construct the Store, then the
**seven** on-open registry loads `Db` performs (`load_index_defs`,
`load_text_defs`, `load_scalar_defs`, `load_compound_defs`,
`load_geo_defs`, `load_schemas`, `load_ttl_collections`) —
backend-independent by construction.

### 2.2 `Store::backup_with_backend` / `Db::backup_with_backend`

```rust
// crates/corvid/src/store.rs
impl Store {
    /// The backend form of [`Store::backup`]: copy all tables into a
    /// database created over `dst`. The path form's preconditions
    /// (target must not exist; cleanup of a partial target on failure)
    /// belong to the CALLER here — a backend has no path to stat.
    pub fn backup_with_backend(&self, dst: impl redb::StorageBackend) -> Result<()>;
}

// crates/corvid/src/db.rs — the Db-level twin is REQUIRED: Db::store()
// is pub(crate) at v0.3.3 (db.rs:154), so the binding's Arc<Db> cannot
// reach the Store from outside the engine.
impl Db {
    /// The backend form of [`Db::backup`] (mirrors the path form's
    /// delegation shape, db.rs:105 at v0.3.3).
    pub fn backup_with_backend(&self, dst: impl redb::StorageBackend) -> Result<()>;
}
```

Implementation is the existing `backup_tables` with the destination
`Database::create(path)` swapped for
`Database::builder().create_with_backend(dst)`; `backup_tables` is
parameterized accordingly (the path-based `Store::backup` keeps its
exists-check + remove-on-failure contract verbatim — its tests are the
regression proof that the refactor changed nothing).

### 2.3 Engine tests (RED-first, in `crates/corvid`)

1. `open_with_backend(InMemoryBackend)` → insert → drop Db → reopen →
   documents, indexes, schema survive (the unit-level twin of
   `persist.txt`).
2. A counting test backend (delegating to `InMemoryBackend`) proves
   trait dispatch: `write/read/len/set_len` all exercised by a
   write-then-read workload; `sync_data` observed on a durable commit
   and on `Store::flush`.
3. A failing Nth-write backend (redb's own test pattern) surfaces as a
   clean engine `Error`, not a panic.
4. `Store::backup_with_backend` → reopen the target via
   `open_with_backend` → contents equal the source (documents, indexes,
   meta); the `Db::backup_with_backend` twin is exercised by the same
   test through the Db handle.
5. Existing path-based `backup` tests keep passing unchanged (refactor
   proof).

---

## 3. The OPFS storage backend (the binding crate, wasm32)

### 3.1 Division of labor

Rust owns the `StorageBackend` implementation and all redb contact; JS
owns everything the DOM owns — the `FileSystemSyncAccessHandle` itself
and the wasm memory views. **Rust never touches a DOM type.** The worker
registers each open handle under a `u32` id; the Rust backend holds only
that id and calls six synchronous imported shims.

### 3.2 The Rust backend (`src/opfs.rs`)

```rust
#[derive(Debug)]
struct OpfsBackend { handle_id: u32 }   // Debug + Send + Sync: u32 only
```

Implements `redb::StorageBackend` by calling `#[wasm_bindgen(catch)]`
imported functions (sync imports — the mechanism redb's synchronous
internals require; `catch` turns a JS `throw` into `Err(JsValue)`):

| Trait method | Import (on `globalThis.corvidOpfs`) | Mapping |
| --- | --- | --- |
| `len()` | `length(handle) -> f64` | safe-integer check → `u64` |
| `read(offset, out)` | `read(handle, offset, ptr, len) -> i32` | view into wasm memory at `ptr..ptr+len`; shim loops until full (B3) |
| `write(offset, data)` | `write(handle, offset, ptr, len) -> i32` | view write; shim verifies `bytesWritten === len` (B4) |
| `set_len(n)` | `setLen(handle, n)` | `truncate(n)`; zero-fill growth is the browser's (B5) |
| `sync_data()` | `sync(handle)` | `flush()` (B7) |
| `close()` | `closeHandle(handle)` | `flush()` then `close()` (B7 pattern) |

**One error channel**: every shim is declared
`#[wasm_bindgen(catch)]`, so a JS `throw` crosses as `Err(JsValue)`
and a clean return carries only the byte counts above — there is no
sentinel-return convention. The Rust side maps the stringified
`DOMException.name + ": " + message` to `std::io::Error` with defined
kinds: `QuotaExceededError` → `ErrorKind::StorageFull`; the shim's
own end-of-file signal (the `UnexpectedEof:` prefix from its fill
loop, §1.3-B3 — not a DOMException) → `ErrorKind::UnexpectedEof`;
every other failure → `ErrorKind::Other` with the DOM text carried.
These surface through redb as `StorageError`, through the engine as
`Error::Storage`/`Error::Io` — code-true end to end (§6).

Wire-type ruling: **offsets and lengths cross as `f64`, not `u64`/BigInt**
— exact integers to 2^53, and a browser-quota-bounded OPFS file cannot
approach 2^53 bytes; this avoids per-call BigInt allocation on the
hottest path (every page read/write). The shim hard-checks
`Number.isSafeInteger` and treats a violation as an internal error.
`ptr`/`len` are `u32` (wasm32 memory bounds).

Wasm-bindgen cannot export `memory` to an import shim by itself; the
worker's bootstrap installs it once: `await init()` returns the
`InitOutput`, whose `memory` the shim registry binds
(`corvidOpfs.install(initOutput.memory)`).

### 3.3 The wasm constructors added to the binding crate

```rust
impl WasmDb {
    #[wasm_bindgen(js_name = openOpfs)]
    pub fn open_opfs(handle_id: u32) -> Result<WasmDb, JsValue>;   // Db::open_with_backend(OpfsBackend)

    pub fn dump(&self) -> Result<Vec<u8>, JsValue>;                 // Db::dump(Vec::new()) — the byte-stream form
    pub fn load(&self, bytes: Vec<u8>) -> Result<(), JsValue>;
    // wasm-bindgen has NO tuple support: the rename map crosses as two
    // parallel vectors (equal length, keys[i] -> values[i]); the JS
    // facade's Record<string,string> is decomposed before the call.
    pub fn load_with_renames(&self, bytes: Vec<u8>, rename_keys: Vec<String>, rename_values: Vec<String>) -> Result<(), JsValue>;
    #[wasm_bindgen(js_name = backupOpfs)]
    pub fn backup_opfs(&self, target_handle_id: u32) -> Result<(), JsValue>;  // Db::backup_with_backend(OpfsBackend)
}
```

The engine needs no wasm-specific code; `Cursor`-free stream forms from
§1.2 do the rest.

---

## 4. The public async surface (the OOP mirror, Promise-flavored)

OOP idiom gate (FFI.md §8 discipline, js form): same class taxonomy, no
worker/protocol/handle-id type ever leaks; every facade method returns a
`Promise` except the fluent query chain (§4.4). The **sync surface is
untouched** — `regressions.spec.ts` pins it.

### 4.1 Names, entry, and placement

```js
import { openOpfs, AsyncDb, field } from 'corvid-js';   // browser entry (additive exports)

const db  = await openOpfs('notes');          // factory (recommended form)
const db2 = await AsyncDb.openOpfs('notes');  // static alias — parity with Db.openMemory()
```

- The async surface lives in `index.js`'s export list (one entry point;
  no subpath). `node.mjs` does **not** re-export the async surface —
  Node has no OPFS; importing it under the node condition yields no
  binding, which is the cleanest possible "not supported here."
- `AsyncDb`, `AsyncCollection`, `AsyncQuery` are exported for typing;
  user code constructs them only via `openOpfs` / `collection()` /
  `query()`.
- `field/and/or/not`, `CorvidFloat`, `ErrorCode`, the value mapping, and
  every plain-data type in `index.d.ts` are shared verbatim with the
  sync surface (they are host-side and protocol-agnostic). The
  module-level `init`/`initSync`/`ffiVersion` exports are unchanged
  sync-surface members.
- **Plan-name resolution, recorded**: OPFS-PLAN ruling 6 sketched the
  surface as "`CorvidWorker` / persistent `Db.open()`". The contract
  resolves the sketch to `openOpfs`/`AsyncDb`: a public `CorvidWorker`
  type would leak the runtime mechanism through the OOP idiom gate
  this very section states, and an async `Db.open()` would put an
  async method on the frozen sync class — `AsyncDb` is the
  Promise-flavored twin, `openOpfs` its entry point, and the locked
  ruling's *substance* (the package gains persistent open alongside
  the untouched sync API) is exactly preserved.

### 4.2 `AsyncDb`

| Method | Returns | Notes |
| --- | --- | --- |
| `static openOpfs(name, opts?)` | `Promise<AsyncDb>` | lifecycle in §5.2; `opts.persistent` (default `true`) drives the storage-persistence request |
| `collection(name)` | `Promise<AsyncCollection>` | lazily created by the engine on first write, like the sync form |
| `collections()` | `Promise<string[]>` | |
| `compact()` | `Promise<boolean>` | the quiescence gate (engine FFI.md §4.13) applies unchanged — enforced by the worker-side derived-handle counter; a violation rejects `Busy` (19) |
| `dump()` | `Promise<Uint8Array>` | the v2 dump stream (engine format; transferred, not cloned) |
| `load(bytes)` | `Promise<void>` | replays into *this* db (merge semantics — engine `load`) |
| `loadWithRenames(bytes, renames)` | `Promise<void>` | `renames: Record<string,string>` |
| `backupTo(name)` | `Promise<void>` | creates `name` under the corvid OPFS directory; existing target rejects code 17; partial target removed on failure (§5.5) |
| `storageEstimate()` | `Promise<{usage, quota}>` | main-thread `navigator.storage.estimate()`; origin-wide and imprecise (B11) — documented as such |
| `requestPersistentStorage()` | `Promise<boolean>` | main-thread `navigator.storage.persist()` — best-effort (B11) |
| `isPersistentStorage()` | `Promise<boolean>` | main-thread `navigator.storage.persisted()` |
| `close()` | `Promise<void>` | §5.3; idempotent |
| `[Symbol.asyncDispose]()` | `Promise<void>` | for `await using` |

### 4.3 `AsyncCollection`

Every sync `Collection` method, Promise-flavored, same semantics, same
order — with three deliberate, specified exceptions:

1. **`update(key, fn)` runs on the main thread as `get → fn →
   compareAndSet`.** A function cannot cross the worker boundary. This
   is *exact* (not a race-prone approximation): OPFS single-writer
   (B8) means no concurrent writer can interleave — within the tab the
   worker serializes ops, across tabs the second `open` fails outright.
   `fn` throwing rejects with `InvalidArgument`, nothing written (the
   CAS never runs) — same contract as the engine form.
2. **`scanEach(cb)` streams.** The worker pages the scan (keyset
   pagination internally) and pushes chunks; the facade invokes `cb`
   per row in order; `false` from `cb` sends a cancel and the walk
   stops (not an error); resolves to the rows visited. Memory stays
   bounded by the chunk, not the collection.
3. Chain-op error timing — see §4.4.
4. `update` resolves to the compare-and-set's boolean (applied /
   not) — the engine CAS result, where the sync form returns void.

Everything else is a 1:1 async mirror of `index.d.ts` — including the
`name` getter (facade-local and **synchronous**, set at
`collection()` time; no worker round-trip) and all **eleven**
`create*Index` variants — plus `setSchema`/`schema`, the graph ops,
the geo trio, `close`, and `[Symbol.asyncDispose]`.

### 4.4 `AsyncQuery` — fluent chain, async terminals

Chain methods (`filter`, `vector`, `text`, `fuseRrf`, `rerankMmr`,
`approx`, `limit`, `offset`, `orderBy`, `select`) are **synchronous on
the facade** and return `this`; they enqueue protocol messages consumed
in FIFO order. Terminal operations (`run`, `count`, `countDistinct`,
`sum`, `avg`, `min`, `max`, `groupCount`, `groupSum`, `groupAvg`,
`close`) return Promises.

Conversion of JS values to engine values happens **in the worker** (the
only wasm instance — same Rust converters as the sync surface, so the
two can never drift). Consequence, specified exactly: a chain method
whose argument the *sync* layer would reject at call time (bad
predicate shape, wrong typed array) instead **poisons the chain** — the
first such error is remembered and every subsequent result-carrying
terminal rejects with it. `close()` is exempt from poisoning: it always
releases the worker-side builder and resolves. Additionally, values
that cannot StructuredClone (functions, symbols, DOM nodes) **throw
synchronously** at the enqueue call with `InvalidArgument` ("not
StructuredClone-able") — the first wire-level difference from the sync
surface, named here so it is a contract, not a surprise.

**The second wire-level difference — `CorvidFloat`.** StructuredClone
of a primitive-wrapper object preserves the wrapper but drops own
properties and subclass identity, so a `CorvidFloat` instance would
cross as an unmarked boxed Number — no `DataCloneError`, silently
losing the typed-float marker. The facade therefore performs a deep
pre-post pass that replaces every `CorvidFloat` instance (at any
depth, in document values, patches, CAS operands, and predicate
values) with the **plain-object marker form** `{"__corvidFloat": n}`
that the marker protocol already documents and that StructuredClone
carries verbatim. The unwrap is exact; a hand-written plain marker
object crosses natively and takes the identical path.

### 4.5 GC and dispose

`close()` everywhere (idempotent, awaited), `Symbol.asyncDispose` where
the runtime provides it, and a main-thread `FinalizationRegistry` that
sends best-effort release messages for collected facades — the async
twin of the wasm-bindgen glue the sync surface relies on.

---

## 5. The OPFS lifecycle

### 5.1 File layout

One OPFS file per database, under one directory the package owns:

```
<OPFS root>/corvid/<name>.corvid      // the redb database file (one per database)
```

Backup files (`backupTo`, §5.5) are user-named siblings inside the same
`corvid/` directory — no reserved extensions, no second layout.

`name` is validated on the main thread before anything async: nonempty,
no `/` or `\`, no `.`/`..`, ≤ 255 bytes UTF-8 — violations reject with
`InvalidName` (11), the engine's own code for bad names (mirrors the
`TypeError` the browser would eventually raise, B10, but earlier and
ours). The directory `corvid/` is created on first open.

### 5.2 Open sequence (in order)

1. **Main thread**: validate `name` → reject (11) synchronously-fast.
2. **Main thread**: `navigator.storage.persist()` when
   `opts.persistent !== false` (B11: workers cannot call it). Awaited,
   never fatal — the result is observable via `isPersistentStorage()`.
3. **Main thread**: spawn `new Worker(new URL('./opfs-worker.js',
   import.meta.url), { type: 'module' })` — one dedicated worker **per
   open database** (v1 ruling: simplest lifecycle; multiple databases
   = multiple workers, each holding its own handle; the plan's ruling 4
   makes them independent writers on independent files anyway).
4. **Worker**: `await init()` (the shipped `pkg/` artifact) → install
   the shim's memory reference (§3.2).
5. **Worker**: `navigator.storage.getDirectory()` →
   `getDirectoryHandle('corvid', {create:true})` →
   `getFileHandle('<name>.corvid', {create:true})` →
   `createSyncAccessHandle()` — **the exclusivity point** (B8). The
   WHATWG fs spec names the lock failure `NoModificationAllowedError`;
   Chromium and Firefox ship that name, while WebKit rejects the SAME
   contention with `InvalidStateError` (observed on the CI matrix leg,
   Playwright WebKit 26.5 — a second same-origin worker's
   `createSyncAccessHandle` on a held file). The binding maps the
   *condition* — this call site's exclusive-lock failure — so either
   name rejects the open `Busy` (19), message naming the file and
   stating another tab/handle holds it.
6. **Worker**: register the handle under id 1, call wasm
   `openOpfs(1)` → engine `Db::open_with_backend(OpfsBackend{1})` →
   reply ready. Engine errors (corrupt file, incompatible format,
   …) reject with their own frozen codes — a pre-existing redb file
   recovered per redb crash semantics just works. **A failed open
   fires `StorageBackend::close()` too** (redb's third close case,
   §1.1): the worker unregisters the id and skips its own
   flush+close (the handle is already released; `closeHandle` on an
   unregistered id is a specified no-op). **No file cleanup on failed
   open**: a file this call created is empty and inert (redb treats it
   as a new database next time), and a file that pre-existed is never
   ours to delete — the asymmetry is deliberate.

### 5.3 Close sequence

`db.close()` → send close → worker drops the wasm `Db` → redb drops the
`Database` → `StorageBackend::close()` fires **exactly once** (§1.1) →
shim `flush()` + `close()` on the handle → worker unregisters the id →
**only then does the worker ack** (and terminates) — the facade
resolves on that ack.
The ordering is pinned because handle release is what lifts OPFS's
exclusive lock (B8) — the immediately-following REOPEN of §8 depends on
the lock already being free when `close()` resolves, and this contract
sentence is that proof. After the resolved `close()`, every later call
on any facade of that db rejects with `Database` (1) "database is
closed". Tab death without `close()` is a crash case — the browser
releases OPFS locks with the worker, and redb's checksummed recovery
governs the next open, exactly like a desktop crash.

### 5.4 Durability, stated honestly

Durable engine commits (and `Store::flush`'s immediate-durability
commit) reach the backend as `sync_data()` → `handle.flush()`. MDN
documents `flush()` as persisting write() changes to disk **without an
fsync-grade guarantee** (B7) — so the contract wording is: *durability
is bounded by the browser's `flush()` semantics; crash-consistency (no
torn state on reload) is redb's checksummed page/WAL format, which
either recovers or rolls back the in-flight commit on the next open.*
Relaxed durability and bulk scopes are engine-side desktop levers and
are **not** exposed in the JS surface (sync or async) — unchanged.

### 5.5 `backupTo(name)` sequence

1. Main thread validates `name` (same rules as open).
2. Worker: `getFileHandle('<name>', {create:false})` — `NotFoundError`
   means absent (good); a hit rejects `BackupTargetExists` (17) with no
   side effects — the path form's contract, restated for OPFS.
3. Worker: create the file `{create:true}` → `createSyncAccessHandle()`
   → register id → wasm `backupOpfs(id)` → engine
   `backup_with_backend` → shim flush+close, unregister. A lock
   failure here maps `Busy` (19) exactly like open (§5.2 step 5's
   name rule).
4. On any failure after creation the partial file is removed
   (best-effort, original error wins) — the path form's no-debris rule.

The backup is a *physical* copy (feature-configuration-sensitive, like
the native `Store::backup`); `dump`/`load` remains the portable
migration path. Both facts inherit the engine's docs verbatim.

### 5.6 Legacy-browser detection (B2 caveat)

At open, after acquiring the handle, the shim calls `getSize()` once:
any thenable return (pre-baseline browser with async sync-handle
methods) rejects the open with `Io` (18), message naming the
pre-March-2023 baseline. B9's matrix is the supported floor; the check
exists so the failure is a clean, attributable error rather than
undefined behavior.

### 5.7 Quota and eviction (ruling 5)

`QuotaExceededError` from `write`/`truncate` (B12) → `Storage` (4)
"storage quota exceeded". Eviction risk is documented in the README
(B11: best-effort storage is LRU-evictable whole-origin; Safari ITP
7-day rule; `persist()` exempts the origin — requested at open by
default). `storageEstimate()` is the monitoring hook, with MDN's
imprecision caveat restated in its docstring.

---

## 6. Error taxonomy (the frozen 0–19 table, extended by mapping — never by new codes)

| Source | Condition | Code | Message shape |
| --- | --- | --- | --- |
| OPFS lock | `NoModificationAllowedError` (the WHATWG fs name; Chromium/Firefox) **or** WebKit's `InvalidStateError` for the same contention, at `createSyncAccessHandle` (open or backup) | **19 Busy** | `OPFS file is locked by another tab or handle: <name>` |
| Quota | `QuotaExceededError` (write/truncate growth) | **4 Storage** | `storage quota exceeded` |
| Bad name | validation failure (§5.1) | **11 InvalidName** | `invalid database name: <name>` |
| Closed facade | any op after resolved `close()` | **1 Database** | `database is closed` |
| Unclonable value | `DataCloneError` at post | **12 InvalidArgument** | `value is not StructuredClone-able: <detail>` |
| Legacy handle | async sync-handle methods (§5.6) | **18 Io** | pre-baseline browser message |
| Worker/env | spawn failure; missing OPFS APIs in the worker; `SecurityError`/`UnknownError` at `getDirectory` (private mode) | **18 Io** | DOMException name + message carried verbatim |
| Engine | every wasm-layer error | **engine's own code** | engine text, unchanged |

**`NoSuchFile` is considered and absent in v1**: open creates-or-opens
and backup's existence pre-check *consumes* `NotFoundError` as "absent
is fine" — no user-visible op can name a missing file. Recorded so the
OPFS-PLAN's taxonomy mention is closed rather than dropped. No code
outside the frozen table is ever thrown; the async layer only *maps*.

---

## 7. The worker protocol (postMessage RPC; StructuredClone values; no SAB)

### 7.1 Envelope shapes

```ts
// main → worker
{ t:'req', id:number, op:string, h:number, ch?:number, a:unknown[] } // a: raw JS args, StructuredClone'd; ch: a second handle id when the op needs one (coll.create's new collection id; every query.* op's owning collection id) — handle ids are allocated by the CALLER (the facade)
{ t:'cont', id:number } | { t:'cancel', id:number }                 // scanEach backpressure/stop
// worker → main
{ t:'ok',   id:number, v:unknown }                                   // v may transfer (dump bytes)
{ t:'err',  id:number, c:number, m:string }                          // frozen code + message
{ t:'chunk',id:number, rows:[{key,doc}] }                            // scanEach pages
```

Request ids are unique per worker (a counter); replies carry the
matching id; ordering is FIFO per worker (postMessage guarantee) — the
query-chain design (§4.4) depends on it and names that dependency.

### 7.2 Op table (complete)

`db.open{name} · db.close · db.collections · db.compact · db.dump ·
db.load{bytes,renames?} · db.backupTo{name} · coll.create{name} ·
coll.close · coll.gc{h} · query.gc{h}` plus, per `AsyncCollection`
method, one `coll.<method>` op with raw args — the §4.3 mirror minus
`update` (composed client-side) and `scanEach` (streaming op
`coll.scanEach` with chunk/cont/cancel). `AsyncQuery` chain and
terminal methods are `query.op{q, method, a}` and
`query.terminal{q, method, a}`; the worker lazily creates the
`WasmQuery` on a q's first op.

Transfer policy: request args are cloned (v1); response buffers are
transferred when the platform allows (`dump` bytes) — an optimization,
never a correctness dependency.

### 7.3 Concurrency model

One worker = one engine instance = one file (B8 makes cross-tab
contention impossible by construction). Within the worker, ops execute
strictly in arrival order; no op interleaves another. There is no lock,
queue, or coordination protocol to get wrong — the plan's ruling 4.

---

## 8. Conformance mapping (T5 — how the last two fixture files finally run)

The browser conformance runs in **all three engines — Chromium,
Firefox, and WebKit — as two legs**: the SAME golden spec in-page via
`await init()` (vitest browser mode — PLAN.md §7's "runs unchanged"
promise, cashed for the six sync files' 230 lines), and a Playwright
E2E leg over plain http where the async surface runs the two
previously excluded files with the production-faithful Worker
construct (no dev-server transform — vite's dev-time worker rewrite
stalls raw module workers, so the async leg runs unbundled; the quirk
is a test-environment fact, not a shipped defect, and both legs'
totals are pinned):

| Fixture op | Browser mapping |
| --- | --- |
| `FILEDB <path>` | `openOpfs(basename)` — a per-scenario name; workdir semantics become the `corvid/` OPFS directory |
| `REOPEN` | `await db.close()` then `await openOpfs(sameName)` (§5.3 releases the lock first — ordering is the test's own proof) |
| `DUMP` | `bytes = await db.dump()` — the harness holds the buffer |
| `LOAD` | `await db.load(bytes)` |
| `LOAD_RENAMES docs,renamed` | `await db.loadWithRenames(bytes, {docs: 'renamed'})`; the fixture's invalid-TARGET case (`docs,__bad`) expects 11 |
| `BACKUP` / `BACKUP_DUP` | `await db.backupTo('<scenario>-backup')` (a plain sibling name under `corvid/`); second call expects 17 |
| `FILEDB2` | a second `openOpfs` on a fresh name |

Baseline arithmetic: the 230-line six-file suite is unchanged (sync
surface, Node leg keeps running it); the browser leg runs
**267/267** — the two honestly-N/A'd files close, and
`docs/SURFACE.tsv`'s file-op rows flip from N/A to MAPPED (annotated
ASYNC — the gate update lands with T5, not before, so the manifest
never claims an unshipped surface).

Extra browser-only tests the E2E leg adds: persistence across page reload
(navigate away and back, data intact); cross-tab BUSY (second page's
`openOpfs` rejects 19, and the lock frees the moment the first page
closes); dump bytes transferred intact across the worker boundary.
Quota-path unit tests run in Node against the fake handle (mocked —
real quota can't be forced); the legacy-handle detection (§5.6, mocked
thenable `getSize`) likewise.

**The enforced matrix (updated 2026-09-02): both legs run on
Chromium, Firefox, and WebKit in CI — no engine is skipped, and no
test carries an engine condition.** The former "Firefox/Safari remain
a documented manual matrix" paragraph is closed by the matrix leg
itself. Two environment facts the harness owns, recorded where they
are applied (playwright.config.ts, test/browser-e2e/e2e-webkit
.spec.mjs) and repeated here for the contract record:

- **Firefox gates `navigator.storage.persist()` behind a permission
  prompt** (§5.2 step 2 awaits it by default). In automation nobody
  answers the prompt, so the promise stays pending forever and every
  OPFS open hangs; `persisted()` resolves fine. The harness sets
  Firefox's own testing prefs (`dom.storageManager.prompt.testing[.
  allow]`) so persist() resolves `true`, like a user granting it.
- **Playwright's default ephemeral context disables WebKit's OPFS
  entirely** (`getDirectory()` rejects `UnknownError` — the same
  private-browsing behavior MDN documents; microsoft/playwright
  #18235). Real Safari runs a real profile, so the webkit leg runs
  the same suite body through `launchPersistentContext` on a fresh
  per-worker profile, and **wipes this origin's `corvid/` OPFS
  directory before its first test** — Playwright's WebKit keeps
  origin-keyed OPFS alive across profile directories (verified:
  files written under profile X are visible under a fresh profile
  Y), so without the wipe run N+1 would read run N's databases.
  Both legs' assertions are identical across engines; only the
  browser plumbing differs.

---

## 9. Build & size (T4)

- One wasm artifact still: the backend adds no dependency (wasm-bindgen
  imports only); `wasm-pack build --release --target web` unchanged.
- New shipped JS: the async facade + worker (`index.js` grows,
  `opfs-worker.js` added; `files` gains it).
- Budget **unchanged: 1 MiB gzipped** for `pkg/corvid_js_bg.wasm`,
  enforced by `scripts/size-gate.sh`; the Rust delta is expected to be
  noise, but the gate — not expectation — is the contract. Size number
  recorded in the README at release, beside the 363 KB baseline.
- `wasm-opt` stays off (measured ruling, PLAN.md §6) — re-measured once
  at T4; if binaryen flips the numbers the PLAN.md decision row changes
  in the same commit, not silently.

---

## 10. Non-goals (v1) and standing guards

Non-goals, inherited verbatim from the plan and closed here: multi-tab
writers; COOP/COEP synchronous main-thread API; SharedArrayBuffer;
migrating the sync surface to async; Flutter/React wrappers. Also
non-goals, newly recorded: exposing relaxed durability/bulk scopes in
JS; a `mode:'read-only'` shared-handle opening; Node OPFS emulation.

Standing guards (inherited, all still binding): golden-suite gating;
surface manifest (with the §8 ASYNC annotation discipline); OOP idiom
gate — Promise-returning methods are the language-idiom form of the
same contract; review gates per task; RED-first bugs; docs-stay-true;
size budget; bump registry (engine v0.3.4 tag flows to all 10 bindings;
corvid-js's golden fixtures re-vendor from the v0.3.4 release).

---

## 11. Spec review gate (the checklist this file must survive before T2)

1. Every §1.3 browser fact re-checked against its MDN/WHATWG source.
2. §2 signatures compile against redb 4.2's real trait (one spike
   compile, no behavior) — re-verified in T2 with tests.
3. §4 is a complete mirror: a walk of `index.d.ts` finds no sync method
   missing an async twin or explicitly excepted (§4.3/§4.4).
4. §6 throws nothing outside the frozen 0–19 table.
5. §7's op table covers every §4 method exactly once.
6. §8's fixture arithmetic (230 + 37 = 267) checks against the vendored
   files.
7. The sync surface, its specs, and every other binding are untouched.
