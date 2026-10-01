'use strict';
// ============================================================================
// Product images — the Supabase Storage path
// ----------------------------------------------------------------------------
// The Admin product editor's "Upload image" button is only really connected if
// the server talks to Supabase Storage: create the PUBLIC `product-images`
// bucket when missing, keep it public, upload the validated bytes under a
// UNIQUE object name (a product gallery holds several photos and an upload can
// happen before the product exists), and return the durable public URL that the
// product row stores in products.images.
//
// This suite drives lib/storage.js against a stubbed @supabase/supabase-js
// client — no network, no credentials — and asserts exactly those calls, the
// same way test/shape_storage.js does for the shape bucket. The end-to-end path
// (HTTP → /api/admin/products/image → product row → /api/data → storefront) is
// covered by test/product_images.js.
//
// Usage: npm run test:productimagestorage
// ============================================================================

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const SVG_DATA_URL = 'data:image/svg+xml;base64,PHN2Zy8+';
const PROJECT = 'https://testproject.supabase.co';

let pass = 0; let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓', name); }
  else { fail += 1; console.log('  ✗', name, extra !== undefined ? `→ ${extra}` : ''); }
}
function section(t) { console.log(`\n== ${t} ==`); }

// ---------------------------------------------------------------------------
// Stub the Supabase client BEFORE lib/storage.js is loaded (it requires the
// package lazily, inside client()).
// ---------------------------------------------------------------------------
const calls = [];
let bucketPublic = true;
let bucketExists = true;
let failFirstUpload = false;

function fakeClient() {
  return {
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
        remove: async (paths) => {
          calls.push({ op: 'remove', bucket, paths });
          return { data: [{ name: paths[0] }], error: null };
        },
        list: async (prefix, opts) => {
          calls.push({ op: 'list', bucket, prefix, opts });
          return { data: [{ name: 'prod_a.png' }], error: null };
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
process.env.VITE_SUPABASE_ANON_KEY = '';

const storage = require(path.join(ROOT, 'lib', 'storage.js'));

(async function main() {
  section('1. The product bucket is created PUBLIC and the URL is the public object URL');
  bucketExists = false;   // first-ever upload on a fresh project
  check('the product bucket is named product-images', storage.PRODUCT_BUCKET === 'product-images', storage.PRODUCT_BUCKET);
  check('the product bucket is NOT the private customize bucket',
    storage.PRODUCT_BUCKET !== storage.BUCKET, `${storage.PRODUCT_BUCKET} vs ${storage.BUCKET}`);
  const up = await storage.uploadProductImage(TINY_PNG, { productId: 'prod_mercedes_case' });
  check('uploading a real PNG succeeds', up.ok === true, JSON.stringify(up));
  const create = calls.find((c) => c.op === 'createBucket');
  check('the bucket is created with public: true', !!create && create.id === 'product-images' && create.opts && create.opts.public === true, JSON.stringify(create));
  const put = calls.find((c) => c.op === 'upload');
  check('the file lands in products/<product id>-<unique>.<ext> with upsert',
    !!put && put.bucket === 'product-images' && /^products\/prod_mercedes_case-[a-z0-9]+\.png$/.test(put.objectPath)
    && put.opts.upsert === true && put.opts.contentType === 'image/png',
    JSON.stringify(put));
  check('the returned URL is the durable PUBLIC storage URL',
    up.url === `${PROJECT}/storage/v1/object/public/product-images/${put.objectPath}`, up.url);
  check('the upload reports the stored path, mime and size',
    up.path === put.objectPath && up.mime === 'image/png' && up.size > 0, JSON.stringify({ path: up.path, mime: up.mime, size: up.size }));

  section('2. A gallery: every photo gets its own object (nothing is overwritten)');
  const second = await storage.uploadProductImage(TINY_PNG, { productId: 'prod_mercedes_case' });
  const puts = calls.filter((c) => c.op === 'upload');
  check('a second photo of the SAME product is stored as a second object',
    second.ok === true && puts.length === 2 && puts[0].objectPath !== puts[1].objectPath,
    JSON.stringify(puts.map((p) => p.objectPath)));
  check('both URLs are different and both are public product-images URLs',
    second.url !== up.url && second.url.indexOf('/object/public/product-images/products/') >= 0, second.url);

  section('3. A brand-new product (no id yet) still uploads');
  const fresh = await storage.uploadProductImage(TINY_PNG, {});
  const freshPut = calls.filter((c) => c.op === 'upload').pop();
  check('an upload without a product id lands under products/new-…',
    fresh.ok === true && /^products\/new-[a-z0-9]+\.png$/.test(freshPut.objectPath), JSON.stringify(freshPut && freshPut.objectPath));
  const weird = await storage.uploadProductImage(TINY_PNG, { productId: '../../etc/passwd' });
  const weirdPut = calls.filter((c) => c.op === 'upload').pop();
  const weirdPath = (weirdPut && weirdPut.objectPath) || '';
  check('a hostile product id cannot escape the products/ folder',
    weird.ok === true && weirdPath.indexOf('products/') === 0
    && weirdPath.slice('products/'.length).indexOf('/') < 0,
    JSON.stringify(weirdPath));

  section('4. A private bucket is flipped to public');
  bucketPublic = false;
  const up2 = await storage.uploadProductImage(TINY_PNG, { productId: 'prod_a' });
  const upd = calls.filter((c) => c.op === 'updateBucket').pop();
  check('an existing private bucket is updated to public: true', !!upd && upd.id === 'product-images' && upd.opts.public === true, JSON.stringify(upd));
  check('the upload still succeeds after the visibility fix', up2.ok === true, JSON.stringify(up2));

  section('5. A deleted bucket is re-created and the upload retried');
  failFirstUpload = true;
  const up3 = await storage.uploadProductImage(TINY_PNG, { productId: 'prod_b' });
  check('the upload recovers when the bucket disappeared', up3.ok === true, JSON.stringify(up3));

  section('6. Validation — only real images reach the bucket');
  let threw = null;
  try { await storage.uploadProductImage(SVG_DATA_URL, { productId: 'prod_a' }); } catch (e) { threw = e; }
  check('an SVG upload is rejected (script-bearing formats never reach storage)', !!threw && threw.code === 'UNSUPPORTED_TYPE', threw && threw.code);
  threw = null;
  try { await storage.uploadProductImage('data:image/png;base64,aGVsbG8=', { productId: 'prod_a' }); } catch (e) { threw = e; }
  check('a file whose bytes are not a real image is rejected', !!threw && threw.code === 'BAD_SIGNATURE', threw && threw.code);
  threw = null;
  try { await storage.uploadProductImage('https://example.com/photo.png', { productId: 'prod_a' }); } catch (e) { threw = e; }
  check('a typed URL is not accepted as an uploaded file', !!threw && threw.code === 'INVALID_IMAGE', threw && threw.code);

  console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('product image storage test crashed:', e); process.exit(1); });
