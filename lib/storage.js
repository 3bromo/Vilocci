'use strict';
// ============================================================================
// VELOCE — private storage for Customize car photos
// ----------------------------------------------------------------------------
// Customer car photos are private customer data: they must never be publicly
// reachable and must never be listed by another customer. This module is the
// ONLY place that talks to Supabase Storage, and it always does so from the
// server with the service-role key:
//
//   * bucket   — 'customize-uploads', created PRIVATE (public = false)
//   * upload   — server-side only, after the request body is validated
//   * viewing  — admins receive a short-lived SIGNED URL minted per request
//   * delete   — best effort, when a request is deleted in the admin panel
//
// The service-role key is read from the environment and is never sent to the
// browser (there is no client-facing endpoint that returns it).
//
// Fallback: when Supabase Storage is not configured (local development, or a
// deployment without Supabase env vars), uploads report `ok:false` and the
// caller stores the photo inline on the request row so the admin can still see
// it. Nothing about the browser contract changes.
// ============================================================================

let SUPABASE_URL = '';
try {
  const raw = (process.env.VITE_SUPABASE_URL || '').trim();
  if (raw) SUPABASE_URL = `${new URL(raw).protocol}//${new URL(raw).hostname}`;
} catch (e) { SUPABASE_URL = ''; }

// A key with characters that cannot be sent in an HTTP header (a pasted bullet,
// any code point above 255) would make every request throw before it leaves the
// machine — treat it as unusable rather than breaking every upload.
function usableKey(key) {
  const k = String(key || '').trim();
  if (!k) return '';
  for (let i = 0; i < k.length; i += 1) {
    const code = k.charCodeAt(i);
    if (code < 32 || code > 255) return '';
  }
  return k;
}
const SERVICE_KEY = usableKey(process.env.SUPABASE_SERVICE_ROLE_KEY);

const BUCKET = String(process.env.CUSTOMIZE_BUCKET || 'customize-uploads').trim() || 'customize-uploads';

// Shape images are the OPPOSITE of car photos: they are public storefront
// content (the customer sees them on the product page), so they live in a
// PUBLIC bucket and the shape row stores the durable public URL — exactly the
// pattern brands.logo uses. One canonical object per shape: uploading again
// REPLACES the previous file (upsert), so the URL stays stable.
const SHAPE_BUCKET = String(process.env.SHAPE_IMAGE_BUCKET || 'shape-images').trim() || 'shape-images';
// Product photos are public storefront content as well (the customer sees them
// in the product gallery), so they follow the shape-image pattern exactly:
// a PUBLIC bucket + the durable public URL stored on the product row
// (products.images / product_images.url) — never a signed URL, never a
// read-only-host local file. The difference is cardinality: a shape has ONE
// canonical image (upload = replace), a product has a GALLERY and an upload can
// happen before the product is saved, so every file gets its own object name.
const PRODUCT_BUCKET = String(process.env.PRODUCT_IMAGE_BUCKET || 'product-images').trim() || 'product-images';
// The admin media library (Website Images, homepage hero banner) uploads into
// the SAME public bucket but under its own prefix, so library files stay
// distinguishable from product gallery files (`products/`).
const LIBRARY_PREFIX = 'library';
const SIGNED_URL_TTL = Math.max(30, Number(process.env.CUSTOMIZE_SIGNED_URL_TTL || 300));
const MAX_BYTES = Math.max(64 * 1024, Number(process.env.CUSTOMIZE_MAX_IMAGE_BYTES || 6 * 1024 * 1024));
const PAYMENT_PROOF_PREFIX = 'payment-proofs';

// SVG is deliberately NOT accepted: an uploaded SVG can carry script and would
// be rendered in the admin panel's origin.
const ALLOWED_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
};

function isConfigured() {
  return !!(SUPABASE_URL && SERVICE_KEY);
}

function info() {
  return {
    configured: isConfigured(),
    bucket: BUCKET,
    private: true,
    shapeBucket: SHAPE_BUCKET,
    shapeBucketPublic: true,
    maxBytes: MAX_BYTES,
    allowedTypes: Object.keys(ALLOWED_MIME),
    signedUrlTtlSeconds: SIGNED_URL_TTL,
    mode: isConfigured() ? 'supabase-storage' : 'inline-fallback',
  };
}

let _client = null;
function client() {
  if (_client) return _client;
  const { createClient } = require('@supabase/supabase-js');
  _client = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _client;
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------
function fail(message, code) {
  const err = new Error(message);
  err.code = code || 'INVALID_IMAGE';
  return err;
}

// The declared mime must match the file's own magic bytes, otherwise a renamed
// file (or a script with an image prefix) could slip through.
function signatureMatches(mime, buf) {
  const hex = buf.slice(0, 16).toString('hex');
  const ascii = buf.slice(0, 16).toString('latin1');
  if (mime === 'image/jpeg' || mime === 'image/jpg') return hex.startsWith('ffd8ff');
  if (mime === 'image/png') return hex.startsWith('89504e470d0a1a0a');
  if (mime === 'image/webp') return hex.startsWith('52494646') && ascii.slice(8, 12) === 'WEBP';
  if (mime === 'image/avif') return ascii.slice(4, 8) === 'ftyp' && /avif|avis/.test(ascii);
  if (mime === 'image/heic' || mime === 'image/heif') return ascii.slice(4, 8) === 'ftyp';
  return false;
}

// Parses `data:image/...;base64,…` into a validated buffer. Throws an Error
// whose `code` the API turns into a 400.
function parseImageDataUrl(dataUrl, label = 'car photo') {
  if (typeof dataUrl !== 'string' || !dataUrl) {
    throw fail(`The ${label} is required.`, 'MISSING_IMAGE');
  }
  if (dataUrl.length > Math.ceil((MAX_BYTES * 4) / 3) + 1024) {
    throw fail(`The ${label} is too large (max ${Math.round(MAX_BYTES / (1024 * 1024))} MB).`, 'IMAGE_TOO_LARGE');
  }
  const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(dataUrl.trim());
  if (!m) throw fail(`The ${label} must be an uploaded image file.`, 'INVALID_IMAGE');
  const mime = m[1].toLowerCase();
  const ext = ALLOWED_MIME[mime];
  if (!ext) {
    throw fail('Unsupported image type. Please upload a JPG, PNG, WebP or HEIC photo.', 'UNSUPPORTED_TYPE');
  }
  const buffer = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (!buffer.length) throw fail(`The uploaded ${label} is empty.`, 'EMPTY_IMAGE');
  if (buffer.length > MAX_BYTES) {
    throw fail(`The ${label} is too large (max ${Math.round(MAX_BYTES / (1024 * 1024))} MB).`, 'IMAGE_TOO_LARGE');
  }
  if (!signatureMatches(mime, buffer)) {
    throw fail(`That file does not look like a real image. Please upload a JPG, PNG or WebP image.`, 'BAD_SIGNATURE');
  }
  return { mime, ext, buffer, size: buffer.length };
}

// ---------------------------------------------------------------------------
// upload / read / delete
// ---------------------------------------------------------------------------
async function ensureBucket() {
  const sb = client();
  const { error } = await sb.storage.createBucket(BUCKET, { public: false });
  // "already exists" is the happy path on every run after the first one.
  if (error && !/already exists|duplicate/i.test(error.message || '')) throw new Error(error.message);
  return true;
}

// Uploads a validated data URL into the private bucket.
// Returns { ok:true, path, mime, size } or { ok:false, reason, message } —
// the caller decides whether to fall back to inline storage.
async function uploadCarPhoto(dataUrl, opts = {}) {
  const parsed = parseImageDataUrl(dataUrl);          // throws on invalid input
  if (!isConfigured()) {
    return { ok: false, reason: 'not-configured', message: 'Supabase Storage is not configured on this server.' };
  }
  const sb = client();
  const safeId = String(opts.requestId || 'req').replace(/[^A-Za-z0-9._-]/g, '_');
  const day = new Date().toISOString().slice(0, 10);
  const path = `${day}/${safeId}.${parsed.ext}`;
  const put = () => sb.storage.from(BUCKET).upload(path, parsed.buffer, {
    contentType: parsed.mime,
    upsert: true,
    cacheControl: '3600',
  });
  try {
    let { error } = await put();
    if (error && /bucket not found|does not exist/i.test(error.message || '')) {
      await ensureBucket();
      ({ error } = await put());
    }
    if (error) throw new Error(error.message);
    return { ok: true, path, mime: parsed.mime, size: parsed.size };
  } catch (e) {
    console.warn('[customize] storage upload failed, storing the photo inline:', e.message);
    return { ok: false, reason: 'upload-failed', message: e.message };
  }
}

// The existing Customize parser remains the public compatibility helper.
// Payment proofs use the same strict magic-byte validation, but get payment-specific copy.
function parseCarImageDataUrl(dataUrl) {
  return parseImageDataUrl(dataUrl, 'car photo');
}

async function uploadPaymentProof(dataUrl, opts = {}) {
  const parsed = parseImageDataUrl(dataUrl, 'payment screenshot');
  if (!isConfigured()) {
    return { ok: false, reason: 'not-configured', message: 'Supabase Storage is not configured on this server.', ...parsed };
  }
  const sb = client();
  const safeId = String(opts.orderId || 'order').replace(/[^A-Za-z0-9._-]/g, '_');
  const day = new Date().toISOString().slice(0, 10);
  const path = `${PAYMENT_PROOF_PREFIX}/${day}/${safeId}.${parsed.ext}`;
  const put = () => sb.storage.from(BUCKET).upload(path, parsed.buffer, {
    contentType: parsed.mime,
    upsert: false,
    cacheControl: '3600',
  });
  try {
    let { error } = await put();
    if (error && /bucket not found|does not exist/i.test(error.message || '')) {
      await ensureBucket();
      ({ error } = await put());
    }
    if (error) throw new Error(error.message);
    return { ok: true, path, mime: parsed.mime, size: parsed.size };
  } catch (e) {
    // Unlike Customize, a payment proof must never silently fall back after a
    // configured storage service fails: doing so could accept an order without
    // a durable proof reference. The API rejects the order instead.
    console.warn('[orders] payment proof storage upload failed:', e.message);
    return { ok: false, reason: 'upload-failed', message: e.message, ...parsed };
  }
}

// Short-lived signed URL for an admin viewing the photo. Never cached publicly.
async function signedUrl(path) {
  if (!isConfigured() || !path) return null;
  const { data, error } = await client().storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL);
  if (error) throw new Error(`Could not sign the photo URL: ${error.message}`);
  return (data && data.signedUrl) || null;
}

async function removeCarPhoto(path) {
  if (!isConfigured() || !path) return false;
  try {
    const { error } = await client().storage.from(BUCKET).remove([path]);
    if (error) throw new Error(error.message);
    return true;
  } catch (e) {
    console.warn('[customize] could not delete the stored photo:', e.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public storefront image buckets (shape images, product images)
// ---------------------------------------------------------------------------
// Creates the bucket when it is missing AND makes sure an existing bucket is
// PUBLIC. A bucket somebody created by hand as private would silently break
// every stored image (the public URL the row holds answers 400), so the
// visibility is verified — and repaired — before every upload instead of
// assumed. Shared by `shape-images` and `product-images`: both hold public
// storefront content whose durable URL is stored on the row itself.
async function ensurePublicBucket(bucketName) {
  const sb = client();

  // Do not only create the bucket when an upload gets a "not found" response:
  // an operator may already have created it as PRIVATE, which would make the
  // stored public URL fail on the storefront. Every production upload
  // therefore verifies the bucket and explicitly keeps it public.
  let bucket = await sb.storage.getBucket(bucketName);
  if (bucket.error) {
    const missing = /not found|does not exist|404/i.test(bucket.error.message || '')
      || Number(bucket.error.status || 0) === 404;
    if (!missing) throw new Error(bucket.error.message);
    const created = await sb.storage.createBucket(bucketName, { public: true });
    if (created.error && !/already exists|duplicate/i.test(created.error.message || '')) {
      throw new Error(created.error.message);
    }
    bucket = await sb.storage.getBucket(bucketName);
    if (bucket.error) throw new Error(bucket.error.message);
  }

  // `updateBucket` is idempotent and also repairs a bucket that was created
  // manually with public=false. The image URL contract depends on this.
  const updated = await sb.storage.updateBucket(bucketName, { public: true });
  if (updated.error) {
    // Not fatal for the service-role upload itself, but the public URL would
    // not render — surface it instead of storing a broken URL silently.
    throw new Error(updated.error.message);
  }
  return true;
}

async function ensureShapeBucket() {
  return ensurePublicBucket(SHAPE_BUCKET);
}

async function ensureProductBucket() {
  return ensurePublicBucket(PRODUCT_BUCKET);
}

// Writes already-validated bytes into a public bucket and returns the durable
// public URL. The bucket is verified before every upload so one that was
// deleted (or flipped private) in the dashboard is repaired instead of
// silently storing a URL that cannot render; a bucket that disappears between
// the verification and the upload is recreated and the put retried once.
async function putPublicObject(bucketName, objectPath, parsed) {
  const sb = client();
  const put = () => sb.storage.from(bucketName).upload(objectPath, parsed.buffer, {
    contentType: parsed.mime,
    upsert: true,
    cacheControl: '3600',
  });
  await ensurePublicBucket(bucketName);
  let { error } = await put();
  if (error && /bucket not found|does not exist/i.test(error.message || '')) {
    await ensurePublicBucket(bucketName);
    ({ error } = await put());
  }
  if (error) throw new Error(error.message);
  return `${SUPABASE_URL}/storage/v1/object/public/${bucketName}/${objectPath}`;
}

// ---------------------------------------------------------------------------
// Shape images — one canonical object per shape
// ---------------------------------------------------------------------------
// Read-only status of the shape-images bucket for the admin panel / diagnose
// endpoint: does the bucket exist, is it PUBLIC, and how many objects live in
// it. Never throws — problems come back in `error`.
async function shapeStorageStatus() {
  const out = {
    configured: isConfigured(),
    bucket: SHAPE_BUCKET,
    public: null,
    exists: false,
    objects: null,
    publicUrlExample: '',
    error: null,
  };
  if (!isConfigured()) {
    out.error = 'Supabase Storage is not configured on this server (VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are required).';
    return out;
  }
  try {
    const sb = client();
    const { data: bucket, error } = await sb.storage.getBucket(SHAPE_BUCKET);
    if (error) {
      out.error = error.message;
      return out;
    }
    out.exists = true;
    out.public = bucket ? bucket.public === true : null;
    out.publicUrlExample = `${SUPABASE_URL}/storage/v1/object/public/${SHAPE_BUCKET}/shapes/shape_a.png`;
    const { data: files, error: listError } = await sb.storage.from(SHAPE_BUCKET).list('shapes', { limit: 100 });
    if (listError) out.error = listError.message;
    else out.objects = (files || []).length;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

// Uploads a validated data URL as the canonical image of a key shape.
// Returns { ok:true, url, path, mime, size } — `url` is the durable PUBLIC
// URL stored on the shape row — or { ok:false, reason, message } when Storage
// is not configured (the caller then stores the data URL inline, the same
// fallback Customize uses).
async function uploadShapeImage(dataUrl, opts = {}) {
  const parsed = parseImageDataUrl(dataUrl, 'shape image');   // throws on invalid input
  if (!isConfigured()) {
    return { ok: false, reason: 'not-configured', message: 'Supabase Storage is not configured on this server.' };
  }
  const safeId = String(opts.shapeId || 'shape').replace(/[^A-Za-z0-9._-]/g, '_');
  const objectPath = `shapes/${safeId}.${parsed.ext}`;
  try {
    const url = await putPublicObject(SHAPE_BUCKET, objectPath, parsed);
    return { ok: true, url, path: objectPath, mime: parsed.mime, size: parsed.size };
  } catch (e) {
    console.warn('[shapes] storage upload failed:', e.message);
    return { ok: false, reason: 'upload-failed', message: e.message };
  }
}

// ---------------------------------------------------------------------------
// Product images — public bucket, one object per uploaded photo
// ---------------------------------------------------------------------------
// This is what the Admin product editor's "Upload image" button calls: the
// admin picks a photo from the device gallery, the browser sends it as a
// validated data URL and gets back the durable PUBLIC URL that is stored in
// products.images (and the normalized product_images child rows).
//
// A product gallery holds several images and an upload can happen while the
// product is still being created (no id yet), so — unlike a shape's single
// canonical object — every upload gets its own unique object name and never
// overwrites another photo. Cancelling the editor leaves the file in the
// bucket, which is harmless (it is not referenced by any product).
async function uploadProductImage(dataUrl, opts = {}) {
  const parsed = parseImageDataUrl(dataUrl, 'product image');   // throws on invalid input
  if (!isConfigured()) {
    return { ok: false, reason: 'not-configured', message: 'Supabase Storage is not configured on this server.' };
  }
  const safeId = (String(opts.productId || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)) || 'new';
  const unique = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const objectPath = `products/${safeId}-${unique}.${parsed.ext}`;
  try {
    const url = await putPublicObject(PRODUCT_BUCKET, objectPath, parsed);
    return { ok: true, url, path: objectPath, mime: parsed.mime, size: parsed.size };
  } catch (e) {
    console.warn('[products] storage upload failed:', e.message);
    return { ok: false, reason: 'upload-failed', message: e.message };
  }
}

// ---------------------------------------------------------------------------
// Admin media library — POST /api/admin/upload
// ---------------------------------------------------------------------------
// This is the endpoint Admin → Website Images (the admin's one media library)
// and the Homepage CMS hero banner upload to. Those files are public storefront
// content, so they follow the product-image pattern exactly: a PUBLIC bucket
// plus the durable public URL that the library row / setting stores.
//
// They share the PUBLIC `product-images` bucket but live under their own
// `library/` prefix, so the media library stays distinguishable from product
// galleries (`products/`) in the bucket itself and in the diagnostics that
// list that prefix. Every upload gets a unique object name — a library holds
// many independent images and nothing is ever overwritten.
//
// Why not the local disk: /api/admin/upload used to write /img/uploads, which
// does not exist on a serverless host — the file vanished with the instance and
// the endpoint could only answer 507 there. Storage makes the same endpoint
// durable on every host; the disk path is kept only as the not-configured
// fallback (local development), exactly as products/images and shapes do.
async function uploadLibraryImage(dataUrl, opts = {}) {
  const parsed = parseImageDataUrl(dataUrl, 'image');   // throws on invalid input
  if (!isConfigured()) {
    return { ok: false, reason: 'not-configured', message: 'Supabase Storage is not configured on this server.' };
  }
  const unique = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const objectPath = `${LIBRARY_PREFIX}/up_${unique}.${parsed.ext}`;
  try {
    const url = await putPublicObject(PRODUCT_BUCKET, objectPath, parsed);
    return { ok: true, url, path: objectPath, mime: parsed.mime, size: parsed.size };
  } catch (e) {
    console.warn('[library] storage upload failed:', e.message);
    return { ok: false, reason: 'upload-failed', message: e.message };
  }
}

// Read-only status of the product-images bucket, for /api/admin/diagnose and
// the operator probe: does the bucket exist, is it PUBLIC (a private bucket
// would store URLs the storefront cannot render), and how many objects live in
// it. Never throws — problems come back in `error`.
async function productStorageStatus() {
  const out = {
    configured: isConfigured(),
    bucket: PRODUCT_BUCKET,
    public: null,
    exists: false,
    objects: null,
    objectsLimit: 1000,
    publicUrlExample: '',
    error: null,
  };
  if (!isConfigured()) {
    out.error = 'Supabase Storage is not configured on this server (VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are required) — uploads fall back to /img/uploads, or to a small inline data URL on a read-only host.';
    return out;
  }
  try {
    const sb = client();
    const { data: bucket, error } = await sb.storage.getBucket(PRODUCT_BUCKET);
    if (error) {
      out.error = error.message;
      return out;
    }
    out.exists = true;
    out.public = bucket ? bucket.public === true : null;
    out.publicUrlExample = `${SUPABASE_URL}/storage/v1/object/public/${PRODUCT_BUCKET}/products/prod_x-abc123.jpg`;
    const { data: files, error: listError } = await sb.storage.from(PRODUCT_BUCKET).list('products', { limit: out.objectsLimit });
    if (listError) out.error = listError.message;
    else out.objects = (files || []).length;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

// True when a stored product image URL points at OUR product bucket. Used by
// the diagnostics to count how many gallery images really came from an upload
// (pasted external URLs, /img/asset.svg artwork, /img/uploads files and inline
// data URLs are all counted separately and are never touched).
function isProductImageUrl(url) {
  const u = String(url || '');
  return u.indexOf(`/storage/v1/object/public/${PRODUCT_BUCKET}/`) >= 0;
}

// Extracts the storage object path from a stored shape image URL, but only
// when the URL actually points at OUR shape bucket (pasted external URLs and
// inline data URLs are never touched).
function shapeImagePathFromUrl(url) {
  const u = String(url || '');
  const marker = `/storage/v1/object/public/${SHAPE_BUCKET}/`;
  const at = u.indexOf(marker);
  return at >= 0 ? u.slice(at + marker.length) : null;
}

async function removeShapeImage(url) {
  const objectPath = shapeImagePathFromUrl(url);
  if (!isConfigured() || !objectPath) return false;
  try {
    const { error } = await client().storage.from(SHAPE_BUCKET).remove([objectPath]);
    if (error) throw new Error(error.message);
    return true;
  } catch (e) {
    console.warn('[shapes] could not delete the stored shape image:', e.message);
    return false;
  }
}

module.exports = {
  BUCKET,
  SHAPE_BUCKET,
  PRODUCT_BUCKET,
  LIBRARY_PREFIX,
  MAX_BYTES,
  ALLOWED_MIME,
  isConfigured,
  info,
  parseImageDataUrl,
  parseCarImageDataUrl,
  uploadCarPhoto,
  uploadPaymentProof,
  signedUrl,
  removeCarPhoto,
  ensureBucket,
  uploadShapeImage,
  removeShapeImage,
  shapeImagePathFromUrl,
  ensureShapeBucket,
  shapeStorageStatus,
  ensurePublicBucket,
  ensureProductBucket,
  uploadProductImage,
  uploadLibraryImage,
  productStorageStatus,
  isProductImageUrl,
};
