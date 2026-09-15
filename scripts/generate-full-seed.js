#!/usr/bin/env node
'use strict';
// ============================================================================
// VELOCCI / SPINTO — full database seed bundle generator
// ----------------------------------------------------------------------------
//   node scripts/generate-full-seed.js
//
// Writes supabase/full_database_seed.sql — ONE self-contained bundle that a
// Supabase project can run in the SQL Editor to get the entire database:
//
//   PART 1  migration 001 (supabase-schema.sql)                — verbatim
//   PART 2  migration 002 (supabase/migrations/002_cms_core.sql) — verbatim
//   PART 3  every row of data/velocci-db.json, as upsert-only INSERTs
//   PART 4  verification queries (row counts vs. expected)
//
// NOTHING IS TYPED BY HAND. All data rows are produced by the exact same
// buildContentPlan() / lib/mapping.js code path that `npm run migrate
// --apply` uses, so the bundle and the live migration cannot drift apart.
//
// SAFETY PROPERTIES (asserted by test/full_bundle.js):
//   * idempotent   — every INSERT is ON CONFLICT … DO UPDATE; the schema parts
//                    use IF NOT EXISTS / CREATE OR REPLACE / drop-then-create.
//                    Running the bundle twice (or ten times) is a no-op.
//   * non-destructive — no DROP TABLE, no TRUNCATE, no DELETE anywhere.
//   * admin_users  — the table + RLS are created by PART 1, but NO admin row
//                    is inserted. The optional linking statement is included
//                    fully commented out and must never be uncommented by an
//                    automated tool (see supabase-admin-setup.sql instead).
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadSource, buildContentPlan, verifyAgainstSource, MIGRATIONS, DB_FILE, ROOT } = require('./migrate');

const OUT_FILE = path.join(ROOT, 'supabase', 'full_database_seed.sql');

// ---------------------------------------------------------------------------
// Column type registry — mirrors supabase-schema.sql (001) and
// supabase/migrations/002_cms_core.sql (002). A column listed here gets the
// matching SQL literal rendering; anything unknown is rendered as text.
// ---------------------------------------------------------------------------
const TYPES = {
  products: {
    numeric: ['price', 'sale_price', 'old_price', 'discount_pct', 'order'],
    integer: ['stock'],
    boolean: ['active', 'featured', 'new_arrival', 'hero_product', 'best_seller', 'limited_edition', 'preorder', 'out_of_stock'],
    jsonb: ['key_shapes', 'fitment', 'models', 'years', 'specs', 'vehicles'],
    textarray: ['images'],
  },
  categories: {
    integer: ['product_count', 'order'],
    boolean: ['active'],
  },
  brands: {
    integer: ['product_count', 'order'],
    boolean: ['active'],
    jsonb: ['models'],
  },
  bundles: {
    numeric: ['bundle_price', 'normal_total', 'order', 'discount', 'discount_percent', 'discount_amount'],
    boolean: ['active'],
    timestamptz: ['start_date', 'end_date'],
  },
  hero_slides: {
    integer: ['order'],
    boolean: ['active'],
  },
  home_sections: {
    integer: ['order'],
    boolean: ['enabled'],
    jsonb: ['config'],
  },
  orders: {
    numeric: ['subtotal', 'bundle_discount', 'delivery_fee', 'total'],
    jsonb: ['customer', 'items', 'status_history'],
    timestamptz: ['created_at'],
  },
  order_items: {
    integer: ['qty'],
    numeric: ['unit_price', 'line_total'],
    jsonb: ['fitment'],
  },
  product_images: {
    integer: ['position'],
    boolean: ['is_main'],
  },
  product_prices: {
    numeric: ['price', 'sale_price', 'old_price', 'discount_pct'],
    integer: ['order'],
    boolean: ['active'],
  },
  settings: {
    jsonb: ['value'],
  },
  promo_bar: {
    boolean: ['enabled'],
    timestamptz: ['end_time'],
  },
  messages: {
    boolean: ['is_read', 'is_resolved'],
    timestamptz: ['created_at'],
  },
  preorders: {
    jsonb: ['customer'],
    timestamptz: ['created_at'],
  },
  discount_codes: {
    numeric: ['value', 'min_order'],
    integer: ['max_uses', 'used_count'],
    boolean: ['active'],
    timestamptz: ['expires_at'],
  },
};

// ---------------------------------------------------------------------------
// SQL literal rendering
// ---------------------------------------------------------------------------

// Dollar-quoted string literal: no escaping needed at all, which makes it
// impossible to corrupt Arabic text, quotes, backslashes or newlines. A tag
// collision with the content itself is ruled out by picking a fresh tag.
function dollarQuote(s) {
  const str = String(s);
  let n = 0;
  let tag = '$q$';
  while (str.includes(tag)) {
    n += 1;
    tag = `$q${n}$`;
  }
  return tag + str + tag;
}

function colType(table, column) {
  const t = TYPES[table] || {};
  for (const kind of Object.keys(t)) {
    if (t[kind].includes(column)) return kind;
  }
  return 'text';
}

function sqlValue(table, column, value) {
  if (value === undefined || value === null) return 'NULL';
  const type = colType(table, column);
  switch (type) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'integer':
      return String(Math.trunc(Number(value)));
    case 'numeric':
      return JSON.stringify(Number(value));
    case 'jsonb':
      return dollarQuote(JSON.stringify(value)) + '::jsonb';
    case 'textarray': {
      const items = Array.isArray(value) ? value : [];
      if (!items.length) return "array[]::text[]";
      return 'array[' + items.map((v) => dollarQuote(String(v))).join(', ') + ']::text[]';
    }
    case 'timestamptz':
      return dollarQuote(String(value)) + '::timestamptz';
    case 'text':
    default:
      return dollarQuote(String(value));
  }
}

// ---------------------------------------------------------------------------
// INSERT rendering — same conflict targets and update semantics as
// scripts/migrate.js upsert(), so the bundle behaves exactly like --apply.
// ---------------------------------------------------------------------------
function insertStatements(tableEntry) {
  const { table, conflict, rows } = tableEntry;
  if (!rows.length) {
    return [`-- (${table}: no rows in data/velocci-db.json — nothing to insert)`];
  }
  const columns = Object.keys(rows[0]);
  const targets = conflict.split(',').map((c) => c.trim());
  const updates = columns.filter((c) => !targets.includes(c)).map((c) => `"${c}" = excluded."${c}"`);
  const conflictSql = targets.map((c) => `"${c}"`).join(', ');
  const BATCH = table === 'products' ? 10 : 25;
  const out = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const valuesSql = chunk.map((row) =>
      '  (' + columns.map((c) => sqlValue(table, c, row[c])).join(', ') + ')').join(',\n');
    out.push(
      `insert into public.${table} (${columns.map((c) => `"${c}"`).join(', ')})\nvalues\n${valuesSql}\non conflict (${conflictSql}) do update set\n  ${updates.join(',\n  ')};`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// bundle assembly
// ---------------------------------------------------------------------------
function generate() {
  const db = loadSource();
  const plan = buildContentPlan(db);

  // Refuse to generate a bundle that does not match the source of truth.
  const verify = verifyAgainstSource(plan, db);
  if (verify.mismatches.length) {
    console.error('Refusing to generate: mapped content does not match data/velocci-db.json.');
    verify.mismatches.slice(0, 10).forEach((m) => console.error(`  ${m.id}: ${m.reason}`));
    process.exit(1);
  }

  const sourceBytes = fs.readFileSync(DB_FILE);
  const sourceSha = crypto.createHash('sha256').update(sourceBytes).digest('hex');
  const totalRows = plan.reduce((s, t) => s + t.rows.length, 0);

  const parts = [];

  parts.push(`-- ============================================================================
-- VELOCCI / SPINTO — FULL DATABASE SEED BUNDLE (complete schema + all data)
-- ----------------------------------------------------------------------------
-- Generated by scripts/generate-full-seed.js — do not edit by hand; re-run
-- the generator after any change to the schema files or the source data.
--
-- Source of truth : data/velocci-db.json
--                    sha256 ${sourceSha}
--                    meta.updatedAt = ${(db.meta && db.meta.updatedAt) || 'n/a'}
-- Migrations      : ${MIGRATIONS.map((m) => `${m.version} ${m.file}`).join(' + ')} (embedded verbatim)
-- Data rows       : ${totalRows} rows across ${plan.filter((t) => t.rows.length).length} tables (upsert-only)
--
-- HOW TO RUN
--   Supabase Dashboard -> SQL Editor -> paste this whole file -> Run.
--   (psql works too: psql "$SUPABASE_DB_URL" -f supabase/full_database_seed.sql)
--
-- SAFETY
--   * Idempotent: every INSERT is ON CONFLICT ... DO UPDATE and every schema
--     object uses IF NOT EXISTS / CREATE OR REPLACE / drop-then-create.
--     Running this file any number of times never duplicates a row, never
--     loses or alters content — a re-run converges to exactly this data set
--     (like \`npm run migrate -- --apply\`). The only side effect of a re-run
--     is the updated_at bookkeeping column refreshed by the before-update
--     trigger on rows that are re-upserted.
--   * Non-destructive: no DROP TABLE, no TRUNCATE, no DELETE anywhere.
--   * admin_users: table + RLS are created by PART 1, but this bundle
--     inserts NO admin row and never touches an existing admin account.
--     The optional linking statement is included commented out at the end
--     and must stay that way (see supabase-admin-setup.sql).
-- ============================================================================
`);

  // ---- PART 1 + PART 2: schema migrations, verbatim ------------------------
  MIGRATIONS.forEach((m, idx) => {
    const sql = fs.readFileSync(path.join(ROOT, m.file), 'utf8');
    parts.push(`
-- ============================================================================
-- PART ${idx + 1}: MIGRATION ${m.version} — ${m.file}
-- ${m.title}
-- (embedded VERBATIM — the canonical copy lives at the path above)
-- ============================================================================

${sql.replace(/\s+$/, '')}
`);
  });

  // ---- PART 3: data ---------------------------------------------------------
  const dataLines = [];
  dataLines.push(`-- ============================================================================
-- PART 3: DATA — every row of data/velocci-db.json (upsert-only)
-- ----------------------------------------------------------------------------
-- ${totalRows} rows. Generated from the source file by the same mapping code
-- that \`npm run migrate -- --apply\` uses; nothing was typed by hand.
-- Re-running is a no-op: conflicts resolve on the natural keys.
-- ============================================================================

begin;`);

  plan.forEach((t) => {
    dataLines.push(`
-- ---- ${t.table}: ${t.rows.length} rows (conflict on ${t.conflict})${t.note ? `\n--      note: ${t.note}` : ''}`);
    insertStatements(t).forEach((stmt) => dataLines.push(stmt));
  });

  dataLines.push('commit;');
  parts.push(dataLines.join('\n'));

  // ---- admin_users (deliberately inert) ------------------------------------
  parts.push(`
-- ============================================================================
-- ADMIN USERS — deliberately NOT seeded by this bundle
-- ----------------------------------------------------------------------------
-- The admin_users table, its RLS policies and public.is_admin() come from
-- PART 1 above. This bundle inserts NO row into it and never touches an
-- existing admin account.
--
-- If an admin login needs to be (re)linked to a Supabase Auth user, run
-- supabase-admin-setup.sql SEPARATELY. The statement below is reproduced
-- here fully commented out for reference only — it must NOT be uncommented
-- by automated tooling:
--
-- INSERT INTO public.admin_users (id, email, full_name, role)
-- VALUES (
--   '363fc336-b630-493d-8f58-b614bc4fcfc8',
--   '3brosnfroo15@gmail.com',
--   'Admin',
--   'admin'
-- )
-- ON CONFLICT (id) DO UPDATE SET
--   email = EXCLUDED.email,
--   full_name = EXCLUDED.full_name,
--   role = EXCLUDED.role;
-- ============================================================================
`);

  // ---- PART 4: verification --------------------------------------------------
  const expectedRows = plan.map((t) => `  ('${t.table}', (select count(*)::int from public.${t.table}), ${t.rows.length})`);
  parts.push(`-- ============================================================================
-- PART 4: VERIFICATION — row counts vs. the source of truth
-- ----------------------------------------------------------------------------
-- Pure SELECTs; safe to run anywhere, any number of times. Every row of the
-- result must show ok = true after the bundle has been applied.
-- ============================================================================

select t as "table", n as rows_in_database, expected, (n = expected) as ok
from (values
${expectedRows.join(',\n')}
) v(t, n, expected)
order by t;
`);

  const bundle = parts.join('\n');
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, bundle, 'utf8');

  const lines = bundle.split('\n').length;
  console.log(`✓ wrote ${path.relative(ROOT, OUT_FILE)}`);
  console.log(`  source sha256 : ${sourceSha}`);
  console.log(`  data rows     : ${totalRows} (${plan.map((t) => `${t.table}:${t.rows.length}`).join(', ')})`);
  console.log(`  size          : ${Buffer.byteLength(bundle)} bytes, ${lines} lines`);
  return 0;
}

process.exit(generate());
