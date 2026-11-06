// Background work's jobs, shared by the worker (worker.ts) and the web process (JOB-5): the handlers, the lease claim
// (JOB-2) and running one job. Every job is safe to run twice: emails carry a key that names the message, and
// agent.cloud sends each key once.
import pg from 'pg';
import { event, log } from './log.ts';

export interface Job { id: string; kind: string; payload: Record<string, unknown>; attempts: number }

// JOB-4: one connection for one poll or one job, closed right after, so between polls the worker holds none and the
// database can sleep. The web's pool keeps idle connections a minute (DATA-8, db.ts); the worker never uses it.
async function withDb<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 });
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
      const res = await fetch(process.env.AGC_EMAIL_URL!, {
        method: 'POST', signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${process.env.AGC_EMAIL_TOKEN}`, 'content-type': 'application/json' },
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
export const claim = (): Promise<Job | null> => withDb(claimWith);

async function claimWith(db: pg.Client): Promise<Job | null> {
  const { rows } = await db.query<Job>(`
    UPDATE jobs SET locked_until = now() + interval '60 seconds', attempts = attempts + 1
     WHERE id = (SELECT id FROM jobs WHERE done_at IS NULL AND run_at <= now() AND (locked_until IS NULL OR locked_until < now())
                 ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING id, kind, payload, attempts`);
  return rows[0] ?? null;
}

export async function work(job: Job) {
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

// JOB-5: a request's own job, run by the web process just after it has answered, so it doesn't wait for the worker's
// next poll. It's claimed by id with JOB-2's lease, so a worker that took it first keeps it. One this can't finish (the
// process stops, or the job fails) stays queued, and the worker runs it at its next poll. Nothing runs where the
// process lacks what the worker has (the email service's address and token): the worker does it then.
export async function runNow(id: string): Promise<void> {
  if (!process.env.AGC_EMAIL_URL || !process.env.AGC_EMAIL_TOKEN) return;
  let job: Job | null = null;
  try {
    job = await withDb(async (db) => (await db.query<Job>(`
      UPDATE jobs SET locked_until = now() + interval '60 seconds', attempts = attempts + 1
       WHERE id = $1 AND done_at IS NULL AND (locked_until IS NULL OR locked_until < now())
      RETURNING id, kind, payload, attempts`, [id])).rows[0] ?? null);
  } catch (e) {
    log.warn('couldn\u2019t claim a request\u2019s job; the worker will', { job: id, error: (e as Error).message });
    return;
  }
  if (job) await work(job);
}
