'use strict';
// ============================================================================
// Shape images — one uploaded visual per key shape (build 20260919b)
// ----------------------------------------------------------------------------
// The shape's image belongs to the catalogue shape itself (Admin → Shapes),
// never to one product: the Shapes screen and the Products editor's Key
// Shapes rows both manage the same file through
//   POST /api/admin/shapes/image          (upload dataUrl or paste a URL)
//   POST /api/admin/shapes/image/remove   (clear it)
// and every storefront selector renders it (PDP, Quick Add, Fitment Finder,
// Key Guide), falling back to the generated silhouette when a shape has no
// image — exactly the pre-feature look.
//
// This suite drives the REAL server (scratch JSON datastore — the committed
// dataset is never touched) and the REAL storefront + admin bundles (jsdom):
//
//   api        /api/data serves image_url on every shape; upload / replace /
//              remove persist; validation + admin auth enforced.
//   rules      a shape with an image stays fully orderable; products' own
//              availability flags and the catalogue hide-rule are unchanged.
//   storefront image shapes render as <img class="shape-img"> cards; shapes
//              without an image keep the SVG silhouette.
//   admin ui   the Products editor's Key Shapes rows expose Name EN / Name
//              AR / upload / preview / replace / remove; the Shapes table and
//              the shape editor expose the same controls.
//   migration  009_shape_images.sql ships with the CLI (additive only).
//
// Usage: npm run test:shapeimages
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const PORT = 3497;
const API = `http://127.0.0.1:${PORT}`;
const DEV_TOKEN = 'shape-images-test-token-' + Date.now().toString(36);

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
// Storefront boot (jsdom) — same harness as test/shapes_admin.js.
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
        if (url.indexOf('/api/orders') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, orderId: 'ORD-SHAPEIMG', total: 100 }) });
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
// shape-image endpoints the way the real server does ({ ok, url }).
// ---------------------------------------------------------------------------
async function bootAdmin(catalog) {
  const html = fs.readFileSync(path.join(PUBLIC, 'admin.html'), 'utf8');
  const calls = [];
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
        // The Shapes screen's status strip reads this endpoint.
        if (url.indexOf('/api/admin/diagnose') >= 0) {
          const shapes = catalog.shapes || [];
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
            probe: { ok: true, servedBy: 'postgrest' },
            issues: [],
            shapeImages: {
              column: { present: true, mode: 'postgrest' },
              rowCount: shapes.length,
              rowsWithImage: shapes.filter((s) => s.image_url).length,
              rows: shapes.map((s) => ({
                id: s.id, code: s.code, name_en: s.name_en,
                active: s.active !== false, image_url: s.image_url || '',
              })),
              storage: { configured: true, bucket: 'shape-images', public: true, exists: true, objects: shapes.filter((s) => s.image_url).length, error: null },
            },
          }) });
        }
        if (url.indexOf('/api/admin/shapes/image/remove') >= 0) {
          const s = (catalog.shapes || []).find((x) => body && x.id === body.shapeId);
          if (s) s.image_url = '';
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, shapeId: body && body.shapeId }) });
        }
        if (url.indexOf('/api/admin/shapes/image') >= 0) {
          const stored = (body && body.url) || 'https://cdn.test/uploaded-shape.png';
          const s = (catalog.shapes || []).find((x) => body && x.id === body.shapeId);
          if (s) s.image_url = stored;
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, url: stored, storage: 'test', shapeId: body && body.shapeId }) });
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
  return { dom, window, doc, calls, click };
}

(async function main() {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vilocci-shapeimg-'));
  const scratchDb = path.join(scratchDir, 'velocci-db.json');
  fs.copyFileSync(path.join(ROOT, 'data', 'velocci-db.json'), scratchDb);

  const srv = startServer(PORT, scratchDb);
  try {
    const up = await waitForServer(srv.child, API);
    if (!up) { console.error('server did not start\n', srv.log()); process.exit(1); }

    // ------------------------------------------------------------------ 1
    console.log('\n== 1. Public API — every served shape carries image_url ==');
    const data0 = (await http('GET', '/api/data')).json;
    check('/api/data serves the catalogue with an image_url field on every shape',
      Array.isArray(data0.shapes) && data0.shapes.length >= 4
      && data0.shapes.every((s) => Object.prototype.hasOwnProperty.call(s, 'image_url')),
      JSON.stringify(data0.shapes && data0.shapes[0]));
    check('no shape starts with an image (nothing hard-coded)', data0.shapes.every((s) => !s.image_url));

    // ------------------------------------------------------------------ 2
    console.log('\n== 2. Upload — the image persists on the shape itself ==');
    const uploaded = await http('POST', '/api/admin/shapes/image', { shapeId: 'shape_b', dataUrl: TINY_PNG }, { admin: true });
    check('uploading a shape image succeeds', uploaded.ok && uploaded.json.ok, JSON.stringify(uploaded.json));
    check('the upload reports where the image was stored', !!uploaded.json.storage, JSON.stringify(uploaded.json));
    let pub = (await http('GET', '/api/data')).json;
    const bAfter = pub.shapes.find((s) => s.code === 'B');
    check('/api/data now serves the stored image for Shape B', !!bAfter && !!bAfter.image_url && bAfter.image_url.startsWith('data:image/png'), JSON.stringify(bAfter && bAfter.image_url || '').slice(0, 60));
    check('the other shapes keep no image', pub.shapes.filter((s) => s.code !== 'B').every((s) => !s.image_url));
    const adminData = (await http('GET', '/api/admin/data', null, { admin: true })).json;
    check('the admin payload carries the image too', (adminData.shapes.find((s) => s.code === 'B') || {}).image_url === bAfter.image_url);

    // ------------------------------------------------------------------ 3
    console.log('\n== 3. Paste-a-URL + replace ==');
    const pasted = await http('POST', '/api/admin/shapes/image', { shapeId: 'shape_a', url: 'https://example.com/shape-a.png' }, { admin: true });
    pub = (await http('GET', '/api/data')).json;
    check('a pasted public URL is stored as the shape image', pasted.ok && (pub.shapes.find((s) => s.code === 'A') || {}).image_url === 'https://example.com/shape-a.png');
    await http('POST', '/api/admin/shapes/image', { shapeId: 'shape_a', url: 'https://example.com/shape-a-v2.png' }, { admin: true });
    pub = (await http('GET', '/api/data')).json;
    check('uploading again REPLACES the previous image', (pub.shapes.find((s) => s.code === 'A') || {}).image_url === 'https://example.com/shape-a-v2.png');

    // ------------------------------------------------------------------ 4
    console.log('\n== 4. Remove — back to the silhouette fallback ==');
    const removed = await http('POST', '/api/admin/shapes/image/remove', { shapeId: 'shape_a' }, { admin: true });
    pub = (await http('GET', '/api/data')).json;
    check('removing clears the stored image', removed.ok && !(pub.shapes.find((s) => s.code === 'A') || {}).image_url);

    // ------------------------------------------------------------------ 5
    console.log('\n== 5. Validation & auth ==');
    const noToken = await http('POST', '/api/admin/shapes/image', { shapeId: 'shape_b', dataUrl: TINY_PNG });
    check('unauthenticated uploads are refused', noToken.status === 401, String(noToken.status));
    const noTokenRm = await http('POST', '/api/admin/shapes/image/remove', { shapeId: 'shape_b' });
    check('unauthenticated removes are refused', noTokenRm.status === 401, String(noTokenRm.status));
    const unknown = await http('POST', '/api/admin/shapes/image', { shapeId: 'shape_zzz', dataUrl: TINY_PNG }, { admin: true });
    check('an unknown shape is refused', unknown.status === 404, JSON.stringify(unknown.json));
    const empty = await http('POST', '/api/admin/shapes/image', { shapeId: 'shape_b' }, { admin: true });
    check('a request with no image at all is refused', empty.status === 400, JSON.stringify(empty.json));
    const notImage = await http('POST', '/api/admin/shapes/image', { shapeId: 'shape_b', dataUrl: 'data:text/plain;base64,aGVsbG8=' }, { admin: true });
    check('a non-image data URL is refused', notImage.status === 400, JSON.stringify(notImage.json));
    const badUrl = await http('POST', '/api/admin/shapes/image', { shapeId: 'shape_b', url: 'javascript:alert(1)' }, { admin: true });
    check('a non http(s) URL is refused', badUrl.status === 400, JSON.stringify(badUrl.json));

    // ------------------------------------------------------------------ 6
    console.log('\n== 6. Order rules — an imaged shape stays fully sellable ==');
    const cust = { fullName: 'Shape Img Tester', phone: '+201011112222', city: 'Cairo', address: '1 Test Street' };
    const prodC = adminData.products.find((p) => (p.keyShapes || []).some((s) => s.shape === 'C' && s.available));
    const firstColor = (p) => ((p.colors || []).find((c) => c.enabled !== false) || {}).id;
    await http('POST', '/api/admin/shapes/image', { shapeId: 'shape_c', url: 'https://example.com/shape-c.png' }, { admin: true });
    const orderRes = await http('POST', '/api/orders', { cart: [{ productId: prodC.id, keyShape: 'C', qty: 1, colorId: firstColor(prodC) }], customer: cust, payment: 'Cash on Delivery' });
    let orderShape = null;
    if (orderRes.ok) {
      const detail = await http('GET', `/api/admin/order/${orderRes.json.orderId}`, null, { admin: true });
      orderShape = detail.json.items[0].keyShape;
    }
    check('an order for a shape WITH an image keeps the shape', orderRes.status === 200 && orderShape === 'C', JSON.stringify({ status: orderRes.status, orderShape }));
    await http('POST', '/api/admin/shapes/image/remove', { shapeId: 'shape_c' }, { admin: true });

    // ------------------------------------------------------------------ 7
    console.log('\n== 7. Storefront — image cards with the silhouette fallback ==');
    await http('POST', '/api/admin/shapes/image', { shapeId: 'shape_b', url: 'https://cdn.test/shape-b.png' }, { admin: true });
    const pubImg = (await http('GET', '/api/data')).json;
    const pdpProduct = pubImg.products.find((p) => (p.keyShapes || []).some((s) => s.shape === 'B' && s.available) && (p.keyShapes || []).some((s) => s.shape === 'A'));
    const dom = await bootStorefront(pubImg);
    const doc = dom.window.document;
    doc.defaultView.location.hash = '#/product/' + pdpProduct.slug;
    doc.defaultView.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
    await wait(90);
    const bBtn = doc.querySelector('.shape-opt[data-shape="B"]');
    const aBtn = doc.querySelector('.shape-opt[data-shape="A"]');
    const bImg = bBtn && bBtn.querySelector('img.shape-img');
    check('the PDP renders the uploaded Shape B image as a visual card', !!bImg && bImg.getAttribute('src') === 'https://cdn.test/shape-b.png', bBtn && bBtn.innerHTML.slice(0, 80));
    check('a shape WITHOUT an image keeps the generated silhouette on the PDP', !!aBtn && !aBtn.querySelector('img.shape-img') && !!aBtn.querySelector('svg'));
    check('the image card keeps the catalogue label', !!bBtn && /Shape B|الشكل B/.test(bBtn.textContent));

    // A stored URL that turns out to be dead (file deleted, bucket renamed,
    // typo) must never leave an empty card: the error listener swaps the <img>
    // back to the generated silhouette.
    if (bImg) {
      bImg.dispatchEvent(new dom.window.Event('error'));
      await wait(30);
      const bBtnAfter = doc.querySelector('.shape-opt[data-shape="B"]');
      check('a broken image URL falls back to the silhouette',
        !!bBtnAfter && !bBtnAfter.querySelector('img.shape-img') && !!bBtnAfter.querySelector('svg'),
        bBtnAfter && bBtnAfter.innerHTML.slice(0, 80));
    } else {
      check('a broken image URL falls back to the silhouette', false, 'no image card to break');
    }

    // Quick Add shows the same image card (the button lives on product cards,
    // e.g. the homepage — navigate back there first and pick any rendered
    // card of a product that offers Shape B).
    dom.window.location.hash = '#/';
    dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
    await wait(90);
    const qaBtn = [...doc.querySelectorAll('[data-add]')].find((el) => {
      const pr = pubImg.products.find((x) => x.id === el.getAttribute('data-add'));
      return pr && (pr.keyShapes || []).some((s) => s.shape === 'B' && s.available);
    });
    if (qaBtn) {
      qaBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      await wait(90);
      const qaImg = doc.querySelector('.qa-modal .shape-opt[data-qa="B"] img.shape-img');
      check('Quick Add renders the uploaded shape image too', !!qaImg && qaImg.getAttribute('src') === 'https://cdn.test/shape-b.png');
    } else {
      check('Quick Add renders the uploaded shape image too', false, 'quick add button not found');
    }
    dom.window.close();

    // Removing the image restores the silhouette everywhere
    await http('POST', '/api/admin/shapes/image/remove', { shapeId: 'shape_b' }, { admin: true });
    const pubNoImg = (await http('GET', '/api/data')).json;
    const dom2 = await bootStorefront(pubNoImg);
    dom2.window.location.hash = '#/product/' + pdpProduct.slug;
    dom2.window.dispatchEvent(new dom2.window.HashChangeEvent('hashchange'));
    await wait(90);
    const bBtn2 = dom2.window.document.querySelector('.shape-opt[data-shape="B"]');
    check('after removing the image the PDP falls back to the silhouette', !!bBtn2 && !bBtn2.querySelector('img.shape-img') && !!bBtn2.querySelector('svg'));
    dom2.window.close();

    // ------------------------------------------------------------------ 8
    console.log('\n== 8. Admin panel — Products editor Key Shapes rows ==');
    const adminPayload = (await http('GET', '/api/admin/data', null, { admin: true })).json;
    adminPayload.shapes = (adminPayload.shapes || []).map((s) => (s.code === 'B' ? Object.assign({}, s, { image_url: 'https://cdn.test/shape-b.png' }) : s));
    const admin = await bootAdmin(adminPayload);
    const navProducts = [...admin.doc.querySelectorAll('[data-nav]')].find((a) => a.getAttribute('data-nav') === 'products');
    if (navProducts) admin.click(navProducts);
    await wait(60);
    const firstEdit = admin.doc.querySelector('[data-edit-product]');
    if (firstEdit) admin.click(firstEdit);
    await wait(90);
    const editorProduct = adminPayload.products[0];
    const rows = [...admin.doc.querySelectorAll('#product-shapes-list .pshape-row')];
    check('one row per product shape', rows.length === (editorProduct.keyShapes || []).length, `${rows.length} vs ${(editorProduct.keyShapes || []).length}`);
    const nameInputs = [...admin.doc.querySelectorAll('#product-shapes-list [data-shname-en]')];
    const nameInputsAr = [...admin.doc.querySelectorAll('#product-shapes-list [data-shname-ar]')];
    check('every catalogue shape row has a Shape name EN field', nameInputs.length === (editorProduct.keyShapes || []).length, String(nameInputs.length));
    check('every catalogue shape row has a Shape name AR field', nameInputsAr.length === (editorProduct.keyShapes || []).length, String(nameInputsAr.length));
    const rowA = nameInputs.find((i) => i.value === 'Shape A');
    check('the name fields are prefilled from the catalogue', !!rowA && [...nameInputsAr].some((i) => i.value === 'الشكل A'));
    const fileInputs = [...admin.doc.querySelectorAll('#product-shapes-list [data-shimg-file]')];
    check('every catalogue shape row has an image upload control', fileInputs.length === (editorProduct.keyShapes || []).length, String(fileInputs.length));
    const bRowImg = admin.doc.querySelector('#product-shapes-list img.pshape-thumb');
    check('a shape with an image shows its preview in the row', !!bRowImg && bRowImg.getAttribute('src') === 'https://cdn.test/shape-b.png');
    const replaceBtns = [...admin.doc.querySelectorAll('#product-shapes-list [data-shimg-up]')];
    check('an imaged shape offers Replace and a Remove control', replaceBtns.some((b) => b.title.indexOf('Replace') >= 0) && !!admin.doc.querySelector('#product-shapes-list [data-shimg-rm]'));

    // Editing a name persists on the catalogue shape (store-wide)
    if (rowA) {
      rowA.value = 'Shape A — Studio';
      rowA.dispatchEvent(new admin.window.Event('change', { bubbles: true }));
      await wait(80);
      const nameCall = admin.calls.find((c) => c.url.indexOf('/api/admin/update') >= 0 && c.body && c.body.collection === 'shapes' && c.body.id === 'shape_a');
      check('renaming from the product editor PATCHes the catalogue shape', !!nameCall && nameCall.body.updates.name_en === 'Shape A — Studio', JSON.stringify(nameCall && nameCall.body));
    }

    // Uploading through the row's file control POSTs the data URL
    const bIdx = (editorProduct.keyShapes || []).findIndex((s) => s.shape === 'B');
    const bFileInput = admin.doc.querySelector(`#product-shapes-list [data-shimg-file="${bIdx}"]`);
    if (bFileInput) {
      const file = new admin.window.File([Buffer.from(TINY_PNG.split(',')[1], 'base64')], 'shape-b.png', { type: 'image/png' });
      Object.defineProperty(bFileInput, 'files', { value: [file], configurable: true });
      bFileInput.dispatchEvent(new admin.window.Event('change', { bubbles: true }));
      await wait(150);
      const upCall = admin.calls.find((c) => c.url.indexOf('/api/admin/shapes/image') >= 0 && c.url.indexOf('remove') < 0 && c.body && c.body.shapeId === 'shape_b');
      check('the row upload POSTs the image to /api/admin/shapes/image', !!upCall && typeof upCall.body.dataUrl === 'string' && upCall.body.dataUrl.startsWith('data:image/png'), JSON.stringify(upCall && { shapeId: upCall.body.shapeId, len: (upCall.body.dataUrl || '').length }));
    } else {
      check('the row upload POSTs the image to /api/admin/shapes/image', false, 'file input not found');
    }

    // ------------------------------------------------------------------ 9
    console.log('\n== 9. Admin panel — the Shapes screen ==');
    // Section 8's stub upload mutated the shared payload — restore Shape B's
    // known image before booting a fresh panel.
    adminPayload.shapes = (adminPayload.shapes || []).map((s) => (s.code === 'B' ? Object.assign({}, s, { image_url: 'https://cdn.test/shape-b.png' }) : s));
    const admin2 = await bootAdmin(adminPayload);
    const navShapes = [...admin2.doc.querySelectorAll('[data-nav]')].find((a) => a.getAttribute('data-nav') === 'shapes');
    if (navShapes) admin2.click(navShapes);
    await wait(60);
    const tableUps = [...admin2.doc.querySelectorAll('[data-shape-img-up]')];
    check('the Shapes table offers an image upload control per shape', tableUps.length === (adminPayload.shapes || []).length, String(tableUps.length));
    check('the Shapes table shows the stored preview', !!admin2.doc.querySelector('.data-table img.pshape-thumb[src="https://cdn.test/shape-b.png"]'));
    const editB = admin2.doc.querySelector('[data-edit-shape="shape_b"]');
    if (editB) admin2.click(editB);
    await wait(60);
    check('the shape editor shows the image preview + Replace/Remove controls', !!admin2.doc.querySelector('#shape-img-preview img.pshape-thumb') && !!admin2.doc.querySelector('#btn-shape-img-up') && !!admin2.doc.querySelector('#btn-shape-img-rm'));
    const rmBtn = admin2.doc.querySelector('#btn-shape-img-rm');
    if (rmBtn) {
      admin2.click(rmBtn);
      await wait(60);
      const confirmOk = admin2.doc.querySelector('#confirm-ok');
      if (confirmOk) admin2.click(confirmOk);
      await wait(80);
      const rmCall = admin2.calls.find((c) => c.url.indexOf('/api/admin/shapes/image/remove') >= 0 && c.body && c.body.shapeId === 'shape_b');
      check('Remove image asks for confirmation and POSTs the remove', !!rmCall, JSON.stringify(rmCall && rmCall.body));
    }
    admin.dom.window.close(); admin2.dom.window.close();

    // ------------------------------------------------------------------ 10
    console.log('\n== 10. Migration 009 ships with the CLI (column + public bucket + policies) ==');
    const printSql = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate.js'), '--print-sql'], { cwd: ROOT, encoding: 'utf8' });
    check('migrate --print-sql includes the 009 shape images migration', printSql.stdout.includes('009_shape_images.sql') && /add column if not exists image_url/i.test(printSql.stdout));
    // Migration 009 also provisions the public storefront bucket and the
    // explicit Storage policies. The local embedded database has no storage
    // schema, so this is intentionally checked from the generated SQL text.
    check('009 provisions the public shape-images bucket', /values\s*\(\s*'shape-images'\s*,\s*'shape-images'\s*,\s*true\s*\)/i.test(printSql.stdout));
    check('009 includes public-read and admin Storage policies',
      /Shape images: public read/i.test(printSql.stdout)
      && /Shape images: admin upload/i.test(printSql.stdout)
      && /Shape images: admin update/i.test(printSql.stdout)
      && /Shape images: admin delete/i.test(printSql.stdout));
    // Comments may mention DROP/DELETE/`TRUNCATE` (the safety rules do) — strip
    // them before asserting the actual statements are additive only.
    const tail009 = (printSql.stdout.split('009_shape_images.sql').pop() || '').replace(/--[^\n]*/g, '');
    check('009 is additive only (no drops, no deletes)', !/drop table|truncate|delete from/i.test(tail009));

    // The storage half of the feature lives in the SAME 009 migration: the
    // public bucket plus the explicit Storage policies. The local embedded
    // database has no storage schema, so these are checked from the generated
    // SQL text (test/supabase_e2e.js runs them against a Supabase-like schema).
    const migration009 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '009_shape_images.sql'), 'utf8');
    const sql009 = migration009.replace(/--[^\n]*/g, '');
    check('009 creates the shape-images bucket as PUBLIC (upsert keeps existing objects)',
      /insert into storage\.buckets[\s\S]*?'shape-images'[\s\S]*?true[\s\S]*?on conflict \(id\) do update/i.test(sql009),
      'no public bucket upsert found');
    check('009 forces the bucket back to public on an existing row',
      /on conflict \(id\) do update set[\s\S]*?public = true/i.test(sql009), 'the upsert does not set public = true');
    check('009 only touches storage when the Storage schema exists',
      /to_regclass\('storage\.buckets'\)/.test(sql009) && /to_regclass\('storage\.objects'\)/.test(sql009),
      'missing the storage-schema guard');
    ['Shape images: public read', 'Shape images: admin upload', 'Shape images: admin update', 'Shape images: admin delete']
      .forEach((p) => {
        const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        check(`009 creates the "${p}" policy (idempotently)`,
          new RegExp(`create policy "${escaped}" on storage\\.objects`).test(sql009)
          && new RegExp(`drop policy if exists "${escaped}" on storage\\.objects`).test(sql009),
          'policy missing or not idempotent');
      });
    check('every 009 Storage policy is scoped to the shape-images bucket',
      (sql009.match(/bucket_id = ''shape-images''/g) || []).length >= 4,
      'a policy is not scoped to the bucket');
    const dryRun = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate.js')], { cwd: ROOT, encoding: 'utf8' });
    check('the migration dry run lists the 009 shape-images migration',
      /009[\s\S]{0,120}?shape images/i.test(dryRun.stdout), (dryRun.stdout || '').slice(-300));

    // ------------------------------------------------------------------ 11
    console.log('\n== 11. /api/admin/diagnose reports the shape-image state ==');
    // Restore a known image so the diagnostic has something to report.
    await http('POST', '/api/admin/shapes/image', { shapeId: 'shape_b', url: 'https://cdn.test/shape-b.png' }, { admin: true });
    const diag = (await http('GET', '/api/admin/diagnose?probe=1')).json;
    check('diagnose exposes a shapeImages section', !!diag && !!diag.shapeImages, JSON.stringify(diag && Object.keys(diag)));
    const si = (diag && diag.shapeImages) || {};
    check('diagnose reports the image_url column state (migration 009)', si.column && si.column.present === true, JSON.stringify(si.column));
    check('diagnose reports the key_shapes rows the operator checks by hand',
      si.rowCount === 4 && (si.rows || []).map((r) => r.code).join(',') === 'A,B,C,D', JSON.stringify(si.rows));
    check('diagnose reports how many shapes carry an image', si.rowsWithImage === 1
      && (si.rows.find((r) => r.code === 'B') || {}).image_url === 'https://cdn.test/shape-b.png', JSON.stringify(si.rows));
    check('diagnose reports the storage bucket state honestly (no Supabase on this server)',
      si.storage && si.storage.bucket === 'shape-images' && si.storage.configured === false && !!si.storage.error,
      JSON.stringify(si.storage));

    // ------------------------------------------------------------------ 12
    console.log('\n== 12. Admin panel — the Shapes screen reports the wiring ==');
    const adminPayload2 = (await http('GET', '/api/admin/data', null, { admin: true })).json;
    const admin3 = await bootAdmin(adminPayload2);
    const navShapes3 = [...admin3.doc.querySelectorAll('[data-nav]')].find((a) => a.getAttribute('data-nav') === 'shapes');
    if (navShapes3) admin3.click(navShapes3);
    await wait(80);
    const strip = admin3.doc.querySelector('#btn-shape-status-refresh');
    check('the Shapes screen renders the shape-image status strip', !!strip);
    const stripCard = strip && strip.closest('.card');
    const stripText = (stripCard && stripCard.textContent) || '';
    check('the strip names the database column, the bucket and how many shapes have images',
      /image_url column ready/.test(stripText) && /bucket public/.test(stripText) && /of 4 shape\(s\)/.test(stripText.replace(/\s+/g, ' ')),
      stripText.replace(/\s+/g, ' ').slice(0, 200));
    if (strip) {
      admin3.click(strip);
      await wait(120);
      const diagCall = admin3.calls.find((c) => c.url.indexOf('/api/admin/diagnose') >= 0);
      check('refreshing re-checks the server (database column + bucket)', !!diagCall, JSON.stringify(admin3.calls.map((c) => c.url).slice(0, 8)));
    } else {
      check('refreshing re-checks the server (database column + bucket)', false, 'no refresh control');
    }
    admin3.dom.window.close();

    // ------------------------------------------------------------------ 13
    console.log('\n== 13. Operator probe: the same flow against a DEPLOYED store ==');
    // scripts/shape_image_probe.js is what the operator (or a reviewer) runs
    // against production with an admin token: diagnose → upload → read back
    // through /api/data → fetch the stored URL → replace → optional remove.
    const probePath = path.join(ROOT, 'scripts', 'shape_image_probe.js');
    check('the probe script ships with the repo', fs.existsSync(probePath));
    check('npm run probe:shapes points at it',
      /probe:shapes[\s\S]{0,60}shape_image_probe\.js/.test(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')));
    const noCreds = spawnSync(process.execPath, [probePath, '--url', 'http://127.0.0.1:9', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 20000 });
    let noCredsJson = null;
    try { noCredsJson = JSON.parse(noCreds.stdout); } catch (e) { /* ignore */ }
    check('without a credential it fails fast with an explanatory check (no request is sent)',
      noCreds.status === 2 && noCredsJson && noCredsJson.checks && noCredsJson.checks[0].ok === false
        && /credential/i.test(noCredsJson.checks[0].name),
      `exit=${noCreds.status} ${(noCreds.stdout || '').replace(/\s+/g, ' ').slice(0, 160)}`);
    const syntax = spawnSync(process.execPath, ['--check', probePath], { cwd: ROOT, encoding: 'utf8' });
    check('the probe script parses cleanly', syntax.status === 0, (syntax.stderr || '').slice(0, 200));
  } finally {
    try { srv.child.kill('SIGTERM'); } catch (e) { /* ignore */ }
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('shape images test crashed:', e); process.exit(1); });
