// Background work: jobs from the `jobs` table, claimed with a lease (AGENTS.md "Background work"). A job a dead worker
// held runs again once its lease lapses, so every job is safe to run twice: emails carry a key that names the message,
// and agent.cloud sends each key once. On SIGTERM the worker finishes the job in hand and exits.
//
// With nothing to do it backs off (10 s, 20 s, 40 s … up to 10 minutes) and holds no database connection between polls,
// so the database can go to sleep. A job a request queues doesn't wait for that: the web process runs it just after it
// answers (JOB-5, jobs.ts), and this loop is its backstop.
import { required } from './env.ts';
import { claim, work } from './jobs.ts';
import { log } from './log.ts';

required('DATABASE_URL', 'AGC_EMAIL_URL', 'AGC_EMAIL_TOKEN'); // a missing one stops the worker at once, with its name
const POLL_S = Number(process.env.WORKER_POLL_SECONDS ?? 10);
const IDLE_MAX_S = Number(process.env.WORKER_IDLE_MAX_SECONDS ?? 600);

let stopping = false;
let wake: () => void = () => {};

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
