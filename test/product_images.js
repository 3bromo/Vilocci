'use strict';
// ============================================================================
// Product images — the Admin gallery picker (device photo → product)
// ----------------------------------------------------------------------------
// The product editor used to accept images only as a typed URL. It now opens
// the device's native photo picker, uploads the chosen file through the
// project's existing storage system and adds the resulting image to the
// product's gallery:
//
//   POST /api/admin/products/image   { dataUrl, productId? } → { ok, url }
//     1. Supabase Storage, PUBLIC bucket `product-images` (production)
//     2. /img/uploads on a writable host (local development)
//     3. an inline data URL as the last resort on a read-only host
//
// This suite drives the REAL server (scratch JSON datastore — the committed
// dataset is never touched) and the REAL storefront + admin bundles (jsdom):
//
//   api        a picked photo uploads, is served back, and is refused when it
//              is not a real image / not authenticated. No URL is required.
//   persist    the uploaded URL is saved with the product by the existing Save
//              flow and is served by /api/data + /api/admin/data.
//   compat     every pre-existing image (generated artwork, pasted public URL,
//              /img/uploads file) keeps working untouched.
//   storefront the uploaded photo renders in the product gallery.
//   admin ui   the editor exposes a real file input (native gallery on iOS /
//              Android), previews each image, adds several one at a time, still
//              removes an image, and posts the gallery on Save — for an
//              existing product AND for a brand-new one.
//   migration  010_product_images.sql ships with the CLI (additive only).
//
// Usage: npm run test:productimages
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(ROOT, 'img', 'uploads');

const PORT = 3498;
const API = `http://127.0.0.1:${PORT}`;
const DEV_TOKEN = 'product-images-test-token-' + Date.now().toString(36);

// A real 1x1 PNG (valid magic bytes — passes the strict upload validation).
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

let pass = 0; let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓', name); }
  else { fail += 1; console.log('  ✗', name, extra !== undefined ? `→ ${extra}` : ''); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, urlPath, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.admin) headers['x-admin-dev-token'] = DEV_TOKEN;
  const res = await fetch(API + urlPath, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') || '';
  let json = null;
  if (type.indexOf('json') >= 0) { try { json = await res.json(); } catch (e) { /* ignore */ } }
  return { ok: res.ok, status: res.status, json };
}

async function waitForServer(child, base) {
  const deadline = Date.now() + 20000;
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

function startServer(port, dbFile) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(port),
      VELOCCI_DB: dbFile,
      DATA_DRIVER: 'json',
      ADMIN_DEV_TOKEN: DEV_TOKEN,
      VITE_SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      SUPABASE_DB_URL: '', DATABASE_URL: '', POSTGRES_URL: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  return { child, log: () => log };
}

// ---------------------------------------------------------------------------
// Storefront boot (jsdom) — same harness as test/shape_images.js.
// ---------------------------------------------------------------------------
async function bootStorefront(payload) {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: API + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (u) => {
        const url = typeof u === 'string' ? u : u.url;
        if (url.indexOf('/api/data') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
        if (url.indexOf('/api/orders') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, orderId: 'ORD-PRODIMG', total: 100 }) });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      };
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.alert = () => {};
      window.confirm = () => true;
      window.scrollTo = () => {};
    },
  });
  dom.window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'engine.js'), 'utf8'));
  dom.window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8'));
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !dom.window.document.querySelector('#brand-strip')) await wait(50);
  await wait(120);
  return dom;
}

// ---------------------------------------------------------------------------
// Admin panel boot (jsdom). The fetch stub records every call and answers the
// product-image upload the way the real server does ({ ok, url }).
// ---------------------------------------------------------------------------
async function bootAdmin(catalog) {
  const html = fs.readFileSync(path.join(PUBLIC, 'admin.html'), 'utf8');
  const calls = [];
  let uploadCount = 0;
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => {
    if (!/Could not load|Not implemented/.test(e.message)) console.log('  ! page error:', e.message);
  });
  const dom = new JSDOM(html, {
    virtualConsole,
    url: 'http://localhost:3000/admin',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.supabase = { createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: { user: { id: 'admin-1', email: 'admin@test.com' }, access_token: 'test-jwt' } } }),
          signInWithPassword: async () => ({ data: {}, error: null }),
          signOut: async () => ({ error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        },
        from() { return { select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'admin-1' }, error: null }) }) }) }; },
      }) };
      window.__SPINTO_SUPABASE_URL = '%VITE_SUPABASE_URL%';
      window.__SPINTO_SUPABASE_ANON_KEY = '%VITE_SUPABASE_ANON_KEY%';
      window.scrollTo = () => {};
      const realSetInterval = window.setInterval.bind(window);
      window.setInterval = (fn, ms) => realSetInterval(() => {}, 2147483000);
      window.fetch = (u, o = {}) => {
        const url = typeof u === 'string' ? u : u.url;
        let body = null;
        try { body = o.body ? JSON.parse(o.body) : null; } catch (e) { body = null; }
        calls.push({ url, method: o.method || 'GET', body });
        if (url.indexOf('/api/admin/config') >= 0) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
            url: 'https://testproject.supabase.co', anonKey: 'fake-anon-key-0123456789-abcdefghijklmnopqrstuvwxyz',
          }) });
        }
        if (url.indexOf('/api/admin/data') >= 0) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(catalog) });
        }
        if (url.indexOf('/api/admin/diagnose') >= 0) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ probe: { ok: true, servedBy: 'json' }, issues: [] }) });
        }
        // The upload endpoint: every picked photo gets its own durable URL,
        // exactly like the real Supabase Storage object name.
        if (url.indexOf('/api/admin/products/image') >= 0) {
          uploadCount += 1;
          const stored = `https://testproject.supabase.co/storage/v1/object/public/product-images/products/prod_x-${uploadCount}.png`;
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, url: stored, storage: 'supabase-storage', bytes: 68 }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
      };
      window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'admin-app.js'), 'utf8'));
    },
  });
  await wait(400);
  const { window } = dom;
  const doc = window.document;
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const pickFile = async (input, name, mime) => {
    const file = new window.File([Buffer.from(TINY_PNG.split(',')[1], 'base64')], name || 'photo.png', { type: mime || 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(160);
  };
  const openProducts = async () => {
    const navProducts = [...doc.querySelectorAll('[data-nav]')].find((a) => a.getAttribute('data-nav') === 'products');
    if (navProducts) click(navProducts);
    await wait(80);
  };
  return { dom, window, doc, calls, click, pickFile, openProducts };
}

(async function main() {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'VELOCE-prodimg-'));
  const scratchDb = path.join(scratchDir, 'velocci-db.json');
  fs.copyFileSync(path.join(ROOT, 'data', 'velocci-db.json'), scratchDb);
  // The writable-host fallback writes into <repo>/img/uploads — remember what
  // was there so the run leaves the working tree exactly as it found it.
  const uploadsBefore = fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR) : null;

  const srv = startServer(PORT, scratchDb);
  try {
    const up = await waitForServer(srv.child, API);
    if (!up) { console.error('server did not start\n', srv.log()); process.exit(1); }

    // ------------------------------------------------------------------ 1
    console.log('\n== 1. The upload endpoint stores a picked photo ==');
    const uploaded = await http('POST', '/api/admin/products/image', { dataUrl: TINY_PNG, productId: 'prod_test' }, { admin: true });
    check('uploading a picked photo succeeds', uploaded.ok && uploaded.json && uploaded.json.ok, JSON.stringify(uploaded.json));
    check('the response carries the image URL the editor adds to the product',
      typeof (uploaded.json || {}).url === 'string' && (uploaded.json || {}).url.length > 0, JSON.stringify(uploaded.json));
    check('the response reports where the image was stored', !!uploaded.json.storage, JSON.stringify(uploaded.json));
    check('this server has no Supabase Storage, so the photo is written to /img/uploads',
      uploaded.json.storage === 'local-disk' && /^\/img\/uploads\/prod_[a-z0-9_]+\.png$/.test(uploaded.json.url), JSON.stringify(uploaded.json));
    const served = await fetch(API + uploaded.json.url);
    check('the uploaded image is served back by the app', served.ok && (served.headers.get('content-type') || '').indexOf('image') >= 0, String(served.status));

    // ------------------------------------------------------------------ 2
    console.log('\n== 2. Validation & auth — a real image file, nothing else ==');
    const noToken = await http('POST', '/api/admin/products/image', { dataUrl: TINY_PNG });
    check('unauthenticated uploads are refused', noToken.status === 401, String(noToken.status));
    const empty = await http('POST', '/api/admin/products/image', { productId: 'prod_test' }, { admin: true });
    check('a request with no image at all is refused', empty.status === 400, JSON.stringify(empty.json));
    const notImage = await http('POST', '/api/admin/products/image', { dataUrl: 'data:text/plain;base64,aGVsbG8=' }, { admin: true });
    check('a non-image data URL is refused', notImage.status === 400, JSON.stringify(notImage.json));
    const svg = await http('POST', '/api/admin/products/image', { dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }, { admin: true });
    check('an SVG is refused (script-bearing formats never reach storage)', svg.status === 400, JSON.stringify(svg.json));
    const fakePng = await http('POST', '/api/admin/products/image', { dataUrl: 'data:image/png;base64,aGVsbG8=' }, { admin: true });
    check('a file whose bytes are not a real image is refused', fakePng.status === 400, JSON.stringify(fakePng.json));
    const typedUrl = await http('POST', '/api/admin/products/image', { url: 'https://example.com/photo.png' }, { admin: true });
    check('a typed URL is not accepted as an uploaded file', typedUrl.status === 400, JSON.stringify(typedUrl.json));
    const junk = await http('POST', '/api/admin/products/image', { dataUrl: 'not-an-image' }, { admin: true });
    check('junk input is refused', junk.status === 400, JSON.stringify(junk.json));

    // ------------------------------------------------------------------ 3
    console.log('\n== 3. Saving the product preserves the uploaded image ==');
    const before = (await http('GET', '/api/admin/data', null, { admin: true })).json;
    const target = before.products.find((p) => p.id === 'p_mercedes-benz_case_carbon') || before.products[0];
    const originalImages = (target.images || []).slice();
    check('the product starts with its existing URL-based images', originalImages.length === 3 && originalImages[0].indexOf('/img/asset.svg') === 0, JSON.stringify(originalImages));

    const pick1 = await http('POST', '/api/admin/products/image', { dataUrl: TINY_PNG, productId: target.id }, { admin: true });
    const saved = await http('POST', '/api/admin/save', {
      collection: 'products',
      record: Object.assign({}, target, { images: originalImages.concat([pick1.json.url]), main_image: originalImages[0] }),
    }, { admin: true });
    check('the existing Save flow stores the product with the uploaded image', saved.ok, JSON.stringify(saved.json).slice(0, 120));

    let pub = (await http('GET', '/api/data')).json;
    let live = pub.products.find((p) => p.id === target.id);
    check('/api/data serves the uploaded image on the product',
      !!live && live.images.length === 4 && live.images[3] === pick1.json.url, JSON.stringify(live && live.images));
    check('every pre-existing image is preserved, in order',
      !!live && originalImages.every((u, i) => live.images[i] === u), JSON.stringify(live && live.images));
    check('main_image still points at the first image', !!live && live.main_image === originalImages[0], live && live.main_image);

    // A second photo, one at a time (the same picker, again)
    const pick2 = await http('POST', '/api/admin/products/image', { dataUrl: TINY_PNG, productId: target.id }, { admin: true });
    check('a second upload gets its own URL (a gallery, never an overwrite)',
      pick2.ok && pick2.json.url !== pick1.json.url, `${pick1.json.url} vs ${pick2.json.url}`);
    await http('POST', '/api/admin/save', {
      collection: 'products',
      record: Object.assign({}, live, { images: live.images.concat([pick2.json.url]), main_image: originalImages[0] }),
    }, { admin: true });
    pub = (await http('GET', '/api/data')).json;
    live = pub.products.find((p) => p.id === target.id);
    check('the product now carries both uploaded photos', !!live && live.images.length === 5
      && live.images[3] === pick1.json.url && live.images[4] === pick2.json.url, JSON.stringify(live && live.images));

    // Removing one image again (the editor's 🗑) must not disturb the others
    await http('POST', '/api/admin/save', {
      collection: 'products',
      record: Object.assign({}, live, { images: live.images.filter((u) => u !== pick2.json.url), main_image: originalImages[0] }),
    }, { admin: true });
    pub = (await http('GET', '/api/data')).json;
    live = pub.products.find((p) => p.id === target.id);
    check('removing an image drops only that image', !!live && live.images.length === 4 && live.images.indexOf(pick2.json.url) < 0
      && live.images[3] === pick1.json.url, JSON.stringify(live && live.images));

    // ------------------------------------------------------------------ 4
    console.log('\n== 4. Existing image kinds keep working ==');
    const artwork = await fetch(API + '/img/asset.svg?type=keycase&brand=mercedes-benz&style=carbon');
    check('generated artwork (/img/asset.svg) is still served', artwork.ok && (artwork.headers.get('content-type') || '').indexOf('svg') >= 0, String(artwork.status));
    const external = 'https://cdn.example.com/legacy-product-photo.jpg';
    await http('POST', '/api/admin/save', {
      collection: 'products',
      record: Object.assign({}, live, { images: live.images.concat([external, '/img/uploads/up_legacy.png']) }),
    }, { admin: true });
    pub = (await http('GET', '/api/data')).json;
    live = pub.products.find((p) => p.id === target.id);
    check('a pasted external URL is stored untouched', live.images.indexOf(external) >= 0, JSON.stringify(live.images));
    check('a legacy /img/uploads URL is stored untouched', live.images.indexOf('/img/uploads/up_legacy.png') >= 0, JSON.stringify(live.images));
    check('the other products are untouched by all of this',
      pub.products.filter((p) => p.id !== target.id).length === before.products.length - 1
      && pub.products.filter((p) => p.id !== target.id).every((p, i) => {
        const orig = before.products.filter((x) => x.id !== target.id)[i];
        return orig && JSON.stringify(orig.images || []) === JSON.stringify(p.images || []);
      }), 'a neighbouring product changed');
    // restore the product to its committed state for the remaining sections
    await http('POST', '/api/admin/save', { collection: 'products', record: Object.assign({}, target, { images: originalImages, main_image: originalImages[0] }) }, { admin: true });
    pub = (await http('GET', '/api/data')).json;
    check('the product is restored to its original gallery', JSON.stringify((pub.products.find((p) => p.id === target.id) || {}).images) === JSON.stringify(originalImages));

    // ------------------------------------------------------------------ 5
    console.log('\n== 5. Storefront — the uploaded photo renders in the gallery ==');
    const withUpload = await http('POST', '/api/admin/products/image', { dataUrl: TINY_PNG, productId: target.id }, { admin: true });
    await http('POST', '/api/admin/save', {
      collection: 'products',
      record: Object.assign({}, target, { images: [withUpload.json.url].concat(originalImages), main_image: withUpload.json.url }),
    }, { admin: true });
    pub = (await http('GET', '/api/data')).json;
    const dom = await bootStorefront(pub);
    dom.window.location.hash = '#/product/' + target.slug;
    dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
    await wait(120);
    const doc = dom.window.document;
    const mainImg = doc.querySelector('#gallery-main');
    check('the product page shows the uploaded photo as the main image',
      !!mainImg && mainImg.getAttribute('src') === withUpload.json.url, mainImg && mainImg.getAttribute('src'));
    const thumbs = [...doc.querySelectorAll('.thumbs .thumb img')];
    check('the gallery lists one thumbnail per product image', thumbs.length === 4, String(thumbs.length));
    check('the existing generated artwork thumbnails still render',
      thumbs.some((t) => (t.getAttribute('src') || '').indexOf('/img/asset.svg') === 0), JSON.stringify(thumbs.map((t) => t.getAttribute('src'))));
    dom.window.close();
    await http('POST', '/api/admin/save', { collection: 'products', record: Object.assign({}, target, { images: originalImages, main_image: originalImages[0] }) }, { admin: true });

    // ------------------------------------------------------------------ 6
    console.log('\n== 6. Admin panel — the product editor opens the device gallery ==');
    const adminPayload = (await http('GET', '/api/admin/data', null, { admin: true })).json;
    const admin = await bootAdmin(adminPayload);
    await admin.openProducts();
    const editBtn = admin.doc.querySelector(`[data-edit-product="${target.id}"]`) || admin.doc.querySelector('[data-edit-product]');
    admin.click(editBtn);
    await wait(120);

    const fileInput = admin.doc.querySelector('#pf-image-file');
    const uploadBtn = admin.doc.querySelector('#btn-upload-product-image');
    check('the editor has an Upload image button', !!uploadBtn && /upload/i.test(uploadBtn.textContent), uploadBtn && uploadBtn.textContent);
    check('the editor has a real file input (the native gallery on iOS/Android)',
      !!fileInput && fileInput.getAttribute('type') === 'file', fileInput && fileInput.outerHTML);
    check('the file input accepts images', !!fileInput && (fileInput.getAttribute('accept') || '').indexOf('image') >= 0, fileInput && fileInput.getAttribute('accept'));
    check('the file input is hidden — the button is what the admin taps',
      !!fileInput && /display:\s*none/.test(fileInput.getAttribute('style') || ''), fileInput && fileInput.getAttribute('style'));
    check('the editor explains that the picker uploads the photo automatically',
      /photo gallery/i.test(admin.doc.querySelector('#product-form').textContent), '');

    // Tapping the button must open the picker (iOS Safari needs a real click on
    // a real <input type="file"> from the tap handler).
    let pickerOpened = 0;
    fileInput.click = () => { pickerOpened += 1; };
    admin.click(uploadBtn);
    await wait(30);
    check('tapping Upload image opens the device picker', pickerOpened === 1, String(pickerOpened));

    // Existing images are previewed, and no URL has to be typed for them
    const rowsBefore = [...admin.doc.querySelectorAll('#product-images-list [data-img-del]')];
    check('every existing image is listed with its own row', rowsBefore.length === originalImages.length, String(rowsBefore.length));
    check('every existing image shows a preview thumbnail',
      admin.doc.querySelectorAll('#product-images-list img').length === originalImages.length,
      String(admin.doc.querySelectorAll('#product-images-list img').length));
    check('the first image is still marked MAIN', /MAIN IMAGE/.test(admin.doc.querySelector('#product-images-list').textContent));
    const urlBox = admin.doc.querySelector('#product-image-url-box');
    check('pasting a URL is optional and collapsed away (never required)',
      !!urlBox && urlBox.tagName === 'DETAILS' && urlBox.open === false && !!admin.doc.querySelector('#pf-new-image'),
      urlBox && urlBox.outerHTML.slice(0, 60));

    // Picking a photo uploads it and previews it — one at a time, twice
    await admin.pickFile(fileInput, 'iphone-photo-1.png', 'image/png');
    const upCalls = admin.calls.filter((c) => c.url.indexOf('/api/admin/products/image') >= 0);
    check('picking a photo POSTs it to /api/admin/products/image', upCalls.length === 1
      && typeof upCalls[0].body.dataUrl === 'string' && upCalls[0].body.dataUrl.indexOf('data:image/png') === 0,
      JSON.stringify(upCalls.map((c) => c.body && Object.keys(c.body))));
    check('the upload names the product being edited', upCalls.length === 1 && upCalls[0].body.productId === target.id, JSON.stringify(upCalls[0] && upCalls[0].body && upCalls[0].body.productId));
    let rows = [...admin.doc.querySelectorAll('#product-images-list [data-img-del]')];
    check('the uploaded image is added to the gallery automatically', rows.length === originalImages.length + 1, String(rows.length));
    const uploadedThumb = [...admin.doc.querySelectorAll('#product-images-list img')].pop();
    check('the uploaded image is previewed with the returned storage URL',
      !!uploadedThumb && (uploadedThumb.getAttribute('src') || '').indexOf('/object/public/product-images/products/') >= 0,
      uploadedThumb && uploadedThumb.getAttribute('src'));
    check('the existing previews are untouched by the upload',
      [...admin.doc.querySelectorAll('#product-images-list img')].slice(0, originalImages.length)
        .every((im, i) => im.getAttribute('src') === originalImages[i]),
      JSON.stringify([...admin.doc.querySelectorAll('#product-images-list img')].map((i) => i.getAttribute('src'))));
    check('the file input is reset so the same photo can be picked again', fileInput.value === '', fileInput.value);
    check('the upload button is usable again after the upload', uploadBtn.disabled === false, String(uploadBtn.disabled));

    await admin.pickFile(fileInput, 'iphone-photo-2.png', 'image/png');
    rows = [...admin.doc.querySelectorAll('#product-images-list [data-img-del]')];
    check('a second photo is added the same way (multiple images, one at a time)',
      rows.length === originalImages.length + 2
      && admin.calls.filter((c) => c.url.indexOf('/api/admin/products/image') >= 0).length === 2, String(rows.length));

    // Removing an image still works — both an uploaded one and an existing one
    admin.click(admin.doc.querySelector('#product-images-list [data-img-del="' + (rows.length - 1) + '"]'));
    await wait(40);
    rows = [...admin.doc.querySelectorAll('#product-images-list [data-img-del]')];
    check('the last uploaded image can be removed again', rows.length === originalImages.length + 1, String(rows.length));

    // Save posts the whole gallery — existing URLs plus the uploaded one
    admin.click(admin.doc.querySelector('#btn-save-product'));
    await wait(120);
    const saveCall = admin.calls.filter((c) => c.url.indexOf('/api/admin/save') >= 0 && c.body && c.body.collection === 'products').pop();
    check('Save posts the product with the uploaded image in its gallery',
      !!saveCall && Array.isArray(saveCall.body.record.images)
      && saveCall.body.record.images.length === originalImages.length + 1
      && originalImages.every((u, i) => saveCall.body.record.images[i] === u)
      && saveCall.body.record.images[originalImages.length].indexOf('/object/public/product-images/products/') >= 0,
      JSON.stringify(saveCall && saveCall.body && saveCall.body.record && saveCall.body.record.images));
    check('main_image follows the first gallery image', !!saveCall && saveCall.body.record.main_image === saveCall.body.record.images[0],
      saveCall && saveCall.body && saveCall.body.record && saveCall.body.record.main_image);
    check('the price and the other fields still travel with the save',
      !!saveCall && saveCall.body.record.price === target.price && saveCall.body.record.brandSlug === target.brandSlug,
      JSON.stringify(saveCall && saveCall.body && saveCall.body.record && saveCall.body.record.price));
    admin.dom.window.close();

    // ------------------------------------------------------------------ 7
    console.log('\n== 7. Admin panel — creating a NEW product from picked photos ==');
    const admin2 = await bootAdmin(adminPayload);
    await admin2.openProducts();
    const addBtn = admin2.doc.querySelector('#btn-add-product');
    admin2.click(addBtn);
    await wait(120);
    const newFileInput = admin2.doc.querySelector('#pf-image-file');
    check('the Add Product editor has the same gallery picker', !!newFileInput && !!admin2.doc.querySelector('#btn-upload-product-image'));
    check('a new product starts with an empty gallery',
      admin2.doc.querySelectorAll('#product-images-list [data-img-del]').length === 0
      && /No images yet/.test(admin2.doc.querySelector('#product-images-list').textContent));
    await admin2.pickFile(newFileInput, 'new-photo.png', 'image/png');
    const newUp = admin2.calls.filter((c) => c.url.indexOf('/api/admin/products/image') >= 0);
    check('a photo can be uploaded before the product exists', newUp.length === 1 && !newUp[0].body.productId, JSON.stringify(newUp[0] && newUp[0].body));
    check('the uploaded photo is the new product\'s first (main) image',
      admin2.doc.querySelectorAll('#product-images-list [data-img-del]').length === 1
      && /MAIN IMAGE/.test(admin2.doc.querySelector('#product-images-list').textContent));
    admin2.doc.querySelector('#product-form [name=name_en]').value = 'Test Uploaded Product';
    admin2.doc.querySelector('#product-form [name=price]').value = '1500';
    const catSelect = admin2.doc.querySelector('#product-form [name=category]');
    if (catSelect && !catSelect.value && catSelect.options.length > 1) catSelect.value = catSelect.options[1].value;
    const brandSelect = admin2.doc.querySelector('#product-form [name=brandSlug]');
    if (brandSelect && !brandSelect.value && brandSelect.options.length > 1) brandSelect.value = brandSelect.options[1].value;
    admin2.click(admin2.doc.querySelector('#btn-save-product'));
    await wait(140);
    const createCall = admin2.calls.filter((c) => c.url.indexOf('/api/admin/save') >= 0 && c.body && c.body.collection === 'products').pop();
    check('creating the product stores the picked photo',
      !!createCall && createCall.body.record.name_en === 'Test Uploaded Product'
      && (createCall.body.record.images || []).length === 1
      && createCall.body.record.images[0].indexOf('/object/public/product-images/products/') >= 0,
      JSON.stringify(createCall && createCall.body && createCall.body.record && createCall.body.record.images));
    check('main_image is set from the picked photo', !!createCall && createCall.body.record.main_image === createCall.body.record.images[0]);
    admin2.dom.window.close();

    // ------------------------------------------------------------------ 8
    console.log('\n== 8. Migration 010 ships with the CLI (public bucket + policies) ==');
    const printSql = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate.js'), '--print-sql'], { cwd: ROOT, encoding: 'utf8' });
    check('migrate --print-sql includes the 010 product images migration',
      printSql.stdout.includes('010_product_images.sql'), (printSql.stdout || '').slice(-200));
    check('010 provisions the public product-images bucket',
      /values\s*\(\s*'product-images'\s*,\s*'product-images'\s*,\s*true\s*\)/i.test(printSql.stdout));
    check('010 includes public-read and admin Storage policies',
      /Product images: public read/i.test(printSql.stdout)
      && /Product images: admin upload/i.test(printSql.stdout)
      && /Product images: admin update/i.test(printSql.stdout)
      && /Product images: admin delete/i.test(printSql.stdout));
    const migration010 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '010_product_images.sql'), 'utf8');
    const sql010 = migration010.replace(/--[^\n]*/g, '');
    check('010 changes NO table (products.images and product_images already exist)',
      !/alter table|create table/i.test(sql010), (sql010.match(/alter table[^\n]*/i) || [])[0]);
    check('010 only touches storage when the Storage schema exists',
      /to_regclass\('storage\.buckets'\)/.test(sql010) && /to_regclass\('storage\.objects'\)/.test(sql010));
    check('every 010 Storage policy is scoped to the product-images bucket',
      (sql010.match(/bucket_id = ''product-images''/g) || []).length >= 4);
    check('010 is additive only (no drops of data, no deletes)',
      !/drop table|truncate|delete from/i.test(sql010));
    const dryRun = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate.js')], { cwd: ROOT, encoding: 'utf8' });
    check('the migration dry run lists the 010 product-images migration',
      /010[\s\S]{0,160}?product image/i.test(dryRun.stdout), (dryRun.stdout || '').slice(-300));
  } finally {
    srv.child.kill();
    // Leave the working tree exactly as it was: drop the files this run wrote
    // into <repo>/img/uploads (and the folder itself when it did not exist).
    try {
      if (uploadsBefore === null) fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
      else fs.readdirSync(UPLOAD_DIR).filter((f) => !uploadsBefore.includes(f)).forEach((f) => fs.rmSync(path.join(UPLOAD_DIR, f), { force: true }));
    } catch (e) { /* best effort */ }
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }

  console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('product images test crashed:', e); process.exit(1); });
