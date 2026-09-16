'use strict';
// ============================================================================
// Data-layer fallback test
// ----------------------------------------------------------------------------
// Production has VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY but the schema
// may not be applied yet. The store must then degrade to the bundled JSON
// dataset — for reads AND writes — instead of failing the storefront with a
// 500. This drives lib/db.js directly against drivers that cannot connect.
//
// Usage: npm run test:fallback
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0; let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓', name); }
  else { fail += 1; console.log('  ✗', name, extra || ''); }
}

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spinto-fallback-')), 'velocci-db.json');
fs.copyFileSync(path.join(ROOT, 'data', 'velocci-db.json'), SCRATCH);

// Load lib/db.js fresh with a given environment.
function loadDb(env) {
  for (const key of Object.keys(process.env)) {
    if (/^(VITE_SUPABASE_URL|VITE_SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_DB_URL|DATABASE_URL|POSTGRES_URL|DATA_DRIVER|VELOCCI_DB)$/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, { VELOCCI_DB: SCRATCH }, env);
  for (const id of Object.keys(require.cache)) {
    if (id.includes(`${path.sep}lib${path.sep}`)) delete require.cache[id];
  }
  return require('../lib/db');
}

const quiet = (fn) => {
  const { log, warn, error } = console;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  return Promise.resolve().then(fn).finally(() => { console.log = log; console.warn = warn; console.error = error; });
};

(async function main() {
  // -------------------------------------------------------------------------
  console.log('\n== sql driver configured but unreachable ==');
  let db = loadDb({ SUPABASE_DB_URL: 'postgres://postgres:postgres@127.0.0.1:1/postgres' });
  check('configured driver is sql', db.DRIVER === 'sql', db.DRIVER);

  const catalog = await quiet(() => db.getCatalog());
  check('GET /api/data still serves the catalog', catalog.products.length === 117, `got ${catalog.products.length}`);
  check('catalog came from the JSON fallback', db.health().usingJsonFallback === true, JSON.stringify(db.health()));
  check('health names the active driver', db.health().activeDriver === 'json');
  check('health keeps the reason', /ECONNREFUSED/.test(db.health().remoteError || ''), db.health().remoteError);

  const orders = await quiet(() => db.getOrders({}));
  check('admin order list still works', orders.length === 23, `got ${orders.length}`);

  const created = await quiet(() => db.createOrder({
    id: 'ORD-FALLBACK-1',
    createdAt: new Date().toISOString(),
    customer: { fullName: 'Fallback Test', phone: '+201000000000', city: 'Cairo', area: 'Nasr City', address: '123 Main St', notes: '' },
    items: [{ productId: 'p_mercedes-benz_holder', name_en: 'Key Holder', qty: 1, price: 850, lineTotal: 850 }],
    subtotal: 850, bundleDiscount: 0, deliveryFee: 60, total: 910, status: 'new', statusHistory: [], payment: 'cod',
  }));
  check('checkout is still accepted (not lost)', created && created.ok !== false, JSON.stringify(created).slice(0, 160));
  const after = await db.getOrders({});
  check('the checkout is visible to admin', after.some((o) => o.id === 'ORD-FALLBACK-1'), `orders=${after.length}`);
  const stored = JSON.parse(fs.readFileSync(SCRATCH, 'utf8'));
  check('the checkout was written to the JSON store', (stored.orders || []).some((o) => o.id === 'ORD-FALLBACK-1'));
  check('info() reports the fallback for /api/admin/diagnose',
    db.info().usingJsonFallback === true && db.info().remoteState === 'unavailable', JSON.stringify(db.info()));
  await quiet(() => db.close());

  // -------------------------------------------------------------------------
  console.log('\n== postgrest driver configured but unreachable ==');
  db = loadDb({
    VITE_SUPABASE_URL: 'http://127.0.0.1:1',
    SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-key',
  });
  check('configured driver is postgrest', db.DRIVER === 'postgrest', db.DRIVER);
  const cat2 = await quiet(() => db.getCatalog());
  check('storefront data still served from the JSON store', cat2.products.length === 117, `got ${cat2.products.length}`);
  check('fallback engaged', db.health().usingJsonFallback === true, JSON.stringify(db.health()));
  const admin = await quiet(() => db.getAdminData());
  check('admin payload still complete', admin.products.length === 117 && admin.orders.length >= 23,
    `products=${admin.products.length} orders=${admin.orders.length}`);
  const saved = await quiet(() => db.saveRecord('products', Object.assign({}, admin.products[0], { price: 9999 })));
  check('admin edits still work on the fallback store', saved && saved.ok !== false, JSON.stringify(saved).slice(0, 160));
  const edited = await db.getCatalog();
  check('the edit is readable back', edited.products.find((p) => p.id === admin.products[0].id).price === 9999);
  await quiet(() => db.close());

  // -------------------------------------------------------------------------
  console.log('\n== json driver (nothing configured) ==');
  db = loadDb({});
  check('driver is json', db.DRIVER === 'json' && db.health().activeDriver === 'json');
  check('no fallback flag when json is what was asked for', db.health().usingJsonFallback === false, JSON.stringify(db.health()));
  const cat3 = await db.getCatalog();
  check('catalog served', cat3.products.length === 117);

  // -----------------------------------------------------------------------
  // Admin writes on the json driver must stay in APP shape.
  //
  // saveRecord() used to persist the translated SQL row (brand_slug /
  // bundle_price / key_case_id) into the JSON store, which jsonCatalog()
  // serves straight back with no row->app mapping. Every reader uses camelCase,
  // so an admin edit read `undefined`: an edited bundle rendered as "EGP 0"
  // and looked like the save had silently failed. patchRecord() compounded it
  // by running the already-app-shaped record through FROM_ROW, which blanked
  // brandSlug / bundlePrice / keyCaseProductId before the patch was merged —
  // dropping every field the edit form does not expose.
  // -----------------------------------------------------------------------
  console.log('\n== json driver: admin writes keep the app shape ==');
  const bundlesBefore = cat3.bundles.slice();
  const seeded = bundlesBefore.find((b) => b.id === 'b_mercedes-benz');
  check('seeded bundle is app-shaped', seeded.brandSlug === 'mercedes-benz' && Number(seeded.bundlePrice) > 0,
    JSON.stringify({ brandSlug: seeded.brandSlug, bundlePrice: seeded.bundlePrice }));

  // Exactly the patch the Admin → Packages ✏️ modal sends.
  const patch = {
    brandSlug: seeded.brandSlug, bundlePrice: 2299, normalTotal: 2999,
    title_en: 'Fallback Patch Check', title_ar: 'فحص السقوط', active: true,
  };
  await db.patchRecord('bundles', seeded.id, patch);
  const patched = (await db.getCatalog()).bundles.find((b) => b.id === seeded.id);
  check('edited bundlePrice reads back as camelCase', Number(patched.bundlePrice) === 2299, patched.bundlePrice);
  check('edited normalTotal reads back as camelCase', Number(patched.normalTotal) === 2999, patched.normalTotal);
  check('edited title_en persisted', patched.title_en === 'Fallback Patch Check', patched.title_en);
  check('no snake_case row keys leaked into the store',
    patched.bundle_price === undefined && patched.brand_slug === undefined && patched.normal_total === undefined,
    JSON.stringify(Object.keys(patched).filter((k) => /^(bundle_price|brand_slug|normal_total|key_case_id)$/.test(k))));
  check('unexposed keyCaseProductId survived the patch',
    patched.keyCaseProductId === seeded.keyCaseProductId, `${patched.keyCaseProductId} vs ${seeded.keyCaseProductId}`);
  check('unexposed keyHolderProductId survived the patch',
    patched.keyHolderProductId === seeded.keyHolderProductId, patched.keyHolderProductId);
  check('unexposed medalProductId survived the patch', patched.medalProductId === seeded.medalProductId);
  check('unexposed sub_en copy survived the patch', patched.sub_en === seeded.sub_en);
  check('unexposed startDate survived the patch', patched.startDate === seeded.startDate, patched.startDate);
  check('unexposed discountPercent survived the patch',
    Number(patched.discountPercent) === Number(seeded.discountPercent), patched.discountPercent);

  // A brand-new record must land app-shaped too, or its prices read as 0.
  const createdBundle = {
    id: 'bundle_qa_fallback', brandSlug: 'bmw', title_en: 'QA Fallback Bundle',
    bundlePrice: 1299, normalTotal: 1999, active: true, order: 99,
  };
  await db.saveRecord('bundles', createdBundle);
  const readBack = (await db.getCatalog()).bundles.find((b) => b.id === createdBundle.id);
  check('newly saved bundle reads back app-shaped', Number(readBack.bundlePrice) === 1299, readBack.bundlePrice);
  check('newly saved bundle keeps its brandSlug', readBack.brandSlug === 'bmw', readBack.brandSlug);
  await db.deleteRecord('bundles', createdBundle.id);
  check('throwaway bundle removed again', !(await db.getCatalog()).bundles.some((b) => b.id === createdBundle.id));

  const catalogAfter = await db.getCatalog();
  const otherBefore = bundlesBefore.find((b) => b.id === 'b_bmw');
  const otherAfter = catalogAfter.bundles.find((b) => b.id === 'b_bmw');
  check('an unedited bundle is byte-identical', JSON.stringify(otherBefore) === JSON.stringify(otherAfter));
  check('products untouched by a bundle patch', JSON.stringify(cat3.products) === JSON.stringify(catalogAfter.products));
  check('bundle count restored', catalogAfter.bundles.length === bundlesBefore.length,
    `${catalogAfter.bundles.length} vs ${bundlesBefore.length}`);

  await quiet(() => db.close());

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('fallback test crashed:', e); process.exit(1); });
