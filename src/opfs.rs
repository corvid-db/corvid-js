//! The OPFS storage backend — redb's `StorageBackend` implemented over
//! a `FileSystemSyncAccessHandle` owned by the JS host (the Worker).
//!
//! Division of labor (docs/OPFS-SPEC.md §3): Rust owns the trait
//! implementation and never touches a DOM type; the host owns the
//! handle and the wasm memory. The wasm engine reaches the handle
//! through six **synchronous** imported functions on
//! `globalThis.corvidOpfs` — synchronous because redb calls its
//! backend from inside synchronous transaction internals, and
//! sync-handle reads/writes are the one browser primitive that can
//! answer in place. The host-side implementation is `opfs-shim.js`
//! (shared verbatim by the real Worker runtime and the Node test
//! suite's fake handles, so the semantics cannot drift).
//!
//! Wire types: byte offsets and lengths cross as `f64` (exact to 2^53
//! — far above any quota-bounded OPFS file — avoiding per-call BigInt
//! allocation on the hottest path); `ptr`/`len` are `u32` (wasm32
//! memory bounds). Errors cross as thrown `Error`s whose messages
//! begin with the DOMException name (`QuotaExceededError: …`), mapped
//! here to `io::Error` with defined kinds; they then surface through
//! redb as `StorageError` and the engine as `Error::Storage`/`Io`,
//! code-true end to end.

use std::io;

use redb::StorageBackend;
use wasm_bindgen::prelude::*;

/// The wasm imports every host of the persistent engine must install
/// (see `opfs-shim.js` — the reference implementation).
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = corvidOpfs, catch)]
    fn read(handle: u32, offset: f64, ptr: u32, len: u32) -> Result<i32, JsValue>;
    #[wasm_bindgen(js_namespace = corvidOpfs, catch)]
    fn write(handle: u32, offset: f64, ptr: u32, len: u32) -> Result<i32, JsValue>;
    #[wasm_bindgen(js_namespace = corvidOpfs, catch)]
    fn length(handle: u32) -> Result<f64, JsValue>;
    #[wasm_bindgen(js_namespace = corvidOpfs, js_name = setLen, catch)]
    fn set_len(handle: u32, len: f64) -> Result<(), JsValue>;
    #[wasm_bindgen(js_namespace = corvidOpfs, catch)]
    fn sync(handle: u32) -> Result<(), JsValue>;
    #[wasm_bindgen(js_namespace = corvidOpfs, js_name = closeHandle, catch)]
    fn close_handle(handle: u32) -> Result<(), JsValue>;
}

/// A shim error → the io error redb sees. The host shim stringifies
/// DOMExceptions as `"<Name>: <message>"`; kinds are assigned by that
/// prefix: quota → `StorageFull`, the shim's own end-of-file signal →
/// `UnexpectedEof` (this one is not a DOMException — it originates in
/// the shim's fill loop per SPEC §1.3-B3 — which is why §3.2's
/// "everything else" clause does not cover it), everything else
/// carries the DOM text verbatim.
fn shim_err(e: JsValue) -> io::Error {
    // The shim throws Error objects whose MESSAGE carries the wire form
    // ("QuotaExceededError: ..."); a bare string crosses as a string.
    // `as_string` alone sees only the latter — extract `.message()`
    // (falling back to `.name()`) for thrown Errors.
    let text = if let Some(s) = e.as_string() {
        s
    } else if let Ok(err) = e.dyn_into::<js_sys::Error>() {
        let m: String = err.message().into();
        if m.is_empty() {
            err.name().into()
        } else {
            m
        }
    } else {
        "unknown OPFS shim error".to_owned()
    };
    if text.starts_with("QuotaExceededError") {
        io::Error::new(io::ErrorKind::StorageFull, text)
    } else if text.starts_with("UnexpectedEof") {
        io::Error::new(io::ErrorKind::UnexpectedEof, text)
    } else {
        io::Error::other(text)
    }
}

/// The largest offset/length value that crosses the f64 wire AND the
/// JS safe-integer range (2^53 − 1 — the shim's Number.isSafeInteger
/// checks cap at the same bound).
const MAX_OFFSET: u64 = (1 << 53) - 1;

/// Convert an offset/length pair to the shim wire form, refusing what
/// cannot cross exactly.
fn wire(offset: u64, len: usize) -> io::Result<(f64, u32)> {
    if offset > MAX_OFFSET {
        return Err(io::Error::other(
            "OPFS offset exceeds 2^53 (impossible under browser quotas)",
        ));
    }
    let len =
        u32::try_from(len).map_err(|_| io::Error::other("OPFS transfer exceeds u32 length"))?;
    Ok((offset as f64, len))
}

/// The backend redb talks to: one registered sync-handle id. `Debug`
/// and `Send`/`Sync` hold trivially (a bare `u32`); the handle itself
/// lives in the JS host's registry.
#[derive(Debug)]
pub(crate) struct OpfsBackend {
    handle_id: u32,
}

impl OpfsBackend {
    pub(crate) fn new(handle_id: u32) -> Self {
        Self { handle_id }
    }
}

impl StorageBackend for OpfsBackend {
    fn len(&self) -> io::Result<u64> {
        let n = length(self.handle_id).map_err(shim_err)?;
        if !n.is_finite() || n < 0.0 || n.fract() != 0.0 || n > MAX_OFFSET as f64 {
            return Err(io::Error::other(
                "corvidOpfs.length returned a non-safe-integer",
            ));
        }
        Ok(n as u64)
    }

    fn read(&self, offset: u64, out: &mut [u8]) -> io::Result<()> {
        let (off, len) = wire(offset, out.len())?;
        let ptr = out.as_mut_ptr() as u32;
        let n = read(self.handle_id, off, ptr, len).map_err(shim_err)?;
        if n != len as i32 {
            // The shim fills or throws (SPEC §3.2); a short count here
            // means it did neither — refuse rather than feed redb
            // half-cleared pages.
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                format!("OPFS short read: {n} of {len} bytes"),
            ));
        }
        Ok(())
    }

    fn set_len(&self, len: u64) -> io::Result<()> {
        if len > MAX_OFFSET {
            return Err(io::Error::other(
                "OPFS set_len exceeds 2^53 (impossible under browser quotas)",
            ));
        }
        set_len(self.handle_id, len as f64).map_err(shim_err)
    }

    fn sync_data(&self) -> io::Result<()> {
        sync(self.handle_id).map_err(shim_err)
    }

    fn write(&self, offset: u64, data: &[u8]) -> io::Result<()> {
        let (off, len) = wire(offset, data.len())?;
        let ptr = data.as_ptr() as u32;
        let n = write(self.handle_id, off, ptr, len).map_err(shim_err)?;
        if n != len as i32 {
            // B4: a partially failed write may not throw at the DOM
            // layer; the shim re-checks, and so does the backend.
            return Err(io::Error::other(format!(
                "OPFS short write: {n} of {len} bytes"
            )));
        }
        Ok(())
    }

    fn close(&self) -> io::Result<()> {
        close_handle(self.handle_id).map_err(shim_err)
    }
}
