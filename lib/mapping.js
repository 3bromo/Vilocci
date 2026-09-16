'use strict';
// ============================================================================
// VELOCCI / SPINTO — row mapping
// ----------------------------------------------------------------------------
// The ONE place that knows how the app's JSON shapes (what the storefront and
// the admin panel speak) translate to SQL table rows (what Supabase stores)
// and back.
//
// Both consumers share this module, so what `npm run migrate` writes into the
// database is byte-for-byte what the runtime reads back:
//   * scripts/migrate.js  — content mapping (existing JSON DB -> tables)
//   * lib/db.js           — runtime reads/writes (PostgREST + SQL drivers)
//
// Nothing here touches the network; these are pure functions.
// ============================================================================

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const str = (v) => (v === undefined || v === null ? null : String(v));
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const bool = (v, dflt) => (v === undefined || v === null ? dflt : !!v);
const json = (v, dflt) => (v === undefined || v === null ? dflt : v);

// Pick only the keys we know about, so an unexpected property in the JSON can
// never become an "column does not exist" error at write time.
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// ---------------------------------------------------------------------------
// Column lists — the exact columns each table is written with.
// Kept next to the mappers on purpose: a column added to SQL must be added
// here, and the local test suite asserts every name exists in the database.
// ---------------------------------------------------------------------------
const COLUMNS = {
  products: [
    'id', 'name_en', 'name_ar', 'slug', 'category', 'brand_slug',
    'description_en', 'description_ar', 'short_en', 'short_ar',
    'material_en', 'material_ar', 'price', 'sale_price', 'old_price',
    'discount_pct', 'active', 'featured', 'new_arrival', 'hero_product',
    'best_seller', 'limited_edition', 'preorder', 'out_of_stock', 'stock',
    'sku', 'key_shapes', 'images', 'main_image', 'fitment', 'order',
    'warranty_en', 'warranty_ar', 'badge_en', 'badge_ar',
    'models', 'years', 'specs', 'vehicles',
  ],
  categories: [
    'id', 'name_en', 'name_ar', 'slug', 'description_en', 'description_ar',
    'image', 'active', 'icon', 'product_count', 'order',
  ],
  brands: [
    'id', 'name_en', 'name_ar', 'slug', 'description_en', 'description_ar',
    'logo', 'emblem', 'mark', 'tier', 'accent', 'models', 'active',
    'product_count', 'order',
  ],
  bundles: [
    'id', 'brand_slug', 'name_en', 'name_ar', 'active', 'bundle_price',
    'normal_total', 'key_case_id', 'key_holder_id', 'medal_id', 'order',
    'title_en', 'title_ar', 'sub_en', 'sub_ar', 'discount', 'discount_percent',
    'discount_mode', 'discount_amount', 'start_date', 'end_date',
  ],
  hero_slides: [
    'id', 'title_en', 'title_ar', 'subtitle_en', 'subtitle_ar', 'image',
    'product_id', 'active', 'order', 'headline_en', 'headline_ar',
    'sub_en', 'sub_ar', 'btn1_en', 'btn1_ar', 'btn1_link',
    'btn2_en', 'btn2_ar', 'btn2_link', 'accent_en', 'accent_ar',
  ],
  home_sections: [
    'id', 'type', 'title_en', 'title_ar', 'subtitle_en', 'subtitle_ar',
    'enabled', 'order', 'config',
  ],
  orders: [
    'id', 'created_at', 'customer', 'items', 'subtotal', 'bundle_discount',
    'delivery_fee', 'total', 'status', 'status_history', 'payment', 'notes',
    'customer_name', 'customer_phone', 'customer_email', 'customer_city',
    'customer_area', 'customer_address', 'customer_notes', 'currency', 'source',
  ],
  order_items: [
    'id', 'order_id', 'product_id', 'name_en', 'name_ar', 'slug', 'category',
    'brand_slug', 'key_shape', 'qty', 'unit_price', 'line_total', 'image',
    'fitment',
  ],
  product_images: [
    'id', 'product_id', 'url', 'alt', 'position', 'is_main',
  ],
  product_prices: [
    'id', 'product_id', 'label', 'price', 'sale_price', 'old_price',
    'discount_pct', 'currency', 'active', 'order',
  ],
  website_content: ['id', 'section', 'key', 'value_en', 'value_ar', 'type'],
  website_images: ['id', 'name', 'url', 'section', 'alt'],
  settings: ['key', 'value'],
  promo_bar: ['id', 'enabled', 'text_en', 'text_ar', 'sub_en', 'sub_ar', 'end_time'],
  messages: [
    'id', 'name', 'email', 'phone', 'message', 'subject', 'is_read',
    'is_resolved', 'created_at',
  ],
  discount_codes: [
    'id', 'code', 'type', 'value', 'min_order', 'max_uses', 'used_count',
    'expires_at', 'active',
  ],
  preorders: [
    'id', 'product_id', 'name_en', 'name_ar', 'brand_slug', 'key_shape',
    'customer', 'status', 'created_at',
  ],
  // Customize requests — customer submitted car-customization enquiries.
  // `car_image_path` is the object path inside the PRIVATE storage bucket;
  // `car_image_data` is only used when Supabase Storage is not configured (the
  // JSON / local fallback), so the admin can still view the photo. Neither is
  // ever exposed to the storefront.
  customize_requests: [
    'id', 'created_at', 'updated_at',
    'category_id', 'category_slug', 'category_name_en', 'category_name_ar',
    'car_image_path', 'car_image_mime', 'car_image_size', 'car_image_data',
    'car_brand', 'car_model', 'model_year', 'car_details',
    'customization_request', 'customer_name', 'phone', 'whatsapp', 'email',
    'preferred_contact', 'additional_notes', 'status', 'admin_notes',
    'client_key', 'locale', 'source',
  ],
};

// ---------------------------------------------------------------------------
// PRODUCTS
// ---------------------------------------------------------------------------
function productToRow(p) {
  const images = Array.isArray(p.images) ? p.images.filter(Boolean) : [];
  const row = {
    id: str(p.id),
    name_en: str(p.name_en),
    name_ar: str(p.name_ar),
    slug: str(p.slug),
    category: str(p.category),
    brand_slug: str(p.brandSlug !== undefined ? p.brandSlug : p.brand_slug),
    description_en: str(p.description_en),
    description_ar: str(p.description_ar),
    short_en: str(p.short_en),
    short_ar: str(p.short_ar),
    material_en: str(p.material_en),
    material_ar: str(p.material_ar),
    price: num(p.price) === null ? 0 : num(p.price),
    sale_price: num(p.sale_price),
    old_price: num(p.oldPrice !== undefined ? p.oldPrice : p.old_price),
    discount_pct: num(p.discount !== undefined ? p.discount : p.discount_pct) || 0,
    active: bool(p.active, true),
    featured: bool(p.featured, false),
    new_arrival: bool(p.newArrival !== undefined ? p.newArrival : p.new_arrival, false),
    hero_product: bool(p.heroProduct !== undefined ? p.heroProduct : p.hero_product, false),
    best_seller: bool(p.bestSeller !== undefined ? p.bestSeller : p.best_seller, false),
    limited_edition: bool(p.limitedEdition !== undefined ? p.limitedEdition : p.limited_edition, false),
    preorder: bool(p.preorder, false),
    out_of_stock: bool(p.outOfStock !== undefined ? p.outOfStock : p.out_of_stock, false),
    // The live data calls the stock count `inventory`; the SQL column is `stock`.
    stock: Math.round(num(p.inventory !== undefined ? p.inventory : p.stock) || 0),
    sku: str(p.sku),
    key_shapes: json(p.keyShapes !== undefined ? p.keyShapes : p.key_shapes, []),
    images,
    main_image: str(p.main_image || images[0] || null),
    fitment: json(p.fitment, {}),
    order: num(p.order) || 0,
    warranty_en: str(p.warranty_en),
    warranty_ar: str(p.warranty_ar),
    badge_en: str(p.badge_en),
    badge_ar: str(p.badge_ar),
    models: json(p.models, []),
    years: json(p.years, []),
    specs: json(p.specs, []),
    vehicles: json(p.vehicles, []),
  };
  return pick(row, COLUMNS.products);
}

function rowToProduct(r) {
  if (!r) return null;
  const images = Array.isArray(r.images) ? r.images : [];
  return Object.assign({}, r, {
    brandSlug: r.brand_slug,
    oldPrice: r.old_price === null ? undefined : Number(r.old_price),
    discount: Number(r.discount_pct || 0),
    keyShapes: Array.isArray(r.key_shapes) ? r.key_shapes : [],
    newArrival: !!r.new_arrival,
    new_arrival: !!r.new_arrival,
    heroProduct: !!r.hero_product,
    bestSeller: !!r.best_seller,
    limitedEdition: !!r.limited_edition,
    outOfStock: !!r.out_of_stock,
    active: !!r.active,
    featured: !!r.featured,
    preorder: !!r.preorder,
    // storefront reads `inventory`, admin reads `stock`
    inventory: Number(r.stock || 0),
    stock: Number(r.stock || 0),
    price: Number(r.price || 0),
    sale_price: r.sale_price === null || r.sale_price === undefined ? undefined : Number(r.sale_price),
    images,
    main_image: r.main_image || images[0] || '',
    order: Number(r.order || 0),
  });
}

// ---------------------------------------------------------------------------
// CATEGORIES  (name / image / description / order — same names on both sides)
// ---------------------------------------------------------------------------
function categoryToRow(c) {
  return pick({
    id: str(c.id),
    name_en: str(c.name_en || c.name),
    name_ar: str(c.name_ar),
    slug: str(c.slug || c.id),
    description_en: str(c.description_en || c.description),
    description_ar: str(c.description_ar),
    image: str(c.image),
    active: bool(c.active, true),
    icon: str(c.icon),
    product_count: num(c.product_count) || 0,
    order: num(c.order) || 0,
  }, COLUMNS.categories);
}

function rowToCategory(r) {
  if (!r) return null;
  return Object.assign({}, r, {
    active: r.active !== false,
    product_count: Number(r.product_count || 0),
    order: Number(r.order || 0),
  });
}

// ---------------------------------------------------------------------------
// The storefront's categories are DERIVED from the catalogue it already has,
// not invented: labels come from the site's own EN/AR dictionary, the image is
// that category's existing first product image and the product count is
// counted from the products themselves. Shared by the content migration
// (scripts/migrate.js), the JSON fallback driver (lib/db.js) and the Admin
// Customize Settings screen, so all of them agree on the same three category
// ids: keycase / keyholder / medal.
// ---------------------------------------------------------------------------
const CATEGORY_META = [
  { key: 'keycase', slug: 'keycases', labelEn: 'Key Cases', dictKey: 'key_cases', order: 1 },
  { key: 'keyholder', slug: 'keyholders', labelEn: 'Key Holders', dictKey: 'key_holders', order: 2 },
  { key: 'medal', slug: 'medals', labelEn: 'Car Medals', dictKey: 'car_medals', order: 3 },
];

function deriveCategories(db) {
  const dict = (db && db.languages && db.languages.dict) || {};
  const en = dict.en || {};
  const ar = dict.ar || {};
  const meta = CATEGORY_META.map((m) => ({
    key: m.key,
    slug: m.slug,
    name_en: en[m.dictKey] || m.labelEn,
    name_ar: ar[m.dictKey] || '',
    order: m.order,
  }));
  const products = (db && db.products) || [];
  const out = [];
  meta.forEach((m) => {
    const inCat = products.filter((p) => p.category === m.key);
    if (!inCat.length) return; // never create an empty, unused category
    const withImage = inCat.find((p) => p.images && p.images[0]);
    const firstImage = (withImage && withImage.images && withImage.images[0]) || null;
    out.push(categoryToRow({
      id: m.key,
      slug: m.slug,
      name_en: m.name_en,
      name_ar: m.name_ar,
      description_en: null, // not present in the existing data — left for the admin
      description_ar: null,
      image: firstImage,
      active: true,
      product_count: inCat.length,
      order: m.order,
    }));
  });
  return out;
}

// ---------------------------------------------------------------------------
// BRANDS
// ---------------------------------------------------------------------------
// 9 of the 29 live brands (and their bundles) have no id in the JSON store —
// only a slug. The ids already present follow the `b_<slug>` convention, so the
// missing ones are completed with the same deterministic id. That is a key
// derived from existing content, not a new record, and it keeps re-running the
// mapping from ever inserting a second row for the same brand.
function brandId(b) {
  return str(b.id || (b.slug ? `b_${b.slug}` : null));
}

function brandToRow(b) {
  return pick({
    id: brandId(b),
    name_en: str(b.name_en),
    name_ar: str(b.name_ar),
    slug: str(b.slug),
    description_en: str(b.description_en),
    description_ar: str(b.description_ar),
    logo: str(b.logo),
    emblem: str(b.emblem),
    mark: str(b.mark),
    tier: str(b.tier),
    accent: str(b.accent),
    models: json(b.models, []),
    active: bool(b.active, true),
    product_count: num(b.product_count) || 0,
    order: num(b.order) || 0,
  }, COLUMNS.brands);
}

function rowToBrand(r) {
  if (!r) return null;
  return Object.assign({}, r, {
    active: r.active !== false,
    models: Array.isArray(r.models) ? r.models : [],
    product_count: Number(r.product_count || 0),
    order: Number(r.order || 0),
  });
}

// ---------------------------------------------------------------------------
// BUNDLES
// ---------------------------------------------------------------------------
function bundleToRow(b) {
  return pick({
    id: str(b.id || (b.brandSlug || b.brand_slug ? `b_${b.brandSlug || b.brand_slug}` : null)),
    brand_slug: str(b.brandSlug !== undefined ? b.brandSlug : b.brand_slug),
    name_en: str(b.title_en || b.name_en),
    name_ar: str(b.title_ar || b.name_ar),
    active: bool(b.active, true),
    bundle_price: num(b.bundlePrice !== undefined ? b.bundlePrice : b.bundle_price) || 0,
    normal_total: num(b.normalTotal !== undefined ? b.normalTotal : b.normal_total) || 0,
    key_case_id: str(b.keyCaseProductId !== undefined ? b.keyCaseProductId : b.key_case_id),
    key_holder_id: str(b.keyHolderProductId !== undefined ? b.keyHolderProductId : b.key_holder_id),
    medal_id: str(b.medalProductId !== undefined ? b.medalProductId : b.medal_id),
    order: num(b.order) || 0,
    title_en: str(b.title_en),
    title_ar: str(b.title_ar),
    sub_en: str(b.sub_en),
    sub_ar: str(b.sub_ar),
    discount: num(b.discount) || 0,
    discount_percent: num(b.discountPercent !== undefined ? b.discountPercent : b.discount_percent) || 0,
    discount_mode: str(b.discountMode !== undefined ? b.discountMode : b.discount_mode) || 'percent',
    discount_amount: num(b.discountAmount !== undefined ? b.discountAmount : b.discount_amount) || 0,
    start_date: str(b.startDate || null),
    end_date: str(b.endDate || null),
  }, COLUMNS.bundles);
}

function rowToBundle(r) {
  if (!r) return null;
  return Object.assign({}, r, {
    brandSlug: r.brand_slug,
    bundlePrice: Number(r.bundle_price || 0),
    normalTotal: Number(r.normal_total || 0),
    keyCaseProductId: r.key_case_id,
    keyHolderProductId: r.key_holder_id,
    medalProductId: r.medal_id,
    discountPercent: Number(r.discount_percent || 0),
    discount: Number(r.discount || 0),
    title_en: r.title_en || r.name_en,
    title_ar: r.title_ar || r.name_ar,
    active: r.active !== false,
  });
}

// ---------------------------------------------------------------------------
// HERO SLIDES
// ---------------------------------------------------------------------------
function heroSlideToRow(s) {
  const headlineEn = str(s.headline_en !== undefined ? s.headline_en : s.title_en);
  const headlineAr = str(s.headline_ar !== undefined ? s.headline_ar : s.title_ar);
  const subEn = str(s.sub_en !== undefined ? s.sub_en : s.subtitle_en);
  const subAr = str(s.sub_ar !== undefined ? s.sub_ar : s.subtitle_ar);
  return pick({
    id: str(s.id),
    title_en: headlineEn,
    title_ar: headlineAr,
    subtitle_en: subEn,
    subtitle_ar: subAr,
    image: str(s.image),
    product_id: str(s.productId || s.product_id || null),
    active: bool(s.active, true),
    order: num(s.order) || 0,
    headline_en: headlineEn,
    headline_ar: headlineAr,
    sub_en: subEn,
    sub_ar: subAr,
    btn1_en: str(s.btn1_en), btn1_ar: str(s.btn1_ar), btn1_link: str(s.btn1_link),
    btn2_en: str(s.btn2_en), btn2_ar: str(s.btn2_ar), btn2_link: str(s.btn2_link),
    accent_en: str(s.accent_en), accent_ar: str(s.accent_ar),
  }, COLUMNS.hero_slides);
}

function rowToHeroSlide(r) {
  if (!r) return null;
  return Object.assign({}, r, {
    headline_en: r.headline_en || r.title_en || '',
    headline_ar: r.headline_ar || r.title_ar || '',
    sub_en: r.sub_en || r.subtitle_en || '',
    sub_ar: r.sub_ar || r.subtitle_ar || '',
    active: r.active !== false,
    order: Number(r.order || 0),
  });
}

// ---------------------------------------------------------------------------
// HOME SECTIONS (website content sections)
// ---------------------------------------------------------------------------
function homeSectionToRow(s) {
  return pick({
    id: str(s.id),
    type: str(s.type),
    title_en: str(s.title !== undefined ? s.title : s.title_en),
    title_ar: str(s.title_ar),
    subtitle_en: str(s.subtitle_en),
    subtitle_ar: str(s.subtitle_ar),
    enabled: bool(s.enabled, true),
    order: num(s.order) || 0,
    config: json(s.config, {}),
  }, COLUMNS.home_sections);
}

function rowToHomeSection(r) {
  if (!r) return null;
  return Object.assign({}, r, {
    title: r.title_en || '',
    enabled: r.enabled !== false,
    order: Number(r.order || 0),
  });
}

// ---------------------------------------------------------------------------
// ORDERS + ORDER ITEMS
// ---------------------------------------------------------------------------
function orderToRow(o) {
  const c = o.customer || {};
  return pick({
    id: str(o.id),
    created_at: str(o.createdAt || o.created_at || new Date().toISOString()),
    customer: json(c, {}),
    items: json(o.items, []),
    subtotal: num(o.subtotal) || 0,
    bundle_discount: num(o.bundleDiscount !== undefined ? o.bundleDiscount : o.bundle_discount) || 0,
    delivery_fee: num(o.deliveryFee !== undefined ? o.deliveryFee : o.delivery_fee) || 0,
    total: num(o.total) || 0,
    status: str(o.status) || 'Pending',
    status_history: json(o.statusHistory || o.status_history, []),
    payment: str(o.payment) || 'Cash on Delivery',
    notes: str(o.notes || c.notes || null),
    customer_name: str(c.fullName || c.name || null),
    customer_phone: str(c.phone || null),
    customer_email: str(c.email || null),
    customer_city: str(c.city || null),
    customer_area: str(c.area || null),
    customer_address: str(c.address || null),
    customer_notes: str(c.notes || null),
    currency: str(o.currency) || 'EGP',
    source: str(o.source) || 'storefront',
  }, COLUMNS.orders);
}

function rowToOrder(r, items) {
  if (!r) return null;
  const customer = Object.assign({}, r.customer || {}, {
    fullName: (r.customer && r.customer.fullName) || r.customer_name || '',
    phone: (r.customer && r.customer.phone) || r.customer_phone || '',
    email: (r.customer && r.customer.email) || r.customer_email || '',
    city: (r.customer && r.customer.city) || r.customer_city || '',
    area: (r.customer && r.customer.area) || r.customer_area || '',
    address: (r.customer && r.customer.address) || r.customer_address || '',
    notes: (r.customer && r.customer.notes) || r.customer_notes || '',
  });
  const out = Object.assign({}, r, {
    createdAt: r.created_at,
    customer,
    subtotal: Number(r.subtotal || 0),
    bundleDiscount: Number(r.bundle_discount || 0),
    deliveryFee: Number(r.delivery_fee || 0),
    total: Number(r.total || 0),
    statusHistory: Array.isArray(r.status_history) ? r.status_history : [],
  });
  // Prefer the normalized order_items rows; fall back to the legacy jsonb.
  if (Array.isArray(items) && items.length) {
    out.items = items.map(rowToOrderItem);
  } else {
    out.items = Array.isArray(r.items) ? r.items : [];
  }
  return out;
}

function orderItemToRow(item, orderId, index) {
  return pick({
    id: str(item.id || `${orderId}-${index + 1}`),
    order_id: str(orderId),
    product_id: str(item.productId || item.product_id || null),
    name_en: str(item.name_en),
    name_ar: str(item.name_ar),
    slug: str(item.slug),
    category: str(item.category),
    brand_slug: str(item.brandSlug !== undefined ? item.brandSlug : item.brand_slug),
    key_shape: str(item.keyShape !== undefined ? item.keyShape : item.key_shape),
    qty: num(item.qty) || 1,
    unit_price: num(item.price !== undefined ? item.price : item.unit_price) || 0,
    line_total: num(item.lineTotal !== undefined ? item.lineTotal : item.line_total) || 0,
    image: str(item.image),
    fitment: json(item.fitment, {}),
  }, COLUMNS.order_items);
}

function rowToOrderItem(r) {
  if (!r) return null;
  return {
    id: r.id,
    productId: r.product_id,
    name_en: r.name_en,
    name_ar: r.name_ar,
    slug: r.slug,
    category: r.category,
    brandSlug: r.brand_slug,
    keyShape: r.key_shape || '',
    qty: Number(r.qty || 0),
    price: Number(r.unit_price || 0),
    lineTotal: Number(r.line_total || 0),
    image: r.image || '',
    fitment: r.fitment || {},
  };
}

// ---------------------------------------------------------------------------
// PRODUCT IMAGES / PRICES (normalized children)
// ---------------------------------------------------------------------------
function productImageRows(product) {
  const row = productToRow(product);
  const urls = [];
  (row.images || []).forEach((url) => { if (url && !urls.includes(url)) urls.push(url); });
  if (row.main_image && !urls.includes(row.main_image)) urls.unshift(row.main_image);
  return urls.map((url, i) => pick({
    // deterministic id: the same product + url always maps to the same row,
    // so re-running the migration cannot create duplicate images.
    id: `pimg_${row.id}_${i}`,
    product_id: row.id,
    url,
    alt: row.name_en || '',
    position: i,
    is_main: i === 0,
  }, COLUMNS.product_images));
}

function productPriceRows(product) {
  const row = productToRow(product);
  return [pick({
    id: `price_${row.id}_default`,
    product_id: row.id,
    label: 'default',
    price: row.price,
    sale_price: row.sale_price,
    old_price: row.old_price,
    discount_pct: row.discount_pct,
    currency: 'EGP',
    active: true,
    order: 0,
  }, COLUMNS.product_prices)];
}

// ---------------------------------------------------------------------------
// PROMO BAR / SETTINGS
// ---------------------------------------------------------------------------
function promoBarToRow(p) {
  return pick({
    id: 'promo',
    enabled: bool(p.enabled, true),
    text_en: str(p.text_en),
    text_ar: str(p.text_ar),
    sub_en: str(p.sub_en),
    sub_ar: str(p.sub_ar),
    end_time: str(p.endTime || p.end_time || null),
  }, COLUMNS.promo_bar);
}

function rowToPromoBar(r) {
  if (!r) return {};
  return {
    enabled: r.enabled !== false,
    text_en: r.text_en || '',
    text_ar: r.text_ar || '',
    sub_en: r.sub_en || '',
    sub_ar: r.sub_ar || '',
    endTime: r.end_time || '',
  };
}

function settingRows(settings) {
  return Object.keys(settings || {}).map((key) => pick({
    key,
    value: settings[key],
  }, COLUMNS.settings));
}

function rowsToSettings(rows) {
  const out = {};
  (rows || []).forEach((r) => { out[r.key] = r.value; });
  return out;
}

// ---------------------------------------------------------------------------
// WEBSITE CONTENT (editable copy, grouped into sections)
// ---------------------------------------------------------------------------
function websiteContentRows(dict, language) {
  const rows = [];
  Object.keys(dict || {}).forEach((key) => {
    const value = dict[key];
    if (value === null || typeof value === 'object') return; // nested groups are skipped
    rows.push(pick({
      id: `wc_${language}_${key}`,
      section: 'copy',
      key,
      value_en: language === 'en' ? String(value) : null,
      value_ar: language === 'ar' ? String(value) : null,
      type: 'text',
    }, COLUMNS.website_content));
  });
  return rows;
}

// Merge EN + AR website_content rows into one array the admin can edit.
function rowsToWebsiteContent(rows) {
  const byKey = {};
  (rows || []).forEach((r) => {
    const k = r.key;
    if (!byKey[k]) byKey[k] = { id: r.id, section: r.section, key: k, value_en: '', value_ar: '' };
    if (r.value_en) byKey[k].value_en = r.value_en;
    if (r.value_ar) byKey[k].value_ar = r.value_ar;
  });
  return Object.values(byKey);
}

function websiteContentToRow(c) {
  return pick({
    id: str(c.id || `wc_${c.key}`),
    section: str(c.section) || 'copy',
    key: str(c.key),
    value_en: str(c.value_en),
    value_ar: str(c.value_ar),
    type: str(c.type) || 'text',
  }, COLUMNS.website_content);
}

// ---------------------------------------------------------------------------
// MESSAGES / PRE-ORDERS
// ---------------------------------------------------------------------------
function messageToRow(m) {
  return pick({
    id: str(m.id),
    name: str(m.name), email: str(m.email), phone: str(m.phone),
    message: str(m.message), subject: str(m.subject),
    is_read: bool(m.is_read, false), is_resolved: bool(m.is_resolved, false),
    created_at: str(m.createdAt || m.created_at || new Date().toISOString()),
  }, COLUMNS.messages);
}

function rowToMessage(r) {
  return r ? Object.assign({}, r, { createdAt: r.created_at, is_read: !!r.is_read, is_resolved: !!r.is_resolved }) : null;
}

function preorderToRow(p) {
  return pick({
    id: str(p.id),
    product_id: str(p.productId || p.product_id),
    name_en: str(p.name_en), name_ar: str(p.name_ar),
    brand_slug: str(p.brandSlug || p.brand_slug),
    key_shape: str(p.keyShape || p.key_shape),
    customer: json(p.customer, {}),
    status: str(p.status) || 'Pending',
    created_at: str(p.createdAt || p.created_at || new Date().toISOString()),
  }, COLUMNS.preorders);
}

function rowToPreorder(r) {
  return r ? Object.assign({}, r, {
    createdAt: r.created_at, productId: r.product_id, brandSlug: r.brand_slug, keyShape: r.key_shape,
  }) : null;
}

// ---------------------------------------------------------------------------
// CUSTOMIZE REQUESTS
// ---------------------------------------------------------------------------
// A customer's car-customization request. The row keeps the app's own field
// names (car_brand / car_model / customer_name / …) because the feature owns
// them end to end, so the mapper only normalizes the timestamps and the
// camelCase aliases the admin panel reads.
function customizeRequestToRow(r) {
  return pick({
    id: str(r.id),
    created_at: str(r.createdAt || r.created_at || new Date().toISOString()),
    updated_at: str(r.updatedAt || r.updated_at || null),
    category_id: str(r.categoryId || r.category_id),
    category_slug: str(r.categorySlug || r.category_slug),
    category_name_en: str(r.categoryNameEn || r.category_name_en),
    category_name_ar: str(r.categoryNameAr || r.category_name_ar),
    car_image_path: str(r.carImagePath || r.car_image_path),
    car_image_mime: str(r.carImageMime || r.car_image_mime),
    car_image_size: num(r.carImageSize !== undefined ? r.carImageSize : r.car_image_size),
    car_image_data: str(r.carImageData || r.car_image_data),
    car_brand: str(r.carBrand || r.car_brand),
    car_model: str(r.carModel || r.car_model),
    model_year: str(r.modelYear !== undefined ? r.modelYear : r.model_year),
    car_details: str(r.carDetails || r.car_details),
    customization_request: str(r.customizationRequest || r.customization_request),
    customer_name: str(r.customerName || r.customer_name),
    phone: str(r.phone),
    whatsapp: str(r.whatsapp),
    email: str(r.email),
    preferred_contact: str(r.preferredContact || r.preferred_contact) || 'Phone',
    additional_notes: str(r.additionalNotes || r.additional_notes),
    status: str(r.status) || 'New',
    admin_notes: str(r.adminNotes || r.admin_notes),
    client_key: str(r.clientKey || r.client_key),
    locale: str(r.locale) || 'en',
    source: str(r.source) || 'storefront',
  }, COLUMNS.customize_requests);
}

function rowToCustomizeRequest(r) {
  if (!r) return null;
  return Object.assign({}, r, {
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    categoryId: r.category_id,
    categorySlug: r.category_slug,
    categoryNameEn: r.category_name_en,
    categoryNameAr: r.category_name_ar,
    carImagePath: r.car_image_path,
    carImageMime: r.car_image_mime,
    carImageSize: r.car_image_size === null || r.car_image_size === undefined ? null : Number(r.car_image_size),
    carImageData: r.car_image_data || '',
    carBrand: r.car_brand,
    carModel: r.car_model,
    modelYear: r.model_year,
    carDetails: r.car_details,
    customizationRequest: r.customization_request,
    customerName: r.customer_name,
    preferredContact: r.preferred_contact || 'Phone',
    additionalNotes: r.additional_notes,
    adminNotes: r.admin_notes || '',
    clientKey: r.client_key,
  });
}

// The row WITHOUT the private photo payload — the admin list/detail payloads
// only ever carry a flag plus the storage path, and the photo itself is served
// by an authenticated endpoint (signed URL).
function customizeRequestSummary(record) {
  const out = Object.assign({}, record);
  delete out.carImageData;
  delete out.car_image_data;
  delete out.carImagePath;
  delete out.car_image_path;
  out.hasPhoto = !!(record.carImagePath || record.carImageData);
  out.photoKind = record.carImagePath ? 'storage' : (record.carImageData ? 'inline' : 'none');
  return out;
}

// ---------------------------------------------------------------------------
// DISCOUNT CODES (column names match on both sides)
// ---------------------------------------------------------------------------
function discountCodeToRow(d) {
  return pick({
    id: str(d.id),
    code: str(d.code),
    type: str(d.type) || 'percentage',
    value: num(d.value) || 0,
    min_order: num(d.min_order) || 0,
    max_uses: d.max_uses === null || d.max_uses === '' ? null : num(d.max_uses),
    used_count: num(d.used_count) || 0,
    expires_at: str(d.expires_at || null),
    active: bool(d.active, true),
  }, COLUMNS.discount_codes);
}

function rowToDiscountCode(r) {
  if (!r) return null;
  return Object.assign({}, r, {
    value: Number(r.value || 0),
    min_order: Number(r.min_order || 0),
    used_count: Number(r.used_count || 0),
    active: r.active !== false,
  });
}

module.exports = {
  COLUMNS,
  productToRow, rowToProduct,
  categoryToRow, rowToCategory, deriveCategories, CATEGORY_META,
  brandToRow, rowToBrand,
  bundleToRow, rowToBundle,
  heroSlideToRow, rowToHeroSlide,
  homeSectionToRow, rowToHomeSection,
  orderToRow, rowToOrder, orderItemToRow, rowToOrderItem,
  productImageRows, productPriceRows,
  promoBarToRow, rowToPromoBar,
  settingRows, rowsToSettings,
  websiteContentRows, rowsToWebsiteContent, websiteContentToRow,
  messageToRow, rowToMessage,
  discountCodeToRow, rowToDiscountCode,
  preorderToRow, rowToPreorder,
  customizeRequestToRow, rowToCustomizeRequest, customizeRequestSummary,
};
