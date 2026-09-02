// node.mjs — the Node entry for corvid-js.
//
// wasm-bindgen's web-target glue instantiates asynchronously in
// browsers (fetch) but exposes `initSync(bytes)` for hosts that have
// the module on disk. This entry initializes the wasm module
// synchronously from the built artifact at import time, then re-exports
// the whole public surface — so under Node (`node:fs` present) the
// package is zero-config synchronous, exactly like the other corvid
// bindings:
//
//     import { Db, field } from 'corvid-js/node';   // or '../node.mjs'
//     const db = new Db();
//
// Browsers never touch this file: they import 'corvid-js' (index.js)
// and `await init()` first. Everything after initialization is
// identical — the same wasm binary, the same classes, the same calls.

import { readFileSync } from 'node:fs';

import { initSync } from './pkg/corvid_js.js';

initSync({ module: readFileSync(new URL('./pkg/corvid_js_bg.wasm', import.meta.url)) });

export * from './index.js';
