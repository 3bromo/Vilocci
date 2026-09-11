// Capture screenshots of the live site for visual verification.
'use strict';
const { chromium } = require('playwright-core');
const path = require('path');
const API = 'http://localhost:3000';
const OUT = path.join(__dirname, '..', 'shots');

(async () => {
  const fs = require('fs');
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();

  async function shot(name, url, waitMs = 1200, actions) {
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(waitMs);
    if (actions) await actions(page);
    await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: false });
    console.log('shot:', name);
  }

  // Home (EN) — full page
  await page.goto(API + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, 'home-en.png'), fullPage: true });
  console.log('shot: home-en (full)');
  // Product page
  const slug = await page.evaluate(async () => {
    const d = await (await fetch('/api/data')).json();
    return d.products[0].slug;
  });
  await shot('product-en', API + '/#/product/' + slug, 1400, async (p) => {
    // select an available shape
    const sel = await p.$('.shape-opt.selectable');
    if (sel) await sel.click();
    await p.waitForTimeout(500);
  });
  // Cart drawer open
  await shot('cart-open', API + '/#/product/' + slug, 1200, async (p) => {
    const sel = await p.$('.shape-opt.selectable');
    if (sel) await sel.click();
    await p.waitForTimeout(300);
    const add = await p.$('#addbtn');
    if (add) await add.click();
    await p.waitForTimeout(700);
  });
  // Category
  await shot('category-en', API + '/#/category/keycases', 1200);
  // Brand page
  await shot('brand-en', API + '/#/brand/mercedes-benz', 1200);
  // Fitment
  await shot('fitment-en', API + '/#/fitment', 1200);
  // Checkout
  await shot('checkout-en', API + '/#/checkout', 1200);
  // Arabic home
  await shot('home-ar', API + '/', 1400, async (p) => {
    await p.click('[data-lang="ar"]');
    await p.waitForTimeout(600);
  });
  // Admin dashboard (authenticated)
  await page.goto(API + '/admin', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.fill('input[name="password"]', 'velocci2026');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, 'admin-dashboard.png') });
  console.log('shot: admin-dashboard');
  // products view
  await page.click('[data-view="products"]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'admin-products.png') });
  console.log('shot: admin-products');
  // orders view
  await page.click('[data-view="orders"]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'admin-orders.png') });
  console.log('shot: admin-orders');

  await browser.close();
  console.log('DONE');
})().catch(e => { console.error(e); process.exit(1); });
