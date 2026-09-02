//! The `Collection` wasm class — the engine-binding twin of the JS
//! `Collection` (index.js). Holds `Arc<Db>` + name (the ABI's derived
//! handle shape); each op materializes the engine `Collection` for the
//! call, mirroring the FFI's transient-borrow pattern.

use std::sync::{Arc, Mutex};

use corvid::schema::{Field, FieldType, Schema};
use corvid::{Metric, Quantization};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

use crate::db::{release, Counter};
use crate::error::{CResult, CorvidErr, ErrCode};
use crate::pred::parse_pred;
use crate::value::{
    js_error_message, key_from_js, key_to_js, reflect_set, value_from_js, value_to_js,
};

pub(crate) struct CollInner {
    pub db: Arc<corvid::Db>,
    pub name: String,
    pub counter: Counter,
}

#[wasm_bindgen]
pub struct WasmCollection {
    inner: Mutex<Option<CollInner>>,
}

pub(crate) fn parse_metric(s: &str) -> CResult<Metric> {
    match s {
        "cosine" => Ok(Metric::Cosine),
        "dot" => Ok(Metric::Dot),
        "l2" => Ok(Metric::L2),
        _ => Err(CorvidErr::new(
            ErrCode::Argument,
            format!("unknown metric '{s}'"),
        )),
    }
}

pub(crate) fn parse_quant(s: &str) -> CResult<Quantization> {
    match s {
        "none" => Ok(Quantization::None),
        "binary" => Ok(Quantization::Binary),
        "scalar" => Ok(Quantization::Scalar),
        _ => Err(CorvidErr::new(
            ErrCode::Argument,
            format!("unknown quantization '{s}'"),
        )),
    }
}

pub(crate) fn parse_field_type(s: &str) -> CResult<FieldType> {
    match s {
        "any" => Ok(FieldType::Any),
        "bool" => Ok(FieldType::Bool),
        "int" => Ok(FieldType::Int),
        "float" => Ok(FieldType::Float),
        "text" => Ok(FieldType::Text),
        "bytes" => Ok(FieldType::Bytes),
        "vector" => Ok(FieldType::Vector),
        "array" => Ok(FieldType::Array),
        "map" => Ok(FieldType::Map),
        _ => Err(CorvidErr::new(
            ErrCode::Argument,
            format!("unknown field type '{s}'"),
        )),
    }
}

pub(crate) fn field_type_name(t: FieldType) -> &'static str {
    match t {
        FieldType::Any => "any",
        FieldType::Bool => "bool",
        FieldType::Int => "int",
        FieldType::Float => "float",
        FieldType::Text => "text",
        FieldType::Bytes => "bytes",
        FieldType::Vector => "vector",
        FieldType::Array => "array",
        FieldType::Map => "map",
    }
}

fn closed() -> CorvidErr {
    CorvidErr::new(ErrCode::Argument, "collection handle is closed")
}

/// CorvidErr → engine error (for closures that must return
/// `corvid::Result`): the message rides in an InvalidArgument.
fn engine_err(e: CorvidErr) -> corvid::Error {
    corvid::Error::InvalidArgument(e.message)
}

impl WasmCollection {
    pub(crate) fn new(db: Arc<corvid::Db>, name: String, counter: Counter) -> Self {
        Self {
            inner: Mutex::new(Some(CollInner { db, name, counter })),
        }
    }

    fn with_coll<T>(&self, f: impl FnOnce(corvid::Collection<'_>) -> CResult<T>) -> CResult<T> {
        let guard = self.inner.lock().unwrap();
        let inner = guard.as_ref().ok_or_else(closed)?;
        let coll = inner.db.collection(&inner.name);
        f(coll)
    }
}

impl Drop for WasmCollection {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.lock().unwrap().take() {
            release(&inner.counter);
        }
    }
}

// A `{ key, doc, score }` row object.
fn row_obj(key: &JsValue, doc: &JsValue, score: f32) -> CResult<JsValue> {
    let obj = js_sys::Object::new();
    reflect_set(&obj, "key", key)?;
    reflect_set(&obj, "doc", doc)?;
    reflect_set(&obj, "score", JsValue::from_f64(score as f64))?;
    Ok(obj.into())
}

// A `{ key, doc }` pair object.
fn pair_obj(key: &JsValue, doc: &JsValue) -> CResult<JsValue> {
    let obj = js_sys::Object::new();
    reflect_set(&obj, "key", key)?;
    reflect_set(&obj, "doc", doc)?;
    Ok(obj.into())
}

fn opt_value(u: &JsValue) -> CResult<Option<corvid::Value>> {
    if u.is_null() || u.is_undefined() {
        return Ok(None);
    }
    Ok(Some(value_from_js(u)?))
}

fn opt_key(u: &JsValue) -> CResult<Option<Vec<u8>>> {
    if u.is_null() || u.is_undefined() {
        return Ok(None);
    }
    Ok(Some(key_from_js(u)?))
}

#[wasm_bindgen]
impl WasmCollection {
    #[wasm_bindgen(getter)]
    pub fn name(&self) -> Result<String, JsValue> {
        let guard = self.inner.lock().unwrap();
        Ok(guard.as_ref().ok_or_else(closed)?.name.clone())
    }

    // -- mutations ----------------------------------------------------------

    pub fn insert(&self, key: JsValue, doc: JsValue) -> Result<(), JsValue> {
        self.with_coll(|coll| {
            let k = key_from_js(&key)?;
            let v = value_from_js(&doc)?;
            coll.insert(&k, &v).map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)
    }

    /// Bulk atomic insert (`put_many`): one transaction; a violating
    /// pair rolls the whole batch back. `entries` is an array of
    /// `[key, doc]` pairs.
    #[wasm_bindgen(js_name = "insertMany")]
    pub fn insert_many(&self, entries: JsValue) -> Result<(), JsValue> {
        self.with_coll(|coll| {
            let arr = entries
                .dyn_ref::<js_sys::Array>()
                .ok_or_else(|| CorvidErr::argument("insertMany wants [[key, doc], ...]"))?;
            let mut items: Vec<(Vec<u8>, corvid::Value)> =
                Vec::with_capacity(arr.length() as usize);
            for pair in arr.iter() {
                let pair = pair
                    .dyn_ref::<js_sys::Array>()
                    .ok_or_else(|| CorvidErr::argument("insertMany wants [[key, doc], ...]"))?;
                if pair.length() != 2 {
                    return Err(CorvidErr::argument(
                        "insertMany wants [key, doc] pairs of length 2",
                    ));
                }
                items.push((key_from_js(&pair.get(0))?, value_from_js(&pair.get(1))?));
            }
            let refs: Vec<(&[u8], &corvid::Value)> =
                items.iter().map(|(k, v)| (k.as_slice(), v)).collect();
            coll.insert_batch(&refs).map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)
    }

    #[wasm_bindgen(js_name = "insertAuto")]
    pub fn insert_auto(&self, doc: JsValue) -> Result<JsValue, JsValue> {
        let key = self
            .with_coll(|coll| {
                let v = value_from_js(&doc)?;
                coll.insert_auto(&v).map_err(CorvidErr::from)
            })
            .map_err(JsValue::from)?;
        key_to_js(&key).map_err(JsValue::from)
    }

    /// Read-modify-write: the callback receives the current document
    /// (or `null` when absent) and returns the new document — `null`
    /// to delete. A throwing callback aborts with code 12 and writes
    /// nothing. (The engine's own update is the same get-then-write
    /// composition; see its docs for the linearizability caveat.)
    pub fn update(&self, key: JsValue, f: js_sys::Function) -> Result<(), JsValue> {
        self.with_coll(|coll| {
            let k = key_from_js(&key)?;
            let current = coll.get(&k).map_err(CorvidErr::from)?;
            let arg = match &current {
                Some(v) => value_to_js(v)?,
                None => JsValue::NULL,
            };
            let ret = f.call1(&JsValue::NULL, &arg).map_err(|e| {
                CorvidErr::argument(format!("update callback failed: {}", js_error_message(&e)))
            })?;
            if ret.is_null() || ret.is_undefined() {
                coll.delete(&k).map_err(CorvidErr::from)?;
                Ok(())
            } else {
                let doc = value_from_js(&ret)?;
                coll.insert(&k, &doc).map_err(CorvidErr::from)
            }
        })
        .map_err(JsValue::from)
    }

    pub fn patch(&self, key: JsValue, patch: JsValue) -> Result<(), JsValue> {
        self.with_coll(|coll| {
            let k = key_from_js(&key)?;
            let p = value_from_js(&patch)?;
            coll.patch(&k, &p).map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)
    }

    /// Atomically write `replacement` only if the current value equals
    /// `expected` (`null` = must be absent; `replacement: null`
    /// deletes on match). Returns whether the write was applied.
    #[wasm_bindgen(js_name = "compareAndSet")]
    pub fn compare_and_set(
        &self,
        key: JsValue,
        expected: JsValue,
        replacement: JsValue,
    ) -> Result<bool, JsValue> {
        self.with_coll(|coll| {
            let k = key_from_js(&key)?;
            let ex = opt_value(&expected)?;
            let re = opt_value(&replacement)?;
            coll.compare_and_set(&k, ex.as_ref(), re)
                .map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)
    }

    pub fn delete(&self, key: JsValue) -> Result<bool, JsValue> {
        self.with_coll(|coll| coll.delete(&key_from_js(&key)?).map_err(CorvidErr::from))
            .map_err(JsValue::from)
    }

    /// Delete every document matching the predicate (built with
    /// `field()`/`and`/`or`/`not`); returns the removed count.
    #[wasm_bindgen(js_name = "deleteWhere")]
    pub fn delete_where(&self, pred: JsValue) -> Result<u32, JsValue> {
        self.with_coll(|coll| {
            let p = parse_pred(&pred)?;
            coll.delete_where(p)
                .map(|n| n as u32)
                .map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)
    }

    #[wasm_bindgen(js_name = "deleteBatch")]
    pub fn delete_batch(&self, keys: JsValue) -> Result<u32, JsValue> {
        self.with_coll(|coll| {
            let arr = keys
                .dyn_ref::<js_sys::Array>()
                .ok_or_else(|| CorvidErr::argument("deleteBatch wants an array of keys"))?;
            let mut ks: Vec<Vec<u8>> = Vec::with_capacity(arr.length() as usize);
            for k in arr.iter() {
                ks.push(key_from_js(&k)?);
            }
            let refs: Vec<&[u8]> = ks.iter().map(|k| k.as_slice()).collect();
            coll.delete_batch(&refs)
                .map(|n| n as u32)
                .map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)
    }

    // -- TTL ----------------------------------------------------------------

    #[wasm_bindgen(js_name = "insertWithTtl")]
    pub fn insert_with_ttl(
        &self,
        key: JsValue,
        doc: JsValue,
        expires_at: f64,
    ) -> Result<(), JsValue> {
        let expires = expires_at as i64;
        self.with_coll(|coll| {
            let k = key_from_js(&key)?;
            let v = value_from_js(&doc)?;
            coll.insert_with_ttl(&k, &v, expires)
                .map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)
    }

    #[wasm_bindgen(js_name = "setTtl")]
    pub fn set_ttl(&self, key: JsValue, expires_at: f64) -> Result<(), JsValue> {
        let expires = expires_at as i64;
        self.with_coll(|coll| {
            coll.set_ttl(&key_from_js(&key)?, expires)
                .map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)
    }

    /// The key's expiry instant, or `null` when it has no TTL.
    pub fn ttl(&self, key: JsValue) -> Result<JsValue, JsValue> {
        let ttl = self
            .with_coll(|coll| coll.ttl(&key_from_js(&key)?).map_err(CorvidErr::from))
            .map_err(JsValue::from)?;
        Ok(match ttl {
            None => JsValue::NULL,
            Some(t) => JsValue::from_f64(t as f64),
        })
    }

    #[wasm_bindgen(js_name = "purgeExpired")]
    pub fn purge_expired(&self, now: f64) -> Result<u32, JsValue> {
        self.with_coll(|coll| {
            coll.purge_expired(now as i64)
                .map(|n| n as u32)
                .map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)
    }

    // -- reads ----------------------------------------------------------------

    pub fn get(&self, key: JsValue) -> Result<JsValue, JsValue> {
        let doc = self
            .with_coll(|coll| coll.get(&key_from_js(&key)?).map_err(CorvidErr::from))
            .map_err(JsValue::from)?;
        Ok(match doc {
            Some(v) => value_to_js(&v).map_err(JsValue::from)?,
            None => JsValue::NULL,
        })
    }

    /// Every row in key order, as `[{ key, doc }]`.
    #[wasm_bindgen(js_name = "scanRows")]
    pub fn scan_rows(&self) -> Result<JsValue, JsValue> {
        let rows = self
            .with_coll(|coll| coll.scan().map_err(CorvidErr::from))
            .map_err(JsValue::from)?;
        let out = js_sys::Array::new();
        for (k, v) in rows {
            out.push(&pair_obj(&key_to_js(&k)?, &value_to_js(&v)?)?);
        }
        Ok(out.into())
    }

    /// Stream with a callback `(key, doc) => boolean` — returning
    /// `false` stops the walk early (not an error). Returns the number
    /// of rows visited.
    #[wasm_bindgen(js_name = "scanCb")]
    pub fn scan_cb(&self, cb: js_sys::Function) -> Result<u32, JsValue> {
        let mut visited: u32 = 0;
        self.with_coll(|coll| {
            coll.for_each_doc(|key, doc| {
                visited += 1;
                let kj = key_to_js(key).map_err(engine_err)?;
                let dj = value_to_js(&doc).map_err(engine_err)?;
                let ret = cb.call2(&JsValue::NULL, &kj, &dj).map_err(|e| {
                    corvid::Error::InvalidArgument(format!(
                        "scan callback failed: {}",
                        js_error_message(&e)
                    ))
                })?;
                let cont = ret.as_bool().unwrap_or(true);
                Ok(cont)
            })
            .map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)?;
        Ok(visited)
    }

    /// Keyset pagination: up to `limit` rows strictly after `after`
    /// (`null` starts at the beginning). Returns
    /// `{ rows: [{key, doc}], next }` — `next` is the resume cursor
    /// or `null` at the end.
    pub fn page(&self, after: JsValue, limit: u32) -> Result<JsValue, JsValue> {
        let page = self
            .with_coll(|coll| {
                let after_key = opt_key(&after)?;
                coll.page(after_key.as_deref(), limit as usize)
                    .map_err(CorvidErr::from)
            })
            .map_err(JsValue::from)?;
        let rows = js_sys::Array::new();
        for (k, v) in page.rows {
            rows.push(&pair_obj(&key_to_js(&k)?, &value_to_js(&v)?)?);
        }
        let next = match page.next {
            Some(k) => key_to_js(&k)?,
            None => JsValue::NULL,
        };
        let obj = js_sys::Object::new();
        reflect_set(&obj, "rows", rows).map_err(JsValue::from)?;
        reflect_set(&obj, "next", next).map_err(JsValue::from)?;
        Ok(obj.into())
    }

    pub fn len(&self) -> Result<u32, JsValue> {
        self.with_coll(|coll| coll.len().map(|n| n as u32).map_err(CorvidErr::from))
            .map_err(JsValue::from)
    }

    #[wasm_bindgen(js_name = "isEmpty")]
    pub fn is_empty(&self) -> Result<bool, JsValue> {
        self.with_coll(|coll| coll.is_empty().map_err(CorvidErr::from))
            .map_err(JsValue::from)
    }

    // -- direct search fns (v0.3.0 additive ABI) ------------------------------

    /// Phrase search (the v0.3.0 additive ABI's `corvid_phrase_search`):
    /// up to `k` documents whose `field` contains `phrase` as a
    /// consecutive, in-order run of analyzed tokens, most relevant
    /// first; rows as `[{ key, doc, score }]` with the BM25 phrase-sum
    /// score (the direct fn's scale, not the query builder's RRF).
    #[wasm_bindgen(js_name = "phraseSearch")]
    pub fn phrase_search(&self, field: String, phrase: String, k: u32) -> Result<JsValue, JsValue> {
        let hits = self
            .with_coll(|coll| {
                coll.phrase_search(&field, &phrase, k as usize)
                    .map_err(CorvidErr::from)
            })
            .map_err(JsValue::from)?;
        let out = js_sys::Array::new();
        for hit in hits {
            out.push(&row_obj(
                &key_to_js(&hit.key)?,
                &value_to_js(&hit.document)?,
                hit.score,
            )?);
        }
        Ok(out.into())
    }

    // -- indexes & schema -----------------------------------------------------

    #[wasm_bindgen(js_name = "createScalarIndex")]
    pub fn create_scalar_index(&self, field: String) -> Result<(), JsValue> {
        self.with_coll(|coll| coll.create_scalar_index(&field).map_err(CorvidErr::from))
            .map_err(JsValue::from)
    }

    #[wasm_bindgen(js_name = "createCompoundIndex")]
    pub fn create_compound_index(&self, fields: JsValue) -> Result<(), JsValue> {
        self.with_coll(|coll| {
            let arr = fields
                .dyn_ref::<js_sys::Array>()
                .ok_or_else(|| CorvidErr::argument("createCompoundIndex wants [field, ...]"))?;
            let names: Vec<String> = arr
                .iter()
                .map(|v| {
                    v.as_string().ok_or_else(|| {
                        CorvidErr::argument("createCompoundIndex wants field name strings")
                    })
                })
                .collect::<CResult<_>>()?;
            let refs: Vec<&str> = names.iter().map(|s| s.as_str()).collect();
            coll.create_compound_index(&refs).map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)
    }

    #[wasm_bindgen(js_name = "createTextIndex")]
    pub fn create_text_index(&self, field: String) -> Result<(), JsValue> {
        self.with_coll(|coll| coll.create_text_index(&field).map_err(CorvidErr::from))
            .map_err(JsValue::from)
    }

    #[wasm_bindgen(js_name = "createTextIndexOndisk")]
    pub fn create_text_index_ondisk(&self, field: String) -> Result<(), JsValue> {
        self.with_coll(|coll| {
            coll.create_text_index_ondisk(&field)
                .map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)
    }

    #[wasm_bindgen(js_name = "createGeoIndex")]
    pub fn create_geo_index(&self, field: String) -> Result<(), JsValue> {
        self.with_coll(|coll| coll.create_geo_index(&field).map_err(CorvidErr::from))
            .map_err(JsValue::from)
    }

    #[wasm_bindgen(js_name = "createVectorIndex")]
    pub fn create_vector_index(&self, field: String, metric: String) -> Result<(), JsValue> {
        self.with_coll(|coll| {
            coll.create_vector_index(&field, parse_metric(&metric)?)
                .map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)
    }

    #[wasm_bindgen(js_name = "createVectorIndexQuantized")]
    pub fn create_vector_index_quantized(
        &self,
        field: String,
        metric: String,
        quant: String,
    ) -> Result<(), JsValue> {
        self.with_coll(|coll| {
            coll.create_vector_index_quantized(&field, parse_metric(&metric)?, parse_quant(&quant)?)
                .map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)
    }

    #[wasm_bindgen(js_name = "createVectorIndexOndisk")]
    pub fn create_vector_index_ondisk(&self, field: String, metric: String) -> Result<(), JsValue> {
        self.with_coll(|coll| {
            coll.create_vector_index_ondisk(&field, parse_metric(&metric)?)
                .map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)
    }

    #[wasm_bindgen(js_name = "createVectorIndexOndiskQuantized")]
    pub fn create_vector_index_ondisk_quantized(
        &self,
        field: String,
        metric: String,
        quant: String,
    ) -> Result<(), JsValue> {
        self.with_coll(|coll| {
            coll.create_vector_index_ondisk_quantized(
                &field,
                parse_metric(&metric)?,
                parse_quant(&quant)?,
            )
            .map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)
    }

    #[wasm_bindgen(js_name = "createVectorIndexPq")]
    pub fn create_vector_index_pq(
        &self,
        field: String,
        metric: String,
        m: u32,
        k: u32,
    ) -> Result<(), JsValue> {
        self.with_coll(|coll| {
            coll.create_vector_index_pq(&field, parse_metric(&metric)?, m as usize, k as usize)
                .map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)
    }

    #[wasm_bindgen(js_name = "createVectorIndexOndiskPq")]
    pub fn create_vector_index_ondisk_pq(
        &self,
        field: String,
        metric: String,
        m: u32,
        k: u32,
    ) -> Result<(), JsValue> {
        self.with_coll(|coll| {
            coll.create_vector_index_ondisk_pq(
                &field,
                parse_metric(&metric)?,
                m as usize,
                k as usize,
            )
            .map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)
    }

    /// Declare the collection's schema (replaces any previous one):
    /// `[{ name, type, required, unique }]` with `type` one of
    /// `any|bool|int|float|text|bytes|vector|array|map`.
    #[wasm_bindgen(js_name = "setSchema")]
    pub fn set_schema(&self, fields: JsValue) -> Result<(), JsValue> {
        self.with_coll(|coll| {
            let arr = fields.dyn_ref::<js_sys::Array>().ok_or_else(|| {
                CorvidErr::argument("setSchema wants [{ name, type, required, unique }]")
            })?;
            let mut schema = Schema::new();
            for item in arr.iter() {
                let obj = item
                    .dyn_ref::<js_sys::Object>()
                    .ok_or_else(|| CorvidErr::argument("set_schema fields must be objects"))?;
                let name = js_sys::Reflect::get(obj, &JsValue::from_str("name"))
                    .map_err(|e| crate::value::js_throw(&e))?
                    .as_string()
                    .ok_or_else(|| CorvidErr::argument("schema field lacks 'name'"))?;
                let ty = js_sys::Reflect::get(obj, &JsValue::from_str("type"))
                    .map_err(|e| crate::value::js_throw(&e))?
                    .as_string()
                    .ok_or_else(|| CorvidErr::argument("schema field lacks 'type'"))?;
                let mut f = Field::new(name, parse_field_type(&ty)?);
                if js_sys::Reflect::get(obj, &JsValue::from_str("required"))
                    .map_err(|e| crate::value::js_throw(&e))?
                    .as_bool()
                    .unwrap_or(false)
                {
                    f = f.required();
                }
                if js_sys::Reflect::get(obj, &JsValue::from_str("unique"))
                    .map_err(|e| crate::value::js_throw(&e))?
                    .as_bool()
                    .unwrap_or(false)
                {
                    f = f.unique();
                }
                schema = schema.field(f);
            }
            coll.set_schema(&schema).map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)
    }

    /// The declared schema (`[{ name, type, required, unique }]`), or
    /// `null` when none.
    pub fn schema(&self) -> Result<JsValue, JsValue> {
        let schema = self
            .with_coll(|coll| {
                Ok(coll.schema().map(|s| {
                    s.fields()
                        .iter()
                        .map(|f| (f.name.clone(), f.ty, f.required, f.unique))
                        .collect::<Vec<_>>()
                }))
            })
            .map_err(JsValue::from)?;
        let Some(fields) = schema else {
            return Ok(JsValue::NULL);
        };
        let out = js_sys::Array::new();
        for (name, ty, required, unique) in fields {
            let obj = js_sys::Object::new();
            reflect_set(&obj, "name", JsValue::from_str(&name)).map_err(JsValue::from)?;
            reflect_set(&obj, "type", JsValue::from_str(field_type_name(ty)))
                .map_err(JsValue::from)?;
            reflect_set(&obj, "required", JsValue::from_bool(required)).map_err(JsValue::from)?;
            reflect_set(&obj, "unique", JsValue::from_bool(unique)).map_err(JsValue::from)?;
            out.push(&obj.into());
        }
        Ok(out.into())
    }

    // -- graph ----------------------------------------------------------------

    pub fn link(&self, from: JsValue, relation: String, to: JsValue) -> Result<(), JsValue> {
        self.with_coll(|coll| {
            coll.link(&key_from_js(&from)?, &relation, &key_from_js(&to)?)
                .map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)
    }

    #[wasm_bindgen(js_name = "linkWeighted")]
    pub fn link_weighted(
        &self,
        from: JsValue,
        relation: String,
        to: JsValue,
        weight: f64,
    ) -> Result<(), JsValue> {
        self.with_coll(|coll| {
            coll.link_weighted(&key_from_js(&from)?, &relation, &key_from_js(&to)?, weight)
                .map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)
    }

    pub fn unlink(&self, from: JsValue, relation: String, to: JsValue) -> Result<bool, JsValue> {
        self.with_coll(|coll| {
            coll.unlink(&key_from_js(&from)?, &relation, &key_from_js(&to)?)
                .map_err(CorvidErr::from)
        })
        .map_err(JsValue::from)
    }

    pub fn neighbors(&self, from: JsValue, relation: String) -> Result<JsValue, JsValue> {
        let keys = self
            .with_coll(|coll| {
                coll.neighbors(&key_from_js(&from)?, &relation)
                    .map_err(CorvidErr::from)
            })
            .map_err(JsValue::from)?;
        let out = js_sys::Array::new();
        for k in keys {
            out.push(&key_to_js(&k)?);
        }
        Ok(out.into())
    }

    #[wasm_bindgen(js_name = "inNeighbors")]
    pub fn in_neighbors(&self, to: JsValue, relation: String) -> Result<JsValue, JsValue> {
        let keys = self
            .with_coll(|coll| {
                coll.in_neighbors(&key_from_js(&to)?, &relation)
                    .map_err(CorvidErr::from)
            })
            .map_err(JsValue::from)?;
        let out = js_sys::Array::new();
        for k in keys {
            out.push(&key_to_js(&k)?);
        }
        Ok(out.into())
    }

    /// Weighted out-edges as `[{ key, weight }]`.
    #[wasm_bindgen(js_name = "neighborsWeighted")]
    pub fn neighbors_weighted(&self, from: JsValue, relation: String) -> Result<JsValue, JsValue> {
        let pairs = self
            .with_coll(|coll| {
                coll.neighbors_weighted(&key_from_js(&from)?, &relation)
                    .map_err(CorvidErr::from)
            })
            .map_err(JsValue::from)?;
        let out = js_sys::Array::new();
        for (k, w) in pairs {
            let obj = js_sys::Object::new();
            reflect_set(&obj, "key", &key_to_js(&k)?)?;
            reflect_set(&obj, "weight", JsValue::from_f64(w))?;
            out.push(&obj.into());
        }
        Ok(out.into())
    }

    pub fn traverse(
        &self,
        start: JsValue,
        relation: String,
        hops: u32,
    ) -> Result<JsValue, JsValue> {
        let keys = self
            .with_coll(|coll| {
                coll.traverse(&key_from_js(&start)?, &relation, hops as usize)
                    .map_err(CorvidErr::from)
            })
            .map_err(JsValue::from)?;
        let out = js_sys::Array::new();
        for k in keys {
            out.push(&key_to_js(&k)?);
        }
        Ok(out.into())
    }

    // -- geo ------------------------------------------------------------------

    /// Radius search, nearest first (ties by key):
    /// `[{ key, doc, distanceKm }]`.
    #[wasm_bindgen(js_name = "geoWithinRadius")]
    pub fn geo_within_radius(
        &self,
        field: String,
        lat: f64,
        lon: f64,
        radius_km: f64,
    ) -> Result<JsValue, JsValue> {
        let hits = self
            .with_coll(|coll| {
                coll.geo_within_radius(&field, lat, lon, radius_km)
                    .map_err(CorvidErr::from)
            })
            .map_err(JsValue::from)?;
        geo_hits(hits)
    }

    /// Bounding-box search (key order; no center, so distances are the
    /// engine's 0.0 sentinel).
    #[wasm_bindgen(js_name = "geoWithinBbox")]
    pub fn geo_within_bbox(
        &self,
        field: String,
        min_lat: f64,
        min_lon: f64,
        max_lat: f64,
        max_lon: f64,
    ) -> Result<JsValue, JsValue> {
        // bbox has no center: the engine returns plain rows and the
        // ABI reports the 0.0 distance sentinel — same here.
        let rows = self
            .with_coll(|coll| {
                coll.geo_within_bbox(&field, min_lat, min_lon, max_lat, max_lon)
                    .map_err(CorvidErr::from)
            })
            .map_err(JsValue::from)?;
        let out = js_sys::Array::new();
        for (k, doc) in rows {
            let obj = js_sys::Object::new();
            reflect_set(&obj, "key", &key_to_js(&k)?)?;
            reflect_set(&obj, "doc", &value_to_js(&doc)?)?;
            reflect_set(&obj, "distanceKm", JsValue::from_f64(0.0))?;
            out.push(&obj.into());
        }
        Ok(out.into())
    }

    /// The `k` nearest points: `[{ key, doc, distanceKm }]`.
    #[wasm_bindgen(js_name = "geoNearest")]
    pub fn geo_nearest(
        &self,
        field: String,
        lat: f64,
        lon: f64,
        k: u32,
    ) -> Result<JsValue, JsValue> {
        let hits = self
            .with_coll(|coll| {
                coll.geo_nearest(&field, lat, lon, k as usize)
                    .map_err(CorvidErr::from)
            })
            .map_err(JsValue::from)?;
        geo_hits(hits)
    }

    // -- queries ----------------------------------------------------------------

    /// Begin a query over this collection (a derived handle; close it
    /// or execute it).
    pub fn query(&self) -> Result<crate::WasmQuery, JsValue> {
        let guard = self.inner.lock().unwrap();
        let inner = guard.as_ref().ok_or_else(closed).map_err(JsValue::from)?;
        Ok(crate::WasmQuery::new(
            Arc::clone(&inner.db),
            inner.name.clone(),
            Arc::clone(&inner.counter),
        ))
    }

    /// Release the handle (idempotent); also runs on GC.
    pub fn close(&self) {
        if let Some(inner) = self.inner.lock().unwrap().take() {
            release(&inner.counter);
        }
    }
}

fn geo_hits(hits: Vec<corvid::GeoHit>) -> Result<JsValue, JsValue> {
    let out = js_sys::Array::new();
    for hit in hits {
        let obj = js_sys::Object::new();
        reflect_set(&obj, "key", &key_to_js(&hit.key)?)?;
        reflect_set(&obj, "doc", &value_to_js(&hit.document)?)?;
        reflect_set(&obj, "distanceKm", JsValue::from_f64(hit.distance_km))?;
        out.push(&obj.into());
    }
    Ok(out.into())
}
