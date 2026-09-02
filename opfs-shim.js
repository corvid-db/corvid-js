// opfs-shim.js — the host side of the OPFS storage backend.
//
// The wasm engine reaches OPFS through SIX SYNCHRONOUS imported
// functions on `corvidOpfs` (docs/OPFS-SPEC.md §3.2). This module IS
// that object: a registry mapping handle ids (u32) to
// FileSystemSyncAccessHandles plus byte-view plumbing over the wasm
// memory. It is host code, shared verbatim by the Worker runtime
// (opfs-worker.js) and the Node test suite's fake handles — one shim,
// two hosts, so the semantics cannot drift.
//
// Lifecycle: install(memory) once at engine bootstrap (`init()` /
// `initSync()` return the wasm exports; their `.memory` is the live
// WebAssembly.Memory), then register(handle) per opened OPFS file —
// it returns the id the engine side holds — and unregister(id) when
// the host retires a handle itself. The wasm-import surface
// (read/write/length/setLen/sync/closeHandle) must stay synchronous:
// redb calls it from synchronous transaction internals.
//
// Errors: every handle operation is wrapped so a DOMException crosses
// as a plain Error whose message begins with the DOMException name
// ("QuotaExceededError: ...") — the Rust side maps that prefix to
// io error kinds (StorageFull / UnexpectedEof / Other).

export const corvidOpfs = {
  _memory: null,
  _handles: new Map(),
  _nextId: 1,

  /** Bind the wasm memory (once, at engine bootstrap). */
  install(memory) {
    this._memory = memory;
  },

  /**
   * Register a sync access handle; returns its id. Throws on the
   * legacy pre-baseline browsers whose sync-handle methods are async
   * (SPEC §5.6) — probed here, at registration, so the failure is a
   * clean attributable error instead of undefined behavior.
   */
  register(handle) {
    const probe = handle.getSize();
    if (probe != null && typeof probe.then === 'function') {
      throw new Error(
        'Io: this browser implements the legacy asynchronous ' +
          'FileSystemSyncAccessHandle methods (pre-March-2023 baseline); ' +
          'corvid-js OPFS persistence requires the synchronous baseline',
      );
    }
    const id = this._nextId++;
    this._handles.set(id, handle);
    return id;
  },

  /** Retire a handle id without touching the handle (host-owned path). */
  unregister(id) {
    this._handles.delete(id);
  },

  _require(id) {
    const h = this._handles.get(id);
    if (!h) throw new Error(`Io: corvidOpfs: unknown or closed handle id ${id}`);
    return h;
  },

  /** Run a handle op, stringifying DOMExceptions into the wire form. */
  _call(id, op) {
    const h = this._require(id);
    try {
      return op(h);
    } catch (e) {
      const name = e && typeof e.name === 'string' ? e.name : 'Error';
      const msg = e && typeof e.message === 'string' ? e.message : String(e);
      throw new Error(`${name}: ${msg}`);
    }
  },

  _view(ptr, len) {
    if (!this._memory) {
      throw new Error('Io: corvidOpfs.install(wasmMemory) was not called');
    }
    return new Uint8Array(this._memory.buffer, ptr, len);
  },

  // ---- the wasm-import surface (synchronous) ----

  read(id, offset, ptr, len) {
    const view = this._view(ptr, len);
    let done = 0;
    while (done < len) {
      const n = this._call(id, (h) => h.read(view.subarray(done), { at: offset + done }));
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`Io: corvidOpfs.read returned a non-integer byte count (${n})`);
      }
      if (n === 0) {
        throw new Error(`UnexpectedEof: corvidOpfs.read hit end of file at ${offset + done}`);
      }
      done += n;
    }
    return done;
  },

  write(id, offset, ptr, len) {
    const view = this._view(ptr, len);
    let done = 0;
    while (done < len) {
      const n = this._call(id, (h) => h.write(view.subarray(done), { at: offset + done }));
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`Io: corvidOpfs.write returned a non-integer byte count (${n})`);
      }
      if (n === 0) {
        throw new Error(`Io: corvidOpfs.write wrote 0 bytes at ${offset + done}`);
      }
      done += n;
    }
    if (done !== len) {
      // Only reachable when a handle OVERSHOOTS (reports more than
      // requested) — the Rust side refuses the mismatched count too.
      throw new Error(`Io: corvidOpfs.write: byte count mismatch (${done} of ${len})`);
    }
    return done;
  },

  length(id) {
    const n = this._call(id, (h) => h.getSize());
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new Error(`Io: corvidOpfs.length returned a non-safe-integer (${n})`);
    }
    return n;
  },

  setLen(id, len) {
    if (!Number.isSafeInteger(len) || len < 0) {
      throw new Error(`Io: corvidOpfs.setLen received a non-safe-integer (${len})`);
    }
    this._call(id, (h) => h.truncate(len));
  },

  sync(id) {
    this._call(id, (h) => h.flush());
  },

  closeHandle(id) {
    const h = this._handles.get(id);
    if (!h) return; // SPEC §5.2: no-op on unregistered ids
    this._handles.delete(id);
    let failure = null;
    try {
      h.flush();
    } catch (e) {
      failure = e; // the original error wins; close anyway below
    }
    try {
      h.close();
    } catch (e) {
      failure = failure ?? e;
    }
    if (failure) {
      const name =
        failure && typeof failure.name === 'string' ? failure.name : 'Error';
      const msg =
        failure && typeof failure.message === 'string'
          ? failure.message
          : String(failure);
      throw new Error(`${name}: ${msg}`);
    }
  },
};

// wasm-bindgen's `js_namespace = corvidOpfs` imports resolve the bare
// identifier `corvidOpfs` at call time — publish the shim globally.
globalThis.corvidOpfs = corvidOpfs;
