"""Agents over MCP (SPEC.md AMCP-1 to AMCP-10): a person's own agent does in this app what they can, after they say yes
once. Every /api route is a tool too (tools.py reads FastAPI's route table); mount(app) adds /mcp, its OAuth and the
/agents pages' API."""

from fastapi import FastAPI

from .agents import mount_agents
from .oauth import mount_oauth
from .server import mount_server

# The paths an agent reaches with no cookie at all. Any origin may call them: they read no session.
COOKIE_FREE = ("/mcp", "/oauth/register", "/oauth/token", "/oauth/revoke")
# OAuth's token and revoke requests are forms by their standard, and read no cookie.
FORM_PATHS = ("/oauth/token", "/oauth/revoke")


def mount(app: FastAPI) -> None:
    mount_oauth(app)
    mount_server(app)
    mount_agents(app)


def exclude(why: str) -> dict[str, str]:
    """openapi_extra for a route that isn't a tool, and why: the reason is shown on the release's receipt."""
    if not why.strip():
        raise ValueError("leaving a route out of the tools takes a reason")
    return {"x-mcp-exclude": why}
