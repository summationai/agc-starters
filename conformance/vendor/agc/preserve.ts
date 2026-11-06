// What must survive a migration, proven around it, from a connection of its own: the keys it sets aside are temporary
// tables of that session, which no other session can read or change (a migration can drop them: that fails the proof).
// It sees only public and pg_catalog, so a schema a migration creates can't stand in for the tables. Proven: the results of `unchanged` checks, `equal:` pairs across the change
// (a query on the old schema against one on the new), and, without anyone asking, every row of every table that existed
// before. Captured right before the migrations and compared right after, before any test writes data. `agc migrate`
// does it on a mirror; a ship's rehearsal does it on a fresh copy of production, where it reports pass or fail only.
// Shared by agc and the control service (which copies this file into its image).
import pg from 'pg';

export interface PreserveCheck {
  name: string;
  sql: string;
  hold?: string; // 'unchanged' or 'equal:<check name>'
}

export interface PreserveResult {
  name: string;
  kind: 'invariant';
  ok: boolean;
  detail: string;
}

interface Table {
  schema: string;
  table: string;
  pk: string[];
  cols: string[]; // "name:attnum": a column dropped and added back under its name is a different column
  rows: number;
  saved: string | null; // where its primary keys were set aside
}

export interface Captured {
  digests: Map<string, string | Error>;
  tables: Table[];
  operators: number; // operators in public: a migration that adds one could change what = means in a check
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const one = (text: string) => ({ text, queryMode: 'extended' }) as pg.QueryConfig; // a single statement, nothing chained
// An order-free fingerprint of a query's whole result.
const digestOf = (sql: string) => `SELECT md5(coalesce(string_agg(r::text, E'\\n' ORDER BY r::text), '')) AS digest FROM (${sql.trim().replace(/;\s*$/, '')}) r`;

// What migrations say they remove on purpose, in their header (the comment lines before any SQL):
// `-- agentcloud: drops orders, bookings.child_name` (the contract step of an expand/contract change) or
// `-- agentcloud: rekeys orders` (a new primary key). Anything else that goes is a loss.
export interface Declared {
  drops: Set<string>;
  rekeys: Set<string>;
}

export function declaredDrops(sqls: string[]): Declared {
  const out: Declared = { drops: new Set(), rekeys: new Set() };
  for (const sql of sqls) {
    for (const line of sql.split('\n')) {
      if (line.trim() && !line.trim().startsWith('--')) break; // the header ends at the first line of SQL
      const m = /^\s*--\s*agentcloud:\s*(drops|rekeys)\s+(.+)$/i.exec(line);
      if (m) for (const name of m[2].split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) out[m[1].toLowerCase() as 'drops' | 'rekeys'].add(name);
    }
  }
  return out;
}

// What the declarations say, for the person approving.
export const describeDeclared = (d: Declared) => [
  ...[...d.drops].map((n) => `deletes ${n}`), ...[...d.rekeys].map((n) => `gives ${n} a new primary key`),
];

export const preserving = (checks: PreserveCheck[]) => checks.filter((c) => c.hold === 'unchanged' || c.hold?.startsWith('equal:'));

// MIRROR-47: a copy that stopped answering after the connect: a statement past its deadline, or a connection that closed or
// broke. It's never a check's own result, and nothing more is sent on that connection, a ROLLBACK included: pg leaves a
// statement past its client deadline active until the socket goes. The caller drops the connection and says so.
export function copyStopped(e: unknown): string | null {
  const message = (e as Error)?.message ?? '', code = (e as { code?: string })?.code ?? '';
  if (message === 'Query read timeout') return 'a statement got no answer within its deadline';
  if (/^Connection terminated/.test(message)) return 'the connection closed';
  if (/^(ECONNRESET|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH)$/.test(code)) return `the connection broke (${code})`;
  return null;
}
const rollback = (db: pg.Client) => db.query('ROLLBACK').then(() => {}, (e: unknown) => { if (copyStopped(e)) throw e; });

async function readOnly<T>(db: pg.Client, run: () => Promise<T>): Promise<T> {
  await db.query('BEGIN READ ONLY');
  let out: T;
  try {
    await db.query("SET LOCAL statement_timeout = '60s'");
    out = await run();
  } catch (e) {
    if (!copyStopped(e)) await rollback(db);
    throw e;
  }
  await rollback(db);
  return out;
}

// A measuring session: errors on it (a migration may end other sessions) are recorded, never thrown at the process,
// and names resolve only in public, never in a schema the migrations made.
export async function measuring(db: pg.Client): Promise<{ broken: () => Error | null }> {
  let broken: Error | null = null;
  db.on('error', (e) => { broken = e; });
  await db.query("SET search_path = public; SET statement_timeout = '120s'");
  return { broken: () => broken };
}

// PKEY-1: the review's no-primary-key rule, earlier: each table the review reads (control's inspect.ts schemaShape, the
// same filter) that has no primary key, as a warning line. The catalog only, never a row.
export async function noPrimaryKey(db: pg.Client): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(`
    SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
       AND n.nspname NOT IN ('anon', 'neon', 'neon_auth') AND c.relname NOT LIKE 'agentcloud\\_%'
       AND NOT EXISTS (SELECT 1 FROM pg_constraint p WHERE p.conrelid = c.oid AND p.contype = 'p')
     ORDER BY 1`);
  return rows.map((r) => `Table ${r.name} has no primary key: add one in a new migration (deduplicate its rows first if needed), or agent.cloud's review files it as no-primary-key.`);
}

export async function capture(db: pg.Client, checks: PreserveCheck[]): Promise<Captured> {
  const wanted = new Set(preserving(checks).map((c) => (c.hold === 'unchanged' ? c.name : c.hold!.slice('equal:'.length))));
  const digests = new Map<string, string | Error>();
  for (const c of checks.filter((x) => wanted.has(x.name))) {
    digests.set(c.name, await readOnly(db, async () => (await db.query(one(digestOf(c.sql)))).rows[0].digest as string).catch((e: Error) => { if (copyStopped(e)) throw e; return e; }));
  }
  // Every user table's primary keys, set aside on the same database; extensions' own tables aren't the app's data.
  const { rows } = await db.query<{ schema: string; table: string; pk: string[] | null; cols: string[] }>(`
    SELECT n.nspname AS schema, c.relname AS "table",
           (SELECT array_agg(a.attname::text ORDER BY array_position(i.indkey::int2[], a.attnum)) FROM pg_index i
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey) WHERE i.indrelid = c.oid AND i.indisprimary) AS pk,
           (SELECT array_agg(a.attname::text || ':' || a.attnum ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS cols
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
       AND NOT (n.nspname = 'public' AND c.relname = 'agentcloud_migrations')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
     ORDER BY 1, 2`);
  const tables: Table[] = [];
  for (const [i, t] of rows.entries()) {
    const rel = `${ident(t.schema)}.${ident(t.table)}`;
    try {
      const n = Number((await db.query(`SELECT count(*) AS n FROM ${rel}`)).rows[0].n);
      let saved: string | null = null;
      if (t.pk?.length && n > 0 && n <= 5_000_000) {
        saved = `pg_temp.agc_keep_${i}`;
        await db.query(`DROP TABLE IF EXISTS ${saved}`);
        await db.query(`CREATE TEMP TABLE agc_keep_${i} AS SELECT ${t.pk.map(ident).join(', ')} FROM ${rel}`);
      }
      tables.push({ schema: t.schema, table: t.table, pk: t.pk ?? [], cols: t.cols, rows: n, saved });
    } catch (e) {
      // A table this role can't read isn't one the app's migrations can change either; anything else stops the proof.
      if ((e as { code?: string }).code !== '42501') throw e;
    }
  }
  const operators = Number((await db.query("SELECT count(*) AS n FROM pg_operator o JOIN pg_namespace n ON n.oid = o.oprnamespace WHERE n.nspname = 'public'")).rows[0].n);
  return { digests, tables, operators };
}

// explain turns a database error into what may be shown: on a rehearsal, never the database's own words. declared:
// what the migrations said they drop or rekey.
export async function verify(db: pg.Client, checks: PreserveCheck[], cap: Captured, explain: (e: Error) => string = (e) => e.message, declared: Declared = { drops: new Set(), rekeys: new Set() }): Promise<PreserveResult[]> {
  const results: PreserveResult[] = [];
  const operators = Number((await db.query("SELECT count(*) AS n FROM pg_operator o JOIN pg_namespace n ON n.oid = o.oprnamespace WHERE n.nspname = 'public'")).rows[0].n);
  for (const c of preserving(checks)) {
    if (operators > cap.operators) { results.push({ name: c.name, kind: 'invariant', ok: false, detail: 'the migrations added operators to public, so this comparison can\u2019t be trusted' }); continue; }
    const ref = c.hold === 'unchanged' ? c.name : c.hold!.slice('equal:'.length);
    const before = cap.digests.get(ref);
    const r = (ok: boolean, detail: string) => results.push({ name: c.name, kind: 'invariant', ok, detail });
    if (before === undefined) { r(false, `hold = "${c.hold}" names no check called "${ref}"`); continue; }
    if (before instanceof Error) {
      if (c.hold === 'unchanged') r(true, `skipped: it couldn't run before the migrations (${explain(before)})`);
      else r(false, `"${ref}" couldn't run before the migrations: ${explain(before)}`);
      continue;
    }
    try {
      const after = await readOnly(db, async () => (await db.query(one(digestOf(c.sql)))).rows[0].digest as string);
      if (after === before) r(true, c.hold === 'unchanged' ? 'the same result before and after the migrations' : `after the migrations it gives exactly what "${ref}" gave before`);
      else r(false, c.hold === 'unchanged' ? 'its result changed across the migrations' : `after the migrations it doesn't match what "${ref}" gave before`);
    } catch (e) {
      if (copyStopped(e)) throw e;
      r(false, `it couldn't run after the migrations: ${explain(e as Error)}`);
    }
  }
  // Rows that existed before must still exist, looked up by the primary key they had. Dropping a table or a column with
  // data, or changing a primary key, loses or hides rows too: it passes only when a migration declares it.
  const lost: string[] = [], undeclared: string[] = [], noted: string[] = [], tooBig: string[] = [];
  let compared = 0;
  for (const t of cap.tables) {
    const name = t.schema === 'public' ? t.table : `${t.schema}.${t.table}`;
    const rel = `${ident(t.schema)}.${ident(t.table)}`;
    const dropsSaid = (what: string) => declared.drops.has(what.toLowerCase());
    const colName = (c: string) => c.slice(0, c.lastIndexOf(':'));
    // A new primary key must be declared, and even then no rows may go: counted, since keys can't be compared.
    const rekeyed = async () => {
      if (!declared.rekeys.has(name.toLowerCase())) { undeclared.push(`new primary key on ${name}`); return; }
      noted.push(`new primary key on ${name}`);
      const after = Number((await db.query(`SELECT count(*) AS n FROM ${rel}`)).rows[0].n);
      if (after < t.rows && !dropsSaid(name)) lost.push(name);
    };
    try {
      // Only a real table counts as still there: a view under the old name is not the old rows.
      const { rows: [now] } = await db.query<{ cols: string[] | null }>(
        `SELECT (SELECT array_agg(a.attname::text || ':' || a.attnum) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS cols
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')`, [t.schema, t.table]);
      if (!now) {
        if (t.rows) (dropsSaid(name) ? noted : undeclared).push(`dropped ${name}`);
        continue;
      }
      const cols = now.cols ?? [];
      for (const c of t.cols.filter((x) => !cols.includes(x))) if (t.rows) (dropsSaid(`${name}.${colName(c)}`) ? noted : undeclared).push(`dropped ${name}.${colName(c)}`);
      if (!t.saved) {
        if (t.rows && !t.pk.length && Number((await db.query(`SELECT count(*) AS n FROM ${rel}`)).rows[0].n) < t.rows) lost.push(name);
        else if (t.rows > 5_000_000) tooBig.push(name);
        else if (t.rows) compared++;
        continue;
      }
      // The keys set aside must still be there: if something dropped them, nothing here can be trusted.
      if (!(await db.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [t.saved])).rows[0].ok) {
        throw new Error('the keys set aside before the migrations were dropped during them');
      }
      // A table is rekeyed only when its key columns are really gone; otherwise its old keys are looked up, compared as
      // text so a key whose type changed (int to text) still finds its rows. A lookup that fails fails the proof.
      if (!t.pk.every((c) => t.cols.some((x) => colName(x) === c && cols.includes(x)))) { await rekeyed(); continue; }
      const key = (alias: string) => `(${t.pk.map((c) => `${alias}.${ident(c)}::text`).join(', ')})`;
      const { rows: [g] } = await db.query<{ gone: boolean }>(`SELECT EXISTS (SELECT 1 FROM ${t.saved} s WHERE NOT EXISTS (SELECT 1 FROM ${rel} x WHERE ${key('x')} = ${key('s')})) AS gone`);
      if (g.gone) lost.push(name);
      else compared++;
    } catch (e) {
      if (copyStopped(e) || (e as Error).message.startsWith('the keys set aside')) throw e;
      throw new Error(`couldn't compare ${name} across the migrations`);
    }
  }
  const name = 'no existing row was deleted';
  const tail = [noted.length ? `declared: ${noted.join(', ')}` : '', tooBig.length ? `too big to compare: ${tooBig.join(', ')}` : ''].filter(Boolean).join('; ');
  if (lost.length || undeclared.length) {
    const what = [lost.length ? `rows that existed before the migrations are gone from ${lost.join(', ')}` : '', undeclared.length ? `undeclared: ${undeclared.join(', ')} (a migration that means it says \`-- agentcloud: drops <table>[.<column>]\` or \`rekeys <table>\`)` : ''].filter(Boolean).join('; ');
    results.push({ name, kind: 'invariant', ok: false, detail: `${what}${tail ? `; ${tail}` : ''}` });
  } else {
    results.push({ name, kind: 'invariant', ok: true, detail: `every row of ${compared} table${compared === 1 ? '' : 's'} with data is still there${tail ? `; ${tail}` : ''}` });
  }
  return results;
}

// RFR-10: after the migrations, each foreign key no index leads with (its columns, in order, among the index's key columns;
// a partial or invalid index never covers every row, so it doesn't count),
// which agent.cloud's review files as unindexed-fk (packages/observability/src/review.ts), as a warning: never a failure.
// agc check asks it of the mirror and control's rehearsal of its copy, both through this file. The app's own tables only,
// as the review reads them; names only, never a row.
export async function unindexedFks(db: pg.Client): Promise<string[]> {
  const { rows } = await db.query<{ table: string; ref: string; cols: string[] }>(`
    SELECT f.conrelid::regclass::text AS "table", f.confrelid::regclass::text AS ref,
      (SELECT array_agg(quote_ident(a.attname) ORDER BY k.ord) FROM unnest(f.conkey) WITH ORDINALITY k(att, ord)
         JOIN pg_attribute a ON a.attrelid = f.conrelid AND a.attnum = k.att) AS cols
    FROM pg_constraint f JOIN pg_class c ON c.oid = f.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE f.contype = 'f' AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'anon', 'neon', 'neon_auth') AND n.nspname NOT LIKE 'pg\\_%'
      AND c.relname NOT LIKE 'agentcloud\\_%'
      AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = f.conrelid AND i.indisvalid AND i.indpred IS NULL AND NOT EXISTS (
        SELECT 1 FROM unnest(f.conkey) WITH ORDINALITY k(att, ord) WHERE k.ord > i.indnkeyatts OR i.indkey[k.ord - 1] IS DISTINCT FROM k.att))
    ORDER BY 1, 3`);
  return rows.map((r) => {
    const cols = r.cols.join(', ');
    return `${r.table}(${cols}) references ${r.ref} with no index on it, so looking rows up by it, and deleting from ${r.ref}, scan all of ${r.table}. Add \`CREATE INDEX ON ${r.table} (${cols});\` in a new migration: agent.cloud's review files this as unindexed-fk (see Foreign keys in \`agc help agents\`).`;
  });
}
