// test/browser-e2e/fixtures-runner.mjs — the async fixture leg of the
// browser conformance (docs/OPFS-SPEC.md §8), executed IN THE PAGE over
// plain http (no bundler/dev-server transform): the two file-backed
// fixture files run through the REAL openOpfs → Worker → OPFS path
// with the canonical Worker construct. The fixture language is the
// shared helper (one grammar with the Node golden suite); the §8
// mapping is the dispatch below.

import { openOpfs } from '../../opfs-async.js';
import {
  checkValue,
  doubleMatches,
  errCode,
  listBody,
  parseLiteral,
  splitTop,
} from '../helpers/fixture-lang.js';

function keyList(tok) {
  // k(...) bodies are raw key names (comma-separated), not value
  // literals — 'docs' or 'strong,weak' would not parse as literals.
  return splitTop(listBody(tok));
}

function textOf(tok) {
  return tok.startsWith('t(') ? tok.slice(2, -1) : tok;
}

function keyOf(tok) {
  return textOf(tok);
}

function metricOf(tok) {
  const m = textOf(tok);
  if (m === 'cosine' || m === 'dot' || m === 'l2') return m;
  throw new Error(`unknown metric token: ${tok}`);
}

class AsyncScenario {
  constructor() {
    this.db = null;
    this.name = '';
    this.colls = new Map();
    this.dumpBytes = null;
    this.currentColl = 'docs';
  }

  async filedb(name) {
    if (this.db) await this.close();
    this.name = name;
    this.db = await openOpfs(name);
    this.colls.clear();
    this.currentColl = 'docs';
  }

  async coll(name) {
    const n = name ?? this.currentColl;
    let c = this.colls.get(n);
    if (!c) {
      if (!this.db) throw new Error('no open database');
      c = await this.db.collection(n);
      this.colls.set(n, c);
    }
    return c;
  }

  async close() {
    for (const c of this.colls.values()) await c.close();
    this.colls.clear();
    await this.db?.close();
    this.db = null;
  }
}

async function dispatch(s, op, a, expected, ctx, dbName, seq) {
  const ok = async (fn) => {
    if (expected === 'ok') {
      await fn();
      return;
    }
    if (expected.startsWith('err:')) {
      const want = errCode(expected);
      try {
        await fn();
      } catch (e) {
        if (e.code !== want) throw new Error(`${ctx}: expected err:${want}, got err:${e.code}`);
        return;
      }
      throw new Error(`${ctx}: expected err:${want}, got ok`);
    }
    throw new Error(`${ctx}: unsupported expectation '${expected}'`);
  };

  switch (op) {
    case 'FILEDB':
      await ok(() => s.filedb(`${dbName}-main`));
      return;
    case 'FILEDB2':
      await ok(() => s.filedb(`${dbName}-second-${seq.next()}`));
      return;
    case 'REOPEN':
      await ok(async () => {
        const name = s.name;
        await s.close();
        await s.filedb(name);
      });
      return;
    case 'COLL': {
      const name = textOf(a[0]);
      s.currentColl = name;
      const c = await s.coll(name);
      if (c.name !== name) throw new Error(`${ctx}: collection name mismatch`);
      return;
    }
    case 'INSERT':
      await ok(() => s.coll().then((c) => c.insert(keyOf(a[0]), parseLiteral(a[1]))));
      return;
    case 'LINK':
      await ok(() => s.coll().then((c) => c.link(keyOf(a[0]), textOf(a[1]), keyOf(a[2]))));
      return;
    case 'INSERT_TTL':
      await ok(() =>
        s.coll().then((c) => c.insertWithTtl(keyOf(a[0]), parseLiteral(a[1]), Number(a[2]))),
      );
      return;
    case 'COLLECTIONS': {
      const names = await s.db.collections();
      if (JSON.stringify(names) !== JSON.stringify(keyList(expected))) {
        throw new Error(`${ctx}: collections ${JSON.stringify(names)} != ${expected}`);
      }
      return;
    }
    case 'SET_SCHEMA': {
      const [name, type, req, uniq] = a[0].split('#');
      await s.coll().then((c) =>
        c.setSchema([{ name, type, required: req === '1', unique: uniq === '1' }]),
      );
      return;
    }
    case 'SCHEMA': {
      const schema = await s.coll().then((c) => c.schema());
      const [nm, ty, rq, uq] = expected.split('/');
      const want = [{ name: nm, type: ty, required: rq === '1', unique: uq === '1' }];
      if (JSON.stringify(schema) !== JSON.stringify(want)) {
        throw new Error(`${ctx}: schema ${JSON.stringify(schema)} != ${expected}`);
      }
      return;
    }
    case 'IDX_TEXT_DISK':
      await ok(() => s.coll().then((c) => c.createTextIndexOndisk(textOf(a[0]))));
      return;
    case 'IDX_VEC_DISK':
      await ok(() =>
        s.coll().then((c) => c.createVectorIndexOndisk(textOf(a[0]), metricOf(a[1]))),
      );
      return;
    case 'QTEXT': {
      const rows = await s
        .coll()
        .then((c) => c.query().text(textOf(a[0]), textOf(a[1]), Number(a[2])).run());
      if (JSON.stringify(rows.map((r) => String(r.key))) !== JSON.stringify(keyList(expected))) {
        throw new Error(`${ctx}: qtext keys mismatch: ${JSON.stringify(rows.map((r) => r.key))}`);
      }
      return;
    }
    case 'QVEC': {
      const [keysTok, scoresTok] = expected.split('|');
      const probe = parseLiteral(a[1]);
      const rows = await s
        .coll()
        .then((c) => c.query().vector(textOf(a[0]), probe, Number(a[2])).run());
      if (JSON.stringify(rows.map((r) => String(r.key))) !== JSON.stringify(keyList(keysTok))) {
        throw new Error(`${ctx}: qvec keys mismatch`);
      }
      if (scoresTok) {
        const toks = splitTop(scoresTok);
        rows.forEach((r, i) => {
          if (!doubleMatches(r.score, toks[i])) {
            throw new Error(`${ctx}: qvec score ${i}: ${r.score} !~ ${toks[i]}`);
          }
        });
      }
      return;
    }
    case 'GETFIELD': {
      const doc = await s.coll().then((c) => c.get(keyOf(a[0])));
      checkValue(doc?.[a[1].split('.')[0]], expected, ctx);
      return;
    }
    case 'LEN': {
      const n = await s.coll().then((c) => c.len());
      if (n !== Number(expected)) throw new Error(`${ctx}: len ${n} != ${expected}`);
      return;
    }
    case 'AGG_COUNT': {
      const n = await s.coll().then((c) => c.query().count());
      if (n !== Number(expected)) throw new Error(`${ctx}: count ${n} != ${expected}`);
      return;
    }
    case 'DUMP':
      await ok(async () => {
        s.dumpBytes = await s.db.dump();
      });
      return;
    case 'BACKUP':
      await ok(() => s.db.backupTo(`${dbName}-backup`));
      return;
    case 'BACKUP_DUP':
      await ok(() => s.db.backupTo(`${dbName}-backup`)); // expects 17
      return;
    case 'COMPACT_BUSY':
      await ok(() => s.db.compact()); // expects 19 (live collection)
      return;
    case 'COMPACT': {
      const c = s.colls.get('docs');
      if (c) {
        await c.close();
        s.colls.delete('docs');
      }
      await ok(() => s.db.compact());
      return;
    }
    case 'LOAD':
      await ok(() => s.db.load(s.dumpBytes));
      return;
    case 'LOAD_RENAMES': {
      // splitTop already split the args: a = [from, to].
      const [from, to] = a;
      await ok(() => s.db.loadWithRenames(s.dumpBytes, { [from]: to }));
      return;
    }
    default:
      throw new Error(`${ctx}: unknown OP for the async fixture leg: ${op}`);
  }
}

/** Run one async fixture file in the page; resolves `{lines}` or throws. */
export async function runAsyncFixture(file, dbName) {
  const res = await fetch(`/test/golden/${file}`);
  if (!res.ok) throw new Error(`fixture fetch failed: ${file} (${res.status})`);
  const text = await res.text();

  const counted = text.split('\n').filter((l) => {
    const t = l.replace(/[\r ]+$/, '').trimStart();
    return t.length > 0 && !t.startsWith('#');
  });

  let secondSeq = 0;
  const seq = { next: () => ++secondSeq };
  const s = new AsyncScenario();
  let executed = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.length === 0 || line[0] === '#') continue;
    const ctx = `${file}:${executed + 1}`;
    let op = line;
    let argsStr = '';
    let expected = '';
    const tab1 = line.indexOf('\t');
    if (tab1 >= 0) {
      op = line.slice(0, tab1);
      const tab2 = line.indexOf('\t', tab1 + 1);
      if (tab2 >= 0) {
        argsStr = line.slice(tab1 + 1, tab2);
        expected = line.slice(tab2 + 1);
      } else {
        argsStr = line.slice(tab1 + 1);
      }
    }
    const a = argsStr ? splitTop(argsStr) : [];
    try {
      await dispatch(s, op, a, expected, `${ctx} OP=${op}`, dbName, seq);
    } catch (e) {
      throw new Error(`${ctx} OP=${op} [code=${e.code ?? 'none'}]: ${e.message} :: ${String(e.stack ?? '').split('\\n').slice(1, 3).join(' | ')}`);
    }
    executed++;
  }
  await s.close();
  if (executed !== counted.length) {
    throw new Error(`${file}: dispatched ${executed} != counted ${counted.length}`);
  }
  return { lines: executed };
}
