// node.mjs — the Node entry for corvid-js.
//
// wasm-bindgen's web-target glue instantiates asynchronously in
// browsers (fetch) but exposes `initSync(bytes)` for hosts that have
// the module on disk. This entry initializes the wasm module
// synchronously from the built artifact at import time, then re-exports
// the SYNC surface — so under Node (`node:fs` present) the package is
// zero-config synchronous, exactly like the other corvid bindings:
//
//     import { Db, field } from 'corvid-js/node';   // or '../node.mjs'
//     const db = new Db();
//
// The async OPFS surface is deliberately NOT re-exported (SPEC §4.1):
// Node has no OPFS and no Web Workers, so importing it under the node
// condition yields no binding at all — the cleanest possible "not
// supported here" (browsers get it from 'corvid-js'). Everything after
// initialization is identical — the same wasm binary, the same classes,
// the same calls.

import { readFileSync } from 'node:fs';

import { initSync } from './pkg/corvid_js.js';

initSync({ module: readFileSync(new URL('./pkg/corvid_js_bg.wasm', import.meta.url)) });

export {
  initSync,
  init,
  ErrorCode,
  CorvidError,
  CorvidFloat,
  field,
  and,
  or,
  not,
  Db,
  Collection,
  Query,
  ffiVersion,
} from './index.js';
