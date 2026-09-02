//! The `Db` wasm class — the engine-binding twin of the JS `Db`
//! (index.js). Holds the engine `Arc<Db>` plus the derived-handle
//! counter that gates exclusive compaction (the FFI's §4.13 rule,
//! mirrored: `compact` needs the counter at exactly 1 — the db
//! itself — AND sole `Arc` ownership, else `CORVID_E_BUSY`).
//!
//! In-memory per session remains the SYNC surface's boundary, but the
//! persistence boundary is now implemented: `openOpfs(handleId)`
//! opens the engine over an OPFS sync handle held by the JS host
//! (`opfs-shim.js` + the Worker runtime; docs/OPFS-SPEC.md). The
//! in-memory constructor stays the default for the sync OOP layer;
//! the OPFS form feeds the async surface.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use corvid::Db;
use wasm_bindgen::prelude::*;

use crate::error::{CResult, CorvidErr, ErrCode};

/// The db's derived-handle counter: 1 for the db itself, +1 per live
/// `Collection`/`Query` (decremented by their `close`, their
/// consuming terminal op, or GC finalization). Mirrors the FFI's
/// `Arc<AtomicUsize>` so `compact` keeps the same quiescence contract.
pub(crate) type Counter = Arc<AtomicUsize>;

pub(crate) struct DbInner {
    pub db: Arc<Db>,
    pub counter: Counter,
}

#[wasm_bindgen]
pub struct WasmDb {
    inner: Mutex<Option<DbInner>>,
}

pub(crate) fn retain(counter: &Counter) {
    counter.fetch_add(1, Ordering::SeqCst);
}

pub(crate) fn release(counter: &Counter) {
    counter.fetch_sub(1, Ordering::SeqCst);
}

#[wasm_bindgen]
impl WasmDb {
    /// Open a private, in-memory database (the sync surface's default;
    /// see the module docs).
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<WasmDb, JsValue> {
        let db = Db::open_in_memory().map_err(CorvidErr::from)?;
        Ok(Self::from_engine(db))
    }

    /// Open a persistent database over a sync-handle id registered in
    /// the host's `corvidOpfs` shim (docs/OPFS-SPEC.md §3.3). The host
    /// (Worker) owns the `FileSystemSyncAccessHandle`; `install` must
    /// have been called with the wasm memory before this. Handle
    /// release is deterministic: dropping the last reference to the
    /// engine `Db` fires the backend's `close`, which flushes and
    /// closes the handle and unregisters the id.
    #[wasm_bindgen(js_name = openOpfs)]
    pub fn open_opfs(handle_id: u32) -> Result<WasmDb, JsValue> {
        let db = Db::open_with_backend(crate::opfs::OpfsBackend::new(handle_id))
            .map_err(CorvidErr::from)?;
        Ok(Self::from_engine(db))
    }

    fn from_engine(db: Db) -> WasmDb {
        WasmDb {
            inner: Mutex::new(Some(DbInner {
                db: Arc::new(db),
                counter: Arc::new(AtomicUsize::new(1)),
            })),
        }
    }

    pub(crate) fn with_inner<T>(&self, f: impl FnOnce(&DbInner) -> CResult<T>) -> CResult<T> {
        let guard = self.inner.lock().unwrap();
        match guard.as_ref() {
            Some(inner) => f(inner),
            None => Err(CorvidErr::new(
                ErrCode::Argument,
                "database handle is closed",
            )),
        }
    }

    /// Acquire a collection handle (lazily created by the engine on
    /// first write; names are validated at write time, like the ABI).
    /// Increments the derived-handle counter.
    pub fn collection(&self, name: String) -> Result<crate::WasmCollection, JsValue> {
        self.with_inner(|inner| {
            retain(&inner.counter);
            Ok(crate::WasmCollection::new(
                Arc::clone(&inner.db),
                name,
                Arc::clone(&inner.counter),
            ))
        })
        .map_err(JsValue::from)
    }

    /// The names of the database's collections, in engine order.
    pub fn collections(&self) -> Result<Vec<String>, JsValue> {
        self.with_inner(|inner| inner.db.collections().map_err(CorvidErr::from))
            .map_err(JsValue::from)
    }

    /// Compact the database's storage. Requires quiescence: every
    /// `Collection`/`Query` derived from this db must be closed (or
    /// have executed), otherwise `Busy` (19). Returns whether any
    /// data was moved out. On the in-memory store this is the engine's
    /// own housekeeping pass (identical semantics to the file-backed
    /// compact; it simply has no durability to flush — the OPFS
    /// boundary again).
    pub fn compact(&self) -> Result<bool, JsValue> {
        self.compact_inner().map_err(JsValue::from)
    }

    /// Close the handle (idempotent). Derived handles may legitimately
    /// outlive it — the engine lives until the last handle drops.
    /// For an OPFS db this is the deterministic handle release: the
    /// engine `Db` drops (when the last derived handle is gone too),
    /// the backend's `close` fires, the sync handle flushes, closes,
    /// and unregisters (SPEC §5.3's ordering guarantee begins here).
    pub fn close(&self) {
        let _ = self.inner.lock().unwrap().take();
    }

    /// The v2 dump stream as bytes — the portable whole-database form
    /// (feature-configuration-safe, unlike a physical backup; SPEC
    /// §5.5). Returned as a `Uint8Array` (a fresh copy out of wasm
    /// memory — safe to transfer across workers).
    pub fn dump(&self) -> Result<Vec<u8>, JsValue> {
        self.with_inner(|inner| {
            let mut out = Vec::new();
            inner.db.dump(&mut out).map_err(CorvidErr::from)?;
            Ok(out)
        })
        .map_err(JsValue::from)
    }

    /// Replay a dump stream into this database (merge semantics — the
    /// engine's `load` contract; see `Db::load` in the engine docs).
    pub fn load(&self, bytes: Vec<u8>) -> Result<(), JsValue> {
        self.with_inner(|inner| inner.db.load(&bytes[..]).map_err(CorvidErr::from))
            .map_err(JsValue::from)
    }

    /// `load` with a collection-rename map, crossing as two parallel
    /// arrays (wasm-bindgen has no tuple support — SPEC §3.3); the
    /// facade's `Record<string, string>` is decomposed before this
    /// call. Keys and values must be the same length.
    #[wasm_bindgen(js_name = loadWithRenames)]
    pub fn load_with_renames(
        &self,
        bytes: Vec<u8>,
        rename_keys: Vec<String>,
        rename_values: Vec<String>,
    ) -> Result<(), JsValue> {
        self.with_inner(|inner| {
            if rename_keys.len() != rename_values.len() {
                return Err(CorvidErr::argument(
                    "loadWithRenames: rename keys and values must be parallel arrays",
                ));
            }
            let renames: std::collections::BTreeMap<String, String> =
                rename_keys.into_iter().zip(rename_values).collect();
            inner
                .db
                .load_with_renames(&bytes[..], &renames)
                .map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)
    }

    /// Physical backup into a second registered sync handle (SPEC
    /// §5.5): a raw-table copy, feature-configuration-sensitive like
    /// the native `backup`. The CALLER owns the target's
    /// existence-check and partial-target cleanup — the host created
    /// the target handle, only it can remove the file.
    #[wasm_bindgen(js_name = backupOpfs)]
    pub fn backup_opfs(&self, target_handle_id: u32) -> Result<(), JsValue> {
        self.with_inner(|inner| {
            inner
                .db
                .backup_with_backend(crate::opfs::OpfsBackend::new(target_handle_id))
                .map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)
    }
}

impl WasmDb {
    fn compact_inner(&self) -> CResult<bool> {
        let mut guard = self.inner.lock().unwrap();
        let inner = guard
            .as_mut()
            .ok_or_else(|| CorvidErr::new(ErrCode::Argument, "database handle is closed"))?;
        if inner.counter.load(Ordering::SeqCst) != 1 {
            return Err(CorvidErr::new(
                ErrCode::Busy,
                "compact: derived handles are still open",
            ));
        }
        // Take the Arc out so exclusivity is observable, compact the
        // sole Db, re-share. `try_unwrap` failing means a handle raced
        // us — also Busy. While the lock is held the placeholder is
        // unobservable to every other call (wasm is single-threaded,
        // but the lock keeps the shape identical to the node twin).
        let arc = std::mem::replace(&mut inner.db, Arc::new(placeholder_db()));
        match Arc::try_unwrap(arc) {
            Ok(mut db) => {
                let moved = match db.compact() {
                    Ok(m) => m,
                    Err(e) => {
                        inner.db = Arc::new(db);
                        return Err(CorvidErr::from(e));
                    }
                };
                inner.db = Arc::new(db);
                Ok(moved)
            }
            Err(arc) => {
                inner.db = arc;
                Err(CorvidErr::new(
                    ErrCode::Busy,
                    "compact: engine handles are still open",
                ))
            }
        }
    }
}

/// A stand-in while the real `Arc<Db>` is being unwrapped for
/// exclusive compaction (never observed: the mutex is held throughout).
fn placeholder_db() -> Db {
    Db::open_in_memory().expect("in-memory engine placeholder")
}
