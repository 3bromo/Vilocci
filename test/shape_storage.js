'use strict';
// ============================================================================
// Shape images — the Supabase Storage path (build 20260919c)
// ----------------------------------------------------------------------------
// The Admin → Shapes upload control is only "connected" if the server really
// talks to Supabase Storage: create the bucket when missing, make sure it is
// PUBLIC, upload the validated bytes with upsert (replace), return the durable
// public URL stored in key_shapes.image_url, and delete the object when the
// image is removed.
//
// This suite drives lib/storage.js against a stubbed @supabase/supabase-js
// client — no network, no credentials — and asserts exactly those calls. The
// real end-to-end path (HTTP → /api/admin/shapes/image → row → /api/data →
// storefront) is covered by test/shape_images.js; the SQL side by
// test/supabase_e2e.js.
//
// Usage: npm run test:shapestorage
// ============================================================================

const path = require('path');
const assert = require('assert');
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
          return { data: [{ name: 'shape_a.png' }, { name: 'shape_b.png' }], error: null };
        },
        createSignedUrl: async (p, ttl) => ({ data: { signedUrl: `${PROJECT}/storage/v1/object/sign/${bucket}/${p}?token=x` }, error: null }),
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
  section('1. The bucket is created PUBLIC and the URL is the public object URL');
  bucketExists = false;   // first-ever upload on a fresh project
  check('the shape bucket is named shape-images', storage.SHAPE_BUCKET === 'shape-images', storage.SHAPE_BUCKET);
  const up = await storage.uploadShapeImage(TINY_PNG, { shapeId: 'shape_b' });
  check('uploading a real PNG succeeds', up.ok === true, JSON.stringify(up));
  const create = calls.find((c) => c.op === 'createBucket');
  check('the bucket is created with public: true', !!create && create.opts && create.opts.public === true, JSON.stringify(create));
  const put = calls.find((c) => c.op === 'upload');
  check('the file lands in shapes/<shape id>.<ext> with upsert (replace)',
    !!put && put.bucket === 'shape-images' && put.objectPath === 'shapes/shape_b.png' && put.opts.upsert === true && put.opts.contentType === 'image/png',
    JSON.stringify(put));
  check('the returned URL is the durable PUBLIC storage URL',
    up.url === `${PROJECT}/storage/v1/object/public/shape-images/shapes/shape_b.png`, up.url);

  section('2. A private bucket is flipped to public');
  bucketPublic = false;
  const up2 = await storage.uploadShapeImage(TINY_PNG, { shapeId: 'shape_a' });
  const upd = calls.filter((c) => c.op === 'updateBucket').pop();
  check('an existing private bucket is updated to public: true', !!upd && upd.opts.public === true, JSON.stringify(upd));
  check('the upload still succeeds after the visibility fix', up2.ok === true, JSON.stringify(up2));

  section('3. A deleted bucket is re-created and the upload retried');
  failFirstUpload = true;
  const up3 = await storage.uploadShapeImage(TINY_PNG, { shapeId: 'shape_c' });
  check('the upload recovers when the bucket disappeared', up3.ok === true, JSON.stringify(up3));

  section('4. Status reporting (what Admin → Shapes shows)');
  const status = await storage.shapeStorageStatus();
  check('status reports the bucket, its visibility and the object count',
    status.configured === true && status.bucket === 'shape-images' && status.exists === true
    && status.public === true && status.objects === 2, JSON.stringify(status));
  check('status exposes the public URL shape the rows store', status.publicUrlExample.indexOf('/storage/v1/object/public/shape-images/') >= 0, status.publicUrlExample);

  section('5. Removal deletes the stored object');
  const rm = await storage.removeShapeImage(`${PROJECT}/storage/v1/object/public/shape-images/shapes/shape_b.png`);
  const removeCall = calls.filter((c) => c.op === 'remove').pop();
  check('the stored file is deleted from the bucket', rm === true && !!removeCall && removeCall.paths[0] === 'shapes/shape_b.png', JSON.stringify(removeCall));
  check('an external/pasted URL has no object to delete', (await storage.removeShapeImage('https://cdn.example/whatever.png')) === false);

  section('6. Validation — only real images reach the bucket');
  let threw = null;
  try { await storage.uploadShapeImage(SVG_DATA_URL, { shapeId: 'shape_a' }); } catch (e) { threw = e; }
  check('an SVG upload is rejected (script-bearing formats never reach storage)', !!threw && threw.code === 'UNSUPPORTED_TYPE', threw && threw.code);
  threw = null;
  try { await storage.uploadShapeImage('data:image/png;base64,aGVsbG8=', { shapeId: 'shape_a' }); } catch (e) { threw = e; }
  check('a file whose bytes are not a real image is rejected', !!threw && threw.code === 'BAD_SIGNATURE', threw && threw.code);

  console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('shape storage test crashed:', e); process.exit(1); });
