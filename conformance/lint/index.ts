// The static rules (LINT:*): what can be read from the files without running anything.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { lintChecks, readChecks } from '../vendor/agc/checks.ts';
import { secretIn } from '../vendor/agc/github.ts';
import { listMigrations } from '../vendor/agc/migrations.ts';
import { fail, pass, verdict, type TestResult } from '../lib/report.ts';
import type { Stack } from '../lib/stack.ts';

const table = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const read = (s: Stack, f: string) => readFileSync(join(s.dir, f), 'utf8');
const SOURCE = /\.(?:[cm]?[jt]sx?|py)$/;
// The app's own code: what runs, not its tests, build output, migrations or the conformance descriptor.
const sources = (s: Stack) => s.files.filter((f) => SOURCE.test(f) && !/(^|\/)(node_modules|dist|build|\.venv|tests?|__tests__|migrations)\//.test(f) && !/\.(test|spec)\.[^.]+$/.test(f)
  && statSync(join(s.dir, f)).size < 512 * 1024);
const grep = (s: Stack, re: RegExp) => sources(s).filter((f) => re.test(read(s, f)));

// Every CREATE TABLE in the migrations, with its body: enough to check column types and constraints.
function tables(s: Stack): Map<string, string> {
  const sql = listMigrations(join(s.dir, s.app.db.migrations)).map((m) => m.sql).join('\n');
  const out = new Map<string, string>();
  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?(\w+)"?\s*\(([\s\S]*?)\)\s*;/gi)) out.set(m[1]!.toLowerCase(), m[2]!);
  return out;
}
const column = (body: string, name: string) => new RegExp(`(^|[,(\\s])"?${name}"?\\s+([a-z_ ]+?)(\\s|,|$)`, 'im').exec(body)?.[2]?.trim().toLowerCase() ?? null;
const migrationSql = (s: Stack) => listMigrations(join(s.dir, s.app.db.migrations)).map((m) => m.sql).join('\n');

// APP-7, APP-12: both pages are routes of the one bundle: main.tsx sends /notes to Notes and everything else to App.
export function pageRoutes(s: Stack): string[] {
  const problems: string[] = [];
  for (const f of ['web/src/main.tsx', 'web/src/App.tsx', 'web/src/Notes.tsx']) if (!s.files.includes(f)) problems.push(`no ${f}`);
  if (s.files.includes('web/src/main.tsx')) {
    const main = readFileSync(join(s.dir, 'web/src/main.tsx'), 'utf8');
    if (!/['"`]\/notes['"`]/.test(main)) problems.push('main.tsx never routes /notes');
    if (!/\bNotes\b[^;]*from\s+['"]\.\/Notes(\.tsx)?['"]/.test(main)) problems.push('main.tsx doesn\u2019t import Notes from ./Notes.tsx');
    if (!/\bApp\b[^;]*from\s+['"]\.\/App(\.tsx)?['"]/.test(main)) problems.push('main.tsx doesn\u2019t import App from ./App.tsx');
  }
  return problems;
}

export const lint: Record<string, (s: Stack) => TestResult> = {
  'LINT:manifest': (s) => {
    const web = table(table(s.raw.service).web);
    const worker = table(table(s.raw.service).worker);
    const db = table(table(s.raw.data).db);
    const missing = [
      typeof table(s.raw.app).name === 'string' ? '' : '[app] name',
      typeof web.port === 'number' ? '' : '[service.web] port',
      typeof web.dev === 'string' ? '' : '[service.web] dev',
      typeof web.health === 'string' ? '' : '[service.web] health',
      typeof worker.command === 'string' ? '' : '[service.worker] command',
      typeof worker.dev === 'string' ? '' : '[service.worker] dev',
      db.env === 'DATABASE_URL' ? '' : '[data.db] env = "DATABASE_URL"',
      db.migrations === 'migrations/' ? '' : '[data.db] migrations = "migrations/"',
    ].filter(Boolean);
    const command = typeof web.command === 'string';
    const man2 = s.language === 'node' ? verdict(true, command ? 'a production command is set; npm start would also do' : 'no command: the Node image runs npm start')
      : verdict(command, command ? `command = ${String(web.command)}` : 'a Python app must set [service.web] command');
    return (missing.length ? fail : pass)(missing.length ? `missing ${missing.join(', ')}` : 'every key is present', {
      'MAN-1': verdict(!missing.length, missing.length ? `missing ${missing.join(', ')}` : 'every key is present'),
      'MAN-2': man2,
      'MAN-3': verdict(web.health === '/api/health', `health = ${String(web.health)}`),
    });
  },

  'LINT:checks': (s) => {
    const names = listMigrations(join(s.dir, s.app.db.migrations)).map((m) => m.stem);
    const warnings = lintChecks(s.raw, names);
    const { smoke, invariant } = readChecks(s.raw);
    const signsIn = smoke.some((f) => /^SIGN IN\s/.test(f.steps[0]?.trim() ?? ''));
    const races = smoke.some((f) => f.steps.some((l) => /^(POST|PUT|PATCH|DELETE)\s/.test(l.trim()) && /\sx\d+\s*$/.test(l.trim())));
    const notesRace = smoke.some((f) => f.steps.some((l) => /^POST \/api\/notes\b/.test(l.trim()) && /\sx\d+\s*$/.test(l.trim())));
    const notesInvariant = invariant.some((i) => /\bnotes\b/i.test(i.sql) && /having\s+count\(\*\)\s*>\s*1/i.test(i.sql));
    const chk1 = signsIn && invariant.length > 0 && races;
    return (warnings.length || !chk1 ? fail : pass)(warnings.length ? warnings.join('; ') : 'the checks parse with no warnings', {
      'MAN-4': verdict(!warnings.length, warnings.length ? warnings.join('; ') : 'lintChecks has nothing to say'),
      'CHK-1': verdict(chk1, `a flow starting with SIGN IN: ${signsIn}; an invariant: ${invariant.length > 0}; a racing write step: ${races}`),
      'APP-5': verdict(notesRace && notesInvariant, `racing POST /api/notes: ${notesRace}; an invariant on duplicate titles: ${notesInvariant}`),
    });
  },

  'LINT:no-dockerfile': (s) => {
    const found = s.files.filter((f) => /^(Dockerfile|Containerfile)(\..*)?$/i.test(f));
    return found.length ? fail(`${found.join(', ')} would replace agent.cloud's default image`) : pass('no Dockerfile: agent.cloud builds it with its default image');
  },

  'LINT:build-outputs': (s) => {
    const ignore = existsSync(join(s.dir, '.gitignore')) ? read(s, '.gitignore') : '';
    const want = ['node_modules', 'dist', ...(s.language === 'python' ? ['.venv'] : [])];
    const unignored = want.filter((w) => !new RegExp(`^/?${w.replace('.', '\\.')}/?\\s*$`, 'm').test(ignore) && !new RegExp(`(^|/)${w.replace('.', '\\.')}/?\\s*$`, 'm').test(ignore));
    const shipped = s.files.filter((f) => /(^|\/)(node_modules|dist|build|\.venv)\//.test(f));
    return unignored.length || shipped.length
      ? fail([unignored.length ? `.gitignore doesn't list ${unignored.join(', ')}` : '', shipped.length ? `would ship build output: ${shipped.slice(0, 3).join(', ')}` : ''].filter(Boolean).join('; '))
      : pass(`.gitignore lists ${want.join(', ')}, and no build output would ship`);
  },

  'LINT:lockfile': (s) => {
    const need = [...(existsSync(join(s.dir, 'package.json')) ? ['package-lock.json'] : []), ...(s.language === 'python' ? ['uv.lock'] : [])];
    const missing = need.filter((f) => !s.files.includes(f));
    return missing.length ? fail(`${missing.join(', ')} isn't committed`) : pass(`${need.join(' and ')} committed`);
  },

  'LINT:db-config': (s) => {
    const found = grep(s, /rejectUnauthorized\s*:\s*false|sslmode\s*=\s*(disable|allow|prefer|require)\b|\bssl\s*:\s*false|sslrootcert|PGPASSWORD|PGHOST|postgres(ql)?:\/\/[^\s'"`]*@/);
    return found.length ? fail(`sets its own database connection or TLS options in ${found.join(', ')}`) : pass('connects with DATABASE_URL as given');
  },

  'LINT:migrations': (s) => {
    const dir = join(s.dir, s.app.db.migrations);
    const files = s.files.filter((f) => f.startsWith(s.app.db.migrations));
    const misnamed = files.filter((f) => !/^\d+_[a-z0-9_-]+\.sql$/.test(f.slice(s.app.db.migrations.length)));
    const t = tables(s);
    const jobs = t.get('jobs') ?? '';
    const jobColumns = ['id', 'kind', 'payload', 'run_at', 'attempts', 'locked_until', 'done_at', 'last_error'].filter((c) => !column(jobs, c));
    const notes = t.get('notes') ?? '';
    const unique = /unique\s*\(\s*user_id\s*,\s*title\s*\)/i.test(notes) || /create\s+unique\s+index[^;]*\bon\s+(?:public\.)?notes\s*\(\s*user_id\s*,\s*title\s*\)/i.test(migrationSql(s));
    const app1 = column(notes, 'id') === 'uuid' && column(notes, 'user_id') === 'uuid' && /^(text|varchar)/.test(column(notes, 'title') ?? '') && !!column(notes, 'created_at') && unique && column(t.get('users') ?? '', 'id') === 'uuid';
    return {
      outcome: existsSync(dir) && !misnamed.length ? 'pass' : 'fail',
      evidence: existsSync(dir) ? `${files.length} migration files${misnamed.length ? `; misnamed: ${misnamed.join(', ')}` : ''}` : `no ${s.app.db.migrations}`,
      perRule: {
        'DATA-2': verdict(existsSync(dir) && files.length > 0 && !misnamed.length, misnamed.length ? `misnamed: ${misnamed.join(', ')}` : `${files.length} files, each <digits>_<slug>.sql`),
        'JOB-1': verdict(!!jobs && !jobColumns.length, jobs ? (jobColumns.length ? `jobs lacks ${jobColumns.join(', ')}` : 'jobs has every column AGENTS.md lists') : 'no jobs table'),
        'APP-1': verdict(app1, `notes: id ${column(notes, 'id')}, user_id ${column(notes, 'user_id')}, title ${column(notes, 'title')}, unique (user_id, title) ${unique}; users.id ${column(t.get('users') ?? '', 'id')}`),
      },
    };
  },

  'LINT:no-migrator': (s) => {
    const MIGRATORS = /^(prisma|@prisma\/client|drizzle-kit|knex|typeorm|sequelize|sequelize-cli|node-pg-migrate|db-migrate|umzug|alembic|django|yoyo-migrations|flyway|sqlalchemy-migrate)$/i;
    const deps: string[] = [];
    if (existsSync(join(s.dir, 'package.json'))) {
      const p = JSON.parse(read(s, 'package.json')) as Record<string, Record<string, string> | undefined>;
      deps.push(...Object.keys({ ...p.dependencies, ...p.devDependencies }));
    }
    if (existsSync(join(s.dir, 'pyproject.toml'))) {
      const p = table(parse(read(s, 'pyproject.toml')));
      const list = [...((table(p.project).dependencies as string[] | undefined) ?? []), ...Object.values(table(p['dependency-groups'])).flat() as string[]];
      deps.push(...list.map((d) => String(d).split(/[<>=!~\[; ]/)[0]!));
    }
    // Runtime DDL against Postgres is CONF:no-ddl's to prove: a grep can't tell it from DuckDB's in-process
    // `CREATE TABLE … AS SELECT`, or from a comment.
    const migrators = deps.filter((d) => MIGRATORS.test(d));
    return migrators.length ? fail(`depends on ${migrators.join(', ')}`) : pass('no ORM migrator among the dependencies');
  },

  'LINT:uuid-keys': (s) => {
    const t = tables(s);
    const keys = { 'users.id': column(t.get('users') ?? '', 'id'), 'notes.id': column(t.get('notes') ?? '', 'id'), 'notes.user_id': column(t.get('notes') ?? '', 'user_id') };
    const bad = Object.entries(keys).filter(([, v]) => v !== 'uuid');
    return bad.length ? fail(bad.map(([k, v]) => `${k} is ${v ?? 'missing'}`).join(', ')) : pass('users and notes are keyed on uuid columns');
  },

  'LINT:fixed-values': (s) => {
    const loose: string[] = [];
    for (const [name, body] of tables(s)) {
      if (name === 'jobs') continue; // a job's kind is open-ended by design
      for (const col of ['status', 'state', 'kind', 'type', 'role']) {
        const type = column(body, col);
        if (type && /^(text|varchar)/.test(type) && !new RegExp(`check\\s*\\(\\s*"?${col}"?\\s+in\\s*\\(`, 'i').test(body)) loose.push(`${name}.${col}`);
      }
    }
    return loose.length ? fail(`free text where a fixed list fits: ${loose.join(', ')}`) : pass('fixed-value columns use CHECK lists or enums (or there are none)');
  },

  'LINT:no-passwords': (s) => {
    // The same test as agc ship's handRolledPasswords (packages/cli/src/commands/ship.ts).
    const found = grep(s, /\b(?:bcrypt(?:js)?|argon2|scrypt(?:Sync)?|pbkdf2(?:Sync)?)\b/).filter((f) => /password/i.test(read(s, f)));
    return found.length ? fail(`hashes passwords itself in ${found.join(', ')}`) : pass('no password hashing');
  },

  'LINT:secrets': (s) => {
    const found: string[] = [];
    for (const f of s.files) {
      if (/(^|\/)\.env(\.(?!example$|sample$|template$)[^/]*)?$/.test(f)) { found.push(`${f} (an env file)`); continue; }
      const full = join(s.dir, f);
      if (statSync(full).size > 2 * 1024 * 1024) continue;
      const what = secretIn(readFileSync(full));
      if (what) found.push(`${f} (${what})`);
    }
    return found.length ? fail(`secrets in the repo: ${found.join(', ')}`) : pass(`${s.files.length} files, nothing agent.cloud's secret scan would catch`);
  },

  'LINT:no-cors': (s) => {
    const found = grep(s, /Access-Control-Allow-Origin|\bcors\s*\(|CORSMiddleware|from\s+['"](?:cors|hono\/cors)['"]|require\(['"]cors['"]\)/);
    return found.length ? fail(`CORS in ${found.join(', ')}`) : pass('no CORS anywhere');
  },

  'LINT:agents-md': (s) => {
    if (!s.files.includes('AGENTS.md')) return fail('no AGENTS.md');
    const text = read(s, 'AGENTS.md');
    if (text.includes('# agent.cloud: how to work on this app')) return fail('AGENTS.md carries agc\u2019s own section; agc init appends it');
    return text.trim().length > 400 ? pass(`a ${text.split('\n').length}-line stack section`) : fail('AGENTS.md is too short to explain the stack');
  },

  'LINT:descriptor': (s) => {
    const problems: string[] = [];
    if (!existsSync(join(s.dir, 'conformance.toml'))) return fail('no conformance.toml');
    for (const [k, r] of Object.entries(s.descriptor.reload)) {
      if (!r) { problems.push(`[reload.${k}] missing or incomplete`); continue; }
      if (!existsSync(join(s.dir, r.file))) { problems.push(`${r.file} doesn't exist`); continue; }
      const n = read(s, r.file).split(r.find).length - 1;
      if (n !== 1) problems.push(`"${r.find}" occurs ${n} times in ${r.file}`);
      if (k !== 'worker' && !r.url) problems.push(`[reload.${k}] needs a url`);
    }
    if (!s.descriptor.setup) problems.push('[dev] setup is missing');
    return problems.length ? fail(problems.join('; ')) : pass('every reload probe names one exact spot');
  },
  // APP-6: a small seed for mirrors that start empty: declared, present, inserts only (no DDL), into tables the
  // migrations create, every insert ON CONFLICT DO NOTHING, under 200 lines.
  'LINT:seed': (s) => {
    const declared = table(table(s.raw.data).db).seed;
    if (declared !== 'seed.sql') return fail(`[data.db] seed = ${JSON.stringify(declared ?? null)}; the starter declares seed = "seed.sql"`);
    if (!existsSync(join(s.dir, 'seed.sql'))) return fail('seed.sql is declared but missing');
    const sql = read(s, 'seed.sql');
    const lines = sql.split('\n').length;
    const ddl = sql.match(/\b(create|alter|drop|truncate)\s+(table|index|type|schema|function|extension|view|sequence)\b/i);
    const known = tables(s);
    const inserts = [...sql.matchAll(/insert\s+into\s+(?:public\.)?"?(\w+)"?/gi)].map((m) => m[1]!.toLowerCase());
    const unknown = inserts.filter((t) => !known.has(t));
    const statements = sql.split(';').filter((x) => /\S/.test(x.replace(/--[^\n]*/g, '')));
    const insertsWithoutConflict = statements.filter((x) => /insert\s+into/i.test(x) && !/on\s+conflict\s+do\s+nothing/i.test(x)).length;
    const demo = /demo@example\.test/.test(sql) && /Demo Person/.test(sql);
    const problems = [
      lines >= 200 ? `${lines} lines (under 200)` : '',
      ddl ? `DDL in a seed: ${ddl[0]}` : '',
      unknown.length ? `inserts into tables no migration creates: ${unknown.join(', ')}` : '',
      insertsWithoutConflict ? `${insertsWithoutConflict} insert(s) without ON CONFLICT DO NOTHING` : '',
      inserts.length === 0 ? 'no INSERT at all' : '',
      demo ? '' : 'no demo@example.test / Demo Person',
    ].filter(Boolean);
    return (problems.length ? fail : pass)(problems.length ? problems.join('; ') : `${inserts.length} inserts into ${[...new Set(inserts)].join(', ')}, all ON CONFLICT DO NOTHING, ${lines} lines`);
  },

  // APP-7, APP-12: the welcome page and Notes are two routes of the one UI, and neither owns a table or a migration.
  'LINT:app-pages': (s) => {
    const problems = pageRoutes(s);
    const named = listMigrations(join(s.dir, s.app.db.migrations)).filter((m) => /welcome/i.test(m.stem) || /welcome/i.test(m.sql)).map((m) => m.stem);
    if (named.length) problems.push(`migrations name the welcome page: ${named.join(', ')}`);
    return (problems.length ? fail : pass)(problems.length ? problems.join('; ') : 'main.tsx routes /notes to Notes and the rest to App; no migration names the welcome page');
  },
};
