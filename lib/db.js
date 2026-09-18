'use strict';
// ============================================================================
// VELOCCI / VILOCCI — database access layer
// ----------------------------------------------------------------------------
// This is the single integration point between the app and Supabase (the
// README always described lib/store.js as the thing to swap; this replaces it
// as the durable store while keeping the JSON file as a fallback so the app
// still boots with no database configured).
//
// Drivers (auto-selected from the environment):
//   "sql"       — direct Postgres connection (SUPABASE_DB_URL / DATABASE_URL).
//                 Used by local verification and by anyone with a connection
//                 string; also the only driver that can run DDL.
//   "postgrest" — Supabase REST API through @supabase/supabase-js with the
//                 service-role key. This is what runs on Vercel, where only
//                 VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set.
//   "json"      — the in-memory/file JSON store (no database configured).
//
// Row shape translation lives in lib/mapping.js and is shared with
// scripts/migrate.js, so migration output and runtime reads agree.
// ============================================================================

const mapping = require('./mapping');
const store = require('./store');
const storage = require('./storage');

const SUPABASE_URL = sanitizeUrl(process.env.VITE_SUPABASE_URL || '');
const DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || '';

// ---------------------------------------------------------------------------
// Key hygiene
// ---------------------------------------------------------------------------
// Supabase keys are sent as HTTP header values on every request. A key that
// cannot be encoded as a ByteString — e.g. a stray bullet "•" (U+2022) pasted
// in from a chat app or formatted document, any code point > 255 — makes
// EVERY request throw `Cannot convert argument to a ByteString…` before it
// even leaves the machine. That error used to surface as a baffling data
// failure and silenced the whole remote driver. Validate the keys up front,
// report the exact fault, and fall back to the next usable key
// (service → anon → JSON store) instead of breaking.
// ---------------------------------------------------------------------------
function keyIssue(key, label) {
  if (!key) return null; // absence is handled by driver selection, not here
  for (let i = 0; i < key.length; i += 1) {
    const code = key.charCodeAt(i);
    if (code < 32 || code > 255) {
      const hex = 'U+' + code.toString(16).toUpperCase().padStart(4, '0');
      return `${label} is corrupted: character ${hex} at position ${i} cannot be sent in an HTTP header. `
        + 'Re-copy the key from Supabase → Project Settings → API (no extra characters), then redeploy.';
    }
  }
  return null;
}

const SERVICE_KEY_RAW = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const ANON_KEY_RAW = (process.env.VITE_SUPABASE_ANON_KEY || '').trim();
const SERVICE_KEY_ISSUE = keyIssue(SERVICE_KEY_RAW, 'SUPABASE_SERVICE_ROLE_KEY');
const ANON_KEY_ISSUE = keyIssue(ANON_KEY_RAW, 'VITE_SUPABASE_ANON_KEY');
const SERVICE_KEY = SERVICE_KEY_ISSUE ? '' : SERVICE_KEY_RAW;
const ANON_KEY = ANON_KEY_ISSUE ? '' : ANON_KEY_RAW;

if (SERVICE_KEY_ISSUE) console.error(`[data] ${SERVICE_KEY_ISSUE}`);
if (ANON_KEY_ISSUE) console.error(`[data] ${ANON_KEY_ISSUE}`);
if (SERVICE_KEY_ISSUE && ANON_KEY) {
  console.warn('[data] Using the anon key for the server client instead of the corrupted service key. '
    + 'RLS still applies: public reads work, but admin-only writes (orders) and inactive-row '
    + 'reads are blocked until the service key is fixed.');
}

function sanitizeUrl(url) {
  if (!url) return '';
  try {
    const p = new URL(String(url).trim());
    return `${p.protocol}//${p.hostname}`;
  } catch (e) {
    return '';
  }
}

function detectDriver() {
  if (process.env.DATA_DRIVER === 'json') return 'json';
  if (DB_URL) return 'sql';
  if (SUPABASE_URL && (SERVICE_KEY || ANON_KEY)) return 'postgrest';
  return 'json';
}

const DRIVER = detectDriver();          // what the environment asks for
const REPROBE_MS = 60000;

// ---------------------------------------------------------------------------
// Remote health + JSON fallback
// ---------------------------------------------------------------------------
// The remote store is only usable once the schema exists. If a read or write
// fails (typically `relation "public.products" does not exist` / PGRST205
// because the migrations have not been applied yet), the WHOLE store falls back
// to the JSON dataset — reads and writes together — so a pending migration can
// never take the storefront down or split writes across two stores. The remote
// is re-probed every 60s, so it takes over on its own as soon as the tables
// are there.
let _remote = { state: DRIVER === 'json' ? 'json' : 'unknown', error: null, at: 0 };

function driver() {
  if (DRIVER === 'json') return 'json';
  if (_remote.state === 'unavailable' && Date.now() - _remote.at < REPROBE_MS) return 'json';
  return DRIVER;
}

function remoteUp() {
  if (_remote.state === 'unavailable') {
    console.log(`[data] ${DRIVER} driver recovered — leaving the JSON fallback.`);
  }
  _remote = { state: 'ok', error: null, at: Date.now() };
}

function remoteDown(err) {
  const message = (err && (err.message || String(err))) || 'unknown error';
  if (_remote.error !== message) {
    console.warn(`[data] ${DRIVER} driver unavailable — serving the JSON store for the next `
      + `${REPROBE_MS / 1000}s instead. Reason: ${message}`);
    if (/does not exist|PGRST205|PGRST202|could not find the table/i.test(message)) {
      console.warn('[data] That looks like the Supabase schema is not applied yet. '
        + 'Run `npm run migrate -- --apply` (or paste `npm run migrate -- --print-sql` '
        + 'into the Supabase SQL editor), then this switches over automatically.');
    }
  }
  _remote = { state: 'unavailable', error: message, at: Date.now() };
}

function health() {
  return {
    configuredDriver: DRIVER,
    activeDriver: driver(),
    usingJsonFallback: driver() !== DRIVER,
    remoteState: _remote.state,
    remoteError: _remote.error,
    reprobeMs: REPROBE_MS,
  };
}

// An input the API rejected (unknown status, missing field, …). It says nothing
// about the health of the driver, so it must never switch the app over to the
// JSON store — the caller answers 400 with this message instead.
function invalidInput(message) {
  const err = new Error(message);
  err.code = 'INVALID_INPUT';
  return err;
}

// Runs an operation against the configured driver; if that driver turns out to
// be unusable the same operation is re-run against the JSON store.
async function withFallback(fn) {
  if (driver() === 'json') return fn();
  try {
    const out = await fn();
    remoteUp();
    return out;
  } catch (err) {
    if (err && err.code === 'INVALID_INPUT') throw err;
    remoteDown(err);
    invalidate();                 // nothing from the failed attempt is trustworthy
    return fn();                  // driver() is 'json' now
  }
}

// ---------------------------------------------------------------------------
// driver internals
// ---------------------------------------------------------------------------
let _pg = null;
function pgPool() {
  if (_pg) return _pg;
  const { Pool } = require('pg');
  _pg = new Pool({
    connectionString: DB_URL,
    max: 3,
    ssl: /localhost|127\.0\.0\.1/.test(DB_URL) ? false : { rejectUnauthorized: false },
  });
  return _pg;
}

let _sb = null;
function sbClient() {
  if (_sb) return _sb;
  const { createClient } = require('@supabase/supabase-js');
  // Server side: the service-role key bypasses RLS (admin operations).
  // If only the anon key is configured (or the service key is corrupted) we
  // still create a client — public reads work, writes are rejected by RLS
  // exactly as they should be.
  const role = SERVICE_KEY ? 'service-role' : 'anon';
  console.log(`[data] server Supabase client created (key role: ${role})`);
  _sb = createClient(SUPABASE_URL, SERVICE_KEY || ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _sb;
}

const QUOTED_COLUMNS = new Set(['order', 'key']);
function q(col) { return QUOTED_COLUMNS.has(col) ? `"${col}"` : col; }

// supabase-js v2 keeps the stable PostgREST code (PGRST205, 42501, …) in
// error.code, NOT in error.message — include it so logs and /api/admin/diagnose
// can tell a missing schema (PGRST205) apart from an RLS denial (42501).
function pgRestError(prefix, error) {
  return `${prefix}: ${error.code ? error.code + ': ' : ''}${error.message}`;
}

// ---- select ---------------------------------------------------------------
async function selectRows(table, opts = {}) {
  const columns = opts.columns || '*';
  if (driver() === 'sql') {
    const cols = columns === '*' ? '*' : columns.split(',').map((c) => q(c.trim())).join(', ');
    const where = [];
    const params = [];
    for (const [k, v] of Object.entries(opts.eq || {})) {
      params.push(v);
      where.push(`${q(k)} = $${params.length}`);
    }
    for (const k of opts.in && Object.keys(opts.in) || []) {
      const list = opts.in[k];
      if (!list.length) continue;
      params.push(list);
      where.push(`${q(k)} = any($${params.length})`);
    }
    let sql = `select ${cols} from public.${table}`;
    if (where.length) sql += ' where ' + where.join(' and ');
    if (opts.order) sql += ` order by ${q(opts.order.col)} ${opts.order.asc === false ? 'desc' : 'asc'}`;
    if (opts.limit) sql += ` limit ${parseInt(opts.limit, 10)}`;
    const res = await pgPool().query(sql, params);
    return res.rows;
  }
  if (driver() === 'postgrest') {
    let query = sbClient().from(table).select(columns);
    for (const [k, v] of Object.entries(opts.eq || {})) query = query.eq(k, v);
    for (const k of Object.keys(opts.in || {})) {
      const list = opts.in[k];
      if (list.length) query = query.in(k, list);
    }
    if (opts.order) query = query.order(opts.order.col, { ascending: opts.order.asc !== false });
    query = query.range(0, (opts.limit || 100000) - 1);
    const { data, error } = await query;
    if (error) throw new Error(`select ${table}: ${error.code ? error.code + ': ' : ''}${error.message}`);
    return data || [];
  }
  return jsonRows(table, opts);
}

// ---- upsert ---------------------------------------------------------------
async function upsertRows(table, rows, conflict = 'id') {
  if (!rows.length) return { inserted: 0, updated: 0 };
  if (driver() === 'sql') {
    const columns = Object.keys(rows[0]);
    const targets = conflict.split(',').map((c) => q(c.trim()));
    const updates = columns
      .filter((c) => !conflict.split(',').map((s) => s.trim()).includes(c))
      .map((c) => `${q(c)} = excluded.${q(c)}`);
    let inserted = 0;
    const client = await pgPool().connect();
    try {
      await client.query('begin');
      for (const row of rows) {
        const values = columns.map((c) => row[c]);
        const placeholders = columns.map((_, i) => `$${i + 1}`);
        const sql = `insert into public.${table} (${columns.map(q).join(', ')})
                     values (${placeholders.join(', ')})
                     on conflict (${targets.join(', ')}) do update set ${updates.join(', ')}`;
        await client.query(sql, values.map(jsonbParam(table, columns)));
        inserted += 1;
      }
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw new Error(`upsert ${table}: ${e.message}`);
    } finally {
      client.release();
    }
    return { inserted, updated: 0 };
  }
  if (driver() === 'postgrest') {
    const { data, error } = await sbClient()
      .from(table)
      .upsert(rows, { onConflict: conflict, count: 'exact' });
    if (error) throw new Error(pgRestError(`upsert ${table}`, error));
    return { inserted: (data || []).length, updated: 0 };
  }
  return jsonUpsert(table, rows);
}

// jsonb columns: Postgres parses the incoming parameter text as JSON, so every
// value — including plain strings and numbers — has to be JSON-encoded. (A raw
// 'VILOCCI' is not valid JSON; '"VILOCCI"' is.)
function jsonbParam(table, columns) {
  return (value, index) => {
    const col = columns[index];
    if (value === undefined) return null;
    if (value === null) return null;
    if (JSON_COLUMNS.has(`${table}.${col}`)) return JSON.stringify(value);
    // Everything else goes through node-postgres' own type inference: JS arrays
    // become Postgres array literals (products.images is text[]).
    return value;
  };
}

// Columns declared jsonb (products.images is text[] and stays a JS array).
const JSON_COLUMNS = new Set([
  'products.key_shapes', 'products.fitment', 'products.models', 'products.years',
  'products.specs', 'products.vehicles', 'products.colors',
  'brands.models', 'home_sections.config',
  'orders.customer', 'orders.items', 'orders.status_history',
  'order_items.fitment', 'order_items.color', 'preorders.customer', 'settings.value',
]);

// ---- update / delete ------------------------------------------------------
async function updateRow(table, id, patch, idColumn = 'id') {
  if (driver() === 'sql') {
    const columns = Object.keys(patch);
    const values = columns.map((c) => patch[c]);
    const sql = `update public.${table} set ${columns
      .map((c, i) => `${q(c)} = $${i + 1}`)
      .join(', ')} where ${q(idColumn)} = $${columns.length + 1}`;
    const res = await pgPool().query(sql, values.concat([id]));
    return res.rowCount;
  }
  if (driver() === 'postgrest') {
    const { error } = await sbClient().from(table).update(patch).eq(idColumn, id);
    if (error) throw new Error(pgRestError(`update ${table}`, error));
    return 1;
  }
  return jsonUpdate(table, id, patch, idColumn);
}

async function deleteRow(table, id, idColumn = 'id') {
  if (driver() === 'sql') {
    const res = await pgPool().query(`delete from public.${table} where ${q(idColumn)} = $1`, [id]);
    return res.rowCount;
  }
  if (driver() === 'postgrest') {
    const { error } = await sbClient().from(table).delete().eq(idColumn, id);
    if (error) throw new Error(pgRestError(`delete ${table}`, error));
    return 1;
  }
  return jsonDelete(table, id, idColumn);
}

async function runSql(sql, params = []) {
  if (driver() === 'sql') {
    const res = await pgPool().query(sql, params);
    return res;
  }
  if (driver() === 'postgrest') {
    // Supabase Management API — needs SUPABASE_ACCESS_TOKEN + project ref.
    const token = process.env.SUPABASE_ACCESS_TOKEN;
    const ref = process.env.SUPABASE_PROJECT_REF || projectRefFromUrl(SUPABASE_URL);
    if (!token || !ref) {
      throw new Error('DDL needs a Postgres connection (SUPABASE_DB_URL) or the Supabase Management API (SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF). PostgREST cannot run DDL.');
    }
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    });
    if (!res.ok) throw new Error(`Management API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return { rows: await res.json() };
  }
  throw new Error('runSql requires a database connection (SUPABASE_DB_URL).');
}

function projectRefFromUrl(url) {
  const m = /^https:\/\/([^.]+)\.supabase\.co$/.exec(url || '');
  return m ? m[1] : '';
}

// ---------------------------------------------------------------------------
// JSON fallback driver (keeps the app usable with no database configured)
// ---------------------------------------------------------------------------
const JSON_COLLECTION = {
  products: 'products', categories: 'categories', brands: 'brands', bundles: 'bundles',
  hero_slides: 'heroSlides', home_sections: 'homeSections', orders: 'orders',
  order_items: 'orderItems', product_images: 'productImages', product_prices: 'productPrices',
  website_content: 'websiteContent', website_images: 'websiteImages', settings: 'settingsRows',
  promo_bar: 'promoBarRows', messages: 'messages', preorders: 'preorders',
  customize_requests: 'customizeRequests',
  discount_codes: 'discount_codes',
};

function jsonTable(table) {
  const db = store.load();
  const key = JSON_COLLECTION[table];
  if (!key) throw new Error(`json fallback does not know table ${table}`);
  if (!db[key]) db[key] = [];
  return db[key];
}

function jsonRows(table, opts) {
  let rows = jsonTable(table).slice();
  for (const [k, v] of Object.entries(opts.eq || {})) rows = rows.filter((r) => r[k] === v);
  if (opts.order) {
    const c = opts.order.col;
    rows.sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (opts.order.asc === false ? -1 : 1));
  }
  if (opts.limit) rows = rows.slice(0, opts.limit);
  return rows;
}

function jsonUpsert(table, rows) {
  const arr = jsonTable(table);
  let inserted = 0;
  for (const row of rows) {
    const i = arr.findIndex((r) => r.id === row.id);
    if (i >= 0) arr[i] = Object.assign({}, arr[i], row);
    else { arr.push(row); inserted += 1; }
  }
  store.save();
  return { inserted, updated: rows.length - inserted };
}

function jsonUpdate(table, id, patch) {
  const arr = jsonTable(table);
  const i = arr.findIndex((r) => r.id === id);
  if (i < 0) return 0;
  arr[i] = Object.assign({}, arr[i], patch);
  store.save();
  return 1;
}

function jsonDelete(table, id) {
  const arr = jsonTable(table);
  const i = arr.findIndex((r) => r.id === id);
  if (i < 0) return 0;
  arr.splice(i, 1);
  store.save();
  return 1;
}

// ---------------------------------------------------------------------------
// read cache — the storefront reads the catalog on every request; a short TTL
// keeps serverless latency sane and is invalidated on every admin write.
// ---------------------------------------------------------------------------
const TTL_MS = Number(process.env.DB_CACHE_TTL_MS || 5000);
const _cache = new Map();

function cacheGet(key) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  return null;
}
function cacheSet(key, value) { _cache.set(key, { at: Date.now(), value }); return value; }
function invalidate() { _cache.clear(); }

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------
async function getCatalog() {
  if (driver() === 'json') return jsonCatalog();
  const cached = cacheGet('catalog');
  if (cached) return cached;

  const [productRows, categoryRows, brandRows, bundleRows, slideRows, sectionRows, settingRowsDb, promoRows] =
    await Promise.all([
      selectRows('products', { order: { col: 'order', asc: true } }),
      selectRows('categories', { order: { col: 'order', asc: true } }),
      selectRows('brands', { order: { col: 'order', asc: true } }),
      selectRows('bundles'),
      selectRows('hero_slides', { order: { col: 'order', asc: true } }),
      selectRows('home_sections', { order: { col: 'order', asc: true } }),
      selectRows('settings'),
      selectRows('promo_bar', { eq: { id: 'promo' }, limit: 1 }),
    ]);

  const settings = mapping.rowsToSettings(settingRowsDb);
  const languages = settings.languages || { current: 'en', supported: ['en', 'ar'], dict: {} };
  const products = productRows.map(mapping.rowToProduct);
  return cacheSet('catalog', {
    settings,
    languages,
    promoBar: mapping.rowToPromoBar(promoRows[0]),
    heroSlides: slideRows.map(mapping.rowToHeroSlide),
    homeSections: sectionRows.map(mapping.rowToHomeSection),
    brands: brandRows.map(mapping.rowToBrand),
    bundles: bundleRows.map(mapping.rowToBundle),
    products,
    categories: catalogCategories(categoryRows, { languages, products }),
  });
}

// The `categories` table is optional, and its rows are only meaningful while at
// least one of them is ACTIVE. A database created from the schema has no rows
// at all; a database seeded by the content migration has three rows that can
// all be switched off — and RLS (`for select using (active = true)`) hides
// those from the browser, so the Admin panel and the storefront see nothing
// either. In both cases the products still carry their `category`, so the
// categories are DERIVED from them — the very same rule the JSON driver and
// scripts/migrate.js have always used, producing the same three ids
// (keycase / keyholder / medal).
//
// Reporting an empty catalogue instead silently broke everything driven by it,
// most visibly the Customize flow: no categories meant no Customize entry in
// the storefront navigation at all, on the live site.
//
// A partially switched-off catalogue is NOT touched — the stored rows are
// returned as they are, so an admin hiding one category still hides exactly
// that one.
function catalogCategories(rows, source) {
  const stored = (rows || []).filter(Boolean);
  const hasActive = stored.some((r) => r.active !== false);
  if (hasActive) return stored.map(mapping.rowToCategory);
  return mapping.deriveCategories(source || {}).map(mapping.rowToCategory);
}

function jsonCatalog() {
  const db = store.load();
  return {
    settings: db.settings || {},
    languages: db.languages || { current: 'en', supported: ['en', 'ar'], dict: {} },
    promoBar: db.promoBar || {},
    heroSlides: (db.heroSlides || []).slice(),
    homeSections: (db.homeSections || []).slice(),
    brands: (db.brands || []).slice(),
    bundles: (db.bundles || []).slice(),
    products: (db.products || []).slice(),
    categories: jsonCategories(db),
  };
}

// The JSON dataset has no `categories` collection — exactly like the content
// migration, the categories are DERIVED from the products the store already
// has (same ids, labels, images and counts the SQL mapping writes), unless the
// admin has since edited them in the store's own categories array. Deriving
// them here means the Customize page, the Admin category list and the database
// all talk about the same real categories instead of a hard-coded list.
function jsonCategories(db) {
  const stored = Array.isArray(db.categories) ? db.categories.filter(Boolean) : [];
  if (stored.length) return stored;
  return mapping.deriveCategories(db).map(mapping.rowToCategory);
}

// Normalize InstaPay for the storefront without writing to the database.
// Accepts object or JSON string; if the key is missing, fill from the JSON
// catalog defaults (seed) so Checkout can render the option.
function normalizeStorefrontSettings(settings) {
  const s = Object.assign({}, settings || {});
  let cfg = s.instapay;
  if (typeof cfg === 'string') {
    try { cfg = JSON.parse(cfg); } catch (e) { cfg = null; }
  }
  if (!cfg || typeof cfg !== 'object') {
    try {
      const fallback = (jsonCatalog().settings || {}).instapay;
      if (fallback && typeof fallback === 'object') cfg = fallback;
    } catch (e) { cfg = null; }
  }
  if (cfg && typeof cfg === 'object') {
    const url = String(cfg.url || s.instapayUrl || s.instapay_url || '').trim();
    const raw = cfg.enabled;
    const off = raw === false || raw === 'false' || raw === 0 || raw === '0';
    s.instapay = { enabled: !off && !!url, url };
  }
  return s;
}

// The public payload the storefront consumes (same contract as before).
function publicPayload(catalog) {
  return {
    settings: normalizeStorefrontSettings(catalog.settings),
    languages: catalog.languages,
    promoBar: catalog.promoBar && catalog.promoBar.enabled ? catalog.promoBar : null,
    heroSlides: catalog.heroSlides.filter((s) => s.active !== false).sort((a, b) => (a.order || 0) - (b.order || 0)),
    homeSections: catalog.homeSections.filter((s) => s.enabled !== false).sort((a, b) => (a.order || 0) - (b.order || 0)),
    brands: catalog.brands.filter((b) => b.active !== false).sort((a, b) => (a.order || 0) - (b.order || 0)),
    bundles: catalog.bundles.filter((b) => b.active !== false),
    products: catalog.products.filter((p) => p.active !== false),
    categories: catalog.categories.filter((c) => c.active !== false),
    // Which of those categories the customer may pick on the Customize page.
    // Read-only for the storefront: it is driven entirely by the Admin
    // Customize Settings screen and never changes categories.active.
    customize: publicCustomizeConfig(catalog),
  };
}

// ---------------------------------------------------------------------------
// CUSTOMIZE — settings (which categories are available) + customer requests
// ---------------------------------------------------------------------------
// Category availability lives in its OWN settings row (`customize`), never in
// categories.active: the normal shopping / category pages keep behaving exactly
// as before, and only the Customize page reads this.
const CUSTOMIZE_SETTING_KEY = 'customize';
const CUSTOMIZE_STATUSES = ['New', 'Contacted', 'In Progress', 'Completed', 'Cancelled'];

function parseCustomizeSetting(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  return typeof raw === 'object' ? raw : null;
}

// Availability DEFAULTS TO ENABLED for every existing category. That is the
// safe first-deployment behaviour: the Customize page is populated from the
// site's real categories and an operator only ever has to turn categories OFF.
// A category that is not mentioned in a saved configuration therefore stays
// enabled (so a brand-new category is never silently hidden).
function customizeConfig(settings, categories) {
  const raw = parseCustomizeSetting(settings && settings[CUSTOMIZE_SETTING_KEY]);
  const map = (raw && raw.categories && typeof raw.categories === 'object') ? raw.categories : {};
  const out = {};
  (categories || []).forEach((c) => { out[c.id] = map[c.id] !== false; });
  return {
    categories: out,
    updatedAt: (raw && raw.updatedAt) || null,
    configured: !!raw,
    storage: storage.info(),
  };
}

function toCustomizeCategory(c) {
  return {
    id: c.id,
    slug: c.slug || c.id,
    name_en: c.name_en || c.name || c.id,
    name_ar: c.name_ar || '',
    image: c.image || null,
    icon: c.icon || null,
    product_count: Number(c.product_count || 0),
    order: Number(c.order || 0),
  };
}

// The categories a customer may choose on the Customize page: every category
// that is (a) live on the storefront and (b) switched ON for Customize.
function customizeCategoryList(catalog) {
  const config = customizeConfig(catalog.settings, catalog.categories);
  return catalog.categories
    .filter((c) => c.active !== false && config.categories[c.id] !== false)
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map(toCustomizeCategory);
}

function publicCustomizeConfig(catalog) {
  const categories = customizeCategoryList(catalog);
  return { available: categories.length > 0, categories };
}

async function getCustomizeConfig() {
  const catalog = await getCatalog();
  const config = customizeConfig(catalog.settings, catalog.categories);
  return Object.assign({}, config, {
    list: catalog.categories
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((c) => Object.assign(toCustomizeCategory(c), { active: c.active !== false, enabled: config.categories[c.id] !== false })),
    stats: await customizeStats(),
  });
}

async function getCustomizeCategories() {
  return customizeCategoryList(await getCatalog());
}

async function getCustomizeSettings() {
  const catalog = await getCatalog();
  return customizeConfig(catalog.settings, catalog.categories);
}

// Persists { categories: { [categoryId]: boolean } }. The admin panel sends the
// complete map, so what it saves is exactly what is stored.
async function saveCustomizeSettings(input) {
  const catalog = await getCatalog();
  const raw = parseCustomizeSetting(input) || {};
  const wanted = (raw.categories && typeof raw.categories === 'object') ? raw.categories : {};
  const map = {};
  catalog.categories.forEach((c) => { map[c.id] = wanted[c.id] !== false; });
  const config = { categories: map, updatedAt: new Date().toISOString() };
  await saveSettings({ [CUSTOMIZE_SETTING_KEY]: config });
  invalidate();
  return getCustomizeConfig();
}

// Stats for the admin sidebar badge. Never allowed to break the admin payload:
// if the table is not migrated yet the counts are reported as unknown.
async function customizeStats() {
  try {
    const rows = await selectRows('customize_requests', { columns: 'id,status' });
    return { total: rows.length, new: rows.filter((r) => r.status === 'New').length };
  } catch (e) {
    return { total: 0, new: 0, error: e.message };
  }
}

// One request per client key — makes a double tap / retry idempotent.
async function findCustomizeRequestByClientKey(clientKey) {
  if (!clientKey) return null;
  const rows = await selectRows('customize_requests', { eq: { client_key: clientKey }, limit: 1 });
  return rows.length ? mapping.rowToCustomizeRequest(rows[0]) : null;
}

async function createCustomizeRequest(record) {
  const row = mapping.customizeRequestToRow(record);
  await upsertRows('customize_requests', [row], 'id');
  invalidate();
  return mapping.rowToCustomizeRequest(row);
}

// Admin lists never carry the photo payload; the image is served separately by
// an authenticated endpoint that mints a signed URL.
async function getCustomizeRequests(opts = {}) {
  const rows = await selectRows('customize_requests', {
    order: { col: 'created_at', asc: false },
    limit: opts.limit,
  });
  return rows.map((r) => mapping.customizeRequestSummary(mapping.rowToCustomizeRequest(r)));
}

async function getCustomizeRequest(id) {
  const rows = await selectRows('customize_requests', { eq: { id }, limit: 1 });
  return rows.length ? mapping.rowToCustomizeRequest(rows[0]) : null;
}

// Only the admin-managed fields can be patched from the API surface.
async function updateCustomizeRequest(id, patch) {
  const clean = { updated_at: new Date().toISOString() };
  if (patch.status !== undefined) {
    const status = String(patch.status);
    if (!CUSTOMIZE_STATUSES.includes(status)) throw invalidInput(`Unknown status: ${status}`);
    clean.status = status;
  }
  if (patch.admin_notes !== undefined) clean.admin_notes = patch.admin_notes === null ? null : String(patch.admin_notes);
  const n = await updateRow('customize_requests', id, clean);
  invalidate();
  return n;
}

// Deletes the row and (best effort) the private storage object behind it.
async function deleteCustomizeRequest(id) {
  let path = null;
  try {
    const rows = await selectRows('customize_requests', { columns: 'id,car_image_path', eq: { id }, limit: 1 });
    if (rows.length) path = rows[0].car_image_path;
  } catch (e) { /* the row read is only for the photo cleanup */ }
  const n = await deleteRow('customize_requests', id);
  if (path) await storage.removeCarPhoto(path);
  invalidate();
  return n;
}

// ---------------------------------------------------------------------------
// orders
// ---------------------------------------------------------------------------
async function getOrders(opts = {}) {
  const cached = !opts.limit && cacheGet('orders');
  if (cached) return cached;

  let orderRows;
  if (driver() === 'json') {
    orderRows = jsonRows('orders', {}).map((o) => ({
      id: o.id, created_at: o.createdAt, customer: o.customer, items: o.items,
      subtotal: o.subtotal, bundle_discount: o.bundleDiscount, delivery_fee: o.deliveryFee,
      // stored orders are either seeded camelCase documents or freshly
      // written snake_case rows — accept the coating fee from either shape
      coating_fee: o.coatingFee !== undefined ? o.coatingFee : o.coating_fee,
      total: o.total, status: o.status, status_history: o.statusHistory, payment: o.payment,
      customer_name: o.customer && o.customer.fullName, customer_phone: o.customer && o.customer.phone,
      customer_email: o.customer && o.customer.email, customer_city: o.customer && o.customer.city,
      customer_area: o.customer && o.customer.area, customer_address: o.customer && o.customer.address,
      customer_notes: o.customer && o.customer.notes,
      payment_proof_path: o.paymentProof ? o.paymentProof.path : o.payment_proof_path,
      payment_proof_mime: o.paymentProof ? o.paymentProof.mime : o.payment_proof_mime,
      payment_proof_size: o.paymentProof ? o.paymentProof.size : o.payment_proof_size,
      payment_proof_data: o.paymentProof ? o.paymentProof.data : o.payment_proof_data,
    }));
  } else {
    orderRows = await selectRows('orders', { order: { col: 'created_at', asc: false }, limit: opts.limit });
  }
  const itemRows = await getOrderItemRows(orderRows.map((o) => o.id));
  const byOrder = {};
  itemRows.forEach((it) => { (byOrder[it.order_id] = byOrder[it.order_id] || []).push(it); });
  const orders = orderRows.map((o) => mapping.rowToOrder(o, byOrder[o.id]));
  return opts.limit ? orders : cacheSet('orders', orders);
}

async function getOrderItemRows(orderIds) {
  if (!orderIds.length) return [];
  if (driver() === 'json') {
    return jsonRows('order_items', {}).filter((it) => orderIds.includes(it.order_id));
  }
  return selectRows('order_items', { in: { order_id: orderIds } });
}

async function getOrder(id) {
  const rows = await selectRows('orders', { eq: { id }, limit: 1 });
  if (!rows.length) return null;
  const items = await getOrderItemRows([id]);
  let row = rows[0];
  if (driver() === 'json') {
    const o = rows[0];
    row = {
      id: o.id, created_at: o.createdAt, customer: o.customer, items: o.items,
      subtotal: o.subtotal, bundle_discount: o.bundleDiscount, delivery_fee: o.deliveryFee,
      // seeded camelCase documents and freshly written snake_case rows both
      // have to surface the coating fee (same dual-shape read as getOrders)
      coating_fee: o.coatingFee !== undefined ? o.coatingFee : o.coating_fee,
      total: o.total, status: o.status, status_history: o.statusHistory, payment: o.payment,
      customer_name: o.customer && o.customer.fullName, customer_phone: o.customer && o.customer.phone,
      customer_email: o.customer && o.customer.email, customer_city: o.customer && o.customer.city,
      customer_area: o.customer && o.customer.area, customer_address: o.customer && o.customer.address,
      customer_notes: o.customer && o.customer.notes,
      payment_proof_path: o.paymentProof ? o.paymentProof.path : o.payment_proof_path,
      payment_proof_mime: o.paymentProof ? o.paymentProof.mime : o.payment_proof_mime,
      payment_proof_size: o.paymentProof ? o.paymentProof.size : o.payment_proof_size,
      payment_proof_data: o.paymentProof ? o.paymentProof.data : o.payment_proof_data,
    };
  }
  return mapping.rowToOrder(row, items, { includePaymentProofData: true });
}

// Writes an order + its line items. Upsert on the primary key, so re-submitting
// the same order id can never create a duplicate.
async function createOrder(order) {
  const orderRow = mapping.orderToRow(order);
  const itemRows = (order.items || []).map((it, i) => mapping.orderItemToRow(it, orderRow.id, i));
  if (driver() === 'sql') {
    const client = await pgPool().connect();
    try {
      await client.query('begin');
      await upsertRows('orders', [orderRow]);
      if (itemRows.length) await upsertRows('order_items', itemRows);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  } else {
    await upsertRows('orders', [orderRow]);
    if (itemRows.length) await upsertRows('order_items', itemRows);
  }
  invalidate();
  return mapping.rowToOrder(orderRow, itemRows);
}

async function setOrderStatus(id, status) {
  const history = [{ status, at: new Date().toISOString() }];
  const existing = await selectRows('orders', { columns: 'id,status_history', eq: { id }, limit: 1 });
  const prev = existing[0] && Array.isArray(existing[0].status_history) ? existing[0].status_history : [];
  const patch = { status, status_history: prev.concat(history) };
  const n = driver() === 'sql'
    ? await updateRow('orders', id, { status, status_history: JSON.stringify(patch.status_history) })
    : await updateRow('orders', id, patch);
  invalidate();
  return n;
}

// ---------------------------------------------------------------------------
// admin CRUD over the CMS collections
// ---------------------------------------------------------------------------
const COLLECTION_TABLE = {
  products: 'products',
  categories: 'categories',
  brands: 'brands',
  bundles: 'bundles',
  heroSlides: 'hero_slides',
  homeSections: 'home_sections',
  websiteImages: 'website_images',
  websiteContent: 'website_content',
  orders: 'orders',
  preorders: 'preorders',
  messages: 'messages',
  discount_codes: 'discount_codes',
  customize_requests: 'customize_requests',
};

const TO_ROW = {
  products: mapping.productToRow,
  categories: mapping.categoryToRow,
  brands: mapping.brandToRow,
  bundles: mapping.bundleToRow,
  heroSlides: mapping.heroSlideToRow,
  homeSections: mapping.homeSectionToRow,
  websiteImages: (w) => ({ id: w.id, name: w.name, url: w.url, section: w.section || null, alt: w.alt || null }),
  websiteContent: mapping.websiteContentToRow,
  messages: mapping.messageToRow,
  preorders: mapping.preorderToRow,
  discount_codes: mapping.discountCodeToRow,
  customize_requests: mapping.customizeRequestToRow,
};

const CONFLICT_TARGET = {
  products: 'id', categories: 'id', brands: 'id', bundles: 'id',
  hero_slides: 'id', home_sections: 'id', website_images: 'id',
  website_content: 'section,key', messages: 'id', preorders: 'id', orders: 'id',
  discount_codes: 'id', customize_requests: 'id',
};

async function saveRecord(collection, record) {
  const table = COLLECTION_TABLE[collection];
  const toRow = TO_ROW[collection];
  if (!table || !toRow) throw new Error(`Unknown collection: ${collection}`);
  const row = toRow(record);
  if (!row.id) throw new Error('Record is missing an id');
  // The JSON fallback store is seeded in APP shape (brandSlug, bundlePrice,
  // keyCaseProductId, createdAt, statusHistory …) and every json reader —
  // jsonCatalog(), getOrders(), the storefront and the admin panel — consumes
  // that shape directly, with no row->app translation. Persisting the SQL row
  // here instead left camelCase readers seeing `undefined` (an edited bundle
  // rendered as "EGP 0") or the stale seeded value, so a successful admin save
  // looked like it had not saved at all. Keep the store homogeneous: SQL rows
  // for a real database, the original app-shape record for the json fallback.
  // The json driver keeps the app-shape record (not the SQL row), so it never
  // passes through productToRow's color/shape normalization — run it here so
  // colors and keyShapes are cleaned identically on BOTH drivers.
  const jsonExtra = (driver() === 'json' && collection === 'products') ? {
    ...(record.colors !== undefined ? { colors: mapping.normalizeColors(record.colors) } : {}),
    ...(record.keyShapes !== undefined ? { keyShapes: mapping.normalizeKeyShapes(record.keyShapes) } : {}),
  } : {};
  const stored = driver() === 'json' ? Object.assign({}, record, { id: row.id }, jsonExtra) : row;
  await upsertRows(table, [stored], CONFLICT_TARGET[table] || 'id');
  if (collection === 'products') await syncProductChildren(row, record);
  invalidate();
  return stored;
}

// Keeps the normalized product_images / product_prices children in step with
// the product row. Images are upserted on (product_id, url) so re-saving a
// product cannot create duplicate images.
async function syncProductChildren(row, original) {
  const imageRows = mapping.productImageRows(original || row);
  if (imageRows.length) await upsertRows('product_images', imageRows, 'product_id,url');
  await upsertRows('product_prices', mapping.productPriceRows(original || row), 'product_id,label');
  if (driver() !== 'json') {
    const keep = imageRows.map((r) => r.url);
    const existing = await selectRows('product_images', { columns: 'id,url', eq: { product_id: row.id } });
    const stale = existing.filter((e) => !keep.includes(e.url)).map((e) => e.id);
    for (const id of stale) await deleteRow('product_images', id);
  }
}

const FROM_ROW = {
  products: mapping.rowToProduct,
  categories: mapping.rowToCategory,
  brands: mapping.rowToBrand,
  bundles: mapping.rowToBundle,
  heroSlides: mapping.rowToHeroSlide,
  homeSections: mapping.rowToHomeSection,
  messages: mapping.rowToMessage,
  preorders: mapping.rowToPreorder,
  discount_codes: mapping.rowToDiscountCode,
  customize_requests: mapping.rowToCustomizeRequest,
};

// Partial update. The row is read back first and merged, so patching one field
// can never blank out the others (a bare productToRow({id, active}) would).
async function patchRecord(collection, id, patch) {
  const table = COLLECTION_TABLE[collection];
  if (!table) throw new Error(`Unknown collection: ${collection}`);
  const rows = await selectRows(table, { eq: { id }, limit: 1 });
  if (!rows.length) throw new Error(`Record not found: ${id}`);
  // Only a real database returns SQL rows that need translating. The json
  // fallback already stores app shape, so running it through FROM_ROW reads
  // snake_case keys that are not there (r.brand_slug, r.bundle_price,
  // r.key_case_id …) and resolves them to undefined/0. The patch then restores
  // only the fields the edit form happens to expose, so `current` reaches
  // saveRecord with every other field blanked out.
  const toApp = driver() === 'json' ? null : FROM_ROW[collection];
  const current = toApp ? toApp(rows[0]) : rows[0];
  return saveRecord(collection, Object.assign({}, current, patch, { id }));
}

async function deleteRecord(collection, id) {
  const table = COLLECTION_TABLE[collection];
  if (!table) throw new Error(`Unknown collection: ${collection}`);
  const n = await deleteRow(table, id);
  invalidate();
  return n;
}

async function reorder(collection, ids) {
  const table = COLLECTION_TABLE[collection];
  if (!table) throw new Error(`Unknown collection: ${collection}`);
  for (let i = 0; i < ids.length; i += 1) {
    await updateRow(table, ids[i], { order: i + 1 });
  }
  invalidate();
}

async function saveSettings(patch) {
  if (driver() === 'json') {
    const raw = store.load();
    raw.settings = Object.assign({}, raw.settings || {}, patch);
    store.save(raw);
  }
  const rows = mapping.settingRows(patch);
  if (rows.length) await upsertRows('settings', rows, 'key');
  invalidate();
}

async function getSettings() {
  if (driver() === 'json') return store.load().settings || {};
  return mapping.rowsToSettings(await selectRows('settings'));
}

async function savePromoBar(patch) {
  const current = driver() === 'json' ? (store.load().promoBar || {}) : mapping.rowToPromoBar((await selectRows('promo_bar', { eq: { id: 'promo' }, limit: 1 }))[0]);
  const merged = mapping.promoBarToRow(Object.assign({}, current, patch));
  await upsertRows('promo_bar', [merged], 'id');
  invalidate();
}

async function saveLanguages(dict) {
  await upsertRows('settings', [{ key: 'languages', value: dict }], 'key');
  invalidate();
}

// ---------------------------------------------------------------------------
// DISCOUNT CODES
// ---------------------------------------------------------------------------
// Deliberately fault-tolerant. The `discount_codes` table arrives with the CMS
// migration; a deployment still running the bare schema (or the bundled JSON
// store, which simply has no codes yet) must behave as "there are no discount
// codes" rather than failing the checkout. A missing table is never a reason
// to refuse an order.
async function getDiscountCodes() {
  if (driver() === 'json') {
    const db = store.load();
    return db.discount_codes || [];
  }
  try {
    const rows = await selectRows('discount_codes');
    return (rows || []).map(mapping.rowToDiscountCode).filter(Boolean);
  } catch (e) {
    console.warn('[db] discount_codes unavailable:', e.message);
    return [];
  }
}

// Bump used_count once an order has been accepted. Best effort by design: the
// order is already durable at this point, and a failed counter must never roll
// back or fail a real purchase.
async function redeemDiscountCode(rawCode) {
  const discounts = require('./discounts');
  const want = discounts.normalizeCode(rawCode);
  if (!want) return 0;
  const rows = await getDiscountCodes();
  const row = discounts.findDiscountCode(rows, want);
  if (!row || !row.id) return 0;
  const updated = discounts.normalizeCode(row.code);
  try {
    await updateRow('discount_codes', row.id, { used_count: Number(row.used_count || 0) + 1 });
  } catch (e) {
    console.warn('[db] could not increment used_count for', updated + ':', e.message);
    return 0;
  }
  invalidate();
  return 1;
}

// ---------------------------------------------------------------------------
// admin payload
// ---------------------------------------------------------------------------
async function getAdminData() {
  const catalog = await getCatalog();
  const orders = await getOrders();
  const out = Object.assign({}, catalog, { orders });
  // The Customize screens need to know which categories are enabled and how
  // many requests are waiting. Both reads are fault-tolerant: a not-yet-migrated
  // customize_requests table must never break the admin payload.
  out.customize = await getCustomizeConfig();
  if (driver() === 'json') {
    const db = store.load();
    out.preorders = db.preorders || [];
    out.messages = db.messages || [];
    out.websiteContent = db.websiteContent || [];
    out.website_images = db.websiteImages || db.website_images || [];
    out.discount_codes = db.discount_codes || [];
    return out;
  }
  const [preorders, messages, content, images, discounts] = await Promise.all([
    selectRows('preorders', { order: { col: 'created_at', asc: false } }),
    selectRows('messages', { order: { col: 'created_at', asc: false } }),
    selectRows('website_content'),
    selectRows('website_images'),
    selectRows('discount_codes'),
  ]);
  out.discount_codes = discounts.map(mapping.rowToDiscountCode);
  out.preorders = preorders.map(mapping.rowToPreorder);
  out.messages = messages.map(mapping.rowToMessage);
  out.websiteContent = mapping.rowsToWebsiteContent(content);
  out.website_images = images;
  return out;
}

// The data API. Every entry point goes through withFallback() so that an
// un-applied schema degrades to the JSON store instead of failing the request.
const DATA_API = {
  getCatalog, getAdminData,
  getOrders, getOrder, createOrder, setOrderStatus,
  saveRecord, patchRecord, deleteRecord, reorder,
  saveSettings, getSettings, savePromoBar, saveLanguages,
  getCustomizeConfig, getCustomizeCategories, getCustomizeSettings, saveCustomizeSettings,
  createCustomizeRequest, getCustomizeRequests, getCustomizeRequest,
  findCustomizeRequestByClientKey, updateCustomizeRequest, deleteCustomizeRequest,
  customizeStats, CUSTOMIZE_STATUSES,
  getDiscountCodes, redeemDiscountCode,
};
const fallbackApi = {};
for (const [name, fn] of Object.entries(DATA_API)) {
  fallbackApi[name] = (...args) => withFallback(() => fn(...args));
}

module.exports = {
  DRIVER,
  SUPABASE_URL,
  isConfigured: () => DRIVER !== 'json',
  info: () => ({
    driver: DRIVER,
    activeDriver: driver(),
    usingJsonFallback: driver() !== DRIVER,
    remoteState: _remote.state,
    remoteError: _remote.error,
    supabaseUrl: SUPABASE_URL ? SUPABASE_URL.replace(/\/\/([^@]+)@/, '//***@') : '',
    serviceKeyPresent: !!SERVICE_KEY_RAW,
    anonKeyPresent: !!ANON_KEY_RAW,
    serviceKeyIssue: SERVICE_KEY_ISSUE,
    anonKeyIssue: ANON_KEY_ISSUE,
    serverKeyRole: SERVICE_KEY ? 'service-role' : (ANON_KEY ? 'anon' : 'none'),
    dbUrlPresent: !!DB_URL,
    projectRef: projectRefFromUrl(SUPABASE_URL),
  }),
  keyIssue,
  serviceKeyIssue: SERVICE_KEY_ISSUE,
  anonKeyIssue: ANON_KEY_ISSUE,
  health,
  driver,
  selectRows, upsertRows, updateRow, deleteRow, runSql, invalidate,
  publicPayload,
  ...fallbackApi,
  COLLECTION_TABLE,
  async close() { if (_pg) { await _pg.end(); _pg = null; } },
};
