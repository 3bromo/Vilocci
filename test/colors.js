'use strict';
// ============================================================================
// Product color system test (self-contained, real server)
// ----------------------------------------------------------------------------
// Boots the REAL server.js against a scratch JSON datastore and a dev admin
// token, then drives the live HTTP API to prove the complete color system:
//
//   storefront   every product carries its own colors via /api/data (nothing
//                hard-coded in the frontend), disabled colors are hidden, and
//                the jsdom storefront renders swatches straight from the data
//   admin        add / edit / reorder / enable / delete colors per product,
//                live from the HEX value, persisted through lib/db.js
//   ordering     the selected color is required, validated server-side against
//                the product's own list, and attached to the cart -> order ->
//                admin order detail
//   isolation    one product's color list never leaks into another product
//
// Usage: npm run test:colors
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const PORT = 3479;
const API = `http://127.0.0.1:${PORT}`;
const DEV_TOKEN = 'color-test-token-' + Date.now().toString(36);

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
    await wait(150);
  }
  return false;
}

(async function main() {
  // Scratch datastore so the committed dataset is never mutated by this test.
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinto-colors-'));
  const scratchDb = path.join(scratchDir, 'velocci-db.json');
  fs.copyFileSync(path.join(ROOT, 'data', 'velocci-db.json'), scratchDb);

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      VELOCCI_DB: scratchDb,
      DATA_DRIVER: 'json',
      ADMIN_DEV_TOKEN: DEV_TOKEN,
      // keep Supabase out of the picture for this local test
      VITE_SUPABASE_URL: '',
      SUPABASE_DB_URL: '', DATABASE_URL: '', POSTGRES_URL: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });

  try {
    const up = await waitForServer(child);
    if (!up) { console.error('server did not start\n', serverLog); process.exit(1); }

    // ------------------------------------------------------------------ 1
    console.log('\n== 1. Every product carries its own colors via /api/data ==');
    const data = (await http('GET', '/api/data')).json;
    check('storefront payload loaded', !!data && Array.isArray(data.products), typeof data);
    check('every product has a colors array', data.products.every((p) => Array.isArray(p.colors)),
      data.products.filter((p) => !Array.isArray(p.colors)).map((p) => p.id).slice(0, 5).join(','));
    const withColors = data.products.filter((p) => p.colors.length > 0);
    check('seeded products ship with color variants', withColors.length === data.products.length,
      `${withColors.length}/${data.products.length}`);
    const sample = withColors[0].colors[0];
    check('a color has id + EN + AR name + HEX',
      !!sample.id && !!sample.name_en && !!sample.name_ar && /^#[0-9A-F]{6}$/.test(sample.hex),
      JSON.stringify(sample));

    // ------------------------------------------------------------------ 2
    console.log('\n== 2. Admin color CRUD (add / edit / reorder / enable / delete) ==');
    const target = data.products.find((p) => p.id === 'p_mercedes-benz_case_carbon');
    check('test target product exists', !!target, 'p_mercedes-benz_case_carbon');
    const other = data.products.find((p) => p.id === 'p_bmw_case_carbon');
    check('independent control product exists', !!other, 'p_bmw_case_carbon');
    const originalOther = JSON.stringify(other.colors);

    // ADD a new color
    const added = target.colors.concat([{ id: 'color_new', name_en: 'Racing Red', name_ar: 'أحمر سباق', hex: '#b50a0a', enabled: true }]);
    let r = await http('POST', '/api/admin/update', { collection: 'products', id: target.id, updates: { colors: added } }, { admin: true });
    check('admin can add a color', r.ok && r.json.ok, JSON.stringify(r.json).slice(0, 160));
    let fresh = (await http('GET', '/api/data')).json.products.find((p) => p.id === target.id);
    check('added color visible on the storefront immediately',
      fresh.colors.some((c) => c.id === 'color_new' && c.hex === '#B50A0A' && c.name_ar === 'أحمر سباق'),
      JSON.stringify(fresh.colors.map((c) => c.id)));
    check('HEX normalized to uppercase 6-digit', fresh.colors.find((c) => c.id === 'color_new').hex === '#B50A0A');

    // EDIT a color name + hex
    const edited = fresh.colors.map((c) => c.id === 'color_new' ? Object.assign({}, c, { name_en: 'Rosso Corsa', hex: '#d40000' }) : c);
    r = await http('POST', '/api/admin/update', { collection: 'products', id: target.id, updates: { colors: edited } }, { admin: true });
    fresh = (await http('GET', '/api/data')).json.products.find((p) => p.id === target.id);
    const editedColor = fresh.colors.find((c) => c.id === 'color_new');
    check('admin can edit a color name + HEX', r.ok && editedColor.name_en === 'Rosso Corsa' && editedColor.hex === '#D40000',
      JSON.stringify(editedColor));

    // REORDER colors (array order == display order)
    const reordered = fresh.colors.slice().reverse();
    r = await http('POST', '/api/admin/update', { collection: 'products', id: target.id, updates: { colors: reordered } }, { admin: true });
    fresh = (await http('GET', '/api/data')).json.products.find((p) => p.id === target.id);
    check('admin can reorder colors', r.ok && JSON.stringify(fresh.colors.map((c) => c.id)) === JSON.stringify(reordered.map((c) => c.id)),
      fresh.colors.map((c) => c.id).join(','));

    // DISABLE a color — stays in the admin list, hidden from the storefront
    const disabled = fresh.colors.map((c) => c.id === 'color_new' ? Object.assign({}, c, { enabled: false }) : c);
    r = await http('POST', '/api/admin/update', { collection: 'products', id: target.id, updates: { colors: disabled } }, { admin: true });
    fresh = (await http('GET', '/api/data')).json.products.find((p) => p.id === target.id);
    const mapping = require('../lib/mapping');
    const activeNow = mapping.activeColors(fresh);
    check('admin can disable a color (kept in list)', r.ok && fresh.colors.find((c) => c.id === 'color_new').enabled === false);
    check('disabled color is NOT selectable on the storefront', !activeNow.some((c) => c.id === 'color_new'),
      activeNow.map((c) => c.id).join(','));

    // DELETE a color
    const removed = fresh.colors.filter((c) => c.id !== 'color_new');
    r = await http('POST', '/api/admin/update', { collection: 'products', id: target.id, updates: { colors: removed } }, { admin: true });
    fresh = (await http('GET', '/api/data')).json.products.find((p) => p.id === target.id);
    check('admin can delete a color', r.ok && !fresh.colors.some((c) => c.id === 'color_new'),
      fresh.colors.map((c) => c.id).join(','));

    // ------------------------------------------------------------------ 3
    console.log('\n== 3. Per-product isolation ==');
    const otherNow = (await http('GET', '/api/data')).json.products.find((p) => p.id === other.id);
    check("editing one product's colors never touches another", JSON.stringify(otherNow.colors) === originalOther);

    // ------------------------------------------------------------------ 4
    console.log('\n== 4. Selected color -> cart -> order -> admin order ==');
    const buyProduct = (await http('GET', '/api/data')).json.products.find((p) => p.id === target.id);
    const pickShape = (buyProduct.keyShapes || []).find((s) => s.available);
    const pickColor = mapping.activeColors(buyProduct)[0];
    check('target has an available shape + active color', !!pickShape && !!pickColor,
      JSON.stringify({ pickShape: pickShape && pickShape.shape, pickColor: pickColor && pickColor.id }));

    // missing color for a product that HAS colors must be rejected
    r = await http('POST', '/api/orders', {
      customer: { fullName: 'Color Test', phone: '+201000000001', city: 'Cairo', address: '1 Test St' },
      cart: [{ productId: buyProduct.id, keyShape: pickShape.shape, qty: 1 }],
    });
    check('order WITHOUT a required color is rejected', r.status === 400, r.status);

    // an unknown color id must be rejected (client is never trusted)
    r = await http('POST', '/api/orders', {
      customer: { fullName: 'Color Test', phone: '+201000000001', city: 'Cairo', address: '1 Test St' },
      cart: [{ productId: buyProduct.id, keyShape: pickShape.shape, qty: 1, colorId: 'color_does_not_exist' }],
    });
    check('order with an UNKNOWN color is rejected', r.status === 400, r.status);

    // a valid selection goes through and is attached to the order
    r = await http('POST', '/api/orders', {
      customer: { fullName: 'Color Test', phone: '+201000000001', city: 'Cairo', address: '1 Test St' },
      cart: [{ productId: buyProduct.id, keyShape: pickShape.shape, qty: 2, colorId: pickColor.id }],
    });
    check('order WITH a valid color is accepted', r.ok && r.json.ok, JSON.stringify(r.json).slice(0, 160));
    const orderId = r.json.orderId;

    const stored = (await http('GET', `/api/admin/order/${encodeURIComponent(orderId)}`, null, { admin: true })).json;
    const line = stored && stored.items && stored.items[0];
    check('admin order detail carries the chosen color',
      !!line && !!line.color && line.color.id === pickColor.id && line.color.hex === pickColor.hex,
      JSON.stringify(line && line.color));
    check('order color is a snapshot (EN + AR names)', !!line.color.name_en && !!line.color.name_ar,
      JSON.stringify(line.color));

    // The snapshot survives a later rename of the catalog color.
    const renamed = buyProduct.colors.map((c) => c.id === pickColor.id ? Object.assign({}, c, { name_en: 'Renamed Later' }) : c);
    await http('POST', '/api/admin/update', { collection: 'products', id: buyProduct.id, updates: { colors: renamed } }, { admin: true });
    const stored2 = (await http('GET', `/api/admin/order/${encodeURIComponent(orderId)}`, null, { admin: true })).json;
    check('order keeps its original color after the catalog color is renamed',
      stored2.items[0].color.name_en === line.color.name_en, stored2.items[0].color.name_en);
    // restore
    await http('POST', '/api/admin/update', { collection: 'products', id: buyProduct.id, updates: { colors: buyProduct.colors } }, { admin: true });

    // ------------------------------------------------------------------ 5
    console.log('\n== 5. Durability — colors persist to the JSON store ==');
    const onDisk = JSON.parse(fs.readFileSync(scratchDb, 'utf8'));
    const diskProduct = onDisk.products.find((p) => p.id === target.id);
    check('admin color edits were written to the datastore', Array.isArray(diskProduct.colors) && diskProduct.colors.length === buyProduct.colors.length,
      `disk=${diskProduct.colors.length} expected=${buyProduct.colors.length}`);
    check('stored color shape is {id,name_en,name_ar,hex,enabled}',
      diskProduct.colors.every((c) => c.id && c.name_en && c.hex && typeof c.enabled === 'boolean'));

    // ------------------------------------------------------------------ 6
    console.log('\n== 6. Storefront renders colors from the data (jsdom) ==');
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    const payload = (await http('GET', '/api/data')).json;
    const dom = new JSDOM(html, {
      url: API + '/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(window) {
        window.fetch = (u) => {
          const url = typeof u === 'string' ? u : u.url;
          if (url.indexOf('/api/data') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
          return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        };
        window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
        window.alert = () => {}; window.confirm = () => true;
      },
    });
    dom.window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'engine.js'), 'utf8'));
    dom.window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8'));
    await wait(160);
    const doc = dom.window.document;

    // product card shows swatches for a product that has colors
    const card = doc.querySelector(`.product-card[data-slug="${target.slug}"]`);
    check('product card renders color swatches', !!card && card.querySelectorAll('.pc-colors .cdot').length >= 2,
      card ? card.querySelectorAll('.pc-colors .cdot').length : 'no card');

    // product detail page shows a color selector built from the HEX values
    // (compare against the SAME payload the storefront received — `target`
    // still holds the pre-edit copy)
    const pdpProduct = payload.products.find((p) => p.id === target.id);
    const pdpActive = mapping.activeColors(pdpProduct);
    dom.window.location.hash = '#/product/' + target.slug;
    dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
    await wait(60);
    const colorOpts = doc.querySelectorAll('.color-selector .color-opt');
    check('PDP renders one color option per enabled color', colorOpts.length === pdpActive.length,
      `${colorOpts.length} vs ${pdpActive.length}`);
    const swatch = doc.querySelector('.color-selector .color-opt .color-swatch');
    check('PDP swatch background comes from the stored HEX',
      !!swatch && swatch.getAttribute('style').toLowerCase().includes(pdpActive[0].hex.toLowerCase()),
      swatch && swatch.getAttribute('style'));

    // add-to-cart is blocked until a color is chosen
    const shapeBtn = doc.querySelector('.shape-opt.selectable');
    if (shapeBtn) shapeBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(60);
    const addBtn = doc.querySelector('#addbtn');
    check('add-to-cart stays disabled until a color is picked', !!addBtn && addBtn.disabled === true);
    const colorBtn = doc.querySelector('.color-selector .color-opt');
    if (colorBtn) colorBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(60);
    check('add-to-cart enabled after shape + color', doc.querySelector('#addbtn').disabled === false);

    dom.window.close();

    console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error('colors test crashed:', e);
    console.error(serverLog.slice(-2000));
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await wait(150);
    try { child.kill('SIGKILL'); } catch (e) { /* already dead */ }
  }
})().catch((e) => { console.error('colors test crashed:', e); process.exit(1); });
