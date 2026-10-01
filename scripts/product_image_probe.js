#!/usr/bin/env node
/* ==========================================================================
   Product Images — end-to-end production probe.

   Verifies that the Admin product-image picker is really wired on a DEPLOYED
   store (Vercel + Supabase), through the same HTTP endpoints the Admin panel
   uses — WITHOUT touching a single product:

     1. read the server diagnosis    GET  /api/admin/diagnose?products=1
                                     → is Supabase Storage configured, does the
                                       PUBLIC `product-images` bucket exist and
                                       is it public, what are the served
                                       galleries made of
     2. UPLOAD a photo               POST /api/admin/products/image
                                     → Supabase Storage (or the documented
                                       fallback), returns the durable URL
     3. fetch the stored URL         GET  <public storage URL>   → must be 200
                                     and served as an image (this is exactly
                                     what the storefront <img> loads)
     4. UPLOAD a second photo        → a gallery must never overwrite: two
                                     different URLs, both publicly served
     5. read the catalog back        GET  /api/data              → the probe
                                     left every product untouched

   The two uploaded files are NOT attached to any product (an upload happens
   before/independent of Save, exactly like the Admin editor). They are inert;
   delete them in Supabase → Storage → product-images/products/ if you like.

   Authentication is the operator's own admin session: copy the Supabase access
   token the Admin panel uses (`localStorage["velocci_admin_session"]`, or the
   `Authorization: Bearer …` header of any /api/admin/* request in the
   browser's network tab), or pass a dev token for a local server. No credential
   is ever stored by this script.

   Usage:
     node scripts/product_image_probe.js --url https://<deployment> --token <ADMIN_JWT>
     node scripts/product_image_probe.js --url http://localhost:3000 --dev-token <ADMIN_DEV_TOKEN>
   Options:
     --file <path>     upload this image instead of the built-in test card
     --product <id>    also send this product id with the upload (object naming
                       only — the product row is never written)
     --allow-fallback  accept a deployment WITHOUT Supabase Storage (a local
                       JSON store writing to /img/uploads). Off by default: on
                       Vercel that fallback is not durable, so a production
                       probe must fail until Storage is configured.
     --json            machine-readable summary on stdout
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf('--' + name);
  if (i === -1) return dflt;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
const BASE = String(arg('url', process.env.VELOCCI_URL || 'http://localhost:3000')).replace(/\/+$/, '');
const TOKEN = arg('token', process.env.VELOCCI_ADMIN_TOKEN || '');
const DEV_TOKEN = arg('dev-token', process.env.ADMIN_DEV_TOKEN || '');
const FILE = typeof arg('file', '') === 'string' ? arg('file', '') : '';
const PRODUCT = typeof arg('product', '') === 'string' ? String(arg('product', '')) : '';
const ALLOW_FALLBACK = !!arg('allow-fallback', false);
const AS_JSON = !!arg('json', false);

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  if (!AS_JSON) {
    console.log(`  ${ok ? '\u2713' : '\u2717'} ${name}${detail !== undefined && detail !== '' ? `  (${detail})` : ''}`);
  }
  return !!ok;
}
function note(msg) { if (!AS_JSON) console.log(`    · ${msg}`); }
function finish(code) {
  if (AS_JSON) {
    console.log(JSON.stringify({ target: BASE, checks, ok: checks.every((c) => c.ok) }, null, 2));
  } else {
    const bad = checks.filter((c) => !c.ok);
    console.log(`\n${bad.length ? `\u2717 ${bad.length} of ${checks.length} checks FAILED` : `\u2713 all ${checks.length} checks passed`}`);
    if (bad.length) {
      console.log('\nWhat to do:');
      console.log('  · "productImages block" missing      → the deployment predates this feature: redeploy the branch.');
      console.log('  · Storage not configured             → set VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in Vercel, then REDEPLOY.');
      console.log('  · bucket missing / not public        → run supabase/migrations/010_product_images.sql (or create a PUBLIC `product-images` bucket).');
      console.log('  · stored URL not served              → the bucket is private: make it public, otherwise the storefront cannot render it.');
      console.log('  · upload refused 401/403             → the token is not an admin session (public.admin_users).');
      console.log('  See docs/PRODUCT-IMAGE-UPLOADS.md for the full checklist.');
    }
  }
  process.exit(code);
}

function headers(extra) {
  const h = Object.assign({ 'content-type': 'application/json' }, extra || {});
  if (DEV_TOKEN && DEV_TOKEN !== true) h['x-admin-dev-token'] = String(DEV_TOKEN);
  else if (TOKEN && TOKEN !== true) h.authorization = `Bearer ${String(TOKEN)}`;
  return h;
}
async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text };
}

// --------------------------------------------------------------------------
// A real PNG built here (zlib + CRC), so the probe needs no asset file.
// Two visibly different cards, so a human can spot them in the bucket.
// --------------------------------------------------------------------------
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function testPng(variant) {
  const W = 200, H = 200;
  const cream = [246, 241, 231];
  const ink = [30, 30, 30];
  const accent = variant === 2 ? [23, 48, 92] : [201, 168, 76];   // navy / champagne
  const rows = [];
  const cx = W / 2, cy = H / 2, r = 62;
  for (let y = 0; y < H; y++) {
    const row = Buffer.alloc(1 + W * 3);
    row[0] = 0;                                                   // filter: none
    for (let x = 0; x < W; x++) {
      let px = cream;
      const border = x < 5 || y < 5 || x >= W - 5 || y >= H - 5;
      const inShape = variant === 2
        ? (Math.abs(x - cx) < r * 0.78 && Math.abs(y - cy) < r * 0.78)
        : ((x - cx) * (x - cx) + (y - cy) * (y - cy) < r * r);
      if (border) px = ink;
      else if (inShape) px = accent;
      const o = 1 + x * 3;
      row[o] = px[0]; row[o + 1] = px[1]; row[o + 2] = px[2];
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function dataUrlFor(variant) {
  if (FILE && variant === 1) {
    const p = path.resolve(String(FILE));
    const buf = fs.readFileSync(p);
    const ext = path.extname(p).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp'
      : ext === '.avif' ? 'image/avif' : 'image/jpeg';
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, bytes: buf.length, label: `${ext || 'image'} file ${p}` };
  }
  const buf = testPng(variant);
  return { dataUrl: `data:image/png;base64,${buf.toString('base64')}`, bytes: buf.length, label: `built-in test card #${variant} (${buf.length} B)` };
}

// Fetches a stored URL the way the storefront <img> does.
async function checkServed(url, label) {
  if (/^data:/.test(url)) {
    check(`${label} is a servable image`, true, 'inline data URL (no Supabase Storage on this host)');
    return true;
  }
  const absolute = /^https?:\/\//i.test(url) ? url : BASE + url;
  try {
    const res = await fetch(absolute, { method: 'GET' });
    const ct = res.headers.get('content-type') || '';
    check(`${label} answers 200`, res.status === 200, `HTTP ${res.status} ${absolute.slice(0, 100)}`);
    check(`${label} is served as an image`, /^image\//i.test(ct), ct || '(no content-type)');
    return res.status === 200;
  } catch (e) {
    check(`${label} answers 200`, false, e.message);
    return false;
  }
}

async function main() {
  const auth = DEV_TOKEN && DEV_TOKEN !== true ? 'dev token' : TOKEN && TOKEN !== true ? 'admin session token' : 'NONE';
  if (!AS_JSON) {
    console.log('Product Images end-to-end probe');
    console.log(`  target: ${BASE}`);
    console.log(`  auth:   ${auth}`);
    if (ALLOW_FALLBACK) console.log('  mode:   --allow-fallback (a deployment without Supabase Storage is accepted)');
    console.log('');
  }
  if (auth === 'NONE') {
    check('an admin credential was supplied (--token/--dev-token)', false, 'nothing to authenticate with');
    finish(2);
  }

  // 1 — what the deployed app reports about product images ------------------
  if (!AS_JSON) console.log('1. deployed app diagnosis (/api/admin/diagnose?products=1)');
  let diag;
  try {
    const r = await req('GET', `${BASE}/api/admin/diagnose?products=1`);
    diag = r.json;
    if (!check('diagnose answered with JSON', r.status === 200 && !!diag, `HTTP ${r.status}`)) finish(1);
  } catch (e) {
    check('diagnose reachable', false, e.message);
    finish(1);
  }
  const pi = diag.productImages || null;
  if (!check('the deployment reports the productImages block (this build is deployed)', !!pi, pi ? '' : 'old deployment?')) finish(1);
  const st = pi.storage || {};
  const storageBacked = st.configured !== false;
  check('the product-image endpoint is wired', pi.endpoint === 'POST /api/admin/products/image', String(pi.endpoint));
  check('no table migration is needed (products.images already exists)', /no table change/i.test(String(pi.schema)), String(pi.schema));
  if (storageBacked) {
    check('Supabase Storage is configured (VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)', true, `bucket=${st.bucket}`);
    check(`the ${st.bucket} bucket exists`, !!st.exists, st.error || `objects=${st.objects}`);
    check(`the ${st.bucket} bucket is PUBLIC (otherwise the storefront cannot render the URL)`, !!st.public, `public=${st.public}`);
    if (st.objects != null) note(`${st.objects} object(s) already stored under products/`);
  } else {
    const msg = 'Supabase Storage is configured (VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)';
    if (ALLOW_FALLBACK) {
      check(msg + ' [not required: --allow-fallback]', true, 'local JSON store — the /img/uploads fallback is durable here');
    } else {
      check(msg, false, st.error || 'not configured');
    }
    note('uploads will fall back to /img/uploads (writable host) or to a small inline data URL (read-only host such as Vercel)');
    note('that fallback is NOT durable on Vercel: set the two variables above and redeploy (or re-run with --allow-fallback for a local JSON server)');
  }
  if (!AS_JSON) {
    console.log(`    · served galleries: ${pi.imageCount} image(s) on ${pi.productsWithImage}/${pi.productCount} product(s)`);
    console.log(`      from Storage ${pi.uploadedFromStorage} · generated artwork ${pi.generatedArtwork} · /img/uploads ${pi.localUploads} · inline ${pi.inlineDataUrls} · external ${pi.externalUrls}`);
  }

  // 2 — UPLOAD a photo (the exact call the Admin editor makes) --------------
  const first = dataUrlFor(1);
  if (!AS_JSON) console.log(`\n2. upload a picked photo (${first.label})`);
  const body1 = { dataUrl: first.dataUrl };
  if (PRODUCT) body1.productId = PRODUCT;
  const up1 = await req('POST', `${BASE}/api/admin/products/image`, body1);
  if (!check('upload accepted', up1.status === 200 && up1.json && up1.json.url,
    `HTTP ${up1.status}${up1.json && up1.json.error ? ' — ' + up1.json.error : ''}`)) finish(1);
  const url1 = up1.json.url;
  note(`stored via ${up1.json.storage}: ${String(url1).slice(0, 120)}${String(url1).length > 120 ? '…' : ''}`);
  if (storageBacked) {
    check('the photo really landed in Supabase Storage (not a fallback)', up1.json.storage === 'supabase-storage', String(up1.json.storage));
    check('the stored URL is the durable public product-images URL',
      url1.indexOf(`/storage/v1/object/public/${st.bucket || 'product-images'}/products/`) >= 0, String(url1).slice(0, 120));
  } else {
    check('the fallback stored a servable image', up1.json.storage === 'local-disk' || up1.json.storage === 'inline-data-url', String(up1.json.storage));
  }

  // 3 — the stored URL is what the storefront <img> loads -------------------
  if (!AS_JSON) console.log('3. fetch the stored URL (what the storefront gallery loads)');
  await checkServed(url1, 'the stored URL');

  // 4 — a gallery: the second photo must not overwrite the first ------------
  const second = dataUrlFor(2);
  if (!AS_JSON) console.log(`\n4. upload a second photo (${second.label})`);
  const up2 = await req('POST', `${BASE}/api/admin/products/image`, Object.assign({ dataUrl: second.dataUrl }, PRODUCT ? { productId: PRODUCT } : {}));
  if (!check('second upload accepted', up2.status === 200 && up2.json && up2.json.url, `HTTP ${up2.status}`)) finish(1);
  const url2 = up2.json.url;
  check('the second photo got its own URL (nothing was overwritten)', url2 !== url1, url2 === url1 ? 'same URL!' : `${String(url1).length} B vs ${String(url2).length} B`);
  await checkServed(url2, 'the second stored URL');

  // 5 — validation is enforced on the deployed function ---------------------
  if (!AS_JSON) console.log('\n5. validation on the deployed endpoint');
  const junk = await req('POST', `${BASE}/api/admin/products/image`, { dataUrl: 'data:image/png;base64,aGVsbG8=' });
  check('a file whose bytes are not a real image is refused', junk.status === 400, `HTTP ${junk.status}`);
  const typed = await req('POST', `${BASE}/api/admin/products/image`, { url: 'https://example.com/photo.png' });
  check('a typed URL is not accepted as an uploaded file', typed.status === 400, `HTTP ${typed.status}`);

  // 6 — the probe changed no product ---------------------------------------
  if (!AS_JSON) console.log('\n6. the catalog is untouched by the probe');
  const data = (await req('GET', `${BASE}/api/data`)).json;
  const products = (data && data.products) || [];
  const leaked = products.filter((p) => (p.images || []).some((u) => u === url1 || u === url2));
  check('GET /api/data still serves the catalog', products.length > 0, `${products.length} product(s)`);
  check('no product was modified by the probe (the uploads are inert files)', leaked.length === 0, leaked.map((p) => p.id).join(', '));
  if (!AS_JSON && products.length) {
    console.log(`\n   Now check it in the Admin panel:  ${BASE}/admin`);
    console.log('   Products → edit any product → Images → 🖼️ Add image → select from the library (or 📷 Upload a new photo) → Save.');
    console.log('   The two probe files are inert; delete them in Supabase → Storage → product-images/products/ if you want.');
  }

  finish(checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((e) => {
  check('probe completed without an unexpected error', false, e.message);
  finish(1);
});
