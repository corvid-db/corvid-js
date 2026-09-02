//! The `Query` wasm class — the engine-binding twin of the JS `Query`
//! fluent builder (index.js). Like the FFI's `QueryHandle`, it stores
//! the builder's parts (`Arc<Db>`, name, filters, sources, knobs) and
//! materializes the real engine `QueryBuilder` exactly once, at the
//! executing call — which CONSUMES the handle (mirroring the engine's
//! by-value `run(self)`). The JS wrapper supplies the fluent chaining;
//! ranking-parameter validation stays at execution, exactly as the
//! engine and the ABI do it.

use std::sync::{Arc, Mutex};

use corvid::filter::Predicate;
use corvid::Metric;
use wasm_bindgen::prelude::*;

use crate::collection::parse_metric;
use crate::db::{release, Counter};
use crate::error::{CResult, CorvidErr, ErrCode};
use crate::pred::parse_pred;
use crate::value::{key_to_js, reflect_set, value_from_js, value_to_js};

enum Source {
    Vector {
        field: String,
        query: Vec<f32>,
        k: usize,
        metric: Metric,
    },
    Text {
        field: String,
        query: String,
        k: usize,
    },
}

pub(crate) struct QueryInner {
    db: Arc<corvid::Db>,
    name: String,
    counter: Counter,
    filters: Vec<Predicate>,
    sources: Vec<Source>,
    rrf_k: f32,
    mmr_lambda: Option<f32>,
    limit: Option<usize>,
    offset: usize,
    order_by: Option<(String, bool)>,
    projection: Option<Vec<String>>,
    approx: bool,
}

impl QueryInner {
    /// Materialize the engine builder from the stored parts, applying
    /// them in the engine's own builder order. `fuse_rrf` is applied
    /// unconditionally with `rrf_k` (initialized to the engine's
    /// `DEFAULT_RRF_K`), which is identical to the engine's default
    /// fused state.
    fn build(&self) -> corvid::QueryBuilder<'_> {
        let coll = self.db.collection(&self.name);
        let mut b = coll.query();
        for f in &self.filters {
            b = b.filter(f.clone());
        }
        for s in &self.sources {
            match s {
                Source::Vector {
                    field,
                    query,
                    k,
                    metric,
                } => {
                    b = b.vector(field.clone(), query.clone(), *k, *metric);
                }
                Source::Text { field, query, k } => {
                    b = b.text(field.clone(), query.clone(), *k);
                }
            }
        }
        b = b.fuse_rrf(self.rrf_k);
        if let Some(l) = self.mmr_lambda {
            b = b.rerank_mmr(l);
        }
        if self.approx {
            b = b.approx();
        }
        if let Some((field, desc)) = &self.order_by {
            b = b.order_by(field.clone(), *desc);
        }
        if let Some(fields) = &self.projection {
            b = b.select(fields.iter().cloned());
        }
        if self.offset > 0 {
            b = b.offset(self.offset);
        }
        if let Some(n) = self.limit {
            b = b.limit(n);
        }
        b
    }
}

#[wasm_bindgen]
pub struct WasmQuery {
    inner: Mutex<Option<QueryInner>>,
}

impl WasmQuery {
    pub(crate) fn new(db: Arc<corvid::Db>, name: String, counter: Counter) -> Self {
        // A query is a derived handle: count it until the executing
        // terminal op (or close/drop) releases it — the §4.13 gate.
        crate::db::retain(&counter);
        Self {
            inner: Mutex::new(Some(QueryInner {
                db,
                name,
                counter,
                filters: Vec::new(),
                sources: Vec::new(),
                rrf_k: corvid::DEFAULT_RRF_K,
                mmr_lambda: None,
                limit: None,
                offset: 0,
                order_by: None,
                projection: None,
                approx: false,
            })),
        }
    }

    fn with<R>(&self, f: impl FnOnce(&mut QueryInner) -> CResult<R>) -> CResult<R> {
        let mut guard = self.inner.lock().unwrap();
        match guard.as_mut() {
            Some(inner) => f(inner),
            None => Err(CorvidErr::new(
                ErrCode::Argument,
                "query was already executed or closed",
            )),
        }
    }

    /// Take the inner state (consume) — terminal ops run through this,
    /// releasing the derived-handle counter exactly once.
    fn consume(&self) -> CResult<QueryInner> {
        let mut guard = self.inner.lock().unwrap();
        match guard.take() {
            Some(inner) => {
                release(&inner.counter);
                Ok(inner)
            }
            None => Err(CorvidErr::new(
                ErrCode::Argument,
                "query was already executed or closed",
            )),
        }
    }
}

impl Drop for WasmQuery {
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

#[wasm_bindgen]
impl WasmQuery {
    // -- setters (the JS layer chains these fluently) -----------------------

    pub fn filter(&self, pred: JsValue) -> Result<(), JsValue> {
        self.with(|inner| {
            inner.filters.push(parse_pred(&pred)?);
            Ok(())
        })
        .map_err(JsValue::from)
    }

    pub fn vector(
        &self,
        field: String,
        query: JsValue,
        k: u32,
        metric: String,
    ) -> Result<(), JsValue> {
        self.with(|inner| {
            let v = value_from_js(&query)?;
            let elems = match v {
                corvid::Value::Vector(f) => f,
                _ => return Err(CorvidErr::argument("query.vector wants a Float32Array")),
            };
            let m = parse_metric(&metric)?;
            inner.sources.push(Source::Vector {
                field,
                query: elems,
                k: k as usize,
                metric: m,
            });
            Ok(())
        })
        .map_err(JsValue::from)
    }

    pub fn text(&self, field: String, query: String, k: u32) -> Result<(), JsValue> {
        self.with(|inner| {
            inner.sources.push(Source::Text {
                field,
                query,
                k: k as usize,
            });
            Ok(())
        })
        .map_err(JsValue::from)
    }

    #[wasm_bindgen(js_name = "fuseRrf")]
    pub fn fuse_rrf(&self, k: f64) -> Result<(), JsValue> {
        self.with(|inner| {
            inner.rrf_k = k as f32;
            Ok(())
        })
        .map_err(JsValue::from)
    }

    #[wasm_bindgen(js_name = "rerankMmr")]
    pub fn rerank_mmr(&self, lambda: f64) -> Result<(), JsValue> {
        self.with(|inner| {
            inner.mmr_lambda = Some(lambda as f32);
            Ok(())
        })
        .map_err(JsValue::from)
    }

    pub fn approx(&self) -> Result<(), JsValue> {
        self.with(|inner| {
            inner.approx = true;
            Ok(())
        })
        .map_err(JsValue::from)
    }

    pub fn limit(&self, n: u32) -> Result<(), JsValue> {
        self.with(|inner| {
            inner.limit = Some(n as usize);
            Ok(())
        })
        .map_err(JsValue::from)
    }

    pub fn offset(&self, n: u32) -> Result<(), JsValue> {
        self.with(|inner| {
            inner.offset = n as usize;
            Ok(())
        })
        .map_err(JsValue::from)
    }

    #[wasm_bindgen(js_name = "orderBy")]
    pub fn order_by(&self, field: String, descending: bool) -> Result<(), JsValue> {
        self.with(|inner| {
            inner.order_by = Some((field, descending));
            Ok(())
        })
        .map_err(JsValue::from)
    }

    pub fn select(&self, fields: Vec<String>) -> Result<(), JsValue> {
        self.with(|inner| {
            inner.projection = Some(fields);
            Ok(())
        })
        .map_err(JsValue::from)
    }

    // -- terminal (consuming) ops --------------------------------------------

    /// Execute; rows as `{ key, doc, score }` objects (score 0 for
    /// pure filter/order queries). Consumes the builder.
    pub fn run(&self) -> Result<JsValue, JsValue> {
        let inner = self.consume().map_err(JsValue::from)?;
        let rows = inner
            .build()
            .run()
            .map_err(CorvidErr::from)
            .map_err(JsValue::from)?;
        let out = js_sys::Array::new();
        for row in rows {
            out.push(&row_obj(
                &key_to_js(&row.key)?,
                &value_to_js(&row.document)?,
                row.score,
            )?);
        }
        Ok(out.into())
    }

    pub fn count(&self) -> Result<u32, JsValue> {
        let inner = self.consume().map_err(JsValue::from)?;
        Ok(inner
            .build()
            .count()
            .map_err(CorvidErr::from)
            .map_err(JsValue::from)? as u32)
    }

    #[wasm_bindgen(js_name = "countDistinct")]
    pub fn count_distinct(&self, field: String) -> Result<u32, JsValue> {
        let inner = self.consume().map_err(JsValue::from)?;
        Ok(inner
            .build()
            .count_distinct(&field)
            .map_err(CorvidErr::from)
            .map_err(JsValue::from)? as u32)
    }

    pub fn sum(&self, field: String) -> Result<f64, JsValue> {
        let inner = self.consume().map_err(JsValue::from)?;
        inner
            .build()
            .sum(&field)
            .map_err(CorvidErr::from)
            .map_err(JsValue::from)
    }

    /// The filtered mean, or `null` when no document has the field.
    pub fn avg(&self, field: String) -> Result<JsValue, JsValue> {
        let inner = self.consume().map_err(JsValue::from)?;
        let avg = inner
            .build()
            .avg(&field)
            .map_err(CorvidErr::from)
            .map_err(JsValue::from)?;
        Ok(match avg {
            Some(v) => JsValue::from_f64(v),
            None => JsValue::NULL,
        })
    }

    pub fn min(&self, field: String) -> Result<JsValue, JsValue> {
        let inner = self.consume().map_err(JsValue::from)?;
        let v = inner
            .build()
            .min(&field)
            .map_err(CorvidErr::from)
            .map_err(JsValue::from)?;
        Ok(match v {
            Some(v) => value_to_js(&v).map_err(JsValue::from)?,
            None => JsValue::NULL,
        })
    }

    pub fn max(&self, field: String) -> Result<JsValue, JsValue> {
        let inner = self.consume().map_err(JsValue::from)?;
        let v = inner
            .build()
            .max(&field)
            .map_err(CorvidErr::from)
            .map_err(JsValue::from)?;
        Ok(match v {
            Some(v) => value_to_js(&v).map_err(JsValue::from)?,
            None => JsValue::NULL,
        })
    }

    /// Group counts as an array of `[key, count]` pairs (the engine's
    /// group-key formatting: text bare; int/float type-tagged `i:1` /
    /// `f:0.5`; ascending) — the JS layer folds it into an object.
    #[wasm_bindgen(js_name = "groupCount")]
    pub fn group_count(&self, field: String) -> Result<JsValue, JsValue> {
        let inner = self.consume().map_err(JsValue::from)?;
        let m = inner
            .build()
            .group_count(&field)
            .map_err(CorvidErr::from)
            .map_err(JsValue::from)?;
        let out = js_sys::Array::new();
        for (k, v) in m {
            let pair = js_sys::Array::new();
            pair.push(&JsValue::from_str(&k));
            pair.push(&JsValue::from_f64(v as f64));
            out.push(&pair.into());
        }
        Ok(out.into())
    }

    #[wasm_bindgen(js_name = "groupSum")]
    pub fn group_sum(&self, group_field: String, value_field: String) -> Result<JsValue, JsValue> {
        let inner = self.consume().map_err(JsValue::from)?;
        let m = inner
            .build()
            .group_sum(&group_field, &value_field)
            .map_err(CorvidErr::from)
            .map_err(JsValue::from)?;
        let out = js_sys::Array::new();
        for (k, v) in m {
            let pair = js_sys::Array::new();
            pair.push(&JsValue::from_str(&k));
            pair.push(&JsValue::from_f64(v));
            out.push(&pair.into());
        }
        Ok(out.into())
    }

    #[wasm_bindgen(js_name = "groupAvg")]
    pub fn group_avg(&self, group_field: String, value_field: String) -> Result<JsValue, JsValue> {
        let inner = self.consume().map_err(JsValue::from)?;
        let m = inner
            .build()
            .group_avg(&group_field, &value_field)
            .map_err(CorvidErr::from)
            .map_err(JsValue::from)?;
        let out = js_sys::Array::new();
        for (k, v) in m {
            let pair = js_sys::Array::new();
            pair.push(&JsValue::from_str(&k));
            pair.push(&JsValue::from_f64(v));
            out.push(&pair.into());
        }
        Ok(out.into())
    }

    /// Abandon the builder without executing (the free path).
    pub fn close(&self) {
        if let Some(inner) = self.inner.lock().unwrap().take() {
            release(&inner.counter);
        }
    }
}
