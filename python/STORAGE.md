# Files people upload

Files go to `[storage]`. Postgres holds file keys and ownership, never file bytes.
The contract is [Agent Cloud app storage, STO-2/3/6/11/12/15](https://github.com/summationai/agent-cloud/blob/main/docs/specs/app-storage.md).

## Enable storage

Add this declaration to `agentcloud.toml`:

```toml
[storage]
uploads = true
max_object_mb = 25 # optional, 25 by default, at most 100
```

Run the migration before you use the example routes:

```sh
agc migrate
```

Agent Cloud supplies the configuration. Do not derive a bucket or prefix from an app name.
Apps without `[storage]` can start normally. Only a call to a storage helper requires this configuration.

| Variable | Meaning |
|---|---|
| `AGC_STORAGE_ENDPOINT` | S3-compatible signing origin, such as `https://storage.googleapis.com` or a regional S3 origin |
| `AGC_STORAGE_REGION` | Signing region, including `auto` on GCS |
| `AGC_STORAGE_BUCKET` | This place's bucket |
| `AGC_STORAGE_PREFIX` | This place's prefix, with a final `/`, or an empty string for a whole bucket |
| `AGC_STORAGE_MAX_OBJECT_MB` | Integer from 1 to 100, measured in 1,048,576-byte units |
| `AGC_STORAGE_ACCESS_KEY_ID`, `AGC_STORAGE_SECRET_ACCESS_KEY` | GCS HMAC pair, when supplied |
| `AGC_STORAGE_FALLBACK_BUCKET`, `AGC_STORAGE_FALLBACK_PREFIX` | Read-only production fallback for a preview or rehearsal. The fallback prefix defaults to empty. |
| `AGC_STORAGE_GATEWAY_URL` | Optional browser gateway base, including its app/place/attempt path |

Without the HMAC pair, the helpers use the SDK's default credential chain.
AWS supplies `AWS_CONTAINER_CREDENTIALS_FULL_URI` and `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`, with short-lived credentials and an HTTPS endpoint.
The SDK reads the projected token file. Do not copy the token into app configuration.

The TypeScript helper refreshes cached credentials when fewer than 11 minutes remain.
The Python helper creates a private SDK session for each signing call and reloads the credential chain.
Both refuse temporary credentials with fewer than 11 minutes after refresh.
Neither helper changes a global SDK session or an app's backend S3 client.

## The helpers

TypeScript exports `signUpload(key)` and `signDownload(key)` from `server/storage.ts`.
Python exports the same names from `app/storage.py`.

`signUpload(key)` returns `{key, url, fields}`.
Each call inserts a fresh UUID segment before the filename, so repeated calls do not reuse an object key.
The returned `key` is relative to the place's prefix. The exact POST policy key includes that prefix.
The policy lasts 10 minutes and includes `content-length-range` with the configured file limit.

`signDownload(key)` returns a GET URL valid for 5 minutes.
The helper first sends HEAD to the place's own bucket and prefix.
Only a 404 selects the configured production fallback. A permission error or network error does not select it.
The helper never lists files and never writes to production through the fallback.
Without a fallback, a missing key raises `StorageNotFoundError`. The example returns 404 with the mirror message.

When the gateway variable is present, both helpers sign against the storage endpoint with path-style bucket URLs.
They then replace only that endpoint with the gateway base.
The bucket path, encoded key, signed query, and POST fields stay unchanged.
Applications use the returned URL without provider checks or URL rewriting.

## Authenticated example

`POST /api/uploads` takes `{"name":"receipt.pdf"}` after sign-in.
It stores the returned relative key with the person's user ID in `uploads` and returns the POST form.
The row can exist before the upload finishes. A download still needs the object to exist.
`GET /api/uploads/download?key=...` checks the file row's owner before it calls the helper.
Both routes return `Cache-Control: no-store`. The existing JSON and origin guards protect the upload route.

This browser code works with either starter, GCS, direct S3, or the customer file gateway:

```ts
async function upload(file: File) {
  const response = await fetch('/api/uploads', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name }),
  });
  if (!response.ok) throw new Error('Cannot prepare the upload.');
  const post = await response.json();
  const form = new FormData();
  for (const [name, value] of Object.entries(post.fields)) form.append(name, value as string);
  form.append('file', file); // Last: the gateway reads the policy fields before the file.
  const sent = await fetch(post.url, { method: 'POST', body: form, credentials: 'omit' });
  if (!sent.ok) throw new Error('The upload failed.');
  return post.key;
}

async function download(key: string) {
  const response = await fetch('/api/uploads/download?key=' + encodeURIComponent(key));
  if (!response.ok) throw new Error((await response.json()).error.message);
  window.location.assign((await response.json()).url);
}
```

The browser supplies the multipart Content-Type and Content-Length for the `File` form.
The customer gateway requires a known Content-Length, permits 128 KiB of multipart overhead, and has a 90-second deadline.
It permits at most 16 concurrent transfers per runner. A failed transfer requires a new signed form.
The helper adds no gateway credentials. The signed policy or query carries the authority.

## Existing apps

1. Copy `server/storage.ts` or `app/storage.py` from the same starters release into the corresponding app folder.
2. Install the dependencies listed below.
3. Add `[storage]` to the app manifest.
4. Call the helper from a route after the app's sign-in and file-access checks.
5. Store the returned relative key in the app's existing file table.
6. Pass the URL and form fields unchanged to the browser.

For TypeScript, install the release's pinned dependencies:

```sh
npm install --save-exact @aws-sdk/client-s3@3.1156.0 @aws-sdk/credential-provider-node@3.972.88 @aws-sdk/s3-presigned-post@3.1156.0 @aws-sdk/s3-request-presigner@3.1156.0
```

For Python, install the runtime dependency and type stubs:

```sh
uv add 'boto3==1.43.9'
uv add --dev 'boto3-stubs[s3]==1.43.9'
```

Commit the app's updated lockfile. Copy the example routes only when the app needs them.
If you copy the `uploads` table, use the next unused migration number in that app.
Keep the app's existing authentication, authorization, and file metadata schema.
Existing stored keys remain valid inputs to `signDownload` when they are relative to the configured prefix.
For a new upload, store the returned relative key.
The proposed input key, full prefixed key, and expiring URL cannot replace it.

Backend reads, writes, multipart operations, and credential refresh continue through the app's own S3 SDK client.
That client uses `AGC_STORAGE_ENDPOINT` directly. The browser gateway adapter does not wrap it.
The POST file limit applies only to browser uploads. Backend multipart uploads keep the SDK's standard behavior.

## Verification and release

The starter tests use synthetic S3 and container-credential endpoints. They require no AWS account or infrastructure.
They cover policy limits and signatures, fresh keys, gateway URLs, fallback, authorization, token-file rotation, and refresh beyond one hour.
TypeScript runs them with `npm test`. Python runs them with `uv run pytest`.
Normal CI also runs each starter's types, builds, and conformance checks.

After this PR merges, a maintainer must publish a starters release with `scripts/release.sh`.
Agent Cloud can then update the version and sha256 in `packages/cli/src/starters.ts` in a separate change.
This PR does not publish a release or change that pin.
