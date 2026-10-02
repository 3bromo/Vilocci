'use strict';
// ============================================================================
// Media-library uploads — POST /api/admin/upload on Supabase Storage
// ----------------------------------------------------------------------------
// `/api/admin/upload` is the admin media library's own endpoint (Admin →
// Website Images, the Homepage CMS hero banner, product images picked from the
// library). It used to write the file to /img/uploads, which a serverless host
// cannot do at all — the filesystem is read-only AND ephemeral, so the endpoint
// could only answer 507 in production.
//
// It now follows the exact order the product/shape image endpoints already use:
//   1. Supabase Storage, PUBLIC bucket `product-images`, prefix `library/`
//   2. /img/uploads when Storage is not configured (local development)
//   3. 507 when Storage is not configured and the disk is read-only
//
// Part A drives lib/storage.js against a stubbed @supabase/supabase-js client —
// no network, no credentials — the same way test/product_image_storage.js does
// for the product gallery and test/shape_storage.js does for the shape bucket.
// Parts B–C drive the REAL server over HTTP (both Storage-configured and not),
// so the endpoint contract itself is asserted, not just the helper.
//
// Usage: npm run test:libraryupload
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const UPLOAD_DIR = path.join(ROOT, 'img', 'uploads');

// A real 1x1 PNG (valid magic bytes — passes the strict upload validation).
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
// A real (tiny) SVG — Storage must refuse it, the disk fallback must accept it.
const SVG_DATA_URL = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
// Deliberately NOT a *.supabase.co host: server.js keeps the ADMIN_DEV_TOKEN
// test hook inert whenever a real Supabase project is configured (devAdminUser),
// and @supabase/supabase-js is stubbed here anyway — so nothing hits a network.
const PROJECT = 'https://testproject.storage.invalid';

const PORT_CONFIGURED = 3499;
const PORT_PLAIN = 3497;
const DEV_TOKEN = 'library-upload-test-token-' + Date.now().toString(36);

let pass = 0; let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓', name); }
  else { fail += 1; console.log('  ✗', name, extra !== undefined ? `→ ${extra}` : ''); }
}
function section(t) { console.log(`\n== ${t} ==`); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// A. lib/storage.js against a stubbed Supabase client
// ---------------------------------------------------------------------------
const calls = [];
let bucketPublic = true;
let bucketExists = true;
let failFirstUpload = false;

function fakeClient() {
  return {
    auth: { getUser: async () => ({ data: null, error: { message: 'stub' } }) },
    storage: {
      createBucket: async (id, opts) => {
        calls.push({ op: 'createBucket', id, opts });
        bucketExists = true;
        return { data: { name: id }, error: null };
      },
      getBucket: async (id) => {
        calls.push({ op: 'getBucket', id });
        if (!bucketExists) return { data: null, error: { message: 'Bucket not found' } };
        return { data: { id, name: id, public: bucketPublic }, error: null };
      },
      updateBucket: async (id, opts) => {
        calls.push({ op: 'updateBucket', id, opts });
        bucketPublic = opts.public === true;
        return { data: { id, public: bucketPublic }, error: null };
      },
      from: (bucket) => ({
        upload: async (objectPath, buffer, opts) => {
          calls.push({ op: 'upload', bucket, objectPath, opts, size: buffer.length });
          if (failFirstUpload) { failFirstUpload = false; bucketExists = false; return { error: { message: 'Bucket not found' } }; }
          return { data: { path: objectPath }, error: null };
        },
        list: async (prefix, opts) => {
          calls.push({ op: 'list', bucket, prefix, opts });
          return { data: [{ name: 'up_a.png' }], error: null };
        },
      }),
    },
  };
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request) {
  if (request === '@supabase/supabase-js') return { createClient: () => fakeClient() };
  return originalLoad.apply(this, arguments);
};

process.env.VITE_SUPABASE_URL = PROJECT;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key-for-tests';

const storage = require(path.join(ROOT, 'lib', 'storage.js'));

// ---------------------------------------------------------------------------
// B/C. The real server over HTTP
// ---------------------------------------------------------------------------
// Preloaded into the Storage-configured child with NODE_OPTIONS=--require, so
// server.js (and lib/storage.js inside it) talks to the stub instead of the
// network. Written to a temp dir — the repository stays clean.
const STUB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libup-')), 'supabase-stub.js');
fs.writeFileSync(STUB_PATH, `
'use strict';
const Module = require('module');
const orig = Module._load;
const PROJECT = ${JSON.stringify(PROJECT)};
Module._load = function (request) {
  if (request === '@supabase/supabase-js') {
    return {
      createClient: () => ({
        auth: { getUser: async () => ({ data: null, error: { message: 'stub' } }) },
        storage: {
          createBucket: async (id) => ({ data: { name: id }, error: null }),
          getBucket: async (id) => ({ data: { id, name: id, public: true }, error: null }),
          updateBucket: async (id) => ({ data: { id, public: true }, error: null }),
          from: (bucket) => ({
            upload: async (objectPath) => {
              process.env.__STUB_UPLOADS = (process.env.__STUB_UPLOADS || '') + bucket + '|' + objectPath + '\\n';
              try { require('fs').appendFileSync(process.env.STUB_LOG, bucket + '|' + objectPath + '\\n'); } catch (e) {}
              return { data: { path: objectPath }, error: null };
            },
          }),
        },
      }),
    };
  }
  return orig.apply(this, arguments);
};
process.env.__STUB_PROJECT = PROJECT;
`);

const STUB_LOG = path.join(path.dirname(STUB_PATH), 'uploads.log');

async function http(base, method, urlPath, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.admin) headers['x-admin-dev-token'] = DEV_TOKEN;
  const res = await fetch(base + urlPath, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') || '';
  let json = null;
  if (type.indexOf('json') >= 0) { try { json = await res.json(); } catch (e) { /* ignore */ } }
  return { ok: res.ok, status: res.status, json };
}

async function waitForServer(child, base) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + '/api/data');
      if (r.ok) return true;
    } catch (e) { /* not up yet */ }
    if (child.exitCode !== null) throw new Error('server exited early: ' + child.exitCode);
    await wait(150);
  }
  return false;
}

function startServer(port, dbFile, opts = {}) {
  const env = Object.assign({}, process.env, {
    PORT: String(port),
    VELOCCI_DB: dbFile,
    DATA_DRIVER: 'json',
    ADMIN_DEV_TOKEN: DEV_TOKEN,
    VITE_SUPABASE_URL: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
    SUPABASE_DB_URL: '', DATABASE_URL: '', POSTGRES_URL: '',
  });
  if (opts.storage) {
    env.VITE_SUPABASE_URL = PROJECT;
    env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key-for-tests';
    env.NODE_OPTIONS = '--require ' + JSON.stringify(STUB_PATH);
    env.STUB_LOG = STUB_LOG;
  } else {
    delete env.NODE_OPTIONS;
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  child.stdout.on('data', () => {});
  return child;
}

(async function main() {
  section('1. The media library uses the PUBLIC product-images bucket under library/');
  check('the library uploads into the public product-images bucket',
    storage.PRODUCT_BUCKET === 'product-images', storage.PRODUCT_BUCKET);
  check('the library prefix is its own, separate from product galleries',
    storage.LIBRARY_PREFIX === 'library' && storage.LIBRARY_PREFIX !== 'products', storage.LIBRARY_PREFIX);
  bucketExists = false;   // first-ever upload on a fresh project
  const up = await storage.uploadLibraryImage(TINY_PNG);
  check('uploading a real PNG succeeds', up.ok === true, JSON.stringify(up));
  const create = calls.find((c) => c.op === 'createBucket');
  check('the bucket is created with public: true',
    !!create && create.id === 'product-images' && create.opts && create.opts.public === true, JSON.stringify(create));
  const put = calls.find((c) => c.op === 'upload');
  check('the file lands in library/up_<unique>.<ext> — never in products/',
    !!put && put.bucket === 'product-images' && /^library\/up_[a-z0-9]+\.png$/.test(put.objectPath)
    && put.opts.upsert === true && put.opts.contentType === 'image/png',
    JSON.stringify(put));
  check('the returned URL is the durable PUBLIC storage URL (not /img/uploads)',
    up.url === `${PROJECT}/storage/v1/object/public/product-images/${put.objectPath}`
    && up.url.indexOf('/img/uploads') < 0, up.url);
  check('the upload reports the stored path, mime and size',
    up.path === put.objectPath && up.mime === 'image/png' && up.size > 0,
    JSON.stringify({ path: up.path, mime: up.mime, size: up.size }));

  section('2. Every library image gets its own object (nothing is overwritten)');
  const second = await storage.uploadLibraryImage(TINY_PNG);
  const puts = calls.filter((c) => c.op === 'upload');
  check('a second upload is stored as a second object',
    second.ok === true && puts.length === 2 && puts[0].objectPath !== puts[1].objectPath,
    JSON.stringify(puts.map((p) => p.objectPath)));
  check('both URLs are different and both are public library URLs',
    second.url !== up.url && second.url.indexOf('/object/public/product-images/library/') >= 0, second.url);

  section('3. A private bucket is flipped to public, a deleted one re-created');
  bucketPublic = false;
  const up2 = await storage.uploadLibraryImage(TINY_PNG);
  const upd = calls.filter((c) => c.op === 'updateBucket').pop();
  check('an existing private bucket is updated to public: true',
    !!upd && upd.id === 'product-images' && upd.opts.public === true, JSON.stringify(upd));
  check('the upload still succeeds after the visibility fix', up2.ok === true, JSON.stringify(up2));
  failFirstUpload = true;
  const up3 = await storage.uploadLibraryImage(TINY_PNG);
  check('the upload recovers when the bucket disappeared', up3.ok === true, JSON.stringify(up3));

  section('4. Validation — only real images reach the bucket');
  let threw = null;
  try { await storage.uploadLibraryImage(SVG_DATA_URL); } catch (e) { threw = e; }
  check('an SVG is refused by Storage (script-bearing formats never reach it)',
    !!threw && threw.code === 'UNSUPPORTED_TYPE', threw && threw.code);
  threw = null;
  try { await storage.uploadLibraryImage('data:image/png;base64,aGVsbG8='); } catch (e) { threw = e; }
  check('a file whose bytes are not a real image is rejected',
    !!threw && threw.code === 'BAD_SIGNATURE', threw && threw.code);
  threw = null;
  try { await storage.uploadLibraryImage('https://example.com/photo.png'); } catch (e) { threw = e; }
  check('a typed URL is not accepted as an uploaded file',
    !!threw && threw.code === 'INVALID_IMAGE', threw && threw.code);

  // -------------------------------------------------------------------------
  section('5. HTTP — /api/admin/upload WITH Storage configured (production path)');
  const dbA = path.join(os.tmpdir(), 'libup-configured-' + Date.now() + '.json');
  const childA = startServer(PORT_CONFIGURED, dbA, { storage: true });
  const baseA = `http://127.0.0.1:${PORT_CONFIGURED}`;
  try {
    check('the Storage-configured server boots', await waitForServer(childA, baseA));

    const res = await http(baseA, 'POST', '/api/admin/upload', { dataUrl: TINY_PNG }, { admin: true });
    check('the upload answers 200', res.status === 200, JSON.stringify(res.json));
    const url = (res.json && res.json.url) || '';
    check('the returned URL is a Supabase Storage public URL, not /img/uploads',
      url.indexOf(`${PROJECT}/storage/v1/object/public/product-images/library/`) === 0, url);
    check('the response says which backend stored it',
      res.json && res.json.storage === 'supabase-storage', JSON.stringify(res.json));
    check('the response keeps the original { ok, url } contract',
      res.json && res.json.ok === true && typeof res.json.url === 'string', JSON.stringify(res.json));
    const logged = fs.existsSync(STUB_LOG) ? fs.readFileSync(STUB_LOG, 'utf8') : '';
    check('the bytes really went to the product-images bucket under library/',
      logged.indexOf('product-images|library/up_') >= 0, JSON.stringify(logged.trim().split('\n').slice(-1)[0]));

    const svg = await http(baseA, 'POST', '/api/admin/upload', { dataUrl: SVG_DATA_URL }, { admin: true });
    check('an SVG is not lost — it falls back to the local disk as before',
      svg.status === 200 && /^\/img\/uploads\/up_[a-z0-9_]+\.svg$/.test((svg.json && svg.json.url) || ''),
      JSON.stringify(svg.json));

    const bad = await http(baseA, 'POST', '/api/admin/upload', { dataUrl: 'https://example.com/x.png' }, { admin: true });
    check('a typed URL is still refused with 400', bad.status === 400, JSON.stringify(bad.json));
    const noAuth = await http(baseA, 'POST', '/api/admin/upload', { dataUrl: TINY_PNG });
    check('the endpoint still requires an admin session', noAuth.status === 401 || noAuth.status === 503, String(noAuth.status));
  } finally {
    childA.kill('SIGKILL');
    try { fs.unlinkSync(dbA); } catch (e) { /* ignore */ }
  }

  section('6. HTTP — /api/admin/upload WITHOUT Storage (local development)');
  const dbB = path.join(os.tmpdir(), 'libup-plain-' + Date.now() + '.json');
  const childB = startServer(PORT_PLAIN, dbB, { storage: false });
  const baseB = `http://127.0.0.1:${PORT_PLAIN}`;
  try {
    check('the unconfigured server boots', await waitForServer(childB, baseB));
    const res = await http(baseB, 'POST', '/api/admin/upload', { dataUrl: TINY_PNG }, { admin: true });
    check('the upload still answers 200 with no Storage configured', res.status === 200, JSON.stringify(res.json));
    check('it falls back to the served /img/uploads path exactly as before',
      /^\/img\/uploads\/up_[a-z0-9_]+\.png$/.test((res.json && res.json.url) || ''), JSON.stringify(res.json));
    check('the response reports the local-disk backend',
      res.json && res.json.storage === 'local-disk', JSON.stringify(res.json));
    const onDisk = fs.existsSync(path.join(UPLOAD_DIR, path.basename((res.json && res.json.url) || '')));
    check('the file is really on disk and served from there', onDisk, res.json && res.json.url);
  } finally {
    childB.kill('SIGKILL');
    try { fs.unlinkSync(dbB); } catch (e) { /* ignore */ }
  }

  console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('library upload storage test crashed:', e); process.exit(1); });
