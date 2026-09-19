#!/usr/bin/env node
/* ==========================================================================
   Shape Images — end-to-end production probe.

   Runs the exact flow the acceptance test asks for, against a *deployed*
   store, through the same HTTP endpoints the Admin panel uses:

     1. read the server diagnosis   (key_shapes.image_url column + shape-images bucket)
     2. UPLOAD an image for a shape  POST /api/admin/shapes/image   → Supabase Storage
     3. read it back from the app    GET  /api/data                 → key_shapes.image_url
     4. fetch the stored URL         GET  <public storage URL>      → must answer 200
     5. REPLACE it with a second, visibly different image (same three checks)
     6. optional --remove            POST /api/admin/shapes/image/remove → back to the
                                     silhouette fallback (image_url = "")

   Authentication is the operator's own admin session: copy the Supabase access
   token the Admin panel uses (`localStorage["velocci_admin_session"]` or the
   `Authorization: Bearer …` header of any /api/admin/* request in the browser's
   network tab), or pass a dev token for a local server. No credential is ever
   stored by this script.

   Usage:
     node scripts/shape_image_probe.js --url https://<deployment> --token <ADMIN_JWT>
     node scripts/shape_image_probe.js --url http://localhost:3000 --dev-token <ADMIN_DEV_TOKEN>
   Options:
     --shape <code|id>   shape to probe (default: A)
     --file <path>       upload this image instead of the built-in test card
     --remove            clear the image again at the end (fallback must return)
     --json              machine-readable summary on stdout
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
const SHAPE = String(arg('shape', 'A'));
const FILE = typeof arg('file', '') === 'string' ? arg('file', '') : '';
const REMOVE = !!arg('remove', false);
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
    console.log(JSON.stringify({ target: BASE, shape: SHAPE, checks, ok: checks.every((c) => c.ok) }, null, 2));
  } else {
    const bad = checks.filter((c) => !c.ok);
    console.log(`\n${bad.length ? `\u2717 ${bad.length} of ${checks.length} checks FAILED` : `\u2713 all ${checks.length} checks passed`}`);
  }
  process.exit(code);
}

function headers(extra) {
  const h = Object.assign({ 'content-type': 'application/json' }, extra || {});
  if (DEV_TOKEN && DEV_TOKEN !== true) h['x-admin-dev-token'] = String(DEV_TOKEN);
  else if (TOKEN && TOKEN !== true) h.authorization = `Bearer ${String(TOKEN)}`;
  return h;
}
async function req(method, url, body, extraHeaders) {
  const res = await fetch(url, {
    method,
    headers: headers(extraHeaders),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text };
}

// --------------------------------------------------------------------------
// A real PNG built here (zlib + CRC), so the probe needs no asset and the
// operator can SEE the difference: variant 1 = gold disc, variant 2 = navy
// square, both on the store's cream card.
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
  const W = 240, H = 368;
  const cream = [246, 241, 231];
  const ink = [30, 30, 30];
  const accent = variant === 2 ? [23, 48, 92] : [201, 168, 76];   // navy / champagne
  const rows = [];
  const cx = W / 2, cy = H / 2, r = 74;
  for (let y = 0; y < H; y++) {
    const row = Buffer.alloc(1 + W * 3);
    row[0] = 0;                                                   // filter: none
    for (let x = 0; x < W; x++) {
      let px = cream;
      const border = x < 6 || y < 6 || x >= W - 6 || y >= H - 6;
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

async function main() {
  const auth = DEV_TOKEN && DEV_TOKEN !== true ? 'dev token' : TOKEN && TOKEN !== true ? 'admin session token' : 'NONE';
  if (!AS_JSON) {
    console.log(`Shape Images end-to-end probe`);
    console.log(`  target: ${BASE}`);
    console.log(`  shape:  ${SHAPE}`);
    console.log(`  auth:   ${auth}`);
    console.log('');
  }
  if (auth === 'NONE') {
    check('an admin credential was supplied (--token/--dev-token)', false, 'nothing to authenticate with');
    finish(2);
  }

  // 1 — the deployed app reports its shape-image wiring --------------------
  if (!AS_JSON) console.log('1. deployed app diagnosis (/api/admin/diagnose?shapes=1)');
  let diag;
  try {
    const r = await req('GET', `${BASE}/api/admin/diagnose?shapes=1`);
    diag = r.json;
    if (!check('diagnose answered with JSON', r.status === 200 && !!diag, `HTTP ${r.status}`)) finish(1);
  } catch (e) {
    check('diagnose reachable', false, e.message);
    finish(1);
  }
  const si = diag.shapeImages || null;
  if (!check('the deployment reports the shapeImages block (build 20260919c+)', !!si, si ? '' : 'old deployment?')) finish(1);
  check('key_shapes.image_url exists (migration 009 applied)', !!(si.column && si.column.present), JSON.stringify(si.column));
  const st = si.storage || {};
  const storageBacked = st.configured !== false;
  if (storageBacked) {
    check('the shape-images bucket exists', !!st.exists, `bucket=${st.bucket}`);
    check('the shape-images bucket is PUBLIC (stored URLs render on the storefront)', !!st.public, `public=${st.public}`);
  } else {
    note('this deployment has no Supabase Storage (bundled JSON store) — bucket checks do not apply');
  }
  const rows = si.rows || [];
  if (!check(`key_shapes returned its rows (${rows.length})`, rows.length > 0)) finish(1);
  const target = rows.find((r) => String(r.code || '').toUpperCase() === SHAPE.toUpperCase() || r.id === SHAPE);
  if (!check(`shape "${SHAPE}" exists in the catalogue`, !!target, rows.map((r) => r.code).join(', '))) finish(1);
  check('the shape starts from a known state', typeof target.image_url === 'string', `image_url=${JSON.stringify(target.image_url)}`);

  // 2 — UPLOAD -------------------------------------------------------------
  const first = dataUrlFor(1);
  if (!AS_JSON) { console.log(`\n2. upload → ${target.id} (${first.label})`); }
  const up1 = await req('POST', `${BASE}/api/admin/shapes/image`, { shapeId: target.id, dataUrl: first.dataUrl });
  if (!check('upload accepted', up1.status === 200 && up1.json && up1.json.url, `HTTP ${up1.status}${up1.json && up1.json.error ? ' — ' + up1.json.error : ''}`)) finish(1);
  note(`stored via ${up1.json.storage}: ${String(up1.json.url).slice(0, 120)}${String(up1.json.url).length > 120 ? '…' : ''}`);
  const url1 = up1.json.url;

  // 3 — the database / the payload the storefront reads --------------------
  if (!AS_JSON) console.log('3. read back what the storefront reads (/api/data)');
  const data1 = (await req('GET', `${BASE}/api/data`)).json;
  const served1 = (data1 && data1.shapes || []).find((s) => s.id === target.id) || {};
  check('GET /api/data serves the uploaded URL as key_shapes.image_url', served1.image_url === url1, `served=${JSON.stringify(served1.image_url)}`);

  // 4 — the public URL itself ---------------------------------------------
  if (!AS_JSON) console.log('4. fetch the stored URL (what the storefront <img> loads)');
  if (/^data:/.test(url1)) {
    check('stored URL is a served image', true, 'inline data URL (JSON-fallback deployment — no Supabase Storage)');
  } else {
    try {
      const res = await fetch(url1, { method: 'GET' });
      const ct = res.headers.get('content-type') || '';
      check('the stored URL answers 200', res.status === 200, `HTTP ${res.status}`);
      check('the stored URL is served as an image', /^image\//i.test(ct), ct || '(no content-type)');
    } catch (e) {
      check('the stored URL answers 200', false, e.message);
    }
  }

  // 5 — REPLACE ------------------------------------------------------------
  const second = dataUrlFor(2);
  if (!AS_JSON) console.log(`\n5. replace → ${target.id} (${second.label})`);
  const up2 = await req('POST', `${BASE}/api/admin/shapes/image`, { shapeId: target.id, dataUrl: second.dataUrl });
  if (!check('replacement accepted', up2.status === 200 && up2.json && up2.json.url, `HTTP ${up2.status}${up2.json && up2.json.error ? ' — ' + up2.json.error : ''}`)) finish(1);
  const url2 = up2.json.url;
  check('the replacement produced a different stored value', url2 !== url1,
    url2 === url1 ? `unchanged ${String(url2).length} B` : `${String(url1).length} B → ${String(url2).length} B`);
  const data2 = (await req('GET', `${BASE}/api/data`)).json;
  const served2 = (data2 && data2.shapes || []).find((s) => s.id === target.id) || {};
  check('the replacement is what the storefront now reads', served2.image_url === url2, `served=${JSON.stringify(String(served2.image_url).slice(0, 80))}`);

  // 6 — the storefront page that shows it ----------------------------------
  const products = (data2 && (data2.products || data2.catalog && data2.catalog.products)) || [];
  const withShape = products.find((p) => (p.shapes || []).some((s) => String(s.shape).toUpperCase() === String(target.code).toUpperCase() && s.available !== false));
  if (withShape && withShape.slug && !AS_JSON) {
    console.log(`\n   Open this product page to see the uploaded image in the "SELECT YOUR KEY SHAPE" row:`);
    console.log(`   ${BASE}/index.html#/product/${withShape.slug}`);
  }

  // 7 — optional cleanup ---------------------------------------------------
  if (REMOVE) {
    if (!AS_JSON) console.log('\n6. remove → back to the SVG silhouette fallback');
    const rm = await req('POST', `${BASE}/api/admin/shapes/image/remove`, { shapeId: target.id });
    check('removal accepted', rm.status === 200, `HTTP ${rm.status}`);
    const data3 = (await req('GET', `${BASE}/api/data`)).json;
    const served3 = (data3 && data3.shapes || []).find((s) => s.id === target.id) || {};
    check('image_url is empty again (storefront falls back to the silhouette)', served3.image_url === '' || served3.image_url == null,
      `served=${JSON.stringify(served3.image_url)}`);
  } else if (!AS_JSON) {
    console.log(`\n   The uploaded image is left in place so you can see it on the storefront.`);
    console.log(`   Remove it again with:  node scripts/shape_image_probe.js --url ${BASE} --token <JWT> --shape ${SHAPE} --remove`);
  }

  finish(checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((e) => {
  check('probe completed without an unexpected error', false, e.message);
  finish(1);
});
