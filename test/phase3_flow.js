// Phase 3 — full sales flow: Fitment -> Add to Cart -> Cross-sell -> Checkout -> Success.
// Uses the live server on :3000. Verifies per-item vehicle fitment is captured,
// bundle discount applies from cross-sell, COD order resolves 'Pending', and the
// thank-you page renders complete order details.
'use strict';
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const API = 'http://localhost:3000';
const OUT = path.join(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n); } };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1, locale: 'en-US' });
  // fresh, deterministic state
  await ctx.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('velocci_lang', 'en');
  });
  const page = await ctx.newPage();
  const shot = (name) => page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: false });

  console.log('\n== 1. FITMENT (Mercedes · C-Class · 2022 · Shape B) ==');
  await page.goto(API + '/#/fitment', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.click('[data-fitbrand="mercedes-benz"]');
  await page.waitForTimeout(400);
  await page.click('[data-fitmodel="C-Class"]');
  await page.waitForTimeout(400);
  await page.click('[data-fityear="2022"]');
  await page.waitForTimeout(400);
  await page.click('[data-fit-shape="B"]');
  await page.waitForTimeout(900);
  check('fitment complete, compatible results shown', await page.$('.fit-results .product-grid') !== null);
  check('vehicle context shows Mercedes·C-Class·2022', /Mercedes.*C-Class.*2022/i.test(await page.textContent('.fit-vehicle') || ''));

  const caseId = await page.evaluate(async () => {
    const d = await (await fetch('/api/data')).json();
    return d.products.find(p => p.brandSlug === 'mercedes-benz' && p.category === 'keycase').id;
  });

  console.log('\n== 2. ADD KEY CASE TO CART ==');
  await page.click(`[data-addfit="${caseId}"]`);
  await page.waitForTimeout(900);
  check('cart badge = 1 (key case added)', (await page.textContent('#cart-badge' || 'body')) === null ? false : (await page.textContent('#cart-badge')).trim() === '1');
  check('drawer opened', (await page.$('#cart-drawer')).evaluate ? await (await page.$('#cart-drawer')).evaluate(el => el.classList.contains('open')) : false);
  const veh = await page.textContent('.drawer-item .di-vehicle');
  check('cart item shows fitted vehicle', /Mercedes|مرسيدس/.test(veh || '') && /C-Class/.test(veh || '') && /2022/.test(veh || ''));
  check('cart item shows key shape B', /Shape B|الشكل B/.test(veh || ''));
  check('cross-sell COMPLETE YOUR SET present', /COMPLETE YOUR SET|أكمل/i.test(await page.textContent('.drawer-bundle') || ''));
  await shot('p3-cart-keycase-en');

  console.log('\n== 3. CROSS-SELL: add Key Holder + Medal to complete set ==');
  // click both suggested items (holder + medal); re-query after each re-render
  let addbuttons = await page.$$('.drawer-bundle [data-addbundle]');
  let clicked = 0;
  while (addbuttons.length && clicked < 3) {
    await addbuttons[0].click();
    await page.waitForTimeout(700);
    clicked++;
    addbuttons = await page.$$('.drawer-bundle [data-addbundle]');
  }
  check('added at least 2 cross-sell items', clicked >= 2);
  check('cart now has 3 set items', (await page.textContent('#drawer-head-count')).includes('3'));
  check('bundle discount shown (negative EGP)', /−\s*EGP\s*[1-9]/.test(await page.textContent('#cart-summary') || ''));
  check('Bundle Applied! tag shown', /Bundle Applied|تطبيق خصم/.test(await page.textContent('#cart-summary') || ''));
  check('bundle price cross-out shown (→)', (await page.textContent('#cart-summary')).includes('→'));
  check('You saved message shown', /You saved|وفرت/.test(await page.textContent('#cart-summary') || ''));
  await shot('p3-cart-bundle-en');

  console.log('\n== 4. CHECKOUT (guest, COD) ==');
  await page.click('#cart-proceed');
  await page.waitForTimeout(1200);
  check('checkout form present', await page.$('#checkout-form') !== null);
  check('COD mentioned at checkout', /Cash on Delivery|الدفع عند الاستلام/.test(await page.textContent('body') || ''));
  check('checkout item shows fitted vehicle', /C-Class/.test(await page.textContent('.checkout-grid .drawer-item') || ''));
  await shot('p3-checkout-en');

  await page.fill('input[name="fullName"]', 'Ahmed Hassan');
  await page.fill('input[name="phone"]', '+201234567890');
  await page.fill('input[name="city"]', 'Cairo');
  await page.fill('input[name="area"]', 'New Cairo');
  await page.fill('textarea[name="address"]', '14 St, District 5, New Cairo');
  await page.fill('textarea[name="notes"]', 'Call before delivery');
  await page.click('#checkout-form button[type="submit"]');
  await page.waitForFunction(() => location.hash.indexOf('#/success') === 0, { timeout: 8000 });
  await page.waitForTimeout(900);
  await shot('p3-success-en');

  console.log('\n== 5. SUCCESS PAGE ==');
  check('order confirmed shown', /Order Confirmed|تم تأكيد/.test(await page.textContent('.success') || ''));
  check('order id shown (ORD-)', /ORD-/.test(await page.textContent('.success') || ''));
  check('COD payment method shown', /CASH ON DELIVERY|الدفع عند الاستلام/.test(await page.textContent('.success') || ''));
  check('order items listed', (await page.$$('.success-card .s-item')).length >= 3);
  check('item fitment shown on success', /C-Class/.test(await page.textContent('.success') || ''));
  check('bundle saved message on success', /You saved|وفرت/.test(await page.textContent('.success') || ''));
  check('customer details shown', /Ahmed Hassan/.test(await page.textContent('.success') || ''));
  check('order date shown', /\b20\d\d\b/.test(await page.textContent('.success') || ''));

  console.log('\n== 6. PERSISTED ORDER ==');
  const order = await page.evaluate(async () => {
    const d = await (await fetch('/api/data')).json();
    return null; // /api/data (public) has no orders; read the DB file instead
  });
  const db = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'velocci-db.json'), 'utf8'));
  const last = db.orders[db.orders.length - 1];
  check('order status is Pending', last.status === 'Pending');
  check('order payment is Cash on Delivery', /Cash on Delivery/.test(last.payment));
  check('order has per-item fitment', last.items.every(it => it.fitment && it.fitment.brand === 'mercedes-benz' && it.fitment.model === 'C-Class' && it.fitment.year === '2022'));
  check('order has 3 set items', last.items.length === 3);
  check('order bundle discount applied', last.bundleDiscount > 0);
  check('order customer saved', last.customer.fullName === 'Ahmed Hassan');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
