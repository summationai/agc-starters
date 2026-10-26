"""One pool for the process. DATABASE_URL is used exactly as given: it carries sslmode=verify-full, and libpq checks the
database's certificate against the system's CAs (agent.cloud sets PGSSLROOTCERT=system). Never set a host, password or
TLS option of your own."""

from collections.abc import Iterator
from contextlib import contextmanager

import psycopg
from psycopg.rows import DictRow, dict_row
from psycopg_pool import ConnectionPool

from .env import ON_MIRROR, required

DATABASE_URL = required("DATABASE_URL")["DATABASE_URL"]

# Opened in the background: the app starts serving (and answering health) even while the database wakes up.
# DATA-8: no connection is kept while idle (min_size 0, idle ones close after a second), so a quiet app's database can
# sleep: Neon suspends a compute with no connections after 5 minutes. In production, reconnecting costs a few
# milliseconds when work arrives. On a mirror (agc up) the app runs on this machine and its database in the cloud,
# behind agc's proxy: from a laptop a new connection costs about 1.7 s and each query about 0.25 s. There idle
# connections stay 30 s, so a request that comes a few seconds after the last one reuses a connection instead of opening one.
pool: ConnectionPool[psycopg.Connection[DictRow]] = ConnectionPool(
    DATABASE_URL, min_size=0, max_size=10, max_idle=30 if ON_MIRROR else 1, open=False, kwargs={"row_factory": dict_row}
)


@contextmanager
def tx() -> Iterator[psycopg.Connection[DictRow]]:
    """Everything written inside lands together, or nothing does."""
    with pool.connection() as conn, conn.transaction():
        yield conn
