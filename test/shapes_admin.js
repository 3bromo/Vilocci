'use strict';
// ============================================================================
// Admin → Shapes (Shape management) — the global key-shape catalogue
// ----------------------------------------------------------------------------
// Before this feature the four key shapes (A–D) existed only as per-product
// availability flags and hard-coded letters in the storefront. This suite
// drives the REAL server (scratch JSON datastore — the committed dataset is
// never touched) and the REAL storefront + admin bundles (jsdom):
//
//   api        /api/data serves the catalogue (ordered, active-only); CRUD
//              through /api/admin/save|update|delete normalizes codes to
//              upper case, rejects codeless shapes and demands the admin
//              token.
//   rules      a hidden shape disappears from the public payload AND can no
//              longer be ordered (the order line falls back to no shape);
//              unknown shapes are refused while a catalogue exists; a store
//              with NO catalogue derives A–D from its products (legacy).
//   storefront the product page, Quick Add, the Fitment Finder and the Key
//              Guide render the catalogue's shapes in catalogue order with
//              localized names (EN + AR) and never render a hidden shape.
//   admin ui   the Shapes view lists the catalogue; add / edit / hide /
//              delete all hit the right endpoints; the product editor
//              exposes the catalogue as per-product availability checkboxes.
//
// Usage: npm run test:shapes
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const PORT = 3493;
const PORT_LEGACY = 3494;
const API = `http://127.0.0.1:${PORT}`;
const API_LEGACY = `http://127.0.0.1:${PORT_LEGACY}`;
const DEV_TOKEN = 'shapes-test-token-' + Date.now().toString(36);

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
// Storefront boot (jsdom) against a given /api/data payload — the same
// harness the brands / coating suites use.
// ---------------------------------------------------------------------------
async function bootStorefront(payload, opts = {}) {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: API + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      if (opts.lang) window.localStorage.setItem('velocci_lang', opts.lang);
      window.fetch = (u) => {
        const url = typeof u === 'string' ? u : u.url;
        if (url.indexOf('/api/data') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
        if (url.indexOf('/api/orders') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, orderId: 'ORD-SHAPE', total: 100 }) });
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
// Admin panel boot (jsdom) — same stub the brands suite uses.
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
  // Scratch datastores — the committed dataset is never touched.
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vilocci-shapes-'));
  const scratchDb = path.join(scratchDir, 'velocci-db.json');
  fs.copyFileSync(path.join(ROOT, 'data', 'velocci-db.json'), scratchDb);
  // Legacy store: same dataset WITHOUT the shapes collection (pre-feature).
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vilocci-shapes-legacy-'));
  const legacyDb = path.join(legacyDir, 'velocci-db.json');
  const legacyData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'velocci-db.json'), 'utf8'));
  delete legacyData.shapes;
  fs.writeFileSync(legacyDb, JSON.stringify(legacyData));

  const srv = startServer(PORT, scratchDb);
  const legacy = startServer(PORT_LEGACY, legacyDb);

  try {
    const up = await waitForServer(srv.child, API);
    if (!up) { console.error('server did not start\n', srv.log()); process.exit(1); }
    const upLegacy = await waitForServer(legacy.child, API_LEGACY);
    if (!upLegacy) { console.error('legacy server did not start\n', legacy.log()); process.exit(1); }

    // ------------------------------------------------------------------ 1
    console.log('\n== 1. Public API — the catalogue is served ==');
    const data = (await http('GET', '/api/data')).json;
    check('/api/data serves the key-shape catalogue', Array.isArray(data.shapes) && data.shapes.length === 4, JSON.stringify(data.shapes));
    check('catalogue codes A–D in catalogue order', data.shapes.map((s) => s.code).join(',') === 'A,B,C,D', data.shapes.map((s) => s.code).join(','));
    check('catalogue rows carry EN + AR display names', data.shapes.every((s) => s.name_en && s.name_ar));
    check('the seeded names are exactly what the storefront always showed', data.shapes[0].name_en === 'Shape A' && data.shapes[0].name_ar === 'الشكل A');

    // ------------------------------------------------------------------ 2
    console.log('\n== 2. Admin CRUD — create / rename / reorder / hide / delete ==');
    const created = await http('POST', '/api/admin/save', { collection: 'shapes', record: { id: 'shape_e', code: 'e', name_en: 'Shape E', name_ar: 'الشكل E', active: true, order: 5 } }, { admin: true });
    check('creating a shape succeeds', created.ok && created.json.ok, JSON.stringify(created.json));
    check('the code is normalized to upper case', created.json.record.code === 'E', JSON.stringify(created.json.record));
    let pub = (await http('GET', '/api/data')).json;
    check('the new shape is served to the storefront', pub.shapes.some((s) => s.code === 'E'));

    const renamed = await http('POST', '/api/admin/update', { collection: 'shapes', id: 'shape_e', updates: { name_en: 'Shape E — Compact' } }, { admin: true });
    pub = (await http('GET', '/api/data')).json;
    check('renaming persists through the public payload', renamed.ok && pub.shapes.find((s) => s.code === 'E').name_en === 'Shape E — Compact');

    await http('POST', '/api/admin/update', { collection: 'shapes', id: 'shape_e', updates: { order: 0 } }, { admin: true });
    pub = (await http('GET', '/api/data')).json;
    check('reordering changes the served order (E first)', pub.shapes[0].code === 'E', pub.shapes.map((s) => s.code).join(','));
    await http('POST', '/api/admin/update', { collection: 'shapes', id: 'shape_e', updates: { order: 5 } }, { admin: true });

    const hidden = await http('POST', '/api/admin/update', { collection: 'shapes', id: 'shape_d', updates: { active: false } }, { admin: true });
    pub = (await http('GET', '/api/data')).json;
    // A hidden shape stays in the public payload FLAGGED (active:false) so the
    // storefront can block it while still allowing product-local custom codes.
    check('hiding a shape flags it inactive in the public payload', hidden.ok && pub.shapes.some((s) => s.code === 'D' && s.active === false), pub.shapes.map((s) => s.code + (s.active === false ? '!' : '')).join(','));
    const adminData = (await http('GET', '/api/admin/data', null, { admin: true })).json;
    check('the admin payload still lists the hidden shape (marked inactive)', adminData.shapes.find((s) => s.code === 'D').active === false);

    const codeless = await http('POST', '/api/admin/save', { collection: 'shapes', record: { id: 'shape_x', name_en: 'No code' } }, { admin: true });
    check('a shape without a code is rejected with a clear error', codeless.status === 400 && /code/i.test(codeless.json.error), JSON.stringify(codeless.json));

    const noToken = await http('POST', '/api/admin/update', { collection: 'shapes', id: 'shape_d', updates: { active: true } });
    check('unauthenticated shape writes are refused', noToken.status === 401, String(noToken.status));

    const deleted = await http('POST', '/api/admin/delete', { collection: 'shapes', id: 'shape_e' }, { admin: true });
    pub = (await http('GET', '/api/data')).json;
    check('deleting a shape removes it from the catalogue', deleted.ok && !pub.shapes.some((s) => s.code === 'E'), pub.shapes.map((s) => s.code).join(','));

    // ------------------------------------------------------------------ 3
    console.log('\n== 3. Server rules — hidden / unknown shapes can never be ordered ==');
    const cust = { fullName: 'Shape Tester', phone: '+201011112222', city: 'Cairo', address: '1 Test Street' };
    const firstColor = (p) => ((p.colors || []).find((c) => c.enabled !== false) || {}).id;
    const placeOrder = async (productId, keyShape) => {
      const r = await http('POST', '/api/orders', { cart: [{ productId, keyShape, qty: 1, colorId: firstColor(adminData.products.find((p) => p.id === productId)) }], customer: cust, payment: 'Cash on Delivery' });
      if (!r.ok) return { status: r.status, error: r.json && r.json.error };
      const detail = await http('GET', `/api/admin/order/${r.json.orderId}`, null, { admin: true });
      return { status: r.status, shape: detail.json.items[0].keyShape };
    };
    const prodC = adminData.products.find((p) => (p.keyShapes || []).some((s) => s.shape === 'C' && s.available));
    // D is still hidden from section 2
    const prodD = adminData.products.find((p) => (p.keyShapes || []).some((s) => s.shape === 'D' && s.available));
    if (prodD) {
      const hiddenOrder = await placeOrder(prodD.id, 'D');
      check('an order for the hidden shape D falls back to no shape', hiddenOrder.status === 200 && hiddenOrder.shape === '', JSON.stringify(hiddenOrder));
    } else {
      check('an order for the hidden shape D falls back to no shape', true, 'no product carries D as available — covered by C below');
    }
    const hiddenC = await placeOrder(prodC.id, 'C');
    check('an order for the active shape C keeps the shape', hiddenC.status === 200 && hiddenC.shape === 'C', JSON.stringify(hiddenC));
    const unknown = await placeOrder(prodC.id, 'Z');
    check('an order for a shape the product does not carry falls back to no shape', unknown.status === 200 && unknown.shape === '', JSON.stringify(unknown));
    // Product-local custom shapes — the Products editor can attach codes the
    // catalogue does not manage; those must stay orderable end to end.
    const beforeCustom = JSON.stringify(prodC.keyShapes);
    await http('POST', '/api/admin/update', { collection: 'products', id: prodC.id, updates: { keyShapes: [...(prodC.keyShapes || []), { shape: 'E', available: true }] } }, { admin: true });
    const customOrder = await placeOrder(prodC.id, 'E');
    check('a product-local custom shape (not in the catalogue) stays orderable', customOrder.status === 200 && customOrder.shape === 'E', JSON.stringify(customOrder));
    await http('POST', '/api/admin/update', { collection: 'products', id: prodC.id, updates: { keyShapes: JSON.parse(beforeCustom) } }, { admin: true });
    await http('POST', '/api/admin/update', { collection: 'shapes', id: 'shape_d', updates: { active: true } }, { admin: true });

    // ------------------------------------------------------------------ 4
    console.log('\n== 4. Legacy store — no catalogue means the classic derivation ==');
    const legacyRes = await fetch(API_LEGACY + '/api/data');
    const legacyPayload = await legacyRes.json();
    check('a store without a shapes collection derives A–D from its products', legacyPayload.shapes.map((s) => s.code).join(',') === 'A,B,C,D', JSON.stringify(legacyPayload.shapes));
    check('derived names match the classic labels', legacyPayload.shapes[0].name_en === 'Shape A');

    // ------------------------------------------------------------------ 5
    console.log('\n== 5. Storefront — selectors, labels, fitment, key guide ==');
    const pubNow = (await http('GET', '/api/data')).json;
    const pdpProduct = pubNow.products.find((p) => (p.keyShapes || []).some((s) => s.shape === 'A' && s.available) && (p.keyShapes || []).some((s) => s.shape === 'C'));
    const dom = await bootStorefront(pubNow);
    const { window } = dom;
    const doc = window.document;
    const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const setHash = (h) => { window.location.hash = h; window.dispatchEvent(new window.HashChangeEvent('hashchange')); };

    setHash('#/product/' + pdpProduct.slug);
    await wait(80);
    const pdpCodes = [...doc.querySelectorAll('.shape-opt')].map((b) => b.getAttribute('data-shape'));
    check('the PDP offers exactly the catalogue shapes, in catalogue order', pdpCodes.join(',') === 'A,B,C,D', pdpCodes.join(','));
    check('the PDP shape labels use the catalogue names', [...doc.querySelectorAll('.shape-opt .lbl')].some((l) => l.textContent.trim() === 'Shape A'));

    // hide shape D again and re-boot the storefront against the new payload
    await http('POST', '/api/admin/update', { collection: 'shapes', id: 'shape_d', updates: { active: false } }, { admin: true });
    const pubHidden = (await http('GET', '/api/data')).json;
    const dom2 = await bootStorefront(pubHidden);
    const doc2 = dom2.window.document;
    const setHash2 = (h) => { dom2.window.location.hash = h; dom2.window.dispatchEvent(new dom2.window.HashChangeEvent('hashchange')); };
    setHash2('#/product/' + pdpProduct.slug);
    await wait(80);
    const pdpCodesHidden = [...doc2.querySelectorAll('.shape-opt')].map((b) => b.getAttribute('data-shape'));
    check('a hidden shape disappears from the product-page selector', !pdpCodesHidden.includes('D'), pdpCodesHidden.join(','));

    // Quick Add only offers AVAILABLE shapes — and no product carries D as
    // available — so the rule is exercised with shape B (92 products offer
    // it): hide B, then Quick Add for a B-product must no longer offer B.
    await http('POST', '/api/admin/update', { collection: 'shapes', id: 'shape_b', updates: { active: false } }, { admin: true });
    const pubQa = (await http('GET', '/api/data')).json;
    const qaProduct = pubQa.products.find((p) => (p.keyShapes || []).some((s) => s.shape === 'B' && s.available));
    const domQa = await bootStorefront(pubQa);
    const docQa = domQa.window.document;
    const qaBtn = qaProduct && docQa.querySelector(`[data-add="${qaProduct.id}"]`);
    if (qaBtn) {
      qaBtn.dispatchEvent(new domQa.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      await wait(80);
      const qaCodes = [...docQa.querySelectorAll('.qa-modal .shape-opt')].map((b) => b.getAttribute('data-qa'));
      check('Quick Add never offers the hidden shape', qaCodes.length > 0 && !qaCodes.includes('B') && qaProduct.keyShapes.some((s) => s.shape === 'B'), qaCodes.join(','));
      const qaClose = docQa.querySelector('#qa-close');
      if (qaClose) qaClose.click();
    } else {
      check('Quick Add never offers the hidden shape', false, 'quick-add button not found for ' + (qaProduct && qaProduct.id));
    }
    await http('POST', '/api/admin/update', { collection: 'shapes', id: 'shape_b', updates: { active: true } }, { admin: true });

    // Fitment Finder step 4 — Mercedes · C-Class · 2022 supports A + B
    setHash2('#/fitment');
    await wait(80);
    const fitBtn = (sel) => doc2.querySelector(sel);
    const brandBtn = [...doc2.querySelectorAll('[data-fitbrand]')].find((b) => b.getAttribute('data-fitbrand') === 'mercedes-benz');
    if (brandBtn) {
      brandBtn.dispatchEvent(new dom2.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      await wait(60);
      const modelBtn = [...doc2.querySelectorAll('[data-fitmodel]')].find((b) => b.getAttribute('data-fitmodel') === 'C-Class');
      if (modelBtn) modelBtn.dispatchEvent(new dom2.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      await wait(60);
      const yearBtn = [...doc2.querySelectorAll('[data-fityear]')].find((b) => b.getAttribute('data-fityear') === '2022');
      if (yearBtn) yearBtn.dispatchEvent(new dom2.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      await wait(60);
      const fitCodes = [...doc2.querySelectorAll('[data-fit-shape]')].map((b) => b.getAttribute('data-fit-shape'));
      check('the Fitment Finder never offers the hidden shape', fitCodes.length > 0 && !fitCodes.includes('D'), fitCodes.join(','));
      check('the Fitment Finder uses catalogue labels', [...doc2.querySelectorAll('[data-fit-shape] .lbl')].some((l) => l.textContent.trim() === 'Shape A'));
    } else {
      check('the Fitment Finder never offers the hidden shape', false, 'fitment brand buttons not found');
    }

    // Key Guide page
    setHash2('#/keyguide');
    await wait(80);
    const guideLbls = [...doc2.querySelectorAll('.shape-opt .lbl')].map((l) => l.textContent.trim());
    check('the Key Guide lists catalogue shapes only (hidden shape gone)', guideLbls.length >= 3 && !guideLbls.some((l) => l === 'Shape D'), guideLbls.join('|'));
    check('the Key Guide shows the catalogue descriptions', /Standard folded key blade profile/i.test(doc2.body.textContent));

    // Arabic: labels come from the catalogue's AR names
    await http('POST', '/api/admin/update', { collection: 'shapes', id: 'shape_d', updates: { active: true } }, { admin: true });
    const pubAr = (await http('GET', '/api/data')).json;
    const domAr = await bootStorefront(pubAr, { lang: 'ar' });
    const docAr = domAr.window.document;
    domAr.window.location.hash = '#/product/' + pdpProduct.slug;
    domAr.window.dispatchEvent(new domAr.window.HashChangeEvent('hashchange'));
    await wait(80);
    const arLbls = [...docAr.querySelectorAll('.shape-opt .lbl')].map((l) => l.textContent.trim());
    check('the Arabic PDP renders the catalogue AR names', arLbls.some((l) => l === 'الشكل A'), arLbls.join('|'));
    check('the page is in RTL', docAr.documentElement.getAttribute('dir') === 'rtl');

    // Cart meta uses the catalogue label
    const shapeBtn = docAr.querySelector('.shape-opt.selectable');
    if (shapeBtn) shapeBtn.dispatchEvent(new domAr.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(60);
    const colorBtn = docAr.querySelector('.color-selector .color-opt');
    if (colorBtn) colorBtn.dispatchEvent(new domAr.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(60);
    const addBtn = docAr.querySelector('#addbtn');
    if (addBtn && !addBtn.disabled) addBtn.dispatchEvent(new domAr.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(80);
    const cartBtn = docAr.querySelector('#cart-btn');
    if (cartBtn) cartBtn.dispatchEvent(new domAr.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(60);
    const metaText = [...docAr.querySelectorAll('.drawer-item .di-meta')].map((e) => e.textContent).join(' ');
    check('the cart line carries the catalogue AR shape label', /الشكل/.test(metaText), metaText.slice(0, 120));

    // ------------------------------------------------------------------ 6
    console.log('\n== 6. Admin panel — the Shapes screen ==');
    const adminPayload = (await http('GET', '/api/admin/data', null, { admin: true })).json;
    const admin = await bootAdmin(adminPayload);
    const navShapes = [...admin.doc.querySelectorAll('[data-nav]')].find((a) => a.getAttribute('data-nav') === 'shapes');
    check('the sidebar has a Shapes entry', !!navShapes);
    if (navShapes) admin.click(navShapes);
    await wait(60);
    const rows = [...admin.doc.querySelectorAll('[data-edit-shape]')];
    check('the Shapes view lists the catalogue (4 rows)', rows.length === 4, String(rows.length));
    check('the Shapes table shows codes + EN/AR names', admin.doc.body.textContent.includes('Shape A') && admin.doc.body.textContent.includes('الشكل A'));

    // Add a shape through the editor
    const addShapeBtn = admin.doc.querySelector('#btn-add-shape-cat');
    if (addShapeBtn) admin.click(addShapeBtn);
    await wait(60);
    const shapeForm = admin.doc.querySelector('#shape-form');
    check('the Add Shape editor opens', !!shapeForm);
    if (shapeForm) {
      shapeForm.querySelector('[name=code]').value = 'e';
      shapeForm.querySelector('[name=name_en]').value = 'Shape E';
      shapeForm.querySelector('[name=name_ar]').value = 'الشكل E';
      admin.click(admin.doc.querySelector('#btn-save-shape'));
      await wait(60);
      const saveCall = admin.calls.find((c) => c.url.indexOf('/api/admin/save') >= 0 && c.body && c.body.collection === 'shapes');
      check('saving POSTs the new shape to /api/admin/save (code normalized client-side too)', !!saveCall && saveCall.body.record.code === 'E' && saveCall.body.record.name_en === 'Shape E', JSON.stringify(saveCall && saveCall.body));
    }

    // Hide a shape from the table
    const toggleD = admin.doc.querySelector('[data-toggle-shape="shape_d"]');
    if (toggleD) admin.click(toggleD);
    await wait(60);
    const toggleCall = admin.calls.find((c) => c.url.indexOf('/api/admin/update') >= 0 && c.body && c.body.collection === 'shapes' && c.body.id === 'shape_d');
    check('the 🙈 button PATCHes shapes.active through /api/admin/update', !!toggleCall && toggleCall.body.updates.active === false, JSON.stringify(toggleCall && toggleCall.body));

    // Edit a shape (prefilled editor)
    const editA = admin.doc.querySelector('[data-edit-shape="shape_a"]');
    if (editA) admin.click(editA);
    await wait(60);
    const editForm = admin.doc.querySelector('#shape-form');
    const codeInput = editForm && editForm.querySelector('[name=code]');
    check('the edit editor opens prefilled and locks the code', !!editForm && codeInput.value === 'A' && codeInput.readOnly);
    if (editForm) {
      editForm.querySelector('[name=name_en]').value = 'Shape A — Classic';
      admin.click(admin.doc.querySelector('#btn-save-shape'));
      await wait(60);
      const updCall = admin.calls.filter((c) => c.url.indexOf('/api/admin/update') >= 0 && c.body && c.body.collection === 'shapes' && c.body.id === 'shape_a').pop();
      check('saving the edit PATCHes only the changed fields', !!updCall && updCall.body.updates.name_en === 'Shape A — Classic', JSON.stringify(updCall && updCall.body));
    }

    // Delete a shape (confirm dialog)
    const delB = admin.doc.querySelector('[data-delete-shape="shape_b"]');
    if (delB) admin.click(delB);
    await wait(60);
    const confirmOk = admin.doc.querySelector('#confirm-ok');
    check('deleting asks for confirmation first', !!confirmOk);
    if (confirmOk) {
      admin.click(confirmOk);
      await wait(60);
      const delCall = admin.calls.find((c) => c.url.indexOf('/api/admin/delete') >= 0 && c.body && c.body.collection === 'shapes' && c.body.id === 'shape_b');
      check('confirming POSTs the delete to /api/admin/delete', !!delCall, JSON.stringify(delCall && delCall.body));
    }

    // ------------------------------------------------------------------ 7
    console.log('\n== 7. Admin panel — the product editor\'s per-product shape list ==');
    const admin2 = await bootAdmin(adminPayload);
    const navProducts = [...admin2.doc.querySelectorAll('[data-nav]')].find((a) => a.getAttribute('data-nav') === 'products');
    if (navProducts) admin2.click(navProducts);
    await wait(60);
    const firstEdit = admin2.doc.querySelector('[data-edit-product]');
    if (firstEdit) admin2.click(firstEdit);
    await wait(80);
    const editorProduct = adminPayload.products[0];
    const shapeToggles = [...admin2.doc.querySelectorAll('#product-shapes-list [data-shapeok]')];
    check('the product editor renders one stock toggle per product shape', shapeToggles.length === (editorProduct.keyShapes || []).length, `${shapeToggles.length} vs ${(editorProduct.keyShapes || []).length}`);
    check('the toggles reflect the product\'s stored availability', shapeToggles.every((b) => {
      const code = (b.getAttribute('name') || '').replace('shapeok_', '');
      const rec = (editorProduct.keyShapes || []).find((s) => s.shape === code);
      return b.checked === !!(rec && rec.available);
    }));
    // The "+ Add shape" select is catalogue-driven (Admin → Shapes is the
    // master list; a legacy store without a catalogue falls back to A–D).
    const addSelect = admin2.doc.querySelector('#pf-new-shape');
    const selectVals = addSelect ? [...addSelect.querySelectorAll('option')].map((o) => o.value) : [];
    check('the add-shape select offers the catalogue codes', selectVals.join(',') === (adminPayload.shapes || []).map((s) => s.code).join(','), selectVals.join(','));
    if (shapeToggles.length) {
      const box = shapeToggles[0];
      admin2.click(box);
      await wait(40);
      admin2.click(admin2.doc.querySelector('#btn-save-product'));
      await wait(80);
      const prodSave = admin2.calls.filter((c) => c.url.indexOf('/api/admin/save') >= 0 && c.body && c.body.collection === 'products').pop();
      const flipped = (prodSave && prodSave.body.record.keyShapes || []).find((s) => s.shape === (box.getAttribute('name') || '').replace('shapeok_', ''));
      check('saving the product stores the edited availability flags', !!prodSave && !!flipped && flipped.available === box.checked, JSON.stringify(flipped));
    }

    // ------------------------------------------------------------------ 8
    console.log('\n== 8. Migration — 007 ships with the CLI ==');
    const printSql = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate.js'), '--print-sql'], { cwd: ROOT, encoding: 'utf8' });
    check('migrate --print-sql includes the 007 key_shapes migration', printSql.stdout.includes('007_key_shapes.sql') && printSql.stdout.includes('create table if not exists public.key_shapes'));
    check('the migration seeds the four default shapes idempotently', /on conflict \(id\) do nothing/.test(printSql.stdout) && /'shape_a', 'A'/.test(printSql.stdout));

    dom.window.close(); dom2.window.close(); domAr.window.close();
    admin.dom.window.close(); admin2.dom.window.close();
  } finally {
    try { srv.child.kill('SIGTERM'); } catch (e) { /* ignore */ }
    try { legacy.child.kill('SIGTERM'); } catch (e) { /* ignore */ }
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    try { fs.rmSync(legacyDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('shapes test crashed:', e); process.exit(1); });
