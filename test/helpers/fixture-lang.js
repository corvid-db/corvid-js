// test/helpers/fixture-lang.js — the golden-fixture language, shared
// verbatim by the Node golden suite (test/golden.spec.ts), the
// vitest-browser leg, and the Playwright E2E fixtures runner: one
// grammar for every host, by construction. Deliberately free of
// test-framework imports (failures are thrown Errors, which every
// runner surfaces) and of environment deps (CorvidFloat is init-free
// pure JS).

import { CorvidFloat } from '../../index.js';

// ---------------------------------------------------------------------------
// Tokenizing
// ---------------------------------------------------------------------------

/** Split `s` on top-level commas (depth-aware over []{}()). */
export function splitTop(s) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= s.length; i++) {
    const c = i < s.length ? s[i] : ',';
    if (c === '[' || c === '{' || c === '(') depth++;
    else if (c === ']' || c === '}' || c === ')') depth--;
    if (c === ',' && depth === 0) {
      let end = i;
      while (end > start && (s[end - 1] === ' ' || s[end - 1] === '\r')) end--;
      if (end > start) out.push(s.slice(start, end));
      start = i + 1;
    }
  }
  return out;
}

const f64 = new DataView(new ArrayBuffer(8));

/** f64 from raw bits (a BigInt). */
function f64FromBits(bits) {
  f64.setBigUint64(0, bits & 0xffffffffffffffffn, false);
  return f64.getFloat64(0, false);
}

function f64Bits(n) {
  f64.setFloat64(0, n, false);
  return f64.getBigUint64(0, false);
}

const f32 = new DataView(new ArrayBuffer(4));

/** f32 from raw bits (a uint32). */
function f32FromBits(bits) {
  f32.setUint32(0, bits >>> 0, false);
  return f32.getFloat32(0, false);
}

/** Parse one expected-double token: `~x` near; `=x`/`x`/bits:/inf exact. */
export function doubleMatches(got, tok) {
  if (tok.startsWith('~')) return doubleNear(got, parseDouble(tok.slice(1)));
  return numbersEqual(got, parseDouble(tok.replace(/^=/, '')));
}

function doubleNear(got, want) {
  return Math.abs(got - want) <= 1e-6 * (1 + Math.abs(want));
}

/**
 * NaN fidelity boundary: V8/wasm canonicalize NaN payloads when a
 * double crosses the JS Number boundary (plain JS HeapNumbers preserve
 * them; the wasm crossing does not — the same corner corvid-node
 * documents for N-API). The engine itself preserves f64 bits, but a
 * JS consumer can only observe NaN-as-NaN, so payload-bit expectations
 * compare as NaN-class equality here. `-0.0`, `inf` and `-inf` DO
 * survive bit-exactly, and Float32Array vector elements keep their
 * bits (typed-array memory is copied, never boxed).
 */
export function numbersEqual(got, want) {
  if (Number.isNaN(got) && Number.isNaN(want)) return true;
  return f64Bits(got) === f64Bits(want);
}

export function parseDouble(tok) {
  if (tok === 'inf') return Infinity;
  if (tok === '-inf') return -Infinity;
  if (tok === 'nan') return NaN;
  if (tok.startsWith('bits:')) return f64FromBits(BigInt(tok.slice(5)));
  return parseFloat(tok);
}

/** The `err:N` expected token → its code. */
export function errCode(expected) {
  if (!expected.startsWith('err:')) {
    throw new Error(`error expectation must be err:N, got '${expected}'`);
  }
  return parseInt(expected.slice(4), 10);
}

/** The `t(...)` literal body. */
export function textBody(tok) {
  if (!tok.startsWith('t(') || !tok.endsWith(')')) {
    throw new Error(`expected a t(...) literal, got '${tok}'`);
  }
  return tok.slice(2, -1);
}

/** The `k(...)` list body. */
export function listBody(tok) {
  if (!tok.startsWith('k(') || !tok.endsWith(')')) {
    throw new Error(`expected a k(...) list, got '${tok}'`);
  }
  return tok.slice(2, -1);
}

// ---------------------------------------------------------------------------
// Value literals: parse into JS values (the mapping's input form)
// ---------------------------------------------------------------------------

const MAX_SAFE = 0x1fffffffffffff; // 2^53 - 1

export function isDigits(s) {
  return /^[0-9]+$/.test(s);
}

/** Parse an int token: a JS number when safe, a BigInt for the extremes. */
function parseIntLiteral(tok) {
  const n = BigInt(tok);
  if (n >= -MAX_SAFE && n <= MAX_SAFE) return Number(n);
  return n;
}

/** Bytes literal body → Uint8Array at latin1 (the fixtures are byte-exact). */
export function bytesOf(body) {
  const out = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) out[i] = body.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Parse one literal into the JS value the binding's mapping accepts:
 * ints → number|bigint, floats → number (bits preserved), t() → string,
 * b() → Uint8Array, vec() → Float32Array, [..] → Array, {k=v} → object.
 */
export function parseLiteral(src, pos = { i: 0 }) {
  skipWs(src, pos);
  if (pos.i >= src.length) throw new Error('empty literal');
  const start = pos.i;
  const c = src[start];

  // numbers: -123 | 3.5 | inf | -inf | nan | bits:0x…
  const isWordNum =
    src.startsWith('inf', start) || src.startsWith('-inf', start) || src.startsWith('nan', start);
  if (c === '-' || (c >= '0' && c <= '9') || src.startsWith('bits:', start) || isWordNum) {
    let j = start;
    let isFloat = false;
    let isBits = false;
    if (src.startsWith('inf', j) || src.startsWith('-inf', j) || src.startsWith('nan', j)) {
      pos.i = j + (src.startsWith('-inf', j) ? 4 : 3);
      return new CorvidFloat(parseDouble(src.slice(start, pos.i)));
    }
    if (src.startsWith('bits:', j)) {
      isFloat = true;
      isBits = true;
      j += 5;
    }
    while (j < src.length) {
      const d = src[j];
      if ((d >= '0' && d <= '9') || d === '-' || d === '+') j++;
      else if (d === '.' || d === 'e' || d === 'E') {
        isFloat = true;
        j++;
      } else if (isBits && /[0-9a-fA-FxX]/.test(d)) j++;
      else break;
    }
    const tok = src.slice(start, j);
    pos.i = j;
    if (isBits) return new CorvidFloat(f64FromBits(BigInt(tok.slice(5))));
    if (isFloat) return new CorvidFloat(parseFloat(tok));
    return parseIntLiteral(tok);
  }

  if (src.startsWith('null', start) && delimsAfter(src, start, 4)) {
    pos.i = start + 4;
    return null;
  }
  if (src.startsWith('true', start) && delimsAfter(src, start, 4)) {
    pos.i = start + 4;
    return true;
  }
  if (src.startsWith('false', start) && delimsAfter(src, start, 5)) {
    pos.i = start + 5;
    return false;
  }

  // t(...) / b(...) / vec(...)
  const paren = (head, from) => {
    if (!src.startsWith(head, from)) return null;
    const open = from + head.length - 1;
    let depth = 0;
    for (let q = open; q < src.length; q++) {
      if (src[q] === '(') depth++;
      else if (src[q] === ')') {
        depth--;
        if (depth === 0) return src.slice(open + 1, q);
      }
    }
    throw new Error('unbalanced () in literal');
  };
  if ((c === 't' || c === 'b') && src[start + 1] === '(') {
    const body = paren(c === 't' ? 't(' : 'b(', start);
    pos.i = start + 2 + body.length + 1;
    return c === 't' ? body : bytesOf(body);
  }
  if (c === 'v' && src.startsWith('vec(', start)) {
    const body = paren('vec(', start);
    pos.i = start + 4 + body.length + 1;
    const elems = splitTop(body).map((tok) =>
      tok.startsWith('bits32:') ? f32FromBits(parseInt(tok.slice(7), 16)) : parseDouble(tok),
    );
    return Float32Array.from(elems);
  }

  if (c === '[') {
    const close = matchBracket(src, start, '[', ']');
    const body = src.slice(start + 1, close);
    const arr = [];
    const p = { i: 0 };
    while (p.i < body.length) {
      arr.push(parseLiteral(body, p));
      skipWs(body, p);
      if (p.i < body.length && body[p.i] === ',') p.i++;
    }
    pos.i = close + 1;
    return arr;
  }

  if (c === '{') {
    const close = matchBracket(src, start, '{', '}');
    const body = src.slice(start + 1, close);
    const obj = {};
    let j = 0;
    while (j < body.length) {
      let ke = j;
      while (ke < body.length && body[ke] !== '=') ke++;
      if (ke >= body.length) throw new Error('map literal needs k=v pairs');
      const key = body.slice(j, ke).trim();
      j = ke + 1;
      const p = { i: j };
      const value = parseLiteral(body, p);
      obj[key] = value;
      j = p.i;
      while (j < body.length && (body[j] === ' ' || body[j] === ',')) j++;
    }
    pos.i = close + 1;
    return obj;
  }

  throw new Error(`unparseable literal at '${src.slice(start, start + 24)}'`);
}

function delimsAfter(s, at, wordLen) {
  const after = s[at + wordLen];
  return after === undefined || after === ',' || after === ']' || after === '}' || after === ' ' || after === '\r';
}

function matchBracket(s, at, open, close) {
  let depth = 0;
  for (let q = at; q < s.length; q++) {
    if (s[q] === open) depth++;
    else if (s[q] === close) {
      depth--;
      if (depth === 0) return q;
    }
  }
  throw new Error(`unbalanced ${open}${close} in literal`);
}

function skipWs(s, pos) {
  while (pos.i < s.length && (s[pos.i] === ' ' || s[pos.i] === '\r')) pos.i++;
}

// ---------------------------------------------------------------------------
// Structural comparison (the mapped JS values)
// ---------------------------------------------------------------------------

export function isPlainObject(v) {
  return (
    typeof v === 'object' && v !== null && !Array.isArray(v) &&
    !(v instanceof Uint8Array) && !(v instanceof Float32Array)
  );
}

function isNumberLike(v) {
  return typeof v === 'number' || v instanceof CorvidFloat;
}

export function valuesEqual(got, want) {
  if (got === want) return true;
  if (isNumberLike(got) && isNumberLike(want)) return numbersEqual(Number(got), Number(want));
  if (typeof got === 'bigint' || typeof want === 'bigint') return false;
  if (typeof got !== typeof want && !(isNumberLike(got) && isNumberLike(want))) return false;
  if (typeof got === 'string') return got === want;
  if (Array.isArray(got) && Array.isArray(want)) {
    return got.length === want.length && got.every((g, i) => valuesEqual(g, want[i]));
  }
  if (got instanceof Uint8Array && want instanceof Uint8Array) {
    if (got.length !== want.length) return false;
    for (let i = 0; i < got.length; i++) if (got[i] !== want[i]) return false;
    return true;
  }
  if (got instanceof Float32Array && want instanceof Float32Array) {
    if (got.length !== want.length) return false;
    const g = new Uint32Array(got.buffer, got.byteOffset, got.length);
    const w = new Uint32Array(want.buffer, want.byteOffset, want.length);
    for (let i = 0; i < g.length; i++) if (g[i] !== w[i]) return false;
    return true;
  }
  if (isPlainObject(got) && isPlainObject(want)) {
    const gk = Object.keys(got);
    const wk = Object.keys(want);
    if (gk.length !== wk.length) return false;
    return wk.every((k) => k in got && valuesEqual(got[k], want[k]));
  }
  return false;
}

export function render(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'number') return `${v} (bits 0x${f64Bits(v).toString(16)})`;
  if (typeof v === 'bigint') return `${v}n`;
  if (v instanceof Float32Array) return `vec(${Array.from(v).join(',')})`;
  if (v instanceof Uint8Array) return `b(${Array.from(v).join(',')})`;
  if (Array.isArray(v)) return `[${v.map(render).join(',')}]`;
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
}

export function checkValue(got, wantTok, ctx) {
  const want = parseLiteral(wantTok);
  if (!valuesEqual(got, want)) {
    throw new Error(`${ctx}: value mismatch: got ${render(got)}, want ${render(want)}`);
  }
}

/** Walk a child path like a.b.0.c; undefined when absent. */
export function walkPath(root, path) {
  let cur = root;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = isDigits(seg) && Array.isArray(cur) ? cur[parseInt(seg, 10)] : cur[seg];
  }
  return cur;
}

/** The map_keys enumeration (the ABI's corvid_value_map_keys): keys of a mapped MAP, ascending engine byte order; anything else enumerates empty (inert, not an error). */
export function mapKeysOf(v) {
  return isPlainObject(v) ? Object.keys(v) : [];
}
