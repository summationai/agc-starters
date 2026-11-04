"""AMCP-3: every /api/* route is a tool, read from FastAPI's own route table. Each APIRoute already says what an agent
needs: its method and path, its docstring (or summary=), and its parameters, which the in-process app.openapi()
describes as JSON Schema (openapi_url stays None, so nothing new is published). A route opts out with a reason:
openapi_extra={"x-mcp-exclude": "<why>"}. One that's neither a tool nor left out is listed as missing."""

import re
from typing import Any, TypedDict

from fastapi import FastAPI
from fastapi.routing import APIRoute


class Tool(TypedDict):
    name: str
    method: str
    path: str  # with :param placeholders, as the TypeScript stack writes it, so both stacks' tools read the same
    route_path: str  # FastAPI's own, with {param}
    summary: str
    readOnly: bool
    destructive: bool
    params: list[str]
    query: list[str]
    body: list[str]
    inputSchema: dict[str, Any]


class Catalog(TypedDict):
    tools: list[Tool]
    excluded: list[dict[str, str]]
    missing: list[dict[str, str]]


METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")
EXCLUDE, NAME, DESTRUCTIVE = "x-mcp-exclude", "x-mcp-name", "x-mcp-destructive"


def _colon(path: str) -> str:
    return re.sub(r"\{([A-Za-z0-9_]+)(:[^}]*)?\}", r":\1", path)


def name_of(method: str, path: str) -> str:
    segments = [f"by_{s[1:]}" if s.startswith(":") else s for s in re.sub(r"^/api/", "", _colon(path)).split("/") if s]
    return re.sub(r"[^a-z0-9_]+", "_", f"{method.lower()}_{'_'.join(segments)}".lower())[:64]


def _resolve(schema: Any, components: dict[str, Any], depth: int = 0) -> Any:
    """The schema with each local $ref inlined and Pydantic's own titles dropped, so it reads like the TypeScript stack's."""
    if depth > 20:
        raise ValueError("a schema that refers to itself")
    if isinstance(schema, list):
        return [_resolve(s, components, depth + 1) for s in schema]
    if not isinstance(schema, dict):
        return schema
    ref = schema.get("$ref")
    if isinstance(ref, str):
        m = re.fullmatch(r"#/components/schemas/(.+)", ref)
        if not m or m[1] not in components:
            raise ValueError(f"an unresolvable $ref: {ref}")
        return _resolve(components[m[1]], components, depth + 1)
    out: dict[str, Any] = {}
    for k, v in schema.items():
        if k == "title" and isinstance(v, str):
            continue
        if k in ("properties", "patternProperties", "$defs") and isinstance(v, dict):
            out[k] = {pk: _resolve(pv, components, depth + 1) for pk, pv in v.items()}
        else:
            out[k] = _resolve(v, components, depth + 1)
    return out


def catalog(app: FastAPI) -> Catalog:
    """The tools, from FastAPI's route table: each /api route once, by method and path."""
    out: Catalog = {"tools": [], "excluded": [], "missing": []}
    seen: set[str] = set()
    spec: dict[str, Any] | None = None
    for r in app.routes:
        path = getattr(r, "path", "")
        if not path.startswith("/api/"):
            continue
        methods = sorted((getattr(r, "methods", None) or set()) & set(METHODS), key=METHODS.index)
        for method in methods:
            key = f"{method} {path}"
            if key in seen:
                continue
            seen.add(key)
            shown = _colon(path)

            def problem(why: str, method: str = method, shown: str = shown) -> None:
                out["missing"].append({"method": method, "path": shown, "why": why})

            if not isinstance(r, APIRoute):
                problem("make it a FastAPI route (@app.get…) so its parameters can be read")
                continue
            extra = r.openapi_extra or {}
            if EXCLUDE in extra:
                reason = extra[EXCLUDE]
                if isinstance(reason, str) and reason.strip():
                    out["excluded"].append({"method": method, "path": shown, "reason": reason})
                else:
                    problem("leaving a route out of the tools takes a reason")
                continue
            summary = (r.summary or r.description or "").strip()
            if not summary:
                problem("give it a docstring or a summary")
                continue
            if not r.include_in_schema:
                problem("its parameters can’t be read: it isn’t in the schema")
                continue
            try:
                spec = spec or app.openapi()
                op = spec["paths"][path][method.lower()]
                components = spec.get("components", {}).get("schemas", {})
                params = [p for p in op.get("parameters", []) if p.get("in") == "path"]
                query = [p for p in op.get("parameters", []) if p.get("in") == "query"]
                body = _resolve(op.get("requestBody", {}).get("content", {}).get("application/json", {}).get("schema", {}), components)
            except (KeyError, ValueError, TypeError):
                problem("its schema can’t be described as JSON Schema")
                continue
            body_props: dict[str, Any] = body.get("properties", {}) if isinstance(body, dict) else {}
            names = [p["name"] for p in params] + [q["name"] for q in query] + list(body_props)
            if len(set(names)) != len(names):
                problem("a name is used twice in its path, query and body")
                continue
            custom = extra.get(NAME)
            name: str = custom if isinstance(custom, str) else name_of(method, path)
            if any(t["name"] == name for t in out["tools"]):
                problem(f"the tool name {name} is taken; give it a name")
                continue
            properties: dict[str, Any] = {p["name"]: {"type": "string"} for p in params}
            properties.update({q["name"]: _resolve(q.get("schema", {}), components) for q in query})
            properties.update(body_props)
            required = [p["name"] for p in params] + [q["name"] for q in query if q.get("required")]
            required += list(body.get("required", [])) if isinstance(body, dict) else []
            out["tools"].append(
                {
                    "name": name,
                    "method": method,
                    "path": shown,
                    "route_path": path,
                    "summary": summary,
                    "readOnly": method == "GET",
                    "destructive": method == "DELETE" or bool(extra.get(DESTRUCTIVE)),
                    "params": [p["name"] for p in params],
                    "query": [q["name"] for q in query],
                    "body": list(body_props),
                    "inputSchema": {"type": "object", "properties": properties, "required": required, "additionalProperties": False},
                }
            )
    return out
