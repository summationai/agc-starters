// Background work: jobs from the `jobs` table, claimed with a lease (AGENTS.md "Background work"). A job a dead worker
// held runs again once its lease lapses, so every job is safe to run twice: emails carry a key that names the message,
// and agent.cloud sends each key once. On SIGTERM the worker finishes the job in hand and exits.
//
// With nothing to do it backs off (10 s, 20 s, 40 s … up to 10 minutes) and holds no database connection between polls,
// so the database can go to sleep. The first email after a quiet spell can take a few minutes: that's the price of not
// paying for an always-awake database.
import pg from 'pg';
import { required } from './env.ts';
import { event, log } from './log.ts';

const { DATABASE_URL, AGC_EMAIL_URL, AGC_EMAIL_TOKEN } = required('DATABASE_URL', 'AGC_EMAIL_URL', 'AGC_EMAIL_TOKEN');
const POLL_S = Number(process.env.WORKER_POLL_SECONDS ?? 10);
const IDLE_MAX_S = Number(process.env.WORKER_IDLE_MAX_SECONDS ?? 600);
interface Job { id: string; kind: string; payload: Record<string, unknown>; attempts: number }

let stopping = false;
let wake: () => void = () => {};

// JOB-4: one connection for one poll or one job, closed right after, so between polls the worker holds none and the
// database can sleep. The web's pool keeps idle connections a minute (DATA-8, db.ts); the worker never uses it.
async function withDb<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 10_000 });
  db.on('error', () => {}); // a dropped connection also fails the query in hand, which main() logs; don't crash on it
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end().catch(() => {});
  }
}

// Each handler gets the job's own connection: use it for the job's reads and writes.
const handlers: Record<string, (job: Job, db: pg.Client) => Promise<void>> = {
  async note_email(job, db) {
    const { rows } = await db.query<{ id: string; title: string; email: string | null }>(
      'SELECT n.id, n.title, u.email FROM notes n JOIN users u ON u.id = n.user_id WHERE n.id = $1', [job.payload.note_id]);
    const note = rows[0];
    if (!note) return; // deleted since: nothing to say
    if (note.email) {
      const res = await fetch(AGC_EMAIL_URL, {
        method: 'POST', signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${AGC_EMAIL_TOKEN}`, 'content-type': 'application/json' },
        // The key names this message for good, so a retried job never emails twice.
        body: JSON.stringify({ to: note.email, subject: `New note: ${note.title}`, text: `You added a note: ${note.title}`, key: `note-${note.id}/created` }),
      });
      if (!res.ok) throw new Error(`the email service answered ${res.status}`);
    }
    event('note.emailed', `note:${note.id}`, { attrs: { sent: Boolean(note.email) } });
  },
};

// Claims one job: due, not done, and not held by a live lease. SKIP LOCKED lets workers claim side by side.
// Each poll opens its own connection and closes it straight after (withDb), so an idle worker holds none between polls.
const claim = (): Promise<Job | null> => withDb(claimWith);

async function claimWith(db: pg.Client): Promise<Job | null> {
  const { rows } = await db.query<Job>(`
    UPDATE jobs SET locked_until = now() + interval '60 seconds', attempts = attempts + 1
     WHERE id = (SELECT id FROM jobs WHERE done_at IS NULL AND run_at <= now() AND (locked_until IS NULL OR locked_until < now())
                 ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING id, kind, payload, attempts`);
  return rows[0] ?? null;
}

async function work(job: Job) {
  try {
    await withDb(async (db) => {
      const handler = handlers[job.kind];
      if (!handler) throw new Error(`no handler for ${job.kind}`);
      await handler(job, db);
      await db.query('UPDATE jobs SET done_at = now(), locked_until = NULL, last_error = NULL WHERE id = $1', [job.id]);
    });
  } catch (e) {
    // Try again later, backing off; the error is kept on the job, not logged with its data.
    const delay = Math.min(2 ** job.attempts, 3600);
    try {
      await withDb((db) => db.query(`UPDATE jobs SET locked_until = NULL, run_at = now() + make_interval(secs => $2), last_error = $3 WHERE id = $1`,
        [job.id, delay, (e as Error).message.slice(0, 500)]));
    } catch (db) {
      // The database is gone too: the job's lease runs out and it's claimed again, so nothing is lost.
      log.warn('couldn\u2019t record a failed job', { job: job.id, error: (db as Error).message });
      return;
    }
    log.warn('job failed', { job: job.id, kind: job.kind, attempts: job.attempts, retry_in_s: delay });
  }
}

async function main() {
  log.info('worker ready');
  let wait = POLL_S;
  while (!stopping) {
    const job = await claim().catch((e) => { log.warn('couldn’t claim a job', { error: (e as Error).message }); return null; });
    if (job) {
      await work(job);
      wait = POLL_S; // busy again: back to the short interval
      continue;
    }
    await new Promise<void>((r) => { const t = setTimeout(r, wait * 1000); wake = () => { clearTimeout(t); r(); }; });
    wait = Math.min(wait * 2, IDLE_MAX_S);
  }
  log.info('worker stopped');
  process.exit(0);
}

process.on('SIGTERM', () => { stopping = true; wake(); });
process.on('SIGINT', () => { stopping = true; wake(); });
void main();
