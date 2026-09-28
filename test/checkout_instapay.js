// Checkout InstaPay visibility — desktop + mobile. Requires server on :3000.
//
// The InstaPay block (exact amount, transfer link, instructions and the payment
// screenshot upload) only belongs to InstaPay: Cash on Delivery hides all of it,
// InstaPay reveals it, and switching back hides it again without a reload.
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

  const cta = page.locator('#instapay-cta-box');
  const ctaLink = page.locator('#instapay-link-btn');
  const proofInput = page.locator('#instapay-proof-input');
  const proofPicker = page.locator('#instapay-proof-picker');
  const title = page.locator('#instapay-title-link');

  // ---- Cash on Delivery (the default) hides everything InstaPay-specific ----
  check(name + ': COD is the default method', await page.locator('input[value="Cash on Delivery"]').isChecked());
  check(name + ': InstaPay option is still displayed', await page.locator('#pay-option-instapay').isVisible());
  check(name + ': Pay with InstaPay title is a link to the configured URL', (await title.getAttribute('href')) === expectedUrl && await title.isVisible());
  check(name + ': COD hides the InstaPay block', !(await cta.isVisible()), 'instapay block was visible under COD');
  check(name + ': COD hides the transfer link', !(await ctaLink.isVisible()));
  check(name + ': COD hides the exact amount', !(await page.locator('#instapay-due-amount').isVisible()));
  check(name + ': COD hides the payment screenshot upload', !(await proofPicker.isVisible()));
  check(name + ': COD does not require a screenshot', await proofInput.getAttribute('required') === null);
  await page.screenshot({ path: path.join(OUT, 'checkout-cod-' + name + '.png'), fullPage: true });

  // ---- InstaPay reveals it immediately (no reload) --------------------------
  await page.fill('#checkout-form [name=fullName]', 'Switch Test');
  await page.locator('#pay-instapay-radio').check();
  await page.waitForTimeout(150);
  check(name + ': InstaPay reveals the InstaPay block', await cta.isVisible());
  check(name + ': Open InstaPay Link is displayed', await ctaLink.isVisible());
  check(name + ': link href is configured URL', (await ctaLink.getAttribute('href')) === expectedUrl);
  check(name + ': the exact amount to transfer is displayed', await page.locator('#instapay-due-amount').isVisible());
  check(name + ': the payment screenshot upload appears', await proofPicker.isVisible());
  check(name + ': proof becomes required when InstaPay is selected', await proofInput.getAttribute('required') !== null);
  check(name + ': payment proof title is exact', /Upload Transfer Proof/.test(await page.locator('.instapay-proof-label').textContent() || ''));
  check(name + ': payment proof description is exact', (await page.locator('.instapay-proof-copy').textContent() || '').trim() === 'Upload your InstaPay payment screenshot');
  check(name + ': payment proof button text is exact', (await proofPicker.textContent() || '').trim() === 'Upload Transfer Proof');
  check(name + ': switching methods did not reload the page',
    await page.inputValue('#checkout-form [name=fullName]') === 'Switch Test'
    && await page.evaluate(() => location.hash) === '#/checkout');
  await page.screenshot({ path: path.join(OUT, 'checkout-instapay-' + name + '.png'), fullPage: true });

  // ---- InstaPay → Cash on Delivery hides it again ---------------------------
  await page.locator('input[value="Cash on Delivery"]').check();
  await page.waitForTimeout(150);
  check(name + ': switching back to COD hides the InstaPay block again', !(await cta.isVisible()));
  check(name + ': switching back to COD hides the screenshot upload', !(await proofPicker.isVisible()));
  check(name + ': COD does not require proof', await proofInput.getAttribute('required') === null);

  // ---- required customer information ---------------------------------------
  await page.locator('#checkout-form button[type="submit"]').click();
  await page.waitForTimeout(300);
  check(name + ': an empty form does not place the order', !/^#\/success\//.test(await page.evaluate(() => location.hash)),
    await page.evaluate(() => location.hash));
  const redFields = await page.evaluate(() => [...document.querySelectorAll('#checkout-form .field.has-error')]
    .map(f => (f.querySelector('input,textarea') || {}).name));
  check(name + ': every required field turns red', ['fullName', 'phone', 'city', 'address'].every(n => redFields.indexOf(n) >= 0), redFields.join(','));
  const messages = await page.$$eval('#checkout-form .field-error', els => els.map(e => e.textContent.trim()));
  check(name + ': every red field explains what is missing', messages.length >= 4 && messages.every(m => m.length > 5), messages.join(' | '));
  check(name + ': optional fields are never flagged', await page.evaluate(() => {
    const area = document.querySelector('#checkout-form [name=area]');
    const notes = document.querySelector('#checkout-form [name=notes]');
    return !area.closest('.field').classList.contains('has-error') && !notes.closest('.field').classList.contains('has-error');
  }));

  await page.fill('#checkout-form [name=fullName]', 'Playwright Customer');
  await page.waitForTimeout(120);
  check(name + ': the filled field loses its red state', await page.evaluate(() =>
    !document.querySelector('#checkout-form [name=fullName]').closest('.field').classList.contains('has-error')));
  await page.fill('#checkout-form [name=phone]', '+201000000000');
  await page.fill('#checkout-form [name=city]', 'Cairo');
  await page.fill('#checkout-form [name=address]', '14 Test Street');
  await page.waitForTimeout(120);
  check(name + ': no error remains once every field is valid', await page.$$eval('#checkout-form .field.has-error', els => els.length) === 0);

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
