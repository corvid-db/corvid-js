// vector-index.js — three vector-index families, ANN vs exact.
//
// An in-memory database (the persistence boundary: wasm has no
// filesystem, so the "on-disk" family here is the engine's
// disk-resident HNSW *storage mode* inside this session's store —
// OPFS persistence is the decided future addition) with eight 4-d
// documents. The same embedding is stored under three fields so each
// index family can be demonstrated side by side:
//
//   vMem  — in-memory HNSW              (createVectorIndex)
//   vDisk — on-disk-mode HNSW           (createVectorIndexOndisk)
//   vQ    — in-memory binary-quantized   (createVectorIndexQuantized)
//
// The exact (streaming-scan) ranking is printed first, then the ANN
// (approx) ranking served by each index. The unquantized indexes
// answer identically to the scan on this corpus; the binary-quantized
// one genuinely diverges — the recall/footprint trade-off
// quantization makes (binary packs each float32 to one sign bit, ~32x
// smaller).
//
// Scores are RRF ranks (1/(60 + rank)) — the lone vector source's row
// score — so they reflect each lane's own ranking.
//
// Run under Node:   node examples/vector-index.js   (after `npm run build`)
// In a browser:     import { Db, init } from 'corvid-js'; await init();

'use strict';

import { Db } from '../node.mjs';

const PROBE = new Float32Array([1.0, 0.0, 0.0, 0.0]);

const CORPUS = [
  ['k0', [1.0, 0.0, 0.0, 0.0]], // nearest
  ['k1', [0.95, 0.05, 0.0, 0.0]],
  ['k2', [0.0, 1.0, 0.0, 0.0]],
  ['k3', [0.0, 0.9, 0.1, 0.0]],
  ['k4', [0.0, 0.0, 1.0, 0.0]],
  ['k5', [0.7, 0.7, 0.0, 0.0]],
  ['k6', [0.0, 0.0, 0.0, 1.0]],
  ['k7', [0.98, 0.02, 0.0, 0.0]],
];

function runQuery(docs, field, approx, label) {
  let q = docs.query().vector(field, PROBE, 4, 'cosine');
  if (approx) q = q.approx();
  const rows = q.run();
  const parts = rows.map(({ key, score }) => `${key}(${score.toFixed(6)})`);
  console.log(label.padEnd(38), parts.join(' '));
}

const db = new Db();
const docs = db.collection('items');
for (const [key, v] of CORPUS) {
  const vec = new Float32Array(v);
  docs.insert(key, { v_mem: vec, v_disk: vec, v_q: vec });
}
docs.createVectorIndex('v_mem', 'cosine');
docs.createVectorIndexOndisk('v_disk', 'cosine');
docs.createVectorIndexQuantized('v_q', 'cosine', 'binary');

console.log('top-4 nearest to (1,0,0,0) under cosine:');
runQuery(docs, 'v_mem', false, 'exact (scan):');
runQuery(docs, 'v_mem', true, 'ann in-memory HNSW:');
runQuery(docs, 'v_disk', true, 'ann on-disk-mode HNSW:');
runQuery(docs, 'v_q', true, 'ann binary-quantized:');
console.log('(the quantized lane trades recall for a ~32x smaller index)');

docs.close();
db.close();
