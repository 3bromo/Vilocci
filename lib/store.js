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
const DEFAULT_DB_FILE = path.join(DATA_DIR, 'velocci-db.json');
const DB_FILE = process.env.VELOCCI_DB || DEFAULT_DB_FILE;

// The JSON dataset is also pulled in via require() so that serverless
// bundles (Vercel) always contain it — the function file tracer follows
// require() calls, but not dynamic fs reads of a computed path. This is a
// read-only fallback used only when the file is not present on the
// function's filesystem.
let BUNDLED_DEFAULT_DB = null;
try { BUNDLED_DEFAULT_DB = require('../data/velocci-db.json'); } catch (e) { /* absent — will seed */ }

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
  } else if (!process.env.VELOCCI_DB && BUNDLED_DEFAULT_DB) {
    // Serverless fallback: file not on this filesystem, use the bundled copy.
    _cache = Object.assign(emptyDb(), JSON.parse(JSON.stringify(BUNDLED_DEFAULT_DB)));
  } else {
    _cache = emptyDb();
  }
  // guarantee collection arrays exist
  ['settings','languages','heroSlides','homeSections','brands','bundles','products','shapes','orders','preorders','messages','promoBar'].forEach(k => {
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
