'use strict';
// ===========================================================================
// Nano Ceramic Coating — the optional extra that REPLACED "Premium Gift"
// ---------------------------------------------------------------------------
// Contract under test (customer-facing spec):
//
//   * offered ONLY for Key Holders and Key Cases — never medals or anything
//     else, on the product page AND in the Quick Add modal;
//   * a FLAT EGP 100 per cart line that opts in — never × qty, never a
//     percentage, EGP 0 when not selected;
//   * the choice travels cart → checkout → order → admin (per-line snapshot
//     + order-level fee), priced by the SERVER (the client is never trusted);
//   * product prices, bundles, discount codes, InstaPay and COD untouched;
//   * the old Premium Gift Packaging option is gone from everywhere.
//
// Three layers, all against the real code (the test/discount.js pattern):
//   1. lib/mapping.js   the persistence mapping (migration-safe columns).
//   2. HTTP             the REAL express server on a scratch JSON datastore.
//   3. public/js/app.js the real storefront in jsdom, window.fetch forwarded
//                       to that same server.
//
// Usage: npm run test:coating
// ===========================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const PORT = 3493;
const API = `http://127.0.0.1:${PORT}`;
const DEV_TOKEN = 'coating-test-token-' + Date.now().toString(36);
const CART_KEY = 'velocci_cart';

let pass = 0; let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓', name); }
  else { fail += 1; console.log('  ✗', name, extra !== undefined ? `→ ${extra}` : ''); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, urlPath, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.admin) headers['x-admin-dev-token'] = DEV_TOKEN;
  const res = await fetch(API + urlPath, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON body */ }
  return { ok: res.ok, status: res.status, json };
}

async function waitForServer(child) {
  const deadline = Date.now() + 25000;
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  while (Date.now() < deadline) {
    try {
      const res = await fetch(API + '/api/data');
      if (res.ok) return { up: true, log };
    } catch (e) { /* not up yet */ }
    if (child.exitCode !== null) return { up: false, log: log + `\nserver exited: ${child.exitCode}` };
    await wait(150);
  }
  return { up: false, log };
}

// ---------------------------------------------------------------------------
// catalog helpers — the FIRST enabled color and an available shape, exactly
// what the storefront sends; expected totals computed from the real settings.
// ---------------------------------------------------------------------------
function firstColor(p) {
  const c = (p.colors || []).find((x) => x.enabled !== false);
  return c ? c.id : null;
}
function firstShape(p) {
  const s = (p.keyShapes || []).find((x) => x.available);
  return s ? s.shape : '';
}
function line(p, qty, coating) {
  return { productId: p.id, keyShape: firstShape(p), qty: qty || 1, colorId: firstColor(p), coating: coating === true };
}
function deliveryFor(settings, subtotal) {
  const threshold = settings.freeShippingThreshold || 0;
  return subtotal >= threshold ? 0 : (settings.shippingFee || 0);
}

// ===========================================================================
// 1. persistence mapping (lib/mapping.js) — migration-safe column handling
// ===========================================================================
function mappingTests() {
  console.log('\n== 1. Persistence mapping (lib/mapping.js) ==');
  const mapping = require('../lib/mapping');

  const baseOrder = {
    id: 'ORD-COATTEST', createdAt: new Date().toISOString(),
    customer: { fullName: 'T', phone: '1', city: 'C', address: 'A' },
    items: [], subtotal: 1000, bundleDiscount: 0, discount: 0,
    coatingFee: 0, deliveryFee: 60, total: 1060, status: 'Pending',
    payment: 'Cash on Delivery', currency: 'EGP',
  };

  const rowNoCoating = mapping.orderToRow(Object.assign({}, baseOrder));
  check('an order WITHOUT coating never writes coating_fee (pre-migration safety)',
    !('coating_fee' in rowNoCoating), JSON.stringify(Object.keys(rowNoCoating)));

  const rowCoated = mapping.orderToRow(Object.assign({}, baseOrder, { coatingFee: 200, total: 1260 }));
  check('an order WITH coating writes coating_fee', rowCoated.coating_fee === 200, rowCoated.coating_fee);

  const back = mapping.rowToOrder({ id: 'X', total: 5, coating_fee: 100 }, []);
  check('rowToOrder surfaces coatingFee', back.coatingFee === 100, back.coatingFee);
  const backMissing = mapping.rowToOrder({ id: 'X', total: 5 }, []);
  check('a pre-migration row without the column reads as coatingFee 0',
    backMissing.coatingFee === 0, backMissing.coatingFee);

  const itemBase = { productId: 'p1', name_en: 'n', qty: 1, price: 10, lineTotal: 10 };
  const itemPlain = mapping.orderItemToRow(Object.assign({}, itemBase, { coating: false }), 'ORD-1', 0);
  check('an un-coated line never writes the coating column (pre-migration safety)',
    !('coating' in itemPlain), JSON.stringify(Object.keys(itemPlain)));
  const itemCoated = mapping.orderItemToRow(Object.assign({}, itemBase, { coating: true }), 'ORD-1', 0);
  check('a coated line writes coating = true', itemCoated.coating === true, itemCoated.coating);

  check('rowToOrderItem surfaces the coating snapshot',
    mapping.rowToOrderItem({ id: 'i', coating: true }).coating === true);
  check('a legacy item row reads as coating = false',
    mapping.rowToOrderItem({ id: 'i' }).coating === false);

  check('orders COLUMNS whitelist contains coating_fee',
    mapping.COLUMNS.orders.includes('coating_fee'));
  check('order_items COLUMNS whitelist contains coating',
    mapping.COLUMNS.order_items.includes('coating'));
}

// ===========================================================================
// 2. the REAL server — eligibility, flat per-line fee, totals, admin APIs
// ===========================================================================
async function serverTests(cat) {
  console.log('\n== 2. POST /api/orders (real server) ==');
  const { products, settings } = cat;
  const holder = products.find((p) => p.id === 'p_mercedes-benz_holder') || products.find((p) => p.category === 'keyholder');
  const kase = products.find((p) => p.id === 'p_mercedes-benz_case_carbon') || products.find((p) => p.category === 'keycase');
  const medal = products.find((p) => p.id === 'p_mercedes-benz_medal') || products.find((p) => p.category === 'medal');
  check('catalog has a key holder, a key case and a medal', !!holder && !!kase && !!medal);
  const customer = { fullName: 'Coating Tester', phone: '+201000000000', city: 'Cairo', address: '1 Test Street' };

  async function place(cart, extra) {
    return http('POST', '/api/orders', Object.assign({ customer, cart, payment: 'Cash on Delivery' }, extra || {}));
  }
  function expectedTotal(items, coatingFee, bundleDiscount, codeDiscount) {
    const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
    return subtotal - (bundleDiscount || 0) - (codeDiscount || 0) + deliveryFor(settings, subtotal) + coatingFee;
  }

  // --- Key Holder, coated, qty 1 ------------------------------------------
  const r1 = await place([line(holder, 1, true)]);
  check('coated key holder order is accepted', r1.status === 200 && r1.json.ok === true, JSON.stringify(r1.json));
  check('coated key holder adds EXACTLY EGP 100', r1.json.coatingFee === 100, r1.json.coatingFee);
  check('coated key holder total = subtotal + delivery + 100',
    r1.json.total === expectedTotal([{ price: holder.price, qty: 1 }], 100), r1.json.total);

  // --- Key Holder, coated, qty 3 — the fee NEVER scales with qty -----------
  const r2 = await place([line(holder, 3, true)]);
  check('qty 3 of a coated key holder still adds exactly EGP 100 (never × qty)',
    r2.json.coatingFee === 100, r2.json.coatingFee);
  check('qty 3 total = 3 × price + delivery + 100',
    r2.json.total === expectedTotal([{ price: holder.price, qty: 3 }], 100), r2.json.total);

  // --- Key Case, coated ----------------------------------------------------
  const r3 = await place([line(kase, 1, true)]);
  check('coated key case adds exactly EGP 100', r3.json.coatingFee === 100, r3.json.coatingFee);

  // --- two coated lines ----------------------------------------------------
  const r4 = await place([line(holder, 1, true), line(kase, 1, true)]);
  check('two coated lines add EGP 100 each (200)', r4.json.coatingFee === 200, r4.json.coatingFee);
  check('two coated lines total = subtotal + delivery + 200',
    r4.json.total === expectedTotal([{ price: holder.price, qty: 1 }, { price: kase.price, qty: 1 }], 200), r4.json.total);

  // --- MEDAL with coating claimed by a hand-edited client → stripped -------
  const r5 = await place([line(medal, 1, true)]);
  check('a medal order is accepted', r5.status === 200, JSON.stringify(r5.json));
  check('coating on a MEDAL is refused: fee is 0', r5.json.coatingFee === 0, r5.json.coatingFee);
  check('medal total carries no coating fee',
    r5.json.total === expectedTotal([{ price: medal.price, qty: 1 }], 0), r5.json.total);

  // --- uncoated key holder → EGP 0 -----------------------------------------
  const r6 = await place([line(holder, 1, false)]);
  check('an unselected coating adds EGP 0', r6.json.coatingFee === 0, r6.json.coatingFee);
  check('uncoated total = subtotal + delivery (prices untouched)',
    r6.json.total === expectedTotal([{ price: holder.price, qty: 1 }], 0), r6.json.total);

  // --- mixed: coated holder + uncoated medal -------------------------------
  const r7 = await place([line(holder, 1, true), line(medal, 1, false)]);
  check('mixed cart charges only the coated line', r7.json.coatingFee === 100, r7.json.coatingFee);

  // --- full Mercedes set (bundle) + coatings: bundle logic untouched --------
  const bundle = (cat.bundles || []).find((b) => b.brandSlug === 'mercedes-benz' && b.active !== false);
  if (bundle) {
    const r8 = await place([line(holder, 1, true), line(kase, 1, true), line(medal, 1, false)]);
    const bundleDiscount = Math.max(0, bundle.normalTotal - bundle.bundlePrice);
    const subtotal = holder.price + kase.price + medal.price;
    check('full set + 2 coatings: bundle discount still applies in full',
      r8.json.total === subtotal - bundleDiscount + deliveryFor(settings, subtotal) + 200,
      `${r8.json.total} vs ${subtotal - bundleDiscount + deliveryFor(settings, subtotal) + 200}`);
  } else {
    check('full set bundle fixture exists for mercedes-benz', false);
  }

  // --- discount code + coating: the code eats subtotal, never the fee -------
  const r9 = await place([line(holder, 2, true)], { discountCode: 'COATFIXED' });
  const sub9 = holder.price * 2;
  check('discount code + coating: fixed EGP 100 code applied to the subtotal',
    r9.json.discount === 100, JSON.stringify(r9.json));
  check('discount code + coating: fee stays exactly 100 on top',
    r9.json.coatingFee === 100, r9.json.coatingFee);
  check('discount code + coating: total = subtotal − code + delivery + 100',
    r9.json.total === sub9 - 100 + deliveryFor(settings, sub9) + 100, r9.json.total);

  // --- the stored order (admin side) ---------------------------------------
  console.log('\n== 3. Admin API — the selection is stored with the order ==');
  const detail = await http('GET', `/api/admin/order/${encodeURIComponent(r1.json.orderId)}`, undefined, { admin: true });
  check('admin order detail exposes coatingFee', detail.json && detail.json.coatingFee === 100, detail.json && detail.json.coatingFee);
  const storedItem = detail.json && (detail.json.items || [])[0];
  check('admin order detail marks the coated LINE', storedItem && storedItem.coating === true, JSON.stringify(storedItem));
  check('stored unit price is the untouched catalog price',
    storedItem && storedItem.price === holder.price && storedItem.lineTotal === holder.price,
    storedItem && `${storedItem.price}/${storedItem.lineTotal}`);

  const medalDetail = await http('GET', `/api/admin/order/${encodeURIComponent(r5.json.orderId)}`, undefined, { admin: true });
  const medalItem = medalDetail.json && (medalDetail.json.items || [])[0];
  check('a claimed-but-ineligible medal line is stored WITHOUT coating',
    medalItem && medalItem.coating === false, JSON.stringify(medalItem && medalItem.coating));

  const list = await http('GET', '/api/admin/orders', undefined, { admin: true });
  const listed = (list.json.orders || []).find((o) => o.id === r4.json.orderId);
  check('admin orders list carries the coating fee (2 coated lines → 200)',
    listed && listed.coatingFee === 200, listed && listed.coatingFee);

  // --- InstaPay path keeps working WITH a coated line ----------------------
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const r10 = await place([line(kase, 1, true)], { payment: 'InstaPay', paymentProof: png });
  check('InstaPay order with coating succeeds and charges the fee',
    r10.status === 200 && r10.json.coatingFee === 100, JSON.stringify(r10.json).slice(0, 160));

  return { holder, kase, medal, orderId: r1.json.orderId };
}

// ===========================================================================
// 3. the storefront (public/js/app.js in jsdom, real server behind fetch)
// ===========================================================================
async function storefrontTests(cat, picks) {
  console.log('\n== 4. Storefront: product pages (eligibility + copy) ==');
  const { holder, kase, medal } = picks;

  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => {
    if (!/Could not load|Not implemented/.test(e.message)) console.log('  ! page error:', e.message);
  });

  const dom = new JSDOM(html, {
    virtualConsole,
    url: API + '/#/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.alert = () => {};
      window.confirm = () => true;
      window.scrollTo = () => {};
      window.fetch = (u, o = {}) => {
        const url = typeof u === 'string' ? u : u.url;
        const target = /^https?:/.test(url) ? url : API + url;
        return fetch(target, { method: o.method || 'GET', headers: o.headers, body: o.body })
          .then(async (r) => {
            const text = await r.text();
            return { ok: r.ok, status: r.status, url: target, json: async () => JSON.parse(text), text: async () => text };
          });
      };
    },
  });
  const { window } = dom;
  const { document } = window;
  window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'engine.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8'));
  await wait(400);

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const setHash = async (h, ms) => { window.location.hash = h; window.dispatchEvent(new window.HashChangeEvent('hashchange')); await wait(ms || 80); };
  const moneyOf = (s) => Number(String(s || '').replace(/[^\d.]/g, ''));
  const cartLines = () => JSON.parse(window.localStorage.getItem(CART_KEY) || '[]');

  // --- KEY HOLDER product page ---------------------------------------------
  await setHash('#/product/' + holder.slug);
  check('key holder PDP shows the Nano Ceramic Coating option', !!$('.coating-option'));
  const coatBox = $('.coating-option');
  check('the option label says Nano Ceramic Coating',
    !!coatBox && /Nano Ceramic Coating/.test(coatBox.textContent), coatBox && coatBox.textContent.trim().slice(0, 80));
  check('the customer sees the flat + EGP 100 price on the option',
    !!coatBox && /EGP\s*100/.test(coatBox.querySelector('.coating-price') ? coatBox.querySelector('.coating-price').textContent : ''),
    coatBox && coatBox.querySelector('.coating-price') && coatBox.querySelector('.coating-price').textContent);
  check('the description explains protection + durability',
    !!coatBox && /extra protection and durability/.test(coatBox.textContent));
  check('the old Premium Gift option is gone from the product page',
    !/Premium Gift/i.test(document.body.textContent) && !$('#gift-packaging') && !$('.gift-packaging-option'));

  // select shape (+ color when configured), then opt in to the coating
  click($('.shape-opt.selectable'));
  await wait(60);
  const colorOpt = $('.color-selector .color-opt');
  if (colorOpt) { click(colorOpt); await wait(60); }
  const coatingInput = $('#nano-coating');
  check('the coating checkbox is rendered', !!coatingInput);
  coatingInput.checked = true;
  coatingInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(30);
  check('selecting the coating highlights the option', $('.coating-option').classList.contains('on'));

  // a PDP re-render (another shape click) must NOT drop the selection
  const otherShape = $$('.shape-opt.selectable').find((b) => !b.classList.contains('selected'));
  if (otherShape) {
    click(otherShape);
    await wait(60);
    check('the coating selection survives a PDP re-render',
      !!$('#nano-coating') && $('#nano-coating').checked === true);
  }

  // --- add to cart ----------------------------------------------------------
  const addBtn = $('#addbtn');
  check('add to cart is enabled with shape (+color) chosen', !!addBtn && addBtn.disabled === false);
  click(addBtn);
  await wait(120);
  let lines = cartLines();
  check('the cart line stores the coating selection', lines.length === 1 && lines[0].coating === true, JSON.stringify(lines));

  // --- cart drawer ------------------------------------------------------------
  click($('#cart-btn'));
  await wait(80);
  const summary = $('#cart-summary');
  check('the cart drawer item shows the coating chip', !!$('.drawer-item .di-coat .coat-chip'));
  check('the cart drawer totals show a Nano Ceramic Coating row (+ EGP 100)',
    !!summary && /Nano Ceramic Coating/.test(summary.textContent) && /\+\s*EGP\s*100/.test(summary.textContent),
    summary && summary.textContent.replace(/\s+/g, ' ').slice(0, 200));
  const drawerTotal = moneyOf(($('#cart-summary .row.total') || {}).textContent);
  const expectedDrawerTotal = holder.price + deliveryFor(cat.settings, holder.price) + 100;
  check('the cart drawer total = price + delivery + 100',
    drawerTotal === expectedDrawerTotal, `${drawerTotal} vs ${expectedDrawerTotal}`);

  // qty + on the coated line: fee stays flat, line qty changes
  const plusBtn = $('.drawer-item [data-qtyv="1"]');
  click(plusBtn);
  await wait(80);
  lines = cartLines();
  const drawerTotal2 = moneyOf(($('#cart-summary .row.total') || {}).textContent);
  const sub2 = holder.price * 2;
  check('qty 2 in the drawer keeps the fee at exactly EGP 100',
    lines[0].qty === 2 && /Nano Ceramic Coating/.test($('#cart-summary').textContent)
      && drawerTotal2 === sub2 + deliveryFor(cat.settings, sub2) + 100,
    `${lines[0] && lines[0].qty} / ${drawerTotal2}`);
  // remove the line again (exercises the coating-aware remove key)
  click($('.drawer-item [data-qtyv="-1"]'));
  await wait(80);
  check('qty − restores the single coated unit', cartLines()[0].qty === 1);
  click($('#drawer-overlay'));
  await wait(50);

  // --- KEY CASE product page ---------------------------------------------------
  await setHash('#/product/' + kase.slug);
  check('key case PDP shows the Nano Ceramic Coating option', !!$('.coating-option') && !!$('#nano-coating'));

  // --- MEDAL product page --------------------------------------------------------
  await setHash('#/product/' + medal.slug);
  check('medal PDP does NOT show the coating option', !$('.coating-option') && !$('#nano-coating'));
  check('medal PDP shows no leftover gift option either', !$('.gift-packaging-option') && !$('#gift-packaging'));

  // --- Arabic ----------------------------------------------------------------------
  console.log('\n== 5. Storefront: Arabic (RTL) ==');
  click($('.shape-opt.selectable')); // medals also need a shape for add; harmless here
  await wait(40);
  click($('[data-lang="ar"]'));
  await wait(120);
  await setHash('#/product/' + holder.slug, 120);
  const arBox = $('.coating-option');
  check('the Arabic PDP shows the coating option with the Arabic label',
    !!arBox && /طلاء نانو سيراميك/.test(arBox.textContent), arBox && arBox.textContent.trim().slice(0, 60));
  check('the Arabic option keeps the EGP 100 price visible',
    !!arBox && /EGP\s*100/.test(arBox.textContent));
  check('the page is in RTL mode', document.documentElement.dir === 'rtl');
  click($('[data-lang="en"]'));
  await wait(120);

  // --- Quick Add -------------------------------------------------------------------
  console.log('\n== 6. Storefront: Quick Add modal ==');
  // empty the cart through the drawer so quick-add assertions are unambiguous
  await setHash('#/');
  click($('#cart-btn'));
  await wait(60);
  let guard = 0;
  while ($('.drawer-item .di-remove') && guard < 10) { click($('.drawer-item .di-remove')); await wait(60); guard += 1; }
  check('cart emptied before the quick-add checks', cartLines().length === 0, JSON.stringify(cartLines()));
  click($('#drawer-overlay'));
  await wait(50);

  await setHash('#/category/keyholders');
  const qaHolderBtn = $('.product-card [data-add]');
  check('a key holder card offers quick add', !!qaHolderBtn);
  click(qaHolderBtn);
  await wait(120);
  let modal = $('.modal-overlay.qa-overlay');
  check('quick add opens for the key holder', !!modal);
  check('quick add offers the coating checkbox with the + EGP 100 price',
    !!modal && !!modal.querySelector('#qa-coating') && /EGP\s*100/.test(modal.querySelector('.qa-coating').textContent),
    modal && modal.querySelector('.qa-coating') && modal.querySelector('.qa-coating').textContent.replace(/\s+/g, ' ').slice(0, 120));
  check('the quick-add coating block is clearly optional',
    !!modal && /Optional extra/i.test(modal.querySelector('.qa-coating').textContent));
  check('the two mandatory quick-add steps are unchanged',
    !!modal && modal.querySelectorAll('.qa-step').length === (modal.querySelector('[data-qablock="color"]') ? 2 : 1));
  // choose shape (+color), tick coating, add
  click(modal.querySelector('[data-qa]'));
  await wait(60);
  const qaColor = modal.querySelector('[data-qac]');
  if (qaColor) { click(qaColor); await wait(60); }
  const qaCoat = modal.querySelector('#qa-coating');
  qaCoat.checked = true;
  qaCoat.dispatchEvent(new window.Event('change', { bubbles: true }));
  click(modal.querySelector('.qa-add'));
  await wait(150);
  lines = cartLines();
  check('quick add stores the coating on the cart line',
    lines.length === 1 && lines[0].coating === true, JSON.stringify(lines));

  // medal quick add → no coating block at all
  await setHash('#/category/medals');
  const qaMedalBtn = $('.product-card [data-add]');
  click(qaMedalBtn);
  await wait(120);
  modal = $('.modal-overlay.qa-overlay');
  check('medal quick add opens', !!modal);
  check('medal quick add has NO coating option', !!modal && !modal.querySelector('#qa-coating') && !modal.querySelector('.qa-coating'));
  click(modal.querySelector('.qa-close'));
  await wait(50);

  // --- checkout → order → success (the real server round trip) ---------------------
  console.log('\n== 7. Checkout → order → success page ==');
  await setHash('#/checkout');
  const totalsBox = $('#checkout-totals');
  check('the checkout summary shows the coating row',
    !!totalsBox && /Nano Ceramic Coating/.test(totalsBox.textContent) && /\+\s*EGP\s*100/.test(totalsBox.textContent),
    totalsBox && totalsBox.textContent.replace(/\s+/g, ' ').slice(0, 200));
  const coatedLine = cartLines()[0];
  const coatedProd = cat.products.find((p) => p.id === coatedLine.productId);
  const expectedCheckoutTotal = coatedProd.price + deliveryFor(cat.settings, coatedProd.price) + 100;
  check('the checkout total includes exactly EGP 100 for the coating',
    moneyOf(($('#checkout-totals .row.total') || {}).textContent) === expectedCheckoutTotal,
    `${moneyOf(($('#checkout-totals .row.total') || {}).textContent)} vs ${expectedCheckoutTotal}`);
  check('the checkout item list marks the coated line', !!$('.checkout-grid .di-coat .coat-chip'));

  // fill + submit (Cash on Delivery is the default)
  const form = $('#checkout-form');
  form.querySelector('[name=fullName]').value = 'Coating Customer';
  form.querySelector('[name=phone]').value = '+201000000000';
  form.querySelector('[name=city]').value = 'Cairo';
  form.querySelector('[name=address]').value = '1 Coating Street';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(900);

  check('the order was placed and the success page shown', /^#\/success\//.test(window.location.hash), window.location.hash);
  const successText = $('.success') ? $('.success').textContent : '';
  check('the success page lists the Nano Ceramic Coating fee',
    /Nano Ceramic Coating/.test(successText) && /\+\s*EGP\s*100/.test(successText), successText.replace(/\s+/g, ' ').slice(0, 200));
  check('the success page total matches the server total',
    moneyOf(($('.s-totals .row.total') || {}).textContent) === expectedCheckoutTotal,
    moneyOf(($('.s-totals .row.total') || {}).textContent));
  check('the success page item shows the coating chip', !!$('.s-item .di-coat .coat-chip'));

  // the stored order (admin truth) matches what the customer saw
  const placedId = (window.location.hash.split('/success/')[1] || '').split('?')[0];
  const stored = await http('GET', `/api/admin/order/${encodeURIComponent(placedId)}`, undefined, { admin: true });
  check('the stored order keeps coatingFee = 100', stored.json && stored.json.coatingFee === 100, stored.json && stored.json.coatingFee);
  check('the stored order line keeps the coating snapshot',
    stored.json && (stored.json.items || []).some((it) => it.coating === true),
    stored.json && JSON.stringify((stored.json.items || []).map((it) => it.coating)));

  dom.window.close();
}

// ===========================================================================
// 4. styles — the option is styled for the site (mobile-first, RTL aware)
// ===========================================================================
function styleTests() {
  console.log('\n== 8. Styles ==');
  const css = fs.readFileSync(path.join(PUBLIC, 'css', 'styles.css'), 'utf8');
  check('coating option styles are in the served stylesheet', /\.coating-option\s*\{/.test(css));
  check('the +EGP 100 price pill is styled', /\.coating-price\s*\{/.test(css));
  check('the cart/checkout/success chip is styled', /\.coat-chip\s*\{/.test(css));
  check('the quick-add coating block is styled', /\.qa-coating\s*\{/.test(css));
  check('RTL rules exist for the coating option', /html\[dir="rtl"\] \.coating-option/.test(css) && /html\[dir="rtl"\] \.coating-label/.test(css));
  check('the price pill uses a logical (RTL-safe) margin', /margin-inline-start/.test(css));
  // Comments may document the replacement's history; what matters is that no
  // gift selector or customer-visible "Premium Gift" string survives.
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  check('no gift-packaging styles remain',
    !/\.gift-/.test(cssNoComments) && !/Premium Gift/i.test(cssNoComments));
  const adminCss = fs.readFileSync(path.join(PUBLIC, 'css', 'admin.css'), 'utf8');
  check('the admin coating badge is styled', /\.badge-coating\s*\{/.test(adminCss));
}

// ===========================================================================
(async function main() {
  mappingTests();
  styleTests();

  // Scratch datastore so the committed dataset is never mutated by this test.
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vilocci-coating-'));
  const scratchDb = path.join(scratchDir, 'velocci-db.json');
  const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'velocci-db.json'), 'utf8'));
  source.discount_codes = [
    { id: 'disc_coat_fixed', code: 'COATFIXED', type: 'fixed', value: 100, min_order: 0, max_uses: null, used_count: 0, expires_at: null, active: true },
  ];
  fs.writeFileSync(scratchDb, JSON.stringify(source, null, 2));

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      VELOCCI_DB: scratchDb,
      DATA_DRIVER: 'json',
      ADMIN_DEV_TOKEN: DEV_TOKEN,
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_ANON_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      SUPABASE_DB_URL: '', DATABASE_URL: '', POSTGRES_URL: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const { up, log } = await waitForServer(child);
    if (!up) { console.error('server did not start\n', log); process.exit(1); }

    const payload = (await http('GET', '/api/data')).json;
    const picks = await serverTests(payload);
    await storefrontTests(payload, picks);
  } finally {
    child.kill('SIGTERM');
    await wait(200);
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
