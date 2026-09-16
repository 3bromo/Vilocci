'use strict';
// ============================================================================
// Customize — storefront VISIBILITY / ROUTING regression test
// ----------------------------------------------------------------------------
// Why this exists
// ---------------
// The Customize flow was shipped and "verified", yet no Customize entry was
// reachable on the live storefront. The cause was not a missing page: it was
// that the entry was conditional on data that the live database did not have.
//
//   headerHTML():  if (czCategories().length) navLinks.push([… '#/customize'])
//
// `czCategories()` reads `/api/data → customize.categories`, which is derived
// from the `categories` collection. The JSON fallback driver DERIVES that
// collection from the products, so it always reported 3 categories — but the
// Supabase-backed production instance had an EMPTY `categories` table and no
// such derivation, so it reported zero and the nav entry silently disappeared.
//
// This test drives the REAL code on both sides of that seam:
//
//   1. lib/db.js through the REAL postgrest driver (a local PostgREST stub
//      answers the actual HTTP calls) with an empty `categories` table — the
//      exact production shape — and asserts the 3 categories come back.
//   2. public/js/app.js in jsdom with that payload, asserting the Customize
//      entry is in the desktop nav, the mobile menu and the footer, that it
//      opens the real 5-step wizard with the 3 categories, and that the page
//      is reachable directly by path (/customize) as well as by hash.
//
// Usage: npm run test:customize_nav
// ============================================================================

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const mapping = require('../lib/mapping');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const DB_FILE = path.join(ROOT, 'data', 'velocci-db.json');

const MOCK_URL = 'https://mock-project.supabase.co';
const MOCK_KEY = 'fake-anon-key-0123456789-abcdefghijklmnopqrstuvwxyz';

let pass = 0; let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓', name); }
  else { fail += 1; console.log('  ✗', name, extra !== undefined ? `→ ${extra}` : ''); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// PostgREST stub — answers the real HTTP calls lib/db.js makes.
//
// `categories: []` is the production condition: the schema exists, the
// products are there, but nobody ever inserted category rows.
// ---------------------------------------------------------------------------
function buildTables() {
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const settings = Object.assign({}, db.settings);
  if (db.languages) settings.languages = db.languages;   // same merge as scripts/migrate.js
  return {
    products: db.products.map(mapping.productToRow),
    categories: [],
    brands: db.brands.map(mapping.brandToRow),
    bundles: db.bundles.map(mapping.bundleToRow),
    hero_slides: db.heroSlides.map(mapping.heroSlideToRow),
    home_sections: db.homeSections.map(mapping.homeSectionToRow),
    settings: mapping.settingRows(settings),
    promo_bar: [mapping.promoBarToRow(db.promoBar)],
    customize_requests: [],
  };
}

function installPostgrestStub(tables) {
  const seen = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    seen.push(url);
    const m = /\/rest\/v1\/([a-z_]+)/.exec(url);
    const table = m ? m[1] : null;
    if (!table || !(table in tables)) {
      return { ok: false, status: 404, headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ code: 'PGRST205', message: `table ${table} not found` }), text: async () => '' };
    }
    return { ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json', 'content-range': `0-${tables[table].length - 1}/${tables[table].length}` }),
      json: async () => tables[table], text: async () => JSON.stringify(tables[table]) };
  };
  return seen;
}

// ===========================================================================
// 1. the data layer, through the real postgrest driver
// ===========================================================================
async function dataLayer() {
  console.log('\n== CUSTOMIZE NAV: data layer (postgrest driver, empty categories table) ==');
  installPostgrestStub(buildTables());
  process.env.VITE_SUPABASE_URL = MOCK_URL;
  process.env.VITE_SUPABASE_ANON_KEY = MOCK_KEY;
  delete process.env.SUPABASE_DB_URL;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  delete process.env.DATA_DRIVER;
  for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}lib${path.sep}`)) delete require.cache[k];

  const db = require('../lib/db');
  check('the postgrest driver is active (not the JSON fallback)',
    db.info().activeDriver === 'postgrest' && db.info().usingJsonFallback === false,
    JSON.stringify(db.info().activeDriver) + ' / fallback=' + db.info().usingJsonFallback);

  const catalog = await db.getCatalog();
  check('an empty categories table no longer yields an empty catalogue',
    Array.isArray(catalog.categories) && catalog.categories.length === 3,
    catalog.categories.length);

  const cats = await db.getCustomizeCategories();
  check('the 3 Customize categories are offered', cats.length === 3, cats.length);
  check('they are the site\'s real categories, in order',
    cats.map((c) => c.id).join(',') === 'keycase,keyholder,medal', cats.map((c) => c.id).join(','));
  check('each has an EN and an AR name from the site dictionary',
    cats.every((c) => c.name_en && c.name_ar), JSON.stringify(cats.map((c) => [c.name_en, c.name_ar])));
  check('product counts are derived from the real catalogue',
    cats.reduce((s, c) => s + c.product_count, 0) === 117, cats.reduce((s, c) => s + c.product_count, 0));

  const payload = db.publicPayload(catalog);
  check('/api/data reports customize.available', payload.customize.available === true);
  check('/api/data carries the 3 customize categories',
    payload.customize.categories.length === 3, payload.customize.categories.length);

  // The Admin ON/OFF switch must still win once categories exist.
  const off = db.publicPayload(Object.assign({}, catalog, {
    settings: Object.assign({}, catalog.settings, { customize: { categories: { keycase: true, keyholder: false, medal: true } } }),
  }));
  check('the Admin OFF switch still removes a category',
    off.customize.categories.map((c) => c.id).join(',') === 'keycase,medal',
    off.customize.categories.map((c) => c.id).join(','));

  await db.close();
  return payload;
}

// ===========================================================================
// 2. the storefront, driven with that payload
// ===========================================================================
async function storefront(payload) {
  console.log('\n== CUSTOMIZE NAV: storefront visibility + routing ==');
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => {
    if (!/Could not load|Not implemented/.test(e.message)) console.log('  ! page error:', e.message);
  });

  const dom = new JSDOM(html, {
    virtualConsole,
    url: 'http://localhost:3000/customize',   // direct clean URL, no hash
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.alert = () => {};
      window.scrollTo = () => {};
      window.fetch = (u) => {
        const url = typeof u === 'string' ? u : u.url;
        if (url.indexOf('/api/data') >= 0) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
      };
    },
  });

  const { window } = dom;
  const { document } = window;
  window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'engine.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8'));
  await wait(200);

  const links = (sel) => Array.from(document.querySelectorAll(sel));
  const navText = links('.nav a').map((a) => a.textContent.trim());
  const mobileText = links('.nav-mobile > a').map((a) => a.textContent.trim());

  // -- 1/2. visible in the main navigation, desktop AND mobile -------------
  check('desktop nav shows a Customize link',
    navText.indexOf('Customize') !== -1, navText.join(' | '));
  check('the desktop Customize link points at the real flow',
    links('.nav a').some((a) => a.textContent.trim() === 'Customize' && a.getAttribute('href') === '#/customize'));
  check('the mobile menu shows the same Customize link',
    mobileText.indexOf('Customize') !== -1, mobileText.join(' | '));
  check('the footer Quick Links show Customize',
    links('.footer a').some((a) => a.getAttribute('href') === '#/customize'));
  check('existing nav items are untouched',
    ['Key Cases', 'Key Holders', 'Car Medals', 'Packages', 'Brands'].every((l) => navText.indexOf(l) !== -1),
    navText.join(' | '));

  // -- 6. reachable directly by its route ----------------------------------
  check('the clean URL /customize is normalised into the hash route',
    window.location.hash === '#/customize', window.location.hash);
  check('/customize renders the Customize page, not the home page',
    !!document.querySelector('#cz-form') && !document.querySelector('.hero'),
    document.querySelector('#main') ? document.querySelector('#main').className : 'no #main');

  // -- 9. the 3 configured categories are displayed ------------------------
  const catCards = links('[data-cz-cat]');
  check('the Customize page lists all 3 categories', catCards.length === 3, catCards.length);
  check('the category names match the site catalogue',
    catCards.map((c) => c.textContent.replace(/\s+/g, ' ').trim())
      .every((txt) => /Key Cases|Key Holders|Car Medals/.test(txt)),
    catCards.map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join(' | '));

  // -- 3. the real 5-step flow is what opens -------------------------------
  const steps = links('#cz-steps .cz-step').map((s) => s.textContent.replace(/\s+/g, ' ').trim());
  check('the 5-step flow renders (Choose → Photo → Car info → Request → Details)',
    steps.length === 5, steps.length + ' → ' + steps.join(' | '));
  check('the steps are the implemented sequence',
    steps.map((s) => s.replace(/^(?:\d+|✓)\s*/, '')).join(' | ') === 'Choose | Photo | Car info | Your request | Your details',
    steps.map((s) => s.replace(/^(?:\d+|✓)\s*/, '')).join(' | '));
  check('the wizard starts on the category step',
    !!document.querySelector('#cz-block-1 [data-cz-cat]') &&
    /Choose/.test(steps[0] || ''), steps[0]);

  // hash navigation still works for every other route (nothing broken)
  window.location.hash = '#/';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await wait(80);
  check('navigating back to the home route still works',
    !document.querySelector('#cz-form') && !!document.querySelector('#main').innerHTML.trim());

  window.location.hash = '#/customize';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await wait(80);
  check('the hash route #/customize still works', !!document.querySelector('#cz-form'));

  // -- 4/5. one implementation: the entry uses the existing page -----------
  check('there is exactly one Customize implementation in the served bundle',
    (fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8').match(/function customizeHTML\(/g) || []).length === 1);
  check('the nav entry links to that page (no second route was invented)',
    links('.nav a').filter((a) => a.getAttribute('href') === '#/customize').length === 1);

  // -- resilience: even with no customize data at all the entry survives ---
  const bare = JSON.parse(JSON.stringify(payload));
  bare.customize = { available: false, categories: [] };
  bare.categories = [];
  const dom2 = new JSDOM(html, {
    virtualConsole, url: 'http://localhost:3000/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.scrollTo = () => {};
      window.fetch = (u) => {
        const url = typeof u === 'string' ? u : u.url;
        if (url.indexOf('/api/data') >= 0) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(bare) });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
      };
    },
  });
  dom2.window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'engine.js'), 'utf8'));
  dom2.window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8'));
  await wait(200);
  const nav2 = Array.from(dom2.window.document.querySelectorAll('.nav a')).map((a) => a.textContent.trim());
  check('the Customize entry survives even if the API reports no categories',
    nav2.indexOf('Customize') !== -1, nav2.join(' | '));
  dom2.window.location.hash = '#/customize';
  dom2.window.dispatchEvent(new dom2.window.HashChangeEvent('hashchange'));
  await wait(80);
  check('and the page still offers the site\'s real categories as a fallback',
    dom2.window.document.querySelectorAll('[data-cz-cat]').length === 3,
    dom2.window.document.querySelectorAll('[data-cz-cat]').length);
  dom2.window.close();

  dom.window.close();
}

(async function main() {
  try {
    const payload = await dataLayer();
    await storefront(payload);
  } catch (e) {
    console.error('customize-nav test crashed:', e);
    process.exit(1);
  }
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
