// opfs-rpc.js — the RPC dispatcher both hosts run (docs/OPFS-SPEC.md §7).
//
// One dispatcher, two hosts:
//   - the browser Dedicated Worker (opfs-worker.js) drives it over
//     postMessage (WorkerLink on the main thread);
//   - the Node test suite drives it in-process (DirectLink) against
//     fake OPFS handles — the semantics that reach users are proven
//     here, and T5's Playwright leg proves the postMessage/OPFS parts
//     the fake cannot.
//
// The protocol (SPEC §7.1/§7.2): requests {t:'req', id, op, h, ch?, a}
// get one reply {t:'ok', id, v} or {t:'err', id, c, m}; scanEach
// streams {t:'chunk', id, rows} with {t:'cont'} / {t:'cancel'} flowing
// back. `h` names the primary handle (db, collection, or query); `ch`
// names a second handle when the op needs one — `coll.create` uses it
// for the new collection id, and every `query.*` op carries the owning
// collection id there. Handle ids are allocated by the CALLER (the
// facade); the host stores under them verbatim. Ops execute strictly
// in arrival order (single worker, single engine, single file —
// SPEC §7.3). Every environment capability (OPFS acquisition,
// backup-target lifecycle) sits behind the injected `env`, so the
// dispatcher itself is pure engine plumbing.
//
// Errors: the wasm layer throws Error with the JSON wire form
// ({"corvidCode":N,"corvidMessage":"..."}); the env throws {code,
// message} objects carrying frozen-table codes. dispatch() normalizes
// both into {code, message} — hosts serialize that into the err
// envelope.

// Static imports, deliberately: this module loads inside a raw
// Dedicated Worker (`new Worker(url, {type:'module'})`), where vite's
// dev-time dynamic-import shims do not exist — a dynamic import here
// broke the worker under every bundler/dev-server that transforms it
// (found by the browser leg). The glue module is importable everywhere
// (Node's entry does the same); only its INIT differs per host.
import * as glueModule from './pkg/corvid_js.js';
import { corvidOpfs } from './opfs-shim.js';

// Boot the engine for a BROWSER host (worker or page): fetch +
// instantiate, then install the wasm memory into the shim — the OPFS
// backend's prerequisite (SPEC §3.2). Node hosts (the test suite's
// DirectLink) boot via initSync themselves and pass the same glue
// module to createRpcHost.
export async function bootEngine() {
  const out = await glueModule.default(); // init(): fetch + instantiate
  corvidOpfs.install(out.memory);
  return glueModule;
}

// Normalize any thrown value into the protocol's {code, message}.
function normalizeError(e) {
  if (e && typeof e.code === 'number' && typeof e.message === 'string') {
    return { code: e.code, message: e.message }; // env-thrown
  }
  if (e instanceof Error) {
    try {
      const parsed = JSON.parse(e.message);
      if (typeof parsed.corvidCode === 'number') {
        return { code: parsed.corvidCode, message: parsed.corvidMessage };
      }
    } catch {
      /* not the wire form */
    }
  }
  return { code: 18, message: String(e?.message ?? e) }; // Io-flavored catch-all
}

// The collection methods the generic coll.call op forwards to, in
// their glue names (SPEC §7.2: every AsyncCollection method minus
// update — composed client-side — and scanEach — the streaming op).
// An allowlist, not a denylist: a new engine method never silently
// becomes callable. `scanRows` is included (a materialized scan is a
// legitimate op); `scanCb` is not (a callback cannot cross).
const COLL_METHODS = new Set([
  'insert', 'insertMany', 'insertAuto', 'patch', 'compareAndSet',
  'delete', 'deleteWhere', 'deleteBatch',
  'insertWithTtl', 'setTtl', 'ttl', 'purgeExpired',
  'get', 'scanRows', 'page', 'len', 'isEmpty', 'phraseSearch',
  'createScalarIndex', 'createCompoundIndex', 'createTextIndex',
  'createTextIndexOndisk', 'createGeoIndex', 'createVectorIndex',
  'createVectorIndexQuantized', 'createVectorIndexOndisk',
  'createVectorIndexOndiskQuantized', 'createVectorIndexPq',
  'createVectorIndexOndiskPq',
  'setSchema', 'schema',
  'link', 'linkWeighted', 'unlink', 'neighbors', 'inNeighbors',
  'neighborsWeighted', 'traverse',
  'geoWithinRadius', 'geoWithinBbox', 'geoNearest',
]);

// Query chain methods (their replies carry errors only — the facade's
// poisoning rule) and terminal methods (results carried back).
const QUERY_CHAIN = new Set([
  'filter', 'vector', 'text', 'fuseRrf', 'rerankMmr', 'approx',
  'limit', 'offset', 'orderBy', 'select',
]);
const QUERY_TERMINAL = new Set([
  'run', 'count', 'countDistinct', 'sum', 'avg', 'min', 'max',
  'groupCount', 'groupSum', 'groupAvg',
]);

const SCAN_CHUNK = 512;

// Create the RPC host. `env` implements the environment contract:
//   openHandle(name)   -> Promise<u32 id>  (acquire + register; the
//                       BUSY/InvalidName mapping is the env's job —
//                       SPEC §5.2 step 5, §6)
//   backupTarget(name) -> Promise<u32 id>  (existence pre-check —
//                       code 17 on a hit; create + register)
//   removeTarget(name) -> Promise<void>    (best-effort debris
//                       cleanup after a failed backup)
export function createRpcHost(glue, env) {
  const dbs = new Map(); // h -> { db, colls:Set, queries:Set }
  const colls = new Map(); // h -> { coll, dbh }
  const queries = new Map(); // h -> { query, dbh }
  const streams = new Map(); // stream id -> { canceled }

  function forgetColl(h) {
    const c = colls.get(h);
    if (!c) return;
    colls.delete(h);
    dbs.get(c.dbh)?.colls.delete(h);
  }

  // db.close's force-teardown: every derived handle closes first so
  // the engine Db actually drops — the backend's close (handle
  // release) fires BEFORE the close op's ack, holding SPEC §5.3's
  // pinned ordering regardless of user close discipline (one worker
  // per db makes this exact, not best-effort).
  function closeDerivedOf(dbh) {
    for (const [h, q] of [...queries]) {
      if (q.dbh === dbh) {
        q.query.close();
        queries.delete(h);
      }
    }
    for (const [h, c] of [...colls]) {
      if (c.dbh === dbh) {
        c.coll.close();
        forgetColl(h);
      }
    }
  }

  function requireDb(h) {
    const entry = dbs.get(h);
    if (!entry) throw { code: 1, message: 'database handle is closed' };
    return entry;
  }

  // The query for handle `h` (owning collection `ch`), built lazily on
  // its first op (SPEC §7.2).
  function ensureQuery(h, ch) {
    let entry = queries.get(h);
    if (!entry) {
      const coll = colls.get(ch);
      if (!coll) {
        throw { code: 1, message: 'query handle created from a closed collection' };
      }
      entry = { query: coll.coll.query(), dbh: coll.dbh };
      queries.set(h, entry);
      dbs.get(coll.dbh)?.queries.add(h);
    }
    return entry;
  }

  async function scanEach(id, coll, emit, isCanceled) {
    let after = null;
    for (;;) {
      if (isCanceled()) return;
      const page = coll.page(after, SCAN_CHUNK);
      if (page.rows.length > 0) {
        await emit(page.rows); // the host resolves this on cont/cancel
        after = page.next;
      }
      if (page.next === null || page.rows.length === 0) return;
    }
  }

  // Handle one request; resolves/rejects with the op's outcome.
  // `emit(id, rows)` is the chunk sink for the streaming op — the
  // host wires it to the transport (DirectLink resolves eagerly).
  async function dispatch(req, emit) {
    const { op, h, ch, a = [] } = req;
    try {
      switch (op) {
        case 'db.open': {
          const [name] = a;
          const handleId = await env.openHandle(name);
          const db = glue.WasmDb.openOpfs(handleId);
          dbs.set(h, { db, colls: new Set(), queries: new Set() });
          return undefined;
        }
        case 'db.close': {
          const entry = dbs.get(h);
          if (!entry) return undefined;
          closeDerivedOf(h);
          entry.db.close();
          dbs.delete(h);
          return undefined;
        }
        case 'db.collections':
          return requireDb(h).db.collections();
        case 'db.compact':
          return requireDb(h).db.compact();
        case 'db.dump':
          return requireDb(h).db.dump();
        case 'db.load': {
          const [bytes, renames] = a;
          if (renames) {
            const keys = Object.keys(renames);
            return requireDb(h).db.loadWithRenames(
              bytes,
              keys,
              keys.map((k) => renames[k]),
            );
          }
          return requireDb(h).db.load(bytes);
        }
        case 'db.backupTo': {
          const [name] = a;
          // The db handle is resolved BEFORE the target is created —
          // a dead db handle must not leave a registered target behind.
          requireDb(h);
          const targetId = await env.backupTarget(name); // code 17 on a hit
          try {
            return requireDb(h).db.backupOpfs(targetId);
          } catch (e) {
            // No debris (SPEC §5.5 step 4) — best-effort; the original error wins.
            await env.removeTarget(name).catch(() => {});
            throw e;
          }
        }

        case 'coll.create': {
          const [name] = a;
          const entry = requireDb(h);
          const coll = entry.db.collection(name);
          colls.set(ch, { coll, dbh: h });
          entry.colls.add(ch);
          return undefined;
        }
        case 'coll.close':
        case 'coll.gc': {
          const c = colls.get(h);
          if (c) {
            c.coll.close();
            forgetColl(h);
          }
          return undefined;
        }
        case 'coll.call': {
          const [method, ...args] = a;
          if (!COLL_METHODS.has(method)) {
            throw { code: 12, message: `unknown collection method: ${method}` };
          }
          const c = colls.get(h);
          if (!c) throw { code: 1, message: 'collection handle is closed' };
          return c.coll[method](...args);
        }

        case 'query.op':
        case 'query.terminal': {
          const [method, ...args] = a;
          const table = op === 'query.op' ? QUERY_CHAIN : QUERY_TERMINAL;
          if (!table.has(method)) {
            throw {
              code: 12,
              message: `unknown query ${op === 'query.op' ? 'chain' : 'terminal'} method: ${method}`,
            };
          }
          const entry = ensureQuery(h, ch);
          const out = entry.query[method](...args);
          if (method === 'run') {
            // run consumes the builder (the engine's contract); the
            // facade never sends another op on a consumed handle.
            entry.query.close();
            queries.delete(h);
            dbs.get(entry.dbh)?.queries.delete(h);
          }
          return out;
        }
        case 'query.close':
        case 'query.gc': {
          const q = queries.get(h);
          if (q) {
            q.query.close();
            queries.delete(h);
            dbs.get(q.dbh)?.queries.delete(h);
          }
          return undefined;
        }

        case 'coll.scanEach': {
          const c = colls.get(h);
          if (!c) throw { code: 1, message: 'collection handle is closed' };
          const state = { canceled: false };
          streams.set(req.id, state);
          try {
            await scanEach(
              req.id,
              c.coll,
              (rows) => emit(req.id, rows),
              () => state.canceled,
            );
          } finally {
            streams.delete(req.id);
          }
          return undefined;
        }

        default:
          throw { code: 12, message: `unknown op: ${op}` };
      }
    } catch (e) {
      throw normalizeError(e);
    }
  }

  return {
    dispatch,
    // The cont/cancel sink for streaming ops (SPEC §7.1).
    control(id, kind) {
      const s = streams.get(id);
      if (s && kind === 'cancel') s.canceled = true;
    },
  };
}
