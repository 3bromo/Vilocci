// ============================================================================
// SPINTO — Application server
// Serves the storefront + admin SPA and exposes a single data API.
// Admin authentication uses Supabase Auth (JWT-verified, no hardcoded passwords).
// ============================================================================
'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const store = require('./lib/store');

const { seed } = require('./data/seed');
const { asset } = require('./lib/assets');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase configuration (required for admin auth)
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const PUBLIC = process.env.NODE_ENV === 'production' && fs.existsSync(path.join(__dirname, 'dist'))
  ? path.join(__dirname, 'dist')
  : __dirname;

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ensure data is present on boot (seed once, non-destructive)
seed();

// On-the-fly premium product / hero SVG imagery
app.get('/img/asset.svg', (req, res) => {
  const svg = asset(req.url, req.query);
  res.type('image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

app.use(express.static(PUBLIC, { maxAge: 0, etag: false }));

// Inject Supabase config into admin.html for browser use
function serveAdminHTML(req, res) {
  let html = fs.readFileSync(path.join(PUBLIC, 'admin.html'), 'utf8');
  html = html.replace('%VITE_SUPABASE_URL%', SUPABASE_URL);
  html = html.replace('%VITE_SUPABASE_ANON_KEY%', SUPABASE_ANON_KEY);
  res.type('html').send(html);
}
app.get('/admin.html', serveAdminHTML);

// ---------------------------------------------------------------------------
// SUPABASE ADMIN AUTH — JWT-verified, no hardcoded passwords
// ---------------------------------------------------------------------------

// Lazy-load Supabase server client (service role for admin verification)
let _serverSb = null;
function getServerSb() {
  if (_serverSb) return _serverSb;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  // Dynamic import to avoid bundling issues
  try {
    const { createClient } = require('@supabase/supabase-js');
    _serverSb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
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
  // Check cookie first (set by Supabase client)
  const cookieToken = req.cookies && req.cookies['sb-access-token'];
  if (cookieToken) return cookieToken;
  // Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return null;
}

// Guard: verify Supabase JWT and admin_users membership
async function requireAdmin(req, res, next) {
  const token = getAuthToken(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized — no token' });

  const sb = getServerSb();
  if (!sb) return res.status(503).json({ error: 'Supabase not configured on server' });

  try {
    // Verify the JWT and get user
    const { data: { user }, error } = await sb.auth.admin.getUserByToken(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid session' });

    // Check admin_users table
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
  const token = getAuthToken(req);
  if (!token) return res.json({ authenticated: false });

  const sb = getServerSb();
  if (!sb) return res.json({ authenticated: false });

  try {
    const { data: { user } } = await sb.auth.admin.getUserByToken(token);
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
function publicPayload() {
  const db = store.load();
  const langs = db.languages;
  return {
    settings: db.settings,
    languages: langs,
    promoBar: db.promoBar && db.promoBar.enabled ? db.promoBar : null,
    heroSlides: db.heroSlides.filter(s => s.active).sort((a,b)=>a.order-b.order),
    homeSections: db.homeSections.filter(s=>s.enabled).sort((a,b)=>a.order-b.order),
    brands: db.brands.filter(b=>b.active).sort((a,b)=>a.order-b.order),
    bundles: db.bundles.filter(b=>b.active),
    products: db.products.filter(p=>p.active),
  };
}

app.get('/api/data', (req, res) => {
  res.json(publicPayload());
});

// ---------------------------------------------------------------------------
// ORDERS (guest checkout, COD only)
// ---------------------------------------------------------------------------
app.post('/api/orders', (req, res) => {
  const db = store.load();
  const body = req.body || {};
  const { customer, cart, totals } = body;

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
  let bundleDiscount = 0;
  let deliveryFee = 0;

  for (const item of cart) {
    const p = db.products.find(x => x.id === item.productId);
    if (!p) continue;
    const qty = Math.max(1, parseInt(item.qty) || 1);
    // shape must be available
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
    const b = db.bundles.find(x => x.brandSlug === item.brandSlug && x.active);
    if (!b) continue;
    const owned = validItems.filter(v => v.brandSlug === item.brandSlug);
    const hasCase = owned.some(v => v.category === 'keycase');
    const hasHolder = owned.some(v => v.category === 'keyholder');
    const hasMedal = owned.some(v => v.category === 'medal');
    const fullSet = hasCase && hasHolder && hasMedal;
    if (fullSet) {
      bundleApplied[item.brandSlug] = { bundleId: b.id, discount: Math.max(0, b.normalTotal - b.bundlePrice) };
    }
  }
  bundleDiscount = Object.values(bundleApplied).reduce((s, x) => s + x.discount, 0);

  const freeShipThreshold = db.settings.freeShippingThreshold || 0;
  deliveryFee = (db.settings.shippingFee || 0) && subtotal >= freeShipThreshold ? 0 : (db.settings.shippingFee || 0);

  const total = subtotal - bundleDiscount + deliveryFee;

  const order = {
    id: 'ORD-' + Date.now().toString().slice(-8),
    createdAt: new Date().toISOString(),
    customer: {
      fullName: customer.fullName, phone: customer.phone,
      city: customer.city, area: customer.area || '',
      address: customer.address, notes: customer.notes || '',
    },
    items: validItems,
    subtotal: Math.round(subtotal),
    bundleDiscount: Math.round(bundleDiscount),
    deliveryFee,
    total: Math.round(total),
    status: 'Pending',
    statusHistory: [{ status: 'Pending', at: new Date().toISOString() }],
    payment: 'Cash on Delivery',
  };

  db.orders.push(order);
  store.save();
  res.json({ ok: true, orderId: order.id, total: Math.round(total) });
});

// ---------------------------------------------------------------------------
// PRE-ORDERS (no payment collected)
// ---------------------------------------------------------------------------
app.post('/api/preorders', (req, res) => {
  const db = store.load();
  const body = req.body || {};
  const { productId, keyShape, customer } = body;
  if (!productId || !customer || !customer.fullName || !customer.phone) {
    return res.status(400).json({ error: 'Missing required pre-order fields.' });
  }
  // Server-side character limit validation for preorders
  const preLimits = { fullName: 60, phone: 20, city: 40, address: 200 };
  for (const [field, max] of Object.entries(preLimits)) {
    if (customer[field] && String(customer[field]).length > max) {
      return res.status(400).json({ error: `${field} exceeds maximum length of ${max} characters.` });
    }
  }
  const p = db.products.find(x => x.id === productId);
  if (!p) return res.status(404).json({ error: 'Product not found.' });
  const rec = {
    id: 'PRE-' + Date.now().toString().slice(-8),
    createdAt: new Date().toISOString(),
    productId, name_en: p.name_en, name_ar: p.name_ar, brandSlug: p.brandSlug,
    keyShape: keyShape || '',
    customer: { fullName: customer.fullName, phone: customer.phone, city: customer.city||'', address: customer.address||'' },
    status: 'Pending',
  };
  db.preorders.push(rec);
  store.save();
  res.json({ ok: true, preorderId: rec.id });
});

// ---------------------------------------------------------------------------
// CONTACT / NEWSLETTER MESSAGES
// ---------------------------------------------------------------------------
app.post('/api/messages', (req, res) => {
  const db = store.load();
  const body = req.body || {};
  db.messages.push(Object.assign({ id:'MSG-'+Date.now().toString().slice(-6), createdAt:new Date().toISOString() }, body));
  store.save();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// ADMIN DATA MANAGEMENT
// A generic, validated upsert/reorder/delete API over the shared store.
// ---------------------------------------------------------------------------
const COLLECTIONS = {
  products: { array: 'products', key: 'id' },
  brands: { array: 'brands', key: 'id' },
  bundles: { array: 'bundles', key: 'id' },
  heroSlides: { array: 'heroSlides', key: 'id' },
  homeSections: { array: 'homeSections', key: 'id' },
};

app.get('/api/admin/data', requireAdmin, (req, res) => {
  const db = store.load();
  res.json({
    products: db.products, brands: db.brands, bundles: db.bundles,
    heroSlides: db.heroSlides, homeSections: db.homeSections,
    orders: db.orders, preorders: db.preorders, messages: db.messages,
    settings: db.settings, promoBar: db.promoBar,
  });
});

app.post('/api/admin/save', requireAdmin, (req, res) => {
  const db = store.load();
  const { collection, record } = req.body || {};
  const cfg = COLLECTIONS[collection];
  if (!cfg) return res.status(400).json({ error: 'Unknown collection.' });
  const arr = db[cfg.array];
  const existing = arr.find(x => x[cfg.key] === record[cfg.key]);
  if (existing) Object.assign(existing, record);
  else arr.push(record);
  store.save();
  res.json({ ok: true, record: existing || record });
});

app.post('/api/admin/delete', requireAdmin, (req, res) => {
  const db = store.load();
  const { collection, id } = req.body || {};
  const cfg = COLLECTIONS[collection];
  if (!cfg) return res.status(400).json({ error: 'Unknown collection.' });
  const idx = db[cfg.array].findIndex(x => x[cfg.key] === id);
  if (idx >= 0) db[cfg.array].splice(idx, 1);
  store.save();
  res.json({ ok: true });
});

app.post('/api/admin/reorder', requireAdmin, (req, res) => {
  const db = store.load();
  const { collection, ids } = req.body || {};
  if (collection === 'heroSlides' || collection === 'homeSections') {
    const cfg = COLLECTIONS[collection];
    ids.forEach((id, i) => {
      const item = db[cfg.array].find(x => x.id === id);
      if (item) item.order = i + 1;
    });
    store.save();
    return res.json({ ok: true });
  }
  if (collection === 'brands') {
    ids.forEach((id, i) => {
      const item = db.brands.find(x => x.id === id);
      if (item) item.order = i + 1;
    });
    store.save();
    return res.json({ ok: true });
  }
  if (collection === 'products') {
    ids.forEach((id, i) => {
      const item = db.products.find(x => x.id === id);
      if (item) item.order = i + 1;
    });
    store.save();
    return res.json({ ok: true });
  }
  res.status(400).json({ error: 'Unknown collection.' });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const db = store.load();
  const { settings, promoBar } = req.body || {};
  if (settings) db.settings = Object.assign(db.settings, settings);
  if (promoBar) db.promoBar = Object.assign(db.promoBar||{}, promoBar);
  store.save();
  res.json({ ok: true });
});

app.post('/api/admin/lang', requireAdmin, (req, res) => {
  const db = store.load();
  const { dict } = req.body || {};
  if (dict) {
    db.languages = Object.assign(db.languages, dict);
    store.save();
  }
  res.json({ ok: true });
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
  const dir = path.join(PUBLIC, 'img', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const fn = 'up_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7) + '.' + ext;
  fs.writeFileSync(path.join(dir, fn), buf);
  res.json({ ok: true, url: '/img/uploads/' + fn });
});

app.post('/api/admin/order-status', requireAdmin, (req, res) => {
  const db = store.load();
  const { id, status } = req.body || {};
  const order = db.orders.find(o => o.id === id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  order.status = status;
  order.statusHistory = order.statusHistory || [];
  order.statusHistory.push({ status, at: new Date().toISOString() });
  store.save();
  res.json({ ok: true });
});

app.post('/api/admin/preorder-status', requireAdmin, (req, res) => {
  const db = store.load();
  const { id, status } = req.body || {};
  const rec = db.preorders.find(o => o.id === id);
  if (!rec) return res.status(404).json({ error: 'Pre-order not found.' });
  rec.status = status;
  store.save();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// SPA fallbacks
// ---------------------------------------------------------------------------
// Serve admin SPA for both /admin and /admin/login (client-side routing via hash)
app.get('/admin/login', serveAdminHTML);
app.get('/admin', serveAdminHTML);
app.get(/^\/(?!api|img|css|js|admin).*/, (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

// Run only when invoked directly (e.g. `node server.js`). On Vercel this file
// is imported by the serverless handler /api/index.js, so we export the app
// instead of binding a port.
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SPINTO running on http://0.0.0.0:${PORT}`);
  });
}

module.exports = app;
