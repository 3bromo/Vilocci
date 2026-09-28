'use strict';
// ============================================================================
// Checkout payment-method visibility + required customer information + search
// ----------------------------------------------------------------------------
// Everything here is driven through the REAL storefront (jsdom, exactly like
// test/smoke.js, test/quickadd_mobile.js and test/discount.js) against the REAL
// server on a scratch datastore, so what is verified is the shipped code:
//
//   1. payment proof   the InstaPay block — exact amount, transfer link,
//                      instructions and the payment-screenshot upload — exists
//                      only while InstaPay is the selected payment method. Cash
//                      on Delivery hides the whole block again, instantly and
//                      without a reload.
//   2. required fields the order cannot be created while fullName, phone, city
//                      or address is empty or the phone is malformed: the field
//                      turns red, a message says what is missing, nothing is
//                      posted to /api/orders, and the red state clears itself as
//                      soon as the value is valid. `area` and `notes` stay
//                      optional, and the server keeps its own check.
//   3. search          a tap/click anywhere outside search closes it and drops
//                      focus (no X required), while taps inside the panel —
//                      field, results, close button — keep it open. The X
//                      button behaves exactly as before.
//
// Usage: npm run test:checkout
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const PORT = 3487;
const API = `http://127.0.0.1:${PORT}`;
const DEV_TOKEN = 'checkout-search-test-token-' + Date.now().toString(36);

// A real 1×1 PNG — the bytes the server's proof validation accepts.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

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
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(API + '/api/data');
      if (r.ok) return true;
    } catch (e) { /* not up yet */ }
    if (child.exitCode !== null) return false;
    await wait(150);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Boot the real storefront in jsdom. /api/data comes from the payload (fast and
// deterministic); every other call goes to the scratch server, and order posts
// are recorded so "no order was created" can be proved, not assumed.
// ---------------------------------------------------------------------------
async function boot({ payload, cart, hash = '#/checkout', lang = 'en' }) {
  const captured = { orderPosts: [] };
  const dom = new JSDOM(fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'), {
    url: API + '/' + hash,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (u, o) => {
        const url = typeof u === 'string' ? u : u.url;
        if (url.indexOf('/api/data') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
        if (url.indexOf('/api/orders') >= 0) {
          try { captured.orderPosts.push(JSON.parse((o && o.body) || '{}')); } catch (e) { captured.orderPosts.push({}); }
        }
        return fetch(url.indexOf('http') === 0 ? url : API + url, o);
      };
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.alert = () => {}; window.confirm = () => true;
      window.scrollTo = () => {};
      // jsdom has no object URLs; the browser preview the storefront builds from
      // them is exercised for real in the Playwright suite instead.
      window.URL.createObjectURL = () => 'blob:jsdom-preview';
      window.URL.revokeObjectURL = () => {};
      window.localStorage.setItem('velocci_lang', lang);
      if (cart) window.localStorage.setItem('velocci_cart', JSON.stringify(cart));
    },
  });
  dom.window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'engine.js'), 'utf8'));
  dom.window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'search.js'), 'utf8'));
  dom.window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8'));
  await wait(180);
  const { window } = dom;
  const doc = window.document;
  const $ = (sel) => doc.querySelector(sel);
  const $$ = (sel) => Array.from(doc.querySelectorAll(sel));
  const click = (el) => { if (!el) throw new Error('click: element not found'); el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); };
  const pointerDown = (el, pointerType) => el.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: pointerType || 'mouse' }));
  const type = (el, value) => { el.value = value; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
  const submit = (form) => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  return { dom, window, doc, $, $$, click, pointerDown, type, submit, captured, cart };
}

// A cart line the checkout accepts: an available key shape, plus the first
// enabled colour when the product has colour variants (both are mandatory for
// products that define them).
function cartLineFor(product) {
  const shape = (product.keyShapes || []).find((s) => s.available);
  const color = (product.colors || []).find((c) => c.enabled !== false && c.hex);
  return { productId: product.id, keyShape: shape ? shape.shape || shape.code : '', qty: 1, fitment: null, colorId: color ? color.id : null, coating: false };
}

(async function main() {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velocci-checkout-search-'));
  const scratchDb = path.join(scratchDir, 'velocci-db.json');
  fs.copyFileSync(path.join(ROOT, 'data', 'velocci-db.json'), scratchDb);

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      VELOCCI_DB: scratchDb,
      DATA_DRIVER: 'json',
      ADMIN_DEV_TOKEN: DEV_TOKEN,
      VITE_SUPABASE_URL: '',
      SUPABASE_DB_URL: '', DATABASE_URL: '', POSTGRES_URL: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });

  try {
    if (!(await waitForServer(child))) {
      console.error('server did not start\n', serverLog);
      process.exit(1);
    }

    const payload = (await http('GET', '/api/data')).json;
    const styles = fs.readFileSync(path.join(PUBLIC, 'css', 'styles.css'), 'utf8');
    const instapayUrl = (payload.settings && payload.settings.instapay && payload.settings.instapay.url) || '';
    const product = payload.products.find((p) => p.active !== false && (p.keyShapes || []).some((s) => s.available));
    check('catalog has an orderable product', !!product, product && product.slug);
    check('InstaPay is configured (link + screenshot flow)', !!instapayUrl, instapayUrl);
    const line = cartLineFor(product);

    // ==================================================================== 1
    console.log('\n== 1. The InstaPay block follows the payment method ==');
    const sf = await boot({ payload, cart: [line] });
    const cta = sf.$('#instapay-cta-box');
    const proofBox = sf.$('#instapay-proof-box');
    const proofInput = sf.$('#instapay-proof-input');
    const instaRadio = sf.$('input[name="paymentMethod"][value="InstaPay"]');
    const codRadio = sf.$('input[name="paymentMethod"][value="Cash on Delivery"]');
    const form = sf.$('#checkout-form');

    check('checkout form rendered', !!form);
    check('both payment methods are still offered',
      !!instaRadio && !!codRadio && /Pay with InstaPay/.test(sf.doc.body.textContent) && /Cash on Delivery/.test(sf.doc.body.textContent));
    check('Cash on Delivery is the default selection', !!codRadio && codRadio.checked);
    check('the screenshot upload lives inside the InstaPay block', !!proofBox && !!cta && cta.contains(proofBox));
    check('COD hides the InstaPay amount / link / instructions / upload',
      !!cta && cta.hidden === true && cta.getAttribute('hidden') !== null);
    check('COD does not make the screenshot upload required', !!proofInput && proofInput.getAttribute('required') === null);
    check('the InstaPay option itself stays selectable under COD',
      !!sf.$('#pay-option-instapay') && sf.$('#pay-option-instapay').getAttribute('hidden') === null && !!sf.$('#instapay-title-link'));

    instaRadio.checked = true;
    instaRadio.dispatchEvent(new sf.window.Event('change', { bubbles: true }));
    await wait(30);
    check('InstaPay shows the amount, the transfer link and the instructions', !!cta && cta.hidden === false);
    check('InstaPay shows the payment screenshot upload', !!sf.$('#instapay-proof-picker') && !!sf.$('.instapay-proof-label'));
    check('the upload becomes required for InstaPay', !!proofInput && proofInput.getAttribute('required') !== null);
    check('the proof block is marked active for InstaPay', !!proofBox && proofBox.classList.contains('is-active'));
    const money = (text) => (String(text).match(/([\d][\d.,]*)/) || ['', ''])[1];
    const dueAmount = sf.$('#instapay-due-amount') ? sf.$('#instapay-due-amount').textContent : '';
    const totalAmount = sf.$('#checkout-totals .row.total') ? sf.$('#checkout-totals .row.total').textContent : '';
    check('the exact amount to transfer matches the order total',
      !!money(dueAmount) && money(dueAmount) === money(totalAmount), `${dueAmount.trim()} vs ${totalAmount.trim()}`);

    codRadio.checked = true;
    codRadio.dispatchEvent(new sf.window.Event('change', { bubbles: true }));
    await wait(30);
    check('switching back to COD hides the screenshot upload again', !!cta && cta.hidden === true);
    check('switching back to COD clears the required flag', !!proofInput && proofInput.getAttribute('required') === null);
    check('switching back to COD clears any proof error', (sf.$('#instapay-proof-error') || {}).textContent === '');

    // the title link and the transfer button also select InstaPay (no reload)
    const formNode = sf.$('#checkout-form');
    sf.click(sf.$('#instapay-title-link'));
    await wait(30);
    check('clicking the InstaPay title reveals the block', !!cta && cta.hidden === false && !!instaRadio && instaRadio.checked);
    codRadio.checked = true;
    codRadio.dispatchEvent(new sf.window.Event('change', { bubbles: true }));
    await wait(20);
    sf.click(sf.$('#instapay-link-btn'));
    await wait(30);
    check('the transfer link keeps selecting InstaPay', !!instaRadio && instaRadio.checked && cta.hidden === false);
    check('switching payment methods never reloads the page', sf.$('#checkout-form') === formNode && sf.window.location.hash === '#/checkout');
    check('the hidden rule that makes the block disappear is shipped',
      /\.instapay-cta\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(styles));

    sf.dom.window.close();

    // ==================================================================== 2
    console.log('\n== 2. Customer information is validated before the order ==');
    const sf2 = await boot({ payload, cart: [line] });
    const form2 = sf2.$('#checkout-form');
    const fieldOf = (name) => sf2.$(`#checkout-form [name="${name}"]`);
    const fieldBoxOf = (name) => fieldOf(name).closest('.field');
    const errorOf = (name) => { const box = fieldBoxOf(name); return box ? box.querySelector('.field-error') : null; };

    check('the checkout form declares its required fields', ['fullName', 'phone', 'city', 'address']
      .every((n) => fieldOf(n) && fieldOf(n).getAttribute('required') !== null));
    check('area and notes stay optional', fieldOf('area').getAttribute('required') === null && fieldOf('notes').getAttribute('required') === null);

    sf2.submit(form2);
    await wait(220);
    check('an empty form does NOT create an order', sf2.captured.orderPosts.length === 0);
    check('an empty form never reaches the success page', !/^#\/success\//.test(sf2.window.location.hash), sf2.window.location.hash);
    check('every empty required field turns red', ['fullName', 'phone', 'city', 'address']
      .every((n) => fieldBoxOf(n).classList.contains('has-error')));
    check('every empty required field explains what is missing', ['fullName', 'phone', 'city', 'address']
      .every((n) => { const e = errorOf(n); return !!e && e.textContent.trim().length > 5; }),
      ['fullName', 'phone', 'city', 'address'].map((n) => (errorOf(n) || {}).textContent).join(' | '));
    check('optional fields are never flagged', !fieldBoxOf('area').classList.contains('has-error') && !fieldBoxOf('notes').classList.contains('has-error'));
    check('the required-field error style is shipped',
      /\.field\.has-error\s+input[^{]*\{[^}]*border-color:\s*var\(--danger\)/.test(styles) && /\.field-error\s*\{[^}]*var\(--danger\)/.test(styles));

    // typing a valid value clears only that field
    sf2.type(fieldOf('fullName'), 'Nour Ibrahim');
    await wait(20);
    check('the filled field loses its red state immediately', !fieldBoxOf('fullName').classList.contains('has-error'));
    check('a filled field shows no error message', (errorOf('fullName') || { textContent: '' }).textContent === '');
    check('the other empty fields stay flagged',
      ['phone', 'city', 'address'].every((n) => fieldBoxOf(n).classList.contains('has-error')));

    // an invalid phone is refused with its own message
    sf2.type(fieldOf('city'), 'Cairo');
    sf2.type(fieldOf('address'), '12 Nile Street, Zamalek');
    sf2.type(fieldOf('phone'), 'not-a-number');
    sf2.submit(form2);
    await wait(220);
    check('an invalid phone number does not create an order', sf2.captured.orderPosts.length === 0);
    check('only the phone field is flagged', fieldBoxOf('phone').classList.contains('has-error')
      && ['fullName', 'city', 'address'].every((n) => !fieldBoxOf(n).classList.contains('has-error')));
    check('the phone error explains the format', /phone number/i.test((errorOf('phone') || {}).textContent || ''),
      (errorOf('phone') || {}).textContent);

    // fixing it clears the error and lets the order through
    sf2.type(fieldOf('phone'), '+201000000000');
    await wait(20);
    check('a valid phone clears its red state', !fieldBoxOf('phone').classList.contains('has-error'));
    sf2.submit(form2);
    await wait(700);
    check('the order is created once every required field is valid', sf2.captured.orderPosts.length === 1, sf2.captured.orderPosts.length);
    const posted = sf2.captured.orderPosts[0] || {};
    check('the posted customer keeps the existing field names and values',
      posted.customer && posted.customer.fullName === 'Nour Ibrahim' && posted.customer.phone === '+201000000000'
      && posted.customer.city === 'Cairo' && posted.customer.address === '12 Nile Street, Zamalek',
      JSON.stringify(posted.customer));
    check('no field names were changed or added',
      Object.keys(posted.customer || {}).sort().join(',') === 'address,area,city,fullName,notes,phone',
      Object.keys(posted.customer || {}).join(','));
    check('the order carries the chosen payment method', posted.payment === 'Cash on Delivery', posted.payment);
    check('a COD order carries no payment screenshot', !('paymentProof' in posted));
    check('the success page is shown', /^#\/success\//.test(sf2.window.location.hash), sf2.window.location.hash);

    const createdId = (sf2.window.location.hash.split('/success/')[1] || '').split('?')[0];
    const stored = await http('GET', '/api/admin/order/' + encodeURIComponent(createdId), undefined, { admin: true });
    check('the server really stored the order', stored.ok && stored.json && stored.json.id === createdId, JSON.stringify(stored.json).slice(0, 120));
    check('the stored order holds no screenshot for COD', stored.json && !stored.json.paymentProof);

    // the server keeps its own guard (the client is not the only gate)
    const direct = await http('POST', '/api/orders', {
      customer: { fullName: '', phone: '', city: '', address: '' },
      cart: [{ productId: product.id, keyShape: line.keyShape, qty: 1, colorId: line.colorId }],
      payment: 'Cash on Delivery',
    });
    check('the API still refuses an incomplete customer', direct.status === 400, direct.status);

    // InstaPay is refused without its screenshot, accepted with it
    const noProof = await http('POST', '/api/orders', {
      customer: { fullName: 'Nour Ibrahim', phone: '+201000000000', city: 'Cairo', address: '12 Nile Street' },
      cart: [{ productId: product.id, keyShape: line.keyShape, qty: 1, colorId: line.colorId }],
      payment: 'InstaPay',
    });
    check('InstaPay still requires the payment screenshot server-side', noProof.status === 400 && noProof.json && noProof.json.code === 'PAYMENT_PROOF_REQUIRED', JSON.stringify(noProof.json));

    const sf3 = await boot({ payload, cart: [line] });
    sf3.click(sf3.$('input[name="paymentMethod"][value="InstaPay"]'));
    await wait(30);
    sf3.type(sf3.$('#checkout-form [name="fullName"]'), 'InstaPay Customer');
    sf3.type(sf3.$('#checkout-form [name="phone"]'), '01000000000');
    sf3.type(sf3.$('#checkout-form [name="city"]'), 'Giza');
    sf3.type(sf3.$('#checkout-form [name="address"]'), '5 Pyramids Road');
    sf3.submit(sf3.$('#checkout-form'));
    await wait(220);
    check('InstaPay without a screenshot is stopped in the browser too', sf3.captured.orderPosts.length === 0);
    check('the missing screenshot is explained on the upload', /screenshot/i.test((sf3.$('#instapay-proof-error') || {}).textContent || ''),
      (sf3.$('#instapay-proof-error') || {}).textContent);

    const file = new sf3.window.File([Buffer.from(PNG.split(',')[1], 'base64')], 'proof.png', { type: 'image/png' });
    const fileInput = sf3.$('#instapay-proof-input');
    Object.defineProperty(fileInput, 'files', { value: [file], writable: false });
    fileInput.dispatchEvent(new sf3.window.Event('change', { bubbles: true }));
    await wait(60);
    check('a valid screenshot clears the upload error', (sf3.$('#instapay-proof-error') || {}).textContent === '');
    sf3.submit(sf3.$('#checkout-form'));
    await wait(700);
    check('the InstaPay order is posted with its screenshot',
      sf3.captured.orderPosts.length === 1 && typeof sf3.captured.orderPosts[0].paymentProof === 'string' && sf3.captured.orderPosts[0].paymentProof.indexOf('data:image/png;base64,') === 0,
      sf3.captured.orderPosts.length);
    check('the InstaPay order completes on the success page', /^#\/success\//.test(sf3.window.location.hash), sf3.window.location.hash);

    // the same validation speaks Arabic in the Arabic storefront
    const sfAr = await boot({ payload, cart: [line], lang: 'ar' });
    sfAr.submit(sfAr.$('#checkout-form'));
    await wait(220);
    const arError = sfAr.$('#checkout-form [name="fullName"]').closest('.field').querySelector('.field-error');
    check('an empty required field is explained in Arabic too', !!arError && /مطلوب/.test(arError.textContent), arError && arError.textContent);
    check('Arabic errors do not create an order either', sfAr.captured.orderPosts.length === 0);
    check('the Arabic layout is untouched by the error state', sfAr.doc.documentElement.dir === 'rtl');

    sf2.dom.window.close();
    sf3.dom.window.close();
    sfAr.dom.window.close();

    // ==================================================================== 3
    console.log('\n== 3. Search closes on an outside tap (and stays open inside) ==');
    const sf4 = await boot({ payload, hash: '#/' });
    const panel = sf4.$('#search-panel');
    const input = sf4.$('#search-input');
    const results = sf4.$('#search-results');
    const open = () => !panel.classList.contains('hidden');

    check('search is closed on load', !open());
    sf4.click(sf4.$('#search-btn'));
    await wait(30);
    check('the search icon opens the panel', open());

    sf4.type(input, 'key');
    await wait(30);
    check('search still returns results while typing', results.querySelectorAll('a.result').length > 0, results.textContent.slice(0, 60));
    check('the panel stays open while typing', open());

    sf4.pointerDown(sf4.doc.body);
    await wait(30);
    check('tapping outside closes search', !open());
    check('closing clears the query', input.value === '');
    check('closing drops the focus', sf4.doc.activeElement !== input, sf4.doc.activeElement && sf4.doc.activeElement.tagName);

    sf4.click(sf4.$('#search-btn'));
    sf4.type(input, 'key');
    await wait(30);
    sf4.pointerDown(input);
    await wait(20);
    check('tapping the search field keeps it open', open() && input.value === 'key');
    sf4.pointerDown(sf4.$('.instapay-cta') || sf4.$('.search-panel .results'));
    await wait(20);
    sf4.pointerDown(results);
    await wait(20);
    check('tapping the results area keeps it open', open());
    sf4.pointerDown(sf4.$('#search-btn'));
    await wait(20);
    check('tapping the search icon keeps it open', open());

    const firstResult = results.querySelector('a.result');
    sf4.pointerDown(firstResult);
    await wait(20);
    check('tapping a result does not close it by accident', open());
    sf4.click(firstResult);
    await wait(30);
    check('choosing a result still closes search', !open());

    sf4.click(sf4.$('#search-btn'));
    await wait(20);
    sf4.click(sf4.$('#search-close'));
    await wait(20);
    check('the X button still closes search', !open());

    // mobile-style touch, and the re-render (language switch) path
    sf4.click(sf4.$('#search-btn'));
    await wait(20);
    sf4.pointerDown(sf4.doc.body, 'touch');
    await wait(20);
    check('a touch outside closes search too', !open());

    const langBtn = sf4.$('[data-lang="ar"]');
    sf4.click(langBtn);
    await wait(60);
    const panelAr = sf4.$('#search-panel');
    const inputAr = sf4.$('#search-input');
    sf4.click(sf4.$('#search-btn'));
    await wait(20);
    check('search still opens after a language switch (re-render)', !panelAr.classList.contains('hidden'));
    sf4.type(inputAr, 'مفتاح');
    await wait(30);
    sf4.pointerDown(sf4.doc.body);
    await wait(20);
    check('outside tap still closes search after a re-render', panelAr.classList.contains('hidden'));

    // the outside-tap listener must be live on touch + mouse devices
    const appJs = fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8');
    check('the outside-tap listener is bound on the document for touch + mouse',
      /addEventListener\(searchOutsideEvent, searchOutsideHandler, true\)/.test(appJs) && /'PointerEvent' in window\) \? 'pointerdown' : 'mousedown'/.test(appJs));
    check('the mobile search sheet rules are untouched',
      /@media \(max-width: 640px\)[\s\S]*?\.search-panel \{/.test(styles) || /\.search-panel \{[^}]*left: 12px/.test(styles));

    sf4.dom.window.close();

    console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
    child.kill();
    process.exit(fail ? 1 : 0);
  } catch (error) {
    console.error('TEST ERROR:', error);
    console.error('server log:\n', serverLog);
    child.kill();
    process.exit(1);
  }
})();
