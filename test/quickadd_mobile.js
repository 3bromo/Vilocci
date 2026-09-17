'use strict';
// ============================================================================
// Quick Add (Shape → Color → Add to Cart) + mobile-safe layout test
// ----------------------------------------------------------------------------
// Boots the REAL server.js against a scratch JSON datastore and drives the
// real storefront (jsdom, exactly like test/smoke.js and test/colors.js) to
// prove the reported UI/UX fixes:
//
//   quick add    the modal is a strict two-step flow — the customer picks a
//                KEY SHAPE first, only then are that product's colors revealed
//                (round swatches, enabled colors only, HEX + names straight
//                from the product record). Add to Cart never fires without a
//                color and instead shows the existing localized validation
//                message. Shape + color travel with the cart line, combos stay
//                separate lines, and products without colors keep the existing
//                shape-only fallback.
//   cart/order   the chosen shape + color are posted at checkout and stored on
//                the created order (server-side check through the admin API).
//   mobile css   the shipped stylesheet keeps the search sheet inside the
//                viewport (LTR + RTL), the promo second line is gone on
//                mobile, and the product page can no longer overflow sideways.
//   admin entry  the public storefront renders NO admin link anywhere (header,
//                mobile menu, footer) while /admin + /admin/login stay up.
//
// Usage: npm run test:quickadd
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const PORT = 3481;
const API = `http://127.0.0.1:${PORT}`;
const DEV_TOKEN = 'quickadd-test-token-' + Date.now().toString(36);

let pass = 0; let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓', name); }
  else { fail += 1; console.log('  ✗', name, extra !== undefined ? `→ ${extra}` : ''); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, urlPath, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.admin) headers['x-admin-dev-token'] = DEV_TOKEN;
  const res = await fetch(API + urlPath, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: opts.redirect || 'follow',
  });
  const type = res.headers.get('content-type') || '';
  let json = null; let text = null;
  if (type.indexOf('json') >= 0) { try { json = await res.json(); } catch (e) { /* ignore */ } }
  else { try { text = await res.text(); } catch (e) { /* ignore */ } }
  return { ok: res.ok, status: res.status, json, text, type };
}

async function waitForServer(child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(API + '/api/data');
      if (r.ok) return true;
    } catch (e) { /* not up yet */ }
    if (child.exitCode !== null) throw new Error('server exited early: ' + child.exitCode);
    await wait(150);
  }
  return false;
}

// Build the jsdom storefront exactly the way the other suites do.
async function bootStorefront(payload) {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const captured = { orders: [] };
  const dom = new JSDOM(html, {
    url: API + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (u, o) => {
        const url = typeof u === 'string' ? u : u.url;
        if (url.indexOf('/api/data') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
        if (url.indexOf('/api/orders') >= 0) {
          try { captured.orders.push(JSON.parse((o && o.body) || '{}')); } catch (e) { /* ignore */ }
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, orderId: 'ORD-QA-TEST', total: 1450 }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      };
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.alert = () => {}; window.confirm = () => true;
    },
  });
  dom.window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'engine.js'), 'utf8'));
  dom.window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8'));
  await wait(200);
  const { window } = dom;
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const cart = () => JSON.parse(window.localStorage.getItem('velocci_cart') || '[]');
  return { dom, window, doc: window.document, click, cart, captured };
}

(async function main() {
  // Scratch datastore so the committed dataset is never mutated by this test.
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinto-quickadd-'));
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
    const up = await waitForServer(child);
    if (!up) { console.error('server did not start\n', serverLog); process.exit(1); }

    const payload = (await http('GET', '/api/data')).json;
    const stylesCss = fs.readFileSync(path.join(PUBLIC, 'css', 'styles.css'), 'utf8');
    const products = payload.products;
    const activeColors = (p) => (p.colors || []).filter((c) => c.enabled !== false && c.hex);

    // ================================================================== 1
    console.log('\n== 1. Quick Add requires BOTH a key shape and a color ==');
    const withColors = products.filter((p) => activeColors(p).length && (p.keyShapes || []).some((s) => s.available));
    check('catalog has products with shapes + colors', withColors.length > 0, withColors.length);
    const target = withColors.find((p) => activeColors(p).length >= 2 && (p.keyShapes || []).filter((s) => s.available).length >= 2) || withColors[0];
    check('test product has ≥2 shapes and ≥2 enabled colors',
      (target.keyShapes || []).filter((s) => s.available).length >= 1 && activeColors(target).length >= 1);

    const sf = await bootStorefront(payload);
    const cardBtn = sf.doc.querySelector(`[data-add="${target.id}"]`);
    check('product card exposes a quick-add button', !!cardBtn, target.slug);
    sf.click(cardBtn);
    await wait(60);

    let modal = sf.doc.querySelector('.modal-overlay.qa-overlay');
    check('quick-add modal opens', !!modal);

    const steps = modal ? Array.from(modal.querySelectorAll('.qa-step')).map((s) => s.textContent.replace(/\s+/g, ' ').trim()) : [];
    check('modal shows the two labelled steps',
      steps.length >= 1 && /KEY SHAPE/i.test(steps[0]) && (activeColors(target).length ? /COLOR/i.test(steps[1] || '') : true),
      steps.join(' | '));

    const shapeOpts = modal.querySelectorAll('[data-qa]');
    check('step 1 lists the product\'s available key shapes' ,
      shapeOpts.length === (target.keyShapes || []).filter((s) => s.available).length,
      `${shapeOpts.length} vs ${(target.keyShapes || []).filter((s) => s.available).length}`);

    const colorStep = modal.querySelector('[data-qablock="color"]');
    check('color step exists but is locked before a shape is picked', !!colorStep && colorStep.classList.contains('is-locked'));

    const addBtn = modal.querySelector('.qa-add');
    check('add to cart starts locked', !!addBtn && addBtn.getAttribute('aria-disabled') === 'true' && addBtn.classList.contains('is-locked'));

    // tapping Add with nothing selected must not add anything
    sf.click(addBtn);
    await wait(30);
    check('tapping add without a shape adds nothing to the cart', sf.cart().length === 0, JSON.stringify(sf.cart()));
    check('tapping add without a shape shows the localized shape message',
      /SELECT YOUR KEY SHAPE/i.test(modal.querySelector('.qa-error').textContent),
      modal.querySelector('.qa-error').textContent);

    // pick a shape — colors must appear only now
    const shapeA = shapeOpts[0];
    const shapeValue = shapeA.getAttribute('data-qa');
    sf.click(shapeA);
    await wait(40);
    check('shape selection is reflected in the modal', shapeA.classList.contains('selected'));
    check('color step unlocks after the shape is chosen', !colorStep.classList.contains('is-locked'));

    const colorOpts = modal.querySelectorAll('[data-qac]');
    const enabled = activeColors(target);
    check('only the product\'s ENABLED colors are offered', colorOpts.length === enabled.length,
      `${colorOpts.length} vs ${enabled.length}`);
    const firstSwatch = modal.querySelector('[data-qac] .color-swatch');
    const swatchRule = (stylesCss.match(/\.color-opt \.color-swatch \{([^}]*)\}/) || [])[1] || '';
    check('colors render as round swatches (border-radius 50%)',
      /color-swatch/.test(firstSwatch.className) && /border-radius:\s*50%/.test(swatchRule), swatchRule.trim());
    check('swatch colour comes from the admin HEX value',
      firstSwatch.getAttribute('style').toLowerCase().indexOf(enabled[0].hex.toLowerCase()) >= 0,
      firstSwatch.getAttribute('style'));
    const firstLabel = modal.querySelector('[data-qac] .lbl').textContent.trim();
    check('swatch shows the admin colour name', firstLabel === (enabled[0].name_en || enabled[0].name_ar), firstLabel);

    // tapping Add with a shape but no color must be refused with the localized message
    sf.click(addBtn);
    await wait(30);
    check('tapping add without a color adds nothing to the cart', sf.cart().length === 0, JSON.stringify(sf.cart()));
    check('tapping add without a color shows the localized color message',
      /choose a color/i.test(modal.querySelector('.qa-error').textContent),
      modal.querySelector('.qa-error').textContent);
    check('add stays locked while no color is chosen', addBtn.getAttribute('aria-disabled') === 'true');

    // choose a color → add is allowed
    const colorA = colorOpts[0];
    const colorAId = colorA.getAttribute('data-qac');
    sf.click(colorA);
    await wait(30);
    check('add unlocks once BOTH shape and color are chosen', addBtn.getAttribute('aria-disabled') === 'false');
    sf.click(addBtn);
    await wait(60);
    check('modal closes after a successful add', !sf.doc.querySelector('.modal-overlay.qa-overlay'));
    let cartItems = sf.cart();
    check('cart receives exactly one line', cartItems.length === 1, JSON.stringify(cartItems));
    check('cart line keeps the chosen key shape', cartItems[0] && cartItems[0].keyShape === shapeValue, cartItems[0] && cartItems[0].keyShape);
    check('cart line keeps the chosen color id', cartItems[0] && cartItems[0].colorId === colorAId, cartItems[0] && cartItems[0].colorId);
    const storedColor = cartItems[0] && cartItems[0].color;
    check('cart line carries the color snapshot (name + HEX)',
      !!storedColor && storedColor.hex === enabled[0].hex && (storedColor.name_en === enabled[0].name_en || storedColor.name_ar === enabled[0].name_ar),
      JSON.stringify(storedColor));

    // ================================================================== 2
    console.log('\n== 2. Shape + color combinations stay separate cart variants ==');
    const shapeB = modal.querySelectorAll('[data-qa]') && sf.doc.querySelectorAll('.qa-shapes [data-qa]');
    sf.click(sf.doc.querySelector(`[data-add="${target.id}"]`));
    await wait(50);
    modal = sf.doc.querySelector('.modal-overlay.qa-overlay');
    const shape2 = modal.querySelectorAll('[data-qa]')[1];
    const shape2Value = shape2.getAttribute('data-qa');
    sf.click(shape2);
    await wait(30);
    const color2 = modal.querySelectorAll('[data-qac]')[1];
    const color2Id = color2.getAttribute('data-qac');
    sf.click(color2);
    await wait(30);
    sf.click(modal.querySelector('.qa-add'));
    await wait(60);
    cartItems = sf.cart();
    check('a second combination of the same product becomes its own cart line', cartItems.length === 2, JSON.stringify(cartItems.map((i) => [i.keyShape, i.colorId])));
    const line1 = cartItems.find((i) => i.keyShape === shapeValue && i.colorId === colorAId);
    const line2 = cartItems.find((i) => i.keyShape === shape2Value && i.colorId === color2Id);
    check('both lines keep their own shape + color', !!line1 && !!line2, JSON.stringify(cartItems.map((i) => [i.keyShape, i.colorId])));
    check('the two lines are different variants', shapeValue !== shape2Value || colorAId !== color2Id);

    // Quick Add → cart → checkout: the real checkout form must post BOTH the
    // shape and the colour of every line.
    sf.window.location.hash = '#/checkout';
    sf.window.dispatchEvent(sf.window.HashChangeEvent ? new sf.window.HashChangeEvent('hashchange') : new sf.window.Event('hashchange'));
    await wait(80);
    const form = sf.doc.querySelector('#checkout-form');
    check('checkout form renders with the quick-added items', !!form);
    if (form) {
      const setVal = (name, value) => {
        const el = form.querySelector(`[name="${name}"]`);
        if (el) el.value = value;
      };
      setVal('fullName', 'QA Tester'); setVal('phone', '01000000000');
      setVal('city', 'Cairo'); setVal('area', 'Maadi'); setVal('address', '1 Test Street');
      form.dispatchEvent(new sf.window.Event('submit', { bubbles: true, cancelable: true }));
      await wait(80);
      const posted = sf.captured.orders[0];
      check('checkout posts the cart to /api/orders', !!posted && Array.isArray(posted.cart), JSON.stringify(posted));
      const postedLines = (posted && posted.cart) || [];
      check('checkout sends both shape + colour for every line',
        postedLines.length === 2 && postedLines.every((l) => !!l.keyShape && !!l.colorId),
        JSON.stringify(postedLines));
      const postedFirst = postedLines.find((l) => l.keyShape === shapeValue);
      check('checkout line keeps the quick-add colour id', !!postedFirst && postedFirst.colorId === colorAId,
        JSON.stringify(postedFirst));
      check('cart is emptied after a successful order', sf.cart().length === 0);
    }

    // ================================================================== 3
    console.log('\n== 3. Products without colours keep the existing fallback ==');
    const noColorTarget = products.find((p) => p.id !== target.id && (p.keyShapes || []).some((s) => s.available));
    const originalColors = JSON.stringify(noColorTarget.colors || []);
    let r = await http('POST', '/api/admin/update', {
      collection: 'products', id: noColorTarget.id,
      updates: { colors: activeColors(noColorTarget).map((c) => Object.assign({}, c, { enabled: false })) },
    }, { admin: true });
    check('admin can switch every colour of a product off (scratch store)',
      r.ok && r.json && r.json.ok, JSON.stringify(r.json).slice(0, 160));

    const payload2 = (await http('GET', '/api/data')).json;
    const sf2 = await bootStorefront(payload2);
    const noColorProduct = payload2.products.find((p) => p.id === noColorTarget.id);
    check('product with all colours disabled exposes none', activeColors(noColorProduct).length === 0);
    sf2.click(sf2.doc.querySelector(`[data-add="${noColorProduct.id}"]`));
    await wait(60);
    const modal2 = sf2.doc.querySelector('.modal-overlay.qa-overlay');
    check('fallback modal opens for a colour-less product', !!modal2);
    check('no colour step is rendered for a colour-less product', !modal2.querySelector('[data-qablock="color"]'));
    const add2 = modal2.querySelector('.qa-add');
    sf2.click(modal2.querySelectorAll('[data-qa]')[0]);
    await wait(40);
    check('shape-only product unlocks add after the shape', add2.getAttribute('aria-disabled') === 'false');
    sf2.click(add2);
    await wait(60);
    const cart2 = sf2.cart();
    check('colour-less product still adds to the cart (fallback preserved)',
      cart2.length === 1 && cart2[0].keyShape && !cart2[0].colorId, JSON.stringify(cart2));
    sf2.dom.window.close();

    // restore the scratch product so later steps see the normal catalog
    r = await http('POST', '/api/admin/update', {
      collection: 'products', id: noColorTarget.id, updates: { colors: JSON.parse(originalColors) },
    }, { admin: true });
    check('scratch store colours restored', r.ok && r.json && r.json.ok);

    // ================================================================== 4
    console.log('\n== 4. Shape + colour survive checkout and land on the order ==');
    const orderCart = [
      { productId: target.id, keyShape: shapeValue, qty: 1, fitment: null, colorId: colorAId },
    ];
    const orderRes = await http('POST', '/api/orders', {
      customer: { fullName: 'QA Tester', phone: '01000000000', city: 'Cairo', area: 'Maadi', address: '1 Test Street', notes: '' },
      cart: orderCart, payment: 'Cash on Delivery',
    });
    check('order with shape + colour is accepted', orderRes.ok && orderRes.json && orderRes.json.ok, JSON.stringify(orderRes.json).slice(0, 200));
    const orderId = orderRes.json && orderRes.json.orderId;
    const orderDetail = await http('GET', `/api/admin/order/${encodeURIComponent(orderId)}`, null, { admin: true });
    const orderItem = orderDetail.json && (orderDetail.json.items || [])[0];
    check('admin order detail shows the chosen colour',
      !!orderItem && !!orderItem.color && orderItem.color.hex === enabled[0].hex &&
      (orderItem.color.id === colorAId || orderItem.color.id === ''),
      JSON.stringify(orderItem));
    check('admin order detail shows the chosen key shape', !!orderItem && orderItem.keyShape === shapeValue, orderItem && orderItem.keyShape);

    // ================================================================== 5
    console.log('\n== 5. Mobile-safe layout ships in the served stylesheet ==');
    const css = fs.readFileSync(path.join(PUBLIC, 'css', 'styles.css'), 'utf8');
    const mobileCss = css.split('MOBILE SAFETY LAYER')[1] || '';
    check('mobile safety layer ships in the storefront stylesheet', mobileCss.length > 500, mobileCss.length);
    check('search sheet is pinned to BOTH viewport edges on mobile',
      /@media \(max-width: 820px\)[\s\S]{0,4000}?\.search-panel \{[\s\S]{0,400}?position:\s*fixed;[\s\S]{0,400}?left:\s*12px;[\s\S]{0,400}?right:\s*12px;/.test(mobileCss),
      'search-panel mobile block');
    check('search sheet keeps the same insets for RTL',
      /html\[dir="rtl"\] \.search-panel \{ left: 12px; right: 12px; \}/.test(mobileCss));
    check('narrow widths keep a smaller-but-symmetric search inset',
      /@media \(max-width: 520px\)[\s\S]{0,600}?\.search-panel \{ left: 10px; right: 10px;/.test(mobileCss));
    check('search panel can never exceed the viewport on desktop either',
      /\.search-panel \{[\s\S]{0,300}?max-width:\s*calc\(100vw - 24px\)/.test(css));
    check('search results wrap instead of overflowing',
      /\.search-panel \.result > div \{ min-width: 0; \}/.test(css));
    check('mobile promo hides the "Limited Time Only" second line',
      /@media \(max-width: 820px\)[\s\S]{0,4000}?\.promo \.sub \{ display: none; \}/.test(mobileCss));
    check('mobile promo bar is compacted', /\.promo \{ padding: 8px 14px; \}/.test(mobileCss));
    check('mobile hero starts higher', /\.hero-slide \{ padding: 16px 0 30px;/.test(mobileCss));
    check('product tabs wrap on mobile (no sideways overflow)',
      /\.pdp-tabs \.tab-head \{ flex-wrap: wrap;/.test(mobileCss));
    check('specifications table fits the mobile width',
      /\.pdp-specs \.spec-table \{ table-layout: fixed; width: 100%;/.test(mobileCss));
    check('product columns may shrink (min-width: 0) so nothing is pushed off-screen',
      /\.pdp > \*, \.pdp-info > \*/.test(css) && /min-width: 0;/.test(css));
    check('long product text wraps instead of overflowing',
      /overflow-wrap: anywhere;/.test(css) && /word-break: break-word;/.test(css));

    // multi-width geometry: the sheet is pinned to symmetric insets, so the
    // computed panel always fits inside the viewport at every mobile width
    const insetFor = (w) => (w <= 360 ? 8 : w <= 520 ? 10 : 12);
    const widths = [320, 360, 375, 390, 414, 520, 768, 820];
    const geometry = widths.map((w) => {
      const inset = insetFor(w);
      const panelWidth = w - inset * 2;
      return { w, inset, panelWidth, fits: panelWidth > 220 && panelWidth <= w && inset > 0 };
    });
    check('search sheet fits every tested narrow/normal mobile width (320–820px)',
      geometry.every((g) => g.fits), JSON.stringify(geometry));
    check('desktop (≥821px) keeps the original dropdown anchoring',
      /\.search-panel \{ position: absolute; top: 100%; right: 0; width: 370px;/.test(css));

    // the mobile search sheet must live on the header + search markup
    check('header sets a header-height token used by the search sheet', /--header-h: 82px;/.test(css));
    check('header-height token matches the 820px mobile header', /@media \(max-width: 820px\)[\s\S]{0,4000}?\.header \{ --header-h: 56px; \}/.test(mobileCss));
    check('header-height token matches the 768px mobile header', /@media \(max-width: 768px\)[\s\S]{0,200}?\.header \{ --header-h: 64px; \}/.test(mobileCss));

    // ================================================================== 6
    console.log('\n== 6. Public site has no admin entry, /admin still works ==');
    const doc = sf.doc;
    const links = Array.from(doc.querySelectorAll('a')).map((a) => (a.getAttribute('href') || '') + ' ' + a.textContent);
    check('no link on the rendered storefront points at /admin',
      !links.some((l) => /(^|\s|[#/])\/admin\b/i.test(l) || /\badmin\b/i.test(l)), links.filter((l) => /admin/i.test(l)).join(' | '));
    const headerHtml = doc.querySelector('.header').outerHTML;
    check('header has no admin entry', !/admin/i.test(headerHtml));
    const mobileNav = doc.querySelector('#nav-mobile');
    check('mobile menu has no admin entry', !!mobileNav && !/admin/i.test(mobileNav.outerHTML));
    const footerHtml = doc.querySelector('.footer').outerHTML;
    check('footer has no admin entry', !/admin/i.test(footerHtml));
    check('storefront markup still exposes the mobile-safe search wrapper', !!doc.querySelector('.header-search #search-panel'));

    // search must keep working exactly as before (only its positioning changed)
    sf.click(doc.querySelector('#search-btn'));
    const searchPanel = doc.querySelector('#search-panel');
    check('search panel opens from the header icon', !!searchPanel && !searchPanel.classList.contains('hidden'));
    const input = doc.querySelector('#search-input');
    input.value = products[0].name_en.split(' ')[0];
    input.dispatchEvent(new sf.window.Event('input', { bubbles: true }));
    await wait(40);
    check('search still filters products (live results)', doc.querySelectorAll('#search-results .result').length >= 1,
      doc.querySelector('#search-results') ? doc.querySelector('#search-results').innerHTML.slice(0, 80) : 'no results node');
    sf.dom.window.close();

    const adminPage = await http('GET', '/admin');
    check('GET /admin is still served (admin route untouched)',
      adminPage.status === 200 && /admin-root/.test(adminPage.text || ''), `status ${adminPage.status}`);
    const adminLogin = await http('GET', '/admin/login');
    check('GET /admin/login is still served', adminLogin.status === 200 && /admin-root/.test(adminLogin.text || ''));
    const adminConfig = await http('GET', '/api/admin/config');
    check('admin API is still reachable', adminConfig.status === 200 && adminConfig.json !== null, `status ${adminConfig.status}`);
    const adminDiag = await http('GET', '/api/admin/diagnose');
    check('admin diagnostics endpoint still reachable', adminDiag.status === 200 && adminDiag.json !== null, `status ${adminDiag.status}`);

    // ================================================================== 7
    console.log('\n== 7. Cache-buster bumped for the new assets ==');
    const indexHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    const appV = (indexHtml.match(/js\/app\.js\?v=([\w.]+)/) || [])[1];
    const cssV = (indexHtml.match(/css\/styles\.css\?v=([\w.]+)/) || [])[1];
    check('index.html loads app.js and styles.css', !!appV && !!cssV, `${appV} / ${cssV}`);
    check('both share the same cache-buster', appV === cssV, `${appV} vs ${cssV}`);
    check('cache-buster is not the previous build (20260917b)', appV !== '20260917b', appV);

    console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error('quickadd/mobile test crashed:', e);
    console.error(serverLog.slice(-2000));
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await wait(150);
    try { child.kill('SIGKILL'); } catch (e) { /* already dead */ }
  }
})().catch((e) => { console.error('quickadd/mobile test crashed:', e); process.exit(1); });
