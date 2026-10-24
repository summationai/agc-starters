# Uploads in the TypeScript starter

Add `[storage]` to `agentcloud.toml`, then apply `migrations/0002_uploads.sql` with `agc migrate` before using the example routes. The starter does not declare storage by default. The contract is in the [Agent Cloud storage spec](https://github.com/summationai/agent-cloud/blob/main/docs/specs/app-storage.md) and this repository's `SPEC.md` STOR rules.

```toml
[storage]
uploads = true
max_object_mb = 25
```

`server/storage.ts` exports `signUpload(key)`, `signDownload(key, mayRead)` and `delete(key)`. Keys are relative to `AGC_STORAGE_PREFIX`. Store the returned key, not the full object path or signed URL. The upload policy gives one fresh key, a size cap, and ten minutes. The download helper checks the app's permission callback before one HEAD and returns either `{ok: true, url}` or `{ok: false, status, error}`. A missing key on a mirror returns `not_on_mirror`; a rehearsal or preview can read its own production file after a 404 when `AGC_STORAGE_FALLBACK_BUCKET` is supplied. Delete touches only the current place.

The authenticated `POST /api/uploads` example accepts `{"name":"receipt.pdf"}`, saves the signed-in owner's relative key, and returns `{key, url, fields}`. Send the returned fields and then the file as a browser multipart POST to `url`. `GET /api/uploads/download?key=...` checks the owner row before signing and returns `{url}`. These routes are examples to adapt to the app's own file and authorization model. They never proxy file bytes through the app server.

Agent Cloud supplies `AGC_STORAGE_ENDPOINT`, `AGC_STORAGE_REGION`, `AGC_STORAGE_BUCKET`, `AGC_STORAGE_PREFIX`, `AGC_STORAGE_MAX_OBJECT_MB` and, where needed, a GCS HMAC pair. On AWS targets the SDK uses container credentials; the signer refreshes or rejects credentials with fewer than eleven minutes left. The mirror's HTTPS proxy is used for backend storage requests. A rehearsal or preview may receive `AGC_STORAGE_FALLBACK_BUCKET`; `AGC_STORAGE_FALLBACK_PREFIX` optionally names the production path on a customer target. Mirrors never use either fallback.

When `AGC_STORAGE_GATEWAY_URL` is supplied for a customer AWS target, the helper signs against the storage endpoint and replaces only the browser URL base. The encoded path, signed query and POST fields stay untouched. Backend S3 clients continue to use `AGC_STORAGE_ENDPOINT`. Direct browser S3 URLs remain the default. The current Agent Cloud platform spec describes a customer file gateway but does not yet define either the gateway or fallback-prefix environment variable; platform wiring is a separate prerequisite for that target.

Existing apps can copy `server/storage.ts` and the S3 dependencies from this starter release. Keep the app's own authentication, authorization and database schema; copy the example routes and migration only if they fit. Run `npm test` for synthetic storage and route checks.
