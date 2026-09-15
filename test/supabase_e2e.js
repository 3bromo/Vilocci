'use strict';
// ============================================================================
// Supabase-backed end-to-end verification
// ----------------------------------------------------------------------------
// Runs the REAL migration CLI against a REAL PostgreSQL server (with the
// Supabase shims), then boots the REAL Express app against it and exercises:
//
//   storefront checkout  ->  orders + order_items rows  ->  admin Orders list
//   admin edit (product / category / product image)  ->  storefront /api/data
//
// Usage:  npm run test:db
// Requires the dev dependency `embedded-postgres` (npm i -D embedded-postgres).
// ============================================================================

const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const { startLocalSupabase } = require('./support/local-supabase');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 4321);
const DEV_TOKEN = 'local-dev-token';

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
async function acheck(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
const section = (t) => console.log(`\n${t}`);

function runMigrate(args, env) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate.js')].concat(args), {
    cwd: ROOT,
    env: Object.assign({}, process.env, env),
    encoding: 'utf8',
  });
}

async function main() {
  console.log('Starting local Supabase-compatible Postgres…');
  let local;
  try {
    local = await startLocalSupabase({ port: 55432 });
  } catch (e) {
    console.log(`SKIP: ${e.message}`);
    process.exit(e.code === 'MISSING_EMBEDDED_PG' ? 0 : 1);
  }
  console.log(`  ready at ${local.url}\n`);

  const q = async (sql, params) => (await local.client.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];

  try {
    // ------------------------------------------------------------------ 1
    section('1. npm run migrate -- --apply  (real CLI, real Postgres)');
    const apply = runMigrate(['--apply'], { SUPABASE_DB_URL: local.url });
    process.stdout.write(apply.stdout || '');
    if (apply.stderr) process.stderr.write(apply.stderr);
    check('migration CLI exited 0', () => assert.strictEqual(apply.status, 0, `exit ${apply.status}`));

    const applied = await q('select version from supabase_migrations.schema_migrations order by version');
    check('both migrations recorded (001 + 002)', () =>
      assert.deepStrictEqual(applied.map((r) => r.version), ['001', '002']));

    // ------------------------------------------------------------------ 2
    section('2. Existing storefront content is in the database (mapped, not sample data)');
    const counts = {};
    for (const t of ['products', 'categories', 'brands', 'bundles', 'hero_slides', 'home_sections',
      'settings', 'promo_bar', 'website_content', 'orders', 'order_items', 'product_images', 'product_prices']) {
      counts[t] = (await one(`select count(*)::int n from public.${t}`)).n;
    }
    console.log('  ' + JSON.stringify(counts));
    const expected = {
      products: 117, categories: 3, brands: 29, bundles: 29, hero_slides: 3,
      home_sections: 14, settings: 25, promo_bar: 1, website_content: 167,
      orders: 23, order_items: 65, product_images: 279, product_prices: 117,
    };
    for (const [t, n] of Object.entries(expected)) {
      check(`${t} = ${n} rows`, () => assert.strictEqual(counts[t], n, `got ${counts[t]}`));
    }

    const kc = await one(`select name_en, product_count, image from public.categories where id = 'keycase'`);
    check('category "keycase" mapped from live data (59 products, real image)', () => {
      assert.strictEqual(kc.name_en, 'Key Cases');
      assert.strictEqual(kc.product_count, 59);
      assert.match(kc.image, /^\/img\/asset\.svg\?/);
    });

    const p = await one(`select name_en, price, brand_slug, category, images from public.products where id = 'p_mercedes-benz_case_carbon'`);
    check('product row carries the real catalog values', () => {
      assert.strictEqual(p.name_en, 'Spinto Carbon Key Case — Mercedes-Benz');
      assert.strictEqual(Number(p.price), 1450);
      assert.strictEqual(p.brand_slug, 'mercedes-benz');
      assert.strictEqual(p.category, 'keycase');
      assert.strictEqual(p.images.length, 3);
    });

    // ------------------------------------------------------------------ 3
    section('3. No duplicates (re-running the migration is a no-op)');
    const dup = await one(`
      select (select count(*) from (select slug from public.products group by slug having count(*) > 1) a)::int as dup_slugs,
             (select count(*) from (select product_id, url from public.product_images group by product_id, url having count(*) > 1) b)::int as dup_images,
             (select count(*) from (select slug from public.categories group by slug having count(*) > 1) c)::int as dup_cats`);
    check('no duplicate product slugs / images / categories', () =>
      assert.deepStrictEqual(dup, { dup_slugs: 0, dup_images: 0, dup_cats: 0 }));

    const before = JSON.stringify(counts);
    const reapply = runMigrate(['--apply'], { SUPABASE_DB_URL: local.url });
    check('second --apply exits 0', () => assert.strictEqual(reapply.status, 0, reapply.stdout.slice(-400)));
    const counts2 = {};
    for (const t of Object.keys(expected)) counts2[t] = (await one(`select count(*)::int n from public.${t}`)).n;
    check('row counts unchanged after re-run (idempotent)', () =>
      assert.strictEqual(JSON.stringify(counts2), before, `${JSON.stringify(counts2)} != ${before}`));

    // ------------------------------------------------------------------ 4
    section('4. Row Level Security actually blocks anonymous order reads');
    const anon = await local.connect();
    await anon.connect();
    await anon.query('set role anon');
    const anonOrders = (await anon.query('select count(*)::int n from public.orders')).rows[0].n;
    const anonProducts = (await anon.query('select count(*)::int n from public.products')).rows[0].n;
    await anon.end();
    check('anon sees 0 orders (admin-only table)', () => assert.strictEqual(anonOrders, 0));
    check('anon can read the public catalog', () => assert.ok(anonProducts > 0, `anon saw ${anonProducts} products`));

    // ------------------------------------------------------------------ 5
    section('5. Storefront -> checkout -> orders/order_items -> admin Orders');
    process.env.SUPABASE_DB_URL = local.url;
    process.env.ADMIN_DEV_TOKEN = DEV_TOKEN;
    process.env.NODE_ENV = 'test';
    process.env.DB_CACHE_TTL_MS = '0';
    const app = require('../server');
    const server = await new Promise((resolve) => {
      const s = app.listen(PORT, '0.0.0.0', () => resolve(s));
    });
    const base = `http://127.0.0.1:${PORT}`;
    const adminHeaders = { 'Content-Type': 'application/json', 'x-admin-dev-token': DEV_TOKEN };

    const data = await (await fetch(`${base}/api/data`)).json();
    check('GET /api/data serves the migrated catalog', () => {
      assert.strictEqual(data.products.length, 117);
      assert.strictEqual(data.categories.length, 3);
      assert.strictEqual(data.brands.length, 29);
      assert.strictEqual(data.settings.shopName, 'SPINTO');
    });

    const cart = [
      { productId: 'p_mercedes-benz_case_carbon', qty: 2, keyShape: 'A' },
      { productId: 'p_mercedes-benz_holder', qty: 1, keyShape: 'A' },
    ];
    const orderRes = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer: { fullName: 'E2E Tester', phone: '+201099998888', city: 'Cairo', area: 'Maadi', address: '9 Test Street, building 2', notes: 'call before delivery' },
        cart,
      }),
    });
    const orderJson = await orderRes.json();
    check('POST /api/orders succeeds', () => {
      assert.strictEqual(orderRes.status, 200, JSON.stringify(orderJson));
      assert.ok(orderJson.ok && orderJson.orderId, JSON.stringify(orderJson));
    });
    const newOrderId = orderJson.orderId;

    const orderRow = await one('select customer_name, customer_phone, customer_address, customer_city, customer_area, total, status from public.orders where id = $1', [newOrderId]);
    check('order row has customer_phone + customer_address columns filled', () => {
      assert.ok(orderRow, 'order row missing');
      assert.strictEqual(orderRow.customer_phone, '+201099998888');
      assert.strictEqual(orderRow.customer_address, '9 Test Street, building 2');
      assert.strictEqual(orderRow.customer_name, 'E2E Tester');
      assert.strictEqual(orderRow.customer_city, 'Cairo');
      assert.strictEqual(orderRow.customer_area, 'Maadi');
      assert.strictEqual(orderRow.status, 'Pending');
    });
    // 2 x 1450 + 850 = 3750, over the 2000 free-shipping threshold
    check('server recomputed the total (2 x 1450 + 850, free delivery)', () =>
      assert.strictEqual(Number(orderRow.total), 3750, `got ${orderRow.total}`));

    const items = await q('select product_id, qty, unit_price, line_total, key_shape, brand_slug from public.order_items where order_id = $1 order by product_id', [newOrderId]);
    check('order_items rows written (one per line)', () => {
      assert.strictEqual(items.length, 2);
      const caseItem = items.find((i) => i.product_id === 'p_mercedes-benz_case_carbon');
      assert.strictEqual(Number(caseItem.qty), 2);
      assert.strictEqual(Number(caseItem.unit_price), 1450);
      assert.strictEqual(Number(caseItem.line_total), 2900);
      assert.strictEqual(caseItem.key_shape, 'A');
      assert.strictEqual(caseItem.brand_slug, 'mercedes-benz');
    });

    const adminOrders = await (await fetch(`${base}/api/admin/orders`, { headers: adminHeaders })).json();
    const found = adminOrders.orders.find((o) => o.id === newOrderId);
    check('new order appears automatically in the admin Orders API', () => {
      assert.ok(found, 'order not in /api/admin/orders');
      assert.strictEqual(found.customer.phone, '+201099998888');
      assert.strictEqual(found.customer.address, '9 Test Street, building 2');
      assert.strictEqual(found.items.length, 2);
      assert.strictEqual(found.items[0].name_en && found.items[0].name_en.length > 3, true);
    });

    const adminData = await (await fetch(`${base}/api/admin/data`, { headers: adminHeaders })).json();
    check('admin payload has categories + all 23 migrated orders + the new one', () => {
      assert.strictEqual(adminData.categories.length, 3);
      assert.strictEqual(adminData.orders.length, 24);
      assert.ok(adminData.orders.some((o) => o.id === newOrderId));
      assert.strictEqual(adminData.websiteContent.length, 167);
    });

    const unauth = await fetch(`${base}/api/admin/data`);
    check('unauthenticated /api/admin/data -> 401', () => assert.strictEqual(unauth.status, 401));

    // ------------------------------------------------------------------ 6
    section('6. Admin edit -> Supabase -> storefront');
    const saveProduct = await (await fetch(`${base}/api/admin/save`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        collection: 'products',
        record: {
          id: 'p_mercedes-benz_case_carbon',
          name_en: 'Spinto Carbon Key Case — Mercedes-Benz',
          slug: 'mercedes-benz-carbon-key-case',
          category: 'keycase',
          brandSlug: 'mercedes-benz',
          price: 1599,
          oldPrice: 1800,
          discount: 11,
          inventory: 7,
          images: [
            '/img/asset.svg?type=keycase&brand=mercedes-benz&style=carbon',
            '/img/asset.svg?type=detail-a&brand=mercedes-benz',
          ],
          active: true,
        },
      }),
    })).json();
    check('POST /api/admin/save (product) accepted', () => assert.ok(saveProduct.ok, JSON.stringify(saveProduct)));

    const data2 = await (await fetch(`${base}/api/data`)).json();
    const edited = data2.products.find((x) => x.id === 'p_mercedes-benz_case_carbon');
    check('storefront immediately serves the edited price/stock', () => {
      assert.strictEqual(edited.price, 1599);
      assert.strictEqual(edited.inventory, 7);
      assert.strictEqual(edited.oldPrice, 1800);
      assert.strictEqual(edited.images.length, 2);
    });

    const imgRows = await q('select url, is_main from public.product_images where product_id = $1 order by position', ['p_mercedes-benz_case_carbon']);
    check('product_images replaced without leaving stale/duplicate rows', () => {
      assert.strictEqual(imgRows.length, 2);
      assert.strictEqual(new Set(imgRows.map((r) => r.url)).size, 2);
      assert.strictEqual(imgRows[0].is_main, true);
    });
    const priceRow = await one(`select price, old_price from public.product_prices where product_id = $1 and label = 'default'`, ['p_mercedes-benz_case_carbon']);
    check('product_prices row updated with the new price', () => {
      assert.strictEqual(Number(priceRow.price), 1599);
      assert.strictEqual(Number(priceRow.old_price), 1800);
    });

    const catRes = await (await fetch(`${base}/api/admin/save`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        collection: 'categories',
        record: {
          id: 'keycase', slug: 'keycases', name_en: 'Key Cases', name_ar: 'جرابات المفاتيح',
          description_en: 'Carbon fibre and leather key cases.', image: '/img/asset.svg?type=keycase&brand=bmw',
          active: true, product_count: 59, order: 3,
        },
      }),
    })).json();
    check('POST /api/admin/save (category) accepted', () => assert.ok(catRes.ok, JSON.stringify(catRes)));
    const data3 = await (await fetch(`${base}/api/data`)).json();
    const cat = data3.categories.find((c) => c.id === 'keycase');
    check('storefront serves the edited category (name/image/description/order)', () => {
      assert.strictEqual(cat.image, '/img/asset.svg?type=keycase&brand=bmw');
      assert.strictEqual(cat.description_en, 'Carbon fibre and leather key cases.');
      assert.strictEqual(cat.order, 3);
    });

    const statusRes = await (await fetch(`${base}/api/admin/order-status`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ id: newOrderId, status: 'Confirmed' }),
    })).json();
    const statusRow = await one('select status, status_history from public.orders where id = $1', [newOrderId]);
    check('admin status change persisted with history', () => {
      assert.ok(statusRes.ok);
      assert.strictEqual(statusRow.status, 'Confirmed');
      assert.strictEqual(statusRow.status_history.length, 2);
      assert.strictEqual(statusRow.status_history[1].status, 'Confirmed');
    });

    const contentRes = await (await fetch(`${base}/api/admin/save`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ collection: 'websiteContent', record: { id: 'wc_home', section: 'copy', key: 'home', value_en: 'Home', value_ar: 'الرئيسية' } }),
    })).json();
    check('website content section saved', () => assert.ok(contentRes.ok, JSON.stringify(contentRes)));

    const imgUpload = await (await fetch(`${base}/api/admin/save`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ collection: 'websiteImages', record: { id: 'img_e2e', name: 'E2E banner', url: '/img/hero.jpg', section: 'hero', alt: 'E2E' } }),
    })).json();
    const siteImg = await one(`select url from public.website_images where id = 'img_e2e'`);
    check('website image saved to website_images', () => {
      assert.ok(imgUpload.ok, JSON.stringify(imgUpload));
      assert.strictEqual(siteImg.url, '/img/hero.jpg');
    });

    await new Promise((resolve) => server.close(resolve));

    // ------------------------------------------------------------------ 7
    section('7. Dry run reports the same mapping (no writes)');
    const dry = runMigrate(['--json'], { SUPABASE_DB_URL: local.url });
    const dryJson = JSON.parse(dry.stdout);
    check('dry run lists every table with existing row counts', () => {
      assert.strictEqual(dryJson.mode, 'dry-run');
      assert.strictEqual(dryJson.tables.find((t) => t.table === 'products').existingRows, 117);
      assert.strictEqual(dryJson.tables.find((t) => t.table === 'orders').existingRows, 24);
      assert.strictEqual(dryJson.totals.deletes, 0);
    });
    check('dry run verifies 117/117 products against data/velocci-db.json', () => {
      assert.strictEqual(dryJson.sourceVerification.checked, 117);
      assert.strictEqual(dryJson.sourceVerification.mismatches.length, 0);
    });
  } finally {
    // Close the app's connection pool before stopping Postgres, otherwise the
    // idle sockets emit an unhandled 'error' during teardown.
    try { require('../lib/db').close && await require('../lib/db').close(); } catch (e) { /* ignore */ }
    await local.stop();
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('test crashed:', e);
  process.exit(1);
});
