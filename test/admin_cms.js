'use strict';
// ============================================================================
// Admin CMS UI test (jsdom)
// ----------------------------------------------------------------------------
// Loads the REAL /js/admin-app.js in jsdom and drives the views that were
// missing: categories CRUD (name / image / description / order), the product
// editor (details, prices, images), the full order list with customer_phone +
// customer_address, the order detail panel with order_items, the website
// content sections, and the automatic order refresh.
//
// The fixture is built with lib/mapping.js — the same module the server uses
// to turn Supabase rows into the admin payload — so the admin panel is tested
// against exactly the shape it receives in production.
//
// Usage: npm run test:admin
// ============================================================================

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const mapping = require('../lib/mapping');

const PUBLIC = path.join(__dirname, '..', 'public');
const DB_FILE = path.join(__dirname, '..', 'data', 'velocci-db.json');

const TEST_URL = 'https://testproject.supabase.co';
const TEST_KEY = 'fake-anon-key-0123456789-abcdefghijklmnopqrstuvwxyz';

let pass = 0; let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓', name); }
  else { fail += 1; console.log('  ✗', name, extra || ''); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// fixture — same shapes as GET /api/admin/data
// ---------------------------------------------------------------------------
function buildFixture() {
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const products = db.products.map((p) => mapping.rowToProduct(mapping.productToRow(p)));
  const dict = db.languages.dict;
  const categories = [
    { key: 'keycase', slug: 'keycases', en: dict.en.key_cases, ar: dict.ar.key_cases, order: 1 },
    { key: 'keyholder', slug: 'keyholders', en: dict.en.key_holders, ar: dict.ar.key_holders, order: 2 },
    { key: 'medal', slug: 'medals', en: dict.en.car_medals, ar: dict.ar.car_medals, order: 3 },
  ].map((c) => {
    const inCat = products.filter((p) => p.category === c.key);
    return mapping.rowToCategory(mapping.categoryToRow({
      id: c.key, slug: c.slug, name_en: c.en, name_ar: c.ar,
      image: (inCat[0].images || [])[0] || null,
      product_count: inCat.length, order: c.order, active: true,
    }));
  });
  const orders = db.orders.slice(0, 5).map((o) => mapping.rowToOrder(
    mapping.orderToRow(o),
    (o.items || []).map((it, i) => mapping.orderItemToRow(it, o.id, i)),
  ));
  const content = mapping.rowsToWebsiteContent(
    Object.keys(dict.en).filter((k) => typeof dict.en[k] !== 'object').map((k) => mapping.websiteContentToRow({
      id: `wc_${k}`, section: 'copy', key: k, value_en: String(dict.en[k]), value_ar: dict.ar[k] ? String(dict.ar[k]) : null,
    })),
  );
  return {
    products,
    categories,
    brands: db.brands.map((b) => mapping.rowToBrand(mapping.brandToRow(b))),
    bundles: db.bundles.map((b) => mapping.rowToBundle(mapping.bundleToRow(b))),
    heroSlides: db.heroSlides.map((s) => mapping.rowToHeroSlide(mapping.heroSlideToRow(s))),
    homeSections: db.homeSections.map((s) => mapping.rowToHomeSection(mapping.homeSectionToRow(s))),
    orders,
    preorders: [],
    messages: [],
    discount_codes: [],
    website_images: [{ id: 'img_1', name: 'Hero', url: '/img/hero.jpg', section: 'hero', alt: 'Hero' }],
    websiteContent: content,
    settings: db.settings,
    promoBar: mapping.rowToPromoBar(mapping.promoBarToRow(db.promoBar)),
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
  const intervals = [];
  // Surface page errors instead of letting jsdom swallow them.
  const { VirtualConsole } = require('jsdom');
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => {
    if (!/Could not load|Not implemented/.test(e.message)) console.log('  ! page error:', e.message, (e.detail && e.detail.stack) ? '\n' + e.detail.stack.split('\n').slice(0, 3).join('\n') : '');
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
      window.setInterval = (fn, ms) => { intervals.push(ms); return realSetInterval(() => {}, 2147483000); };
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
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ orders: fixture.orders }) });
        }
        const orderMatch = url.match(/\/api\/admin\/order\/([^/?]+)/);
        if (orderMatch) {
          const o = fixture.orders.find((x) => x.id === decodeURIComponent(orderMatch[1])) || null;
          return Promise.resolve({ ok: !!o, status: o ? 200 : 404, json: () => Promise.resolve(o || { error: 'not found' }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
      };
      window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'admin-app.js'), 'utf8'));
    },
  });
  await wait(400);
  return { dom, calls, intervals };
}

const click = (doc, sel) => {
  const el = doc.querySelector(sel);
  if (!el) throw new Error(`no element for ${sel}`);
  // cancelable: true — without it jsdom ignores preventDefault() and the
  // sidebar <a href="#view"> changes the hash, which re-triggers auth routing.
  el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }));
  return el;
};
const nav = async (doc, view) => { click(doc, `[data-nav="${view}"]`); await wait(120); };

(async function main() {
  const fixture = buildFixture();
  const { dom, calls, intervals } = await bootAdmin(fixture);
  const doc = dom.window.document;

  console.log('\n== ADMIN CMS: categories ==');
  check('dashboard rendered', !!doc.querySelector('.sidebar'));

  await nav(doc, 'categories');
  const catRows = doc.querySelectorAll('[data-edit-cat]');
  check('categories table renders 3 rows', catRows.length === 3, `got ${catRows.length}`);
  check('category image column shows the mapped product image',
    /img\/asset\.svg/.test(doc.querySelector('.data-table tbody img')?.getAttribute('src') || ''));
  check('category order is editable inline', !!doc.querySelector('[data-cat-order]'));
  const catRowText = doc.querySelector('.data-table tbody').textContent;
  check('category name + product count rendered', /Key Cases/.test(catRowText) && /59/.test(catRowText));

  click(doc, '[data-edit-cat="keycase"]');
  await wait(60);
  const catForm = doc.querySelector('#cat-form');
  check('category editor opens prefilled', !!catForm
    && catForm.querySelector('[name=name_en]').value === 'Key Cases'
    && /asset\.svg/.test(catForm.querySelector('[name=image]').value));
  catForm.querySelector('[name=description_en]').value = 'Carbon fibre and leather cases';
  catForm.querySelector('[name=image]').value = '/img/asset.svg?type=keycase&brand=bmw';
  catForm.querySelector('[name=order]').value = '7';
  click(doc, '#btn-save-cat');
  await wait(80);
  const catSave = calls.filter((c) => c.url.includes('/api/admin/save') && c.body?.collection === 'categories').pop();
  check('category save posts name/image/description/order', !!catSave
    && catSave.body.record.image === '/img/asset.svg?type=keycase&brand=bmw'
    && catSave.body.record.description_en === 'Carbon fibre and leather cases'
    && catSave.body.record.order === 7, JSON.stringify(catSave?.body?.record));

  console.log('\n== ADMIN CMS: products (details, prices, images) ==');
  await nav(doc, 'products');
  check('products table renders', doc.querySelectorAll('[data-edit-product]').length > 0);
  click(doc, '[data-edit-product="p_mercedes-benz_case_carbon"]');
  await wait(80);
  const pf = doc.querySelector('#product-form');
  check('product editor has a Details section', /Details/.test(doc.querySelector('.modal-body').textContent));
  check('product editor prefills short description + material',
    pf.querySelector('[name=short_en]').value.includes('carbon fibre')
    && pf.querySelector('[name=material_en]').value.includes('Carbon fibre'));
  check('product editor prefills price and old price',
    pf.querySelector('[name=price]').value === '1450' && pf.querySelector('[name=oldPrice]').value === '1600');
  const imgRowsBefore = doc.querySelectorAll('#product-images-list [data-img-del]').length;
  check('product gallery lists the 3 existing images', imgRowsBefore === 3, `got ${imgRowsBefore}`);
  check('first image is marked MAIN', /MAIN IMAGE/.test(doc.querySelector('#product-images-list').textContent));

  doc.querySelector('#pf-new-image').value = '/img/asset.svg?type=detail-c&brand=mercedes-benz';
  click(doc, '#btn-add-image');
  await wait(40);
  check('image added to the gallery', doc.querySelectorAll('#product-images-list [data-img-del]').length === 4);
  doc.querySelector('#pf-new-image').value = '/img/asset.svg?type=detail-c&brand=mercedes-benz';
  click(doc, '#btn-add-image');
  await wait(40);
  check('duplicate image is rejected', doc.querySelectorAll('#product-images-list [data-img-del]').length === 4);
  click(doc, '#product-images-list [data-img-del="3"]');
  await wait(40);

  pf.querySelector('[name=price]').value = '1599';
  pf.querySelector('[name=oldPrice]').value = '1800';
  pf.querySelector('[name=oldPrice]').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  check('discount % auto-recalculates to 11', pf.querySelector('[name=discount]').value === '11', pf.querySelector('[name=discount]').value);

  click(doc, '#btn-save-product');
  await wait(80);
  const prodSave = calls.filter((c) => c.url.includes('/api/admin/save') && c.body?.collection === 'products').pop();
  check('product save posts the edited price + gallery',
    !!prodSave && prodSave.body.record.price === 1599 && prodSave.body.record.images.length === 3
    && prodSave.body.record.brandSlug === 'mercedes-benz', JSON.stringify(prodSave?.body?.record?.images));

  console.log('\n== ADMIN CMS: orders ==');
  await nav(doc, 'orders');
  check('order polling is scheduled (10s)', intervals.includes(10000), JSON.stringify(intervals));
  const orderHead = Array.from(doc.querySelectorAll('.data-table thead th')).map((th) => th.textContent).join('|');
  check('order list has Phone and Address columns', /Phone/.test(orderHead) && /Address/.test(orderHead), orderHead);
  const orderBody = doc.querySelector('.data-table tbody').textContent;
  check('order list shows the customer phone', /\+201000000000/.test(orderBody));
  check('order list shows the customer address', /123 Main St/.test(orderBody));
  check('order list shows every migrated order', doc.querySelectorAll('[data-view-order]').length === fixture.orders.length);

  click(doc, '#btn-refresh-orders');
  await wait(120);
  check('refresh button re-reads orders from Supabase', calls.some((c) => c.url.includes('/api/admin/orders')));

  const firstOrderId = fixture.orders[0].id;
  click(doc, `[data-view-order="${firstOrderId}"]`);
  await wait(150);
  const panel = doc.querySelector('.modal');
  check('order detail panel opens', !!panel && panel.textContent.includes(firstOrderId));
  check('panel shows customer_phone', !!panel.querySelector('[data-field="customer_phone"]')
    && panel.querySelector('[data-field="customer_phone"]').textContent.includes('+201000000000'));
  check('panel shows customer_address', !!panel.querySelector('[data-field="customer_address"]')
    && panel.querySelector('[data-field="customer_address"]').textContent.includes('123 Main St'));
  check('panel notes it renders order_items rows', /order_items/.test(panel.textContent));
  const itemRows = Array.from(panel.querySelectorAll('.data-table tbody tr'));
  check('panel renders one row per order item', itemRows.length === fixture.orders[0].items.length, `got ${itemRows.length}`);
  check('item rows show key shape + qty + line total', /A/.test(itemRows[0].textContent) && /1,450/.test(itemRows[0].textContent), itemRows[0].textContent);
  check('panel fetched the order from /api/admin/order/:id', calls.some((c) => c.url.includes(`/api/admin/order/${firstOrderId}`)));

  console.log('\n== ADMIN CMS: website content sections ==');
  await nav(doc, 'content');
  check('content sections card rendered', /Website Content Sections/.test(doc.body.textContent));
  check('content strings listed', doc.querySelectorAll('[data-edit-content]').length > 50,
    `got ${doc.querySelectorAll('[data-edit-content]').length}`);
  click(doc, '[data-edit-content="add_to_cart"]');
  await wait(60);
  const cf = doc.querySelector('#content-form');
  check('content editor opens with EN + AR values',
    !!cf && cf.querySelector('[name=value_en]').value === 'ADD TO CART'
    && cf.querySelector('[name=value_ar]').value.length > 0);
  cf.querySelector('[name=value_en]').value = 'ADD TO CART NOW';
  click(doc, '#btn-save-content');
  await wait(80);
  const contentSave = calls.filter((c) => c.url.includes('/api/admin/save') && c.body?.collection === 'websiteContent').pop();
  check('content save posts the new value', !!contentSave
    && contentSave.body.record.value_en === 'ADD TO CART NOW'
    && contentSave.body.record.key === 'add_to_cart');

  console.log('\n== ADMIN CMS: website images library ==');
  await nav(doc, 'images');
  check('library renders the stored image', /hero\.jpg/.test(doc.body.innerHTML));
  doc.querySelector('#image-url-input').value = '/img/hero2.jpg';
  doc.querySelector('#image-name-input').value = 'Second hero';
  click(doc, '#btn-image-by-url');
  await wait(80);
  const imgSave = calls.filter((c) => c.url.includes('/api/admin/save') && c.body?.collection === 'websiteImages').pop();
  check('image added to the library through the API', !!imgSave && imgSave.body.record.url === '/img/hero2.jpg');

  dom.window.close();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('admin CMS test crashed:', e); process.exit(1); });
