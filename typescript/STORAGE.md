# Uploads in the TypeScript starter

Add `[storage]` to `agentcloud.toml` when your app needs uploads. The starter does not declare storage, create an uploads table, or install upload routes by default. After adapting the examples below, put the SQL in the next available migration file and run `agc migrate`. The contract is in the [Agent Cloud storage spec](https://github.com/summationai/agent-cloud/blob/main/docs/specs/app-storage.md) and this repository's `SPEC.md` STOR rules.

```toml
[storage]
uploads = true
max_object_mb = 25
```

`server/storage.ts` exports `signUpload(key)`, `signDownload(key, mayRead)` and `delete(key)`. Keys are relative to `AGC_STORAGE_PREFIX`. Store the returned key, not the full object path or signed URL. The upload policy gives one fresh key, a size cap, and ten minutes. The download helper checks the app's permission callback before one HEAD and returns either `{ok: true, url}` or `{ok: false, status, error}`. A missing key on a mirror returns `not_on_mirror`; a rehearsal or preview can read its own production file after a 404 when `AGC_STORAGE_FALLBACK_BUCKET` is supplied. Delete touches only the current place, and a key that isn't there is already deleted: it succeeds on every target, including GCS's 404 `NoSuchKey`.

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

The route code goes in `server/app.ts`, after its `body` helper and before the notes routes. Add `import { signDownload, signUpload } from './storage.ts';` to that file. It uses the starter's existing `signedIn`, `pool`, and `body` helpers.

```ts
// STOR-8: Postgres keeps ownership and a relative key. File bytes go straight from the browser to storage.
const UploadIn = z.object({ name: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f/\\]+$/).refine((name) => !name.includes('${')) });
app.post('/api/uploads', body(UploadIn), async (c) => {
  const user = signedIn(c);
  const post = await signUpload(`${user.id}/${c.req.valid('json').name}`);
  await pool.query('INSERT INTO uploads (user_id, storage_key) VALUES ($1, $2)', [user.id, post.key]);
  c.header('Cache-Control', 'no-store');
  return c.json(post, 201);
});
app.get('/api/uploads/download', async (c) => {
  const user = signedIn(c);
  c.header('Cache-Control', 'no-store');
  const key = c.req.query('key') ?? '';
  const { rows } = await pool.query<{ storage_key: string }>(
    'SELECT storage_key FROM uploads WHERE storage_key = $1 AND user_id = $2', [key, user.id]);
  if (!rows[0]) return c.json({ error: { code: 'not_found', message: 'There’s no such file.' } }, 404);
  const result = await signDownload(rows[0].storage_key, () => true);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ url: result.url });
});
```

The owner-filtered query returns 404 for another person's key before calling the storage helper. Both handlers require sign-in and return `Cache-Control: no-store`.

Agent Cloud supplies `AGC_STORAGE_ENDPOINT`, `AGC_STORAGE_REGION`, `AGC_STORAGE_BUCKET`, `AGC_STORAGE_PREFIX`, `AGC_STORAGE_MAX_OBJECT_MB` and, where needed, a GCS HMAC pair. On AWS targets the SDK uses container credentials; the signer refreshes or rejects credentials with fewer than eleven minutes left. The mirror's HTTPS proxy is used for backend storage requests. A rehearsal or preview may receive `AGC_STORAGE_FALLBACK_BUCKET`; `AGC_STORAGE_FALLBACK_PREFIX` optionally names the production path on a customer target. Mirrors never use either fallback.

When `AGC_STORAGE_GATEWAY_URL` is supplied for a customer AWS target, the helper signs against the storage endpoint and replaces only the browser URL base. The encoded path, signed query and POST fields stay untouched. Backend S3 clients continue to use `AGC_STORAGE_ENDPOINT`. Direct browser S3 URLs remain the default. The current Agent Cloud platform spec describes a customer file gateway but does not yet define either the gateway or fallback-prefix environment variable; platform wiring is a separate prerequisite for that target.

Existing apps can copy `server/storage.ts` and the S3 dependencies from this starter release. Keep the app's own authentication, authorization and database schema; copy the example routes and migration only if they fit. Run `npm test` for synthetic storage checks.
