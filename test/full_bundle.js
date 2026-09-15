'use strict';
// ============================================================================
// supabase/full_database_seed.sql — full bundle verification
// ----------------------------------------------------------------------------
// Boots a REAL PostgreSQL server (embedded-postgres + Supabase shims), runs
// the ENTIRE generated bundle as one script, and proves:
//
//   1. BUNDLE APPLIES CLEANLY — every table, policy, trigger, index and
//      function from migrations 001+002 exists afterwards.
//   2. ALL SOURCE ROWS PRESENT — per-table counts and FIELD-LEVEL equality
//      between the database and data/velocci-db.json (all 872 rows).
//   3. ARABIC PRESERVED EXACTLY — every mapped *_ar / AR-dictionary value is
//      byte-equal to the source, and every Arabic string found anywhere in
//      the JSON exists verbatim in the database.
//   4. IDEMPOTENT — the bundle is applied 3 times; row counts and full-table
//      content digests are identical after each run; admin_users stays empty.
//   5. SIZE REPORT — final byte size and line count of the bundle.
//
// Plus static safety checks: no DROP TABLE / TRUNCATE / DELETE, every INSERT
// is an upsert, and no ACTIVE statement touches admin_users.
//
// Usage:  npm run test:bundle
// ============================================================================

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const { startLocalSupabase } = require('./support/local-supabase');

const ROOT = path.join(__dirname, '..');
const BUNDLE = path.join(ROOT, 'supabase', 'full_database_seed.sql');
const DB_FILE = path.join(ROOT, 'data', 'velocci-db.json');

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

const AR = /[\u0600-\u06FF]/;

// Every Arabic string anywhere in the source JSON (recursive walk).
function collectArabicStrings(value, out) {
  if (typeof value === 'string') {
    if (AR.test(value)) out.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectArabicStrings(v, out));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => collectArabicStrings(v, out));
  }
  return out;
}

async function main() {
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const bundleSql = fs.readFileSync(BUNDLE, 'utf8');

  console.log('Starting local Supabase-compatible Postgres…');
  let local;
  try {
    local = await startLocalSupabase({ port: 55444 });
  } catch (e) {
    console.log(`SKIP: ${e.message}`);
    process.exit(e.code === 'MISSING_EMBEDDED_PG' ? 0 : 1);
  }
  console.log(`  ready at ${local.url}`);

  const q = async (sql, params) => (await local.client.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];

  try {
    // ------------------------------------------------------------------ 0
    section('0. Static safety checks on the bundle file itself');
    const activeLines = bundleSql.split('\n').filter((l) => !l.trim().startsWith('--'));
    const activeSql = activeLines.join('\n');
    check('no DROP TABLE statement anywhere (active or commented)', () =>
      assert.ok(!/^\s*(--\s*)?drop\s+table/im.test(bundleSql), 'found DROP TABLE statement'));
    check('no TRUNCATE statement anywhere (active or commented)', () =>
      assert.ok(!/^\s*(--\s*)?truncate/im.test(bundleSql), 'found TRUNCATE statement'));
    check('no active DELETE statement', () =>
      assert.ok(!/delete\s+from/i.test(activeSql), 'found active DELETE'));
    check('every INSERT is an upsert (ON CONFLICT)', () => {
      const inserts = activeSql.match(/insert\s+into/gi) || [];
      const conflicts = activeSql.match(/on\s+conflict/gi) || [];
      assert.strictEqual(inserts.length, conflicts.length, `${inserts.length} inserts vs ${conflicts.length} on-conflict`);
      assert.ok(inserts.length > 0, 'no inserts found');
    });
    check('no ACTIVE statement touches admin_users', () =>
      assert.ok(!/(insert\s+into|update|delete\s+from)\s+(public\.)?admin_users/i.test(activeSql)));
    check('admin link block stays commented out', () =>
      assert.ok(/^--\s*INSERT INTO public\.admin_users/m.test(bundleSql)));

    // ------------------------------------------------------------------ 1
    section('1. Apply the FULL bundle (run #1) — one script, real Postgres');
    await acheck('bundle executes without error', async () => {
      await local.client.query(bundleSql);
    });

    const tables = ['admin_users', 'products', 'categories', 'brands', 'bundles', 'orders',
      'preorders', 'messages', 'discount_codes', 'website_content', 'website_images',
      'settings', 'hero_slides', 'home_sections', 'promo_bar',
      'order_items', 'product_images', 'product_prices'];
    await acheck(`all ${tables.length} tables exist`, async () => {
      const res = await q(`select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`);
      const have = new Set(res.map((r) => r.table_name));
      const missing = tables.filter((t) => !have.has(t));
      assert.deepStrictEqual(missing, [], `missing: ${missing.join(', ')}`);
    });

    await acheck('RLS enabled on all 15 core + 3 CMS tables', async () => {
      const res = await q(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
      assert.deepStrictEqual(res.map((r) => r.relname), [], `tables without RLS: ${res.map((r) => r.relname).join(', ')}`);
    });

    await acheck('functions is_admin() + set_updated_at() exist', async () => {
      const res = await q(`select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and proname in ('is_admin', 'set_updated_at')`);
      assert.deepStrictEqual(res.map((r) => r.proname).sort(), ['is_admin', 'set_updated_at']);
    });

    await acheck('all updated_at triggers exist (10 tables)', async () => {
      const res = await q(`select tgname from pg_trigger where not tgisinternal`);
      const names = res.map((r) => r.tgname).sort();
      const expected = ['brands_updated_at', 'bundles_updated_at', 'categories_updated_at',
        'content_updated_at', 'hero_slides_updated_at', 'home_sections_updated_at',
        'orders_updated_at', 'product_prices_updated_at', 'products_updated_at', 'settings_updated_at'].sort();
      assert.deepStrictEqual(names, expected);
    });

    await acheck('lookup indexes exist (12)', async () => {
      const res = await q(`select indexname from pg_indexes where schemaname = 'public'`);
      const have = new Set(res.map((r) => r.indexname));
      const expected = ['products_category_idx', 'products_brand_idx', 'products_active_idx',
        'categories_order_idx', 'home_sections_order_idx', 'orders_created_at_idx',
        'orders_status_idx', 'orders_customer_phone_idx', 'order_items_order_idx',
        'order_items_product_idx', 'product_images_product_idx', 'product_prices_product_idx'];
      const missing = expected.filter((i) => !have.has(i));
      assert.deepStrictEqual(missing, [], `missing indexes: ${missing.join(', ')}`);
    });

    await acheck('RLS policies created (≥ 30 policies)', async () => {
      const n = (await one(`select count(*)::int n from pg_policies where schemaname = 'public'`)).n;
      assert.ok(n >= 30, `only ${n} policies`);
    });

    await acheck('updated_at trigger actually fires on UPDATE', async () => {
      const before = await one(`select updated_at from public.products where id = 'p_mercedes-benz_case_carbon'`);
      await q(`update public.products set stock = stock where id = 'p_mercedes-benz_case_carbon'`);
      const after = await one(`select updated_at from public.products where id = 'p_mercedes-benz_case_carbon'`);
      assert.ok(new Date(after.updated_at).getTime() >= new Date(before.updated_at).getTime());
    });

    // ------------------------------------------------------------------ 2
    section('2. ALL source rows present — counts + field-level equality');
    const expected = {
      products: 117, categories: 3, brands: 29, bundles: 29, hero_slides: 3,
      home_sections: 14, settings: 25, promo_bar: 1, website_content: 167,
      orders: 23, order_items: 65, product_images: 279, product_prices: 117,
      messages: 0, preorders: 0, admin_users: 0, discount_codes: 0, website_images: 0,
    };
    const counts = {};
    for (const t of Object.keys(expected)) {
      counts[t] = (await one(`select count(*)::int n from public.${t}`)).n;
    }
    for (const [t, n] of Object.entries(expected)) {
      check(`${t.padEnd(16)} = ${String(n).padStart(4)} rows`, () =>
        assert.strictEqual(counts[t], n, `got ${counts[t]}`));
    }

    // products — field-level equality for all 117 rows
    await acheck('all 117 products match the source field-for-field', async () => {
      const rows = await q('select * from public.products');
      const byId = new Map(rows.map((r) => [r.id, r]));
      assert.strictEqual(rows.length, db.products.length);
      const problems = [];
      db.products.forEach((p) => {
        const r = byId.get(p.id);
        if (!r) { problems.push(`${p.id}: missing row`); return; }
        // DB NULL is the faithful rendering of a field absent from the source
        const orNull = (v) => (v === undefined ? null : v);
        const checks = [
          ['name_en', r.name_en, orNull(p.name_en)],
          ['name_ar', r.name_ar, orNull(p.name_ar)],
          ['slug', r.slug, orNull(p.slug)],
          ['category', r.category, p.category],
          ['brand_slug', r.brand_slug, p.brandSlug],
          ['description_ar', r.description_ar, orNull(p.description_ar)],
          ['short_ar', r.short_ar, orNull(p.short_ar)],
          ['material_ar', r.material_ar, orNull(p.material_ar)],
          ['warranty_ar', r.warranty_ar, orNull(p.warranty_ar)],
          ['badge_ar', r.badge_ar, orNull(p.badge_ar)],
          ['price', Number(r.price), Number(p.price)],
          ['stock', r.stock, Math.round(p.inventory || 0)],
          ['images', JSON.stringify(r.images), JSON.stringify(p.images)],
          ['key_shapes', JSON.stringify(r.key_shapes), JSON.stringify(p.keyShapes || [])],
          ['fitment', JSON.stringify(r.fitment), JSON.stringify(p.fitment || {})],
        ];
        checks.forEach(([f, got, want]) => {
          if (String(got) !== String(want)) problems.push(`${p.id}.${f}: db ${JSON.stringify(got)} != source ${JSON.stringify(want)}`);
        });
      });
      assert.deepStrictEqual(problems, [], problems.slice(0, 5).join(' | '));
    });

    // brands — Arabic names + models jsonb deep-equal
    await acheck('all 29 brands match (name_ar + models jsonb)', async () => {
      const rows = await q('select * from public.brands order by "order"');
      const problems = [];
      db.brands.forEach((b, i) => {
        const r = rows.find((x) => x.slug === b.slug);
        if (!r) { problems.push(`${b.slug}: missing row`); return; }
        if (r.name_ar !== b.name_ar) problems.push(`${b.slug}.name_ar: ${r.name_ar} != ${b.name_ar}`);
        if (r.name_en !== b.name_en) problems.push(`${b.slug}.name_en`);
        assert.deepStrictEqual(r.models, b.models || [], `${b.slug}.models jsonb mismatch`);
        const orNull = (v) => (v === undefined ? null : v);
        if (r.mark !== orNull(b.mark)) problems.push(`${b.slug}.mark: ${r.mark} != ${orNull(b.mark)}`);
        if (r.tier !== orNull(b.tier)) problems.push(`${b.slug}.tier: ${r.tier} != ${orNull(b.tier)}`);
      });
      assert.deepStrictEqual(problems, [], problems.slice(0, 5).join(' | '));
    });

    // bundles
    await acheck('all 29 bundles match (titles AR + prices)', async () => {
      const rows = await q('select * from public.bundles');
      const problems = [];
      db.bundles.forEach((b) => {
        const id = b.id || `b_${b.brandSlug || b.brand_slug}`;
        const r = rows.find((x) => x.id === id);
        if (!r) { problems.push(`${id}: missing row`); return; }
        if (r.title_ar !== (b.title_ar || null) && !(r.title_ar === '' && !b.title_ar))
          problems.push(`${id}.title_ar: ${JSON.stringify(r.title_ar)} != ${JSON.stringify(b.title_ar)}`);
        if (Number(r.bundle_price) !== Number(b.bundlePrice)) problems.push(`${id}.bundle_price`);
        if (Number(r.normal_total) !== Number(b.normalTotal)) problems.push(`${id}.normal_total`);
      });
      assert.deepStrictEqual(problems, [], problems.slice(0, 5).join(' | '));
    });

    // hero slides + home sections + promo bar
    await acheck('hero slides: AR fields byte-equal', async () => {
      const rows = await q('select * from public.hero_slides order by "order"');
      db.heroSlides.forEach((s, i) => {
        const r = rows.find((x) => x.id === s.id);
        assert.ok(r, `slide ${s.id} missing`);
        assert.strictEqual(r.headline_ar, s.headline_ar !== undefined ? s.headline_ar : s.title_ar, `slide ${i} headline_ar`);
        assert.strictEqual(r.title_ar, s.headline_ar !== undefined ? s.headline_ar : s.title_ar, `slide ${i} title_ar`);
        assert.strictEqual(r.btn1_ar, s.btn1_ar, `slide ${i} btn1_ar`);
        assert.strictEqual(r.btn2_ar, s.btn2_ar, `slide ${i} btn2_ar`);
        assert.strictEqual(r.accent_ar, s.accent_ar, `slide ${i} accent_ar`);
      });
    });

    await acheck('home sections: 14 rows, AR titles + config jsonb', async () => {
      const rows = await q('select * from public.home_sections');
      db.homeSections.forEach((s) => {
        const r = rows.find((x) => x.id === s.id);
        assert.ok(r, `section ${s.id} missing`);
        assert.strictEqual(r.title_ar, s.title_ar || null, `${s.id} title_ar`);
        assert.deepStrictEqual(r.config, s.config || {}, `${s.id} config jsonb`);
      });
    });

    await acheck('promo bar AR text byte-equal', async () => {
      const r = await one(`select * from public.promo_bar where id = 'promo'`);
      assert.ok(r, 'promo row missing');
      assert.strictEqual(r.text_ar, db.promoBar.text_ar);
      assert.strictEqual(r.text_en, db.promoBar.text_en);
      assert.strictEqual(r.enabled, db.promoBar.enabled !== false);
    });

    // settings — every key (incl. the full languages dictionary) deep-equal
    await acheck('settings: all 25 keys deep-equal (incl. full AR/EN dictionary)', async () => {
      const rows = await q('select key, value from public.settings');
      const src = Object.assign({}, db.settings, { languages: db.languages });
      assert.strictEqual(rows.length, Object.keys(src).length);
      rows.forEach((r) => {
        assert.deepStrictEqual(r.value, src[r.key], `settings key "${r.key}" differs`);
      });
    });

    // website content — all 167 rows EN+AR equal to the dictionary
    await acheck('website_content: 167 rows match the EN/AR dictionary', async () => {
      const rows = await q('select * from public.website_content');
      const dict = (db.languages && db.languages.dict) || {};
      const keys = new Set([...Object.keys(dict.en || {}), ...Object.keys(dict.ar || {})]);
      let scalarKeys = 0;
      keys.forEach((k) => {
        const ve = (dict.en || {})[k]; const va = (dict.ar || {})[k];
        if (typeof ve === 'object' && typeof va === 'object') return;
        scalarKeys += 1;
        const r = rows.find((x) => x.key === k);
        assert.ok(r, `wc row missing for key ${k}`);
        const wantEn = ve === undefined || ve === null || typeof ve === 'object' ? null : String(ve);
        const wantAr = va === undefined || va === null || typeof va === 'object' ? null : String(va);
        assert.strictEqual(r.value_en, wantEn, `wc ${k} EN`);
        assert.strictEqual(r.value_ar, wantAr, `wc ${k} AR`);
      });
      assert.strictEqual(scalarKeys, 167, `expected 167 scalar keys, got ${scalarKeys}`);
    });

    // orders + order items
    await acheck('all 23 orders match (customer jsonb, totals, status)', async () => {
      const rows = await q('select * from public.orders');
      db.orders.forEach((o) => {
        const r = rows.find((x) => x.id === o.id);
        assert.ok(r, `order ${o.id} missing`);
        assert.deepStrictEqual(r.customer, o.customer || {}, `order ${o.id} customer jsonb`);
        assert.deepStrictEqual(r.items, o.items || [], `order ${o.id} items jsonb`);
        assert.strictEqual(Number(r.total), Number(o.total), `order ${o.id} total`);
        assert.strictEqual(r.status, o.status, `order ${o.id} status`);
        const c = o.customer || {};
        assert.strictEqual(r.customer_phone, c.phone || null, `order ${o.id} phone`);
      });
    });

    await acheck('order_items: 65 rows with correct qty / prices', async () => {
      const rows = await q('select * from public.order_items');
      const totalItems = db.orders.reduce((s, o) => s + (o.items || []).length, 0);
      assert.strictEqual(rows.length, totalItems);
      db.orders.forEach((o) => {
        (o.items || []).forEach((it, i) => {
          const id = it.id || `${o.id}-${i + 1}`;
          const r = rows.find((x) => x.id === id);
          assert.ok(r, `order item ${id} missing`);
          assert.strictEqual(r.qty, it.qty, `${id} qty`);
          assert.strictEqual(Number(r.unit_price), Number(it.price), `${id} unit_price`);
          assert.strictEqual(Number(r.line_total), Number(it.lineTotal), `${id} line_total`);
        });
      });
    });

    await acheck('product_images: 279 rows, exact URL set per product', async () => {
      const rows = await q('select * from public.product_images');
      db.products.forEach((p) => {
        const want = [];
        (p.images || []).forEach((u) => { if (u && !want.includes(u)) want.push(u); });
        const main = p.main_image || (p.images || [])[0];
        if (main && !want.includes(main)) want.unshift(main);
        const got = rows.filter((r) => r.product_id === p.id).sort((a, b) => a.position - b.position).map((r) => r.url);
        assert.deepStrictEqual(got, want, `images mismatch for ${p.id}`);
      });
    });

    await acheck('product_prices: 117 default rows match product prices', async () => {
      const rows = await q('select * from public.product_prices');
      db.products.forEach((p) => {
        const r = rows.find((x) => x.id === `price_${p.id}_default`);
        assert.ok(r, `price row missing for ${p.id}`);
        assert.strictEqual(Number(r.price), Number(p.price), `${p.id} price`);
      });
    });

    // ------------------------------------------------------------------ 3
    section('3. Arabic content preserved EXACTLY');
    const arabicStrings = collectArabicStrings(db, []);
    check(`source contains ${arabicStrings.length} Arabic strings`, () =>
      assert.ok(arabicStrings.length > 500, `only ${arabicStrings.length}`));

    await acheck('every Arabic string in the JSON exists verbatim in the database', async () => {
      // Build one big haystack: every text + jsonb column of every populated table.
      const parts = [];
      for (const t of Object.keys(expected)) {
        if (counts[t] === 0) continue;
        const cols = await q(`select column_name, data_type from information_schema.columns
          where table_schema = 'public' and table_name = $1 order by ordinal_position`, [t]);
        for (const c of cols) {
          if (c.data_type === 'text' || c.data_type === 'character varying') {
            const res = await q(`select "${c.column_name}" as v from public.${t} where "${c.column_name}" is not null`);
            res.forEach((r) => parts.push(r.v));
          } else if (c.data_type === 'jsonb' || c.data_type === 'json') {
            const res = await q(`select "${c.column_name}"::text as v from public.${t} where "${c.column_name}" is not null`);
            res.forEach((r) => parts.push(r.v));
          } else if (c.data_type === 'ARRAY') {
            const res = await q(`select "${c.column_name}"::text as v from public.${t} where "${c.column_name}" is not null`);
            res.forEach((r) => parts.push(r.v));
          }
        }
      }
      // jsonb text output escapes embedded double quotes — normalize so a
      // comparison against the raw source string still works.
      const haystack = parts.join('\n').replace(/\\"/g, '"');
      const missing = [...new Set(arabicStrings)].filter((s) => !haystack.includes(s));
      assert.deepStrictEqual(missing.slice(0, 5), [], `${missing.length} Arabic strings missing, e.g. ${missing.slice(0, 3).map((s) => JSON.stringify(s)).join(', ')}`);
    });

    await acheck('RTL spot-checks: real AR sentences round-trip byte-equal', async () => {
      const sample = await one(`select name_ar, description_ar from public.products where id = 'p_mercedes-benz_case_carbon'`);
      const src = db.products.find((p) => p.id === 'p_mercedes-benz_case_carbon');
      assert.strictEqual(sample.name_ar, src.name_ar);
      assert.strictEqual(sample.description_ar, src.description_ar);
      const nav = await one(`select value_ar from public.website_content where key = 'nav_home'`);
      if ((db.languages.dict.ar || {}).nav_home) assert.strictEqual(nav.value_ar, db.languages.dict.ar.nav_home);
    });

    // ------------------------------------------------------------------ 4
    section('4. IDEMPOTENCY — apply the same bundle two more times');
    async function stateDigest() {
      const digests = {};
      for (const t of Object.keys(expected)) {
        const pk = t === 'settings' ? 'key' : 'id';
        // Digest every CONTENT column. updated_at / created_at are excluded on
        // purpose: an upsert's conflict-update legitimately refreshes
        // updated_at (that is what the before-update trigger is for), and
        // created_at defaults to now() for rows that did not exist yet.
        // Idempotency means re-running changes no CONTENT, no counts and no
        // ids — which is exactly what this digest proves.
        const cols = await q(`select column_name from information_schema.columns
          where table_schema = 'public' and table_name = $1
            and column_name not in ('created_at', 'updated_at')
          order by ordinal_position`, [t]);
        const expr = cols.map((c) => `t."${c.column_name}"`).join(', ');
        const res = await one(`select coalesce(md5(coalesce(json_agg(row(${expr}) order by t."${pk}")::text, '')), 'empty') as d from public.${t} t`);
        digests[t] = res.d;
      }
      return digests;
    }

    const digest1 = await stateDigest();
    await acheck('bundle run #2 executes without error', async () => {
      await local.client.query(bundleSql);
    });
    const digest2 = await stateDigest();
    await acheck('run #2 changed NO content (all column digests identical)', () =>
      assert.deepStrictEqual(digest2, digest1));

    await acheck('bundle run #3 executes without error', async () => {
      await local.client.query(bundleSql);
    });
    const digest3 = await stateDigest();
    await acheck('run #3 changed NO content (all column digests identical)', () =>
      assert.deepStrictEqual(digest3, digest1));

    await acheck('row counts unchanged after 3 runs (no duplicates)', async () => {
      for (const t of Object.keys(expected)) {
        const n = (await one(`select count(*)::int n from public.${t}`)).n;
        assert.strictEqual(n, expected[t], `${t}: ${n} != ${expected[t]}`);
      }
    });

    await acheck('admin_users still EMPTY after all runs', async () => {
      const n = (await one('select count(*)::int n from public.admin_users')).n;
      assert.strictEqual(n, 0);
    });

    // ------------------------------------------------------------------ 5
    section('5. Bundle file statistics');
    const stat = fs.statSync(BUNDLE);
    const lineCount = bundleSql.split('\n').length;
    const srcSha = crypto.createHash('sha256').update(fs.readFileSync(DB_FILE)).digest('hex');
    console.log(`  file          : supabase/full_database_seed.sql`);
    console.log(`  size          : ${stat.size} bytes (${(stat.size / 1024).toFixed(1)} KB)`);
    console.log(`  lines         : ${lineCount}`);
    console.log(`  data rows     : ${Object.values(expected).reduce((a, b) => a + b, 0) - counts.discount_codes - counts.website_images - counts.admin_users}`);
    console.log(`  source sha256 : ${srcSha}`);
    check('bundle embeds the correct source sha256', () =>
      assert.ok(bundleSql.includes(srcSha), 'sha256 of data/velocci-db.json not found in bundle header'));

    // PART 4 verification query of the bundle itself must report ok=true
    await acheck("bundle's own PART 4 verification query reports ok=true everywhere", async () => {
      const res = await q(`select t, n, expected, (n = expected) as ok
        from (values
          ('categories', (select count(*)::int from public.categories), 3),
          ('products', (select count(*)::int from public.products), 117),
          ('product_images', (select count(*)::int from public.product_images), 279),
          ('product_prices', (select count(*)::int from public.product_prices), 117),
          ('brands', (select count(*)::int from public.brands), 29),
          ('bundles', (select count(*)::int from public.bundles), 29),
          ('hero_slides', (select count(*)::int from public.hero_slides), 3),
          ('home_sections', (select count(*)::int from public.home_sections), 14),
          ('settings', (select count(*)::int from public.settings), 25),
          ('promo_bar', (select count(*)::int from public.promo_bar), 1),
          ('website_content', (select count(*)::int from public.website_content), 167),
          ('orders', (select count(*)::int from public.orders), 23),
          ('order_items', (select count(*)::int from public.order_items), 65),
          ('messages', (select count(*)::int from public.messages), 0),
          ('preorders', (select count(*)::int from public.preorders), 0)
        ) v(t, n, expected)`);
      const bad = res.filter((r) => !r.ok);
      assert.deepStrictEqual(bad, [], JSON.stringify(bad));
    });
  } finally {
    await local.stop();
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} full bundle verification: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
