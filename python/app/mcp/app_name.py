"""The app's name, from its manifest, read once: what agents see, and the audience of the gate's x-agc-identity (EDGE-15)."""

import tomllib
from pathlib import Path


def _app_name() -> str:
    try:
        return str(tomllib.loads(Path("agentcloud.toml").read_text()).get("app", {}).get("name") or "This app")
    except (OSError, tomllib.TOMLDecodeError):
        return "This app"


APP_NAME = _app_name()
