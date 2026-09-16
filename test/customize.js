'use strict';
// ============================================================================
// Customize feature test (jsdom)
// ----------------------------------------------------------------------------
// Drives the REAL public/js/app.js (customer flow) and the REAL
// public/js/admin-app.js (Admin → Customize Settings / Requests) and asserts:
//
//   storefront   5-step wizard, ONLY admin-enabled categories, required photo
//                with preview + replace, validation, submit payload,
//                duplicate-submission guard, professional success message
//   admin        ON/OFF per category + save, request list, private photo via a
//                signed link, status change, internal notes, delete + confirm
//
// Nothing is read from a hard-coded category list: the public payload is built
// with lib/db.js's own publicPayload() and the admin fixture with
// lib/mapping.js, i.e. the exact shapes the server produces.
//
// Usage: npm run test:customize
// ============================================================================

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const mapping = require('../lib/mapping');

const PUBLIC = path.join(__dirname, '..', 'public');
const DB_FILE = path.join(__dirname, '..', 'data', 'velocci-db.json');

const TEST_URL = 'https://testproject.supabase.co';
const TEST_KEY = 'fake-anon-key-0123456789-abcdefghijklmnopqrstuvwxyz';
const SIGNED_URL = 'https://testproject.supabase.co/storage/v1/object/sign/customize-uploads/2026-09-16/CUS-1.jpg?token=abc123';

let pass = 0; let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓', name); }
  else { fail += 1; console.log('  ✗', name, extra !== undefined ? `→ ${extra}` : ''); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
function buildPublicPayload() {
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const products = db.products.map((p) => mapping.rowToProduct(mapping.productToRow(p)));
  const catalog = {
    settings: db.settings,
    languages: db.languages,
    promoBar: mapping.rowToPromoBar(mapping.promoBarToRow(db.promoBar)),
    heroSlides: db.heroSlides.map((s) => mapping.rowToHeroSlide(mapping.heroSlideToRow(s))),
    homeSections: db.homeSections.map((s) => mapping.rowToHomeSection(mapping.homeSectionToRow(s))),
    brands: db.brands.map((b) => mapping.rowToBrand(mapping.brandToRow(b))),
    bundles: db.bundles.map((b) => mapping.rowToBundle(mapping.bundleToRow(b))),
    products,
    categories: mapping.deriveCategories(db).map(mapping.rowToCategory),
  };
  // The server-side shape of /api/data is produced by lib/db.js itself.
  const payload = require('../lib/db').publicPayload(catalog);
  // Admin enabled only TWO of the three categories for Customize.
  payload.customize = {
    available: true,
    categories: payload.customize.categories.filter((c) => c.id !== 'keyholder'),
  };
  return payload;
}

function customizeFixture(config) {
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const categories = mapping.deriveCategories(db).map(mapping.rowToCategory);
  const requests = [
    mapping.customizeRequestSummary(mapping.rowToCustomizeRequest(mapping.customizeRequestToRow({
      id: 'CUS-AAA111',
      createdAt: '2026-09-16T10:00:00.000Z',
      categoryId: 'keycase', categorySlug: 'keycases', categoryNameEn: 'Key Cases',
      carBrand: 'Mercedes-Benz', carModel: 'C-Class', modelYear: '2022',
      carDetails: 'AMG line',
      customizationRequest: 'Carbon key case with the AMG badge and gold stitching.',
      customerName: 'Ahmed Test', phone: '+201234567890', whatsapp: '+201234567890',
      email: 'ahmed@example.com', preferredContact: 'WhatsApp', additionalNotes: 'Call after 5pm',
      carImagePath: '2026-09-16/CUS-AAA111.jpg', carImageMime: 'image/jpeg', carImageSize: 120000,
      status: 'New', adminNotes: '',
    }))),
    mapping.customizeRequestSummary(mapping.rowToCustomizeRequest(mapping.customizeRequestToRow({
      id: 'CUS-BBB222',
      createdAt: '2026-09-15T09:30:00.000Z',
      categoryId: 'medal', categorySlug: 'medals', categoryNameEn: 'Car Medals',
      carBrand: 'BMW', carModel: 'X5', modelYear: '2023',
      customizationRequest: 'Gold plated medal with my initials engraved.',
      customerName: 'Sara Test', phone: '01001112222', preferredContact: 'Phone',
      carImagePath: '2026-09-15/CUS-BBB222.png', carImageMime: 'image/png', carImageSize: 98000,
      status: 'Contacted', adminNotes: 'Called her.',
    }))),
  ];
  return {
    products: db.products.map((p) => mapping.rowToProduct(mapping.productToRow(p))),
    categories,
    brands: db.brands.map((b) => mapping.rowToBrand(mapping.brandToRow(b))),
    bundles: db.bundles.map((b) => mapping.rowToBundle(mapping.bundleToRow(b))),
    heroSlides: [],
    homeSections: [],
    orders: [],
    preorders: [],
    messages: [],
    discount_codes: [],
    website_images: [],
    websiteContent: [],
    settings: db.settings,
    promoBar: {},
    requests,
    customize: config,
  };
}

function adminConfig({ keycase = true, keyholder = false, medal = true } = {}) {
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const list = mapping.deriveCategories(db).map(mapping.rowToCategory).map((c) => ({
    id: c.id, slug: c.slug, name_en: c.name_en, name_ar: c.name_ar, image: c.image,
    product_count: c.product_count, order: c.order, active: c.active !== false,
    enabled: { keycase, keyholder, medal }[c.id] !== false,
  }));
  return {
    categories: { keycase, keyholder, medal },
    list,
    stats: { total: 2, new: 1 },
    updatedAt: null,
    configured: true,
    storage: { configured: false, bucket: 'customize-uploads', private: true, mode: 'inline-fallback' },
  };
}

function stubSupabase() {
  return {
    createClient() {
      return {
        auth: {
          getSession: async () => ({ data: { session: { user: { id: 'admin-1', email: 'admin@test.com' }, access_token: 'test-jwt' } } }),
          signInWithPassword: async () => ({ data: {}, error: null }),
          signOut: async () => ({ error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        },
        from() {
          return {
            select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'admin-1' }, error: null }) }) }),
          };
        },
      };
    },
  };
}

// ===========================================================================
// 1. customer flow
// ===========================================================================
async function storefront() {
  console.log('\n== CUSTOMIZE: public wizard ==');
  const payload = buildPublicPayload();
  const calls = [];
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  let submitResponder = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, requestId: 'CUS-NEW123' }) });

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => {
    if (!/Could not load|Not implemented/.test(e.message)) console.log('  ! page error:', e.message);
  });

  const dom = new JSDOM(html, {
    virtualConsole,
    url: 'http://localhost:3000/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.alert = () => {};
      window.scrollTo = () => {};
      // jsdom ships no image decoder: emulate the browser's decode step so the
      // upload path runs (canvas is unavailable there, which the app handles by
      // keeping the original data URL — the server validates it again).
      window.Image = class {
        constructor() { this.width = 1200; this.height = 800; }
        set src(value) { this._src = value; setTimeout(() => { if (this.onload) this.onload(); }, 0); }
        get src() { return this._src; }
      };
      window.fetch = (u, o = {}) => {
        const url = typeof u === 'string' ? u : u.url;
        if (url.indexOf('/api/data') >= 0) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
        }
        if (url.indexOf('/api/customize/requests') >= 0) {
          calls.push({ url, method: o.method || 'GET', body: o.body ? JSON.parse(o.body) : null });
          return submitResponder();
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
      };
    },
  });

  const { window } = dom;
  const { document } = window;
  window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'engine.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8'));
  await wait(160);

  const text = (sel) => { const e = document.querySelector(sel); return e ? e.textContent.trim() : ''; };
  const click = (el) => { if (el) el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); };
  const setHash = (h) => { window.location.hash = h; window.dispatchEvent(new window.HashChangeEvent('hashchange')); };
  const setValue = (sel, value) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`missing ${sel}`);
    el.value = value;
  };

  check('header shows the Customize entry when categories are enabled',
    Array.from(document.querySelectorAll('.nav a')).some((a) => a.getAttribute('href') === '#/customize'));

  setHash('#/customize');
  await wait(80);

  check('five-step wizard renders', document.querySelectorAll('.cz-step').length === 5,
    document.querySelectorAll('.cz-step').length);
  const catLabels = Array.from(document.querySelectorAll('.cz-cat .cz-cat-name')).map((e) => e.textContent.trim());
  check('only admin-enabled categories are offered (2 of 3)', catLabels.length === 2, JSON.stringify(catLabels));
  check('the disabled category is NOT offered', !catLabels.includes('Key Holders'), JSON.stringify(catLabels));
  check('car photo step is required (no preview yet)', !document.querySelector('.cz-preview'));

  // --- Arabic (checked before submitting: a submitted request replaces the
  //     wizard with the success screen)
  click(document.querySelector('[data-lang="ar"]'));
  await wait(120);
  check('the wizard is translated and RTL in Arabic',
    document.documentElement.dir === 'rtl' && /ماذا تريد أن نخصص/.test(text('#cz-block-4')),
    `${document.documentElement.dir} | ${text('#cz-block-4').slice(0, 40)}`);
  click(document.querySelector('[data-lang="en"]'));
  await wait(120);
  check('switching back restores the English wizard',
    document.documentElement.dir === 'ltr' && document.querySelectorAll('.cz-cat').length === 2);

  // --- validation: submitting an empty form must not reach the server
  // (#cz-form is re-created on every route() render, so it is always re-queried)
  const formNow = () => document.querySelector('#cz-form');
  formNow().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(60);
  check('empty submit shows field errors', document.querySelectorAll('.cz-err').length >= 4,
    document.querySelectorAll('.cz-err').length);
  check('empty submit does not call the API', calls.length === 0, JSON.stringify(calls));

  // --- step 1: category
  click(document.querySelector('[data-cz-cat="keycase"]'));
  await wait(30);
  check('selected category is highlighted', document.querySelector('[data-cz-cat="keycase"]').classList.contains('selected'));
  check('stepper marks step 1 done', document.querySelectorAll('.cz-step')[0].classList.contains('done'));

  // --- step 2: photo upload (+ preview + replace)
  const file = new window.File([new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4])], 'car.jpg', { type: 'image/jpeg' });
  const input = document.querySelector('#cz-file');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(300);
  check('uploaded photo renders a preview', !!document.querySelector('.cz-preview'));
  check('preview offers replace + remove', !!document.querySelector('[data-cz-action="replace"]') && !!document.querySelector('[data-cz-action="remove"]'));
  check('stepper marks the photo step done', document.querySelectorAll('.cz-step')[1].classList.contains('done'));

  // a non-image file is rejected before anything is sent
  const badFile = new window.File([new Uint8Array([1, 2, 3])], 'notes.txt', { type: 'text/plain' });
  Object.defineProperty(input, 'files', { value: [badFile], configurable: true });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(80);
  check('non-image upload is rejected with a clear message', /JPG, PNG or WebP/.test(text('#cz-photo')), text('#cz-photo').slice(0, 80));
  check('the valid photo is kept after the rejected one', !!document.querySelector('.cz-preview'));

  // --- steps 3-5
  setValue('#cz-brand', 'Mercedes-Benz');
  setValue('#cz-model', 'C-Class');
  setValue('#cz-year', '2022');
  setValue('#cz-details', 'AMG line, black leather');
  setValue('#cz-request', 'Please customize a carbon key case with the AMG badge.');
  setValue('#cz-name', 'Ahmed Test');
  setValue('#cz-phone', '+20 123 456 7890');
  setValue('#cz-whatsapp', '+20 123 456 7890');
  setValue('#cz-email', 'ahmed@example.com');
  click(document.querySelector('.cz-contact input[value="WhatsApp"]'));
  await wait(20);

  // --- duplicate-submission guard: a slow request disables the button and a
  //     second submit while it is in flight is ignored
  let release;
  submitResponder = () => new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, requestId: 'CUS-NEW123' }) }); });
  formNow().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(80);
  check('submit button shows a loading state', document.querySelector('#cz-submit').disabled === true && /Submitting/.test(text('#cz-submit')));
  formNow().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(40);
  check('double submission is prevented (one API call)', calls.length === 1, JSON.stringify(calls.map((c) => c.url)));

  const body = calls[0].body;
  check('submit sends the chosen category + car + request + customer', !!body
    && body.category === 'keycase'
    && body.carBrand === 'Mercedes-Benz'
    && body.carModel === 'C-Class'
    && body.modelYear === '2022'
    && /carbon key case/.test(body.customizationRequest)
    && body.fullName === 'Ahmed Test'
    && body.preferredContact === 'WhatsApp', JSON.stringify(body && { category: body.category, brand: body.carBrand }));
  check('submit carries the uploaded car photo as a data URL', /^data:image\//.test(body.carImage || ''));
  check('submit carries a duplicate-guard client key', /^cz_/.test(body.clientKey || ''), body.clientKey);

  release();
  await wait(120);
  check('professional success message is shown',
    /Your customization request has been received\. Our team will contact you shortly\./.test(text('.cz-success')),
    text('.cz-success').slice(0, 120));
  check('success screen shows the request id', /CUS-NEW123/.test(text('.cz-success-card')), text('.cz-success-card'));

  dom.window.close();
}

// ===========================================================================
// 2. the three served copies of the front-end must stay byte-identical
// ===========================================================================
function copiesInSync() {
  console.log('\n== CUSTOMIZE: served copies in sync ==');
  const files = ['js/app.js', 'js/admin-app.js', 'js/engine.js', 'js/admin.js', 'js/supabase-client.js',
    'css/styles.css', 'css/admin.css', 'index.html', 'admin.html'];
  const ROOT = path.join(__dirname, '..');
  files.forEach((f) => {
    const a = fs.readFileSync(path.join(ROOT, f));
    const b = fs.readFileSync(path.join(ROOT, 'public', f));
    const c = fs.readFileSync(path.join(ROOT, 'dist', f));
    check(`${f} · root == public == dist`, a.equals(b) && a.equals(c));
  });
}

// ===========================================================================
// 3. admin screens
// ===========================================================================
async function admin() {
  console.log('\n== CUSTOMIZE: admin settings + requests ==');
  const config = adminConfig();
  const fixture = customizeFixture(config);
  const calls = [];
  const html = fs.readFileSync(path.join(PUBLIC, 'admin.html'), 'utf8');
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => {
    if (!/Could not load|Not implemented/.test(e.message)) console.log('  ! page error:', e.message);
  });

  const dom = new JSDOM(html, {
    virtualConsole,
    url: 'http://localhost:3000/admin',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.supabase = stubSupabase();
      window.__SPINTO_SUPABASE_URL = '%VITE_SUPABASE_URL%';
      window.__SPINTO_SUPABASE_ANON_KEY = '%VITE_SUPABASE_ANON_KEY%';
      window.scrollTo = () => {};
      const realSetInterval = window.setInterval.bind(window);
      window.setInterval = (fn, ms) => realSetInterval(() => {}, 2147483000);
      window.fetch = (u, o = {}) => {
        const url = typeof u === 'string' ? u : u.url;
        const body = o.body ? JSON.parse(o.body) : null;
        calls.push({ url, method: o.method || 'GET', body });
        if (url.includes('/api/admin/config')) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ url: TEST_URL, anonKey: TEST_KEY }) });
        }
        if (url.includes('/api/admin/data')) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(fixture) });
        }
        if (url.includes('/api/admin/customize/settings')) {
          fixture.customize = Object.assign({}, fixture.customize, {
            categories: body.categories,
            list: fixture.customize.list.map((c) => Object.assign({}, c, { enabled: body.categories[c.id] !== false })),
            updatedAt: '2026-09-16T12:00:00.000Z',
          });
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, customize: fixture.customize }) });
        }
        if (/\/api\/admin\/customize\/requests\/[^/]+\/photo/.test(url)) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ url: SIGNED_URL, kind: 'signed', expiresIn: 300, mime: 'image/jpeg' }) });
        }
        if (/\/api\/admin\/customize\/requests\/[^/]+\/delete/.test(url)) {
          const id = decodeURIComponent(url.match(/requests\/([^/]+)\/delete/)[1]);
          fixture.requests = fixture.requests.filter((r) => r.id !== id);
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
        }
        if (/\/api\/admin\/customize\/requests\/[^/]+$/.test(url) && (o.method || 'GET') === 'POST') {
          const id = decodeURIComponent(url.match(/requests\/([^/]+)$/)[1]);
          const row = fixture.requests.find((r) => r.id === id);
          if (row) Object.assign(row, body);
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, request: row }) });
        }
        if (/\/api\/admin\/customize\/requests\/[^/]+$/.test(url)) {
          const id = decodeURIComponent(url.match(/requests\/([^/]+)$/)[1]);
          const row = fixture.requests.find((r) => r.id === id);
          return Promise.resolve({ ok: !!row, status: row ? 200 : 404, json: () => Promise.resolve(row || { error: 'not found' }) });
        }
        if (url.includes('/api/admin/customize/requests')) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ requests: fixture.requests }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
      };
      window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'admin-app.js'), 'utf8'));
    },
  });

  await wait(400);
  const doc = dom.window.document;
  const click = (sel) => {
    const el = doc.querySelector(sel);
    if (!el) throw new Error(`no element for ${sel}`);
    el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }));
    return el;
  };
  const nav = async (view) => { click(`[data-nav="${view}"]`); await wait(200); };

  check('the sidebar has a Customize group with both screens',
    !!doc.querySelector('[data-nav="customize-settings"]') && !!doc.querySelector('[data-nav="customize-requests"]'));
  check('sidebar badge counts the new requests', /1/.test(doc.querySelector('[data-nav="customize-requests"]').textContent));

  // ---------------------------------------------------------------- settings
  await nav('customize-settings');
  check('Customize Settings lists every existing category', doc.querySelectorAll('[data-cz-enable]').length === 6,
    doc.querySelectorAll('[data-cz-enable]').length);
  const onOff = {};
  ['keycase', 'keyholder', 'medal'].forEach((id) => {
    const row = doc.querySelector(`[data-cz-row="${id}"]`);
    onOff[id] = { on: row.querySelector('[data-cz-value="1"]').classList.contains('on'), off: row.querySelector('[data-cz-value="0"]').classList.contains('off') };
  });
  check('saved ON/OFF state is rendered per category',
    onOff.keycase.on && onOff.keyholder.off && onOff.medal.on, JSON.stringify(onOff));

  click('[data-cz-row="medal"] [data-cz-value="0"]');
  await wait(30);
  check('toggling OFF updates the row instantly',
    doc.querySelector('[data-cz-row="medal"] [data-cz-value="0"]').classList.contains('off'));
  click('[data-cz-row="keyholder"] [data-cz-value="1"]');
  await wait(30);
  check('toggling ON updates the row instantly',
    doc.querySelector('[data-cz-row="keyholder"] [data-cz-value="1"]').classList.contains('on'));

  click('#btn-save-customize');
  await wait(200);
  const saveCall = calls.filter((c) => c.url.includes('/api/admin/customize/settings')).pop();
  check('saving posts the complete availability map', !!saveCall
    && saveCall.body.categories.keycase === true
    && saveCall.body.categories.keyholder === true
    && saveCall.body.categories.medal === false, JSON.stringify(saveCall && saveCall.body));
  check('the saved state survives a re-render',
    doc.querySelector('[data-cz-row="medal"] [data-cz-value="0"]').classList.contains('off'));

  // ---------------------------------------------------------------- requests
  await nav('customize-requests');
  check('requests are fetched from the admin API', calls.some((c) => c.url.includes('/api/admin/customize/requests')));
  check('the list renders both requests', doc.querySelectorAll('[data-cz-view]').length === 2,
    doc.querySelectorAll('[data-cz-view]').length);
  const table = doc.querySelector('.data-table tbody').textContent;
  check('each row shows id, date, category, car and customer',
    /CUS-AAA111/.test(table) && /Mercedes-Benz/.test(table) && /Ahmed Test/.test(table) && /Key Cases/.test(table),
    table.replace(/\s+/g, ' ').slice(0, 160));
  check('status is shown per request', /New/.test(table) && /Contacted/.test(table));
  check('filter chips cover every status', doc.querySelectorAll('[data-cz-filter]').length === 6,
    doc.querySelectorAll('[data-cz-filter]').length);

  await wait(200);
  const thumb = doc.querySelector('[data-cz-thumb="CUS-AAA111"] img');
  check('the private car photo is loaded through the signed-URL endpoint',
    !!thumb && thumb.getAttribute('src') === SIGNED_URL,
    thumb ? thumb.getAttribute('src') : 'no img');
  check('the photo endpoint is admin-only (called through /api/admin/…)',
    calls.some((c) => c.url.includes('/api/admin/customize/requests/CUS-AAA111/photo')));

  // status change straight from the list
  const select = doc.querySelector('[data-cz-status="CUS-AAA111"]');
  select.value = 'In Progress';
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await wait(200);
  const statusCall = calls.filter((c) => c.method === 'POST' && /requests\/CUS-AAA111$/.test(c.url)).pop();
  check('changing the status persists it', !!statusCall && statusCall.body.status === 'In Progress',
    JSON.stringify(statusCall && statusCall.body));

  // detail modal: everything + internal notes
  click('[data-cz-view="CUS-AAA111"]');
  await wait(200);
  const modal = doc.querySelector('.cz-detail-modal');
  check('request detail opens', !!modal && /CUS-AAA111/.test(modal.textContent));
  const modalText = modal.textContent.replace(/\s+/g, ' ');
  check('detail shows the customer contact details',
    /Ahmed Test/.test(modalText) && /\+201234567890/.test(modalText) && /ahmed@example\.com/.test(modalText) && /WhatsApp/.test(modalText),
    modalText.slice(0, 200));
  check('detail shows the car + the customization request',
    /Mercedes-Benz · C-Class · 2022/.test(modalText) && /AMG badge/.test(modalText));
  doc.querySelector('#cz-detail-notes').value = 'Contacted the customer on WhatsApp.';
  doc.querySelector('#cz-detail-status').value = 'Completed';
  click('#cz-detail-save');
  await wait(220);
  const detailSave = calls.filter((c) => c.method === 'POST' && /requests\/CUS-AAA111$/.test(c.url)).pop();
  check('internal notes + status are saved together', !!detailSave
    && detailSave.body.admin_notes === 'Contacted the customer on WhatsApp.'
    && detailSave.body.status === 'Completed', JSON.stringify(detailSave && detailSave.body));

  // delete with confirmation
  click('[data-cz-delete="CUS-BBB222"]');
  await wait(80);
  check('deleting asks for confirmation first', !!doc.querySelector('#confirm-ok'));
  click('#confirm-ok');
  await wait(220);
  check('confirmed deletion calls the delete endpoint',
    calls.some((c) => /requests\/CUS-BBB222\/delete/.test(c.url)));
  check('the deleted request disappears from the list',
    !doc.querySelector('[data-cz-delete="CUS-BBB222"]') && doc.querySelectorAll('[data-cz-view]').length === 1,
    doc.querySelectorAll('[data-cz-view]').length);

  dom.window.close();
}

(async function main() {
  try {
    copiesInSync();
    await storefront();
    await admin();
  } catch (e) {
    console.error('customize test crashed:', e);
    process.exit(1);
  }
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
