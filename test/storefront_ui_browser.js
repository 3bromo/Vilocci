// Real-browser verification of the three storefront behaviours — desktop +
// mobile. Requires the server on :3000 and a Playwright browser
// (`npx playwright install chromium`).
//
//   1. Cash on Delivery hides the InstaPay block, InstaPay reveals it.
//   2. An empty required field turns red (real computed border colour) and no
//      order is created; filling it clears the state.
//   3. Search closes on a click/tap outside it and stays open when clicked
//      inside — the X button included.
//
// Usage: npm run test:ui
'use strict';
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const API = 'http://localhost:3000';
const OUT = path.join(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const check = (n, c, extra) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, extra !== undefined ? `→ ${extra}` : ''); } };

const DANGER = '192, 57, 43'; // --danger

async function runViewport(browser, name, viewport) {
  console.log('\n== ' + name.toUpperCase() + ' ==');
  const ctx = await browser.newContext({ viewport, locale: 'en-US' });
  await ctx.addInitScript(() => { localStorage.clear(); localStorage.setItem('velocci_lang', 'en'); });
  const page = await ctx.newPage();

  const catalog = await (await fetch(API + '/api/data')).json();
  const prod = catalog.products.find(p => (p.keyShapes || []).some(s => s.available)) || catalog.products[0];

  // ---------------------------------------------------------------- checkout
  await page.goto(API + '/#/product/' + prod.slug, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const shape = page.locator('.shape-opt.selectable').first();
  if (await shape.count()) { await shape.click(); await page.waitForTimeout(250); }
  const color = page.locator('.color-selector .color-opt').first();
  if (await color.count()) { await color.click(); await page.waitForTimeout(200); }   // products with colour variants require a colour
  const add = page.locator('#addbtn');
  if (await add.count()) { await add.click(); await page.waitForTimeout(400); }
  await page.goto(API + '/#/checkout', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  check(name + ': checkout form present', await page.locator('#checkout-form').count() === 1);

  const display = (sel) => page.$eval(sel, (el) => getComputedStyle(el).display);
  check(name + ': COD is the default method', await page.locator('input[value="Cash on Delivery"]').isChecked());
  check(name + ': COD hides the InstaPay block completely (computed display)', await display('#instapay-cta-box') === 'none',
    await display('#instapay-cta-box'));
  check(name + ': the hidden block is not clickable', !(await page.locator('#instapay-proof-picker').isVisible()));

  await page.locator('#pay-instapay-radio').check();
  await page.waitForTimeout(150);
  check(name + ': InstaPay shows the block again', await page.locator('#instapay-cta-box').isVisible() && await display('#instapay-cta-box') !== 'none');
  check(name + ': the screenshot upload is usable under InstaPay', await page.locator('#instapay-proof-picker').isVisible());
  await page.locator('input[value="Cash on Delivery"]').check();
  await page.waitForTimeout(150);
  check(name + ': switching back to COD hides it again', await display('#instapay-cta-box') === 'none');

  // ------------------------------------------------- required customer fields
  await page.locator('#checkout-form button[type="submit"]').click();
  await page.waitForTimeout(300);
  check(name + ': no order is created from an empty form', !/^#\/success\//.test(await page.evaluate(() => location.hash)),
    await page.evaluate(() => location.hash));
  const border = await page.$eval('#checkout-form [name=fullName]', (el) => getComputedStyle(el).borderColor);
  check(name + ': the empty field is really red on screen', border.replace(/\s/g, '').indexOf(DANGER.replace(/\s/g, '')) >= 0, border);
  const msg = await page.$eval('#checkout-form [name=fullName]', (el) => {
    const box = el.closest('.field').querySelector('.field-error');
    return box ? box.textContent.trim() : '';
  });
  check(name + ': the field says it is required', /required/i.test(msg), msg);

  await page.fill('#checkout-form [name=fullName]', 'Browser Tester');
  await page.waitForTimeout(150);
  check(name + ': typing a valid value clears the red state', await page.$eval('#checkout-form [name=fullName]', (el) => {
    const field = el.closest('.field');
    const box = field.querySelector('.field-error');
    return !field.classList.contains('has-error') && (!box || !box.textContent.trim());
  }));

  // ------------------------------------------------------------------ search
  const panel = page.locator('#search-panel');
  await page.locator('#search-btn').click();
  await page.waitForTimeout(150);
  check(name + ': the search icon opens search', await panel.isVisible());
  await page.fill('#search-input', 'key');
  await page.waitForTimeout(250);
  check(name + ': typing still returns results', await page.locator('#search-results a.result').count() > 0);

  // a real mouse click far away from the panel (bottom of the viewport)
  await page.mouse.click(5, viewport.height - 5);
  await page.waitForTimeout(150);
  check(name + ': clicking outside closes search', !(await panel.isVisible()));
  check(name + ': the closed search gives up focus', await page.evaluate(() => document.activeElement !== document.querySelector('#search-input')));

  await page.locator('#search-btn').click();
  await page.waitForTimeout(150);
  await page.click('#search-input');
  await page.waitForTimeout(100);
  check(name + ': clicking the search field keeps it open', await panel.isVisible());
  await page.fill('#search-input', 'key');
  await page.waitForTimeout(250);
  await page.locator('#search-results').click({ position: { x: 10, y: 10 } });
  await page.waitForTimeout(150);
  check(name + ': clicking the results area keeps it open', await panel.isVisible());

  await page.locator('#search-results a.result').first().click();
  await page.waitForTimeout(250);
  check(name + ': a result still closes search', !(await panel.isVisible()));

  await page.locator('#search-btn').click();
  await page.waitForTimeout(150);
  await page.locator('#search-close').click();
  await page.waitForTimeout(150);
  check(name + ': the X button still closes search', !(await panel.isVisible()));

  await page.screenshot({ path: path.join(OUT, 'storefront-ui-' + name + '.png'), fullPage: false });
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
