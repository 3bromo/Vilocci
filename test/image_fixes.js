'use strict';
// ============================================================================
// Image fixes — product card image, Admin "Upload Image" button, PDP swipe
// ----------------------------------------------------------------------------
// Three storefront / admin regressions, driven against the REAL bundles
// (public/js/app.js, public/js/admin-app.js) in jsdom:
//
//   card     a product with no images (or an image that fails to load) shows
//            the generated artwork for its category + brand, never the
//            non-existent /img/detail_a.png; product <img>s carry a
//            data-fallback that the document-level error handler applies once.
//   gallery  the PDP thumbnails switch the main image (the old handler looked
//            the product up by id with a slug and threw), and a horizontal
//            touch swipe on the main image moves to the next / previous image
//            — mirrored in RTL — while a vertical swipe / tap does nothing.
//   upload   Admin → Website Images: the toolbar's "📤 Upload Image" button
//            opens the hidden file input, a picked file is uploaded through
//            /api/admin/upload and saved as a website_images row, and the
//            drop zone accepts a dropped file.
//
// Usage: node test/image_fixes.js
// ============================================================================

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

let pass = 0; let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓', name); }
  else { fail += 1; console.log('  ✗', name, extra !== undefined ? `→ ${extra}` : ''); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The committed dataset through the server's own public-payload shaping, so
// the storefront boots on exactly what /api/data serves.
async function publicPayload() {
  process.env.DATA_DRIVER = 'json';
  const db = require(path.join(ROOT, 'lib', 'db.js'));
  return db.publicPayload(await db.getCatalog());
}

async function bootStorefront(payload, opts = {}) {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (e) => { if (!/Could not load|Not implemented/.test(e.message)) errors.push(e.message); });
  const dom = new JSDOM(html, {
    virtualConsole,
    url: 'http://localhost:3000/' + (opts.hash || ''),
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (u) => {
        const url = typeof u === 'string' ? u : u.url;
        if (url.indexOf('/api/data') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      };
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.alert = () => {};
      window.confirm = () => true;
      window.scrollTo = () => {};
      window.console.error = (...a) => errors.push(a.map(String).join(' '));
    },
  });
  dom.window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'engine.js'), 'utf8'));
  dom.window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8'));
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !dom.window.document.querySelector('#brand-strip')) await wait(50);
  await wait(150);
  return { dom, errors };
}

function touch(window, el, type, x, y) {
  // jsdom has no TouchEvent constructor with touches; a plain Event carrying
  // the same fields is what the handler reads.
  const ev = new window.Event(type, { bubbles: true, cancelable: true });
  const pt = { clientX: x, clientY: y };
  Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : [pt] });
  Object.defineProperty(ev, 'changedTouches', { value: [pt] });
  el.dispatchEvent(ev);
}
function swipe(window, el, dx, dy) {
  touch(window, el, 'touchstart', 200, 200);
  touch(window, el, 'touchend', 200 + dx, 200 + (dy || 0));
}

async function bootAdmin(catalog) {
  const html = fs.readFileSync(path.join(PUBLIC, 'admin.html'), 'utf8');
  const calls = [];
  const inserted = [];
  let uploadCount = 0;
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => { if (!/Could not load|Not implemented/.test(e.message)) console.log('  ! page error:', e.message); });
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
      window.setInterval = () => realSetInterval(() => {}, 2147483000);
      window.fetch = (u, o = {}) => {
        const url = typeof u === 'string' ? u : u.url;
        let body = null;
        try { body = o.body ? JSON.parse(o.body) : null; } catch (e) { body = null; }
        calls.push({ url, method: o.method || 'GET', body });
        if (url.indexOf('/api/admin/config') >= 0) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ url: 'https://testproject.supabase.co', anonKey: 'fake-anon-key-0123456789-abcdefghijklmnopqrstuvwxyz' }) });
        }
        if (url.indexOf('/api/admin/data') >= 0) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(catalog) });
        if (url.indexOf('/api/admin/diagnose') >= 0) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ probe: { ok: true, servedBy: 'json' }, issues: [] }) });
        if (url.indexOf('/api/admin/upload') >= 0) {
          uploadCount += 1;
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, url: `https://testproject.supabase.co/storage/v1/object/public/product-images/library/lib_${uploadCount}.png`, storage: 'supabase-storage' }) });
        }
        if (/\/api\/admin\/(website_images|collections\/website_images|insert)/.test(url) || (body && body.table === 'website_images')) {
          inserted.push(body);
        }
        if (url.indexOf('website_images') >= 0 && (o.method || 'GET') !== 'GET') inserted.push({ url, body });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
      };
      window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'admin-app.js'), 'utf8'));
    },
  });
  await wait(400);
  const { window } = dom;
  const doc = window.document;
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const makeFile = (name) => new window.File([Buffer.from(TINY_PNG.split(',')[1], 'base64')], name || 'photo.png', { type: 'image/png' });
  return { dom, window, doc, calls, click, makeFile, uploads: () => uploadCount };
}

(async function main() {
  const payload = await publicPayload();
  const products = payload.products;
  const sample = products.find((p) => (p.images || []).length >= 3) || products[0];

  // -------------------------------------------------------------------------
  console.log('\n== 1. Product card image ==');
  // -------------------------------------------------------------------------
  const noImage = Object.assign({}, sample, { id: 'p_test_noimage', slug: 'test-no-image', images: [], name_en: 'No Image Test', featured: true, newArrival: true, new_arrival: true });
  const blankImage = Object.assign({}, sample, { id: 'p_test_blank', slug: 'test-blank-image', images: ['', '  ', '/img/asset.svg?type=detail-b&brand=' + sample.brandSlug], name_en: 'Blank Image Test', featured: true, newArrival: true, new_arrival: true });
  const payloadCards = Object.assign({}, payload, { products: [noImage, blankImage].concat(products) });
  {
    const { dom, errors } = await bootStorefront(payloadCards, { hash: '#/category/' + sample.category });
    const doc = dom.window.document;
    const html = doc.body.innerHTML;
    check('the storefront renders product cards', doc.querySelectorAll('.product-card').length > 0);
    check('no product image points at the non-existent /img/detail_a.png', html.indexOf('/img/detail_a.png') === -1);
    const cardNo = doc.querySelector(`.product-card[data-slug="${noImage.slug}"] .media img`);
    const expected = `/img/asset.svg?type=${encodeURIComponent(noImage.category)}&brand=${encodeURIComponent(noImage.brandSlug)}`;
    check('a product without images shows the generated artwork for its category + brand', !!cardNo && cardNo.getAttribute('src') === expected, cardNo && cardNo.getAttribute('src'));
    const cardBlank = doc.querySelector(`.product-card[data-slug="${blankImage.slug}"] .media img`);
    check('blank entries in products.images are skipped — the first real image is the main one', !!cardBlank && cardBlank.getAttribute('src') === blankImage.images[2], cardBlank && cardBlank.getAttribute('src'));
    const cardReal = doc.querySelector(`.product-card[data-slug="${sample.slug}"] .media img`);
    check('a product with images still shows its first image (unchanged)', !!cardReal && cardReal.getAttribute('src') === sample.images[0]);
    check('every product-card image carries the artwork fallback', [...doc.querySelectorAll('.product-card .media img')].every((im) => /^\/img\/asset\.svg\?type=/.test(im.getAttribute('data-fallback') || '')));

    // a broken image swaps to the artwork exactly once (capture-phase error handler)
    if (cardReal) {
      cardReal.dispatchEvent(new dom.window.Event('error', { bubbles: false }));
      check('an image that fails to load is swapped for the generated artwork', cardReal.getAttribute('src') === `/img/asset.svg?type=${encodeURIComponent(sample.category)}&brand=${encodeURIComponent(sample.brandSlug)}`, cardReal.getAttribute('src'));
      check('the fallback is applied once (data-fallback removed, no loop)', !cardReal.hasAttribute('data-fallback'));
      const srcAfter = cardReal.getAttribute('src');
      cardReal.dispatchEvent(new dom.window.Event('error', { bubbles: false }));
      check('a second error leaves the artwork in place', cardReal.getAttribute('src') === srcAfter);
    }
    check('no script errors while rendering the cards', errors.length === 0, errors.join(' | '));
    dom.window.close();
  }

  // -------------------------------------------------------------------------
  console.log('\n== 2. PDP gallery — thumbnails + mobile swipe ==');
  // -------------------------------------------------------------------------
  {
    const { dom, errors } = await bootStorefront(payload, { hash: '#/product/' + sample.slug });
    const { window } = dom;
    const doc = window.document;
    await wait(150);
    const main = () => doc.querySelector('#gallery-main');
    const thumbs = () => [...doc.querySelectorAll('[data-thumb]')];
    const activeIdx = () => thumbs().findIndex((t) => t.classList.contains('active'));
    check('the product page renders a gallery with one thumbnail per image', !!main() && thumbs().length === sample.images.length, String(thumbs().length));
    check('the main image starts on the first image', main() && main().getAttribute('src') === sample.images[0]);

    thumbs()[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    check('clicking a thumbnail switches the main image (no exception)', main().getAttribute('src') === sample.images[1], main().getAttribute('src'));
    check('the clicked thumbnail becomes active', activeIdx() === 1, String(activeIdx()));
    check('no script errors on thumbnail click', errors.length === 0, errors.join(' | '));

    const area = doc.querySelector('.gallery .main');
    swipe(window, area, -120, 5);
    check('swiping left on the main image shows the next image', main().getAttribute('src') === sample.images[2] && activeIdx() === 2, main().getAttribute('src'));
    swipe(window, area, -120, 0);
    check('swiping past the last image wraps to the first', main().getAttribute('src') === sample.images[0] && activeIdx() === 0, main().getAttribute('src'));
    swipe(window, area, 120, 0);
    check('swiping right shows the previous image (wraps to the last)', main().getAttribute('src') === sample.images[sample.images.length - 1], main().getAttribute('src'));
    const before = main().getAttribute('src');
    swipe(window, area, 10, 0);
    check('a short movement (a tap) does not change the image', main().getAttribute('src') === before);
    swipe(window, area, -60, -140);
    check('a mostly-vertical swipe (page scroll) does not change the image', main().getAttribute('src') === before);

    // RTL mirrors the direction
    doc.documentElement.setAttribute('dir', 'rtl');
    const idxBefore = activeIdx();
    swipe(window, area, 120, 0);
    check('in RTL a swipe to the right moves forward', activeIdx() === (idxBefore + 1) % sample.images.length, String(activeIdx()));
    doc.documentElement.setAttribute('dir', 'ltr');

    check('every gallery image carries the artwork fallback', [...doc.querySelectorAll('.gallery img')].every((im) => /^\/img\/asset\.svg\?type=/.test(im.getAttribute('data-fallback') || '')));
    check('the main image keeps vertical page scrolling (touch-action: pan-y in the mobile rules)', /\.gallery \.main\s*\{[^}]*touch-action:\s*pan-y/.test(fs.readFileSync(path.join(PUBLIC, 'css', 'styles.css'), 'utf8')));
    check('no script errors during swipes', errors.length === 0, errors.join(' | '));
    dom.window.close();
  }

  // -------------------------------------------------------------------------
  console.log('\n== 3. Admin → Website Images — the Upload Image button ==');
  // -------------------------------------------------------------------------
  {
    const store = require(path.join(ROOT, 'lib', 'store.js'));
    const catalog = Object.assign({}, store.load(), { website_images: [] });
    const { dom, window, doc, calls, click, makeFile, uploads } = await bootAdmin(catalog);
    const nav = [...doc.querySelectorAll('[data-nav]')].find((a) => a.getAttribute('data-nav') === 'images');
    check('Admin has a Website Images screen', !!nav);
    if (nav) click(nav);
    await wait(120);
    const btn = () => doc.querySelector('#btn-upload-image');
    const input = () => doc.querySelector('#image-file-input');
    check('the toolbar shows the "📤 Upload Image" button', !!btn() && /Upload Image/.test(btn().textContent));
    check('a hidden file input (device picker) is present and accepts images', !!input() && input().type === 'file' && /image/.test(input().accept || ''));

    let opened = 0;
    input().click = () => { opened += 1; };
    click(btn());
    check('clicking "Upload Image" opens the device file picker', opened === 1, String(opened));

    // pick a file → uploaded → saved into the library → grid re-rendered
    const file = makeFile('showroom.png');
    Object.defineProperty(input(), 'files', { value: [file], configurable: true });
    input().dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(400);
    check('the picked photo is posted to /api/admin/upload as an image data URL', calls.some((c) => c.url.indexOf('/api/admin/upload') >= 0 && c.method === 'POST' && c.body && /^data:image\//.test(c.body.dataUrl || '')));
    const grid = doc.querySelector('.image-preview-grid');
    check('the uploaded image appears in the library grid', !!grid && grid.innerHTML.indexOf('library/lib_1.png') >= 0);
    check('the upload button is enabled again with its label restored', btn() && !btn().disabled && /Upload Image/.test(btn().textContent));
    check('exactly one upload call was made for one file', uploads() === 1, String(uploads()));

    // drag & drop onto the zone
    const zone = doc.querySelector('#upload-zone');
    check('the drop zone is rendered', !!zone);
    const over = new window.Event('dragover', { bubbles: true, cancelable: true });
    zone.dispatchEvent(over);
    check('dragging over the zone is accepted (default prevented) and highlighted', over.defaultPrevented && zone.classList.contains('dragover'));
    const drop = new window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [makeFile('dropped.png')] } });
    zone.dispatchEvent(drop);
    await wait(400);
    check('a dropped file is uploaded too', uploads() === 2, String(uploads()));
    const grid2 = doc.querySelector('.image-preview-grid');
    check('the dropped image appears in the library grid', !!grid2 && grid2.innerHTML.indexOf('library/lib_2.png') >= 0);

    // a non-image drop is refused without an upload
    const dropBad = new window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(dropBad, 'dataTransfer', { value: { files: [new window.File(['x'], 'notes.txt', { type: 'text/plain' })] } });
    doc.querySelector('#upload-zone').dispatchEvent(dropBad);
    await wait(200);
    check('a non-image file is refused (no upload call)', uploads() === 2, String(uploads()));
    dom.window.close();
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('IMAGE FIXES ERROR:', e); process.exit(1); });
