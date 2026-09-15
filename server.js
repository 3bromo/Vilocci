// ============================================================================
// SPINTO — Application server
// Serves the storefront + admin SPA and exposes a single data API.
// Admin authentication uses Supabase Auth (JWT-verified, no hardcoded passwords).
// Data is read/written through lib/db.js (Supabase), with the JSON store as a
// fallback when no database is configured.
// ============================================================================
'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const db = require('./lib/db');
const store = require('./lib/store');

const { seed } = require('./data/seed');
const { asset } = require('./lib/assets');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase configuration (required for admin auth)
// Sanitize Supabase URL: must be https://<project-ref>.supabase.co with no path
function sanitizeSupabaseUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url.trim());
    // Only keep protocol + hostname (strip any path, query, hash)
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch (e) {
    console.error('[Supabase] Invalid URL format:', url);
    return '';
  }
}

const SUPABASE_URL = sanitizeSupabaseUrl(process.env.VITE_SUPABASE_URL || '');
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// A key with header-unencodable characters (e.g. a pasted bullet "•") makes
// every Supabase request throw before it is sent. Treat such keys as absent
// and fall back to the next usable one; lib/db.js does the same for its own
// data client, and the issues are reported by /api/admin/diagnose.
const ANON_KEY_ISSUE = db.keyIssue(SUPABASE_ANON_KEY.trim(), 'VITE_SUPABASE_ANON_KEY');
const SERVICE_KEY_ISSUE = db.keyIssue(SUPABASE_SERVICE_KEY.trim(), 'SUPABASE_SERVICE_ROLE_KEY');
if (ANON_KEY_ISSUE) console.error(`[Supabase] ${ANON_KEY_ISSUE}`);
if (SERVICE_KEY_ISSUE) console.error(`[Supabase] ${SERVICE_KEY_ISSUE}`);
// Key used for the server-side auth-verification client (JWT checks, admin
// lookups). Service role first; the anon key is sufficient for auth checks
// because the GoTrue /user endpoint only needs a valid apikey.
const SERVER_AUTH_KEY = (!SERVICE_KEY_ISSUE && SUPABASE_SERVICE_KEY)
  || (!ANON_KEY_ISSUE && SUPABASE_ANON_KEY)
  || '';

if (SUPABASE_URL) {
  console.log('[Supabase] URL configured:', SUPABASE_URL);
} else {
  console.warn('[Supabase] WARNING: VITE_SUPABASE_URL is not set or invalid');
}
console.log('[data] driver:', db.DRIVER,
  db.DRIVER === 'json' ? '(bundled JSON store)' : '(will fall back to the JSON store if the schema is not applied)');

const PUBLIC = process.env.NODE_ENV === 'production' && fs.existsSync(path.join(__dirname, 'dist'))
  ? path.join(__dirname, 'dist')
  : __dirname;

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ensure data is present on boot (seed once, non-destructive).
// Only needed for the JSON fallback driver — with a database configured the
// database is the source of truth and seeding it from a file would be wrong.
if (db.DRIVER === 'json') seed();

// On-the-fly premium product / hero SVG imagery
app.get('/img/asset.svg', (req, res) => {
  const svg = asset(req.url, req.query);
  res.type('image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

app.use(express.static(PUBLIC, { maxAge: 0, etag: false }));

// Inject Supabase config into admin.html for browser use.
// Tries several locations so it works locally (repo root / dist) and inside
// the serverless bundle alike.
function serveAdminHTML(req, res) {
  const candidates = [
    path.join(PUBLIC, 'admin.html'),
    path.join(__dirname, 'admin.html'),
  ];
  const file = candidates.find(f => fs.existsSync(f));
  if (!file) {
    console.error('[Admin] admin.html not found in:', candidates.join(', '));
    return res.status(404).send('Admin page not found');
  }
  let html = fs.readFileSync(file, 'utf8');
  html = html.replace('%VITE_SUPABASE_URL%', SUPABASE_URL);
  html = html.replace('%VITE_SUPABASE_ANON_KEY%', SUPABASE_ANON_KEY);
  res.type('html').send(html);
}
app.get('/admin.html', serveAdminHTML);

// Client-safe Supabase configuration for the admin SPA.
// On Vercel the admin page is served as a static file, so the
// %VITE_SUPABASE_URL% / %VITE_SUPABASE_ANON_KEY% placeholders in admin.html
// are not replaced by the server. The admin SPA fetches this endpoint in
// that case. The anon key is a public key by design (RLS protects data);
// the service role key is never exposed here. A corrupted key is served as
// empty — it could never authenticate anyway, and shipping it to the browser
// would only reproduce the same ByteString failure client-side.
app.get('/api/admin/config', (req, res) => {
  res.json({
    url: SUPABASE_URL || '',
    anonKey: ANON_KEY_ISSUE ? '' : (SUPABASE_ANON_KEY || ''),
  });
});

// Diagnostic endpoint to check Supabase configuration (no secrets exposed)
app.get('/api/admin/diagnose', async (req, res) => {
  const rawUrl = process.env.VITE_SUPABASE_URL || '';
  const hasAnonKey = !!(process.env.VITE_SUPABASE_ANON_KEY || '');
  const hasServiceKey = !!(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  const urlPattern = /^https:\/\/[a-z0-9]+\.supabase\.co$/i;
  let urlHasPath = false;
  try { urlHasPath = !!rawUrl && new URL(rawUrl).pathname !== '/'; } catch (e) { urlHasPath = false; }

  // ?probe=1 — actually read the catalog so the health state below reflects a
  // real attempt on THIS instance (serverless instances are cold per request).
  let probe = null;
  if (req.query.probe) {
    const t0 = Date.now();
    try {
      const catalog = await db.getCatalog();
      const orders = await db.getOrders({ limit: 1000 });
      probe = {
        ok: true,
        ms: Date.now() - t0,
        products: catalog.products.length,
        categories: catalog.categories.length,
        brands: catalog.brands.length,
        bundles: catalog.bundles.length,
        heroSlides: catalog.heroSlides.length,
        homeSections: catalog.homeSections.length,
        orders: orders.length,
      };
    } catch (e) {
      probe = { ok: false, ms: Date.now() - t0, error: e.message };
    }
    probe.servedBy = db.health().activeDriver;
    probe.health = db.health();
  }

  const detail = db.info();
  // Actionable, human-readable list of everything that is blocking the
  // app from using the real Supabase database right now (empty = healthy).
  const issues = [];
  if (detail.serviceKeyIssue) issues.push(detail.serviceKeyIssue);
  if (detail.anonKeyIssue) issues.push(detail.anonKeyIssue);
  // The last remote failure lands in health().remoteError (the probe's own
  // error only covers probe-level failures); check both.
  const lastRemoteError = detail.remoteError || (probe && probe.error) || '';
  const schemaMissing = /does not exist|PGRST205|PGRST202|could not find the table/i.test(lastRemoteError);
  if (schemaMissing) {
    issues.push('The Supabase schema has not been applied to this project. '
      + 'Run supabase/full_database_seed.sql in Supabase → SQL Editor (creates every table and loads the existing catalog).');
  } else if (db.health().usingJsonFallback && detail.remoteError) {
    issues.push(`The remote Supabase store is unreachable (${detail.remoteError}) — the bundled JSON store is serving instead.`);
  }

  res.json({
    probe,
    issues,
    rawEnvUrl: rawUrl || '(not set)',
    sanitizedUrl: SUPABASE_URL || '(empty)',
    urlIsValid: urlPattern.test(SUPABASE_URL),
    urlHasPath,
    anonKeyPresent: hasAnonKey,
    serviceKeyPresent: hasServiceKey,
    serviceKeyIssue: detail.serviceKeyIssue,
    anonKeyIssue: detail.anonKeyIssue,
    serverKeyRole: detail.serverKeyRole,
    serverClientAvailable: !!getServerSb(),
    dataDriver: db.DRIVER,
    dataDriverActive: db.health().activeDriver,
    usingJsonFallback: db.health().usingJsonFallback,
    remoteState: db.health().remoteState,
    remoteError: db.health().remoteError,
    dataDriverDetail: detail,
    publicDir: PUBLIC,
    distExists: fs.existsSync(path.join(__dirname, 'dist')),
    env: process.env.NODE_ENV || 'development',
  });
});

// ---------------------------------------------------------------------------
// SUPABASE ADMIN AUTH — JWT-verified, no hardcoded passwords
// ---------------------------------------------------------------------------

// Lazy-load Supabase server client (service role when usable, anon key as a
// fallback — both are valid apikeys for the GoTrue auth endpoints).
let _serverSb = null;
function getServerSb() {
  if (_serverSb) return _serverSb;
  if (!SUPABASE_URL || !SERVER_AUTH_KEY) return null;
  try {
    const { createClient } = require('@supabase/supabase-js');
    _serverSb = createClient(SUPABASE_URL, SERVER_AUTH_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  } catch (e) {
    console.warn('[server] @supabase/supabase-js not available:', e.message);
    return null;
  }
  return _serverSb;
}

// Extract Supabase JWT from request (cookie or Authorization header)
function getAuthToken(req) {
  const cookieToken = req.cookies && req.cookies['sb-access-token'];
  if (cookieToken) return cookieToken;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return null;
}

// Local-only admin hook for the automated test suite. It is inert unless
// ADMIN_DEV_TOKEN is set AND no real Supabase project is configured, so it can
// never open the production admin panel.
function devAdminUser(req) {
  const token = process.env.ADMIN_DEV_TOKEN;
  if (!token) return null;
  if (/\.supabase\.co$/i.test(SUPABASE_URL)) return null;
  const supplied = req.headers['x-admin-dev-token'];
  return supplied && supplied === token ? { id: 'dev-admin', email: 'dev@localhost' } : null;
}

// Guard: verify Supabase JWT and admin_users membership
async function requireAdmin(req, res, next) {
  const dev = devAdminUser(req);
  if (dev) { req.adminUser = dev; return next(); }

  const token = getAuthToken(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized — no token' });

  const sb = getServerSb();
  if (!sb) {
    return res.status(503).json({
      error: 'Supabase is not configured on this server (no usable VITE_SUPABASE_URL + key pair).',
      hint: SERVICE_KEY_ISSUE || ANON_KEY_ISSUE || 'Check /api/admin/diagnose',
    });
  }

  try {
    // supabase-js v2 exposes this as auth.getUser(jwt).
    const { data: { user }, error } = await sb.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid session' });

    const { data: adminRecord } = await sb
      .from('admin_users')
      .select('id')
      .eq('id', user.id)
      .single();

    if (!adminRecord) return res.status(403).json({ error: 'Not an admin user' });

    req.adminUser = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

// Admin session check (for the admin SPA to verify auth on load)
app.get('/api/admin/session', async (req, res) => {
  const dev = devAdminUser(req);
  if (dev) return res.json({ authenticated: true, email: dev.email });

  const token = getAuthToken(req);
  if (!token) return res.json({ authenticated: false });

  const sb = getServerSb();
  if (!sb) return res.json({ authenticated: false });

  try {
    const { data: { user } } = await sb.auth.getUser(token);
    if (!user) return res.json({ authenticated: false });

    const { data: adminRecord } = await sb
      .from('admin_users')
      .select('id')
      .eq('id', user.id)
      .single();

    res.json({ authenticated: !!adminRecord, email: user.email });
  } catch (e) {
    res.json({ authenticated: false });
  }
});

// ---------------------------------------------------------------------------
// PUBLIC DATA API — everything the storefront needs in one payload
// ---------------------------------------------------------------------------
app.get('/api/data', async (req, res) => {
  try {
    const catalog = await db.getCatalog();
    res.set('Cache-Control', 'no-store');
    res.json(db.publicPayload(catalog));
  } catch (e) {
    console.error('[api/data]', e.message);
    res.status(500).json({ error: 'Failed to load store data.' });
  }
});

// ---------------------------------------------------------------------------
// ORDERS (guest checkout, COD only)
// ---------------------------------------------------------------------------
app.post('/api/orders', async (req, res) => {
  try {
    const catalog = await db.getCatalog();
    const body = req.body || {};
    const { customer, cart } = body;

    if (!customer || !customer.fullName || !customer.phone || !customer.city || !customer.address) {
      return res.status(400).json({ error: 'Missing required order fields.' });
    }
    // Server-side character limit validation
    const limits = { fullName: 60, phone: 20, city: 40, address: 200, area: 40, notes: 300 };
    for (const [field, max] of Object.entries(limits)) {
      if (customer[field] && String(customer[field]).length > max) {
        return res.status(400).json({ error: `${field} exceeds maximum length of ${max} characters.` });
      }
    }
    if (!Array.isArray(cart) || !cart.length) {
      return res.status(400).json({ error: 'Your cart is empty.' });
    }

    // Validate against real store + recalculate totals server-side (never trust client)
    const validItems = [];
    let subtotal = 0;

    for (const item of cart) {
      const p = catalog.products.find(x => x.id === item.productId);
      if (!p) continue;
      const qty = Math.max(1, parseInt(item.qty) || 1);
      let shape = item.keyShape || '';
      const shapeAvailable = (p.keyShapes || []).find(sh => sh.shape === shape && sh.available);
      if (!shapeAvailable) shape = '';
      const linePrice = p.price * qty;
      subtotal += linePrice;
      const fit = (item.fitment && (item.fitment.brand || item.fitment.model || item.fitment.year))
        ? { brand: item.fitment.brand || '', model: item.fitment.model || '', year: (item.fitment.year != null ? String(item.fitment.year) : '') }
        : null;
      validItems.push({
        productId: p.id, name_en: p.name_en, name_ar: p.name_ar,
        slug: p.slug, category: p.category, brandSlug: p.brandSlug,
        keyShape: shape, qty,
        price: p.price, lineTotal: linePrice,
        image: (p.images && p.images[0]) || '/img/detail_a.png',
        fitment: fit,
      });
    }

    if (!validItems.length) return res.status(400).json({ error: 'Your cart is empty.' });

    // Bundle discount — a full brand set (Key Case + Key Holder + Medal) present
    // in the cart unlocks the bundle price. Otherwise no discount.
    const bundleApplied = {};
    for (const item of validItems) {
      if (bundleApplied[item.brandSlug]) continue;
      const b = catalog.bundles.find(x => x.brandSlug === item.brandSlug && x.active !== false);
      if (!b) continue;
      const owned = validItems.filter(v => v.brandSlug === item.brandSlug);
      const hasCase = owned.some(v => v.category === 'keycase');
      const hasHolder = owned.some(v => v.category === 'keyholder');
      const hasMedal = owned.some(v => v.category === 'medal');
      if (hasCase && hasHolder && hasMedal) {
        bundleApplied[item.brandSlug] = { bundleId: b.id, discount: Math.max(0, b.normalTotal - b.bundlePrice) };
      }
    }
    const bundleDiscount = Object.values(bundleApplied).reduce((s, x) => s + x.discount, 0);

    const settings = catalog.settings || {};
    const freeShipThreshold = settings.freeShippingThreshold || 0;
    const deliveryFee = (settings.shippingFee || 0) && subtotal >= freeShipThreshold ? 0 : (settings.shippingFee || 0);
    const total = subtotal - bundleDiscount + deliveryFee;

    const nowIso = new Date().toISOString();
    const order = {
      id: 'ORD-' + Date.now().toString().slice(-8),
      createdAt: nowIso,
      customer: {
        fullName: customer.fullName, phone: customer.phone,
        email: customer.email || '',
        city: customer.city, area: customer.area || '',
        address: customer.address, notes: customer.notes || '',
      },
      items: validItems,
      subtotal: Math.round(subtotal),
      bundleDiscount: Math.round(bundleDiscount),
      deliveryFee,
      total: Math.round(total),
      status: 'Pending',
      statusHistory: [{ status: 'Pending', at: nowIso }],
      payment: 'Cash on Delivery',
      currency: settings.currency || 'EGP',
      source: 'storefront',
    };

    // Durable write: orders + order_items in Supabase.
    await db.createOrder(order);
    res.json({ ok: true, orderId: order.id, total: Math.round(total) });
  } catch (e) {
    console.error('[api/orders]', e.message);
    res.status(500).json({ error: 'Could not save the order.' });
  }
});

// ---------------------------------------------------------------------------
// PRE-ORDERS (no payment collected)
// ---------------------------------------------------------------------------
app.post('/api/preorders', async (req, res) => {
  try {
    const catalog = await db.getCatalog();
    const body = req.body || {};
    const { productId, keyShape, customer } = body;
    if (!productId || !customer || !customer.fullName || !customer.phone) {
      return res.status(400).json({ error: 'Missing required pre-order fields.' });
    }
    const preLimits = { fullName: 60, phone: 20, city: 40, address: 200 };
    for (const [field, max] of Object.entries(preLimits)) {
      if (customer[field] && String(customer[field]).length > max) {
        return res.status(400).json({ error: `${field} exceeds maximum length of ${max} characters.` });
      }
    }
    const p = catalog.products.find(x => x.id === productId);
    if (!p) return res.status(404).json({ error: 'Product not found.' });
    const rec = {
      id: 'PRE-' + Date.now().toString().slice(-8),
      createdAt: new Date().toISOString(),
      productId, name_en: p.name_en, name_ar: p.name_ar, brandSlug: p.brandSlug,
      keyShape: keyShape || '',
      customer: { fullName: customer.fullName, phone: customer.phone, city: customer.city || '', address: customer.address || '' },
      status: 'Pending',
    };
    await db.saveRecord('preorders', rec);
    res.json({ ok: true, preorderId: rec.id });
  } catch (e) {
    console.error('[api/preorders]', e.message);
    res.status(500).json({ error: 'Could not save the pre-order.' });
  }
});

// ---------------------------------------------------------------------------
// CONTACT / NEWSLETTER MESSAGES
// ---------------------------------------------------------------------------
app.post('/api/messages', async (req, res) => {
  try {
    const body = req.body || {};
    const rec = Object.assign({ id: 'MSG-' + Date.now().toString().slice(-6), createdAt: new Date().toISOString() }, body);
    await db.saveRecord('messages', rec);
    res.json({ ok: true });
  } catch (e) {
    console.error('[api/messages]', e.message);
    res.status(500).json({ error: 'Could not save the message.' });
  }
});

// ---------------------------------------------------------------------------
// ADMIN DATA MANAGEMENT
// Every write goes through lib/db.js, so the storefront and the admin panel
// always read the same rows.
// ---------------------------------------------------------------------------
app.get('/api/admin/data', requireAdmin, async (req, res) => {
  try {
    const data = await db.getAdminData();
    // _meta tells the admin SPA which store actually served the payload, so
    // an empty-looking dashboard can never be mistaken for an empty database.
    const h = db.health();
    res.json(Object.assign({}, data, {
      _meta: {
        driver: h.activeDriver,
        usingJsonFallback: h.usingJsonFallback,
        remoteState: h.remoteState,
        remoteError: h.remoteError,
        serviceKeyIssue: db.serviceKeyIssue,
        anonKeyIssue: db.anonKeyIssue,
      },
    }));
  } catch (e) {
    console.error('[api/admin/data]', e.message);
    res.status(500).json({ error: 'Failed to load admin data.' });
  }
});

// Light-weight polling endpoint so the Orders page can pick up new customer
// orders without re-downloading the whole catalog.
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    res.json({ orders: await db.getOrders({ limit }) });
  } catch (e) {
    console.error('[api/admin/orders]', e.message);
    res.status(500).json({ error: 'Failed to load orders.' });
  }
});

app.get('/api/admin/order/:id', requireAdmin, async (req, res) => {
  try {
    const order = await db.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    res.json(order);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load order.' });
  }
});

app.post('/api/admin/save', requireAdmin, async (req, res) => {
  try {
    const { collection, record } = req.body || {};
    if (!record || !record.id) return res.status(400).json({ error: 'Record and record.id are required.' });
    const saved = await db.saveRecord(collection, record);
    res.json({ ok: true, record: saved });
  } catch (e) {
    console.error('[api/admin/save]', e.message);
    res.status(400).json({ error: e.message });
  }
});

// Partial update: patches the given fields and keeps everything else.
app.post('/api/admin/update', requireAdmin, async (req, res) => {
  try {
    const { collection, id, updates } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required.' });
    const saved = await db.patchRecord(collection, id, updates || {});
    res.json({ ok: true, record: saved });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/admin/delete', requireAdmin, async (req, res) => {
  try {
    const { collection, id } = req.body || {};
    await db.deleteRecord(collection, id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/admin/reorder', requireAdmin, async (req, res) => {
  try {
    const { collection, ids } = req.body || {};
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be an array.' });
    await db.reorder(collection, ids);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const { settings, promoBar } = req.body || {};
    if (settings) await db.saveSettings(settings);
    if (promoBar) await db.savePromoBar(promoBar);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/admin/lang', requireAdmin, async (req, res) => {
  try {
    const { dict } = req.body || {};
    if (dict) await db.saveLanguages(dict);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Upload an image (base64 data URL) and return a served URL. Used by the
// Homepage CMS for the hero banner and by product images.
app.post('/api/admin/upload', requireAdmin, (req, res) => {
  const { dataUrl } = req.body || {};
  if (!dataUrl || !/^data:image\//.test(dataUrl)) return res.status(400).json({ error: 'Invalid image data.' });
  const m = dataUrl.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'Invalid image data.' });
  const rawExt = m[1].toLowerCase();
  const ext = rawExt === 'svg+xml' ? 'svg' : rawExt === 'jpeg' ? 'jpg' : rawExt;
  const buf = Buffer.from(m[2], 'base64');
  try {
    const dir = path.join(PUBLIC, 'img', 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const fn = 'up_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7) + '.' + ext;
    fs.writeFileSync(path.join(dir, fn), buf);
    res.json({ ok: true, url: '/img/uploads/' + fn });
  } catch (e) {
    // Serverless filesystems are read-only: the admin can still paste any
    // public image URL, which is the durable option there.
    res.status(507).json({ error: 'File uploads are not writable on this host — paste a public image URL instead.' });
  }
});

app.post('/api/admin/order-status', requireAdmin, async (req, res) => {
  try {
    const { id, status } = req.body || {};
    const n = await db.setOrderStatus(id, status);
    if (!n) return res.status(404).json({ error: 'Order not found.' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/admin/preorder-status', requireAdmin, async (req, res) => {
  try {
    const { id, status } = req.body || {};
    const n = await db.updateRow('preorders', id, { status });
    if (!n) return res.status(404).json({ error: 'Pre-order not found.' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// SPA fallbacks
// ---------------------------------------------------------------------------
app.get('/admin/login', serveAdminHTML);
app.get('/admin', serveAdminHTML);
app.get(/^\/(?!api|img|css|js|admin).*/, (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

// Run only when invoked directly (e.g. `node server.js`). On Vercel this file
// is imported by the serverless handler /api/index.js, so we export the app
// instead of binding a port.
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SPINTO running on http://0.0.0.0:${PORT}`);
    if (db.DRIVER === 'json') console.warn('[data] no database configured — using the JSON store fallback.');
  });
}

module.exports = app;
module.exports.store = store;
