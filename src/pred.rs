//! Predicate descriptors: the JS layer's `field()`/`and`/`or`/`not`
//! builders produce plain descriptor objects; `parse_pred` converts
//! one into an engine `Predicate` at the single crossing point
//! (`query.filter` / `deleteWhere`).

use corvid::filter::{field, CmpOp, Predicate};
use wasm_bindgen::{JsCast, JsValue};

use crate::error::{CResult, CorvidErr, ErrCode};
use crate::value::{js_throw, value_from_js};

fn get_str(obj: &js_sys::Object, key: &str) -> CResult<String> {
    js_sys::Reflect::get(obj, &JsValue::from_str(key))
        .map_err(|e| js_throw(&e))?
        .as_string()
        .ok_or_else(|| CorvidErr::new(ErrCode::Argument, format!("predicate lacks '{key}'")))
}

fn get_f64(obj: &js_sys::Object, key: &str) -> CResult<f64> {
    let v = js_sys::Reflect::get(obj, &JsValue::from_str(key)).map_err(|e| js_throw(&e))?;
    v.as_f64()
        .ok_or_else(|| CorvidErr::new(ErrCode::Argument, format!("predicate lacks '{key}'")))
}

fn get_value(obj: &js_sys::Object, key: &str) -> CResult<JsValue> {
    js_sys::Reflect::get(obj, &JsValue::from_str(key))
        .map_err(|e| js_throw(&e))
        .and_then(|v| {
            if v.is_undefined() {
                Err(CorvidErr::new(
                    ErrCode::Argument,
                    format!("predicate lacks '{key}'"),
                ))
            } else {
                Ok(v)
            }
        })
}

fn parse_cmp(s: &str) -> CResult<CmpOp> {
    match s {
        "eq" => Ok(CmpOp::Eq),
        "ne" => Ok(CmpOp::Ne),
        "lt" => Ok(CmpOp::Lt),
        "le" => Ok(CmpOp::Le),
        "gt" => Ok(CmpOp::Gt),
        "ge" => Ok(CmpOp::Ge),
        _ => Err(CorvidErr::new(
            ErrCode::Argument,
            format!("unknown comparison '{s}'"),
        )),
    }
}

pub(crate) fn parse_pred(u: &JsValue) -> CResult<Predicate> {
    let obj = u
        .dyn_ref::<js_sys::Object>()
        .ok_or_else(|| CorvidErr::argument("predicate must be a descriptor object"))?;
    let op = get_str(obj, "op")?;
    match op.as_str() {
        "exists" => Ok(field(&get_str(obj, "path")?).exists()),
        "cmp" => {
            let path = get_str(obj, "path")?;
            let cmp = parse_cmp(&get_str(obj, "cmp")?)?;
            let value = value_from_js(&get_value(obj, "value")?)?;
            Ok(match cmp {
                CmpOp::Eq => field(&path).eq(value),
                CmpOp::Ne => field(&path).ne(value),
                CmpOp::Lt => field(&path).lt(value),
                CmpOp::Le => field(&path).le(value),
                CmpOp::Gt => field(&path).gt(value),
                CmpOp::Ge => field(&path).ge(value),
            })
        }
        "in" => {
            let path = get_str(obj, "path")?;
            let values = get_value(obj, "values")?;
            let arr = values
                .dyn_ref::<js_sys::Array>()
                .ok_or_else(|| CorvidErr::argument("predicate lacks 'values'"))?;
            let mut parsed = Vec::with_capacity(arr.length() as usize);
            for v in arr.iter() {
                parsed.push(value_from_js(&v)?);
            }
            Ok(field(&path).is_in(parsed))
        }
        "between" => {
            let path = get_str(obj, "path")?;
            let low = value_from_js(&get_value(obj, "low")?)?;
            let high = value_from_js(&get_value(obj, "high")?)?;
            Ok(field(&path).between(low, high))
        }
        "startsWith" => {
            let path = get_str(obj, "path")?;
            let prefix = get_str(obj, "prefix")?;
            Ok(field(&path).starts_with(prefix))
        }
        "contains" => {
            let path = get_str(obj, "path")?;
            let substring = get_str(obj, "substring")?;
            Ok(field(&path).contains(substring))
        }
        "geoWithin" => {
            let path = get_str(obj, "path")?;
            let lat = get_f64(obj, "lat")?;
            let lon = get_f64(obj, "lon")?;
            let radius_km = get_f64(obj, "radiusKm")?;
            Ok(field(&path).within_km(lat, lon, radius_km))
        }
        "and" | "or" => {
            let children = get_value(obj, "children")?;
            let arr = children
                .dyn_ref::<js_sys::Array>()
                .ok_or_else(|| CorvidErr::argument("predicate lacks 'children'"))?;
            let mut iter = arr.iter().map(|c| parse_pred(&c));
            let first = iter
                .next()
                .ok_or_else(|| CorvidErr::argument("and/or need at least one child"))??;
            let is_and = op == "and";
            iter.try_fold(first, |a, b| {
                b.map(|b| if is_and { a.and(b) } else { a.or(b) })
            })
        }
        "not" => {
            let child = parse_pred(&get_value(obj, "child")?)?;
            Ok(Predicate::Not(Box::new(child)))
        }
        other => Err(CorvidErr::argument(format!(
            "unknown predicate op '{other}'"
        ))),
    }
}
