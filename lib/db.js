'use strict';
// ============================================================================
// VELOCCI / SPINTO — database access layer
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

// Runs an operation against the configured driver; if that driver turns out to
// be unusable the same operation is re-run against the JSON store.
async function withFallback(fn) {
  if (driver() === 'json') return fn();
  try {
    const out = await fn();
    remoteUp();
    return out;
  } catch (err) {
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
// 'SPINTO' is not valid JSON; '"SPINTO"' is.)
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
  'products.specs', 'products.vehicles',
  'brands.models', 'home_sections.config',
  'orders.customer', 'orders.items', 'orders.status_history',
  'order_items.fitment', 'preorders.customer', 'settings.value',
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
  return cacheSet('catalog', {
    settings,
    languages: settings.languages || { current: 'en', supported: ['en', 'ar'], dict: {} },
    promoBar: mapping.rowToPromoBar(promoRows[0]),
    heroSlides: slideRows.map(mapping.rowToHeroSlide),
    homeSections: sectionRows.map(mapping.rowToHomeSection),
    brands: brandRows.map(mapping.rowToBrand),
    bundles: bundleRows.map(mapping.rowToBundle),
    products: productRows.map(mapping.rowToProduct),
    categories: categoryRows.map(mapping.rowToCategory),
  });
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
    categories: db.categories || [],
  };
}

// The public payload the storefront consumes (same contract as before).
function publicPayload(catalog) {
  return {
    settings: catalog.settings,
    languages: catalog.languages,
    promoBar: catalog.promoBar && catalog.promoBar.enabled ? catalog.promoBar : null,
    heroSlides: catalog.heroSlides.filter((s) => s.active !== false).sort((a, b) => (a.order || 0) - (b.order || 0)),
    homeSections: catalog.homeSections.filter((s) => s.enabled !== false).sort((a, b) => (a.order || 0) - (b.order || 0)),
    brands: catalog.brands.filter((b) => b.active !== false).sort((a, b) => (a.order || 0) - (b.order || 0)),
    bundles: catalog.bundles.filter((b) => b.active !== false),
    products: catalog.products.filter((p) => p.active !== false),
    categories: catalog.categories.filter((c) => c.active !== false),
  };
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
      total: o.total, status: o.status, status_history: o.statusHistory, payment: o.payment,
      customer_name: o.customer && o.customer.fullName, customer_phone: o.customer && o.customer.phone,
      customer_email: o.customer && o.customer.email, customer_city: o.customer && o.customer.city,
      customer_area: o.customer && o.customer.area, customer_address: o.customer && o.customer.address,
      customer_notes: o.customer && o.customer.notes,
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
  return mapping.rowToOrder(rows[0], items);
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
};

const CONFLICT_TARGET = {
  products: 'id', categories: 'id', brands: 'id', bundles: 'id',
  hero_slides: 'id', home_sections: 'id', website_images: 'id',
  website_content: 'section,key', messages: 'id', preorders: 'id', orders: 'id',
  discount_codes: 'id',
};

async function saveRecord(collection, record) {
  const table = COLLECTION_TABLE[collection];
  const toRow = TO_ROW[collection];
  if (!table || !toRow) throw new Error(`Unknown collection: ${collection}`);
  const row = toRow(record);
  if (!row.id) throw new Error('Record is missing an id');
  await upsertRows(table, [row], CONFLICT_TARGET[table] || 'id');
  if (collection === 'products') await syncProductChildren(row, record);
  invalidate();
  return row;
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
};

// Partial update. The row is read back first and merged, so patching one field
// can never blank out the others (a bare productToRow({id, active}) would).
async function patchRecord(collection, id, patch) {
  const table = COLLECTION_TABLE[collection];
  if (!table) throw new Error(`Unknown collection: ${collection}`);
  const rows = await selectRows(table, { eq: { id }, limit: 1 });
  if (!rows.length) throw new Error(`Record not found: ${id}`);
  const toApp = FROM_ROW[collection];
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
// admin payload
// ---------------------------------------------------------------------------
async function getAdminData() {
  const catalog = await getCatalog();
  const orders = await getOrders();
  const out = Object.assign({}, catalog, { orders });
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
