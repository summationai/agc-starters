"""Background work: jobs from the `jobs` table, claimed with a lease (AGENTS.md "Background work"). A job a dead worker
held runs again once its lease lapses, so every job is safe to run twice: emails carry a key that names the message,
and agent.cloud sends each key once. On SIGTERM the worker finishes the job in hand and exits.

With nothing to do it backs off (10 s, 20 s, 40 s … up to 10 minutes) and holds no database connection between polls, so
the database can go to sleep. A job a request queues doesn't wait for that: the web process runs it just after it
answers (JOB-5, jobs.py), and this loop is its backstop.

When it starts and once a day after, it deletes jobs done over 30 days ago (JOB-6), just before a poll, so that never
wakes the database on its own. Not in a rehearsal (AGC_RUN=rehearsal).

Run: python -m app.worker"""

import logging.config
import os
import signal
import sys
import time

import psycopg

from . import log
from .env import required
from .jobs import CLAIM, PRUNE, connect, work
from .log import LOG_CONFIG

required("AGC_EMAIL_URL", "AGC_EMAIL_TOKEN")  # a missing one stops the worker at once, with its name
POLL_S = float(os.environ.get("WORKER_POLL_SECONDS", "10"))
IDLE_MAX_S = float(os.environ.get("WORKER_IDLE_MAX_SECONDS", "600"))
DAY_S = 86400
stopping = False


def stop(*_: object) -> None:
    global stopping
    stopping = True


def main() -> None:
    logging.config.dictConfig(LOG_CONFIG)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log.info("worker ready")
    wait = POLL_S
    prune_at = time.monotonic()
    while not stopping:
        if time.monotonic() >= prune_at and os.environ.get("AGC_RUN") != "rehearsal":
            prune_at = time.monotonic() + DAY_S
            try:
                with connect() as conn:
                    count = conn.execute(PRUNE).rowcount
                log.info("deleted jobs done over 30 days ago", count=count)
            except psycopg.Error as e:
                log.warn("couldn't delete old done jobs", error=str(e))
        try:
            with connect() as conn:
                job = conn.execute(CLAIM).fetchone()
        except psycopg.Error as e:
            log.warn("couldn't claim a job", error=str(e))
            job = None
        if job:
            work(job)
            wait = POLL_S  # busy again: back to the short interval
            continue
        slept = 0.0
        while not stopping and slept < wait:  # in short steps, so SIGTERM is answered at once
            time.sleep(min(0.25, wait - slept))
            slept += 0.25
        wait = min(wait * 2, IDLE_MAX_S)
    log.info("worker stopped")
    sys.exit(0)


if __name__ == "__main__":
    main()
