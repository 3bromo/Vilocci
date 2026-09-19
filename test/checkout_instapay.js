// Checkout InstaPay visibility — desktop + mobile. Requires server on :3000.
'use strict';
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const API = 'http://localhost:3000';
const OUT = path.join(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n); } };

async function runViewport(browser, name, viewport) {
  console.log('\n== CHECKOUT ' + name.toUpperCase() + ' ==');
  const ctx = await browser.newContext({ viewport, locale: 'en-US' });
  await ctx.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('velocci_lang', 'en');
  });
  const page = await ctx.newPage();
  const data = await page.evaluate(async () => {
    // page not loaded yet
    return null;
  }).catch(() => null);

  await page.goto(API + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  const catalog = await page.evaluate(async () => (await (await fetch('/api/data')).json()));
  check(name + ': API has instapay enabled+url', !!(catalog.settings && catalog.settings.instapay && catalog.settings.instapay.enabled && catalog.settings.instapay.url));
  const expectedUrl = catalog.settings.instapay.url;

  const prod = catalog.products.find(p => (p.keyShapes || []).some(s => s.available)) || catalog.products[0];
  await page.goto(API + '/#/product/' + prod.slug, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const shape = await page.$('.shape-opt.selectable');
  if (shape) { await shape.click(); await page.waitForTimeout(250); }
  const add = await page.$('#addbtn');
  if (add) { await add.click(); await page.waitForTimeout(400); }
  await page.goto(API + '/#/checkout', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  const body = await page.textContent('body');
  check(name + ': checkout form present', await page.$('#checkout-form') !== null);
  check(name + ': COD still visible', /Cash on Delivery|الدفع عند الاستلام/i.test(body || ''));
  check(name + ': Pay with InstaPay visible', /Pay with InstaPay/.test(body || ''));
  check(name + ': Open InstaPay Link visible', /Open InstaPay Link/.test(body || ''));

  const insta = page.locator('#pay-option-instapay');
  check(name + ': InstaPay option is displayed', await insta.isVisible());
  const cta = page.locator('#instapay-link-btn');
  check(name + ': Open InstaPay Link is displayed (not hidden)', await cta.isVisible());
  const href = await cta.getAttribute('href');
  check(name + ': link href is configured URL', href === expectedUrl);

  const title = page.locator('#instapay-title-link');
  check(name + ': Pay with InstaPay title is a link', (await title.getAttribute('href')) === expectedUrl);
  check(name + ': title is visible', await title.isVisible());

  check(name + ': exact amount appears near InstaPay instructions', await page.locator('#instapay-due-amount').isVisible());
  const proofInput = page.locator('#instapay-proof-input');
  check(name + ': payment proof picker exists inside InstaPay', await proofInput.count() === 1);
  check(name + ': payment proof title is exact', /Upload Transfer Proof/.test(await page.locator('.instapay-proof-label').textContent() || ''));
  check(name + ': payment proof description is exact', (await page.locator('.instapay-proof-copy').textContent() || '').trim() === 'Upload your InstaPay payment screenshot');
  check(name + ': payment proof button is exact and visible', await page.locator('#instapay-proof-picker').isVisible() && (await page.locator('#instapay-proof-picker').textContent() || '').trim() === 'Upload Transfer Proof');
  await page.locator('#pay-instapay-radio').check();
  check(name + ': proof becomes required when InstaPay is selected', await proofInput.getAttribute('required') !== null);
  await page.locator('input[value="Cash on Delivery"]').check();
  check(name + ': COD does not require proof', await proofInput.getAttribute('required') === null);

  await page.screenshot({ path: path.join(OUT, 'checkout-instapay-' + name + '.png'), fullPage: true });
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch();
  await runViewport(browser, 'desktop', { width: 1280, height: 900 });
  await runViewport(browser, 'mobile', { width: 390, height: 844 });
  await browser.close();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
