//! corvid-js — the browser/Worker binding for the corvid engine.
//!
//! This crate is the *engine-binding layer*: it compiles the corvid
//! engine to `wasm32-unknown-unknown` (git dep pinned to an exact
//! release tag) and exposes it through wasm-bindgen **typed exports**
//! — `Db`, `Collection`, `Query` classes with `JsValue` crossing
//! points. The public, idiomatic OOP surface (`Db`, `Collection`,
//! `Query` fluent chaining, `field()`, `CorvidError`, `CorvidFloat`)
//! lives in the JavaScript layer (`index.js`) which wraps these
//! classes — see docs/PLAN.md for the architecture ruling and §5 for
//! the in-memory persistence boundary (OPFS is a decided, deferred
//! addition).

use wasm_bindgen::prelude::*;

mod collection;
mod db;
mod error;
mod opfs;
mod pred;
mod query;
mod value;

pub use collection::WasmCollection;
pub use db::WasmDb;
pub use error::CorvidErr;
pub use query::WasmQuery;

/// The FFI-ABI generation this binding's OOP surface covers
/// (docs/FFI.md §1.3 stability policy; `corvid_ffi_version` = 1 —
/// plus the v0.3.0 additive symbols `corvid_value_map_keys` /
/// `corvid_phrase_search`, which map onto the JS value mapping's key
/// enumeration and `Collection.phraseSearch`).
#[wasm_bindgen]
pub fn ffi_version() -> u32 {
    1
}
