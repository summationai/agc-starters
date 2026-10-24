// STO-3/11/12: server-side browser signing. Backend S3 clients keep their own SDK credential chain.
import { randomUUID } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const credentials = defaultProvider();
const MIN_LIFETIME_MS = 11 * 60_000;

export class StorageKeyError extends Error {}
export class StorageNotFoundError extends Error {
  constructor() { super("This file isn't on this mirror or was deleted."); }
}

function keyPath(key: string) {
  if (!key || /[\u0000-\u001f\u007f\\]/.test(key) || key.includes('${') || key.split('/').some((p) => !p || p === '.' || p === '..')) {
    throw new StorageKeyError('Use a relative file key without empty or dot path segments.');
  }
  return key;
}

function config() {
  const required = (name: string) => {
    const value = process.env[name];
    if (value === undefined || value === '') throw new Error(`${name} is not set. Add [storage] uploads = true to agentcloud.toml.`);
    return value;
  };
  const base = (value: string) => {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
        url.username || url.password || url.search || url.hash) throw new Error('Storage URLs require HTTPS without credentials, a query, or a fragment.');
    return value.replace(/\/+$/, '');
  };
  const prefix = (value: string) => {
    if (value) {
      if (!value.endsWith('/')) throw new Error('Storage prefixes must end with /.');
      keyPath(value.slice(0, -1));
    }
    return value;
  };
  const endpoint = base(required('AGC_STORAGE_ENDPOINT'));
  if (new URL(endpoint).pathname !== '/') throw new Error('AGC_STORAGE_ENDPOINT must be an origin.');
  const maxMb = Number(required('AGC_STORAGE_MAX_OBJECT_MB'));
  if (!Number.isInteger(maxMb) || maxMb < 1 || maxMb > 100) throw new Error('AGC_STORAGE_MAX_OBJECT_MB must be an integer from 1 to 100.');
  // An empty prefix is valid for production. A missing prefix is a configuration error.
  if (process.env.AGC_STORAGE_PREFIX === undefined) throw new Error('AGC_STORAGE_PREFIX is not set.');
  return {
    endpoint, region: required('AGC_STORAGE_REGION'), bucket: required('AGC_STORAGE_BUCKET'),
    prefix: prefix(process.env.AGC_STORAGE_PREFIX), maxBytes: maxMb * 1_048_576,
    fallbackBucket: process.env.AGC_STORAGE_FALLBACK_BUCKET,
    fallbackPrefix: prefix(process.env.AGC_STORAGE_FALLBACK_PREFIX ?? ''),
    gateway: process.env.AGC_STORAGE_GATEWAY_URL ? base(process.env.AGC_STORAGE_GATEWAY_URL) : undefined,
  };
}

function scoped(prefix: string, key: string) {
  const full = prefix + keyPath(key);
  if (Buffer.byteLength(full) > 1024) throw new StorageKeyError('The file key exceeds 1024 UTF-8 bytes.');
  return full;
}

async function client(c: ReturnType<typeof config>) {
  const id = process.env.AGC_STORAGE_ACCESS_KEY_ID;
  const secret = process.env.AGC_STORAGE_SECRET_ACCESS_KEY;
  if (Boolean(id) !== Boolean(secret)) throw new Error('Set both AGC_STORAGE HMAC keys or neither.');
  let creds = id && secret ? { accessKeyId: id, secretAccessKey: secret } : await credentials();
  if ('expiration' in creds && creds.expiration && creds.expiration.getTime() - Date.now() < MIN_LIFETIME_MS) {
    creds = await credentials({ forceRefresh: true });
  }
  if ('expiration' in creds && creds.expiration && creds.expiration.getTime() - Date.now() < MIN_LIFETIME_MS) {
    throw new Error('Storage credentials have fewer than 11 minutes left after refresh.');
  }
  return new S3Client({ endpoint: c.endpoint, region: c.region, forcePathStyle: true, credentials: creds, maxAttempts: 2 });
}

function browserUrl(url: string, c: ReturnType<typeof config>) {
  if (!url.startsWith(c.endpoint + '/')) throw new Error('The signed storage URL does not match AGC_STORAGE_ENDPOINT.');
  // Do not parse/serialize the signed URL: preserve the encoded path and query byte for byte.
  return c.gateway ? c.gateway + url.slice(c.endpoint.length) : url;
}

/** Sign a fresh key. Store the returned relative key in the app's row, never fields.key or the expiring URL. */
export async function signUpload(key: string) {
  keyPath(key);
  const parts = key.split('/');
  parts.splice(parts.length - 1, 0, randomUUID());
  const freshKey = parts.join('/');
  const c = config();
  const fullKey = scoped(c.prefix, freshKey);
  const s3 = await client(c);
  try {
    const post = await createPresignedPost(s3, {
      Bucket: c.bucket, Key: fullKey, Expires: 600,
      Conditions: [['content-length-range', 0, c.maxBytes]],
    });
    return { key: freshKey, url: browserUrl(post.url, c), fields: post.fields };
  } finally { s3.destroy(); }
}

/** Call only after the app authorizes this person's access to the stored relative key. */
export async function signDownload(key: string): Promise<string> {
  const c = config();
  let bucket = c.bucket;
  let fullKey = scoped(c.prefix, key);
  const s3 = await client(c);
  try {
    try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: fullKey })); }
    catch (e) {
      // AccessDenied, network errors and all other failures must not select production.
      if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw e;
      if (!c.fallbackBucket) throw new StorageNotFoundError();
      bucket = c.fallbackBucket;
      fullKey = scoped(c.fallbackPrefix, key);
    }
  } finally { s3.destroy(); }
  // HEAD can take time. Recheck the lifetime immediately before the browser signature too.
  const signer = await client(c);
  try {
    const url = await getSignedUrl(signer, new GetObjectCommand({ Bucket: bucket, Key: fullKey, ResponseContentDisposition: 'attachment' }), { expiresIn: 300 });
    return browserUrl(url, c);
  } finally { signer.destroy(); }
}
