//! The JS ↔ engine `Value` mapping (docs/PLAN.md §4 — the binding's
//! value contract), via `js-sys` reflection over `wasm_bindgen::JsValue`.
//!
//! JS → engine:
//! - `null` / `undefined`        → `Null`
//! - `boolean`                   → `Bool`
//! - `number`                    → `Int` when it is an integer value,
//!   not `-0`, and within ±2^53 (the exact-f64 integer range); every
//!   other number (`0.5`, `inf`, `NaN`, `-0.0`) → `Float`; a
//!   `CorvidFloat` marker object forces `Float` for integer-valued
//!   doubles
//! - `bigint`                    → `Int` (full i64; out of range throws)
//! - `string`                    → `Text`
//! - `Uint8Array` (Buffer is a   → `Bytes` (copied through wasm memory,
//!   Uint8Array subclass)          so the raw bytes are exact)
//! - `Float32Array`              → `Vector` (copied; f32 bits exact)
//! - `Array`                     → `Array` (recursive)
//! - plain object                → `Map` (recursive; string keys)
//!
//! engine → JS:
//! - `Int`   → `number` when within ±2^53, else `BigInt`
//! - `Float` → `number` with f64 semantics (see the NaN note below)
//! - `Bytes` → `Uint8Array`, `Vector` → `Float32Array`, `Map` → plain
//!   object (keys in the engine's sorted order — `Object.keys()` of a
//!   mapped document IS the ABI's `corvid_value_map_keys` enumeration,
//!   ascending byte order)
//!
//! NaN fidelity: JS numbers are unboxed f64s in the engine's wasm
//! table and cross the boundary as JS Numbers. A JS consumer observes
//! NaN-as-NaN (semantic equality, ordering; `-0.0`/`±inf` bits are
//! exact), but must not rely on f64 NaN *payload* bits surviving the
//! JS↔wasm Number crossing — the same documented corner as the node
//! binding's N-API boundary, with the same discipline in the golden
//! port (NaN-class comparison). Vector elements are unaffected
//! (Float32Array memory is copied, never boxed).
//!
//! Both directions carry a nesting-depth cap (`MAX_DEPTH`, the
//! engine's `corvid::value::MAX_NESTING`): deeper values (or cyclic
//! JS input) convert to a clean InvalidArgument error rather than
//! recursing toward a trap. Capping ENCODE at the engine's decode
//! bound also makes "converter-accepted == decodable" hold by
//! construction: a value this binding accepts can never encode into
//! bytes the engine's decoder would reject.

use std::collections::BTreeMap;

use corvid::Value;
use wasm_bindgen::{JsCast, JsValue};

use crate::error::{CResult, CorvidErr, ErrCode};

const MAX_SAFE: i64 = 9_007_199_254_740_991; // 2^53 - 1

/// Maximum container nesting the converters will walk — the engine's
/// `corvid::value::MAX_NESTING` (128), taken directly from the
/// compiled-in engine so the two can never drift. Deeper input
/// (including cyclic JS objects, which are depth-unbounded) maps to a
/// clean InvalidArgument instead of unbounded recursion. Capping at
/// the engine's own decode bound (not a merely stack-safe larger
/// number) is the contract: anything the converter accepts is
/// decodable by the engine, so a deep-but-buildable value can never
/// round-trip into bytes the session cannot read back.
const MAX_DEPTH: usize = corvid::value::MAX_NESTING;

fn argument(msg: &str) -> CorvidErr {
    CorvidErr::new(ErrCode::Argument, msg)
}

fn type_of(v: &JsValue) -> String {
    v.js_typeof().as_string().unwrap_or_default()
}

/// Lift a JS-origin failure (a thrown value) into a `CorvidErr` with
/// its message (code 12 — argument), for reflection paths that can
/// throw (BigInt parsing, property access on revoked objects, ...).
pub fn js_throw(e: &JsValue) -> CorvidErr {
    CorvidErr::argument(format!("JS error: {}", js_error_message(e)))
}

/// Best-effort message extraction from an arbitrary thrown JS value.
pub fn js_error_message(e: &JsValue) -> String {
    if let Some(err) = e.dyn_ref::<js_sys::Error>() {
        return err.message().as_string().unwrap_or_else(|| "error".into());
    }
    if let Some(s) = e.as_string() {
        return s;
    }
    if let Ok(tostring) = js_sys::Reflect::get(e, &JsValue::from_str("toString")) {
        if let Ok(s) = js_sys::Function::from(tostring).call0(e) {
            if let Some(s) = s.as_string() {
                return s;
            }
        }
    }
    format!("{e:?}")
}

/// Convert an arbitrary JS value into an engine `Value`.
pub fn value_from_js(u: &JsValue) -> CResult<Value> {
    value_from_js_at(u, 0)
}

fn too_deep() -> CorvidErr {
    argument(&format!(
        "value nesting exceeds the maximum depth of {MAX_DEPTH}"
    ))
}

fn value_from_js_at(u: &JsValue, depth: usize) -> CResult<Value> {
    if depth > MAX_DEPTH {
        return Err(too_deep());
    }
    // `typeof null === "object"` — the JS wart — so null/undefined are
    // distinguished before the typeof dispatch.
    if u.is_null() || u.is_undefined() {
        return Ok(Value::Null);
    }
    match type_of(u).as_str() {
        "boolean" => Ok(Value::Bool(u.as_bool().unwrap_or(false))),
        "number" => {
            let n = u.as_f64().unwrap_or(f64::NAN);
            // Int iff finite, integral, within ±2^53, and NOT -0.0 (the
            // only negative that must fall through to Float: `2` and
            // `2.0` collapse, but Int(0) and Float(-0.0) stay distinct
            // kinds — CAS/unique equality and group-key tags observe
            // the difference). Every other negative integer (-5, -9…)
            // is a plain Int, matching the other bindings.
            if n.is_finite()
                && n.fract() == 0.0
                && !(n == 0.0 && n.is_sign_negative())
                && n.abs() <= MAX_SAFE as f64
            {
                Ok(Value::Int(n as i64))
            } else {
                Ok(Value::Float(n))
            }
        }
        "bigint" => {
            let b = u
                .dyn_ref::<js_sys::BigInt>()
                .ok_or_else(|| argument("bigint conversion failed"))?;
            let s = js_sys::BigInt::to_string(b, 10)
                .map_err(|e| js_throw(&e))?
                .as_string()
                .unwrap_or_default();
            let n: i128 = s
                .parse()
                .map_err(|_| argument("bigint is outside the i64 range"))?;
            if n < i64::MIN as i128 || n > i64::MAX as i128 {
                return Err(argument("bigint is outside the i64 range"));
            }
            Ok(Value::Int(n as i64))
        }
        "string" => Ok(Value::Text(u.as_string().unwrap_or_default())),
        "object" => value_from_object(u, depth),
        other => Err(argument(&format!(
            "unsupported JS value kind '{other}' (function/symbol)"
        ))),
    }
}

fn value_from_object(u: &JsValue, depth: usize) -> CResult<Value> {
    // Typed arrays first, ordered so the exact-kind checks win: a
    // Float32Array is a Vector; a Uint8Array (Buffer included, it is
    // a subclass) is Bytes; any other typed array must be converted
    // by the caller (the browser-realistic input kinds are exactly
    // these two).
    if let Some(f32s) = u.dyn_ref::<js_sys::Float32Array>() {
        return Ok(Value::Vector(f32s.to_vec()));
    }
    if let Some(bytes) = u.dyn_ref::<js_sys::Uint8Array>() {
        return Ok(Value::Bytes(bytes.to_vec()));
    }
    if js_sys::Array::is_array(u) {
        let arr = u
            .dyn_ref::<js_sys::Array>()
            .ok_or_else(|| argument("array conversion failed"))?;
        let mut out = Vec::with_capacity(arr.length() as usize);
        for item in arr.iter() {
            out.push(value_from_js_at(&item, depth + 1)?);
        }
        return Ok(Value::Array(out));
    }
    // The native collection types have no enumerable own keys —
    // mapping them as plain objects would silently lose their
    // contents, so they are a clean InvalidArgument instead (convert
    // to a plain object first).
    for name in ["Map", "Set", "Date"] {
        if u.dyn_ref::<js_sys::Object>()
            .map(|o| {
                js_sys::Reflect::get(&o.constructor(), &JsValue::from_str("name"))
                    .ok()
                    .and_then(|n| n.as_string())
                    .is_some_and(|n| n == name)
            })
            .unwrap_or(false)
        {
            return Err(argument(&format!(
                "a JS {name} is not a corvid value — convert it to a plain object/array first"
            )));
        }
    }
    // Plain object → Map (own enumerable string-keyed properties).
    let obj = u
        .dyn_ref::<js_sys::Object>()
        .ok_or_else(|| argument("object conversion failed"))?;
    let keys = js_sys::Object::keys(obj);
    // The CorvidFloat marker (see index.js): an object whose single
    // own key is `__corvidFloat` maps to a typed engine Float — the
    // escape hatch for integer-valued doubles that must NOT collapse
    // to Int.
    if keys.length() == 1 {
        let key = keys.get(0);
        if key.as_string().as_deref() == Some("__corvidFloat") {
            if let Some(n) = js_sys::Reflect::get(u, &key)
                .map_err(|e| js_throw(&e))?
                .as_f64()
            {
                return Ok(Value::Float(n));
            }
        }
    }
    let mut map = BTreeMap::new();
    for i in 0..keys.length() {
        let key = keys.get(i);
        let val = js_sys::Reflect::get(u, &key).map_err(|e| js_throw(&e))?;
        map.insert(
            key.as_string().unwrap_or_default(),
            value_from_js_at(&val, depth + 1)?,
        );
    }
    Ok(Value::Map(map))
}

/// Convert an engine `Value` into a JS value (see the module docs for
/// the mapping and its fidelity notes).
pub fn value_to_js(v: &Value) -> CResult<JsValue> {
    value_to_js_at(v, 0)
}

fn value_to_js_at(v: &Value, depth: usize) -> CResult<JsValue> {
    if depth > MAX_DEPTH {
        return Err(too_deep());
    }
    match v {
        Value::Null => Ok(JsValue::NULL),
        Value::Bool(b) => Ok(JsValue::from_bool(*b)),
        Value::Int(i) => {
            if i.unsigned_abs() <= MAX_SAFE as u64 {
                Ok(JsValue::from_f64(*i as f64))
            } else {
                big_int(*i)
            }
        }
        Value::Float(f) => Ok(JsValue::from_f64(*f)),
        Value::Text(s) => Ok(JsValue::from_str(s)),
        Value::Bytes(b) => Ok(js_sys::Uint8Array::from(b.as_slice()).into()),
        Value::Vector(f32s) => Ok(js_sys::Float32Array::from(f32s.as_slice()).into()),
        Value::Array(items) => {
            let arr = js_sys::Array::new();
            for item in items {
                arr.push(&value_to_js_at(item, depth + 1)?);
            }
            Ok(arr.into())
        }
        Value::Map(map) => {
            // Property insertion follows the engine's BTreeMap order
            // (ascending key bytes), so Object.keys() of the mapped
            // document is the map_keys enumeration — modulo JS's
            // integer-like key hoisting, which lookups never observe.
            let obj = js_sys::Object::new();
            for (k, val) in map {
                js_sys::Reflect::set(
                    &obj,
                    &JsValue::from_str(k),
                    &value_to_js_at(val, depth + 1)?,
                )
                .map_err(|e| js_throw(&e))?;
            }
            Ok(obj.into())
        }
    }
}

/// An i64 beyond ±2^53 surfaces as a JS `BigInt` (decimal round trip).
fn big_int(i: i64) -> CResult<JsValue> {
    js_sys::BigInt::new(&JsValue::from_str(&i.to_string()))
        .map(|b| b.into())
        .map_err(|e| js_throw(&e))
}

/// A key: string (UTF-8 encoded) or Uint8Array/Buffer (raw bytes).
pub fn key_from_js(u: &JsValue) -> CResult<Vec<u8>> {
    if let Some(s) = u.as_string() {
        return Ok(s.into_bytes());
    }
    if let Some(bytes) = u.dyn_ref::<js_sys::Uint8Array>() {
        return Ok(bytes.to_vec());
    }
    Err(argument("keys must be strings or Uint8Arrays"))
}

/// Keys out: valid UTF-8 → string, anything else → Uint8Array.
pub fn key_to_js(k: &[u8]) -> CResult<JsValue> {
    match std::str::from_utf8(k) {
        Ok(s) => Ok(JsValue::from_str(s)),
        _ => Ok(js_sys::Uint8Array::from(k).into()),
    }
}

/// Set `obj.key = value` (object construction helper).
pub fn reflect_set<V: Into<JsValue>>(obj: &js_sys::Object, key: &str, value: V) -> CResult<()> {
    js_sys::Reflect::set(obj, &JsValue::from_str(key), &value.into())
        .map(|_| ())
        .map_err(|e| js_throw(&e))
}
