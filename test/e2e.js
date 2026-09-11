// End-to-end browser test: full purchase flow with real backend.
'use strict';
const { chromium } = require('playwright-core');
const API = 'http://localhost:3000';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  let pass = 0, fail = 0;
  const check = (n, c) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n); } };

  await page.goto(API + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  // Go to Mercedes product page
  const slug = await page.evaluate(async () => (await (await fetch('/api/data')).json()).products.find(p => p.brandSlug === 'mercedes-benz' && p.category === 'keycase').slug);
  await page.goto(API + '/#/product/' + slug, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  // Select shape A
  await page.click('.shape-opt.selectable[data-shape="A"]');
  await page.waitForTimeout(300);

  // Check "Complete Your Set" pricing
  const setInfo = await page.evaluate(() => {
    const card = document.querySelector('.bundle-card');
    return card ? card.textContent : '';
  });
  check('bundle card shows name of set', /Mercedes/i.test(setInfo));
  check('bundle card shows save', /SAVE|توفير/.test(setInfo));

  // Add the 3-piece set
  await page.click('#addset');
  await page.waitForTimeout(800);
  // close the cart drawer so it doesn't intercept clicks
  await page.click('#drawer-close');
  await page.waitForTimeout(300);

  // Now cart should have all 3 items and bundle discount applied
  const cartState = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.drawer-item')].length;
    const summary = document.querySelector('#cart-summary') ? document.querySelector('#cart-summary').textContent : '';
    return { items, summary };
  });
  check('cart has 3 set items', cartState.items >= 3);
  check('bundle discount shown (negative)', /−\s*EGP\s*[1-9]/.test(cartState.summary.replace(/\u2212/g, '−')) || /bundle.*EGP\s*[1-9]/i.test(cartState.summary));
  check('total shown in EGP', /EGP/.test(cartState.summary));

  // Go to checkout
  await page.goto(API + '/#/checkout', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  check('checkout form present', await page.$('#checkout-form') !== null);

  // Fill and place order
  await page.fill('input[name="fullName"]', 'Ali Hassan');
  await page.fill('input[name="phone"]', '+201000000000');
  await page.fill('input[name="city"]', 'Cairo');
  await page.fill('input[name="area"]', 'Nasr City');
  await page.fill('textarea[name="address"]', '123 Main St');
  await page.click('#checkout-form button[type="submit"]');
  await page.waitForTimeout(1200);

  const url = page.url();
  check('redirected to success page', url.includes('#/success'));
  const successText = await page.evaluate(() => document.body.textContent);
  check('order confirmed shown', /confirm/i.test(successText) || /تم تأكيد/i.test(successText));
  check('order id displayed', /ORD-/.test(successText));

  // Verify order is now in admin backend
  const ordersText = await page.evaluate(async () => {
    const res = await fetch('/api/admin/data');
    return res.status;
  });
  // check admin via a fresh authenticated request
  const adminData = await page.evaluate(async () => {
    const login = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'velocci2026' }) });
    const d = await fetch('/api/admin/data');
    return d.json();
  });
  check('order persisted in backend', adminData.orders.length >= 1);
  check('pre-order record separate', Array.isArray(adminData.preorders));

  await browser.close();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('E2E ERROR:', e); process.exit(1); });
