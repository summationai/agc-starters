# Uploads in the Python starter

Add `[storage]` to `agentcloud.toml` when your app needs uploads. The starter does not declare storage, create an uploads table, or install upload routes by default. After adapting the examples below, put the SQL in the next available migration file and run `agc migrate`. The contract is in the [Agent Cloud storage spec](https://github.com/summationai/agent-cloud/blob/main/docs/specs/app-storage.md) and this repository's `SPEC.md` STOR rules.

```toml
[storage]
uploads = true
max_object_mb = 25
```

`app/storage.py` exports `sign_upload(key)`, `sign_download(key, may_read)` and `delete(key)`. Keys are relative to `AGC_STORAGE_PREFIX`. Store the returned key, not the full object path or signed URL. The upload policy gives one fresh key, a size cap, and ten minutes. The download helper checks the app's permission callback before one HEAD and returns a `Download` with either `url` or an error and status. A missing key on a mirror returns `not_on_mirror`; a rehearsal or preview can read its own production file after a 404 when `AGC_STORAGE_FALLBACK_BUCKET` is supplied. Delete touches only the current place, and a key that isn't there is already deleted: it succeeds on every target, including GCS's 404 `NoSuchKey`.

The authenticated `POST /api/uploads` example accepts `{"name":"receipt.pdf"}`, saves the signed-in owner's relative key, and returns `{key, url, fields}`. Send the returned fields and then the file as a browser multipart POST to `url`. `GET /api/uploads/download?key=...` checks the owner row before signing and returns `{url}`. The following routes and migration are examples to adapt to the app's own file and authorization model. They never proxy file bytes through the app server.

Save this metadata migration under your app's next unused migration number:

```sql
-- STO-3/11: only metadata belongs in Postgres; the browser sends file bytes to storage.
CREATE TABLE uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX uploads_user_id ON uploads(user_id);
```

The route code goes in `app/main.py`, before the notes routes. Add `field_validator` to the existing `pydantic` import and `from .storage import sign_download, sign_upload` to the local imports. It uses the starter's existing `signed_in` and `pool` helpers.

```python
class UploadIn(BaseModel):
    name: Annotated[str, StringConstraints(min_length=1, max_length=200, pattern=r"^[^\x00-\x1f\x7f/\\]+$")]

    @field_validator("name")
    @classmethod
    def no_s3_substitution(cls, name: str) -> str:
        if "${" in name:
            raise ValueError("A file name cannot contain S3 substitution syntax.")
        return name


# STOR-8: Postgres keeps ownership and a relative key. File bytes go straight from the browser to storage.
@app.post("/api/uploads", status_code=201)
def upload(request: Request, body: UploadIn) -> Response:
    user = signed_in(request)
    post = sign_upload(f"{user['id']}/{body.name}")
    with pool.connection() as conn:
        conn.execute("INSERT INTO uploads (user_id, storage_key) VALUES (%s, %s)", (user["id"], post["key"]))
    return JSONResponse(post, 201, headers={"Cache-Control": "no-store"})


@app.get("/api/uploads/download")
def download(request: Request, key: str = "") -> Response:
    user = signed_in(request)
    with pool.connection() as conn:
        row = conn.execute("SELECT storage_key FROM uploads WHERE storage_key = %s AND user_id = %s", (key, user["id"])).fetchone()
    if row is None:
        return JSONResponse(
            {"error": {"code": "not_found", "message": "There’s no such file."}}, 404, headers={"Cache-Control": "no-store"}
        )
    result = sign_download(row["storage_key"], lambda: True)
    if result.error:
        return JSONResponse({"error": result.error}, result.status, headers={"Cache-Control": "no-store"})
    return JSONResponse({"url": result.url}, headers={"Cache-Control": "no-store"})
```

The owner-filtered query returns 404 for another person's key before calling the storage helper. Both handlers require sign-in and return `Cache-Control: no-store`.

Agent Cloud supplies `AGC_STORAGE_ENDPOINT`, `AGC_STORAGE_REGION`, `AGC_STORAGE_BUCKET`, `AGC_STORAGE_PREFIX`, `AGC_STORAGE_MAX_OBJECT_MB` and, where needed, a GCS HMAC pair. On AWS targets the SDK uses container credentials; a private signing session refreshes or rejects credentials with fewer than eleven minutes left. The mirror's HTTPS proxy is used for backend storage requests. A rehearsal or preview may receive `AGC_STORAGE_FALLBACK_BUCKET`; `AGC_STORAGE_FALLBACK_PREFIX` optionally names the production path on a customer target. Mirrors never use either fallback.

When `AGC_STORAGE_GATEWAY_URL` is supplied for a customer AWS target, the helper signs against the storage endpoint and replaces only the browser URL base. The encoded path, signed query and POST fields stay untouched. Backend S3 clients continue to use `AGC_STORAGE_ENDPOINT`. Direct browser S3 URLs remain the default. The current Agent Cloud platform spec describes a customer file gateway but does not yet define either the gateway or fallback-prefix environment variable; platform wiring is a separate prerequisite for that target.

Existing apps can copy `app/storage.py` and the boto3 dependency from this starter release. Keep the app's own authentication, authorization and database schema; copy the example routes and migration only if they fit. Run `uv run pytest` for synthetic storage checks.
