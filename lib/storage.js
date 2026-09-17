'use strict';
// ============================================================================
// VILOCCI — private storage for Customize car photos
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
const SIGNED_URL_TTL = Math.max(30, Number(process.env.CUSTOMIZE_SIGNED_URL_TTL || 300));
const MAX_BYTES = Math.max(64 * 1024, Number(process.env.CUSTOMIZE_MAX_IMAGE_BYTES || 6 * 1024 * 1024));

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
function parseImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) {
    throw fail('The car photo is required.', 'MISSING_IMAGE');
  }
  if (dataUrl.length > Math.ceil((MAX_BYTES * 4) / 3) + 1024) {
    throw fail(`The car photo is too large (max ${Math.round(MAX_BYTES / (1024 * 1024))} MB).`, 'IMAGE_TOO_LARGE');
  }
  const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(dataUrl.trim());
  if (!m) throw fail('The car photo must be an uploaded image file.', 'INVALID_IMAGE');
  const mime = m[1].toLowerCase();
  const ext = ALLOWED_MIME[mime];
  if (!ext) {
    throw fail('Unsupported image type. Please upload a JPG, PNG, WebP or HEIC photo.', 'UNSUPPORTED_TYPE');
  }
  const buffer = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (!buffer.length) throw fail('The uploaded photo is empty.', 'EMPTY_IMAGE');
  if (buffer.length > MAX_BYTES) {
    throw fail(`The car photo is too large (max ${Math.round(MAX_BYTES / (1024 * 1024))} MB).`, 'IMAGE_TOO_LARGE');
  }
  if (!signatureMatches(mime, buffer)) {
    throw fail('That file does not look like a real image. Please upload a JPG, PNG or WebP photo.', 'BAD_SIGNATURE');
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

module.exports = {
  BUCKET,
  MAX_BYTES,
  ALLOWED_MIME,
  isConfigured,
  info,
  parseImageDataUrl,
  uploadCarPhoto,
  signedUrl,
  removeCarPhoto,
  ensureBucket,
};
