// Files people upload, for an app whose agentcloud.toml declares [storage] (agent.cloud's app-storage spec). Nothing
// imports this until the app does: without [storage] there are no AGC_STORAGE_* variables, and nothing here runs.
//
//   const up = await signUpload('receipt.pdf');      // STOR-2: { url, fields, key }; the browser posts the file there,
//                                                    // and the app records `key` in its own table
//   const down = await signDownload(row.key, () => row.user_id === user.id);   // STOR-3: the app's own check comes first
//   await storage.delete(row.key);                   // STOR-4, with `import * as storage from './storage.ts'`
//
// Keys are relative to this place's prefix (AGC_STORAGE_PREFIX), so a row names the same file in every environment.
import { randomUUID } from 'node:crypto';
import { Agent } from 'node:https';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const UPLOAD_SECONDS = 10 * 60; // STOR-2: an upload policy is valid for 10 minutes
const DOWNLOAD_SECONDS = 5 * 60; // STOR-3: a download link for at most 5 minutes
export const NOT_ON_MIRROR = 'This file isn\'t on this mirror';

export type Upload = { url: string; fields: Record<string, string>; key: string };
export type Download =
  | { ok: true; url: string }
  | { ok: false; status: 403 | 404; error: { code: 'forbidden' | 'not_found' | 'not_on_mirror'; message: string } };

function place() {
  const bucket = process.env.AGC_STORAGE_BUCKET;
  if (!bucket) throw new Error('AGC_STORAGE_BUCKET is not set: storage needs [storage] in agentcloud.toml (and `agc up` again on a mirror)');
  return {
    bucket,
    prefix: process.env.AGC_STORAGE_PREFIX ?? '', // production's prefix is empty
    fallback: process.env.AGC_STORAGE_FALLBACK_BUCKET || null, // a rehearsal's or a preview's read-only view of production
    maxBytes: Math.floor(Number(process.env.AGC_STORAGE_MAX_OBJECT_MB || 25) * 1024 * 1024),
  };
}

// STOR-5: one client per configuration. On a mirror, agc up sets HTTPS_PROXY to its egress proxy, the only way out, and
// the AWS SDK ignores it by default, so its HTTPS agent is given the proxy (and NO_PROXY) from the environment.
let cached: { id: string; s3: S3Client } | null = null;
function client(): S3Client {
  const e = process.env;
  const id = [e.AGC_STORAGE_ENDPOINT, e.AGC_STORAGE_REGION, e.AGC_STORAGE_ACCESS_KEY_ID, e.HTTPS_PROXY, e.https_proxy, e.NO_PROXY, e.no_proxy].join('\n');
  if (cached?.id === id) return cached.s3;
  cached?.s3.destroy();
  const s3 = new S3Client({
    region: e.AGC_STORAGE_REGION || 'auto',
    // Path-style URLs: the endpoint's own host is the one the mirror's proxy lets through, never <bucket>.<host>.
    ...(e.AGC_STORAGE_ENDPOINT ? { endpoint: e.AGC_STORAGE_ENDPOINT, forcePathStyle: true } : {}),
    // Keys on a GCP target and on a mirror; on an AWS target, none: the SDK's container credentials find them.
    ...(e.AGC_STORAGE_ACCESS_KEY_ID && e.AGC_STORAGE_SECRET_ACCESS_KEY
      ? { credentials: { accessKeyId: e.AGC_STORAGE_ACCESS_KEY_ID, secretAccessKey: e.AGC_STORAGE_SECRET_ACCESS_KEY } } : {}),
    requestHandler: { httpsAgent: new Agent({ keepAlive: true, proxyEnv: { ...e } }) },
    // GCS's S3 API refuses the checksums newer SDKs add by default; send them only where S3 requires one.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  cached = { id, s3 };
  return s3;
}

// A key is the app's own relative name: no leading slash, no empty, `.` or `..` part, no control characters.
function checked(key: string): string {
  if (typeof key !== 'string' || !key || key.length > 512 || /[\u0000-\u001f\u007f\\]/.test(key)
    || key.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('A storage key is a relative name like "receipts/scan.pdf": no leading slash, no empty, "." or ".." part, at most 512 characters.');
  }
  return key;
}

// STOR-2: a POST policy for one new key under this place's prefix: a fresh uuid goes in front of the name, so no upload
// ever overwrites a file a row already names. The policy caps the size at AGC_STORAGE_MAX_OBJECT_MB and lasts 10 minutes.
export async function signUpload(key: string): Promise<Upload> {
  const name = `${randomUUID()}/${checked(key)}`;
  const { bucket, prefix, maxBytes } = place();
  const { url, fields } = await createPresignedPost(client(), {
    Bucket: bucket,
    Key: prefix + name,
    Conditions: [['content-length-range', 0, maxBytes]],
    Expires: UPLOAD_SECONDS,
  });
  return { url, fields, key: name };
}

// STOR-3: a GET link for at most 5 minutes, signed only once the app's own check says this person may see the file.
// One HEAD asks this place's prefix; a rehearsal or a preview that doesn't hold the key reads production's bucket
// instead, with no second request and never a list. A mirror never does: a key its masked rows name but its own empty
// prefix lacks answers 404 with NOT_ON_MIRROR.
export async function signDownload(key: string, mayRead: () => boolean | Promise<boolean>): Promise<Download> {
  checked(key);
  if (!(await mayRead())) return { ok: false, status: 403, error: { code: 'forbidden', message: 'You can\u2019t see this file.' } };
  const { bucket, prefix, fallback } = place();
  const mirror = Boolean(process.env.AGENTCLOUD_MIRROR);
  const s3 = client();
  let where = { Bucket: bucket, Key: prefix + key };
  if (!(await exists(s3, where))) {
    if (mirror) return { ok: false, status: 404, error: { code: 'not_on_mirror', message: NOT_ON_MIRROR } };
    if (!fallback) return { ok: false, status: 404, error: { code: 'not_found', message: 'There\u2019s no such file.' } };
    where = { Bucket: fallback, Key: key }; // production's prefix is empty
  }
  return { ok: true, url: await getSignedUrl(s3, new GetObjectCommand(where), { expiresIn: DOWNLOAD_SECONDS }) };
}

async function exists(s3: S3Client, where: { Bucket: string; Key: string }): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand(where));
    return true;
  } catch (e) {
    if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
}

// STOR-4: removes one key under this place's prefix, never anything in production's bucket from a rehearsal or a preview.
async function remove(key: string): Promise<void> {
  const { bucket, prefix } = place();
  await client().send(new DeleteObjectCommand({ Bucket: bucket, Key: prefix + checked(key) }));
}
export { remove as delete };
