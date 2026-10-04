// Uploads the web clip segments + thumbnails (built by scripts/build-web-clips.js) to a
// Cloudflare R2 bucket through R2's S3-compatible API, then points web/clips.json at them.
// No SDK: requests are signed with AWS Signature Version 4 using node:crypto.
//
//   node scripts/upload-r2.js                 upload what is missing, then write web/clips.json
//   node scripts/upload-r2.js --dry-run       show what would happen; uploads nothing
//   node scripts/upload-r2.js --manifest-only only rewrite web/clips.json (e.g. after R2_PUBLIC_URL changed)
//
// Settings come from .env (read automatically):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET   for uploading
//   R2_PUBLIC_URL   public address the browser downloads from (the clips Worker, see web/workers/README.md)
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'tmp', 'web-clips');
const R2_MANIFEST = path.join(OUT_DIR, 'clips.r2.json');
const WEB_MANIFEST = path.join(ROOT, 'web', 'clips.json');
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const CONTENT_TYPES = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const CONCURRENCY = 4;
const ATTEMPTS = 4;

/* ------------------------------------------------------------------ SigV4 */

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
export const EMPTY_SHA256 = sha256Hex('');

/** RFC 3986 encoding as SigV4 wants it (A-Z a-z 0-9 - _ . ~ unescaped). */
function uriEncode(str, keepSlash = false) {
  let out = '';
  for (const byte of Buffer.from(str, 'utf8')) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === '/')) out += c;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export function signingKey(secretAccessKey, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/**
 * Sign a request (S3 style: the path is used as-is, not normalised). `headers` must include
 * everything to be signed; `host` is added from the URL and `x-amz-date` from `date` when absent.
 * Returns { headers (incl. authorization), canonicalRequest, stringToSign, signature }.
 */
export function signRequest({ method, url, headers = {}, payloadHash = EMPTY_SHA256, accessKeyId, secretAccessKey, region, service, date = new Date() }) {
  const u = new URL(url);
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  if (!h.host) h.host = u.host;
  if (!h['x-amz-date']) h['x-amz-date'] = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const amzDate = h['x-amz-date'];
  const dateStamp = amzDate.slice(0, 8);

  const canonicalUri = uriEncode(decodeURIComponent(u.pathname || '/'), true) || '/';
  const canonicalQuery = [...u.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const names = Object.keys(h).sort();
  const canonicalHeaders = names.map((n) => `${n}:${h[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method.toUpperCase(), canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(secretAccessKey, dateStamp, region, service)).update(stringToSign).digest('hex');
  h.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: h, canonicalRequest, stringToSign, signature };
}

/* ------------------------------------------------------------------ R2 client */

function r2Config() {
  const env = (k) => (process.env[k] || '').trim();
  return {
    accountId: env('R2_ACCOUNT_ID'),
    accessKeyId: env('R2_ACCESS_KEY_ID'),
    secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
    bucket: env('R2_BUCKET'),
    publicUrl: env('R2_PUBLIC_URL').replace(/\/+$/, ''),
  };
}

const UPLOAD_VARS = {
  R2_ACCOUNT_ID: 'your Cloudflare account ID (Cloudflare dashboard → R2 → "Account details", 32 hex characters)',
  R2_ACCESS_KEY_ID: 'the "Access Key ID" of an R2 API token (R2 → "Manage API tokens" → Create, permission "Object Read & Write")',
  R2_SECRET_ACCESS_KEY: 'the "Secret Access Key" shown once when you create that token',
  R2_BUCKET: 'the bucket name, e.g. tilawat-clips',
};

async function r2Request(cfg, method, key, { body, contentType } = {}) {
  const url = `https://${cfg.accountId}.r2.cloudflarestorage.com/${uriEncode(cfg.bucket)}/${uriEncode(key, true)}`;
  const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256;
  const headers = { 'x-amz-content-sha256': payloadHash };
  if (body) Object.assign(headers, { 'content-type': contentType, 'cache-control': CACHE_CONTROL });
  const signed = signRequest({ method, url, headers, payloadHash, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: 'auto', service: 's3' });
  const { host, ...sendHeaders } = signed.headers; // fetch sets Host itself
  return fetch(url, { method, headers: sendHeaders, body, signal: AbortSignal.timeout(120000) });
}

async function withRetries(label, fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = !err.httpStatus || err.httpStatus >= 500 || err.httpStatus === 429;
      if (!retryable || attempt >= ATTEMPTS) throw err;
      const wait = 1000 * 2 ** (attempt - 1);
      console.warn(`  ${label}: ${err.message} — retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** Size of the object in the bucket, or null when it does not exist. */
async function remoteSize(cfg, key) {
  return withRetries(`HEAD ${key}`, async () => {
    const res = await r2Request(cfg, 'HEAD', key);
    if (res.status === 404) return null;
    if (!res.ok) throw Object.assign(new Error(`HEAD ${key} → HTTP ${res.status}${res.status === 403 ? ' (check the R2 keys and bucket name)' : ''}`), { httpStatus: res.status });
    return Number(res.headers.get('content-length'));
  });
}

async function putObject(cfg, key, file) {
  const body = await fsp.readFile(file);
  return withRetries(`PUT ${key}`, async () => {
    const res = await r2Request(cfg, 'PUT', key, { body, contentType: CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      throw Object.assign(new Error(`PUT ${key} → HTTP ${res.status} ${text}`), { httpStatus: res.status });
    }
  });
}

/* ------------------------------------------------------------------ main */

function loadR2Manifest() {
  if (!fs.existsSync(R2_MANIFEST)) {
    throw new Error(`${path.relative(ROOT, R2_MANIFEST)} not found — build the clips first:  node scripts/build-web-clips.js`);
  }
  return JSON.parse(fs.readFileSync(R2_MANIFEST, 'utf8'));
}

function filesOf(manifest) {
  const keys = new Set();
  for (const c of manifest.clips) {
    if (c.thumb) keys.add(c.thumb);
    for (const s of c.segments) keys.add(s.url);
  }
  return [...keys].map((key) => {
    const file = path.join(OUT_DIR, ...key.split('/'));
    if (!fs.existsSync(file)) throw new Error(`missing local file ${path.relative(ROOT, file)} — re-run node scripts/build-web-clips.js`);
    return { key, file, size: fs.statSync(file).size };
  });
}

function checkPublicUrl(cfg) {
  if (!cfg.publicUrl) return 'R2_PUBLIC_URL is not set';
  try {
    const u = new URL(cfg.publicUrl);
    if (u.protocol !== 'https:') return 'R2_PUBLIC_URL must start with https://';
  } catch {
    return `R2_PUBLIC_URL is not a valid address ("${cfg.publicUrl}")`;
  }
  return null;
}

async function writeWebManifest(manifest, cfg) {
  const out = { ...manifest, mode: 'r2', base: cfg.publicUrl, generatedAt: new Date().toISOString() };
  await fsp.mkdir(path.dirname(WEB_MANIFEST), { recursive: true });
  await fsp.writeFile(WEB_MANIFEST, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Wrote ${path.relative(ROOT, WEB_MANIFEST)} (r2 mode, ${out.clips.length} clips, base ${cfg.publicUrl}).`);
  // Friendly check that the public address really serves the files.
  const probe = out.clips[0]?.thumb;
    // R2 only adds CORS headers when the request carries an Origin header, as browsers do.
  if (!probe) return;
  try {
    const res = await fetch(`${cfg.publicUrl}/${probe}`, { method: 'HEAD', headers: { Origin: 'https://example.netlify.app' }, signal: AbortSignal.timeout(15000) });
    const cors = res.headers.get('access-control-allow-origin');
    if (res.ok && cors === '*') console.log(`Check: ${cfg.publicUrl}/${probe} → ${res.status}, CORS ok.`);
    else console.warn(`Warning: ${cfg.publicUrl}/${probe} → HTTP ${res.status}${cors === '*' ? '' : ', no "Access-Control-Allow-Origin: *"'}. Browsers may not be able to load the clips yet.`);
  } catch (err) {
    console.warn(`Warning: could not reach ${cfg.publicUrl} (${err.message}).`);
  }
}

async function main(args) {
  try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env */ }
  const dryRun = args.includes('--dry-run');
  const manifestOnly = args.includes('--manifest-only');
  const cfg = r2Config();
  const manifest = loadR2Manifest();

  if (manifestOnly) {
    const problem = checkPublicUrl(cfg);
    if (problem) {
      console.error(`${problem}. Put the address of your clips Worker in .env, e.g.\n  R2_PUBLIC_URL=https://tilawat-clips.<your-name>.workers.dev\n(see web/workers/README.md), then run this again.`);
      return 1;
    }
    if (dryRun) { console.log(`[dry run] would write ${path.relative(ROOT, WEB_MANIFEST)} with base ${cfg.publicUrl}`); return 0; }
    await writeWebManifest(manifest, cfg);
    return 0;
  }

  const files = filesOf(manifest);
  const total = files.reduce((n, f) => n + f.size, 0);
  console.log(`${files.length} files to sync (${(total / 1e6).toFixed(1)} MB) from ${path.relative(ROOT, OUT_DIR)}`);

  const missing = Object.keys(UPLOAD_VARS).filter((k) => !(process.env[k] || '').trim());
  if (missing.length) {
    console.error(`\nCannot ${dryRun ? 'check the bucket' : 'upload'}: ${missing.length === 4 ? 'no R2 settings found' : 'some R2 settings are missing'} in .env.`);
    console.error('Add these lines to the .env file in the project folder:');
    for (const k of missing) console.error(`  ${k}=...   ← ${UPLOAD_VARS[k]}`);
    if (checkPublicUrl(cfg)) console.error('  R2_PUBLIC_URL=...   ← the https:// address of the clips Worker (web/workers/README.md); can be added later');
    console.error('Step-by-step instructions: web/workers/README.md');
    return 1;
  }

  // Which objects are already there with the same size?
  let done = 0;
  let uploaded = 0;
  let skipped = 0;
  let bytesUp = 0;
  const failures = [];
  const queue = [...files];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const f = queue.shift();
      try {
        const size = await remoteSize(cfg, f.key);
        if (size === f.size) skipped++;
        else if (dryRun) { uploaded++; bytesUp += f.size; console.log(`  [dry run] would upload ${f.key} (${(f.size / 1e6).toFixed(2)} MB)${size == null ? '' : ` — bucket has ${size} bytes`}`); }
        else { await putObject(cfg, f.key, f.file); uploaded++; bytesUp += f.size; }
      } catch (err) {
        failures.push(`${f.key}: ${err.message}`);
      }
      done++;
      if (!dryRun && done % 20 === 0) console.log(`  ${done}/${files.length}…`);
    }
  }));
  console.log(`${dryRun ? '[dry run] would upload' : 'Uploaded'} ${uploaded} (${(bytesUp / 1e6).toFixed(1)} MB), already there: ${skipped}, failed: ${failures.length}.`);
  if (failures.length) {
    console.error(failures.slice(0, 10).map((s) => `  ${s}`).join('\n'));
    return 1;
  }

  const problem = checkPublicUrl(cfg);
  if (problem) {
    console.warn(`\n${problem}, so web/clips.json was left unchanged. Deploy the clips Worker (web/workers/README.md),\nput its address in .env as R2_PUBLIC_URL, then run:  node scripts/upload-r2.js --manifest-only`);
    return 0;
  }
  if (dryRun) console.log(`[dry run] would write ${path.relative(ROOT, WEB_MANIFEST)} with base ${cfg.publicUrl}`);
  else await writeWebManifest(manifest, cfg);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
