// One pool for the process. DATABASE_URL is used exactly as given: it carries sslmode=verify-full, and the driver checks
// the database's certificate against the system's CAs. Never set a host, password or TLS option of your own.
import pg from 'pg';
import { required } from './env.ts';
import { log } from './log.ts';

const { DATABASE_URL } = required('DATABASE_URL');

// DATA-8: idle connections stay about 60 s, here and on a mirror, so a request within a minute of the last reuses one
// instead of opening a new connection: in production that's a new NAT translation and TLS handshake each time, and on a
// mirror (agc up, from a laptop through agc's proxy) about 1.7 s. A quiet app holds none a minute after its last
// request, so its database can still sleep (Neon suspends a compute with no connections after 5 minutes).
export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10, idleTimeoutMillis: 60_000, connectionTimeoutMillis: 10_000 });
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
