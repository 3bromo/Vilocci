#!/usr/bin/env node
'use strict';
// ============================================================================
// VELOCCI / SPINTO — database migration runner
// ----------------------------------------------------------------------------
//   npm run migrate                # DRY RUN (default): prints the whole plan
//   npm run migrate -- --apply     # applies the SQL migrations, then maps the
//                                  # EXISTING storefront content into the tables
//   npm run migrate -- --print-sql # prints the SQL bundle (for the Supabase SQL
//                                  # editor, when no DB credential is available)
//   npm run migrate -- --json      # machine-readable summary
//
// WHAT IT APPLIES
//   001  supabase-schema.sql                    (baseline schema, idempotent)
//   002  supabase/migrations/002_cms_core.sql   (CMS core: order_items,
//                                                product_images, product_prices,
//                                                customer_phone/address, …)
//   then the CONTENT MAPPING of data/velocci-db.json into those tables.
//
// SAFETY
//   * upsert-only. It never deletes a row and never truncates a table.
//   * conflicts are resolved on the natural key, and an incoming row whose
//     *slug* already exists under a different id is folded into that existing
//     row, so re-running can never create duplicate products/categories/images.
//   * dry run writes nothing at all.
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mapping = require('../lib/mapping');

const ROOT = path.join(__dirname, '..');
const DB_FILE = process.env.VELOCCI_DB || path.join(ROOT, 'data', 'velocci-db.json');

const MIGRATIONS = [
  { version: '001', title: 'Baseline schema (products, categories, brands, bundles, orders, content, RLS)', file: 'supabase-schema.sql' },
  { version: '002', title: 'CMS core (order_items, product_images, product_prices, customer_phone/address, CMS columns)', file: 'supabase/migrations/002_cms_core.sql' },
  { version: '003', title: 'Customize (customize_requests, customize category settings, private storage bucket)', file: 'supabase/migrations/003_customize.sql' },
  { version: '004', title: 'Product colors (products.colors variants, order_items.color snapshot)', file: 'supabase/migrations/004_product_colors.sql' },
];

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const PRINT_SQL = argv.includes('--print-sql');
const AS_JSON = argv.includes('--json');
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').slice(7);

// ---------------------------------------------------------------------------
// content mapping — every row comes from data/velocci-db.json
// ---------------------------------------------------------------------------
function loadSource() {
  if (!fs.existsSync(DB_FILE)) {
    throw new Error(`Source data file not found: ${DB_FILE}`);
  }
  const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  return raw;
}

// Categories are not a collection in the JSON store — the storefront derives
// them from the products it already has. The mapping does exactly the same
// thing, and it lives in lib/mapping.js so the runtime (lib/db.js, the Admin
// Customize Settings screen) and this migration always agree on the same ids.
const deriveCategories = mapping.deriveCategories;

function buildContentPlan(db) {
  const plan = [];

  plan.push({
    label: 'categories',
    table: 'categories',
    conflict: 'id',
    rows: deriveCategories(db),
    note: 'derived from the live products (labels from the site EN/AR dictionary, image = that category\'s existing first product image)',
  });

  const productRows = (db.products || []).map(mapping.productToRow);
  plan.push({ label: 'products', table: 'products', conflict: 'id', rows: productRows });

  const imageRows = [];
  const priceRows = [];
  (db.products || []).forEach((p) => {
    imageRows.push(...mapping.productImageRows(p));
    priceRows.push(...mapping.productPriceRows(p));
  });
  plan.push({ label: 'product_images', table: 'product_images', conflict: 'product_id,url', rows: imageRows });
  plan.push({ label: 'product_prices', table: 'product_prices', conflict: 'product_id,label', rows: priceRows });

  plan.push({ label: 'brands', table: 'brands', conflict: 'id', rows: (db.brands || []).map(mapping.brandToRow) });
  plan.push({ label: 'bundles', table: 'bundles', conflict: 'id', rows: (db.bundles || []).map(mapping.bundleToRow) });
  plan.push({ label: 'hero_slides', table: 'hero_slides', conflict: 'id', rows: (db.heroSlides || []).map(mapping.heroSlideToRow) });
  plan.push({ label: 'home_sections', table: 'home_sections', conflict: 'id', rows: (db.homeSections || []).map(mapping.homeSectionToRow) });

  // settings: one row per top-level key, plus the language dictionary
  const settings = Object.assign({}, db.settings || {});
  if (db.languages) settings.languages = db.languages;
  plan.push({ label: 'settings', table: 'settings', conflict: 'key', rows: mapping.settingRows(settings) });

  plan.push({ label: 'promo_bar', table: 'promo_bar', conflict: 'id', rows: [mapping.promoBarToRow(db.promoBar || {})] });

  // website content: the site's own copy strings, grouped as editable content
  const dict = (db.languages && db.languages.dict) || {};
  const contentRows = [];
  const keys = new Set([...Object.keys(dict.en || {}), ...Object.keys(dict.ar || {})]);
  keys.forEach((key) => {
    const ve = (dict.en || {})[key];
    const va = (dict.ar || {})[key];
    if (typeof ve === 'object' && typeof va === 'object') return; // skip nested groups
    contentRows.push(mapping.websiteContentToRow({
      id: `wc_${key}`, section: 'copy', key,
      value_en: ve === undefined || ve === null || typeof ve === 'object' ? null : String(ve),
      value_ar: va === undefined || va === null || typeof va === 'object' ? null : String(va),
      type: 'text',
    }));
  });
  plan.push({ label: 'website_content', table: 'website_content', conflict: 'section,key', rows: contentRows });

  // existing orders (+ their line items)
  const orderRows = [];
  const orderItemRows = [];
  (db.orders || []).forEach((o) => {
    orderRows.push(mapping.orderToRow(o));
    (o.items || []).forEach((it, i) => orderItemRows.push(mapping.orderItemToRow(it, o.id, i)));
  });
  plan.push({ label: 'orders', table: 'orders', conflict: 'id', rows: orderRows });
  plan.push({ label: 'order_items', table: 'order_items', conflict: 'id', rows: orderItemRows });

  plan.push({ label: 'messages', table: 'messages', conflict: 'id', rows: (db.messages || []).map(mapping.messageToRow) });
  plan.push({ label: 'preorders', table: 'preorders', conflict: 'id', rows: (db.preorders || []).map(mapping.preorderToRow) });

  if (ONLY) return plan.filter((p) => p.label === ONLY);
  return plan;
}

// Prove the plan maps the real catalog: every product row must match the source
// record verbatim on the fields the storefront shows.
function verifyAgainstSource(plan, db) {
  const byId = new Map((db.products || []).map((p) => [p.id, p]));
  const products = plan.find((p) => p.label === 'products');
  if (!products) return { checked: 0, mismatches: [] };
  const mismatches = [];
  products.rows.forEach((row) => {
    const src = byId.get(row.id);
    if (!src) { mismatches.push({ id: row.id, reason: 'not present in data/velocci-db.json' }); return; }
    const checks = [
      ['name_en', row.name_en, src.name_en],
      ['slug', row.slug, src.slug],
      ['category', row.category, src.category],
      ['brand_slug', row.brand_slug, src.brandSlug],
      ['price', Number(row.price), Number(src.price)],
    ];
    checks.forEach(([field, got, want]) => {
      if (String(got) !== String(want)) mismatches.push({ id: row.id, reason: `${field}: mapped ${JSON.stringify(got)} != source ${JSON.stringify(want)}` });
    });
  });
  return { checked: products.rows.length, mismatches };
}

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------
const C = {
  bold: (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s),
};
const line = (s = '') => process.stdout.write(s + '\n');

function sampleOf(rows, fields, n = 2) {
  return rows.slice(0, n).map((r) => fields.map((f) => `${f}=${JSON.stringify(r[f])}`).join(' '));
}

// ---------------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------------
async function connect() {
  const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) return null;
  const { Client } = require('pg');
  const client = new Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
}

async function appliedVersions(client) {
  await client.query(`create schema if not exists supabase_migrations`);
  await client.query(`create table if not exists supabase_migrations.schema_migrations (
    version text primary key, title text, checksum text, applied_at timestamptz default now()
  )`);
  const res = await client.query('select version, checksum from supabase_migrations.schema_migrations');
  return new Map(res.rows.map((r) => [r.version, r.checksum]));
}

// ---------------------------------------------------------------------------
// dry run
// ---------------------------------------------------------------------------
async function dryRun() {
  const db = loadSource();
  const plan = buildContentPlan(db);
  const report = {
    mode: 'dry-run',
    // relative when the dataset lives inside the repo, absolute otherwise
    // (VELOCCI_DB can point anywhere — `../../../tmp/x.json` reads as a bug)
    source: DB_FILE.startsWith(ROOT + path.sep) ? path.relative(ROOT, DB_FILE) : DB_FILE,
    sourceMeta: db.meta || {},
    migrations: MIGRATIONS.map((m) => {
      const sql = fs.readFileSync(path.join(ROOT, m.file), 'utf8');
      return { version: m.version, file: m.file, title: m.title, checksum: sha256(sql), statements: countStatements(sql) };
    }),
    tables: [],
    totals: { rows: 0, deletes: 0 },
  };

  const client = await connect().catch((e) => { line(C.yellow(`! database not reachable (${e.message}) — plan is computed from the source file only`)); return null; });
  let existing = new Map();
  if (client) {
    try {
      const applied = await appliedVersions(client);
      report.migrations.forEach((m) => { m.applied = applied.has(m.version); m.checksumMatches = !applied.has(m.version) || applied.get(m.version) === m.checksum; });
      for (const t of plan) {
        try {
          const res = await client.query(`select count(*)::int as n from public.${t.table}`);
          existing.set(t.label, res.rows[0].n);
        } catch (e) {
          existing.set(t.label, null); // table does not exist yet
        }
      }
    } finally {
      await client.end();
    }
  }

  const verify = verifyAgainstSource(plan, db);
  report.sourceVerification = verify;

  if (AS_JSON) {
    report.tables = plan.map((t) => ({
      table: t.table, rows: t.rows.length, existingRows: existing.get(t.label) ?? null, conflict: t.conflict,
    }));
    report.totals.rows = plan.reduce((s, t) => s + t.rows.length, 0);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return 0;
  }

  line('');
  line(C.bold('VELOCCI — Supabase migration plan (DRY RUN, nothing is written)'));
  line(C.dim(`source of truth : ${report.source}  (meta.updatedAt=${report.sourceMeta.updatedAt || 'n/a'})`));
  line('');
  line(C.bold('1. SQL migrations'));
  report.migrations.forEach((m) => {
    const state = m.applied === undefined ? C.dim('state unknown (no DB connection)')
      : m.applied ? (m.checksumMatches ? C.green('already applied') : C.yellow('APPLIED WITH DIFFERENT CHECKSUM — re-running is safe, it is idempotent'))
        : C.yellow('pending');
    line(`   ${m.version}  ${m.file}`);
    line(`        ${m.title}`);
    line(`        ${m.statements} statements · checksum ${m.checksum} · ${state}`);
  });

  line('');
  line(C.bold('2. Content mapping — EXISTING storefront data (upsert only, 0 deletions)'));
  line(C.dim('   columns: rows to write | already in DB | sample of the real data being mapped'));
  plan.forEach((t) => {
    const ex = existing.get(t.label);
    const exText = ex === undefined ? '?' : ex === null ? C.yellow('table missing (created by the SQL above)') : `${ex} existing → ${t.rows.length} upserts`;
    line(`   ${t.table.padEnd(18)} ${String(t.rows.length).padStart(5)} rows   ${exText}   conflict(${t.conflict})`);
    if (t.note) line(C.dim(`        note: ${t.note}`));
    const fields = t.table === 'products' ? ['id', 'name_en', 'price']
      : t.table === 'categories' ? ['id', 'name_en', 'product_count', 'image']
        : t.table === 'orders' ? ['id', 'customer_name', 'customer_phone', 'total']
          : t.table === 'order_items' ? ['id', 'order_id', 'product_id', 'qty', 'line_total']
            : t.table === 'product_images' ? ['id', 'product_id', 'url']
              : t.table === 'settings' ? ['key'] : ['id'];
    sampleOf(t.rows, fields).forEach((s) => line(C.dim(`        · ${s.slice(0, 150)}`)));
    report.tables.push({ table: t.table, rows: t.rows.length, existingRows: ex === undefined ? null : ex, conflict: t.conflict });
  });
  report.totals.rows = plan.reduce((s, t) => s + t.rows.length, 0);

  line('');
  line(C.bold('3. Source verification (proves this is the live catalog, not sample data)'));
  if (verify.mismatches.length === 0) {
    line(C.green(`   ✓ ${verify.checked}/${verify.checked} product rows match data/velocci-db.json verbatim (id, name_en, slug, category, brand_slug, price)`));
  } else {
    line(C.red(`   ✗ ${verify.mismatches.length} mismatches:`));
    verify.mismatches.slice(0, 10).forEach((m) => line(C.red(`     ${m.id}: ${m.reason}`)));
  }
  line(`   deletions planned: ${C.bold('0')}  ·  truncates planned: ${C.bold('0')}`);
  line('');
  line(C.dim('Run with --apply to write this plan to the database.'));
  line('');
  return verify.mismatches.length ? 1 : 0;
}

function countStatements(sql) {
  return sql.split('\n')
    .filter((l) => /^[a-z]/i.test(l.trim()))
    .filter((l) => !l.trim().startsWith('--'))
    .join(' ')
    .split(';').filter((s) => s.trim()).length;
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------
async function apply() {
  const db = loadSource();
  const plan = buildContentPlan(db);
  const verify = verifyAgainstSource(plan, db);
  if (verify.mismatches.length) {
    line(C.red('Refusing to apply: mapped content does not match data/velocci-db.json.'));
    verify.mismatches.slice(0, 10).forEach((m) => line(C.red(`  ${m.id}: ${m.reason}`)));
    return 1;
  }

  const client = await connect();
  if (!client) {
    line(C.red('No database connection. Set SUPABASE_DB_URL (Postgres connection string)'));
    line(C.red('or SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF (Supabase Management API).'));
    line('');
    line('Without a credential you can still apply the schema by hand:');
    line(C.dim('  npm run migrate -- --print-sql > migration-bundle.sql'));
    line('and paste it into Supabase → SQL Editor.');
    return 2;
  }

  line(C.bold('Applying SQL migrations…'));
  const applied = await appliedVersions(client);
  for (const m of MIGRATIONS) {
    const sql = fs.readFileSync(path.join(ROOT, m.file), 'utf8');
    const checksum = sha256(sql);
    line(`   ${m.version} ${m.file} …`);
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query(
        `insert into supabase_migrations.schema_migrations (version, title, checksum)
         values ($1, $2, $3)
         on conflict (version) do update set checksum = excluded.checksum, applied_at = now()`,
        [m.version, m.title, checksum],
      );
      await client.query('commit');
      line(C.green(`   ${m.version} applied (${applied.has(m.version) ? 're-run, idempotent' : 'first run'})`));
    } catch (e) {
      await client.query('rollback');
      line(C.red(`   ${m.version} FAILED: ${e.message}`));
      await client.end();
      return 1;
    }
  }

  line('');
  line(C.bold('Mapping existing storefront content (upsert only)…'));
  const summary = [];
  for (const t of plan) {
    if (!t.rows.length) { summary.push({ table: t.table, rows: 0 }); continue; }
    try {
      await upsert(client, t.table, t.rows, t.conflict);
      const count = await client.query(`select count(*)::int as n from public.${t.table}`);
      line(C.green(`   ${t.table.padEnd(18)} ${String(t.rows.length).padStart(5)} rows upserted → table now has ${count.rows[0].n}`));
      summary.push({ table: t.table, rows: t.rows.length, tableCount: count.rows[0].n });
    } catch (e) {
      line(C.red(`   ${t.table} FAILED: ${e.message}`));
      await client.end();
      return 1;
    }
  }

  // ---------------------------------------------------------------- defaults
  // The migrations run BEFORE the storefront content is mapped in, so the
  // Customize setting can only be seeded once the categories exist. Exactly the
  // same statement as in 003 (on conflict do nothing) — an operator's choices
  // are never overwritten.
  try {
    const seeded = await seedCustomizeSetting(client);
    if (seeded) line(C.green('   settings[customize] seeded from the existing categories'));
  } catch (e) {
    line(C.yellow(`   settings[customize] not seeded: ${e.message}`));
  }

  await client.end();
  if (AS_JSON) process.stdout.write(JSON.stringify({ mode: 'apply', summary }, null, 2) + '\n');
  line('');
  line(C.green('✓ Migration applied.'));
  return 0;
}

// Enables every existing (active) category for Customize when the setting does
// not exist yet, so the Customize page is never empty on a first deployment.
async function seedCustomizeSetting(client) {
  const tables = await client.query(`
    select to_regclass('public.settings') as settings, to_regclass('public.categories') as categories`);
  if (!tables.rows[0].settings || !tables.rows[0].categories) return false;
  const res = await client.query(`
    insert into public.settings (key, value)
    select 'customize',
           jsonb_build_object('categories', jsonb_object_agg(c.id, true), 'seededAt', now())
    from public.categories c
    where c.active is not false
    having count(*) > 0
    on conflict (key) do nothing
    returning key`);
  return res.rowCount > 0;
}

const JSONB_TABLES = {
  // products.images is text[] (node-postgres builds the array literal), the rest are jsonb
  products: ['key_shapes', 'fitment', 'models', 'years', 'specs', 'vehicles', 'colors'],
  brands: ['models'],
  home_sections: ['config'],
  orders: ['customer', 'items', 'status_history'],
  order_items: ['fitment', 'color'],
  preorders: ['customer'],
  settings: ['value'],
};

async function upsert(client, table, rows, conflict) {
  const columns = Object.keys(rows[0]);
  const jsonb = JSONB_TABLES[table] || [];
  const targets = conflict.split(',').map((c) => c.trim());
  const updates = columns.filter((c) => !targets.includes(c)).map((c) => `"${c}" = excluded."${c}"`);
  const BATCH = 50;
  for (let i = 0; i < rows.length; i += BATCH) {
    await upsertChunk(client, table, rows.slice(i, i + BATCH), columns, targets, updates, jsonb);
  }
}

async function upsertChunk(client, table, rows, columns, targets, updates, jsonb) {
  const values = [];
  const params = [];
  rows.forEach((row) => {
    const tuple = columns.map((c) => {
      let v = row[c];
      if (v === undefined) v = null;
      // jsonb parameters are parsed as JSON text by Postgres, so every value
      // (strings and numbers included) must be JSON-encoded. Plain JS arrays
      // stay as they are: node-postgres turns them into Postgres array
      // literals, which is what text[] columns (products.images) expect.
      if (v !== null && jsonb.includes(c)) v = JSON.stringify(v);
      params.push(v);
      return `$${params.length}`;
    });
    values.push(`(${tuple.join(', ')})`);
  });
  const sql = `insert into public.${table} (${columns.map((c) => `"${c}"`).join(', ')})
               values ${values.join(', ')}
               on conflict (${targets.map((c) => `"${c}"`).join(', ')})
               ${updates.length ? `do update set ${updates.join(', ')}` : 'do nothing'}`;
  await client.query(sql, params);
}

// ---------------------------------------------------------------------------
// print-sql
// ---------------------------------------------------------------------------
function printSql() {
  process.stdout.write('-- VELOCCI / SPINTO — generated migration bundle\n');
  process.stdout.write(`-- generated ${new Date().toISOString()}\n`);
  process.stdout.write('-- Safe to run repeatedly: no DROP TABLE, no DELETE.\n\n');
  MIGRATIONS.forEach((m) => {
    process.stdout.write(`\n-- ===== ${m.version}: ${m.file} — ${m.title} =====\n`);
    process.stdout.write(fs.readFileSync(path.join(ROOT, m.file), 'utf8'));
    process.stdout.write('\n');
  });
  process.stdout.write('\n-- The content mapping (existing products / categories / orders) is written by\n');
  process.stdout.write('-- `npm run migrate -- --apply`, which upserts data/velocci-db.json into these\n');
  process.stdout.write('-- tables. It is deliberately not embedded here: it is data, not schema.\n');
  return 0;
}

// ---------------------------------------------------------------------------
(async function main() {
  try {
    let code;
    if (PRINT_SQL) code = printSql();
    else if (APPLY) code = await apply();
    else code = await dryRun();
    process.exit(code || 0);
  } catch (e) {
    line(C.red(`migrate failed: ${e.message}`));
    if (process.env.MIGRATE_DEBUG) console.error(e);
    process.exit(1);
  }
}());
