// quickstart.js — the README tour as a runnable file.
//
// Open an in-memory database, create a collection, insert three small
// documents carrying 2-d embeddings, run a kNN vector query under
// cosine, and print the ranked rows. Close what you opened.
//
// Run under Node:   node examples/quickstart.js   (after `npm run build`)
//
// Browsers run the SAME code — only the loader line differs:
//
//     import { Db, init } from 'corvid-js';
//     await init();              // fetch + instantiate the wasm module
//     const db = new Db();       // ...everything below, unchanged
//
// The database is in-memory per session (wasm has no filesystem; OPFS
// persistence is a decided future addition — see the README).

'use strict';

// docs:begin:quickstart
import { Db } from '../node.mjs';

const db = new Db();
const docs = db.collection('docs');

docs.insert('p1', {
  title: 'rust embedded database',
  kind: 'doc',
  v: new Float32Array([1.0, 0.0]),
});
docs.insert('p2', {
  title: 'python web frameworks',
  kind: 'doc',
  v: new Float32Array([0.0, 1.0]),
});
docs.insert('p3', {
  title: 'rust again database',
  kind: 'doc',
  v: new Float32Array([0.9, 0.1]),
});

// kNN: the 3 nearest documents to (1, 0) under cosine.
const rows = docs
  .query()
  .vector('v', new Float32Array([1.0, 0.0]), 3, 'cosine')
  .run(); // [{ key, doc, score }]

let rank = 0;
for (const { key, doc, score } of rows) {
  console.log(`${++rank}. ${key} score=${score.toFixed(6)} ${doc.title}`);
}

docs.close();
db.close();
// docs:end:quickstart
