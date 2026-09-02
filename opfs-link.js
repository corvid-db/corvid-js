// opfs-link.js — the two transports the async facade runs over
// (docs/OPFS-SPEC.md §7).
//
// WorkerLink wraps a real Dedicated Worker: postMessage both ways,
// request ids multiplexed, one reply per request ({t:'ok',v} /
// {t:'err',c,m}), chunked streams with cont/cancel flowing back.
// DirectLink runs the SAME dispatcher in-process — the Node suite's
// transport and a debugging tool; the semantics it exercises are the
// ones users get, and T5's Playwright leg covers the postMessage and
// real-OPFS parts it cannot.
//
// Both links present one interface:
//   send(req, handlers?) -> Promise   handlers.onChunk(id, rows) may
//                                     return 'cont' | 'cancel'
//   terminate()
// and both reject with CorvidError (code + message) — never raw
// transport errors. postMessage's DataCloneError (a function, symbol,
// or DOM node inside an argument) maps to InvalidArgument (12), the
// spec's first wire-level difference (§4.4).

import { CorvidError } from './index.js';

function linkErr(code, message) {
  return new CorvidError(code, message);
}

export class WorkerLink {
  constructor(worker) {
    this.worker = worker;
    this.next = 1;
    this.pending = new Map(); // id -> { resolve, reject, onChunk }
    worker.onmessage = (ev) => this._onMessage(ev.data);
    worker.onerror = (ev) => {
      // Worker-level failures (module load error, uncaught error):
      // reject everything in flight; the facade's open path surfaces it.
      for (const { reject } of this.pending.values()) {
        reject(linkErr(18, `worker failed: ${ev.message ?? 'unknown error'}`));
      }
      this.pending.clear();
    };
  }

  _onMessage(m) {
    const entry = this.pending.get(m.id);
    if (m.t === 'chunk') {
      if (entry?.onChunk) {
        Promise.resolve()
          .then(() => entry.onChunk(m.rows))
          .then((action) =>
            this.worker.postMessage({ t: action === 'cancel' ? 'cancel' : 'cont', id: m.id }),
          )
          .catch(() => this.worker.postMessage({ t: 'cancel', id: m.id }));
      } else {
        this.worker.postMessage({ t: 'cont', id: m.id });
      }
      return;
    }
    if (!entry) return;
    this.pending.delete(m.id);
    if (m.t === 'ok') entry.resolve(m.v);
    else entry.reject(linkErr(m.c, m.m));
  }

  send(req, handlers = {}) {
    return new Promise((resolve, reject) => {
      const id = this.next;
      this.next += 1;
      this.pending.set(id, { resolve, reject, onChunk: handlers.onChunk });
      try {
        this.worker.postMessage({ t: 'req', id, ...req });
      } catch (e) {
        this.pending.delete(id);
        if (e?.name === 'DataCloneError' || /could not be cloned/i.test(String(e?.message ?? ''))) {
          reject(linkErr(12, `value is not StructuredClone-able: ${e.message}`));
        } else {
          reject(linkErr(18, `${e?.name ?? 'Error'}: ${e?.message ?? e}`));
        }
      }
    });
  }

  terminate() {
    this.worker.terminate();
  }
}

export class DirectLink {
  constructor(host) {
    this.host = host;
  }

  async send(req, handlers = {}) {
    try {
      return await this.host.dispatch(req, async (id, rows) => {
        if (!handlers.onChunk) return 'cont';
        const action = await handlers.onChunk(rows);
        if (action === 'cancel') this.host.control(id, 'cancel');
      });
    } catch (e) {
      if (e instanceof CorvidError) throw e;
      throw linkErr(e?.code ?? 18, e?.message ?? String(e));
    }
  }

  terminate() {}
}
