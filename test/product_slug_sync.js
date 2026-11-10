'use strict';
// ============================================================================
// Product slug synchronisation — the `23505 … products_slug_key` fix
// ----------------------------------------------------------------------------
// Production reported:
//   upsert products: 23505: duplicate key value violates unique constraint
//   "products_slug_key"
// and, right after it, the admin dashboard switched to the bundled JSON backup.
//
// Two things went wrong, and this file checks both:
//   1. a product save could INSERT a row whose slug already belonged to another
//      product (the upsert matches on `id`, so a new id + an existing slug is
//      an INSERT), and
//   2. that rejected record was treated as a database OUTAGE, which flipped the
//      whole store to the JSON backup for 60s — so one bad slug looked like
//      "the dashboard is showing backup data".
//
// It runs three layers:
//   A. the pure rules in lib/mapping.js,
//   B. the JSON store driver (real file, real reload),
//   C. the PostgREST driver against a local fake Supabase REST endpoint that
//      enforces `products.slug UNIQUE` exactly like Postgres does — so the real
//      23505 path is exercised without touching any real database.
//
// Usage: npm run test:slugs
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const mapping = require('../lib/mapping');

let pass = 0; let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓', name); }
  else { fail += 1; console.log('  ✗', name, extra === undefined ? '' : extra); }
}
const section = (t) => console.log(`\n${t}`);

const ROOT = path.join(__dirname, '..');
const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spinto-slug-'));
const SCRATCH_DB = path.join(SCRATCH_DIR, 'velocci-db.json');
fs.copyFileSync(path.join(ROOT, 'data', 'velocci-db.json'), SCRATCH_DB);

// lib/db.js reads its environment at require() time, so every scenario loads a
// fresh copy of the module (and of everything under lib/).
function loadDb(env) {
  for (const key of Object.keys(process.env)) {
    if (/^(VITE_SUPABASE_URL|VITE_SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_DB_URL|DATABASE_URL|POSTGRES_URL|DATA_DRIVER|VELOCCI_DB)$/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, { VELOCCI_DB: SCRATCH_DB }, env);
  for (const id of Object.keys(require.cache)) {
    if (id.includes(`${path.sep}lib${path.sep}`)) delete require.cache[id];
  }
  return require('../lib/db');
}

// console noise from lib/db.js ("driver unavailable", slug changes) is expected.
async function quiet(fn) {
  const { log, warn, error } = console;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.warn = warn; console.error = error; }
}

// ---------------------------------------------------------------------------
// A tiny PostgREST-compatible endpoint over an in-memory table set.
// It enforces the ONE rule this bug is about: products.slug is UNIQUE.
// ---------------------------------------------------------------------------
function startFakeSupabase(seed) {
  const tables = JSON.parse(JSON.stringify(seed));
  for (const t of ['products', 'categories', 'brands', 'bundles', 'hero_slides', 'home_sections',
    'settings', 'promo_bar', 'key_shapes', 'product_images', 'product_prices', 'orders',
    'order_items', 'preorders', 'messages', 'website_content', 'website_images',
    'discount_codes', 'customize_requests']) {
    if (!Array.isArray(tables[t])) tables[t] = [];
  }
  const stats = { requests: 0, upserts: 0, conflicts: 0 };

  const json = (res, status, body, extraHeaders) => {
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}));
    res.end(JSON.stringify(body === undefined ? null : body));
  };

  // Minimal filter support: ?col=eq.value (repeated) and ?col=in.(a,b)
  function matches(row, params) {
    for (const [key, raw] of params) {
      if (['select', 'order', 'on_conflict', 'limit', 'offset', 'columns'].includes(key)) continue;
      if (raw.startsWith('eq.')) {
        if (String(row[key]) !== raw.slice(3)) return false;
      } else if (raw.startsWith('in.(')) {
        const list = raw.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, ''));
        if (!list.includes(String(row[key]))) return false;
      }
    }
    return true;
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      stats.requests += 1;
      const url = new URL(req.url, 'http://127.0.0.1');
      const table = url.pathname.replace(/^\/rest\/v1\//, '');
      const params = Array.from(url.searchParams.entries());
      const rows = tables[table];
      if (!rows) return json(res, 404, { code: 'PGRST205', message: `Could not find the table 'public.${table}'` });

      if (req.method === 'GET') {
        let out = rows.filter((r) => matches(r, params));
        const order = url.searchParams.get('order');
        if (order) {
          const [col, dir] = order.split('.');
          out = out.slice().sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
        }
        return json(res, 200, out);
      }

      if (req.method === 'POST' || req.method === 'PATCH') {
        const body = raw ? JSON.parse(raw) : [];
        const incoming = Array.isArray(body) ? body : [body];
        const prefer = String(req.headers.prefer || '');
        const onConflict = (url.searchParams.get('on_conflict') || (Array.isArray(body[0]) ? '' : 'id'))
          .split(',').map((s) => s.trim()).filter(Boolean);
        const out = [];
        for (const row of incoming) {
          // unique(products.slug) — the exact constraint that failed in production
          if (table === 'products' && row.slug !== undefined && row.slug !== null) {
            const clash = rows.find((r) => r.slug === row.slug && r.id !== row.id);
            if (clash) {
              stats.conflicts += 1;
              return json(res, 409, {
                code: '23505',
                details: `Key (slug)=(${row.slug}) already exists.`,
                hint: null,
                message: 'duplicate key value violates unique constraint "products_slug_key"',
              });
            }
          }
          const idx = onConflict.length
            ? rows.findIndex((r) => onConflict.every((k) => r[k] === row[k]))
            : -1;
          if (idx >= 0 && /merge-duplicates|resolution=merge/i.test(prefer)) {
            rows[idx] = Object.assign({}, rows[idx], row);
            out.push(rows[idx]);
          } else if (idx >= 0) {
            rows[idx] = Object.assign({}, rows[idx], row);
            out.push(rows[idx]);
          } else {
            const inserted = Object.assign({}, row);
            rows.push(inserted);
            out.push(inserted);
          }
        }
        stats.upserts += incoming.length;
        return json(res, 201, out, { 'Content-Range': `0-${Math.max(out.length - 1, 0)}/${out.length}` });
      }

      if (req.method === 'DELETE') {
        const keep = rows.filter((r) => !matches(r, params));
        const deleted = rows.length - keep.length;
        rows.length = 0;
        keep.forEach((r) => rows.push(r));
        return json(res, 204, null);
      }
      return json(res, 405, { message: 'method not allowed' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        tables,
        stats,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const backup = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'velocci-db.json'), 'utf8'));
const FIRST = backup.products[0];
const SECOND = backup.products[1];

(async function main() {
  // ======================================================================== A
  section('A. slug rules (lib/mapping.js)');
  check('slugify lowercases and hyphenates', mapping.slugify('Audi Key Case (2024)') === 'audi-key-case-2024',
    mapping.slugify('Audi Key Case (2024)'));
  check('slugify strips accents', mapping.slugify('Citroën Élégance') === 'citroen-elegance', mapping.slugify('Citroën Élégance'));
  check('slugify never returns an empty leading/trailing hyphen', mapping.slugify('  --Key Case--  ') === 'key-case',
    mapping.slugify('  --Key Case--  '));

  const existing = [
    { id: 'p_a', slug: 'audi-key-case', name_en: 'Audi Key Case' },
    { id: 'p_b', slug: 'bmw-key-case', name_en: 'BMW Key Case' },
  ];
  check('a new product with a free slug keeps it',
    mapping.planProductSlug({ id: 'p_new', slug: 'kia-key-case', name: 'Kia Key Case', existing }).slug === 'kia-key-case');
  check('a new product cannot take an existing product\'s slug',
    (() => { try { mapping.planProductSlug({ id: 'p_new', slug: 'audi-key-case', name: 'x', existing }); return false; } catch (e) { return e.code === 'DUPLICATE_SLUG' && e.existingId === 'p_a'; } })());
  check('the duplicate message names the owner and suggests a free slug',
    (() => {
      try { mapping.planProductSlug({ id: 'p_new', slug: 'audi-key-case', name: 'x', existing }); return false; } catch (e) {
        return /already used by the product "Audi Key Case" \(id: p_a\)/.test(e.message) && e.suggestion === 'audi-key-case-2';
      }
    })());
  check('an edit that keeps its slug is untouched',
    mapping.planProductSlug({ id: 'p_a', slug: 'audi-key-case', name: 'Audi', existing }).action === 'unchanged');
  check('an edit with an empty slug keeps the stored URL',
    mapping.planProductSlug({ id: 'p_a', slug: '', name: 'Audi', existing }).slug === 'audi-key-case');
  check('an edit cannot steal another product\'s slug',
    (() => { try { mapping.planProductSlug({ id: 'p_a', slug: 'bmw-key-case', name: 'Audi', existing }); return false; } catch (e) { return e.code === 'DUPLICATE_SLUG'; } })());
  check('a deliberate rename to a free slug is allowed',
    mapping.planProductSlug({ id: 'p_a', slug: 'audi-key-case-v2', name: 'Audi', existing }).action === 'changed');
  check('a create without a slug generates a unique one',
    mapping.planProductSlug({ id: 'p_new', slug: '', name: 'Audi Key Case', existing }).slug === 'audi-key-case-2');
  check('uniqueSlug walks past every taken suffix',
    mapping.uniqueSlug('x', ['x', 'x-2', 'x-3']) === 'x-4', mapping.uniqueSlug('x', ['x', 'x-2', 'x-3']));
  check('a slug that only differs by case/spaces still collides',
    (() => { try { mapping.planProductSlug({ id: 'p_new', slug: 'Audi Key Case', name: 'x', existing }); return false; } catch (e) { return e.code === 'DUPLICATE_SLUG'; } })());

  // ======================================================================== B
  section('B. JSON store driver (real file, real reload)');
  {
    const db = loadDb({});
    const before = (await db.getCatalog()).products.length;
    const created = await db.saveRecord('products', Object.assign({}, FIRST, {
      id: 'p_qa_slug_create', slug: 'qa-slug-create', name_en: 'QA Slug Create', price: 111,
    }));
    check('a product with a free slug saves', created.slug === 'qa-slug-create', created.slug);
    check('the catalogue grew by exactly one', (await db.getCatalog()).products.length === before + 1);

    // re-saving the SAME record must UPDATE, never insert a second row
    await db.saveRecord('products', Object.assign({}, FIRST, {
      id: 'p_qa_slug_create', slug: 'qa-slug-create', name_en: 'QA Slug Create', price: 222,
    }));
    const afterEdit = (await db.getCatalog()).products.filter((p) => p.id === 'p_qa_slug_create');
    check('re-saving the same id updates in place (no duplicate record)', afterEdit.length === 1, `rows=${afterEdit.length}`);
    check('the edit is what is read back', afterEdit[0].price === 222, afterEdit[0].price);

    let dupErr = null;
    try {
      await db.saveRecord('products', Object.assign({}, SECOND, {
        id: 'p_qa_slug_duplicate', slug: FIRST.slug, name_en: 'QA Duplicate',
      }));
    } catch (e) { dupErr = e; }
    check('creating a product with an existing slug is refused', !!(dupErr && dupErr.code === 'DUPLICATE_SLUG'), dupErr && dupErr.code);
    check('the refusal names the slug', !!(dupErr && dupErr.message.includes(FIRST.slug)), dupErr && dupErr.message);
    check('nothing was written when it was refused',
      !(await db.getCatalog()).products.some((p) => p.id === 'p_qa_slug_duplicate'));

    const auto = await db.saveRecord('products', Object.assign({}, FIRST, {
      id: 'p_qa_slug_auto', slug: '', name_en: FIRST.name_en,
    }));
    check('a blank slug is generated into a free one', auto.slug && auto.slug !== FIRST.slug, auto.slug);
    check('the generated slug is unique', (await db.getCatalog()).products.filter((p) => p.slug === auto.slug).length === 1);

    await db.patchRecord('products', 'p_qa_slug_create', { active: false });
    const patched = (await db.getCatalog()).products.find((p) => p.id === 'p_qa_slug_create');
    check('a partial update keeps the id and the slug', patched.id === 'p_qa_slug_create' && patched.slug === 'qa-slug-create',
      JSON.stringify({ id: patched.id, slug: patched.slug }));
    check('a partial update keeps the fields it does not touch', patched.price === 222, patched.price);

    // persist across a fresh module load (the "refresh the dashboard" case)
    const reloaded = loadDb({});
    const persisted = (await reloaded.getCatalog()).products.find((p) => p.id === 'p_qa_slug_create');
    check('saved changes survive a reload of the store', !!persisted && persisted.slug === 'qa-slug-create' && persisted.price === 222,
      JSON.stringify(persisted && { slug: persisted.slug, price: persisted.price }));

    const report = await reloaded.productSlugReport();
    check('the slug report is read-only and finds no duplicate slugs', report.readOnly === true && report.duplicateSlugs.length === 0,
      JSON.stringify(report.duplicateSlugs));
    await quiet(() => reloaded.close());
  }

  // ======================================================================== C
  section('C. PostgREST driver against a fake Supabase (real 23505 path)');
  {
    // Restore the scratch store so "backup" numbers stay predictable.
    fs.copyFileSync(path.join(ROOT, 'data', 'velocci-db.json'), SCRATCH_DB);
    const seedProducts = [
      {
        id: 'p_audi_case', name_en: 'VELOCE Key Case — Audi', name_ar: null, slug: 'audi-key-case',
        category: 'keycase', brand_slug: 'audi', description_en: null, description_ar: null,
        short_en: null, short_ar: null, material_en: null, material_ar: null, price: 1000,
        sale_price: null, old_price: null, discount_pct: 0, active: true, featured: false,
        new_arrival: false, hero_product: false, best_seller: false, limited_edition: false,
        preorder: false, out_of_stock: false, stock: 5, sku: null, key_shapes: [], images: [],
        main_image: null, fitment: {}, order: 1, warranty_en: null, warranty_ar: null,
        badge_en: null, badge_ar: null, models: [], years: [], specs: [], vehicles: [], colors: [],
      },
      {
        id: 'p_bmw_case', name_en: 'VELOCE Key Case — BMW', name_ar: null, slug: 'bmw-key-case',
        category: 'keycase', brand_slug: 'bmw', description_en: null, description_ar: null,
        short_en: null, short_ar: null, material_en: null, material_ar: null, price: 1200,
        sale_price: null, old_price: null, discount_pct: 0, active: true, featured: false,
        new_arrival: false, hero_product: false, best_seller: false, limited_edition: false,
        preorder: false, out_of_stock: false, stock: 4, sku: null, key_shapes: [], images: [],
        main_image: null, fitment: {}, order: 2, warranty_en: null, warranty_ar: null,
        badge_en: null, badge_ar: null, models: [], years: [], specs: [], vehicles: [], colors: [],
      },
    ];
    const fake = await startFakeSupabase({ products: seedProducts });
    // lib/db.js sanitizes VITE_SUPABASE_URL down to protocol + hostname (the
    // production project URL never carries a port), so the fake listens on a
    // random port and this shim re-points the hostname at it. Nothing outside
    // the test process is affected.
    const realFetch = global.fetch;
    global.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.startsWith('http://supabase.test')) {
        return realFetch(fake.url + url.slice('http://supabase.test'.length), init);
      }
      return realFetch(input, init);
    };
    const db = loadDb({ VITE_SUPABASE_URL: 'http://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'local-fake-service-key' });
    check('the postgrest driver is the one in use', db.DRIVER === 'postgrest', db.DRIVER);

    const catalog = await quiet(() => db.getCatalog());
    check('products load from the (fake) live database', catalog.products.length === 2,
      `got ${catalog.products.length}`);
    check('nothing is being served from the backup', db.health().usingJsonFallback === false,
      JSON.stringify(db.health()));

    // --- TEST: edit an existing product (its own slug) ---------------------
    const edited = await quiet(() => db.patchRecord('products', 'p_audi_case', { price: 1500 }));
    check('editing an existing product saves', edited && edited.price === 1500, JSON.stringify(edited && edited.slug));
    check('editing it created no second row', fake.tables.products.length === 2, `rows=${fake.tables.products.length}`);
    check('its id and slug are unchanged', fake.tables.products[0].id === 'p_audi_case' && fake.tables.products[0].slug === 'audi-key-case');

    // --- TEST: create a new product with its own slug ----------------------
    await quiet(() => db.saveRecord('products', Object.assign({}, mapping.rowToProduct(seedProducts[1]), {
      id: 'p_kia_case', slug: 'kia-key-case', name_en: 'VELOCE Key Case — Kia', brandSlug: 'kia', price: 900,
    })));
    check('a new product with a free slug is inserted once', fake.tables.products.length === 3,
      `rows=${fake.tables.products.length}`);
    check('the new row keeps its slug', fake.tables.products.some((r) => r.id === 'p_kia_case' && r.slug === 'kia-key-case'));

    // --- TEST: duplicate slug is refused, clearly, WITHOUT the fallback ----
    let dup = null;
    try {
      await quiet(() => db.saveRecord('products', Object.assign({}, mapping.rowToProduct(seedProducts[1]), {
        id: 'p_dup_case', slug: 'audi-key-case', name_en: 'VELOCE Key Case — Copy', brandSlug: 'audi',
      })));
    } catch (e) { dup = e; }
    check('a duplicate slug is refused before it reaches Postgres',
      !!(dup && dup.code === 'DUPLICATE_SLUG'), dup && (dup.code + ': ' + dup.message));
    check('the message is written for an admin, not a raw SQL code',
      !!(dup && /already used by the product/.test(dup.message) && !/^upsert products: 23505/.test(dup.message)),
      dup && dup.message);
    check('the message offers a free alternative', !!(dup && dup.suggestion === 'audi-key-case-2'), dup && dup.suggestion);
    check('no row was written for the refused product', fake.tables.products.length === 3, `rows=${fake.tables.products.length}`);
    check('the refused save did NOT flip the app to the backup JSON',
      db.health().usingJsonFallback === false && db.health().activeDriver === 'postgrest',
      JSON.stringify(db.health()));
    check('the admin payload still comes from the live database',
      (await quiet(() => db.getAdminData())).products.length === 3);

    // --- TEST: slug rename onto another product is refused ------------------
    let rename = null;
    try { await quiet(() => db.patchRecord('products', 'p_bmw_case', { slug: 'kia-key-case' })); } catch (e) { rename = e; }
    check('renaming a product onto another product\'s slug is refused',
      !!(rename && rename.code === 'DUPLICATE_SLUG'), rename && rename.code);
    check('the other product was not modified', fake.tables.products.find((r) => r.id === 'p_bmw_case').slug === 'bmw-key-case' &&
      fake.tables.products.find((r) => r.id === 'p_kia_case').slug === 'kia-key-case');
    check('still no fallback after that refusal', db.health().usingJsonFallback === false);

    // --- TEST: a deliberate rename to a free slug is allowed ---------------
    await quiet(() => db.patchRecord('products', 'p_bmw_case', { slug: 'bmw-key-case-v2' }));
    check('a rename to a free slug is applied to the same record',
      fake.tables.products.find((r) => r.id === 'p_bmw_case').slug === 'bmw-key-case-v2');
    check('the rename did not create a row', fake.tables.products.length === 3, `rows=${fake.tables.products.length}`);

    // --- TEST: a fully raw duplicate still surfaces safely ------------------
    // Bypass the pre-flight check the way a concurrent save would, by writing
    // straight through upsertRows: the driver must convert the 23505 into the
    // same clear error and never into an outage.
    let raw = null;
    try {
      await quiet(() => db.upsertRows('products', [{ id: 'p_raw_dup', name_en: 'Raw', category: 'keycase', brand_slug: 'audi', slug: 'audi-key-case' }], 'id'));
    } catch (e) { raw = e; }
    check('the driver still reports the raw conflict with its code', !!(raw && /23505|duplicate key/i.test(raw.message)),
      raw && raw.message);
    check('the direct 23505 did not flip the store to JSON', db.health().usingJsonFallback === false);

    const report = await quiet(() => db.productSlugReport());
    check('the read-only slug report sees no duplicates and no blank slugs',
      report.duplicateSlugs.length === 0 && report.blankSlugs.length === 0 && report.total === 3,
      JSON.stringify(report));

    // --- TEST: outage => writes refused, backup never written over prod -----
    await quiet(() => fake.close());
    let outage = null;
    try { await quiet(() => db.saveRecord('products', Object.assign({}, mapping.rowToProduct(seedProducts[0]), { price: 1 }))); } catch (e) { outage = e; }
    check('an unreachable database refuses the write with DB_UNAVAILABLE',
      !!(outage && outage.code === 'DB_UNAVAILABLE'), outage && outage.code);
    check('the outage message says nothing was saved and nothing was overwritten',
      !!(outage && /NOT saved/.test(outage.message) && /no backup record was written over production/.test(outage.message)),
      outage && outage.message);
    const disk = JSON.parse(fs.readFileSync(SCRATCH_DB, 'utf8'));
    const diskOriginal = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'velocci-db.json'), 'utf8'));
    check('the bundled backup file was not modified by the refused admin writes',
      JSON.stringify(disk.products) === JSON.stringify(diskOriginal.products));
    await quiet(() => db.close());
    global.fetch = realFetch;
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('slug sync test crashed:', e); process.exit(1); });
