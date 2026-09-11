// ============================================================================
// VELOCCI — Data store
// A single, persistent, atomic JSON datastore shared by the customer website
// and the admin panel. Any change made in admin is immediately visible to the
// customer site because they both read/write the same store.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = process.env.VELOCCI_DB || path.join(DATA_DIR, 'velocci-db.json');

// Default empty shape
function emptyDb() {
  return {
    meta: { version: 1, updatedAt: null },
    settings: {},
    languages: {},
    heroSlides: [],
    homeSections: [],
    brands: [],
    bundles: [],
    products: [],
    orders: [],
    preorders: [],
    messages: [],
    promoBar: {},
  };
}

let _cache = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  if (_cache) return _cache;
  ensureDir();
  if (fs.existsSync(DB_FILE)) {
    try {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      _cache = Object.assign(emptyDb(), JSON.parse(raw));
    } catch (e) {
      console.error('[store] failed to parse DB file, starting fresh:', e.message);
      _cache = emptyDb();
    }
  } else {
    _cache = emptyDb();
  }
  // guarantee collection arrays exist
  ['settings','languages','heroSlides','homeSections','brands','bundles','products','orders','preorders','messages','promoBar'].forEach(k => {
    if (_cache[k] === undefined) _cache[k] = k === 'promoBar' ? {} : (Array.isArray(_cache[k]) ? _cache[k] : []);
  });
  if (typeof _cache.settings !== 'object') _cache.settings = {};
  return _cache;
}

function save() {
  ensureDir();
  const db = load();
  db.meta.updatedAt = new Date().toISOString();
  const tmp = DB_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    // Some hosts (e.g. Vercel serverless) have a read-only filesystem. We keep
    // everything in memory so the site still works for the request lifecycle,
    // and warn once so operators know writes are not persisted to disk.
    console.warn('[store] persist unavailable, keeping in-memory store:', e.message);
  }
}

// Drop in memory cache (used by tests / after seeding)
function reload() { _cache = null; return load(); }

function reset(data) {
  _cache = Object.assign(emptyDb(), data || {});
  save();
  return _cache;
}

function id(prefix) {
  return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

module.exports = { load, save, reload, reset, id, DB_FILE, emptyDb };
