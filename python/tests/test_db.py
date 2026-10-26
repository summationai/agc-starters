"""DATA-8: the pool keeps idle connections 30 s on a mirror (AGENTCLOUD_MIRROR set) and closes them after 1 s everywhere
else. Each case loads app.db in its own process, with that environment, and reads the pool it made. No database is
involved: the pool is made with open=False, so it connects only once the app opens it, and the address below is a fake
nobody answers on."""

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def pool_idle(**env: str) -> float:
    base = {k: v for k, v in os.environ.items() if k not in ("AGENTCLOUD_MIRROR", "AGC_RUN")}
    r = subprocess.run(
        [sys.executable, "-c", "from app.db import pool; print(pool.max_idle)"],
        cwd=ROOT,
        env={**base, "DATABASE_URL": "postgresql://test@127.0.0.1:9/test", **env},
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert r.returncode == 0, r.stderr
    return float(r.stdout.strip())


def test_data_8_on_a_mirror_idle_connections_stay_30_s() -> None:
    # A request seconds after the last one skips a ~1.7 s connect.
    assert pool_idle(AGENTCLOUD_MIRROR="dev") == 30


def test_data_8_in_production_and_rehearsals_idle_connections_close_after_1_s() -> None:
    # So a quiet app's database can sleep.
    assert pool_idle(AGC_RUN="live") == 1
    assert pool_idle(AGC_RUN="rehearsal") == 1
    assert pool_idle(AGENTCLOUD_MIRROR="") == 1, "an empty AGENTCLOUD_MIRROR is no mirror, as for cookies"
