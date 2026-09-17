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
function buildTables(categoryRows) {
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const settings = Object.assign({}, db.settings);
  if (db.languages) settings.languages = db.languages;   // same merge as scripts/migrate.js
  return {
    products: db.products.map(mapping.productToRow),
    categories: categoryRows,
    brands: db.brands.map(mapping.brandToRow),
    bundles: db.bundles.map(mapping.bundleToRow),
    hero_slides: db.heroSlides.map(mapping.heroSlideToRow),
    home_sections: db.homeSections.map(mapping.homeSectionToRow),
    settings: mapping.settingRows(settings),
    promo_bar: [mapping.promoBarToRow(db.promoBar)],
    customize_requests: [],
  };
}

const DB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

// The three rows the content migration writes — used to build the "seeded but
// switched off" and "one hidden by the admin" fixtures. Product counts are the
// real ones, exactly as the migration writes them.
function seededCategoryRows(overrides) {
  const ar = (DB.languages && DB.languages.dict && DB.languages.dict.ar) || {};
  const en = (DB.languages && DB.languages.dict && DB.languages.dict.en) || {};
  return mapping.CATEGORY_META.map((m) => mapping.categoryToRow(Object.assign({
    id: m.key, slug: m.slug,
    name_en: en[m.dictKey] || m.labelEn, name_ar: ar[m.dictKey] || '',
    description_en: null, description_ar: null, image: null, active: true, order: m.order,
    product_count: DB.products.filter((p) => p.category === m.key).length,
  }, (overrides && overrides[m.key]) || {})));
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
async function scenario(label, categoryRows, expectIds, expectCount) {
  installPostgrestStub(buildTables(categoryRows));
  for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}lib${path.sep}`)) delete require.cache[k];
  const db = require('../lib/db');

  console.log(`\n== CUSTOMIZE NAV: ${label} ==`);
  check('the postgrest driver is active (not the JSON fallback)',
    db.info().activeDriver === 'postgrest' && db.info().usingJsonFallback === false,
    JSON.stringify(db.info().activeDriver) + ' / fallback=' + db.info().usingJsonFallback);

  const catalog = await db.getCatalog();
  const cats = await db.getCustomizeCategories();
  check('the offered categories are exactly the expected ones',
    cats.map((c) => c.id).join(',') === expectIds, cats.map((c) => c.id).join(',') || '(none)');
  if (expectIds) {
    check('catalogue is not empty', catalog.categories.length > 0, catalog.categories.length);
    check('every category carries an EN and an AR name from the site dictionary',
      cats.every((c) => c.name_en && c.name_ar), JSON.stringify(cats.map((c) => [c.name_en, c.name_ar])));
    check('product counts come from the real catalogue',
      cats.reduce((s, c) => s + c.product_count, 0) === expectCount, cats.reduce((s, c) => s + c.product_count, 0));
    const payload = db.publicPayload(catalog);
    check('/api/data reports customize.available', payload.customize.available === true);
    check('/api/data carries the customize categories',
      payload.customize.categories.map((c) => c.id).join(',') === expectIds,
      payload.customize.categories.map((c) => c.id).join(',') || '(none)');
    await db.close();
    return payload;
  }
  await db.close();
  return null;
}

async function dataLayer() {
  process.env.VITE_SUPABASE_URL = MOCK_URL;
  process.env.VITE_SUPABASE_ANON_KEY = MOCK_KEY;
  delete process.env.SUPABASE_DB_URL;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  delete process.env.DATA_DRIVER;

  // (a) schema applied, content migration never run: no category rows at all.
  const empty = await scenario('postgrest, categories table EMPTY', [], 'keycase,keyholder,medal', 117);

  // (b) THE LIVE SHAPE: the migration wrote the three rows, but every one of
  //     them is switched off — and RLS `using (active = true)` hides them from
  //     the browser, which is why the storefront saw nothing.
  await scenario('postgrest, three seeded rows ALL inactive (live production shape)',
    seededCategoryRows({ keycase: { active: false }, keyholder: { active: false }, medal: { active: false } }),
    'keycase,keyholder,medal', 117);

  // (c) an admin hiding ONE category must still hide exactly that one.
  await scenario('postgrest, admin switched ONE category off (intent preserved)',
    seededCategoryRows({ keyholder: { active: false } }), 'keycase,medal', 88);

  // (d) The Admin Customize ON/OFF switch is a SEPARATE control from
  //     categories.active and must still win.
  installPostgrestStub(buildTables(seededCategoryRows()));
  for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}lib${path.sep}`)) delete require.cache[k];
  const db = require('../lib/db');
  const catalog = await db.getCatalog();
  const toggled = db.publicPayload(Object.assign({}, catalog, {
    settings: Object.assign({}, catalog.settings, {
      customize: { categories: { keycase: true, keyholder: false, medal: true } },
    }),
  }));
  console.log('\n== CUSTOMIZE NAV: admin Customize ON/OFF switch ==');
  check('the Admin OFF switch still removes a category',
    toggled.customize.categories.map((c) => c.id).join(',') === 'keycase,medal',
    toggled.customize.categories.map((c) => c.id).join(','));
  await db.close();

  return empty;
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

// ===========================================================================
// 4. the HOMEPAGE banner — premium minimal, directly after "Complete Your Set"
// ---------------------------------------------------------------------------
// The banner is an ENTRY POINT only: it must sit immediately after the
// "Complete Your Set" section, exist in EN and AR, and open the very same
// #/customize route + five-step flow the header pill and the mobile menu
// already use. Neither of those two entries may change.
// ===========================================================================

// Walk up to the direct child of #main that contains `el` — i.e. the
// homepage SECTION the element belongs to.
function outerSection(el) {
  let n = el;
  while (n && n.parentElement && n.parentElement.id !== 'main') n = n.parentElement;
  return n;
}

function homeDom(payload, lang) {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => {
    if (!/Could not load|Not implemented/.test(e.message)) console.log('  ! page error:', e.message);
  });
  const dom = new JSDOM(html, {
    virtualConsole,
    url: 'http://localhost:3000/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.alert = () => {};
      window.scrollTo = () => {};
      window.localStorage.setItem('velocci_lang', lang || 'en');
      window.fetch = (u) => {
        const url = typeof u === 'string' ? u : u.url;
        if (url.indexOf('/api/data') >= 0) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
      };
    },
  });
  dom.window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'engine.js'), 'utf8'));
  dom.window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8'));
  return dom;
}

async function homepageBanner(payload) {
  console.log('\n== CUSTOMIZE NAV: homepage banner after "Complete Your Set" ==');
  const cssText = fs.readFileSync(path.join(PUBLIC, 'css', 'styles.css'), 'utf8');
  const appSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8');

  // ---------------------------------------------------------- EN homepage
  const dom = homeDom(payload, 'en');
  await wait(220);
  const doc = dom.window.document;
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  const banner = doc.querySelector('.section-czbanner');
  check('the homepage renders the Customize banner', !!banner);

  // -- placement: DIRECTLY after "Complete Your Set", nothing in between ---
  const setOuter = outerSection(doc.querySelector('#main .set-banner'));
  check('the "Complete Your Set" section is still on the homepage', !!setOuter);
  check('the banner sits DIRECTLY after "Complete Your Set" (adjacent sibling)',
    !!setOuter && setOuter.nextElementSibling === banner,
    setOuter && setOuter.nextElementSibling ? (setOuter.nextElementSibling.className || setOuter.nextElementSibling.id) : 'none');
  check('the banner is inside #main with the other homepage sections',
    !!banner && banner.parentElement && banner.parentElement.id === 'main');

  // -- the four required pieces -------------------------------------------
  const kicker = banner && banner.querySelector('.czbanner-kicker');
  check('1. gold kicker is present', !!kicker && txt(kicker) === 'Bespoke Atelier', txt(kicker));
  check('   …and the kicker is styled in gold',
    /\.czbanner-kicker\s*\{[^}]*var\(--gold-soft\)/.test(cssText));

  const title = banner && banner.querySelector('.czbanner-title');
  check('2. serif "Customize" heading is present', !!title && txt(title) === 'Customize', txt(title));
  check('   …it is an h2 set in the serif display face',
    !!title && title.tagName === 'H2' && /\.czbanner-title\s*\{[^}]*var\(--serif\)/.test(cssText));

  const desc = banner && banner.querySelector('.czbanner-desc');
  check('3. short bespoke-request copy is present',
    !!desc && txt(desc).length > 20 && txt(desc).length < 160, txt(desc));

  const cta = banner && banner.querySelector('a.czbanner-cta');
  check('4. gold "Customize Your Car →" button is present',
    !!cta && cta.classList.contains('btn') && cta.classList.contains('btn-gold') &&
    txt(cta) === 'Customize Your Car →', txt(cta) + ' [' + (cta ? cta.className : '') + ']');
  check('   …the CTA targets the existing #/customize route',
    !!cta && cta.getAttribute('href') === '#/customize', cta && cta.getAttribute('href'));

  // -- the button opens the EXISTING 5-step flow ---------------------------
  dom.window.location.hash = cta.getAttribute('href');
  dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
  await wait(120);
  const steps = Array.from(doc.querySelectorAll('#cz-steps .cz-step')).map((s) => txt(s));
  check('the homepage button opens the existing 5-step Customize flow',
    !!doc.querySelector('#cz-form') && steps.length === 5, steps.length + ' → ' + steps.join(' | '));
  check('it is the SAME flow the route already served (sequence unchanged)',
    steps.map((s) => s.replace(/^(?:\d+|✓)\s*/, '')).join(' | ') ===
      'Choose | Photo | Car info | Your request | Your details',
    steps.map((s) => s.replace(/^(?:\d+|✓)\s*/, '')).join(' | '));
  check('the banner added no second Customize implementation',
    (appSrc.match(/function customizeHTML\(/g) || []).length === 1 &&
    (appSrc.match(/function czCategories\(/g) || []).length === 1);
  const bannerFn = (appSrc.match(/function customizeBannerSection\(\)[\s\S]*?\n {2}\}/) || [''])[0];
  check('the banner builder is an entry point only (no fetch / no new API)',
    bannerFn.length > 0 && !/fetch\(/.test(bannerFn));

  // -- the two existing entries are untouched ------------------------------
  dom.window.location.hash = '#/';
  dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
  await wait(100);
  const pill = Array.from(doc.querySelectorAll('.nav a')).find((a) => txt(a) === 'Customize');
  check('the desktop gold nav pill is unchanged',
    !!pill && pill.classList.contains('nav-customize') && pill.getAttribute('href') === '#/customize',
    pill ? pill.className + ' → ' + pill.getAttribute('href') : 'missing');
  const mob = Array.from(doc.querySelectorAll('.nav-mobile > a')).find((a) => txt(a) === 'Customize');
  check('the side/mobile menu Customize item is unchanged (highlighted row, same target)',
    !!mob && mob.classList.contains('nav-customize-m') && mob.getAttribute('href') === '#/customize',
    mob ? mob.className + ' → ' + mob.getAttribute('href') : 'missing');
  check('the footer Quick Links still show Customize',
    Array.from(doc.querySelectorAll('.footer a')).some((a) => a.getAttribute('href') === '#/customize'));

  // the side-menu entry must still open the flow, exactly as before
  dom.window.location.hash = '#/';
  dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
  await wait(80);
  dom.window.location.hash = mob.getAttribute('href');
  dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
  await wait(100);
  check('the side-menu Customize item still opens the 5-step flow',
    !!doc.querySelector('#cz-form') &&
    doc.querySelectorAll('#cz-steps .cz-step').length === 5,
    doc.querySelectorAll('#cz-steps .cz-step').length);
  dom.window.close();

  // ---------------------------------------------------------- AR homepage
  const domAr = homeDom(payload, 'ar');
  await wait(220);
  const docAr = domAr.window.document;
  check('Arabic: the document switches to lang=ar / dir=rtl',
    docAr.documentElement.getAttribute('lang') === 'ar' && docAr.documentElement.getAttribute('dir') === 'rtl');
  const bAr = docAr.querySelector('.section-czbanner');
  check('Arabic: the banner renders', !!bAr);
  check('Arabic: gold kicker is localised',
    txt(bAr && bAr.querySelector('.czbanner-kicker')) === 'أتيليه خاص', txt(bAr && bAr.querySelector('.czbanner-kicker')));
  check('Arabic: serif heading is localised to "تخصيص"',
    txt(bAr && bAr.querySelector('.czbanner-title')) === 'تخصيص', txt(bAr && bAr.querySelector('.czbanner-title')));
  check('Arabic: bespoke copy is localised',
    /أتيليهنا/.test(txt(bAr && bAr.querySelector('.czbanner-desc'))), txt(bAr && bAr.querySelector('.czbanner-desc')));
  const cAr = bAr && bAr.querySelector('a.czbanner-cta');
  check('Arabic: the gold CTA is localised and still targets #/customize',
    !!cAr && /خصّص سيارتك/.test(txt(cAr)) && cAr.getAttribute('href') === '#/customize', txt(cAr));
  const setAr = outerSection(docAr.querySelector('#main .set-banner'));
  check('Arabic: the banner is still directly after "Complete Your Set"',
    !!setAr && setAr.nextElementSibling === bAr);
  check('Arabic: an RTL rule mirrors the CTA arrow',
    /html\[dir="rtl"\] \.czbanner-cta \.btn-arrow/.test(cssText));
  domAr.window.close();

  // ------------------------------------------------- unconditional render
  const noSet = JSON.parse(JSON.stringify(payload));
  noSet.homeSections = (noSet.homeSections || []).filter((s) => s.type !== 'completeset');
  const domOff = homeDom(noSet, 'en');
  await wait(220);
  check('the banner still renders when "Complete Your Set" is switched off',
    !!domOff.window.document.querySelector('.section-czbanner') &&
    !domOff.window.document.querySelector('#main .set-banner'));
  domOff.window.close();

  // ------------------------------------------------- shipped / cache-busted
  check('the banner CSS ships in the served stylesheet',
    /\.section-czbanner/.test(cssText) && /\.czbanner-card/.test(cssText) && /\.czbanner-title/.test(cssText));
  check('the banner CSS keeps a mobile/responsive rule',
    /max-width:\s*768px[\s\S]{0,600}\.czbanner-card/.test(cssText));
  const idx = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const appV = (idx.match(/\/js\/app\.js\?v=([0-9a-z]+)/) || [])[1];
  const cssV = (idx.match(/\/css\/styles\.css\?v=([0-9a-z]+)/) || [])[1];
  check('index.html bumps app.js + styles.css to the same new cache-buster',
    !!appV && appV === cssV && appV !== '20260917a', appV + ' / ' + cssV);
}

(async function main() {
  try {
    const payload = await dataLayer();
    await storefront(payload);
    await homepageBanner(payload);
  } catch (e) {
    console.error('customize-nav test crashed:', e);
    process.exit(1);
  }
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
