"""DATA-8: the pool keeps idle connections 60 s, in production and on a mirror (AGENTCLOUD_MIRROR set) alike, holds none
at its minimum and opens at most 10. Each case loads app.db in its own process, with that environment, and reads the pool
it made. No database is involved: the pool is made with open=False, so it connects only once the app opens it, and the
address below is a fake nobody answers on."""

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def pool_of(**env: str) -> dict[str, float]:
    base = {k: v for k, v in os.environ.items() if k not in ("AGENTCLOUD_MIRROR", "AGC_RUN")}
    r = subprocess.run(
        [sys.executable, "-c", "import json; from app.db import pool; print(json.dumps({'idle': pool.max_idle, 'max': pool.max_size, 'min': pool.min_size}))"],
        cwd=ROOT,
        env={**base, "DATABASE_URL": "postgresql://test@127.0.0.1:9/test", **env},
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout.strip())


def test_data_8_idle_connections_stay_60_s_in_production_rehearsals_and_on_a_mirror() -> None:
    # A request within a minute of the last reuses a connection: no new NAT translation and TLS handshake in production,
    # no ~1.7 s connect from a laptop on a mirror.
    want = {"idle": 60, "max": 10, "min": 0}
    assert pool_of(AGC_RUN="live") == want
    assert pool_of(AGC_RUN="rehearsal") == want
    assert pool_of(AGENTCLOUD_MIRROR="dev") == want


def test_data_8_a_quiet_app_holds_no_connection_a_minute_after_its_last_request() -> None:
    # Well inside the 5 minutes after which Neon suspends its database.
    pool = pool_of(AGC_RUN="live")
    assert pool["min"] == 0
    assert pool["idle"] <= 60 < 5 * 60
