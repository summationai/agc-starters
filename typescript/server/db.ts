// One pool for the process. DATABASE_URL is used exactly as given: it carries sslmode=verify-full, and the driver checks
// the database's certificate against the system's CAs. Never set a host, password or TLS option of your own.
import pg from 'pg';
import { onMirror, required } from './env.ts';
import { log } from './log.ts';

const { DATABASE_URL } = required('DATABASE_URL');

// DATA-8: idle connections close after a second, so a quiet app holds none and its database can sleep (Neon suspends a
// compute with no connections after 5 minutes). In production, reconnecting costs a few milliseconds when work arrives.
// On a mirror (agc up) the app runs on this machine and its database in the cloud, behind agc's proxy: from a laptop a
// new connection costs about 1.7 s and each query about 0.25 s. There idle connections stay 30 s, so a request that
// comes a few seconds after the last one reuses a connection instead of opening one.
export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10, idleTimeoutMillis: onMirror ? 30_000 : 1_000, connectionTimeoutMillis: 10_000 });
pool.on('error', (e) => log.warn('database connection lost', { error: e.message }));

// Runs `fn` in one transaction: everything it writes lands together, or nothing does.
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
