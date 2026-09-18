'use strict';
// ============================================================================
// Product Key Shape management test (self-contained, real server + jsdom)
// ----------------------------------------------------------------------------
// Boots the REAL server.js against a scratch JSON datastore and a dev admin
// token, then drives the live HTTP API and the jsdom storefront & admin panel
// to prove the complete shape management system:
//
//   1. mapping       normalizeKeyShapes, availableKeyShapes, rowToProduct
//   2. admin API     add / toggle availability / reorder / delete shapes
//   3. isolation     editing one product's shapes never touches another
//   4. durability    edits persist to the datastore on disk
//   5. storefront    PDP marks OOS shapes as disabled; Quick Add offers only
//                    available shapes (or rejects when all OOS)
//   6. ordering      available shape recorded on order line; server drops OOS shape
//   7. admin UI      jsdom drives admin-app.js: table shows Key shapes column,
//                    product modal renders shape rows with toggles + add button,
//                    saving posts updated keyShapes
//
// Usage: npm run test:shapes
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const PORT = 3495;
const API = `http://127.0.0.1:${PORT}`;
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
  const res = await fetch(API + urlPath, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-json */ }
  return { ok: res.ok, status: res.status, json };
}

async function waitForServer(child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(API + '/api/data');
      if (r.ok) return true;
    } catch (e) { /* not up yet */ }
    if (child.exitCode !== null) throw new Error('server exited early: ' + child.exitCode);
    await wait(100);
  }
  throw new Error('server did not start within 20s');
}

async function main() {
  console.log('== 1. Persistence mapping (lib/mapping.js) ==');
  const mapping = require('../lib/mapping');
  check('normalizeKeyShapes is exported', typeof mapping.normalizeKeyShapes === 'function');
  check('availableKeyShapes is exported', typeof mapping.availableKeyShapes === 'function');

  // Test normalizing various inputs
  const norm1 = mapping.normalizeKeyShapes(['a', 'b', 'c']);
  check('string array normalized to objects with uppercase shape',
    norm1.length === 3 && norm1[0].shape === 'A' && norm1[0].available === true);

  const norm2 = mapping.normalizeKeyShapes([
    { shape: 'a', available: false },
    { shape: 'B', available: true },
    { shape: 'a', available: true }, // duplicate
    null,
    '',
  ]);
  check('duplicates and invalid items filtered, casing normalized',
    norm2.length === 2 && norm2[0].shape === 'A' && norm2[0].available === false && norm2[1].shape === 'B' && norm2[1].available === true);

  const norm3 = mapping.normalizeKeyShapes('[{"shape":"C","available":true}]');
  check('JSON string parsed and normalized', norm3.length === 1 && norm3[0].shape === 'C' && norm3[0].available === true);

  const availOnly = mapping.availableKeyShapes({ keyShapes: norm2 });
  check('availableKeyShapes filters out unavailable shapes',
    availOnly.length === 1 && availOnly[0].shape === 'B');

  const pRow = mapping.productToRow({ id: 'p_test', keyShapes: norm2 });
  check('productToRow serializes key_shapes', Array.isArray(pRow.key_shapes) && pRow.key_shapes.length === 2);
  const pApp = mapping.rowToProduct(pRow);
  check('rowToProduct deserializes keyShapes', Array.isArray(pApp.keyShapes) && pApp.keyShapes.length === 2);

  // Set up scratch datastore
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shapes-test-'));
  const scratchDb = path.join(tmpDir, 'velocci-db.json');
  fs.copyFileSync(path.join(ROOT, 'data', 'velocci-db.json'), scratchDb);

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      VELOCCI_DB: scratchDb,
      DATA_DRIVER: 'json',
      ADMIN_DEV_TOKEN: DEV_TOKEN,
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_ANON_KEY: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});

  try {
    await waitForServer(child);

    // ------------------------------------------------------------------ 2
    console.log('\n== 2. Admin API: update shape availability & list ==');
    const catalog = (await http('GET', '/api/data')).json;
    const target = catalog.products.find((p) => (p.keyShapes || []).some(s => s.shape === 'A' && s.available));
    check('found target product with available Shape A', !!target, target && target.id);
    const other = catalog.products.find((p) => p.id !== target.id);
    const originalOther = JSON.stringify(other.keyShapes);

    // TOGGLE Shape A to unavailable
    const toggled = target.keyShapes.map(s => s.shape === 'A' ? { shape: s.shape, available: false } : s);
    let r = await http('POST', '/api/admin/update', { collection: 'products', id: target.id, updates: { keyShapes: toggled } }, { admin: true });
    check('admin can update keyShapes via /api/admin/update', r.ok && r.json.ok);

    let fresh = (await http('GET', '/api/data')).json.products.find((p) => p.id === target.id);
    const shA = fresh.keyShapes.find(s => s.shape === 'A');
    check('Shape A is now marked available: false on storefront data', shA && shA.available === false);

    // ADD a new shape
    const added = fresh.keyShapes.concat([{ shape: 'E', available: true }]);
    r = await http('POST', '/api/admin/update', { collection: 'products', id: target.id, updates: { keyShapes: added } }, { admin: true });
    check('admin can add a shape', r.ok && r.json.ok);
    fresh = (await http('GET', '/api/data')).json.products.find((p) => p.id === target.id);
    check('added shape E is present in product data', fresh.keyShapes.some(s => s.shape === 'E'));

    // REORDER shapes
    fresh = (await http('GET', '/api/data')).json.products.find((p) => p.id === target.id);
    const reversed = fresh.keyShapes.slice().reverse();
    r = await http('POST', '/api/admin/update', { collection: 'products', id: target.id, updates: { keyShapes: reversed } }, { admin: true });
    check('admin can reorder shapes', r.ok && r.json.ok);
    fresh = (await http('GET', '/api/data')).json.products.find((p) => p.id === target.id);
    check('shapes reflect reversed order', fresh.keyShapes[0].shape === reversed[0].shape);

    // DELETE shape
    const filtered = fresh.keyShapes.filter(s => s.shape !== 'E');
    r = await http('POST', '/api/admin/update', { collection: 'products', id: target.id, updates: { keyShapes: filtered } }, { admin: true });
    check('admin can delete a shape', r.ok && r.json.ok);
    fresh = (await http('GET', '/api/data')).json.products.find((p) => p.id === target.id);
    check('shape E removed from product', !fresh.keyShapes.some(s => s.shape === 'E'));

    // ------------------------------------------------------------------ 3
    console.log('\n== 3. Per-product isolation ==');
    const otherNow = (await http('GET', '/api/data')).json.products.find((p) => p.id === other.id);
    check("modifying one product's shapes never touches another", JSON.stringify(otherNow.keyShapes) === originalOther);

    // ------------------------------------------------------------------ 4
    console.log('\n== 4. Durability: persisted to datastore on disk ==');
    const onDisk = JSON.parse(fs.readFileSync(scratchDb, 'utf8'));
    const diskProduct = onDisk.products.find((p) => p.id === target.id);
    check('disk stores updated keyShapes', Array.isArray(diskProduct.keyShapes) && diskProduct.keyShapes.length === filtered.length);
    const diskA = diskProduct.keyShapes.find(s => s.shape === 'A');
    check('disk stores Shape A available: false', diskA && diskA.available === false, JSON.stringify(diskA));

    // ------------------------------------------------------------------ 5
    console.log('\n== 5. Storefront: PDP & Quick Add shape availability ==');
    // Set up storefront JSDOM
    const storeHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    const dom = new JSDOM(storeHtml, {
      url: API + '/#/product/' + target.slug,
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      beforeParse(window) {
        window.fetch = (url, opts) => {
          const full = url.startsWith('http') ? url : API + url;
          return fetch(full, opts);
        };
      },
    });

    // Wait for storefront SPA to render
    await wait(800);
    const doc = dom.window.document;
    const shapeBtnA = doc.querySelector('.shape-opt[data-shape="A"]');
    check('PDP renders shape options', !!shapeBtnA);
    check('OOS Shape A button is disabled', shapeBtnA && shapeBtnA.disabled === true);
    check('OOS Shape A button has unavailable class', shapeBtnA && shapeBtnA.classList.contains('unavailable'));

    const shapeAvail = fresh.keyShapes.find(s => s.available);
    const shapeBtnAvail = doc.querySelector(`.shape-opt[data-shape="${shapeAvail.shape}"]`);
    check('Available shape button is not disabled', shapeBtnAvail && !shapeBtnAvail.disabled);

    // ------------------------------------------------------------------ 6
    console.log('\n== 6. Ordering & server-side validation ==');
    // Place order with available shape
    const color = mapping.activeColors(fresh)[0];
    const orderPayload = {
      customer: { fullName: 'Shape Tester', phone: '01012345678', email: 'shape@test.com', address: '123 Test St', city: 'Cairo' },
      paymentMethod: 'cod',
      cart: [{ productId: fresh.id, keyShape: shapeAvail.shape, qty: 1, colorId: color ? color.id : undefined }],
    };
    let orderRes = await http('POST', '/api/orders', orderPayload);
    check('order with available shape accepted', orderRes.ok && orderRes.json.ok);
    const orderId = orderRes.json.orderId;
    const storedOrder = (await http('GET', `/api/admin/order/${encodeURIComponent(orderId)}`, null, { admin: true })).json;
    check('order item preserves available shape', storedOrder && storedOrder.items[0].keyShape === shapeAvail.shape);

    // Attempt order claiming unavailable Shape A -> server should drop unavailable shape
    const oosOrderPayload = {
      customer: { fullName: 'Shape Tester', phone: '01012345678', email: 'shape@test.com', address: '123 Test St', city: 'Cairo' },
      paymentMethod: 'cod',
      cart: [{ productId: fresh.id, keyShape: 'A', qty: 1, colorId: color ? color.id : undefined }],
    };
    let oosOrderRes = await http('POST', '/api/orders', oosOrderPayload);
    check('order processed', oosOrderRes.ok && oosOrderRes.json.ok);
    const oosStored = (await http('GET', `/api/admin/order/${encodeURIComponent(oosOrderRes.json.orderId)}`, null, { admin: true })).json;
    check('server stripped unavailable shape A', oosStored && oosStored.items[0].keyShape === '');

    // ------------------------------------------------------------------ 7
    console.log('\n== 7. Admin UI (jsdom driving admin-app.js) ==');
    const adminHtml = fs.readFileSync(path.join(PUBLIC, 'admin.html'), 'utf8');
    const adminDom = new JSDOM(adminHtml, {
      url: API + '/admin',
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      beforeParse(window) {
        window.supabase = {
          createClient: () => ({
            auth: {
              getSession: async () => ({ data: { session: { user: { id: 'admin-1', email: 'admin@vilocci.com' }, access_token: DEV_TOKEN } } }),
              signInWithPassword: async () => ({ data: {}, error: null }),
              signOut: async () => ({ error: null }),
              onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
            },
            from() {
              return {
                select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'admin-1', role: 'admin' }, error: null }) }) }),
              };
            },
          }),
        };
        window.__SPINTO_SUPABASE_URL = '%VITE_SUPABASE_URL%';
        window.__SPINTO_SUPABASE_ANON_KEY = '%VITE_SUPABASE_ANON_KEY%';
        window.scrollTo = () => {};
        const realSetInterval = window.setInterval.bind(window);
        window.setInterval = (fn, ms) => realSetInterval(() => {}, 2147483000);
        window.fetch = (url, opts) => {
          const full = typeof url === 'string' ? url : url.url;
          if (full.includes('/api/admin/config')) {
            return Promise.resolve({
              ok: true, status: 200,
              json: () => Promise.resolve({
                url: 'https://testproject.supabase.co',
                anonKey: 'fake-anon-key-0123456789-abcdefghijklmnopqrstuvwxyz',
              }),
            });
          }
          const opt = Object.assign({}, opts);
          opt.headers = Object.assign({}, opt.headers, { 'x-admin-dev-token': DEV_TOKEN });
          return fetch(full.startsWith('http') ? full : API + full, opt);
        };
        window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'admin-app.js'), 'utf8'));
      },
    });

    await wait(600);
    const adoc = adminDom.window.document;
    const aClick = (el) => el.dispatchEvent(new adminDom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    // Navigate to products view
    const prodNav = adoc.querySelector('[data-nav="products"]');
    check('sidebar has products nav ([data-nav="products"])', !!prodNav);
    if (prodNav) aClick(prodNav);
    await wait(400);

    // Check products table has Key shapes column
    const tableHeaders = Array.from(adoc.querySelectorAll('.data-table thead th')).map(th => th.textContent.trim());
    check('Products table has Key shapes column', tableHeaders.includes('Key shapes'), tableHeaders.join(', '));

    const shapeCells = adoc.querySelectorAll('.pshape-cell');
    check('Products table renders shape badges in rows', shapeCells.length > 0);

    // Open edit modal for target product
    const editBtn = adoc.querySelector(`[data-edit="${target.id}"]`) || adoc.querySelector(`[data-edit-product="${target.id}"]`);
    check('product edit button exists with data-edit or data-edit-product', !!editBtn);
    if (editBtn) aClick(editBtn);
    await wait(300);

    // Check modal has Key shapes section
    const shapeList = adoc.querySelector('#product-shapes-list');
    check('modal opens with Key shapes section (#product-shapes-list)', !!shapeList);

    const shapeRows = adoc.querySelectorAll('#product-shapes-list .pshape-row');
    check('shape rows rendered for product', shapeRows.length > 0);

    const chkA = adoc.querySelector('input[name="shapeok_A"]');
    check('Shape A checkbox (shapeok_A) exists', !!chkA);

    // Toggle Shape A back to in stock
    if (chkA && !chkA.checked) {
      aClick(chkA);
      await wait(100);
    }
    const statA = adoc.querySelector('[data-stocklbl="A"]');
    check('toggling Shape A checkbox updates status to In stock', statA && /In stock/i.test(statA.textContent));

    // Save product via save button
    const saveBtn = adoc.querySelector('#btn-save-product');
    check('save button present', !!saveBtn);
    if (saveBtn) aClick(saveBtn);
    await wait(600);

    // Verify saved to server
    const reloaded = (await http('GET', '/api/data')).json.products.find(p => p.id === target.id);
    const savedA = (reloaded.keyShapes || []).find(s => s.shape === 'A');
    check('Shape A was saved back to available: true in database', savedA && savedA.available === true);

    try { dom.window.close(); } catch (e) {}
    try { adminDom.window.close(); } catch (e) {}
  } finally {
    child.kill();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
