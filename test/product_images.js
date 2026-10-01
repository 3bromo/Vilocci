'use strict';
// ============================================================================
// Product images — the Admin image library picker (select, don't type a URL)
// ----------------------------------------------------------------------------
// The product editor used to accept images only as a typed URL. "Add image" now
// opens the admin's EXISTING media library (Admin → Website Images,
// `website_images`) as a chooser: select an image and its URL populates the
// product gallery, with a preview, one selection at a time, for as many images
// as the product needs. A photo that is not in the library yet can be uploaded
// from the picker — into that same library, so any product can reuse it:
//
//   POST /api/admin/upload            the library's own upload endpoint
//   POST /api/admin/products/image    Supabase Storage fallback (read-only host)
//     1. Supabase Storage, PUBLIC bucket `product-images` (production)
//     2. /img/uploads on a writable host (local development)
//     3. an inline data URL as the last resort
//
// This suite drives the REAL server (scratch JSON datastore — the committed
// dataset is never touched) and the REAL storefront + admin bundles (jsdom):
//
//   library    library rows are stored/served by the existing Website Images
//              endpoints — the picker reads real, persisted data.
//   picker     Add image opens the library over an editor that stays open;
//              selecting populates the gallery + preview; several images can be
//              added one after another; duplicates are refused; search works;
//              Done closes it; remove still works.
//   upload     a new photo goes through /api/admin/upload INTO the library (and
//              falls back to Supabase Storage on a read-only host), then is
//              added to the product and shown in the picker grid.
//   persist    Save stores the selected images; /api/data serves them and the
//              storefront gallery displays them.
//   api        the upload endpoint validates (no SVG, real bytes, no typed URL)
//              and requires an admin session.
//   compat     every pre-existing image (generated artwork, pasted public URL,
//              /img/uploads file) keeps working untouched.
//   new prod   the same picker works while creating a product.
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
async function bootAdmin(catalog, opts = {}) {
  const html = fs.readFileSync(path.join(PUBLIC, 'admin.html'), 'utf8');
  const calls = [];
  let uploadCount = 0;
  // opts.uploadStatus = 507 simulates a read-only host (Vercel), where the
  // library's own /api/admin/upload cannot write and the picker must fall back
  // to Supabase Storage.
  const uploadStatus = opts.uploadStatus || 200;
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
        // The media library's own upload endpoint (Admin → Website Images uses
        // exactly this call): a writable host answers with a served /img/uploads
        // URL, a read-only host answers 507.
        if (url.indexOf('/api/admin/upload') >= 0) {
          uploadCount += 1;
          if (uploadStatus !== 200) {
            return Promise.resolve({ ok: false, status: uploadStatus, json: () => Promise.resolve({ error: 'File uploads are not writable on this host — paste a public image URL instead.' }) });
          }
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, url: `/img/uploads/up_lib${uploadCount}.png` }) });
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
    console.log('\n== 6. Admin panel — "Add image" opens the existing media library ==');
    // The library the picker reads IS Admin → Website Images. The committed
    // dataset ships an empty one, so add two rows through the SAME endpoint that
    // screen uses and read them back from the server: the picker must offer
    // real, persisted library images — not a separate, second image system.
    const libRows = [
      { id: 'img_lib_test_1', name: 'carbon-key-case.jpg', url: 'https://cdn.test/library/carbon-key-case.jpg', section: 'general', alt: 'Carbon key case' },
      { id: 'img_lib_test_2', name: 'navy-key-holder.png', url: '/img/uploads/navy-key-holder.png', section: 'general', alt: 'Navy key holder' },
    ];
    for (const row of libRows) {
      const ins = await http('POST', '/api/admin/save', { collection: 'websiteImages', record: row }, { admin: true });
      check(`the library image "${row.name}" is stored by the existing Website Images endpoint`, ins.ok, JSON.stringify(ins.json).slice(0, 100));
    }
    const withLibrary = (await http('GET', '/api/admin/data', null, { admin: true })).json;
    check('/api/admin/data serves the library the picker reads',
      libRows.every((r) => (withLibrary.website_images || []).some((x) => x.url === r.url)),
      JSON.stringify((withLibrary.website_images || []).map((x) => x.url)));

    const admin = await bootAdmin(withLibrary);
    await admin.openProducts();
    const editBtn = admin.doc.querySelector(`[data-edit-product="${target.id}"]`) || admin.doc.querySelector('[data-edit-product]');
    admin.click(editBtn);
    await wait(120);

    const addBtn = admin.doc.querySelector('#btn-pick-product-image');
    check('the product editor has an "Add image" button', !!addBtn && /add image/i.test(addBtn.textContent), addBtn && addBtn.textContent);
    check('the editor does NOT ask for an image URL (that stays optional and collapsed)',
      !!admin.doc.querySelector('#product-image-url-box') && admin.doc.querySelector('#product-image-url-box').tagName === 'DETAILS'
      && admin.doc.querySelector('#product-image-url-box').open === false);
    const rowsBefore = [...admin.doc.querySelectorAll('#product-images-list [data-img-del]')];
    check('every existing product image is listed with its preview', rowsBefore.length === originalImages.length
      && admin.doc.querySelectorAll('#product-images-list img').length === originalImages.length, String(rowsBefore.length));
    check('the first existing image is still marked MAIN', /MAIN IMAGE/.test(admin.doc.querySelector('#product-images-list').textContent));

    // --- the picker opens, over an editor that stays open ---
    admin.click(addBtn);
    await wait(80);
    const picker = admin.doc.querySelector('#libpicker-grid');
    check('clicking Add image opens the image library picker', !!picker);
    check('the picker lists the library images as thumbnails',
      picker && picker.querySelectorAll('.image-preview-item img').length === libRows.length,
      String(picker && picker.querySelectorAll('.image-preview-item img').length));
    check('the picker shows the real library URLs',
      !!picker && libRows.every((r) => [...picker.querySelectorAll('img')].some((im) => im.getAttribute('src') === r.url)),
      picker && JSON.stringify([...picker.querySelectorAll('img')].map((i) => i.getAttribute('src'))));
    check('the picker reports how many images the library holds',
      /2 images in the library/.test((admin.doc.querySelector('#libpicker-count') || {}).textContent || ''),
      (admin.doc.querySelector('#libpicker-count') || {}).textContent);
    check('the product editor stays open underneath the picker (its gallery is not lost)',
      !!admin.doc.querySelector('#product-form') && !!admin.doc.querySelector('#product-images-list')
      && admin.doc.querySelectorAll('#product-images-list [data-img-del]').length === originalImages.length);

    // --- select an image → it populates the product gallery ---
    admin.click(picker.querySelector('.image-preview-item'));
    await wait(60);
    let rows = [...admin.doc.querySelectorAll('#product-images-list [data-img-del]')];
    check('selecting a library image adds it to the product automatically', rows.length === originalImages.length + 1, String(rows.length));
    check('the selected image is previewed in the product gallery',
      [...admin.doc.querySelectorAll('#product-images-list img')].some((im) => im.getAttribute('src') === libRows[0].url),
      JSON.stringify([...admin.doc.querySelectorAll('#product-images-list img')].map((i) => i.getAttribute('src'))));
    check('the picker marks the image as already added', /added/.test(picker.textContent), picker.textContent.replace(/\s+/g, ' ').slice(0, 80));
    check('the picker stays open so more images can be added', !!admin.doc.querySelector('#libpicker-grid'));

    // --- multiple product images, one selection at a time ---
    admin.click(admin.doc.querySelectorAll('#libpicker-grid .image-preview-item')[1]);
    await wait(60);
    rows = [...admin.doc.querySelectorAll('#product-images-list [data-img-del]')];
    check('a second library image is added the same way (multiple product images)', rows.length === originalImages.length + 2, String(rows.length));
    check('both selected URLs are in the product gallery',
      [...admin.doc.querySelectorAll('#product-images-list img')].some((im) => im.getAttribute('src') === libRows[1].url)
      && [...admin.doc.querySelectorAll('#product-images-list img')].some((im) => im.getAttribute('src') === libRows[0].url));
    admin.click(admin.doc.querySelectorAll('#libpicker-grid .image-preview-item')[0]);
    await wait(60);
    rows = [...admin.doc.querySelectorAll('#product-images-list [data-img-del]')];
    check('selecting the same image again does not duplicate it', rows.length === originalImages.length + 2, String(rows.length));
    check('the picker counted exactly the two images added', /2 added to this product/.test((admin.doc.querySelector('#libpicker-count') || {}).textContent || ''),
      (admin.doc.querySelector('#libpicker-count') || {}).textContent);

    // --- search inside the picker ---
    const search = admin.doc.querySelector('#libpicker-search');
    search.value = 'navy';
    search.dispatchEvent(new admin.window.Event('input', { bubbles: true }));
    await wait(40);
    check('the library can be searched', admin.doc.querySelectorAll('#libpicker-grid .image-preview-item').length === 1,
      String(admin.doc.querySelectorAll('#libpicker-grid .image-preview-item').length));
    search.value = '';
    search.dispatchEvent(new admin.window.Event('input', { bubbles: true }));
    await wait(40);
    check('clearing the search shows the whole library again',
      admin.doc.querySelectorAll('#libpicker-grid .image-preview-item').length === libRows.length);

    // --- Done closes the picker, the editor keeps the selection ---
    admin.click([...admin.doc.querySelectorAll('[data-libpicker-close]')].pop());
    await wait(60);
    check('Done closes the picker', !admin.doc.querySelector('#libpicker-grid'));
    check('the product editor and its gallery survive the picker',
      !!admin.doc.querySelector('#product-form')
      && admin.doc.querySelectorAll('#product-images-list [data-img-del]').length === originalImages.length + 2);

    // --- removing an image still works ---
    admin.click(admin.doc.querySelector(`#product-images-list [data-img-del="${originalImages.length + 1}"]`));
    await wait(50);
    rows = [...admin.doc.querySelectorAll('#product-images-list [data-img-del]')];
    check('an image can still be removed from the product gallery', rows.length === originalImages.length + 1, String(rows.length));

    // --- Save persists the selected library image with the product ---
    admin.click(admin.doc.querySelector('#btn-save-product'));
    await wait(140);
    const saveCall = admin.calls.filter((c) => c.url.indexOf('/api/admin/save') >= 0 && c.body && c.body.collection === 'products').pop();
    check('Save posts the product with the library image in its gallery',
      !!saveCall && Array.isArray(saveCall.body.record.images)
      && saveCall.body.record.images.length === originalImages.length + 1
      && originalImages.every((u, i) => saveCall.body.record.images[i] === u)
      && saveCall.body.record.images[originalImages.length] === libRows[0].url,
      JSON.stringify(saveCall && saveCall.body && saveCall.body.record && saveCall.body.record.images));
    check('main_image still follows the first gallery image',
      !!saveCall && saveCall.body.record.main_image === saveCall.body.record.images[0]);
    check('the rest of the product form is untouched by the picker',
      !!saveCall && saveCall.body.record.price === target.price && saveCall.body.record.brandSlug === target.brandSlug
      && saveCall.body.record.name_en === target.name_en);
    admin.dom.window.close();

    // --- the saved selection really persists and is served publicly ---
    await http('POST', '/api/admin/save', {
      collection: 'products',
      record: Object.assign({}, target, { images: originalImages.concat([libRows[0].url]), main_image: originalImages[0] }),
    }, { admin: true });
    pub = (await http('GET', '/api/data')).json;
    live = pub.products.find((p) => p.id === target.id);
    check('the server persisted the selected library image on the product',
      !!live && live.images[live.images.length - 1] === libRows[0].url, JSON.stringify(live && live.images));
    const domLib = await bootStorefront(pub);
    domLib.window.location.hash = '#/product/' + target.slug;
    domLib.window.dispatchEvent(new domLib.window.HashChangeEvent('hashchange'));
    await wait(120);
    const libThumb = [...domLib.window.document.querySelectorAll('.thumbs .thumb img')];
    check('the storefront product gallery displays the selected image',
      libThumb.some((im) => im.getAttribute('src') === libRows[0].url), JSON.stringify(libThumb.map((i) => i.getAttribute('src'))));
    domLib.window.close();
    await http('POST', '/api/admin/save', { collection: 'products', record: Object.assign({}, target, { images: originalImages, main_image: originalImages[0] }) }, { admin: true });

    // ------------------------------------------------------------------ 7
    console.log('\n== 7. Admin panel — uploading a new photo from the picker feeds the SAME library ==');
    const admin2 = await bootAdmin(withLibrary);
    await admin2.openProducts();
    admin2.click(admin2.doc.querySelector(`[data-edit-product="${target.id}"]`) || admin2.doc.querySelector('[data-edit-product]'));
    await wait(120);
    admin2.click(admin2.doc.querySelector('#btn-pick-product-image'));
    await wait(80);
    const libFile = admin2.doc.querySelector('#libpicker-file');
    const libUpload = admin2.doc.querySelector('#libpicker-upload');
    check('the picker offers "Upload a new photo" for images that are not in the library yet', !!libUpload && /upload/i.test(libUpload.textContent));
    check('it is a real hidden file input (the device gallery on iOS/Android)',
      !!libFile && libFile.getAttribute('type') === 'file' && (libFile.getAttribute('accept') || '').indexOf('image') >= 0
      && /display:\s*none/.test(libFile.getAttribute('style') || ''), libFile && libFile.outerHTML);
    let devicePickerOpened = 0;
    libFile.click = () => { devicePickerOpened += 1; };
    admin2.click(libUpload);
    await wait(30);
    check('tapping it opens the device photo picker', devicePickerOpened === 1, String(devicePickerOpened));

    await admin2.pickFile(libFile, 'new-product-photo.png', 'image/png');
    const libUploadCall = admin2.calls.find((c) => c.url.indexOf('/api/admin/upload') >= 0);
    check('the photo is uploaded through the library\'s existing endpoint', !!libUploadCall
      && typeof libUploadCall.body.dataUrl === 'string' && libUploadCall.body.dataUrl.indexOf('data:image/png') === 0,
      JSON.stringify(libUploadCall && Object.keys(libUploadCall.body || {})));
    const libInsert = admin2.calls.filter((c) => c.url.indexOf('/api/admin/save') >= 0 && c.body && c.body.collection === 'websiteImages').pop();
    check('the uploaded photo is saved INTO the media library (reusable by every product)',
      !!libInsert && libInsert.body.record.url === '/img/uploads/up_lib1.png' && !!libInsert.body.record.id,
      JSON.stringify(libInsert && libInsert.body && libInsert.body.record));
    check('the uploaded photo is added to the product gallery automatically',
      [...admin2.doc.querySelectorAll('#product-images-list img')].some((im) => im.getAttribute('src') === '/img/uploads/up_lib1.png'),
      JSON.stringify([...admin2.doc.querySelectorAll('#product-images-list img')].map((i) => i.getAttribute('src'))));
    check('the uploaded photo now appears in the picker grid too',
      [...admin2.doc.querySelectorAll('#libpicker-grid img')].some((im) => im.getAttribute('src') === '/img/uploads/up_lib1.png'));
    check('the file input is reset so the same photo can be picked again', libFile.value === '', libFile.value);
    admin2.dom.window.close();

    // Read-only host (Vercel): /api/admin/upload answers 507, so the picker
    // falls back to Supabase Storage — the admin is never stuck.
    const admin3 = await bootAdmin(withLibrary, { uploadStatus: 507 });
    await admin3.openProducts();
    admin3.click(admin3.doc.querySelector(`[data-edit-product="${target.id}"]`) || admin3.doc.querySelector('[data-edit-product]'));
    await wait(120);
    admin3.click(admin3.doc.querySelector('#btn-pick-product-image'));
    await wait(80);
    await admin3.pickFile(admin3.doc.querySelector('#libpicker-file'), 'iphone-photo.png', 'image/png');
    const fallbackCall = admin3.calls.find((c) => c.url.indexOf('/api/admin/products/image') >= 0);
    check('on a read-only host the upload falls back to Supabase Storage', !!fallbackCall
      && typeof fallbackCall.body.dataUrl === 'string' && fallbackCall.body.dataUrl.indexOf('data:image/png') === 0,
      JSON.stringify(admin3.calls.filter((c) => c.url.indexOf('/api/admin/upload') >= 0 || c.url.indexOf('/api/admin/products/image') >= 0).map((c) => c.url)));
    check('the Storage URL is added to the product gallery',
      [...admin3.doc.querySelectorAll('#product-images-list img')].some((im) => (im.getAttribute('src') || '').indexOf('/object/public/product-images/products/') >= 0),
      JSON.stringify([...admin3.doc.querySelectorAll('#product-images-list img')].map((i) => i.getAttribute('src'))));
    check('the Storage URL is saved into the library as well',
      admin3.calls.some((c) => c.url.indexOf('/api/admin/save') >= 0 && c.body && c.body.collection === 'websiteImages'
        && String(c.body.record.url).indexOf('/object/public/product-images/products/') >= 0));
    admin3.dom.window.close();

    // ------------------------------------------------------------------ 7b
    console.log('\n== 7b. Admin panel — creating a NEW product from library images ==');
    const admin4 = await bootAdmin(withLibrary);
    await admin4.openProducts();
    admin4.click(admin4.doc.querySelector('#btn-add-product'));
    await wait(120);
    check('the Add Product editor has the same Add image button', !!admin4.doc.querySelector('#btn-pick-product-image'));
    check('a new product starts with an empty gallery',
      admin4.doc.querySelectorAll('#product-images-list [data-img-del]').length === 0
      && /No images yet/.test(admin4.doc.querySelector('#product-images-list').textContent));
    admin4.click(admin4.doc.querySelector('#btn-pick-product-image'));
    await wait(80);
    check('the library picker opens for a product that does not exist yet', !!admin4.doc.querySelector('#libpicker-grid')
      && !!admin4.doc.querySelector('#product-form'));
    admin4.click(admin4.doc.querySelector('#libpicker-grid .image-preview-item'));
    await wait(60);
    check('the selected image becomes the new product\'s first (main) image',
      admin4.doc.querySelectorAll('#product-images-list [data-img-del]').length === 1
      && /MAIN IMAGE/.test(admin4.doc.querySelector('#product-images-list').textContent));
    admin4.click([...admin4.doc.querySelectorAll('[data-libpicker-close]')].pop());
    await wait(50);
    admin4.doc.querySelector('#product-form [name=name_en]').value = 'Test Library Product';
    admin4.doc.querySelector('#product-form [name=price]').value = '1500';
    const catSelect = admin4.doc.querySelector('#product-form [name=category]');
    if (catSelect && !catSelect.value && catSelect.options.length > 1) catSelect.value = catSelect.options[1].value;
    const brandSelect = admin4.doc.querySelector('#product-form [name=brandSlug]');
    if (brandSelect && !brandSelect.value && brandSelect.options.length > 1) brandSelect.value = brandSelect.options[1].value;
    admin4.click(admin4.doc.querySelector('#btn-save-product'));
    await wait(140);
    const createCall = admin4.calls.filter((c) => c.url.indexOf('/api/admin/save') >= 0 && c.body && c.body.collection === 'products').pop();
    check('creating the product stores the selected library image',
      !!createCall && createCall.body.record.name_en === 'Test Library Product'
      && (createCall.body.record.images || []).length === 1 && createCall.body.record.images[0] === libRows[0].url,
      JSON.stringify(createCall && createCall.body && createCall.body.record && createCall.body.record.images));
    check('main_image is set from the selected image', !!createCall && createCall.body.record.main_image === libRows[0].url);
    admin4.dom.window.close();

    // The library rows this suite added are removed again, so the scratch store
    // is left as it was found.
    for (const row of libRows) await http('POST', '/api/admin/delete', { collection: 'websiteImages', id: row.id }, { admin: true });

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
