'use strict';
// ============================================================================
// Admin → Brands (edit name + upload/change logo) + storefront rendering
// ----------------------------------------------------------------------------
// The brands table shipped an ✏️ button that had no click handler, so a brand
// could never be renamed or given a logo after it was created. This suite
// drives the REAL admin panel (jsdom) and the REAL server:
//
//   admin ui   the Brands view renders, ✏️ opens a prefilled editor, saving
//              PATCHes through /api/admin/update (name_en / name_ar / logo …)
//              and the table reflects the new values.
//   upload     picking a file posts it to /api/admin/upload; the returned URL
//              lands in the logo field. When the host disk is read-only (the
//              serverless case) the image is kept with the brand record as a
//              data URL instead of failing.
//   server     the PATCH persists: GET /api/data serves the new brand name and
//              logo to the storefront (scratch JSON datastore, never the
//              committed dataset).
//   storefront a brand with a logo renders that image; a brand without one
//              keeps the shipped /img/logos/<slug> fallback.
//
// Usage: npm run test:brands
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const PORT = 3482;
const API = `http://127.0.0.1:${PORT}`;
const DEV_TOKEN = 'brands-test-token-' + Date.now().toString(36);

let pass = 0; let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓', name); }
  else { fail += 1; console.log('  ✗', name, extra !== undefined ? `→ ${extra}` : ''); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, urlPath, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.admin) headers['x-admin-dev-token'] = DEV_TOKEN;
  const res = await fetch(API + urlPath, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') || '';
  let json = null;
  if (type.indexOf('json') >= 0) { try { json = await res.json(); } catch (e) { /* ignore */ } }
  return { ok: res.ok, status: res.status, json };
}

async function waitForServer(child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(API + '/api/data');
      if (r.ok) return true;
    } catch (e) { /* not up yet */ }
    if (child.exitCode !== null) throw new Error('server exited early: ' + child.exitCode);
    await wait(150);
  }
  return false;
}

// 1×1 transparent PNG — a real, tiny image the upload endpoint accepts.
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ---------------------------------------------------------------------------
// Admin panel boot — same shape the other admin suites use.
// ---------------------------------------------------------------------------
async function bootAdmin(catalog, opts = {}) {
  const html = fs.readFileSync(path.join(PUBLIC, 'admin.html'), 'utf8');
  const calls = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => {
    if (!/Could not load|Not implemented/.test(e.message)) console.log('  ! page error:', e.message);
  });
  const dom = new JSDOM(html, {
    virtualConsole,
    url: 'http://localhost:3000/admin',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      // Same stub the other admin suites use: an authenticated admin session.
      window.supabase = { createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: { user: { id: 'admin-1', email: 'admin@test.com' }, access_token: 'test-jwt' } } }),
          signInWithPassword: async () => ({ data: {}, error: null }),
          signOut: async () => ({ error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        },
        from() { return { select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'admin-1' }, error: null }) }) }) }; },
      }) };
      window.__SPINTO_SUPABASE_URL = '%VITE_SUPABASE_URL%';
      window.__SPINTO_SUPABASE_ANON_KEY = '%VITE_SUPABASE_ANON_KEY%';
      window.scrollTo = () => {};
      const realSetInterval = window.setInterval.bind(window);
      window.setInterval = (fn, ms) => realSetInterval(() => {}, 2147483000);
      window.fetch = (u, o = {}) => {
        const url = typeof u === 'string' ? u : u.url;
        let body = null;
        try { body = o.body ? JSON.parse(o.body) : null; } catch (e) { body = null; }
        calls.push({ url, method: o.method || 'GET', body });
        if (url.indexOf('/api/admin/config') >= 0) {
          // The panel refuses to render without a usable client config, then
          // authenticates from the stubbed session above.
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
            url: 'https://testproject.supabase.co', anonKey: 'fake-anon-key-0123456789-abcdefghijklmnopqrstuvwxyz',
          }) });
        }
        if (url.indexOf('/api/admin/data') >= 0) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(catalog) });
        }
        if (url.indexOf('/api/admin/upload') >= 0) {
          if (opts.readOnlyDisk) {
            return Promise.resolve({ ok: false, status: 507, json: () => Promise.resolve({ error: 'File uploads are not writable on this host — paste a public image URL instead.' }) });
          }
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, url: '/img/uploads/up_brandtest.png' }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
      };
      window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'admin-app.js'), 'utf8'));
    },
  });
  await wait(400);
  const { window } = dom;
  const doc = window.document;
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  return { dom, window, doc, calls, click };
}

// ---------------------------------------------------------------------------
// Storefront boot (jsdom) with a given /api/data payload.
// ---------------------------------------------------------------------------
async function bootStorefront(payload) {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: API + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (u) => {
        const url = typeof u === 'string' ? u : u.url;
        if (url.indexOf('/api/data') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      };
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.alert = () => {};
      window.scrollTo = () => {};
    },
  });
  dom.window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'engine.js'), 'utf8'));
  dom.window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8'));
  // The home page paints in passes (hero, sections, brand strip) — wait for the
  // brand strip instead of racing it with a fixed delay.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !dom.window.document.querySelector('#brand-strip')) await wait(50);
  await wait(120);
  return dom;
}

(async function main() {
  // Scratch datastore — the committed dataset is never touched.
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinto-brands-'));
  const scratchDb = path.join(scratchDir, 'velocci-db.json');
  fs.copyFileSync(path.join(ROOT, 'data', 'velocci-db.json'), scratchDb);

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      VELOCCI_DB: scratchDb,
      DATA_DRIVER: 'json',
      ADMIN_DEV_TOKEN: DEV_TOKEN,
      VITE_SUPABASE_URL: '',
      SUPABASE_DB_URL: '', DATABASE_URL: '', POSTGRES_URL: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });

  try {
    const up = await waitForServer(child);
    if (!up) { console.error('server did not start\n', serverLog); process.exit(1); }

    const payload = (await http('GET', '/api/data')).json;
    const TARGET = 'b_mercedes-benz';
    const brand = payload.brands.find((b) => b.id === TARGET);
    check('catalog has the brands collection', Array.isArray(payload.brands) && payload.brands.length > 0, payload.brands && payload.brands.length);
    check('test brand exists', !!brand, TARGET);
    check('brand starts with no custom logo', !brand.logo, JSON.stringify(brand.logo));

    // ============================================================ 1. admin UI
    console.log('\n== 1. Admin → Brands: rename + logo editor ==');
    const adm = await bootAdmin(payload);
    const { doc, calls, click } = adm;
    check('admin panel boots', !!doc.querySelector('.sidebar'));

    const navBrands = doc.querySelector('[data-nav="brands"]');
    check('sidebar exposes the Brands section', !!navBrands);
    if (navBrands) { click(navBrands); await wait(150); }

    const rows = doc.querySelectorAll('[data-edit-brand]');
    check('brands table renders the edit buttons', rows.length === payload.brands.length, `${rows.length} vs ${payload.brands.length}`);
    check('brand row shows the current name', new RegExp(brand.name_en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(doc.querySelector('.data-table tbody').textContent));

    const editBtn = doc.querySelector(`[data-edit-brand="${TARGET}"]`);
    check('the row' + '’' + 's edit button is wired (opens an editor)', !!editBtn);
    click(editBtn); await wait(80);

    const form = doc.querySelector('#brand-form');
    check('editor opens prefilled with the brand', !!form
      && form.querySelector('[name=name_en]').value === brand.name_en
      && form.querySelector('[name=slug]').value === brand.slug,
      form ? form.querySelector('[name=name_en]').value : 'no form');
    check('editor is an EDIT dialog, not a blank create dialog', !!form && !!doc.querySelector('#brand-logo-input'), !!form);
    check('editor exposes a file upload control for the logo',
      !!doc.querySelector('#brand-upload-zone') && !!doc.querySelector('#brand-file-input'));
    check('editor exposes an Arabic name field', !!form && !!form.querySelector('[name=name_ar]'));

    // rename
    form.querySelector('[name=name_en]').value = 'Mercedes-Benz Egypt';
    form.querySelector('[name=name_ar]').value = 'مرسيدس بنز';
    doc.querySelector('#brand-logo-input').value = '/img/uploads/my-brand.png';
    click(doc.querySelector('#btn-save-brand'));
    await wait(120);

    const patch = calls.filter((c) => c.url.indexOf('/api/admin/update') >= 0 && c.body && c.body.collection === 'brands').pop();
    check('saving PATCHes the brand through /api/admin/update', !!patch, JSON.stringify(calls.map((c) => c.url)));
    check('patch carries the new name + logo', !!patch
      && patch.body.id === TARGET
      && patch.body.updates.name_en === 'Mercedes-Benz Egypt'
      && patch.body.updates.name_ar === 'مرسيدس بنز'
      && patch.body.updates.logo === '/img/uploads/my-brand.png',
      JSON.stringify(patch && patch.body));
    check('patch does NOT resend the whole record (heavy columns are preserved server-side)',
      !!patch && patch.body.updates.models === undefined && patch.body.updates.order === undefined
        && patch.body.updates.emblem === undefined && patch.body.updates.product_count === undefined
        && patch.body.updates.active === undefined,
      JSON.stringify(patch && patch.body.updates));
    check('editor closes after saving', !doc.querySelector('#brand-form'));
    check('brands table now shows the new name', /Mercedes-Benz Egypt/.test(doc.querySelector('.data-table tbody').textContent));
    check('brands table now shows the new logo', /my-brand\.png/.test(doc.querySelector('.data-table tbody').innerHTML));

    // ======================================================= 2. logo upload
    console.log('\n== 2. Admin → Brands: logo upload ==');
    click(doc.querySelector(`[data-edit-brand="${TARGET}"]`)); await wait(80);
    const fileInput = doc.querySelector('#brand-file-input');
    const file = new adm.window.File([Buffer.from(PNG_DATA_URL.split(',')[1], 'base64')], 'logo.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [file] });
    fileInput.dispatchEvent(new adm.window.Event('change', { bubbles: true }));
    await wait(200);
    const upload = calls.filter((c) => c.url.indexOf('/api/admin/upload') >= 0).pop();
    check('picking a file posts it to /api/admin/upload', !!upload);
    check('the upload body carries the image as a data URL',
      !!upload && /^data:image\/png;base64,/.test(upload.body.dataUrl || ''), upload && String(upload.body.dataUrl).slice(0, 30));
    check('the served URL lands in the logo field',
      doc.querySelector('#brand-logo-input').value === '/img/uploads/up_brandtest.png',
      doc.querySelector('#brand-logo-input').value);
    check('the logo preview shows the uploaded image',
      doc.querySelector('#brand-logo-preview').getAttribute('src') === '/img/uploads/up_brandtest.png');
    click(doc.querySelector('#brand-logo-clear')); await wait(20);
    check('clear empties the logo field', doc.querySelector('#brand-logo-input').value === '');
    check('clear hides the preview', doc.querySelector('#brand-logo-preview').style.display === 'none');

    // read-only host (Vercel): the logo must still be usable
    const admRo = await bootAdmin(payload, { readOnlyDisk: true });
    admRo.click(admRo.doc.querySelector('[data-nav="brands"]')); await wait(150);
    admRo.click(admRo.doc.querySelector(`[data-edit-brand="${TARGET}"]`)); await wait(80);
    const roInput = admRo.doc.querySelector('#brand-file-input');
    const roFile = new admRo.window.File([Buffer.from(PNG_DATA_URL.split(',')[1], 'base64')], 'logo.png', { type: 'image/png' });
    Object.defineProperty(roInput, 'files', { value: [roFile] });
    roInput.dispatchEvent(new admRo.window.Event('change', { bubbles: true }));
    await wait(250);
    check('read-only disk: upload failure does not throw or empty the field',
      !!admRo.doc.querySelector('#brand-logo-input'));
    check('read-only disk: the logo is kept with the brand as a data URL',
      /^data:image\/png;base64,/.test(admRo.doc.querySelector('#brand-logo-input').value || ''),
      String(admRo.doc.querySelector('#brand-logo-input').value).slice(0, 30));

    // ================================================= 3. server round-trip
    console.log('\n== 3. Server: the change persists and reaches /api/data ==');
    const saved = await http('POST', '/api/admin/update', {
      collection: 'brands', id: TARGET,
      updates: { name_en: 'Mercedes-Benz Egypt', name_ar: 'مرسيدس بنز', logo: '/img/uploads/my-brand.png' },
    }, { admin: true });
    check('admin update endpoint accepts the brand patch', saved.ok && saved.json && saved.json.ok !== false, JSON.stringify(saved.json));

    const after = (await http('GET', '/api/data')).json;
    const updated = after.brands.find((b) => b.id === TARGET);
    check('/api/data serves the renamed brand', updated && updated.name_en === 'Mercedes-Benz Egypt' && updated.name_ar === 'مرسيدس بنز',
      updated && updated.name_en);
    check('/api/data serves the new brand logo', updated && updated.logo === '/img/uploads/my-brand.png', updated && updated.logo);
    check('other brand fields survived the patch',
      updated && updated.slug === brand.slug && JSON.stringify(updated.models) === JSON.stringify(brand.models));
    const untouched = after.brands.find((b) => b.id !== TARGET);
    check('no other brand was modified', untouched && !untouched.logo);

    // ==================================================== 4. storefront
    console.log('\n== 4. Storefront renders the updated brand name + logo ==');
    const sfDom = await bootStorefront(after);
    const sfDoc = sfDom.window.document;

    sfDom.window.location.hash = '#/brands';
    await wait(200);
    const allGrid = sfDoc.querySelector('.brand-grid');
    check('all-brands page renders the brand tiles', !!allGrid && allGrid.querySelectorAll('.brand-tile').length === after.brands.length,
      allGrid && allGrid.querySelectorAll('.brand-tile').length);
    check('all-brands page shows the updated name', !!allGrid && /Mercedes-Benz Egypt/.test(allGrid.textContent));
    check('all-brands page shows the uploaded logo',
      !!allGrid && !!allGrid.querySelector('img.brand-logo[src="/img/uploads/my-brand.png"]'));
    findFirst: {
      const fallbackLogo = allGrid && allGrid.querySelector('img.brand-logo[src*="/img/logos/"]');
      check('brands without a custom logo keep the shipped file fallback', !!fallbackLogo,
        fallbackLogo && fallbackLogo.getAttribute('src'));
    }

    sfDom.window.location.hash = `#/brand/${updated.slug}`;
    await wait(200);
    const heroLogo = sfDoc.querySelector('.brand-hero-logo img.brand-logo');
    check('brand landing page shows the uploaded logo',
      !!heroLogo && heroLogo.getAttribute('src') === '/img/uploads/my-brand.png',
      heroLogo && heroLogo.getAttribute('src'));
    check('brand landing page shows the updated name', /Mercedes-Benz Egypt/.test(sfDoc.querySelector('.brand-hero').textContent));

    // engine contract
    const engineSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'engine.js'), 'utf8');
    check('brandLogoImg still defaults to the file logo when no src is given',
      /var src = \(opts\.src && String\(opts\.src\)\.trim\(\)\) \|\| VEL\.brandLogoUrl\(slug\);/.test(engineSrc));

    // flash
    console.log('\n== 5. Served build ==');
    const idx = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    const admHtml = fs.readFileSync(path.join(PUBLIC, 'admin.html'), 'utf8');
    const appV = (idx.match(/\/js\/app\.js\?v=([0-9a-z]+)/) || [])[1];
    const admV = (admHtml.match(/\/js\/admin-app\.js\?v=([0-9a-z]+)/) || [])[1];
    check('storefront + admin bundles are cache-busted to the same new build',
      !!appV && appV !== '20260917c' && admV === appV, `${appV} / ${admV}`);
  } finally {
    child.kill('SIGTERM');
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
