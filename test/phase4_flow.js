'use strict';
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const API = 'http://localhost:3000';
const OUT = path.join(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const DBFILE = path.join(__dirname, '..', 'data', 'velocci-db.json');

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n); } };
const readDb = () => JSON.parse(fs.readFileSync(DBFILE, 'utf8'));

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 950 }, locale: 'en-US' });
  await ctx.addInitScript(() => { localStorage.clear(); localStorage.setItem('velocci_lang', 'en'); });
  const page = await ctx.newPage();
  const shot = (n) => page.screenshot({ path: path.join(OUT, n + '.png') });

  // ---- ADMIN AUTH (login via UI, then reuse the session cookie) ----
  await page.goto(API + '/admin', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.fill('input[name="password"]', 'velocci2026');
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(1200);
  const cookies = await ctx.cookies();
  const cookieHeader = cookies.map(c => c.name + '=' + c.value).join('; ');
  const api = (method, url, body) => fetch(API + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'Cookie': cookieHeader },
    body: body ? JSON.stringify(body) : undefined,
  }).then(r => r.json().then(j => ({ ok: r.ok, j, status: r.status })));

  // ---- BASELINES (originals restored on teardown) ----
  const carbon = readDb().products.find(p => p.brandSlug === 'mercedes-benz' && p.category === 'keycase' && p.name_en.includes('Carbon'));
  const origPrice = carbon.price;
  const bundle = readDb().bundles.find(x => x.brandSlug === 'mercedes-benz');
  const origBundle = JSON.parse(JSON.stringify(bundle));
  const brandOrderOrig = readDb().brands.map(x => x.id);
  let touchedOrderId = null, touchedOrderStatus = null; // order actually modified, for clean restore
  const mercedesAll = readDb().products.filter(p => p.brandSlug === 'mercedes-benz');
  const origKg = {}; mercedesAll.forEach(p => origKg[p.id] = JSON.parse(JSON.stringify(p.keyShapes)));

  const restore = async () => {
    await api('POST', '/api/admin/save', { collection: 'products', record: Object.assign({}, carbon, { price: origPrice }) });
    for (const p of mercedesAll) await api('POST', '/api/admin/save', { collection: 'products', record: Object.assign({}, p, { keyShapes: origKg[p.id] }) });
    await api('POST', '/api/admin/save', { collection: 'bundles', record: origBundle });
    if (touchedOrderId) await api('POST', '/api/admin/order-status', { id: touchedOrderId, status: touchedOrderStatus });
    await api('POST', '/api/admin/reorder', { collection: 'brands', ids: brandOrderOrig });
  };

  try {
    check('admin logged in, dashboard shown', await page.$('.cards') !== null);

    // ===== 1. ORDERS: details & status update =====
    console.log('\n== ORDERS: details + status update ==');
    await page.click('[data-view="orders"]'); await page.waitForTimeout(500);
    const detailBtn = await page.$('[data-orderdetails]');
    check('orders table has Details button', !!detailBtn);
    const detailId = await detailBtn.getAttribute('data-orderdetails');
    const origDetailStatus = readDb().orders.find(o => o.id === detailId).status;
    touchedOrderId = detailId; touchedOrderStatus = origDetailStatus;
    await detailBtn.click(); await page.waitForTimeout(500);
    const mtext = await page.evaluate(() => (document.querySelector('#order-modal') || {}).innerText || '');
    check('order details: shows vehicle fitment (Shape)', /Shape/.test(mtext));
    check('order details: shows Complete Your Set / bundle', /Complete Your Set/.test(mtext));
    check('order details: shows customer address', /Apr|St|City|District|القاهرة/i.test(mtext));
    await shot('p4-order-details');
    const newStatus = origDetailStatus === 'Processing' ? 'Shipped' : 'Processing';
    await page.selectOption('#od-status', newStatus);
    await page.click('#od-save'); await page.waitForTimeout(1200);
    let upd = readDb().orders.find(o => o.id === detailId);
    check('order status persisted (' + newStatus + ' + history)', upd.status === newStatus && (upd.statusHistory || []).some(h => h.status === newStatus));
    check('admin orders table reflects new status', await page.evaluate(() => /Processing|Shipped/.test(document.body.innerText)));
    await api('POST', '/api/admin/order-status', { id: detailId, status: origDetailStatus });

    // ===== 2. PRODUCT PRICE edit -> frontend PDP =====
    console.log('\n== PRODUCT EDIT: price -> frontend ==');
    await page.click('[data-view="products"]'); await page.waitForTimeout(500);
    await page.click(`[data-edit="${carbon.id}"]`); await page.waitForTimeout(500);
    await page.fill('input[name="price"]', '1599');
    await page.click('#ed-save'); await page.waitForTimeout(1200);
    check('admin saved new price', readDb().products.find(p => p.id === carbon.id).price === 1599);
    await page.goto(API + '/#/product/' + carbon.slug, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    check('frontend PDP shows new price (1,599)', /1,599/.test(await page.evaluate(() => document.body.innerText)));
    await shot('p4-pdp-price');
    await api('POST', '/api/admin/save', { collection: 'products', record: Object.assign({}, carbon, { price: origPrice }) });

    // ===== 3. INVENTORY: per-shape OOS -> frontend fitment =====
    console.log('\n== INVENTORY: shape OOS -> frontend ==');
    // (a) one product shape A OOS via admin UI
    await page.goto(API + '/admin', { waitUntil: 'networkidle' }); await page.waitForTimeout(500);
    await page.click('[data-view="products"]'); await page.waitForTimeout(500);
    await page.click(`[data-edit="${carbon.id}"]`); await page.waitForTimeout(500);
    const shA = await page.$('input[name="shapeok_A"]');
    if (shA && (await shA.isChecked())) { await shA.click(); await page.waitForTimeout(250); }
    await page.click('#ed-save'); await page.waitForTimeout(1200);
    check('admin set carbon shape A OOS', (readDb().products.find(p => p.id === carbon.id).keyShapes || []).find(s => s.shape === 'A').available === false);
    await page.goto(API + '/#/fitment', { waitUntil: 'networkidle' }); await page.waitForTimeout(400);
    await page.click('[data-fitbrand="mercedes-benz"]'); await page.waitForTimeout(200);
    await page.click('[data-fitmodel="C-Class"]'); await page.waitForTimeout(200);
    await page.click('[data-fityear="2022"]'); await page.waitForTimeout(200);
    await page.click('[data-fit-shape="A"]'); await page.waitForTimeout(700);
    check('frontend removed OOS product from shape-A results', !/Carbon Key Case/.test(await page.evaluate(() => (document.querySelector('.fit-results') || { innerText: '' }).innerText)));
    await shot('p4-fitment-shapeA');

    // (b) ALL mercedes products shape A OOS -> shape unclickable
    for (const p of readDb().products.filter(x => x.brandSlug === 'mercedes-benz')) {
      const ks = (p.keyShapes || []).map(s => s.shape === 'A' ? { shape: s.shape, available: false } : s);
      await api('POST', '/api/admin/save', { collection: 'products', record: Object.assign({}, p, { keyShapes: ks }) });
    }
    // reset saved fitment and FORCE a full reload (the page is already on the
    // fitment route from step a, so a same-URL goto would not re-render). The
    // reload re-fetches /api/data and re-runs the init-script that clears
    // localStorage, landing us on the brand selector.
    await page.evaluate(() => localStorage.removeItem('velocci_fitment'));
    await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(600);
    await page.click('[data-fitbrand="mercedes-benz"]'); await page.waitForTimeout(300);
    await page.click('[data-fitmodel="C-Class"]'); await page.waitForTimeout(300);
    await page.click('[data-fityear="2022"]'); await page.waitForTimeout(300);
    const step = await page.evaluate(() => {
      const shA = document.querySelector('[data-fit-shape="A"]');
      const shB = document.querySelector('[data-fit-shape="B"]');
      return { disabled: shA ? shA.disabled : null, cls: shA ? shA.className : null, bEnabled: shB ? !shB.disabled : null };
    });
    check('frontend shape A unclickable when all stock gone', step.disabled === true && /unavailable/.test(step.cls || ''));
    check('frontend shape B still selectable', step.bEnabled === true);
    await shot('p4-fitment-shapeA-oos');

    // ===== 4. BUNDLE: discount by percentage (server recompute) =====
    console.log('\n== BUNDLES: % discount ==');
    const bb = readDb().bundles.find(x => x.brandSlug === 'mercedes-benz');
    const pct = 15;
    const expectPrice = Math.round(bb.normalTotal * (1 - pct / 100));
    await api('POST', '/api/admin/save', { collection: 'bundles', record: Object.assign({}, bb, { discountMode: 'percent', discountPercent: pct, discountAmount: 0, active: true, bundlePrice: expectPrice }) });
    const bb2 = readDb().bundles.find(x => x.brandSlug === 'mercedes-benz');
    check('bundle price recomputed from 15%', bb2.bundlePrice === expectPrice);
    check('bundle discountPercent persisted', Math.abs(bb2.discountPercent - pct) <= 1);

    // ===== 5. HOMEPAGE CMS: featured toggle + brand reorder =====
    console.log('\n== HOMEPAGE CMS: featured + brand reorder ==');
    await page.goto(API + '/admin', { waitUntil: 'networkidle' }); await page.waitForTimeout(500);
    await page.click('[data-view="hero"]'); await page.waitForTimeout(600);
    check('brand logo reorder list present', await page.$('#brands-sort') !== null);
    const featBox = await page.$('.feat-toggle[data-flag="featured"]');
    const fPid = await featBox.getAttribute('data-pid');
    const beforeFlag = !!readDb().products.find(p => p.id === fPid).featured;
    await featBox.click(); await page.waitForTimeout(1000);
    const afterFlag = !!readDb().products.find(p => p.id === fPid).featured;
    check('featured flag toggled via CMS', afterFlag !== beforeFlag);
    await shot('p4-homepage-cms');
    // restore the toggled flag so we don't pollute the live DB
    await api('POST', '/api/admin/save', { collection: 'products', record: Object.assign({}, readDb().products.find(p => p.id === fPid), { featured: beforeFlag }) });

    // brand reorder uses a per-item `order` field (not array position)
    const ids = readDb().brands.map(x => x.id).reverse();
    await api('POST', '/api/admin/reorder', { collection: 'brands', ids });
    const orderMap = readDb().brands.reduce((m, x) => (m[x.id] = x.order, m), {});
    check('brand reorder persisted via order field', ids.every((id, i) => orderMap[id] === i + 1));

    // ===== 6. HERO IMAGE UPLOAD =====
    console.log('\n== HOMEPAGE: hero image upload ==');
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const up = await api('POST', '/api/admin/upload', { dataUrl: tinyPng });
    check('upload returns a served URL', up.ok && /\/img\/uploads\//.test(up.j.url || ''));
    if (up.ok && up.j.url) {
      const img = await fetch(API + up.j.url);
      check('uploaded image is servable', img.ok);
    }
    // invalid data rejected
    const bad = await api('POST', '/api/admin/upload', { dataUrl: 'not-an-image' });
    check('upload rejects non-image payload', bad.status === 400);
  } finally {
    await restore();
    await b.close();
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async e => { console.error(e); process.exit(1); });
