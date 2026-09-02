# corvid-js OPFS persistence — program plan

Date: 2026-09-02 · Status: **EXECUTING** (T1 landed 2026-09-02: the binding
contract is `docs/OPFS-SPEC.md`, review-gated before any code; the rulings
below are locked and the spec elaborates them) · Owner: controller session
Read first: engine DESIGN.md L0 (VFS layer: "the OPFS-SAHPool backend is
specified, not implemented — the remaining blocker for browser persistence");
the 2026-05-29 deferral decision + its 2026-08-30 ledger disposition ("reopening
needs product signal — someone actually building the browser runtime" — this
program IS that signal); corvid-js PLAN.md §OPFS boundary; FFI.md §8 OOP gate.

## Locked architecture rulings (from the design conversation)

1. **Worker-hosted engine, async main-thread API.** The wasm engine moves into
   a Dedicated Worker (sync OPFS handles are Worker-only). Main thread gets
   the same OOP surface (Db/Collection/Query) with methods returning Promises.
   No SharedArrayBuffer/COOP/COEP requirement — plain postMessage RPC. A
   sync-flavored API (`createSyncInterface`) is out of scope (needs SAB +
   cross-origin isolation headers; documented non-goal for v1).
2. **redb `StorageBackend` over OPFS.** One OPFS file per database via
   `createSyncAccessHandle()` — genuine pread/pwrite (`handle.read/write` at
   offsets, `flush()` per commit). redb 4.x exposes `StorageBackend` as its
   storage seam (verify the exact trait surface in the vendored redb source
   before Task 2 — this is the plan's largest unverified assumption; if the
   trait is not exposed for custom backends on wasm, the fallback is a
   patched fork of redb behind a cargo patch =, documented as such).
3. **Growth strategy: truncate-first, SAHPool fallback.** Modern
   Chromium/Firefox/Safari sync handles support `truncate()` for growth —
   use it. If any target browser's handle lacks reliable growth (test in
   Task 3), fall back to the sqlite-wasm SAHPool shape (pre-allocated file
   pool as a block device). Do not build SAHPool unless measurements demand
   it (YAGNI is recorded here as the ruling).
4. **Single-writer = free cross-tab.** OPFS grants sync handles exclusively
   per file across the whole browser: the second tab's open() fails cleanly
   → surface as CorvidError BUSY-style ("database is locked by another
   tab"). No multi-tab coordination in v1 (documented, like sqlite-wasm).
5. **Quota hygiene.** `navigator.storage.persist()` on open (best-effort,
   result surfaced); `estimate()` exposed via `db.storageEstimate()`; the
   eviction risk documented in README.
6. **The existing package stays canonical.** `corvid-js` (npm, live) gains
   `CorvidWorker` / persistent `Db.open()` alongside the in-memory sync API;
   in-memory stays sync (its contract is pinned by regressions.spec.ts);
   the persistent API is async-only. wasm size budget stays enforced
   (current 363 KB gz; budget 1 MiB — the Worker+OPFS code must not blow
   it; measure in Task 4).

## Tasks

- **T1: Spec doc** (this file promoted to binding contract + corvid-js
  PLAN.md §persistent updated + docs-site page updated): exact API surface
  (async Db/Collection/Query mirror), the OPFS lifecycle (open →
  createSyncAccessHandle → StorageBackend wiring → close/flush), error
  taxonomy (BUSY cross-tab, quota, NoSuchFile), the worker protocol
  (message shapes, transferables). Review gate on the SPEC before code —
  the FFI.md discipline.
- **T2: The storage backend** (Rust, wasm32): implement redb StorageBackend
  over sync-handle raw ops (read_at/write_at/len/set_len/flush mapped to
  handle.read/write/truncate/flush) — wasm-bindgen exports for the handle
  ops passed IN from JS (the Worker owns the handle; Rust receives an
  opaque handle-id, JS shims the calls — keeps Rust free of DOM types).
  Verify redb's trait first; unit-test against a JS-driven fake handle.
- **T3: Worker runtime**: worker.ts hosting the wasm engine + the RPC
  bridge (postMessage; StructuredClone of values; no SAB); main-thread
  async facade classes reusing the existing OOP layer's semantics. Browser
  matrix verification of truncate()/sync-handle semantics (Chromium, FF,
   Safari) — document the matrix, fall back to SAHPool only if a browser
  forces it (Ruling 3).
- **T4: Size + build**: wasm-pack build with the worker + backend; size
  gate (budget check in CI, number recorded in BENCHES-equivalent or the
  package README); wasm-opt ruling re-measured (current: off, grows gzip).
- **T5: Browser-tested conformance**: Playwright/Chromium headless CI job —
  port the golden suite's in-memory-executable lines to the async API
  (the file-op fixtures finally run in-browser via OPFS: FILEDB/REOPEN/
  DUMP/LOAD/BACKUP become real, closing the two honestly-N/A'd fixture
  files); persistence-across-reload tests; cross-tab BUSY test (two pages);
  quota/eviction docs verified. Firefox/Safari legs if CI runners allow,
  else documented manual matrix.
- **T6: Release + docs**: npm publish (automated via the v* tag workflow
  + trusted publishing already linked), docs-site page rewritten (the
  OPFS boundary paragraph replaced by the real persistence story), engine
  DESIGN.md decision-log row (deferral closed, mechanism, triggers for
  SAHPool/COOP-EP-sync variants), READMEs.

## Non-goals (v1, recorded)

Multi-tab writers; COOP/COEP synchronous main-thread API; SharedArrayBuffer;
migrating the in-memory sync API to async; Flutter/React wrappers.

## Standing guards

The whole program inherits: golden-suite gating, surface manifest, OOP idiom
gate (FFI.md §8 — Promise-returning methods are the language-idiom form of
the same contract), review gates per task, RED-first bugs, docs-stay-true,
size budget, and the bump registry (engine-tag pins keep flowing).
