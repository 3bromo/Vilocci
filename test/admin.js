// Headless test for the VILOCCI admin panel (Supabase Auth).
// Uses a stubbed window.supabase client so no real Supabase project is
// needed. Verifies:
//   1. Supabase config bootstrap via /api/admin/config (static admin.html)
//   2. Admin session verification (admin_users) and dashboard render
//   3. /api/admin/* requests carry the Bearer access token
//   4. Friendly "Authentication Not Configured" page when config is missing
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const API = (global.API || 'http://localhost:3000');

const TEST_URL = 'https://testproject.supabase.co';
const TEST_KEY = 'fake-anon-key-0123456789-abcdefghijklmnopqrstuvwxyz';

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } }

function stubSupabase(sessionUser, isAdmin) {
  return {
    createClient(url, key, opts) {
      return {
        auth: {
          getSession: async () => ({ data: { session: sessionUser ? { user: sessionUser, access_token: 'test-jwt-token' } : null } }),
          signInWithPassword: async () => ({ data: { user: sessionUser }, error: null }),
          signOut: async () => ({ error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        },
        from(table) {
          return {
            select: () => ({
              eq: () => ({ single: async () => (isAdmin ? { data: { id: 'admin-1' }, error: null } : { data: null, error: { message: 'not found' } }) }),
            }),
            insert: () => ({ select: async () => ({ data: [{}], error: null }) }),
            update: () => ({ eq: () => ({ select: async () => ({ data: [{}], error: null }) }) }),
            delete: () => ({ eq: () => ({ delete: async () => ({ error: null }) }) }),
            upsert: () => ({ select: async () => ({ data: [{}], error: null }) }),
          };
        },
      };
    },
  };
}

async function bootDom({ sessionUser, isAdmin, configResponse, capture }) {
  const apiData = await (await fetch(API + '/api/data')).json();
  const html = fs.readFileSync(path.join(PUBLIC, 'admin.html'), 'utf8');
  const requests = capture ? { seen: {} } : null;
  const dom = new JSDOM(html, {
    url: API + '/admin',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.supabase = stubSupabase(sessionUser, isAdmin);
      // Static admin.html keeps the raw placeholders (server never injected
      // them) — exactly the Vercel static-serving scenario.
      window.__SPINTO_SUPABASE_URL = '%VITE_SUPABASE_URL%';
      window.__SPINTO_SUPABASE_ANON_KEY = '%VITE_SUPABASE_ANON_KEY%';
      window.fetch = (u, o = {}) => {
        const url = typeof u === 'string' ? u : u.url;
        if (requests) {
          const key = url.split('?')[0];
          requests.seen[key] = requests.seen[key] || [];
          requests.seen[key].push({ headers: o.headers || {}, method: o.method || 'GET' });
        }
        if (url.indexOf('/api/admin/config') >= 0) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(configResponse) });
        }
        if (url.indexOf('/api/admin/data') >= 0) {
          const d = {
            products: (apiData.products || []).slice(0, 5),
            brands: apiData.brands || [],
            bundles: apiData.bundles || [],
            heroSlides: apiData.heroSlides || [],
            homeSections: apiData.homeSections || [],
            orders: [], preorders: [], messages: [],
            settings: apiData.settings || {}, promoBar: apiData.promoBar || {},
          };
          return Promise.resolve({ ok: true, json: () => Promise.resolve(d) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      };
      // jsdom does not fetch <script src>; run the admin bundle directly
      // (the same file the browser loads from /js/admin-app.js).
      window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'admin-app.js'), 'utf8'));
    },
  });
  return new Promise(resolve => {
    setTimeout(() => resolve({ dom, requests }), 350);
  });
}

(async function main() {
  const adminUser = { id: 'admin-1', email: 'admin@test.com' };

  // ---- Case 1: valid config via /api/admin/config + valid admin session ----
  console.log('\n== ADMIN: config bootstrap + dashboard ==');
  {
    const { dom, requests } = await bootDom({
      sessionUser: adminUser,
      isAdmin: true,
      configResponse: { url: TEST_URL, anonKey: TEST_KEY },
      capture: true,
    });
    const document = dom.window.document;
    const text = (s) => { const e = document.querySelector(s); return e ? e.textContent : ''; };

    check('dashboard rendered (sidebar present)', !!document.querySelector('.sidebar'));
    check('admin email shown in header', text('.admin-email').includes('admin@test.com'));
    check('dashboard stats rendered', !!document.querySelector('.stats-grid'));
    const dataReqs = (requests && requests.seen['/api/admin/data']) || [];
    check('/api/admin/data was called', dataReqs.length >= 1);
    const withBearer = dataReqs.some(r => (r.headers.Authorization || '').startsWith('Bearer '));
    check('/api/admin/data carried Bearer token', withBearer);
    dom.window.close();
  }

  // ---- Case 2: authenticated user that is NOT in admin_users ----
  console.log('\n== ADMIN: non-admin user rejected ==');
  {
    const { dom } = await bootDom({
      sessionUser: { id: 'other-1', email: 'other@test.com' },
      isAdmin: false,
      configResponse: { url: TEST_URL, anonKey: TEST_KEY },
    });
    const document = dom.window.document;
    check('login page shown (not admin)', !!document.querySelector('#login-form') && !document.querySelector('.sidebar'));
    dom.window.close();
  }

  // ---- Case 3: no Supabase config anywhere -> friendly error page ----
  console.log('\n== ADMIN: missing config -> config error page ==');
  {
    const { dom } = await bootDom({
      sessionUser: null,
      isAdmin: false,
      configResponse: { url: '', anonKey: '' },
    });
    const document = dom.window.document;
    const bodyText = document.body.textContent;
    check('config error page shown', /Authentication Not Configured/i.test(bodyText));
    dom.window.close();
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('admin test crashed:', e); process.exit(1); });
