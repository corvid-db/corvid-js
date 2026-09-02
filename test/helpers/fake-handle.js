// test/helpers/fake-handle.js — a fake FileSystemSyncAccessHandle over
// a growing byte buffer, with optional quota simulation (writes that
// would grow the file past `quotaAt` throw a QuotaExceededError-shaped
// Error). Used by the OPFS backend spec and the async-facade spec.
export function makeFakeHandle({ quotaAt = Infinity } = {}) {
  const h = {
    data: new Uint8Array(0),
    flushes: 0,
    closed: false,
    read(buf, { at }) {
      let i = 0;
      while (i < buf.length && at + i < h.data.length) {
        buf[i] = h.data[at + i];
        i += 1;
      }
      return i;
    },
    write(buf, { at }) {
      const end = at + buf.length;
      if (end > quotaAt) {
        const e = new Error('The operation exceeded the storage quota');
        e.name = 'QuotaExceededError';
        throw e;
      }
      if (end > h.data.length) {
        const grown = new Uint8Array(end);
        grown.set(h.data.subarray(0, Math.min(at, h.data.length)));
        h.data = grown;
      }
      h.data.set(buf, at);
      return buf.length;
    },
    truncate(n) {
      if (n > h.data.length) {
        const grown = new Uint8Array(n);
        grown.set(h.data);
        h.data = grown;
      } else {
        h.data = h.data.subarray(0, n);
      }
    },
    getSize() {
      return h.data.length;
    },
    flush() {
      h.flushes += 1;
    },
    close() {
      h.closed = true;
    },
  };
  return h;
}
