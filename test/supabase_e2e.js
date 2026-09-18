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
    check('all migrations recorded (001 … 006)', () =>
      assert.deepStrictEqual(applied.map((r) => r.version), ['001', '002', '003', '004', '005', '006']));

    const colorCols = await q(`select table_name, column_name from information_schema.columns
      where table_schema = 'public' and column_name in ('colors','color')
        and ((table_name = 'products' and column_name = 'colors') or (table_name = 'order_items' and column_name = 'color'))`);
    check('004 added products.colors + order_items.color', () =>
      assert.strictEqual(colorCols.length, 2, JSON.stringify(colorCols)));

    const proofCols = await q(`select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'orders' and column_name like 'payment_proof%'`);
    check('005 added the four orders.payment_proof_* columns', () =>
      assert.strictEqual(proofCols.length, 4, JSON.stringify(proofCols)));

    const coatingCols = await q(`select table_name, column_name from information_schema.columns
      where table_schema = 'public' and column_name in ('coating_fee','coating')
        and ((table_name = 'orders' and column_name = 'coating_fee') or (table_name = 'order_items' and column_name = 'coating'))`);
    check('006 added orders.coating_fee + order_items.coating', () =>
      assert.strictEqual(coatingCols.length, 2, JSON.stringify(coatingCols)));
    const seededColors = await one(`select count(*)::int n from public.products where jsonb_array_length(coalesce(colors,'[]'::jsonb)) > 0`);
    check('mapped products carry their seeded color variants', () =>
      assert.strictEqual(seededColors.n, 117, `got ${seededColors.n}`));

    // ------------------------------------------------------------------ 2
    section('2. Existing storefront content is in the database (mapped, not sample data)');
    const counts = {};
    for (const t of ['products', 'categories', 'brands', 'bundles', 'hero_slides', 'home_sections',
      'settings', 'promo_bar', 'website_content', 'orders', 'order_items', 'product_images', 'product_prices',
      'customize_requests']) {
      counts[t] = (await one(`select count(*)::int n from public.${t}`)).n;
    }
    console.log('  ' + JSON.stringify(counts));
    const expected = {
      products: 117, categories: 3, brands: 29, bundles: 29, hero_slides: 3,
      home_sections: 14,
      // 25 storefront settings + the language dictionary + the seeded
      // Customize category setting (003 / post-import default)
      settings: 27,
      // 167 original copy strings + the 4 color-system dictionary keys
      // + the 9 InstaPay payment-proof dictionary keys (the old expectation of
      // 171 predated the InstaPay dictionary and was stale on main)
      promo_bar: 1, website_content: 180,
      orders: 23, order_items: 65, product_images: 279, product_prices: 117,
      customize_requests: 0,
    };
    for (const [t, n] of Object.entries(expected)) {
      check(`${t} = ${n} rows`, () => assert.strictEqual(counts[t], n, `got ${counts[t]}`));
    }

    const czSetting = await one(`select value from public.settings where key = 'customize'`);
    check('the Customize category setting was seeded with every existing category', () => {
      assert.deepStrictEqual(Object.keys(czSetting.value.categories).sort(), ['keycase', 'keyholder', 'medal']);
    });

    const kc = await one(`select name_en, product_count, image from public.categories where id = 'keycase'`);
    check('category "keycase" mapped from live data (59 products, real image)', () => {
      assert.strictEqual(kc.name_en, 'Key Cases');
      assert.strictEqual(kc.product_count, 59);
      assert.match(kc.image, /^\/img\/asset\.svg\?/);
    });

    const p = await one(`select name_en, price, brand_slug, category, images from public.products where id = 'p_mercedes-benz_case_carbon'`);
    check('product row carries the real catalog values', () => {
      assert.strictEqual(p.name_en, 'Vilocci Carbon Key Case — Mercedes-Benz');
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

    const czCols = await q(`select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'customize_requests'`);
    const czColNames = czCols.map((r) => r.column_name);
    check('customize_requests has every documented column', () => {
      for (const c of ['id', 'created_at', 'category_id', 'car_image_path', 'car_brand', 'car_model',
        'model_year', 'car_details', 'customization_request', 'customer_name', 'phone', 'whatsapp',
        'email', 'preferred_contact', 'additional_notes', 'status', 'admin_notes']) {
        assert.ok(czColNames.includes(c), `missing column ${c}`);
      }
    });
    const czRls = await one(`select relrowsecurity from pg_class where oid = 'public.customize_requests'::regclass`);
    check('customize_requests has RLS enabled', () => assert.strictEqual(czRls.relrowsecurity, true));
    const czSeed = await one(`select value from public.settings where key = 'customize'`);
    check('the customize category setting is seeded from the existing categories', () => {
      assert.ok(czSeed, 'settings[customize] missing');
      assert.deepStrictEqual(Object.keys(czSeed.value.categories).sort(), ['keycase', 'keyholder', 'medal']);
      assert.deepStrictEqual(Object.values(czSeed.value.categories), [true, true, true]);
    });
    const czCatActive = await one(`select active from public.categories where id = 'keycase'`);
    check('the feature does not touch categories.active (normal shopping unaffected)', () =>
      assert.notStrictEqual(czCatActive.active, false));

    // ------------------------------------------------------------------ 4
    section('4. Row Level Security actually blocks anonymous order reads');
    const anon = await local.connect();
    await anon.connect();
    await anon.query('set role anon');
    const anonOrders = (await anon.query('select count(*)::int n from public.orders')).rows[0].n;
    const anonProducts = (await anon.query('select count(*)::int n from public.products')).rows[0].n;
    // Either RLS hands out zero rows or the role has no grant at all — both mean
    // the customers' data is unreachable.
    let anonCustomize = null;
    let anonCustomizeDenied = false;
    try {
      anonCustomize = (await anon.query('select count(*)::int n from public.customize_requests')).rows[0].n;
    } catch (e) {
      anonCustomizeDenied = /permission denied/i.test(e.message);
    }
    await anon.end();
    check('anon sees 0 orders (admin-only table)', () => assert.strictEqual(anonOrders, 0));
    check('anon cannot read customize requests (no rows and no grant)', () =>
      assert.ok(anonCustomizeDenied || anonCustomize === 0, `anon read ${anonCustomize}`));
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
      assert.strictEqual(data.settings.shopName, 'VILOCCI');
    });

    const pickColor = (pid) => {
      const p = data.products.find((x) => x.id === pid);
      const c = (p.colors || []).find((x) => x && x.id && x.enabled !== false);
      assert.ok(c, `seeded product ${pid} must carry an enabled color`);
      return c.id;
    };
    const cart = [
      { productId: 'p_mercedes-benz_case_carbon', qty: 2, keyShape: 'A', colorId: pickColor('p_mercedes-benz_case_carbon') },
      { productId: 'p_mercedes-benz_holder', qty: 1, keyShape: 'A', colorId: pickColor('p_mercedes-benz_holder') },
    ];
    // The new required-color rule applies to the SQL driver too.
    const noColorRes = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer: { fullName: 'E2E Tester', phone: '+201099998888', city: 'Cairo', area: 'Maadi', address: '9 Test Street, building 2' },
        cart: [{ productId: 'p_mercedes-benz_case_carbon', qty: 1, keyShape: 'A' }],
      }),
    });
    check('order without a required color is rejected (SQL driver)', () => {
      assert.strictEqual(noColorRes.status, 400);
    });
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

    const items = await q('select product_id, qty, unit_price, line_total, key_shape, brand_slug, color from public.order_items where order_id = $1 order by product_id', [newOrderId]);
    check('order_items rows written (one per line)', () => {
      assert.strictEqual(items.length, 2);
      const caseItem = items.find((i) => i.product_id === 'p_mercedes-benz_case_carbon');
      assert.strictEqual(Number(caseItem.qty), 2);
      assert.strictEqual(Number(caseItem.unit_price), 1450);
      assert.strictEqual(Number(caseItem.line_total), 2900);
      assert.strictEqual(caseItem.key_shape, 'A');
      assert.strictEqual(caseItem.brand_slug, 'mercedes-benz');
    });
    check('order_items.color carries the chosen color snapshot (SQL path)', () => {
      for (const it of items) {
        assert.ok(it.color && typeof it.color === 'object', 'color jsonb missing');
        assert.ok(it.color.id && it.color.name_en && it.color.name_ar, 'snapshot fields missing');
        assert.match(it.color.hex, /^#[0-9A-F]{6}$/i);
      }
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
      // the Nano Ceramic Coating order (section 5b) is placed AFTER this point
      assert.strictEqual(adminData.orders.length, 24);
      assert.ok(adminData.orders.some((o) => o.id === newOrderId));
      assert.strictEqual(adminData.websiteContent.length, 180);
    });

    const unauth = await fetch(`${base}/api/admin/data`);
    check('unauthenticated /api/admin/data -> 401', () => assert.strictEqual(unauth.status, 401));

    // ------------------------------------------------------------------ 5b
    section('5b. Nano Ceramic Coating through the SQL driver (migration 006)');
    const holderP = data.products.find((x) => x.id === 'p_mercedes-benz_holder');
    const coatRes = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer: { fullName: 'Coating E2E', phone: '+201099996666', city: 'Cairo', address: '2 Test Street' },
        cart: [{ productId: 'p_mercedes-benz_holder', qty: 1, keyShape: 'A', colorId: pickColor('p_mercedes-benz_holder'), coating: true }],
      }),
    });
    const coatJson = await coatRes.json();
    check('coated COD order succeeds on the SQL driver with the flat fee', () => {
      assert.strictEqual(coatRes.status, 200, JSON.stringify(coatJson));
      assert.strictEqual(coatJson.coatingFee, 100, JSON.stringify(coatJson));
      // holder price + 60 delivery (below the 2000 free-shipping threshold) + 100 coating
      assert.strictEqual(Number(coatJson.total), Number(holderP.price) + 60 + 100, `got ${coatJson.total}`);
    });
    const coatOrderRow = await one('select coating_fee, total from public.orders where id = $1', [coatJson.orderId]);
    check('orders.coating_fee persisted in SQL', () =>
      assert.strictEqual(Number(coatOrderRow.coating_fee), 100, String(coatOrderRow.coating_fee)));
    const coatItemRow = await one('select coating from public.order_items where order_id = $1', [coatJson.orderId]);
    check('order_items.coating persisted in SQL', () =>
      assert.strictEqual(coatItemRow.coating, true, String(coatItemRow.coating)));
    const plainRow = await one('select coating_fee from public.orders where id = $1', [newOrderId]);
    check('the earlier un-coated order never wrote the fee column', () =>
      assert.ok(plainRow.coating_fee === null || Number(plainRow.coating_fee) === 0, String(plainRow.coating_fee)));
    const plainItem = await one('select coating from public.order_items where order_id = $1 limit 1', [newOrderId]);
    check('un-coated lines keep the column default (false)', () =>
      assert.ok(plainItem.coating === false || plainItem.coating === null, String(plainItem.coating)));

    // ------------------------------------------------------------------ 6
    section('6. Admin edit -> Supabase -> storefront');
    const saveProduct = await (await fetch(`${base}/api/admin/save`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        collection: 'products',
        record: {
          id: 'p_mercedes-benz_case_carbon',
          name_en: 'Vilocci Carbon Key Case — Mercedes-Benz',
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

    // ------------------------------------------------------------------ 7
    section('7. Customize: customer request -> private photo -> admin management');

    const czCats = await (await fetch(`${base}/api/customize/categories`)).json();
    check('GET /api/customize/categories lists the admin-enabled categories', () => {
      assert.strictEqual(czCats.available, true);
      assert.deepStrictEqual(czCats.categories.map((c) => c.id).sort(), ['keycase', 'keyholder', 'medal']);
      assert.ok(czCats.contactMethods.includes('WhatsApp'), JSON.stringify(czCats.contactMethods));
    });

    const jpeg = 'data:image/jpeg;base64,' + Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0xff, 0xd9,
    ]).toString('base64');
    const czPost = (body) => fetch(`${base}/api/customize/requests`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const czBody = {
      category: 'keycase', carBrand: 'Mercedes-Benz', carModel: 'C-Class', modelYear: '2022',
      carDetails: 'AMG line, black leather',
      customizationRequest: 'Carbon key case with the AMG badge and gold stitching, please.',
      fullName: 'Customize E2E', phone: '+201099997777', whatsapp: '+201099997777',
      email: 'cz@example.com', preferredContact: 'WhatsApp', additionalNotes: 'Evenings only',
      carImage: jpeg, clientKey: 'e2e_customize_1', locale: 'en',
    };

    const czRes = await czPost(czBody);
    const czJson = await czRes.json();
    check('POST /api/customize/requests stores the request', () => {
      assert.strictEqual(czRes.status, 200, JSON.stringify(czJson));
      assert.ok(czJson.ok && /^CUS-/.test(czJson.requestId || ''), JSON.stringify(czJson));
    });
    const czId = czJson.requestId;
    check('the car photo lands in private storage (or the inline fallback), never a public URL', () =>
      assert.ok(['private-storage', 'inline-fallback'].includes(czJson.photoStored), czJson.photoStored));

    const czRow = await one('select * from public.customize_requests where id = $1', [czId]);
    check('the row carries the category, car, request and customer details', () => {
      assert.strictEqual(czRow.category_id, 'keycase');
      assert.strictEqual(czRow.category_name_en, 'Key Cases');
      assert.strictEqual(czRow.car_brand, 'Mercedes-Benz');
      assert.strictEqual(czRow.car_model, 'C-Class');
      assert.strictEqual(czRow.model_year, '2022');
      assert.strictEqual(czRow.car_details, 'AMG line, black leather');
      assert.strictEqual(czRow.customization_request, 'Carbon key case with the AMG badge and gold stitching, please.');
      assert.strictEqual(czRow.customer_name, 'Customize E2E');
      assert.strictEqual(czRow.phone, '+201099997777');
      assert.strictEqual(czRow.whatsapp, '+201099997777');
      assert.strictEqual(czRow.email, 'cz@example.com');
      assert.strictEqual(czRow.preferred_contact, 'WhatsApp');
      assert.strictEqual(czRow.status, 'New');
    });
    check('the photo is a bucket path or inline data — never a public URL', () => {
      assert.ok(czRow.car_image_path || czRow.car_image_data, 'no photo stored');
      assert.ok(!/^https?:/i.test(czRow.car_image_path || ''), `public path: ${czRow.car_image_path}`);
    });

    const czDup = await (await czPost(czBody)).json();
    check('a repeated submit (same client key) is deduplicated', () => {
      assert.strictEqual(czDup.requestId, czId);
      assert.strictEqual(czDup.duplicate, true);
    });
    await acheck('exactly one row exists for that client key', async () => {
      const n = await one('select count(*)::int n from public.customize_requests where client_key = $1', ['e2e_customize_1']);
      assert.strictEqual(n.n, 1);
    });

    const czNoPhoto = await (await czPost(Object.assign({}, czBody, { carImage: undefined, clientKey: 'e2e_customize_nophoto' }))).json();
    check('a submission without a car photo is rejected', () =>
      assert.match(czNoPhoto.errors.carImage, /photo of your car is required/i));
    const czBadYear = await (await czPost(Object.assign({}, czBody, { modelYear: '22', clientKey: 'e2e_customize_badyear' }))).json();
    check('an invalid model year is rejected', () =>
      assert.match(czBadYear.errors.modelYear, /4-digit/i));
    const czBadImg = await (await czPost(Object.assign({}, czBody, { carImage: 'data:text/html;base64,PHNjcmlwdD4=', clientKey: 'e2e_customize_badimg' }))).json();
    check('a non-image "photo" is rejected', () =>
      assert.match(czBadImg.error, /image/i));

    await acheck('anonymous access to every admin Customize endpoint is refused (401)', async () => {
      for (const p of ['/api/admin/customize/settings', '/api/admin/customize/requests',
        `/api/admin/customize/requests/${czId}`, `/api/admin/customize/requests/${czId}/photo`]) {
        const r = await fetch(base + p);
        assert.strictEqual(r.status, 401, `${p} -> ${r.status}`);
      }
    });
    const czAnonDelete = await fetch(`${base}/api/admin/customize/requests/${czId}/delete`, { method: 'POST' });
    check('anonymously deleting a request is refused', () => assert.strictEqual(czAnonDelete.status, 401));

    const czList = await (await fetch(`${base}/api/admin/customize/requests`, { headers: adminHeaders })).json();
    check('the admin list shows the request without shipping the photo payload', () => {
      const found = czList.requests.find((r) => r.id === czId);
      assert.ok(found, 'request missing from /api/admin/customize/requests');
      assert.strictEqual(found.customerName, 'Customize E2E');
      assert.strictEqual(found.categoryNameEn, 'Key Cases');
      assert.strictEqual(found.hasPhoto, true);
      assert.ok(!('carImageData' in found) && !('carImagePath' in found), 'the private photo must not be in the list payload');
      assert.ok(!JSON.stringify(found).includes('data:image'), 'inline data leaked into the list payload');
    });

    const czPhoto = await (await fetch(`${base}/api/admin/customize/requests/${czId}/photo`, { headers: adminHeaders })).json();
    check('the admin opens the private photo through an authenticated short-lived link', () => {
      assert.ok(czPhoto.url, JSON.stringify(czPhoto));
      assert.ok(['signed', 'inline'].includes(czPhoto.kind), czPhoto.kind);
    });

    const czPatch = await (await fetch(`${base}/api/admin/customize/requests/${czId}`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ status: 'In Progress', admin_notes: 'Quoted carbon + gold stitching.' }),
    })).json();
    const czRow2 = await one('select status, admin_notes from public.customize_requests where id = $1', [czId]);
    check('admin status + internal notes persist in Supabase', () => {
      assert.ok(czPatch.ok, JSON.stringify(czPatch));
      assert.strictEqual(czRow2.status, 'In Progress');
      assert.strictEqual(czRow2.admin_notes, 'Quoted carbon + gold stitching.');
    });
    const czBadStatus = await fetch(`${base}/api/admin/customize/requests/${czId}`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ status: 'Nope' }),
    });
    check('an unknown status is rejected', () => assert.strictEqual(czBadStatus.status, 400));

    // Category availability: admin-controlled, and isolated from shopping.
    const czOff = await (await fetch(`${base}/api/admin/customize/settings`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ categories: { keycase: false, keyholder: true, medal: true } }),
    })).json();
    check('the admin can disable a category for Customize only', () =>
      assert.strictEqual(czOff.customize.categories.keycase, false));
    const czCats2 = await (await fetch(`${base}/api/customize/categories`)).json();
    check('the public Customize page no longer offers it', () =>
      assert.deepStrictEqual(czCats2.categories.map((c) => c.id).sort(), ['keyholder', 'medal']));
    const czRefused = await czPost(Object.assign({}, czBody, { clientKey: 'e2e_customize_off' }));
    check('a request for a disabled category is refused', () => assert.strictEqual(czRefused.status, 400));
    const dataOff = await (await fetch(`${base}/api/data`)).json();
    check('normal shopping is untouched: /api/data still serves all 3 categories + the customize config', () => {
      assert.strictEqual(dataOff.categories.length, 3);
      assert.strictEqual(dataOff.categories.find((c) => c.id === 'keycase').active, true);
      assert.deepStrictEqual(dataOff.customize.categories.map((c) => c.id).sort(), ['keyholder', 'medal']);
    });
    await acheck('categories.active was never modified by the Customize setting', async () => {
      const rows = await q('select id, active from public.categories order by id');
      assert.deepStrictEqual(rows.map((r) => r.active), [true, true, true]);
    });

    const czOn = await (await fetch(`${base}/api/admin/customize/settings`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ categories: { keycase: true, keyholder: true, medal: true } }),
    })).json();
    check('re-enabling the category brings it back', () => assert.strictEqual(czOn.customize.categories.keycase, true));
    const czCats3 = await (await fetch(`${base}/api/customize/categories`)).json();
    check('the public Customize page offers all 3 categories again', () => assert.strictEqual(czCats3.categories.length, 3));

    const czDel = await (await fetch(`${base}/api/admin/customize/requests/${czId}/delete`, {
      method: 'POST', headers: adminHeaders,
    })).json();
    await acheck('admin deletion removes the request from Supabase', async () => {
      assert.ok(czDel.ok, JSON.stringify(czDel));
      const n = await one('select count(*)::int n from public.customize_requests where id = $1', [czId]);
      assert.strictEqual(n.n, 0);
    });

    await new Promise((resolve) => server.close(resolve));

    // ------------------------------------------------------------------ 8
    section('8. Dry run reports the same mapping (no writes)');
    const dry = runMigrate(['--json'], { SUPABASE_DB_URL: local.url });
    const dryJson = JSON.parse(dry.stdout);
    check('dry run lists every table with existing row counts', () => {
      assert.strictEqual(dryJson.mode, 'dry-run');
      assert.strictEqual(dryJson.tables.find((t) => t.table === 'products').existingRows, 117);
      // 23 migrated + the e2e order + the Nano Ceramic Coating order (5b)
      assert.strictEqual(dryJson.tables.find((t) => t.table === 'orders').existingRows, 25);
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
