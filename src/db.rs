//! The `Db` wasm class — the engine-binding twin of the JS `Db`
//! (index.js). Holds the engine `Arc<Db>` plus the derived-handle
//! counter that gates exclusive compaction (the FFI's §4.13 rule,
//! mirrored: `compact` needs the counter at exactly 1 — the db
//! itself — AND sole `Arc` ownership, else `CORVID_E_BUSY`).
//!
//! In-memory per session — the shipped persistence boundary (the
//! recorded DESIGN deferral): wasm32-unknown-unknown has no
//! filesystem, so `Db::open(path)`'s file-backed store, and with it
//! dump/load/backup, are not constructible here. OPFS-backed
//! persistence is a decided, trigger-based future addition (README,
//! docs/PLAN.md §5) — this class opens exactly `Db::open_in_memory`.

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
    /// Open a private, in-memory database (the wasm persistence
    /// boundary — see the module docs).
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<WasmDb, JsValue> {
        let db = Db::open_in_memory().map_err(CorvidErr::from)?;
        let counter: Counter = Arc::new(AtomicUsize::new(1));
        Ok(WasmDb {
            inner: Mutex::new(Some(DbInner {
                db: Arc::new(db),
                counter,
            })),
        })
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
    pub fn close(&self) {
        let _ = self.inner.lock().unwrap().take();
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
