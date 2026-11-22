"""One pool for the process. DATABASE_URL is used exactly as given: it carries sslmode=verify-full, and libpq checks the
database's certificate against the system's CAs (agent.cloud sets PGSSLROOTCERT=system). Never set a host, password or
TLS option of your own."""

from collections.abc import Iterator
from contextlib import contextmanager
from time import monotonic

import psycopg
from psycopg.rows import DictRow, dict_row
from psycopg_pool import ConnectionPool, PoolTimeout

from .env import required

DATABASE_URL = required("DATABASE_URL")["DATABASE_URL"]

# Outside mirror startup the app serves (and answers health) even while the database wakes up.
# DATA-8: idle connections stay about 60 s, here and on a mirror, so a request within a minute of the last reuses one
# instead of opening a new connection: in production that's a new NAT translation and TLS handshake each time, and on a
# mirror (agc up, from a laptop through agc's proxy) about 1.7 s. min_size 0, so a quiet app sheds them all and its database
# can still sleep (Neon suspends a compute 5 minutes after its last connection closes). psycopg_pool closes at most one
# idle connection per max_idle: one or two close within 2 or 3 minutes, and a full pool of 10 within about 11.
pool: ConnectionPool[psycopg.Connection[DictRow]] = ConnectionPool(
    DATABASE_URL, min_size=0, max_size=10, max_idle=60, open=False, kwargs={"row_factory": dict_row}
)


def warm_pool() -> None:
    # DATA-8: on a mirror, normal psycopg_pool growth opens connections one at a time. Resizing queues all opens
    # at once. Hold the checkouts until the pool is warm, then restore its idle minimum so it can drain as before.
    deadline = monotonic() + 10
    clients: list[psycopg.Connection[DictRow]] = []
    pool.resize(pool.max_size)
    try:
        for _ in range(pool.max_size):
            clients.append(pool.getconn(timeout=max(0, deadline - monotonic())))
    except PoolTimeout:
        pass  # use what was ready; unlike pool.wait(), a timeout doesn't close the pool
    finally:
        pool.resize(0, pool.max_size)
        for client in clients:
            pool.putconn(client)


@contextmanager
def tx() -> Iterator[psycopg.Connection[DictRow]]:
    """Everything written inside lands together, or nothing does."""
    with pool.connection() as conn, conn.transaction():
        yield conn
