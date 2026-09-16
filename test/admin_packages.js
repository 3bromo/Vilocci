'use strict';
// ============================================================================
// Admin Packages (bundles) editor test (jsdom)
// ----------------------------------------------------------------------------
// Regression cover for the dead ✏️ button on Admin → Packages.
//
// renderPackages() always emitted `data-edit-package="<id>"`, but bindPackages()
// only bound #btn-add-package and [data-delete-package] — there was no
// [data-edit-package] listener and no editor function, so clicking Edit did
// nothing at all. This drives the REAL public/js/admin-app.js in jsdom and
// asserts the whole path: open → prefill → save → re-render → survive refresh.
//
// The fixture is built with lib/mapping.js (the module the server uses to turn
// Supabase rows into the admin payload), and the "refresh" step replays the
// server's own merge semantics (db.patchRecord → bundleToRow → rowToBundle) so
// persistence is checked against the shape production actually stores.
//
// Usage: npm run test:packages
// ============================================================================

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const mapping = require('../lib/mapping');

const PUBLIC = path.join(__dirname, '..', 'public');
const DB_FILE = path.join(__dirname, '..', 'data', 'velocci-db.json');

const TEST_URL = 'https://testproject.supabase.co';
const TEST_KEY = 'fake-anon-key-0123456789-abcdefghijklmnopqrstuvwxyz';

let pass = 0; let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓', name); }
  else { fail += 1; console.log('  ✗', name, extra !== undefined ? `→ ${extra}` : ''); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// fixture — same shape as GET /api/admin/data
// ---------------------------------------------------------------------------
function bundleFixture() {
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  return db.bundles.map((b) => mapping.rowToBundle(mapping.bundleToRow(b)));
}

function buildFixture(bundles) {
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  return {
    products: db.products.map((p) => mapping.rowToProduct(mapping.productToRow(p))),
    categories: [],
    brands: db.brands.map((b) => mapping.rowToBrand(mapping.brandToRow(b))),
    bundles: bundles || bundleFixture(),
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

async function bootAdmin(fixture) {
  const html = fs.readFileSync(path.join(PUBLIC, 'admin.html'), 'utf8');
  const calls = [];
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
      // Never let the order-polling interval run during the assertions.
      const realSetInterval = window.setInterval.bind(window);
      window.setInterval = () => realSetInterval(() => {}, 2147483000);
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
        if (url.includes('/api/admin/orders')) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ orders: [] }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
      };
      window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'admin-app.js'), 'utf8'));
    },
  });
  await wait(400);
  return { dom, calls };
}

const click = (doc, sel) => {
  const el = doc.querySelector(sel);
  if (!el) throw new Error(`no element for ${sel}`);
  el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }));
  return el;
};
const nav = async (doc, view) => { click(doc, `[data-nav="${view}"]`); await wait(120); };
const updatesFor = (calls, id) => calls
  .filter((c) => c.url.includes('/api/admin/update') && c.body?.collection === 'bundles' && c.body?.id === id)
  .pop();

(async function main() {
  const bundles = bundleFixture();
  const target = bundles[0];
  if (!target) { console.error('no bundles in fixture'); process.exit(1); }
  const fixture = buildFixture(bundles);

  const { dom, calls } = await bootAdmin(fixture);
  const doc = dom.window.document;

  console.log('\n== ADMIN PACKAGES: table ==');
  check('dashboard rendered', !!doc.querySelector('.sidebar'));
  await nav(doc, 'packages');

  const rows = doc.querySelectorAll('.data-table tbody tr');
  check('packages table renders one row per bundle', rows.length === bundles.length, `got ${rows.length} of ${bundles.length}`);
  const editBtns = doc.querySelectorAll('[data-edit-package]');
  check('every row has an ✏️ edit button', editBtns.length === bundles.length, `got ${editBtns.length}`);
  check(`edit button carries the bundle id (${target.id})`,
    editBtns[0]?.getAttribute('data-edit-package') === target.id, editBtns[0]?.getAttribute('data-edit-package'));

  console.log('\n== ADMIN PACKAGES: Edit ✏️ opens the modal ==');
  // The whole point of the fix: this click used to be a no-op.
  click(doc, `[data-edit-package="${target.id}"]`);
  await wait(80);

  const overlay = doc.querySelector('.modal-overlay.open');
  const form = doc.querySelector('#package-form');
  check('clicking ✏️ opens a modal overlay', !!overlay);
  check('modal contains the package form', !!form);
  check('modal is titled "Edit Package/Bundle"',
    /Edit Package\/Bundle/.test(overlay?.textContent || ''), overlay?.querySelector('h3')?.textContent);

  console.log('\n== ADMIN PACKAGES: form is prefilled with current values ==');
  const brandSel = form?.querySelector('[name=brandSlug]');
  const priceInp = form?.querySelector('[name=bundlePrice]');
  const totalInp = form?.querySelector('[name=normalTotal]');
  const titleEnInp = form?.querySelector('[name=title_en]');
  const activeBox = form?.querySelector('[name=active]');

  check('brand select preselects the stored brandSlug',
    brandSel?.value === target.brandSlug, `${brandSel?.value} vs ${target.brandSlug}`);
  check('bundle price prefilled', Number(priceInp?.value) === Number(target.bundlePrice),
    `${priceInp?.value} vs ${target.bundlePrice}`);
  check('regular total prefilled', Number(totalInp?.value) === Number(target.normalTotal),
    `${totalInp?.value} vs ${target.normalTotal}`);
  check('package name (EN) prefilled', titleEnInp?.value === (target.title_en || ''),
    `${titleEnInp?.value} vs ${target.title_en}`);
  check('active toggle reflects stored state', activeBox?.checked === (target.active !== false));
  check('save button reads "Update Package" in edit mode',
    /Update Package/.test(doc.querySelector('#btn-save-package')?.textContent || ''));
  check('savings hint computed from the prefilled prices',
    /saves|no savings/i.test(doc.querySelector('#pkg-savings-hint')?.textContent || ''),
    doc.querySelector('#pkg-savings-hint')?.textContent);

  console.log('\n== ADMIN PACKAGES: saving posts a PARTIAL update ==');
  const NEW_TITLE = 'Complete Your Mercedes-Benz Set (EDITED)';
  const NEW_PRICE = 2299;
  const NEW_TOTAL = 2999;
  titleEnInp.value = NEW_TITLE;
  form.querySelector('[name=title_ar]').value = 'طقم مرسيدس (معدّل)';
  priceInp.value = String(NEW_PRICE);
  totalInp.value = String(NEW_TOTAL);
  priceInp.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await wait(30);
  check('savings hint recalculates on input',
    /EGP 700/.test(doc.querySelector('#pkg-savings-hint')?.textContent || ''),
    doc.querySelector('#pkg-savings-hint')?.textContent);

  click(doc, '#btn-save-package');
  await wait(120);

  const patch = updatesFor(calls, target.id);
  check('save POSTs /api/admin/update for collection "bundles"', !!patch, JSON.stringify(calls.map((c) => c.url)));
  check('patch carries the edited title', patch?.body?.updates?.title_en === NEW_TITLE, patch?.body?.updates?.title_en);
  check('patch carries the edited bundle price', patch?.body?.updates?.bundlePrice === NEW_PRICE, patch?.body?.updates?.bundlePrice);
  check('patch carries the edited regular total', patch?.body?.updates?.normalTotal === NEW_TOTAL, patch?.body?.updates?.normalTotal);
  check('patch keeps the bundle id', patch?.body?.id === target.id);

  // A full-record upsert built from this form would send nulls for every field
  // the form does not expose and wipe them server-side (bundleToRow emits
  // key_case_id / sub_en / start_date … from the record it is given). The edit
  // must therefore be a patch, and must not carry those keys at all.
  const sentKeys = Object.keys(patch?.body?.updates || {});
  const untouched = ['keyCaseProductId', 'keyHolderProductId', 'medalProductId', 'sub_en', 'sub_ar', 'startDate', 'endDate', 'discountMode'];
  check('patch omits fields the form does not edit (so they are preserved)',
    untouched.every((k) => !sentKeys.includes(k)), sentKeys.join(','));
  check('edit did NOT fall back to a full-record /api/admin/save',
    !calls.some((c) => c.url.includes('/api/admin/save') && c.body?.collection === 'bundles'));

  console.log('\n== ADMIN PACKAGES: table reflects the edit ==');
  check('modal closed after save', !doc.querySelector('.modal-overlay.open'));
  const firstRow = doc.querySelector('.data-table tbody tr');
  check('edited name is rendered in the table',
    firstRow?.textContent.includes(NEW_TITLE), firstRow?.textContent.slice(0, 120));
  check('edited bundle price is rendered in the table',
    firstRow?.textContent.includes('2,299'), firstRow?.textContent.slice(0, 120));
  check('savings column recalculated from the new prices',
    firstRow?.textContent.includes('700'), firstRow?.textContent.slice(0, 160));

  console.log('\n== ADMIN PACKAGES: edit survives a refresh ==');
  // Replay exactly what the server does: patchRecord merges the patch into the
  // current row, saveRecord maps it through bundleToRow, and the next read maps
  // it back through rowToBundle. Feeding that result into a fresh boot is the
  // same payload the admin panel receives after F5.
  const merged = mapping.rowToBundle(mapping.bundleToRow(Object.assign({}, target, patch.body.updates)));
  const refreshedBundles = bundles.map((b) => (b.id === target.id ? merged : b));
  const before = doc.querySelector('.data-table tbody tr')?.textContent || '';

  const second = await bootAdmin(buildFixture(refreshedBundles));
  const doc2 = second.dom.window.document;
  await nav(doc2, 'packages');
  const afterRow = doc2.querySelector('.data-table tbody tr');
  check('after refresh the edited name persists',
    afterRow?.textContent.includes(NEW_TITLE), afterRow?.textContent.slice(0, 120));
  check('after refresh the edited price persists',
    afterRow?.textContent.includes('2,299'), afterRow?.textContent.slice(0, 120));
  check('refreshed table matches the pre-refresh table',
    (afterRow?.textContent || '').replace(/\s+/g, ' ') === before.replace(/\s+/g, ' '));

  // Re-opening the editor after refresh must show the saved values, not the old.
  click(doc2, `[data-edit-package="${target.id}"]`);
  await wait(80);
  const form2 = doc2.querySelector('#package-form');
  check('re-opening the editor after refresh shows the saved values',
    form2?.querySelector('[name=title_en]').value === NEW_TITLE
    && Number(form2?.querySelector('[name=bundlePrice]').value) === NEW_PRICE);

  console.log('\n== ADMIN PACKAGES: untouched fields survive the round-trip ==');
  check('brandSlug preserved', merged.brandSlug === target.brandSlug, merged.brandSlug);
  check('keyCaseProductId preserved (would be nulled by a full upsert)',
    merged.keyCaseProductId === target.keyCaseProductId, `${merged.keyCaseProductId} vs ${target.keyCaseProductId}`);
  check('sub_en copy preserved', merged.sub_en === target.sub_en);
  check('startDate preserved', merged.startDate === target.startDate, `${merged.startDate} vs ${target.startDate}`);

  console.log('\n== ADMIN PACKAGES: "+ Add Package" still works (regression) ==');
  const calls2 = second.calls;
  // Snapshot the DOM row count BEFORE adding: buildFixture hands the app the
  // very same array instance, so the app's own push() mutates it. Comparing
  // against refreshedBundles.length afterwards would chase a moving target.
  const rowsBeforeAdd = doc2.querySelectorAll('.data-table tbody tr').length;
  check('refreshed table shows every bundle', rowsBeforeAdd === bundles.length, `got ${rowsBeforeAdd}`);
  click(doc2, '#btn-add-package');
  await wait(80);
  const addForm = doc2.querySelector('#package-form');
  check('Add opens the same editor in create mode', !!addForm);
  check('Add modal is titled "Add Package/Bundle"',
    /Add Package\/Bundle/.test(doc2.querySelector('.modal-overlay.open h3')?.textContent || ''));
  check('Add starts with empty name and price',
    addForm?.querySelector('[name=title_en]').value === '' && addForm?.querySelector('[name=bundlePrice]').value === '');
  check('Add save button reads "Create Package"',
    /Create Package/.test(doc2.querySelector('#btn-save-package')?.textContent || ''));

  addForm.querySelector('[name=brandSlug]').value = 'bmw';
  addForm.querySelector('[name=title_en]').value = 'Throwaway QA Bundle';
  addForm.querySelector('[name=bundlePrice]').value = '1500';
  addForm.querySelector('[name=normalTotal]').value = '1800';
  click(doc2, '#btn-save-package');
  await wait(120);
  const created = calls2.filter((c) => c.url.includes('/api/admin/save') && c.body?.collection === 'bundles').pop();
  check('Add POSTs /api/admin/save for collection "bundles"', !!created, JSON.stringify(calls2.map((c) => c.url)));
  check('Add sends a new generated id', /^bundle_/.test(created?.body?.record?.id || ''), created?.body?.record?.id);
  check('Add sends the entered values',
    created?.body?.record?.brandSlug === 'bmw'
    && created?.body?.record?.bundlePrice === 1500
    && created?.body?.record?.title_en === 'Throwaway QA Bundle');
  check('Add appends a row to the table',
    doc2.querySelectorAll('.data-table tbody tr').length === rowsBeforeAdd + 1,
    `got ${doc2.querySelectorAll('.data-table tbody tr').length}, expected ${rowsBeforeAdd + 1}`);

  console.log('\n== ADMIN PACKAGES: validation + delete still bound (regression) ==');
  click(doc2, '#btn-add-package');
  await wait(60);
  const blankForm = doc2.querySelector('#package-form');
  blankForm.querySelector('[name=brandSlug]').value = '';
  blankForm.querySelector('[name=bundlePrice]').value = '';
  const beforeBlank = calls2.length;
  click(doc2, '#btn-save-package');
  await wait(80);
  check('saving with required fields blank makes no API call', calls2.length === beforeBlank, `${calls2.length} vs ${beforeBlank}`);
  check('blank save shows an error toast', /Fill required fields/.test(doc2.body.textContent));
  check('modal stays open after a rejected save', !!doc2.querySelector('.modal-overlay.open'));
  click(doc2, '.modal-overlay.open .modal-footer .btn-secondary');
  await wait(60);
  check('Cancel closes the modal', !doc2.querySelector('.modal-overlay.open'));
  check('delete buttons are still bound',
    doc2.querySelectorAll('[data-delete-package]').length === rowsBeforeAdd + 1,
    `got ${doc2.querySelectorAll('[data-delete-package]').length}, expected ${rowsBeforeAdd + 1}`);

  dom.window.close();
  second.dom.window.close();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('admin packages test crashed:', e); process.exit(1); });
