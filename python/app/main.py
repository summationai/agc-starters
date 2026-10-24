"""The app: sign-in, the notes API, health, and in production the built UI (web/dist), all on one port."""

import asyncio
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import urlsplit

import psycopg
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, StringConstraints
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import log
from .auth import router as auth_router
from .auth import signed_in
from .db import pool, tx
from .storage import StorageKeyError, StorageNotFoundError, signDownload, signUpload
from .welcome import welcome as welcome_facts

UI = Path("web/dist")


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    pool.open(wait=False)  # health answers at once; the pool connects in the background
    yield
    pool.close()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


def _ours(request: Request) -> bool:
    """SEC-6: a change comes from this app's own pages. A browser says where a request came from (Origin, or
    Sec-Fetch-Site when it sends no Origin), and agent.cloud isn't a public suffix, so a sibling app's page is
    "same-site" and its requests carry this app's cookies. Anything from another origin is refused; a request with
    neither header (an agent, curl, a server) isn't a browser and passes on to the session check."""
    origin = request.headers.get("origin")
    if origin:
        parsed = urlsplit(origin)
        return bool(parsed.scheme and parsed.netloc) and parsed.netloc == request.headers.get("host", "")
    site = request.headers.get("sec-fetch-site")
    return site in (None, "same-origin", "none")


@app.middleware("http")
async def guard(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
    # Changes need a JSON body. Apps on agent.cloud share a site, so a neighbour's page could post a plain form here
    # with this app's cookies; a JSON body would need a CORS preflight, which this app never grants.
    if request.method not in ("GET", "HEAD", "OPTIONS") and not _ours(request):
        response: Response = JSONResponse(
            {"error": {"code": "cross_origin", "message": "Changes come from this app\u2019s own pages."}}, 403
        )
    elif request.method not in ("GET", "HEAD", "OPTIONS") and not request.headers.get("content-type", "").startswith("application/json"):
        refusal = {"code": "json_required", "message": "Send a JSON body (Content-Type: application/json)."}
        response = JSONResponse({"error": refusal}, 415)
    else:
        try:
            response = await call_next(request)
        except Exception as e:  # noqa: BLE001 - logged once here, with its stack in a field, and answered without it
            route = request.scope.get("route")
            log.error("request failed", exc=e, method=request.method, path=getattr(route, "path", "?"))
            response = JSONResponse({"error": {"code": "internal", "message": "Something went wrong."}}, 500)
    response.headers["X-Content-Type-Options"] = "nosniff"
    if response.headers.get("content-type", "").startswith("text/html"):
        response.headers["Content-Security-Policy"] = "frame-ancestors 'none'"
    return response


# Health answers as soon as the server can serve, without touching the database: agent.cloud asks every 2 seconds.
@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


# The welcome page's facts (SPEC.md APP-8): public like the page, and goes when the welcome page does.
@app.get("/api/welcome")
async def welcome() -> dict[str, Any]:
    return await welcome_facts(os.environ)


app.include_router(auth_router)


@app.get("/api/me")
def me(request: Request) -> dict[str, object]:
    return {"user": signed_in(request)}


@app.get("/api/notes")
def notes(request: Request) -> list[dict[str, object]]:
    user = signed_in(request)
    with pool.connection() as conn:
        rows = conn.execute(
            "SELECT id::text AS id, title, created_at FROM notes WHERE user_id = %s ORDER BY created_at DESC, id DESC LIMIT 100",
            (user["id"],),
        ).fetchall()
    return [{**r, "created_at": r["created_at"].isoformat()} for r in rows]


class NoteIn(BaseModel):
    """A new note's body. FastAPI checks it before add_note runs; one that doesn't fit answers 400 (bad_request below)."""

    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class UploadIn(BaseModel):
    name: Annotated[str, StringConstraints(min_length=1, max_length=200, pattern=r"^[^\x00-\x1f\x7f/\\]+$")]


# STO-11: only keys go in Postgres. A row authorizes its owner; bytes go from the browser to storage.
@app.post("/api/uploads", status_code=201)
def upload(request: Request, body: UploadIn) -> Response:
    user = signed_in(request)
    post = signUpload(f"{user['id']}/{body.name}")
    with pool.connection() as conn:
        conn.execute("INSERT INTO uploads (user_id, storage_key) VALUES (%s, %s)", (user["id"], post["key"]))
    return JSONResponse(post, 201, headers={"Cache-Control": "no-store"})


@app.get("/api/uploads/download")
def download(request: Request, key: str = "") -> Response:
    user = signed_in(request)
    # Authorization comes before HEAD or signing. The browser never selects a bucket, prefix, or URL.
    with pool.connection() as conn:
        row = conn.execute("SELECT storage_key FROM uploads WHERE storage_key = %s AND user_id = %s", (key, user["id"])).fetchone()
    if row is None:
        raise HTTPException(404, "No such file.")
    return JSONResponse({"url": signDownload(row["storage_key"])}, headers={"Cache-Control": "no-store"})


@app.exception_handler(StorageKeyError)
async def storage_key_error(_: Request, error: StorageKeyError) -> Response:
    return JSONResponse({"error": {"code": "bad_request", "message": str(error)}}, 400)


@app.exception_handler(StorageNotFoundError)
async def storage_not_found(_: Request, error: StorageNotFoundError) -> Response:
    return JSONResponse({"error": {"code": "not_found", "message": str(error)}}, 404)


@app.post("/api/notes", status_code=201)
async def add_note(request: Request, body: NoteIn) -> Response:
    user = await asyncio.to_thread(signed_in, request)
    try:
        note = await asyncio.to_thread(_insert_note, user["id"], body.title)
    except psycopg.errors.UniqueViolation:
        return JSONResponse({"error": {"code": "duplicate", "message": "You already have a note with that title."}}, 409)
    log.event("note.created", f"note:{note['id']}", related=[f"user:{user['id']}"])
    return JSONResponse({**note, "created_at": note["created_at"].isoformat()}, 201)


def _insert_note(user_id: str, title: str) -> dict[str, Any]:
    # The note and the job that emails about it are saved together, or not at all.
    with tx() as conn:
        note = conn.execute(
            "INSERT INTO notes (user_id, title) VALUES (%s, %s) RETURNING id::text AS id, title, created_at", (user_id, title)
        ).fetchone()
        assert note is not None
        conn.execute("INSERT INTO jobs (kind, payload) VALUES ('note_email', jsonb_build_object('note_id', %s::text))", (note["id"],))
    return note


# Only for agent.cloud's conformance suite: an error and a slow request, to prove logging and graceful shutdown.
if os.environ.get("AGENTCLOUD_CONFORMANCE") == "1":

    @app.get("/api/debug/error")
    def debug_error() -> None:
        raise RuntimeError("a deliberate failure, for the conformance suite")

    @app.get("/api/debug/slow")
    async def debug_slow(ms: int = 0) -> dict[str, bool]:
        log.info("slow request started")
        await asyncio.sleep(min(ms, 10_000) / 1000)
        return {"ok": True}


@app.exception_handler(StarletteHTTPException)
async def http_error(_: Request, e: StarletteHTTPException) -> Response:
    return JSONResponse({"error": {"code": "http", "message": str(e.detail)}}, e.status_code)


@app.exception_handler(RequestValidationError)
async def bad_request(_: Request, e: RequestValidationError) -> Response:
    # A body that isn't JSON or doesn't fit its model: 400 in this app's error shape, naming the first problem.
    first = next(iter(e.errors()), None)
    if first is None:
        return JSONResponse({"error": {"code": "bad_request", "message": "The request isn't valid."}}, 400)
    field = "" if first["type"] == "json_invalid" else ".".join(str(p) for p in first["loc"][1:])
    return JSONResponse({"error": {"code": "bad_request", "message": f"{field}: {first['msg']}" if field else first["msg"]}}, 400)


# The UI: its built files, and any other path is a page of it (it routes on the client).
if UI.is_dir():
    app.mount("/assets", StaticFiles(directory=UI / "assets"), name="assets")


@app.get("/{path:path}", include_in_schema=False)
def page(path: str) -> Response:
    if path.startswith("api/") or path == "api":
        raise HTTPException(404, "No such API route.")
    file = UI / path
    if path and file.is_file() and UI.resolve() in file.resolve().parents:
        return FileResponse(file)
    if not (UI / "index.html").is_file():
        return JSONResponse({"error": {"code": "no_ui", "message": "The UI isn't built: run npm run build."}}, 404)
    return FileResponse(UI / "index.html", media_type="text/html")
