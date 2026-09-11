'use strict';
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const API = 'http://localhost:3000';
const OUT = path.join(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'ar-EG' });
  await ctx.addInitScript(() => { localStorage.clear(); localStorage.setItem('velocci_lang','ar'); });
  const page = await ctx.newPage();
  const shot = (n) => page.screenshot({ path: path.join(OUT, n + '.png') });
  const data0 = await (await fetch(API+'/api/data')).json();
  const caseId = data0.products.find(p=>p.brandSlug==='mercedes-benz'&&p.category==='keycase').id;

  // fitment
  await page.goto(API + '/#/fitment', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const ar = await page.evaluate(() => document.documentElement.dir);
  console.log('html dir =', ar);
  await page.click('[data-fitbrand="mercedes-benz"]'); await page.waitForTimeout(300);
  await page.click('[data-fitmodel="C-Class"]'); await page.waitForTimeout(300);
  await page.click('[data-fityear="2022"]'); await page.waitForTimeout(300);
  await page.click('[data-fit-shape="B"]'); await page.waitForTimeout(700);

  // add keycase
  await page.click(`[data-addfit="${caseId}"]`); await page.waitForTimeout(800);
  // cross-sell add
  let btns = await page.$$('.drawer-bundle [data-addbundle]');
  while (btns.length) { await btns[0].click(); await page.waitForTimeout(700); btns = await page.$$('.drawer-bundle [data-addbundle]'); }
  await shot('p3-cart-bundle-ar');

  // checkout
  await page.click('#cart-proceed'); await page.waitForTimeout(1200);
  await page.fill('input[name="fullName"]', 'أحمد حسن');
  await page.fill('input[name="phone"]', '+201234567890');
  await page.fill('input[name="city"]', 'القاهرة');
  await page.fill('input[name="area"]', 'التجمع الخامس');
  await page.fill('textarea[name="address"]', 'شارع 14، الحي الخامس، القاهرة الجديدة');
  await shot('p3-checkout-ar');
  await page.click('#checkout-form button[type="submit"]');
  await page.waitForFunction(() => location.hash.indexOf('#/success') === 0, { timeout: 8000 });
  await page.waitForTimeout(1000);
  await shot('p3-success-ar');
  console.log('done AR screenshots');
  await b.close();
})().catch(e=>{console.error(e);process.exit(1);});
