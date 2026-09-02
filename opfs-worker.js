// opfs-worker.js — the Dedicated Worker runtime (docs/OPFS-SPEC.md
// §5.2/§5.3/§5.5). One worker per open database: it hosts the wasm
// engine, owns the OPFS sync handles, and answers the RPC protocol.
//
// Spawned by openOpfs() as a module worker; boots the engine (fetch +
// instantiate), installs the shim's wasm memory, then serves requests
// strictly in arrival order. All engine semantics live in opfs-rpc.js
// (shared with the Node test suite); this file is the environment:
// OPFS acquisition (the cross-tab exclusivity point), backup-target
// lifecycle, chunk backpressure, and termination when the last db
// closes.

import { bootEngine, createRpcHost } from './opfs-rpc.js';
import { corvidOpfs } from './opfs-shim.js';

const glue = await bootEngine();

const env = {
  async openHandle(name) {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('corvid', { create: true });
    const file = await dir.getFileHandle(`${name}.corvid`, { create: true });
    let handle;
    try {
      // The exclusivity point (SPEC §5.2 step 5): a default-mode sync
      // handle takes the file's exclusive lock; a second tab or handle
      // rejects here.
      handle = await file.createSyncAccessHandle();
    } catch (e) {
      if (e?.name === 'NoModificationAllowedError') {
        throw {
          code: 19,
          message: `OPFS file is locked by another tab or handle: ${name}.corvid`,
        };
      }
      throw { code: 18, message: `${e?.name ?? 'Error'}: ${e?.message ?? e}` };
    }
    return corvidOpfs.register(handle); // throws on legacy browsers (§5.6)
  },

  async backupTarget(name) {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('corvid', { create: true });
    // Existence pre-check (SPEC §5.5 step 2): NotFoundError means
    // absent (good); a hit is code 17 with no side effects.
    try {
      await dir.getFileHandle(name, { create: false });
      throw { code: 17, message: `backup target already exists: ${name}` };
    } catch (e) {
      if (e?.code === 17) throw e;
      if (e?.name !== 'NotFoundError') {
        throw { code: 18, message: `${e?.name ?? 'Error'}: ${e?.message ?? e}` };
      }
    }
    const file = await dir.getFileHandle(name, { create: true });
    const handle = await file.createSyncAccessHandle();
    return corvidOpfs.register(handle);
  },

  async removeTarget(name) {
    // Best-effort debris cleanup after a failed backup (§5.5 step 4).
    const root = await navigator.storage.getDirectory();
    try {
      const dir = await root.getDirectoryHandle('corvid', { create: false });
      await dir.removeEntry(name);
    } catch {
      /* nothing to remove, or already gone */
    }
  },
};

const host = createRpcHost(glue, env);

// Chunk backpressure: emit resolves only when cont/cancel arrives, so
// the dispatcher's scan loop cannot outrun the consumer (SPEC §7.1).
const pendingControls = new Map(); // stream id -> () => resolve

let openDbs = 0;

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.t === 'cont' || m.t === 'cancel') {
    host.control(m.id, m.t);
    const release = pendingControls.get(m.id);
    if (release) {
      pendingControls.delete(m.id);
      release();
    }
    return;
  }
  if (m.t !== 'req') return;
  try {
    const v = await host.dispatch(m, (id, rows) =>
      new Promise((resolveEmit) => {
        pendingControls.set(id, resolveEmit);
        self.postMessage({ t: 'chunk', id, rows });
      }),
    );
    if (m.op === 'db.open') openDbs += 1;
    // The ok for db.close is the LAST message: by the dispatch
    // contract the engine Db (and every derived handle) is dropped,
    // the backend's close has fired, and the OPFS lock is free —
    // §5.3's pinned ordering. Then the worker terminates.
    if (m.v instanceof Uint8Array && m.v.buffer) {
      // SPEC §7.2: response buffers are transferred, not cloned.
      self.postMessage({ t: 'ok', id: m.id, v: m.v }, [m.v.buffer]);
    } else {
      self.postMessage({ t: 'ok', id: m.id, v: m.v });
    }
    if (m.op === 'db.close') {
      openDbs -= 1;
      if (openDbs <= 0) self.close();
    }
  } catch (e) {
    self.postMessage({
      t: 'err',
      id: m.id,
      c: e?.code ?? 18,
      m: e?.message ?? String(e),
    });
  }
};
