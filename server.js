// ============================================================================
// VILOCCI — Application server
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
const storage = require('./lib/storage');

const { seed } = require('./data/seed');
const { asset } = require('./lib/assets');
const mapping = require('./lib/mapping');
const discounts = require('./lib/discounts');

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

// The Customize car photo travels as a base64 data URL (the same client
// contract as the admin image upload), so that ONE route gets a bigger body
// budget. body-parser marks the request as parsed, so the global 4 MB parser
// below leaves it alone and every other route keeps the smaller limit.
app.use('/api/customize/requests', express.json({ limit: '12mb' }));
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
    customizeStorage: storage.info(),
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
// CART PRICING
// ---------------------------------------------------------------------------
// Shared by POST /api/orders and POST /api/validate-discount so the code the
// checkout quotes and the code the order is charged with are the same number.
// Every total is recomputed here from the catalog; the client is never trusted.

// Resolves the cart against the real catalog: unknown products are dropped,
// an unavailable key shape falls back to none, and a product that has colors
// requires a valid one. `colorError` is returned instead of answered so the
// caller can decide the status code.
function buildOrderItems(catalog, cart) {
  const validItems = [];
  let subtotal = 0;
  let colorError = null;

  for (const item of cart) {
    const p = catalog.products.find(x => x.id === item.productId);
    if (!p) continue;
    const qty = Math.max(1, parseInt(item.qty) || 1);
    let shape = item.keyShape || '';
    const shapeAvailable = (p.keyShapes || []).find(sh => sh.shape === shape && sh.available);
    if (!shapeAvailable) shape = '';

    // Color variant — resolved against the product's OWN admin-managed color
    // list (never trusted from the client). Products that have enabled
    // colors REQUIRE a valid selection; products without colors carry none.
    const selectableColors = mapping.activeColors(p);
    let color = null;
    if (selectableColors.length) {
      color = mapping.resolveProductColor(p, item.colorId !== undefined ? item.colorId : item.color);
      if (!color && !colorError) {
        colorError = `Please choose a color for "${p.name_en || p.id}".`;
        continue;
      }
    }

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
      color,
    });
  }

  return { validItems, subtotal, colorError };
}

// Bundle discount — a full brand set (Key Case + Key Holder + Medal) present
// in the cart unlocks the bundle price. Otherwise no discount.
function bundleDiscountFor(catalog, validItems) {
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
  return Object.values(bundleApplied).reduce((s, x) => s + x.discount, 0);
}

function deliveryFeeFor(settings, subtotal) {
  const freeShipThreshold = settings.freeShippingThreshold || 0;
  return (settings.shippingFee || 0) && subtotal >= freeShipThreshold ? 0 : (settings.shippingFee || 0);
}

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
    const { validItems, subtotal, colorError } = buildOrderItems(catalog, cart);
    if (colorError) return res.status(400).json({ error: colorError });
    if (!validItems.length) return res.status(400).json({ error: 'Your cart is empty.' });

    const bundleDiscount = bundleDiscountFor(catalog, validItems);

    // Discount code — re-validated here for the same reason every other total
    // is: the browser may claim any code and any amount it likes. The codes
    // come from Admin -> Discounts and are read server-side, so an unknown,
    // inactive, expired, exhausted or under-threshold code is simply refused.
    let codeDiscount = 0;
    let appliedCode = null;
    const requestedCode = discounts.normalizeCode(body.discountCode);
    if (requestedCode) {
      const codes = await db.getDiscountCodes();
      const evaluated = discounts.evaluateDiscountCode(codes, requestedCode, { subtotal, bundleDiscount });
      if (!evaluated.ok) {
        return res.status(400).json({
          error: 'The discount code could not be applied to this order.',
          reason: evaluated.reason,
        });
      }
      codeDiscount = evaluated.discount;
      appliedCode = evaluated;
    }

    const settings = catalog.settings || {};
    const deliveryFee = deliveryFeeFor(settings, subtotal);
    const total = subtotal - bundleDiscount - codeDiscount + deliveryFee;

    const nowIso = new Date().toISOString();
    const paymentMethod = body.payment === 'InstaPay' ? 'InstaPay' : 'Cash on Delivery';
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
      // Recorded on the order object. The orders table has no column for it
      // (adding one would mean a production migration), so only `total` —
      // which already has the discount baked in — is durable. The code's own
      // used_count is incremented below, which is durable.
      discountCode: appliedCode ? appliedCode.code : null,
      discount: Math.round(codeDiscount),
      deliveryFee,
      total: Math.round(total),
      status: 'Pending',
      statusHistory: [{ status: 'Pending', at: nowIso }],
      payment: paymentMethod,
      currency: settings.currency || 'EGP',
      source: 'storefront',
    };

    // Durable write: orders + order_items in Supabase.
    await db.createOrder(order);

    // Count the redemption only once the order itself is safe. If the counter
    // cannot be written the customer still keeps the price they were shown.
    if (appliedCode) await db.redeemDiscountCode(appliedCode.code);

    res.json({
      ok: true,
      orderId: order.id,
      total: Math.round(total),
      discount: Math.round(codeDiscount),
      discountCode: appliedCode ? appliedCode.code : null,
    });
  } catch (e) {
    console.error('[api/orders]', e.message);
    res.status(500).json({ error: 'Could not save the order.' });
  }
});

// ---------------------------------------------------------------------------
// DISCOUNT CODES
// ---------------------------------------------------------------------------
// POST /api/validate-discount
//   body: { code, cart? }
//   200:  { ok:true,  code, type, value, discount, subtotal, bundleDiscount }
//         { ok:false, reason }   — reason is a token, never customer copy
//
// The codes live in the `discount_codes` table managed by Admin -> Discounts.
// They are deliberately NOT served by /api/data: a code is only ever checked
// here, server-side. Sending `cart` lets the server price it itself; without
// one the caller's `subtotal` is used (and the order endpoint re-checks it
// anyway, so a dishonest hint cannot buy anything).
app.post('/api/validate-discount', async (req, res) => {
  try {
    const body = req.body || {};
    const code = discounts.normalizeCode(body.code);

    if (!code) return res.status(400).json({ ok: false, reason: 'invalid' });
    if (code.length > discounts.MAX_CODE_LENGTH) return res.status(400).json({ ok: false, reason: 'invalid' });

    const catalog = await db.getCatalog();

    let subtotal = 0;
    let bundleDiscount = 0;
    if (Array.isArray(body.cart) && body.cart.length) {
      const priced = buildOrderItems(catalog, body.cart);
      subtotal = priced.subtotal;
      bundleDiscount = bundleDiscountFor(catalog, priced.validItems);
    } else {
      subtotal = Math.max(0, Number(body.subtotal) || 0);
      bundleDiscount = Math.max(0, Number(body.bundleDiscount) || 0);
    }

    const codes = await db.getDiscountCodes();
    const evaluated = discounts.evaluateDiscountCode(codes, code, { subtotal, bundleDiscount });

    if (!evaluated.ok) {
      // A normal outcome, not a server error: the customer simply cannot use
      // this code. Returning 200 keeps the checkout flow on one happy path.
      return res.json({
        ok: false,
        reason: evaluated.reason,
        code: evaluated.code || code,
        minOrder: evaluated.minOrder || 0,
      });
    }

    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      code: evaluated.code,
      type: evaluated.type,
      value: evaluated.value,
      minOrder: evaluated.minOrder,
      discount: evaluated.discount,
      subtotal: Math.round(subtotal),
      bundleDiscount: Math.round(bundleDiscount),
    });
  } catch (e) {
    console.error('[api/validate-discount]', e.message);
    res.status(500).json({ ok: false, reason: 'error' });
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
// CUSTOMIZE — public customer flow
// ---------------------------------------------------------------------------
// Reads the categories the Admin switched ON for Customize (never a hard-coded
// list, never categories.active) and stores customer requests server-side.
const CUSTOMIZE_STATUSES = ['New', 'Contacted', 'In Progress', 'Completed', 'Cancelled'];
const CUSTOMIZE_CONTACT_METHODS = ['Phone', 'WhatsApp', 'Email'];
const CUSTOMIZE_LIMITS = {
  category: 60,
  carBrand: 60,
  carModel: 60,
  modelYear: 10,
  carDetails: 600,
  customizationRequest: 2000,
  fullName: 60,
  phone: 20,
  whatsapp: 20,
  email: 120,
  additionalNotes: 600,
  clientKey: 80,
};

// Trim, drop control characters and cap the length before anything is stored.
function sanitizeText(value, max) {
  if (value === undefined || value === null) return '';
  let s = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
  s = s.replace(/\r\n?/g, '\n').trim();
  return s.length > max ? s.slice(0, max) : s;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[\d\s+\-()]{6,20}$/;

function customizeRequestId() {
  const stamp = Date.now().toString(36).toUpperCase().slice(-6);
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `CUS-${stamp}${rand}`;
}

// The categories the customer may pick (admin-controlled, live).
app.get('/api/customize/categories', async (req, res) => {
  try {
    const categories = await db.getCustomizeCategories();
    res.set('Cache-Control', 'no-store');
    res.json({
      available: categories.length > 0,
      categories,
      contactMethods: CUSTOMIZE_CONTACT_METHODS,
    });
  } catch (e) {
    console.error('[api/customize/categories]', e.message);
    res.status(500).json({ error: 'Could not load the customization categories.' });
  }
});

// Public submission. Everything is validated, sanitized and stored SERVER-side
// (the photo goes into the private bucket with the service-role key; that key
// never reaches the browser).
app.post('/api/customize/requests', async (req, res) => {
  try {
    const body = req.body || {};
    const f = {
      category: sanitizeText(body.category, CUSTOMIZE_LIMITS.category),
      carBrand: sanitizeText(body.carBrand, CUSTOMIZE_LIMITS.carBrand),
      carModel: sanitizeText(body.carModel, CUSTOMIZE_LIMITS.carModel),
      modelYear: sanitizeText(body.modelYear, CUSTOMIZE_LIMITS.modelYear),
      carDetails: sanitizeText(body.carDetails, CUSTOMIZE_LIMITS.carDetails),
      customizationRequest: sanitizeText(body.customizationRequest, CUSTOMIZE_LIMITS.customizationRequest),
      fullName: sanitizeText(body.fullName, CUSTOMIZE_LIMITS.fullName),
      phone: sanitizeText(body.phone, CUSTOMIZE_LIMITS.phone),
      whatsapp: sanitizeText(body.whatsapp, CUSTOMIZE_LIMITS.whatsapp),
      email: sanitizeText(body.email, CUSTOMIZE_LIMITS.email),
      additionalNotes: sanitizeText(body.additionalNotes, CUSTOMIZE_LIMITS.additionalNotes),
      clientKey: sanitizeText(body.clientKey, CUSTOMIZE_LIMITS.clientKey),
      preferredContact: sanitizeText(body.preferredContact, 20) || 'Phone',
      locale: sanitizeText(body.locale, 5) === 'ar' ? 'ar' : 'en',
    };

    const errors = {};
    if (!f.category) errors.category = 'Please choose a category.';
    if (!body.carImage || typeof body.carImage !== 'string') errors.carImage = 'A photo of your car is required.';
    if (!f.carBrand) errors.carBrand = 'Car brand is required.';
    if (!f.carModel) errors.carModel = 'Car model is required.';
    if (!f.modelYear) errors.modelYear = 'Model year is required.';
    else if (!/^\d{4}$/.test(f.modelYear)) errors.modelYear = 'Enter a 4-digit model year.';
    if (!f.customizationRequest) errors.customizationRequest = 'Tell us what you would like us to customize.';
    else if (f.customizationRequest.length < 10) errors.customizationRequest = 'Please describe your request in at least 10 characters.';
    if (!f.fullName) errors.fullName = 'Full name is required.';
    if (!f.phone) errors.phone = 'Phone number is required.';
    else if (!PHONE_RE.test(f.phone)) errors.phone = 'Enter a valid phone number.';
    if (f.whatsapp && !PHONE_RE.test(f.whatsapp)) errors.whatsapp = 'Enter a valid WhatsApp number.';
    if (f.email && !EMAIL_RE.test(f.email)) errors.email = 'Enter a valid email address.';
    if (!CUSTOMIZE_CONTACT_METHODS.includes(f.preferredContact)) {
      errors.preferredContact = 'Choose how we should contact you.';
    } else if (f.preferredContact === 'WhatsApp' && !f.whatsapp) {
      errors.whatsapp = 'Add your WhatsApp number so we can reach you there.';
    }
    if (Object.keys(errors).length) {
      return res.status(400).json({ error: 'Please check the highlighted fields.', errors });
    }

    // Only a category the admin has enabled for Customize is accepted.
    const available = await db.getCustomizeCategories();
    const category = available.find((c) => c.id === f.category || c.slug === f.category);
    if (!category) {
      return res.status(400).json({
        error: 'That category is not available for customization right now.',
        errors: { category: 'This category is not available for customization.' },
      });
    }

    // Duplicate guard — a stable per-form key makes a retry idempotent.
    const existing = await db.findCustomizeRequestByClientKey(f.clientKey);
    if (existing) {
      return res.json({ ok: true, requestId: existing.id, duplicate: true });
    }

    // Validate the photo, then store it server-side in the PRIVATE bucket.
    let parsedImage;
    try {
      parsedImage = storage.parseImageDataUrl(body.carImage);
    } catch (err) {
      return res.status(400).json({ error: err.message, errors: { carImage: err.message } });
    }

    const id = customizeRequestId();
    const upload = await storage.uploadCarPhoto(body.carImage, { requestId: id });

    const record = {
      id,
      createdAt: new Date().toISOString(),
      categoryId: category.id,
      categorySlug: category.slug || category.id,
      categoryNameEn: category.name_en || category.id,
      categoryNameAr: category.name_ar || '',
      carImagePath: upload.ok ? upload.path : null,
      carImageMime: parsedImage.mime,
      carImageSize: parsedImage.size,
      carImageData: upload.ok ? null : body.carImage,
      carBrand: f.carBrand,
      carModel: f.carModel,
      modelYear: f.modelYear,
      carDetails: f.carDetails,
      customizationRequest: f.customizationRequest,
      customerName: f.fullName,
      phone: f.phone,
      whatsapp: f.whatsapp,
      email: f.email,
      preferredContact: f.preferredContact,
      additionalNotes: f.additionalNotes,
      status: 'New',
      adminNotes: '',
      clientKey: f.clientKey || null,
      locale: f.locale,
      source: 'storefront',
    };

    await db.createCustomizeRequest(record);
    console.log(`[customize] request ${id} stored (photo: ${upload.ok ? 'private storage' : 'inline fallback'})`);
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      requestId: id,
      photoStored: upload.ok ? 'private-storage' : 'inline-fallback',
    });
  } catch (e) {
    console.error('[api/customize/requests]', e.message);
    res.status(500).json({ error: 'Could not save your customization request. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// CUSTOMIZE — admin (settings + requests). Every route requires an admin JWT.
// ---------------------------------------------------------------------------
app.get('/api/admin/customize/settings', requireAdmin, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await db.getCustomizeConfig());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/customize/settings', requireAdmin, async (req, res) => {
  try {
    const { categories } = req.body || {};
    const config = await db.saveCustomizeSettings({ categories: categories || {} });
    res.json({ ok: true, customize: config });
  } catch (e) {
    console.error('[api/admin/customize/settings]', e.message);
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/admin/customize/requests', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 300, 1000);
    res.set('Cache-Control', 'no-store');
    res.json({ requests: await db.getCustomizeRequests({ limit }) });
  } catch (e) {
    console.error('[api/admin/customize/requests]', e.message);
    res.status(/does not exist|PGRST/i.test(e.message) ? 503 : 500).json({
      error: 'Could not load the customization requests.',
      detail: e.message,
      hint: /does not exist|PGRST/i.test(e.message)
        ? 'The customize_requests table is missing — run `npm run migrate -- --apply`.'
        : undefined,
    });
  }
});

app.get('/api/admin/customize/requests/:id', requireAdmin, async (req, res) => {
  try {
    const record = await db.getCustomizeRequest(req.params.id);
    if (!record) return res.status(404).json({ error: 'Request not found.' });
    const summary = require('./lib/mapping').customizeRequestSummary(record);
    summary.photoKind = record.carImagePath ? 'storage' : (record.carImageData ? 'inline' : 'none');
    res.set('Cache-Control', 'no-store');
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Signed URL for the private car photo. Admins only, short-lived, never cached.
app.get('/api/admin/customize/requests/:id/photo', requireAdmin, async (req, res) => {
  try {
    const record = await db.getCustomizeRequest(req.params.id);
    if (!record) return res.status(404).json({ error: 'Request not found.' });
    res.set('Cache-Control', 'no-store');
    if (record.carImagePath) {
      try {
        const url = await storage.signedUrl(record.carImagePath);
        if (url) {
          return res.json({
            url,
            kind: 'signed',
            expiresIn: storage.info().signedUrlTtlSeconds,
            mime: record.carImageMime || null,
          });
        }
      } catch (e) {
        console.warn('[api/admin/customize/requests/photo] signing failed:', e.message);
      }
    }
    if (record.carImageData) {
      return res.json({ url: record.carImageData, kind: 'inline', mime: record.carImageMime || null });
    }
    return res.status(404).json({ error: 'This request has no photo.' });
  } catch (e) {
    res.status(500).json({ error: 'Could not open the photo.' });
  }
});

app.post('/api/admin/customize/requests/:id', requireAdmin, async (req, res) => {
  try {
    const { status, admin_notes: adminNotes } = req.body || {};
    const patch = {};
    if (status !== undefined) {
      // Validated here as well as in the data layer so a typo can never reach
      // the database (and can never look like a database failure).
      if (!CUSTOMIZE_STATUSES.includes(String(status))) {
        return res.status(400).json({ error: `Unknown status: ${status}` });
      }
      patch.status = String(status);
    }
    if (adminNotes !== undefined) patch.admin_notes = sanitizeText(adminNotes, 2000);
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update.' });
    const n = await db.updateCustomizeRequest(req.params.id, patch);
    if (!n) return res.status(404).json({ error: 'Request not found.' });
    const record = await db.getCustomizeRequest(req.params.id);
    res.json({ ok: true, request: require('./lib/mapping').customizeRequestSummary(record) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/admin/customize/requests/:id/delete', requireAdmin, async (req, res) => {
  try {
    const n = await db.deleteCustomizeRequest(req.params.id);
    if (!n) return res.status(404).json({ error: 'Request not found.' });
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
    console.log(`VILOCCI running on http://0.0.0.0:${PORT}`);
    if (db.DRIVER === 'json') console.warn('[data] no database configured — using the JSON store fallback.');
  });
}

module.exports = app;
module.exports.store = store;
