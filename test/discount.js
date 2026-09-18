'use strict';
// ===========================================================================
// Checkout discount codes
// ---------------------------------------------------------------------------
// Drives the whole flow the way a customer does:
//
//   enter code -> POST /api/validate-discount -> checked against the codes in
//   Admin -> Discounts -> saving applied -> order total updated
//
// Three layers, all against the real code (no re-implementation of the rules):
//
//   1. lib/discounts.js      the pure rules, unit-tested with plain objects.
//   2. HTTP                  the REAL express server on a scratch datastore,
//                            seeded with codes in every state (active,
//                            inactive, expired, exhausted, under-minimum).
//   3. public/js/app.js      the real storefront in jsdom, with window.fetch
//                            forwarded to that same server, so the numbers the
//                            customer sees come from the real endpoint.
//
// Nothing here touches the committed dataset: the server runs on a copy in a
// temp directory (the pattern every other suite in this repo uses).
//
// Usage: npm run test:discount
// ===========================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const PORT = 3491;
const API = `http://127.0.0.1:${PORT}`;
const DEV_TOKEN = 'discount-test-token-' + Date.now().toString(36);

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
      const r = await fetch(API + '/api/data');
      if (r.ok) return { up: true, log };
    } catch (e) { /* not up yet */ }
    if (child.exitCode !== null) return { up: false, log: log + `\nserver exited: ${child.exitCode}` };
    await wait(150);
  }
  return { up: false, log };
}

// ---------------------------------------------------------------------------
// The codes, exactly as Admin -> Discounts stores them.
// ---------------------------------------------------------------------------
const PAST = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

function codeFixtures() {
  return [
    { id: 'disc_save20', code: 'SAVE20', type: 'percentage', value: 20, min_order: 0, max_uses: null, used_count: 0, expires_at: null, active: true },
    { id: 'disc_flat', code: 'FLAT100', type: 'fixed', value: 100, min_order: 0, max_uses: null, used_count: 0, expires_at: null, active: true },
    { id: 'disc_min', code: 'BIGSPEND', type: 'percentage', value: 10, min_order: 999999, max_uses: null, used_count: 0, expires_at: null, active: true },
    { id: 'disc_expired', code: 'EXPIRED', type: 'percentage', value: 10, min_order: 0, max_uses: null, used_count: 0, expires_at: PAST, active: true },
    { id: 'disc_inactive', code: 'PAUSED', type: 'percentage', value: 10, min_order: 0, max_uses: null, used_count: 0, expires_at: null, active: false },
    { id: 'disc_maxed', code: 'MAXED', type: 'percentage', value: 10, min_order: 0, max_uses: 2, used_count: 2, expires_at: null, active: true },
    { id: 'disc_onemore', code: 'ONEMORE', type: 'fixed', value: 50, min_order: 0, max_uses: 3, used_count: 0, expires_at: FUTURE, active: true },
    // Deliberately lower case: the customer must be able to type "mixedcase".
    { id: 'disc_mixed', code: 'mixedcase', type: 'percentage', value: 5, min_order: 0, max_uses: null, used_count: 0, expires_at: null, active: true },
  ];
}

// ===========================================================================
// 1. the rules (lib/discounts.js)
// ===========================================================================
function unitTests() {
  console.log('\n== 1. Discount rules (lib/discounts.js) ==');
  const d = require('../lib/discounts');
  const rows = codeFixtures();

  check('normalizeCode trims, upper-cases and strips spaces',
    d.normalizeCode('  save 20 ') === 'SAVE20', d.normalizeCode('  save 20 '));
  check('an empty code is rejected', d.evaluateDiscountCode(rows, '   ', { subtotal: 1000 }).reason === 'invalid');
  check('an unknown code is rejected as not_found',
    d.evaluateDiscountCode(rows, 'NOPE', { subtotal: 1000 }).reason === 'not_found');

  const pct = d.evaluateDiscountCode(rows, 'SAVE20', { subtotal: 1000 });
  check('20% off 1000 is 200', pct.ok && pct.discount === 200, JSON.stringify(pct));

  const flat = d.evaluateDiscountCode(rows, 'FLAT100', { subtotal: 1000 });
  check('a fixed code takes the amount off', flat.ok && flat.discount === 100, JSON.stringify(flat));

  check('lookup is case-insensitive',
    d.evaluateDiscountCode(rows, 'save20', { subtotal: 1000 }).ok === true);
  check('a lower-case stored code still matches',
    d.evaluateDiscountCode(rows, 'MIXEDCASE', { subtotal: 1000 }).ok === true);

  check('an inactive code is rejected',
    d.evaluateDiscountCode(rows, 'PAUSED', { subtotal: 1000 }).reason === 'inactive');
  check('an expired code is rejected',
    d.evaluateDiscountCode(rows, 'EXPIRED', { subtotal: 1000 }).reason === 'expired');
  check('an exhausted code is rejected',
    d.evaluateDiscountCode(rows, 'MAXED', { subtotal: 1000 }).reason === 'exhausted');
  check('a code under its minimum order is rejected',
    d.evaluateDiscountCode(rows, 'BIGSPEND', { subtotal: 100 }).reason === 'min_order');
  check('the same code passes once the minimum is met',
    d.evaluateDiscountCode(rows, 'BIGSPEND', { subtotal: 1000000 }).ok === true);
  check('a code with uses left is accepted',
    d.evaluateDiscountCode(rows, 'ONEMORE', { subtotal: 1000 }).ok === true);

  // Stacking: the code can never eat more than the merchandise left after the
  // existing bundle saving, so the total can never fall below the delivery fee.
  const stacked = d.evaluateDiscountCode(rows, 'SAVE20', { subtotal: 1000, bundleDiscount: 950 });
  check('a percentage code is capped by the merchandise left after the bundle',
    stacked.ok && stacked.discount === 50, JSON.stringify(stacked));

  check('a code is valid before its expiry passes',
    d.evaluateDiscountCode(rows, 'ONEMORE', { subtotal: 1000, now: new Date('2020-01-01T00:00:00Z') }).ok === true);
  check('the same code is expired once that date has passed',
    d.evaluateDiscountCode(rows, 'ONEMORE', { subtotal: 1000, now: new Date('2030-01-01T00:00:00Z') }).ok === false);
}

// ===========================================================================
// 2. the real server
// ===========================================================================
async function serverTests(cart) {
  console.log('\n== 2. POST /api/validate-discount (real server) ==');

  const withCode = (await http('POST', '/api/validate-discount', { code: 'SAVE20', cart })).json;
  check('a valid code is accepted', withCode && withCode.ok === true, JSON.stringify(withCode));
  check('the discount is returned', withCode && withCode.discount > 0, withCode && withCode.discount);
  check('the code echoes back normalized', withCode && withCode.code === 'SAVE20', withCode && withCode.code);
  check('the type and value come from the admin record',
    withCode && withCode.type === 'percentage' && withCode.value === 20, JSON.stringify(withCode));

  const expected = Math.round(withCode.subtotal * 0.2);
  check('20% is computed from the server-priced cart',
    withCode.discount === expected, `${withCode.discount} vs ${expected}`);

  const lower = (await http('POST', '/api/validate-discount', { code: ' save20 ', cart })).json;
  check('lower case + padding behaves exactly the same',
    lower.ok === true && lower.discount === withCode.discount, JSON.stringify(lower));

  const unknown = (await http('POST', '/api/validate-discount', { code: 'NOPE', cart })).json;
  check('an unknown code reports not_found', unknown.ok === false && unknown.reason === 'not_found', JSON.stringify(unknown));

  for (const [code, reason] of [['PAUSED', 'inactive'], ['EXPIRED', 'expired'], ['MAXED', 'exhausted'], ['BIGSPEND', 'min_order']]) {
    const r = (await http('POST', '/api/validate-discount', { code, cart })).json;
    check(`${code} is refused as ${reason}`, r.ok === false && r.reason === reason, JSON.stringify(r));
  }

  const blank = await http('POST', '/api/validate-discount', { code: '', cart });
  check('a blank code is a 400 with reason invalid',
    blank.status === 400 && blank.json.reason === 'invalid', `${blank.status} ${JSON.stringify(blank.json)}`);

  const tooLong = await http('POST', '/api/validate-discount', { code: 'X'.repeat(500), cart });
  check('an absurdly long code is refused', tooLong.status === 400, tooLong.status);

  // Codes must never reach the browser through the public payload.
  const pub = (await http('GET', '/api/data')).json;
  const leaked = JSON.stringify(pub).includes('SAVE20');
  check('discount codes are NOT exposed by /api/data', !leaked);
  check('the storefront payload is otherwise intact', Array.isArray(pub.products) && pub.products.length > 0);
}

async function orderTests(cart) {
  console.log('\n== 3. The discount reaches the order total ==');

  const customer = {
    fullName: 'Discount Tester', phone: '+201000000001',
    city: 'Cairo', area: 'Nasr City', address: '1 Test Street', notes: '',
  };

  // What the checkout quotes, and what the order must honour.
  const quote = (await http('POST', '/api/validate-discount', { code: 'SAVE20', cart })).json;
  check('the checkout got a quote for SAVE20', quote && quote.ok === true, JSON.stringify(quote));

  const plain = await http('POST', '/api/orders', { customer, cart, payment: 'Cash on Delivery' });
  check('an order without a code is accepted', plain.ok && plain.json && plain.json.ok === true, JSON.stringify(plain.json).slice(0, 200));
  const baseTotal = plain.json.total;
  check('no discount is reported without a code',
    plain.json.discount === 0 && plain.json.discountCode === null, JSON.stringify(plain.json));

  const discounted = await http('POST', '/api/orders', { customer, cart, payment: 'Cash on Delivery', discountCode: 'SAVE20' });
  check('an order with a valid code is accepted',
    discounted.ok && discounted.json && discounted.json.ok === true, JSON.stringify(discounted.json).slice(0, 200));

  check('the amount charged matches the amount the checkout quoted',
    discounted.json.discount === quote.discount, `${discounted.json.discount} vs ${quote.discount}`);
  check('the discount is 20% of the merchandise subtotal',
    discounted.json.discount === Math.round(quote.subtotal * 0.2),
    `${discounted.json.discount} vs ${Math.round(quote.subtotal * 0.2)}`);
  check('the charged total is exactly the discount lower',
    discounted.json.total === baseTotal - discounted.json.discount,
    `${discounted.json.total} = ${baseTotal} - ${discounted.json.discount}`);
  check('the applied code is echoed back', discounted.json.discountCode === 'SAVE20', discounted.json.discountCode);

  const lower = await http('POST', '/api/orders', { customer, cart, payment: 'Cash on Delivery', discountCode: 'save20' });
  check('a lower-case code charges the same amount',
    lower.json.ok === true && lower.json.total === discounted.json.total,
    `${lower.json.total} vs ${discounted.json.total}`);

  // The server must not honour a code that no longer qualifies.
  const rejected = await http('POST', '/api/orders', { customer, cart, payment: 'Cash on Delivery', discountCode: 'EXPIRED' });
  check('an expired code cannot buy anything', rejected.status === 400, `${rejected.status} ${JSON.stringify(rejected.json)}`);
  check('the refusal names the reason so the storefront can explain it',
    rejected.json && rejected.json.reason === 'expired', JSON.stringify(rejected.json));

  const fake = await http('POST', '/api/orders', { customer, cart, payment: 'Cash on Delivery', discountCode: 'FREE100' });
  check('an invented code is refused', fake.status === 400 && fake.json.reason === 'not_found', JSON.stringify(fake.json));

  return { baseTotal, discountedTotal: discounted.json.total, discount: discounted.json.discount };
}

async function usageTests(cart) {
  console.log('\n== 4. Redemptions are counted (Admin -> Discounts) ==');
  const counts = async () => {
    const r = (await http('GET', '/api/admin/data', null, { admin: true })).json;
    const out = {};
    for (const c of (r.discount_codes || [])) out[c.code] = Number(c.used_count || 0);
    return out;
  };

  const before = await counts();
  check('admin payload lists the discount codes', Object.keys(before).length > 0, JSON.stringify(before));
  check('ONEMORE started at 0 uses', before.ONEMORE === 0, before.ONEMORE);

  const customer = {
    fullName: 'Counter Tester', phone: '+201000000002',
    city: 'Cairo', area: '', address: '2 Test Street', notes: '',
  };
  const r = await http('POST', '/api/orders', { customer, cart, payment: 'Cash on Delivery', discountCode: 'ONEMORE' });
  check('an order using ONEMORE is accepted', r.ok && r.json && r.json.ok === true, JSON.stringify(r.json).slice(0, 200));

  const after = await counts();
  check('used_count went up by exactly one for that code',
    after.ONEMORE === before.ONEMORE + 1, `${before.ONEMORE} -> ${after.ONEMORE}`);
  const drifted = Object.keys(after).filter((c) => c !== 'ONEMORE' && after[c] !== before[c]);
  check('no other code was touched', drifted.length === 0,
    drifted.map((c) => `${c}: ${before[c]} -> ${after[c]}`).join(', '));

  // A refused order must not burn a redemption.
  const refused = await http('POST', '/api/orders', { customer, cart, payment: 'Cash on Delivery', discountCode: 'EXPIRED' });
  const afterRefused = await counts();
  check('a refused code does not consume a use',
    refused.status === 400 && afterRefused.ONEMORE === after.ONEMORE,
    `${refused.status} / ${afterRefused.ONEMORE}`);
}

// ===========================================================================
// 3. the storefront
// ===========================================================================
async function storefrontTests(payload, cart, expected) {
  console.log('\n== 5. Checkout UI: enter code -> total updates ==');

  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => {
    if (!/Could not load|Not implemented/.test(e.message)) console.log('  ! page error:', e.message);
  });

  const dom = new JSDOM(html, {
    virtualConsole,
    url: API + '/#/checkout',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.alert = () => {};
      window.confirm = () => true;
      window.scrollTo = () => {};
      // The cart the customer already has in their browser.
      window.localStorage.setItem('velocci_cart', JSON.stringify(cart));
      // Every request goes to the REAL server started above — nothing about
      // the discount rules is re-implemented inside this test.
      window.fetch = (u, o = {}) => {
        const url = typeof u === 'string' ? u : u.url;
        const target = /^https?:/.test(url) ? url : API + url;
        return fetch(target, { method: o.method || 'GET', headers: o.headers, body: o.body })
          .then(async (r) => {
            const text = await r.text();
            return {
              ok: r.ok, status: r.status, url: target,
              json: async () => JSON.parse(text),
              text: async () => text,
            };
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
  const money = (s) => Number(String(s || '').replace(/[^\d.]/g, ''));

  check('the checkout page rendered', !!$('#checkout-form'), document.body.innerHTML.slice(0, 120));
  check('the discount code field is present', !!$('#discount-code-input'));
  check('an Apply button is present', !!$('#discount-apply'));

  const totalRow = () => {
    const rows = Array.from(document.querySelectorAll('#checkout-totals .summary .row.total'));
    return rows.length ? rows[rows.length - 1] : null;
  };
  const beforeTotal = money(totalRow() && totalRow().textContent);
  check('the total is shown before any code is applied', beforeTotal > 0, beforeTotal);

  // --- enter a code and apply it -----------------------------------------
  $('#discount-code-input').value = 'save20';       // deliberately lower case
  $('#discount-apply').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(600);

  check('the applied code is shown', !!$('#discount-remove'));
  const appliedText = document.querySelector('#checkout-totals .discount-code-tag');
  check('the code is displayed normalized', appliedText && appliedText.textContent.trim() === 'SAVE20',
    appliedText && appliedText.textContent);

  const afterTotal = money(totalRow() && totalRow().textContent);
  check('the total went DOWN by the discount',
    afterTotal === beforeTotal - expected.discount, `${beforeTotal} -> ${afterTotal} (expected -${expected.discount})`);

  const rowsText = Array.from(document.querySelectorAll('#checkout-totals .summary .row')).map((r) => r.textContent);
  check('a discount row explains the new total',
    rowsText.some((t) => /Discount code/i.test(t) && /SAVE20/.test(t)), rowsText.join(' | '));

  // --- the form the customer already typed must survive -------------------
  const nameInput = document.querySelector('#checkout-form [name=fullName]');
  if (nameInput) nameInput.value = 'Someone Typing';
  $('#discount-remove').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(400);
  check('removing the code restores the original total',
    money(totalRow() && totalRow().textContent) === beforeTotal,
    `${money(totalRow() && totalRow().textContent)} vs ${beforeTotal}`);
  check('the typed name is still there after applying/removing a code',
    document.querySelector('#checkout-form [name=fullName]').value === 'Someone Typing',
    document.querySelector('#checkout-form [name=fullName]').value);

  // --- a bad code is explained, not silently swallowed --------------------
  $('#discount-code-input').value = 'NOTAREALCODE';
  $('#discount-apply').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(600);
  const msg = $('#discount-msg');
  check('a rejected code shows a message', !!msg && !msg.hidden && msg.textContent.trim().length > 0,
    msg && msg.textContent);
  check('a rejected code is marked as an error', msg && /bad/.test(msg.className), msg && msg.className);
  check('a rejected code does not change the total',
    money(totalRow() && totalRow().textContent) === beforeTotal,
    money(totalRow() && totalRow().textContent));

  dom.window.close();
}

// ===========================================================================
(async function main() {
  unitTests();

  // Scratch datastore so the committed dataset is never mutated by this test.
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vilocci-discount-'));
  const scratchDb = path.join(scratchDir, 'velocci-db.json');
  const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'velocci-db.json'), 'utf8'));
  source.discount_codes = codeFixtures();
  fs.writeFileSync(scratchDb, JSON.stringify(source, null, 2));

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      VELOCCI_DB: scratchDb,
      DATA_DRIVER: 'json',
      ADMIN_DEV_TOKEN: DEV_TOKEN,
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_ANON_KEY: '',
      SUPABASE_DB_URL: '', DATABASE_URL: '', POSTGRES_URL: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const { up, log } = await waitForServer(child);
    if (!up) { console.error('server did not start\n', log); process.exit(1); }

    const payload = (await http('GET', '/api/data')).json;

    // A simple one-line cart. Two units so percentages are unambiguous.
    const product = payload.products.find((p) => p.id === 'p_mercedes-benz_holder')
      || payload.products[0];
    const cartItem = { productId: product.id, qty: 2, keyShape: '' };
    if (Array.isArray(product.colors) && product.colors.length) cartItem.colorId = product.colors[0].id;
    const cart = [cartItem];

    await serverTests(cart);
    const expected = await orderTests(cart);
    await usageTests(cart);
    await storefrontTests(payload, cart, expected);
  } finally {
    child.kill('SIGTERM');
    await wait(200);
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
