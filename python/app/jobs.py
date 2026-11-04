"""Background work's jobs, shared by the worker (worker.py) and the web process (JOB-5): the handlers, the lease claim
(JOB-2) and running one job. Every job is safe to run twice: emails carry a key that names the message, and
agent.cloud sends each key once."""

import os
from collections.abc import Callable
from typing import Any

import httpx
import psycopg
from psycopg.rows import DictRow, dict_row

from . import log
from .db import DATABASE_URL


def connect() -> psycopg.Connection[DictRow]:
    """A connection for one poll or one job, closed right after: between polls the worker holds none, so the database
    can sleep. Reconnecting costs a few milliseconds, once per poll."""
    return psycopg.Connection[DictRow].connect(DATABASE_URL, row_factory=dict_row)


def note_email(job: dict[str, Any]) -> None:
    with connect() as conn:
        note = conn.execute(
            "SELECT n.id::text AS id, n.title, u.email FROM notes n JOIN users u ON u.id = n.user_id WHERE n.id = %s",
            (job["payload"]["note_id"],),
        ).fetchone()
    if not note:
        return  # deleted since: nothing to say
    if note["email"]:
        r = httpx.post(
            os.environ["AGC_EMAIL_URL"],
            headers={"authorization": f"Bearer {os.environ['AGC_EMAIL_TOKEN']}"},
            # The key names this message for good, so a retried job never emails twice.
            json={
                "to": note["email"],
                "subject": f"New note: {note['title']}",
                "text": f"You added a note: {note['title']}",
                "key": f"note-{note['id']}/created",
            },
            timeout=15,
        )
        r.raise_for_status()
    log.event("note.emailed", f"note:{note['id']}", attrs={"sent": bool(note["email"])})


HANDLERS: dict[str, Callable[[dict[str, Any]], None]] = {"note_email": note_email}

# Claims one job: due, not done, and not held by a live lease. SKIP LOCKED lets workers claim side by side.
CLAIM = """
UPDATE jobs SET locked_until = now() + interval '60 seconds', attempts = attempts + 1
 WHERE id = (SELECT id FROM jobs WHERE done_at IS NULL AND run_at <= now() AND (locked_until IS NULL OR locked_until < now())
             ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING id, kind, payload, attempts"""


def work(job: dict[str, Any]) -> None:
    try:
        handler = HANDLERS.get(job["kind"])
        if not handler:
            raise RuntimeError(f"no handler for {job['kind']}")
        handler(job)
        with connect() as conn:
            conn.execute("UPDATE jobs SET done_at = now(), locked_until = NULL, last_error = NULL WHERE id = %s", (job["id"],))
    except Exception as e:  # noqa: BLE001 - kept on the job and retried, backing off
        delay = min(2 ** job["attempts"], 3600)
        try:
            with connect() as conn:
                conn.execute(
                    "UPDATE jobs SET locked_until = NULL, run_at = now() + make_interval(secs => %s), last_error = %s WHERE id = %s",
                    (delay, str(e)[:500], job["id"]),
                )
        except psycopg.Error as db:
            # The database is gone too: the job's lease runs out and it's claimed again, so nothing is lost.
            log.warn("couldn't record a failed job", job=job["id"], error=str(db))
            return
        log.warn("job failed", job=job["id"], kind=job["kind"], attempts=job["attempts"], retry_in_s=delay)


# JOB-5: a request's own job, claimed by id with JOB-2's lease, so a worker that took it first keeps it.
CLAIM_ONE = """
UPDATE jobs SET locked_until = now() + interval '60 seconds', attempts = attempts + 1
 WHERE id = %s AND done_at IS NULL AND (locked_until IS NULL OR locked_until < now())
RETURNING id, kind, payload, attempts"""


def run_now(job_id: int) -> None:
    """JOB-5: run a request's own job just after the web process has answered, so it doesn't wait for the worker's next
    poll. One this can't finish (the process stops, or the job fails) stays queued, and the worker runs it at its next
    poll. Nothing runs where the process lacks what the worker has (the email service's address and token)."""
    if not os.environ.get("AGC_EMAIL_URL") or not os.environ.get("AGC_EMAIL_TOKEN"):
        return
    try:
        with connect() as conn:
            job = conn.execute(CLAIM_ONE, (job_id,)).fetchone()
    except psycopg.Error as e:
        log.warn("couldn't claim a request's job; the worker will", job=job_id, error=str(e))
        return
    if job:
        work(job)
