/* ==========================================================================
   VILOCCI — Admin Dashboard Application
   Professional e-commerce admin panel with Supabase integration.
   Build 20260919b — Shape images: in Admin → Products → Edit Product →
   Key Shapes every shape row now carries its store-wide details — Shape
   name EN, Shape name AR, and the shape image (upload / preview / replace
   / remove), stored persistably in Supabase Storage and shown as a real
   image card on every storefront selector. The same image controls live in
   Admin → Shapes (table + editor). Builds on the 20260918d base — Shape
   management: Admin → Shapes, the global key-shape catalogue (add / rename
   EN+AR / describe / reorder / hide / delete); a hidden shape disappears
   from the PDP selector, Quick Add, the Fitment Finder and new orders —
   and on the 20260918c base (per-shape stock toggle, add/remove, reorder
   in the Products editor + Key shapes column), which stays fully intact.
   ========================================================================== */
(() => {
  'use strict';

  // ========================================================================
  // CONFIG & SUPABASE
  // ========================================================================

  // Sanitize Supabase URL: must be https://<project-ref>.supabase.co with no path
  function sanitizeSupabaseUrl(url) {
    if (!url || typeof url !== 'string') return '';
    url = url.trim();
    // Remove any trailing slashes
    url = url.replace(/\/+$/, '');
    // If URL contains a path like /rest/v1/ or /auth/v1/, strip it
    try {
      const parsed = new URL(url);
      // Only keep protocol + hostname (strip any path, query, hash)
      const cleanUrl = `${parsed.protocol}//${parsed.hostname}`;
      if (cleanUrl !== url) {
        console.warn('[Supabase] URL was sanitized:', url, '→', cleanUrl);
      }
      return cleanUrl;
    } catch (e) {
      console.error('[Supabase] Invalid URL format:', url);
      return '';
    }
  }

  // admin.html writes these as %VITE_SUPABASE_URL% / %VITE_SUPABASE_ANON_KEY%
  // and only a server that injects them replaces the token. An unsubstituted
  // placeholder is not a configured value, so treat it as empty: it must never
  // be used as config, and never be reported as if it were a real value.
  function unplaceholder(value) {
    const s = String(value == null ? '' : value).trim();
    return /^%[A-Z0-9_]+%$/i.test(s) ? '' : s;
  }

  // Config sources, in order: values injected into admin.html (local server),
  // or fetched from /api/admin/config (see ensureSupabaseConfig).
  let rawSupabaseUrl = unplaceholder(window.__SPINTO_SUPABASE_URL);
  let SUPABASE_URL = sanitizeSupabaseUrl(rawSupabaseUrl);
  let SUPABASE_ANON_KEY = unplaceholder(window.__SPINTO_SUPABASE_ANON_KEY);

  console.log('[Supabase] Raw URL from server:', rawSupabaseUrl);
  console.log('[Supabase] Sanitized URL:', SUPABASE_URL);
  console.log('[Supabase] Anon key present:', !!SUPABASE_ANON_KEY);
  
  if (SUPABASE_URL) {
    // Validate URL format
    const urlPattern = /^https:\/\/[a-z0-9]+\.supabase\.co$/i;
    if (!urlPattern.test(SUPABASE_URL)) {
      console.error('[Supabase] WARNING: URL format is invalid. Expected: https://<project-ref>.supabase.co');
    }
  } else {
    console.error('[Supabase] ERROR: No valid Supabase URL configured');
  }

  function supabaseConfigLooksValid() {
    return /^https:\/\/[a-z0-9]+\.supabase\.co$/i.test(SUPABASE_URL) && SUPABASE_ANON_KEY.length >= 20;
  }

  // On Vercel the admin page is served as a plain static file, so the
  // %VITE_SUPABASE_URL% / %VITE_SUPABASE_ANON_KEY% placeholders in
  // admin.html are never replaced by the server. When the injected values
  // are missing (or still raw placeholders), fetch the client-safe config
  // from the API instead. The anon key is public by design; RLS protects
  // the data, and the service role key is never sent to the browser.
  async function ensureSupabaseConfig() {
    if (supabaseConfigLooksValid()) return;
    try {
      const r = await fetch('/api/admin/config', { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (j && j.url && j.anonKey) {
        rawSupabaseUrl = j.url;
        SUPABASE_URL = sanitizeSupabaseUrl(j.url);
        SUPABASE_ANON_KEY = String(j.anonKey).trim();
        window.__SPINTO_SUPABASE_URL = SUPABASE_URL;
        window.__SPINTO_SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
        console.log('[Supabase] config loaded from /api/admin/config:', SUPABASE_URL);
      }
    } catch (e) {
      console.warn('[Supabase] could not fetch config from /api/admin/config:', e);
    }
  }

  let sb = null;
  function getSB() {
    if (sb) return sb;
    console.log('[Supabase] getSB() called, SUPABASE_URL:', SUPABASE_URL, 'ANON_KEY present:', !!SUPABASE_ANON_KEY);
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      console.error('[Supabase] Missing config - URL:', !!SUPABASE_URL, 'KEY:', !!SUPABASE_ANON_KEY);
      return null;
    }
    if (!window.supabase || !window.supabase.createClient) {
      console.error('[Supabase] CDN library not loaded. window.supabase:', typeof window.supabase);
      return null;
    }
    try {
      console.log('[Supabase] Creating client with URL:', SUPABASE_URL);
      sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true },
      });
      console.log('[Supabase] Client created successfully');
    } catch (e) {
      console.error('[Supabase] Failed to create client:', e);
      return null;
    }
    return sb;
  }

  // ========================================================================
  // UTILITIES
  // ========================================================================
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const root = () => $('#admin-root');

  const state = {
    view: 'login',
    user: null,
    sidebarOpen: false,
    data: null,
    loading: false,
    loginError: '',
    modal: null,
    toastTimer: null,
    // Data-source health: shown as a banner so an empty dashboard can never
    // be mistaken for an empty database.
    dataError: '',
    dataMeta: null,
    diagnosis: null,
    pollErrorShown: false,
    // Customize: the editable ON/OFF draft (Customize Settings) and the
    // submitted requests (Customize Requests), loaded on demand.
    czSettings: null,
    czRequests: null,
    czLoading: false,
    czError: '',
    czSaving: false,
    czFilter: 'all',
    czSearch: '',
    czSearchTimer: null,
    czPhotoCache: {},
  };

  function money(n) { return 'EGP ' + Math.round(n || 0).toLocaleString('en-US'); }
  function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
  function fmtDate(d) { if (!d) return '—'; const dt = new Date(d); return dt.toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' }); }
  function fmtDateTime(d) { if (!d) return '—'; const dt = new Date(d); return dt.toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); }
  function uid(p) { return (p||'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

  // Local API to existing server (for backward compat & fallback).
  // Attaches the Supabase access token as a Bearer header so the server can
  // verify the admin session (the browser client does not share its session
  // cookie with this API).
  async function api(method, url, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    try {
      const s = getSB();
      if (s) {
        const { data: { session } } = await s.auth.getSession();
        if (session && session.access_token) opts.headers.Authorization = 'Bearer ' + session.access_token;
      }
    } catch (e) { /* proceed unauthenticated */ }
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    const j = await r.json();
    return { ok: r.ok, status: r.status, j };
  }

  // ------------------------------------------------------------------------
  // DATA WRITES — always through the server (lib/db.js)
  // ------------------------------------------------------------------------
  // The browser talks to Supabase only for authentication. Every catalog /
  // order write goes through the server, which owns the app-shape <-> SQL-row
  // mapping (brandSlug -> brand_slug, oldPrice -> old_price, inventory -> stock)
  // and keeps the normalized children in step (product_images, product_prices,
  // order_items). Writing straight to PostgREST from here would send camelCase
  // keys that do not match any column and would skip those children.
  const TABLE_TO_COLLECTION = {
    products: 'products', categories: 'categories', shapes: 'shapes', brands: 'brands', bundles: 'bundles',
    hero_slides: 'heroSlides', heroSlides: 'heroSlides',
    home_sections: 'homeSections', homeSections: 'homeSections',
    website_images: 'websiteImages', websiteImages: 'websiteImages',
    website_content: 'websiteContent', websiteContent: 'websiteContent',
    orders: 'orders', preorders: 'preorders', messages: 'messages',
  };
  const collectionOf = (table) => TABLE_TO_COLLECTION[table] || table;

  async function apiOrThrow(method, url, body) {
    const { ok, j } = await api(method, url, body);
    if (!ok) throw new Error((j && j.error) || `${method} ${url} failed`);
    return j;
  }

  async function sbInsert(table, row) {
    return apiOrThrow('POST', '/api/admin/save', { collection: collectionOf(table), record: row });
  }

  // Partial update — the server merges the patch into the stored row, so
  // changing one field never blanks out the others.
  async function sbUpdate(table, id, updates) {
    return apiOrThrow('POST', '/api/admin/update', { collection: collectionOf(table), id, updates });
  }

  async function sbDelete(table, id) {
    return apiOrThrow('POST', '/api/admin/delete', { collection: collectionOf(table), id });
  }

  async function sbUpsert(table, row) {
    return apiOrThrow('POST', '/api/admin/save', { collection: collectionOf(table), record: row });
  }

  // ========================================================================
  // TOAST
  // ========================================================================
  function toast(msg, kind = '') {
    let c = $('.toast-container');
    if (!c) { c = document.createElement('div'); c.className = 'toast-container'; document.body.appendChild(c); }
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(10px)'; setTimeout(() => t.remove(), 300); }, 2800);
  }

  // ========================================================================
  // MODAL
  // ========================================================================
  function showModal(html) {
    closeAllModals();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.innerHTML = html;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeAllModals(); });
    return overlay;
  }

  function showConfirm(title, message, onConfirm, confirmText = 'Delete', danger = true) {
    showModal(`
      <div class="modal confirm-modal">
        <div class="modal-body">
          <div class="confirm-icon">🗑</div>
          <h4>${esc(title)}</h4>
          <p>${esc(message)}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="confirm-cancel">Cancel</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="confirm-ok">${esc(confirmText)}</button>
        </div>
      </div>`);
    $('#confirm-cancel').onclick = closeAllModals;
    $('#confirm-ok').onclick = () => { closeAllModals(); onConfirm(); };
  }

  function closeAllModals() {
    $$('.modal-overlay').forEach(m => m.remove());
  }

  // ========================================================================
  // AUTH — Supabase Auth only. No hardcoded passwords. No legacy fallback.
  // ========================================================================

  // Verify that the authenticated user is in the admin_users table
  async function verifyAdminUser(user) {
    if (!user) return false;
    const s = getSB();
    if (!s) return false;
    try {
      const { data, error } = await s
        .from('admin_users')
        .select('id')
        .eq('id', user.id)
        .single();
      return !error && !!data;
    } catch (e) {
      return false;
    }
  }

  async function checkAuth() {
    try {
      const s = getSB();

      // If Supabase is not configured, show config error
      if (!s) {
        state.view = 'config-error';
        render();
        return;
      }

      const route = getAdminRoute();

      // Check for existing Supabase session (persists across refresh)
      const { data: { session } } = await s.auth.getSession();

      if (session && session.user) {
        // Verify user is an admin
        const isAdmin = await verifyAdminUser(session.user);
        if (isAdmin) {
          state.user = session.user;

          // If on login page but authenticated, redirect to /admin
          if (route === 'login') {
            setAdminRoute('admin');
          }

          state.view = 'dashboard';
          if (!state.data) await loadData(); else render();
          return;
        }

        // User is authenticated but not an admin — sign them out
        await s.auth.signOut();
      }

      // No valid admin session — must be on login page
      state.user = null;

      // If trying to access /admin without auth, redirect to /admin/login
      if (route === 'admin') {
        setAdminRoute('login');
      }

      state.view = 'login';
      render();
    } catch (e) {
      console.error('[checkAuth error]', e);
      // On error, show login page
      state.view = 'login';
      render();
    }
  }

  async function doLogin(email, password) {
    state.loading = true;
    state.loginError = '';
    state.view = 'login';
    render();

    try {
      const s = getSB();
      if (!s) {
        state.loginError = 'Authentication is not configured. Please contact the site administrator.';
        state.loading = false;
        render();
        return;
      }

      const { data, error } = await s.auth.signInWithPassword({ email, password });

      if (error) {
        // Truthful error mapping — report the cause Supabase Auth actually
        // returned. supabase-js v2 exposes the stable cause in error.code,
        // while error.status is a coarse HTTP code (invalid credentials,
        // unconfirmed email, rate limits and other failures are all HTTP 400).
        // Specific causes are therefore checked first, so a 400 is never
        // reported as "invalid password" when the real cause is different.
        const code = String(error.code || '').toLowerCase();
        const message = String(error.message || '');
        const msg = message.toLowerCase();
        const says = (...needles) => needles.some(n => msg.includes(n));

        console.error('[Supabase] sign-in rejected:', { code: error.code, status: error.status, message });

        if (code === 'invalid_credentials' || says('invalid login credentials')) {
          state.loginError = 'Invalid email or password. Please try again.';
        } else if (code === 'email_not_confirmed' || says('email not confirmed')) {
          state.loginError = 'This email address has not been confirmed yet. Please confirm it, then sign in again.';
        } else if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit' ||
            error.status === 429 || says('too many requests', 'rate limit')) {
          state.loginError = 'Too many attempts. Please wait a moment and try again.';
        } else if (code === 'invalid_url' || code === 'invalid_path' || says('invalid path', 'invalid url', 'invalid api key')) {
          state.loginError = 'Authentication service is misconfigured. Please contact the site administrator.';
        } else if (says('failed to fetch', 'networkerror', 'network request failed')) {
          state.loginError = 'Could not reach the authentication service. Please check your connection and try again.';
        } else if (message) {
          // Anything else: show Supabase's own wording instead of a guess.
          state.loginError = message;
        } else {
          state.loginError = 'Login failed. Please try again.';
        }
        state.loading = false;
        render();
        return;
      }

      if (!data.user) {
        state.loginError = 'Login failed. Please try again.';
        state.loading = false;
        render();
        return;
      }

      // Verify this user is an admin
      const isAdmin = await verifyAdminUser(data.user);
      if (!isAdmin) {
        // Not an admin user — sign out immediately
        await s.auth.signOut();
        state.loginError = 'This account does not have admin access.';
        state.loading = false;
        render();
        return;
      }

      state.user = data.user;
      state.loginError = '';
      toast('Welcome to Vilocci Admin', 'gold');

      // Redirect to /admin after successful login
      setAdminRoute('admin');
      state.view = 'dashboard';
      render();
    } catch (e) {
      console.error('[Login error]', e);
      // A thrown (not returned) failure is usually the auth endpoint being
      // unreachable — say that instead of showing a bare raw fetch error.
      const detail = String((e && e.message) || '');
      state.loginError = /failed to fetch|networkerror|network request failed|load failed/i.test(detail)
        ? 'Could not reach the authentication service. Please check your connection and try again.'
        : (detail || 'An unexpected error occurred. Please try again.');
      state.loading = false;
      state.view = 'login';
      render();
    }
  }

  async function doLogout() {
    const s = getSB();
    if (s) await s.auth.signOut();
    state.user = null;
    state.loginError = '';

    // Redirect to /admin/login after logout
    setAdminRoute('login');
    state.view = 'login';
    render();
  }

  // ========================================================================
  // DATA LOADING
  // ========================================================================
  // Fetch /api/admin/diagnose (no auth required) so a failed or degraded data
  // load can explain itself instead of showing an empty dashboard.
  async function fetchDiagnosis() {
    try {
      const r = await fetch('/api/admin/diagnose?probe=1', { cache: 'no-store' });
      if (r.ok) state.diagnosis = await r.json();
    } catch (e) { /* the banner falls back to the data error text */ }
  }

  function dataIsDegraded(meta) {
    return !!(meta && (meta.usingJsonFallback || meta.serviceKeyIssue || meta.anonKeyIssue || meta.remoteState === 'unavailable'));
  }

  async function loadData() {
    state.loading = true;
    state.dataError = '';
    state.dataMeta = null;
    render();
    try {
      const { ok, j, status } = await api('GET', '/api/admin/data');
      if (ok && j) {
        state.data = j;
        state.dataMeta = j._meta || null;
        state.czSettings = null;      // re-read from the fresh payload
        if (dataIsDegraded(state.dataMeta)) await fetchDiagnosis();
      } else {
        state.dataError = (j && j.error) || ('HTTP ' + status);
        await fetchDiagnosis();
      }
      state.loading = false;
      render();
    } catch (e) {
      state.dataError = String((e && e.message) || e);
      await fetchDiagnosis();
      toast('Failed to load data', 'error');
      state.loading = false;
      render();
    }
  }

  // Builds the warning banner shown above every page while the data source is
  // not the live Supabase database (or the load failed outright). Empty
  // string = everything is healthy.
  function dataBannerHtml() {
    if (state.view === 'login' || state.view === 'config-error') return '';
    const d = state.diagnosis || {};
    let msg = '';
    if (state.dataError) {
      const issues = (d.issues || []).filter(Boolean);
      if (issues.length) {
        msg = 'The admin panel could not load data from Supabase. ' + issues.join(' ');
      } else if (d.remoteError) {
        msg = 'The admin panel could not load data from Supabase: ' + d.remoteError + '.';
      } else {
        msg = 'The admin panel could not load data: ' + state.dataError;
      }
    } else if (dataIsDegraded(state.dataMeta)) {
      const issues = (d.issues || []).filter(Boolean);
      msg = 'Heads up — the data below is being served from the bundled JSON fallback, not the live Supabase database.'
        + (issues.length ? ' ' + issues.join(' ') : ' Check /api/admin/diagnose for details.');
    }
    if (!msg) return '';
    return `<div class="data-banner" role="alert">
      <span class="data-banner-icon">&#9888;</span>
      <span class="data-banner-text">${esc(msg)}</span>
      <a class="data-banner-link" href="/api/admin/diagnose?probe=1" target="_blank" rel="noopener">Details</a>
    </div>`;
  }

  // ========================================================================
  // ROUTER — URL hash-based: #/login or #/admin
  // ========================================================================

  function getAdminRoute() {
    const hash = window.location.hash || '';
    if (hash === '#/login' || hash === '#/admin/login') return 'login';
    return 'admin';
  }

  function setAdminRoute(route) {
    const target = route === 'login' ? '#/login' : '#/admin';
    if (window.location.hash !== target) {
      window.location.hash = target;
    }
  }

  function navigate(view) {
    state.view = view;
    state.sidebarOpen = false;
    // The requests list is fetched fresh on every visit (and signed photo links
    // are short-lived), while the settings draft is re-read from the server
    // payload.
    if (view === 'customize-requests') { state.czRequests = null; state.czError = ''; state.czPhotoCache = {}; }
    if (view === 'customize-settings') { state.czSettings = null; }
    render();
    window.scrollTo(0, 0);
  }

  // ========================================================================
  // RENDER ENGINE
  // ========================================================================
  function render() {
    const r = root();
    if (!r) return;

    if (state.view === 'login') {
      r.innerHTML = renderLoginPage();
      bindLogin();
      return;
    }

    if (state.view === 'config-error') {
      r.innerHTML = renderConfigErrorPage();
      return;
    }

    r.innerHTML = `
      ${renderSidebar()}
      <div class="main-content">
        ${renderHeader()}
        ${dataBannerHtml()}
        <div class="page-content">
          ${renderPage()}
        </div>
      </div>`;

    bindGlobal();
    bindPage();

    // Orders (and the dashboard's recent orders) refresh themselves from
    // Supabase so new customer checkouts appear without a manual reload.
    stopOrderPolling();
    if (state.view === 'orders' || state.view === 'dashboard') startOrderPolling();
  }

  function renderLoginPage() {
    return `
    <div class="login-page">
      <div class="login-card">
        <div class="login-brand">
          <div class="logo-mark">S</div>
          <h1>Vilocci</h1>
          <p>Admin Dashboard</p>
        </div>
        <form class="login-form" id="login-form">
          <div class="field">
            <label>Email</label>
            <input name="email" type="email" autocomplete="email" required>
          </div>
          <div class="field">
            <label>Password</label>
            <input name="password" type="password" placeholder="Enter your password" autocomplete="current-password" required>
          </div>
          <button class="btn-login" type="submit" ${state.loading ? 'disabled' : ''}>
            ${state.loading ? 'Signing in...' : 'Sign In'}
          </button>
          ${state.loginError ? `<div class="login-err" id="login-err">${esc(state.loginError)}</div>` : '<div class="login-err" id="login-err"></div>'}
        </form>
      </div>
    </div>`;
  }

  function renderConfigErrorPage() {
    return `
    <div class="login-page">
      <div class="login-card">
        <div class="login-brand">
          <div class="logo-mark">S</div>
          <h1>Vilocci</h1>
          <p>Admin Dashboard</p>
        </div>
        <div style="text-align:center;padding:20px 0;">
          <div style="font-size:40px;margin-bottom:12px;">&#9888;</div>
          <h3 style="font-size:16px;font-weight:600;margin-bottom:8px;">Authentication Not Configured</h3>
          <p style="font-size:13px;color:var(--text-secondary);line-height:1.6;">
            Supabase credentials are not set up. Please configure
            <code style="background:#f0f0f0;padding:2px 6px;border-radius:4px;font-size:12px;">VITE_SUPABASE_URL</code> and
            <code style="background:#f0f0f0;padding:2px 6px;border-radius:4px;font-size:12px;">VITE_SUPABASE_ANON_KEY</code>
            environment variables.
          </p>
        </div>
      </div>
    </div>`;
  }

  function renderSidebar() {
    const v = state.view;
    const items = [
      { id: 'dashboard', icon: '📊', label: 'Dashboard' },
      { id: 'products', icon: '📦', label: 'Products' },
      { id: 'categories', icon: '️', label: 'Categories' },
      { id: 'brands', icon: '🚗', label: 'Brands' },
      { id: 'shapes', icon: '🗝️', label: 'Shapes' },
      { id: 'orders', icon: '', label: 'Orders', badge: getNewOrderCount() },
      { id: 'customers', icon: '👥', label: 'Customers' },
      { id: 'inventory', icon: '📊', label: 'Inventory' },
      { id: 'discounts', icon: '💰', label: 'Discounts' },
      { id: 'packages', icon: '🎁', label: 'Packages' },
      { id: 'content', icon: '📝', label: 'Website Content' },
      { id: 'images', icon: '🖼️', label: 'Website Images' },
      { id: 'messages', icon: '✉️', label: 'Contact Messages', badge: getUnreadMsgCount() },
      { id: 'customize-settings', icon: '🎨', label: 'Customize Settings' },
      { id: 'customize-requests', icon: '📸', label: 'Customize Requests', badge: getNewCustomizeCount() },
      { id: 'settings', icon: '⚙️', label: 'Settings' },
    ];

    return `
    <div class="sidebar-overlay ${state.sidebarOpen ? 'show' : ''}" id="sidebar-overlay"></div>
    <aside class="sidebar ${state.sidebarOpen ? 'open' : ''}" id="sidebar">
      <div class="sidebar-brand">
        <div class="s-logo">S</div>
        <div>
          <div class="s-name">Vilocci</div>
          <div class="s-sub">Admin Panel</div>
        </div>
      </div>
      <nav class="sidebar-nav">
        <div class="nav-label">Main</div>
        ${items.slice(0, 1).map(i => sidebarLink(i, v)).join('')}
        <div class="nav-label">Catalog</div>
        ${items.slice(1, 5).map(i => sidebarLink(i, v)).join('')}
        <div class="nav-label">Sales</div>
        ${items.slice(5, 9).map(i => sidebarLink(i, v)).join('')}
        <div class="nav-label">Content</div>
        ${items.slice(9, 13).map(i => sidebarLink(i, v)).join('')}
        <div class="nav-label">Customize</div>
        ${items.slice(13, 15).map(i => sidebarLink(i, v)).join('')}
        <div class="nav-label">System</div>
        ${items.slice(15).map(i => sidebarLink(i, v)).join('')}
      </nav>
      <div class="sidebar-footer">
        <a href="/" target="_blank">
          <span class="nav-icon"></span> View Store
        </a>
        <a href="#" class="logout-btn" id="sidebar-logout">
          <span class="nav-icon">🚪</span> Logout
        </a>
      </div>
    </aside>`;
  }

  function sidebarLink(item, active) {
    return `<a href="#${item.id}" class="${item.id === active ? 'active' : ''}" data-nav="${item.id}">
      <span class="nav-icon">${item.icon}</span>
      ${item.label}
      ${item.badge ? `<span class="nav-badge">${item.badge}</span>` : ''}
    </a>`;
  }

  function getNewOrderCount() {
    if (!state.data?.orders) return 0;
    return state.data.orders.filter(o => o.status === 'New' || o.status === 'Pending').length;
  }

  function getUnreadMsgCount() {
    if (!state.data?.messages) return 0;
    return state.data.messages.filter(m => !m.is_read).length;
  }

  // New (not yet contacted) customization requests — drives the sidebar badge.
  function getNewCustomizeCount() {
    const cfg = state.data && state.data.customize;
    const stats = cfg && cfg.stats;
    const n = stats && Number(stats.new);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // Dashboard quick-access card for the Customize flow. The full screens live
  // in the sidebar under "Customize" (Customize Settings + Customize
  // Requests); this card surfaces them on the dashboard too. Navigation uses
  // the global [data-nav] binding, so no per-page bind code is needed.
  function czDashboardCard() {
    const cfg = (state.data && state.data.customize) || {};
    const stats = cfg.stats || {};
    const list = Array.isArray(cfg.list) ? cfg.list : [];
    const enabled = list.filter((c) => c && c.enabled !== false).length;
    const total = Number(stats.total);
    const fresh = getNewCustomizeCount();
    return `
    <div class="card" style="margin-bottom:20px;border:1px solid var(--spinto-gold-soft);">
      <div class="card-header">
        <h3>🎨 Customize — bespoke requests</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-secondary btn-sm" data-nav="customize-settings">Customize Settings</button>
          <button class="btn btn-primary btn-sm" data-nav="customize-requests">View Requests${fresh ? ` (${fresh} new)` : ''}</button>
        </div>
      </div>
      <div class="card-body">
        <div style="display:flex;gap:28px;flex-wrap:wrap;font-size:13px;color:var(--text-secondary);">
          <span><strong style="font-size:17px;color:var(--text-primary);">${fresh}</strong> new requests</span>
          <span><strong style="font-size:17px;color:var(--text-primary);">${Number.isFinite(total) ? total : 0}</strong> total requests</span>
          <span><strong style="font-size:17px;color:var(--text-primary);">${enabled} of ${list.length}</strong> categories available for Customize</span>
        </div>
        <p style="margin:10px 0 0;font-size:12px;color:var(--text-muted);">Customers submit from the store <a href="/#/customize" target="_blank" rel="noopener">Customize page</a>. Availability here never changes the normal shop pages.</p>
      </div>
    </div>`;
  }

  function renderHeader() {
    const titles = {
      dashboard: 'Dashboard', products: 'Products', categories: 'Categories',
      brands: 'Brands', orders: 'Orders', customers: 'Customers',
      inventory: 'Inventory', discounts: 'Discounts', packages: 'Packages',
      content: 'Website Content', images: 'Website Images',
      messages: 'Contact Messages', settings: 'Settings',
      'customize-settings': 'Customize Settings',
      'customize-requests': 'Customize Requests',
    };
    return `
    <header class="top-header">
      <div style="display:flex;align-items:center;gap:12px;">
        <button class="mobile-menu-btn" id="menu-toggle">☰</button>
        <span class="page-title">${titles[state.view] || 'Dashboard'}</span>
      </div>
      <div class="header-actions">
        <span class="admin-email">${state.user?.email || 'Admin'}</span>
      </div>
    </header>`;
  }

  function renderPage() {
    if (state.loading && !state.data) {
      return `<div class="loading-state"><div class="spinner"></div> Loading...</div>`;
    }
    switch (state.view) {
      case 'dashboard': return renderDashboard();
      case 'products': return renderProducts();
      case 'categories': return renderCategories();
      case 'brands': return renderBrands();
      case 'shapes': return renderShapes();
      case 'orders': return renderOrders();
      case 'customers': return renderCustomers();
      case 'inventory': return renderInventory();
      case 'discounts': return renderDiscounts();
      case 'packages': return renderPackages();
      case 'content': return renderContent();
      case 'images': return renderImages();
      case 'messages': return renderMessages();
      case 'customize-settings': return renderCustomizeSettings();
      case 'customize-requests': return renderCustomizeRequests();
      case 'settings': return renderSettings();
      default: return renderDashboard();
    }
  }

  // ========================================================================
  // DASHBOARD
  // ========================================================================
  function renderDashboard() {
    const d = state.data || {};
    const orders = d.orders || [];
    const products = d.products || [];
    const messages = d.messages || [];

    const totalSales = orders.reduce((s, o) => s + (o.total || 0), 0);
    const today = new Date().toDateString();
    const todaySales = orders.filter(o => new Date(o.createdAt).toDateString() === today).reduce((s, o) => s + (o.total || 0), 0);
    const weekAgo = new Date(Date.now() - 7 * 86400000);
    const weekSales = orders.filter(o => new Date(o.createdAt) >= weekAgo).reduce((s, o) => s + (o.total || 0), 0);
    const monthAgo = new Date(Date.now() - 30 * 86400000);
    const monthSales = orders.filter(o => new Date(o.createdAt) >= monthAgo).reduce((s, o) => s + (o.total || 0), 0);

    const byStatus = {};
    orders.forEach(o => { byStatus[o.status] = (byStatus[o.status] || 0) + 1; });

    const lowStock = products.filter(p => (p.stock || 0) <= 5 && p.active);
    const recentOrders = [...orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8);

    // Best sellers
    const productSales = {};
    orders.forEach(o => (o.items || []).forEach(it => {
      productSales[it.productId] = (productSales[it.productId] || 0) + (it.qty || 1);
    }));
    const bestSellers = Object.entries(productSales)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([pid, qty]) => {
        const p = products.find(x => x.id === pid);
        return { name: p?.name_en || pid, qty, price: p?.price || 0 };
      });

    return `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon blue">📋</div>
        <div class="stat-value">${orders.length}</div>
        <div class="stat-label">Total Orders</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon gold">💰</div>
        <div class="stat-value">${money(totalSales)}</div>
        <div class="stat-label">Total Sales</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green">📦</div>
        <div class="stat-value">${products.length}</div>
        <div class="stat-label">Total Products</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon orange">⚠️</div>
        <div class="stat-value">${lowStock.length}</div>
        <div class="stat-label">Low Stock</div>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon blue">📅</div>
        <div class="stat-value">${money(todaySales)}</div>
        <div class="stat-label">Today's Sales</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green">📆</div>
        <div class="stat-value">${money(weekSales)}</div>
        <div class="stat-label">This Week</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon gold">️</div>
        <div class="stat-value">${money(monthSales)}</div>
        <div class="stat-label">This Month</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon orange">🆕</div>
        <div class="stat-value">${byStatus['New'] || 0}</div>
        <div class="stat-label">New Orders</div>
      </div>
    </div>

    ${czDashboardCard()}

    <div style="display:grid;grid-template-columns:2fr 1fr;gap:20px;">
      <div class="card">
        <div class="card-header">
          <h3>Recent Orders</h3>
          <button class="btn btn-secondary btn-sm" data-nav="orders">View All</button>
        </div>
        <div class="card-body" style="padding:0;">
          ${recentOrders.length ? `
          <table class="data-table">
            <thead><tr><th>Order</th><th>Customer</th><th>Date</th><th>Total</th><th>Status</th></tr></thead>
            <tbody>
              ${recentOrders.map(o => `<tr>
                <td><strong>${esc(o.id)}</strong></td>
                <td>${esc(o.customer?.fullName || '—')}</td>
                <td>${fmtDate(o.createdAt)}</td>
                <td><strong>${money(o.total)}</strong></td>
                <td>${statusBadge(o.status)}</td>
              </tr>`).join('')}
            </tbody>
          </table>` : '<div class="empty-state"><div class="empty-icon">📋</div><h4>No orders yet</h4><p>Orders will appear here once customers place them.</p></div>'}
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h3>Best Sellers</h3></div>
        <div class="card-body" style="padding:0;">
          ${bestSellers.length ? `
          <table class="data-table">
            <thead><tr><th>Product</th><th>Sold</th></tr></thead>
            <tbody>
              ${bestSellers.map(p => `<tr>
                <td>${esc(p.name)}</td>
                <td><strong>${p.qty}</strong></td>
              </tr>`).join('')}
            </tbody>
          </table>` : '<div class="empty-state"><p>No sales data yet</p></div>'}
        </div>
      </div>
    </div>

    <div class="stats-grid" style="margin-top:0;">
      <div class="stat-card">
        <div class="stat-icon blue">⏳</div>
        <div class="stat-value">${byStatus['Pending'] || 0}</div>
        <div class="stat-label">Pending</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon gold">✅</div>
        <div class="stat-value">${byStatus['Confirmed'] || 0}</div>
        <div class="stat-label">Confirmed</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon orange">🔄</div>
        <div class="stat-value">${byStatus['Processing'] || 0}</div>
        <div class="stat-label">Processing</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green">🚚</div>
        <div class="stat-value">${byStatus['Shipped'] || 0}</div>
        <div class="stat-label">Shipped</div>
      </div>
    </div>`;
  }

  function statusBadge(s) {
    const cls = {
      'New': 'badge-new', 'Pending': 'badge-pending', 'Confirmed': 'badge-confirmed',
      'Processing': 'badge-processing', 'Shipped': 'badge-shipped',
      'Delivered': 'badge-delivered', 'Cancelled': 'badge-cancelled',
    }[s] || 'badge-pending';
    return `<span class="badge ${cls}">${esc(s)}</span>`;
  }

  function effectivePaymentStatus(o) {
    if (!o) return 'Not Required';
    if (o.payment === 'InstaPay') return o.paymentStatus || o.payment_status || 'Pending Verification';
    return o.paymentStatus || o.payment_status || 'Not Required';
  }

  function paymentStatusBadge(status) {
    const cls = {
      'Pending Verification': 'badge-payment-pending',
      'Verified': 'badge-payment-verified',
      'Rejected': 'badge-payment-rejected',
      'Not Required': 'badge-payment-na',
    }[status] || 'badge-payment-pending';
    return `<span class="badge ${cls}">${esc(status)}</span>`;
  }

  // ========================================================================
  // PRODUCTS
  // ========================================================================
  function renderProducts() {
    const products = state.data?.products || [];
    const brands = state.data?.brands || [];
    const search = state.productSearch || '';
    const filterBrand = state.productBrandFilter || '';
    const filterCat = state.productCatFilter || '';

    let filtered = products;
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(p => (p.name_en || '').toLowerCase().includes(q) || (p.slug || '').toLowerCase().includes(q));
    }
    if (filterBrand) filtered = filtered.filter(p => p.brandSlug === filterBrand);
    if (filterCat) filtered = filtered.filter(p => p.category === filterCat);

    const categories = [...new Set(products.map(p => p.category).filter(Boolean))];

    return `
    <div class="toolbar">
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input type="text" placeholder="Search products..." value="${esc(search)}" id="product-search">
      </div>
      <select class="filter-select" id="product-brand-filter">
        <option value="">All Brands</option>
        ${brands.map(b => `<option value="${esc(b.slug)}" ${filterBrand === b.slug ? 'selected' : ''}>${esc(b.name_en)}</option>`).join('')}
      </select>
      <select class="filter-select" id="product-cat-filter">
        <option value="">All Categories</option>
        ${categories.map(c => `<option value="${esc(c)}" ${filterCat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
      </select>
      <button class="btn btn-primary" id="btn-add-product">+ Add Product</button>
    </div>

    <div class="card">
      <div class="card-body" style="padding:0;overflow-x:auto;">
        ${filtered.length ? `
        <table class="data-table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Category</th>
              <th>Brand</th>
              <th>Key shapes</th>
              <th>Colors</th>
              <th>Price</th>
              <th>Stock</th>
              <th>Status</th>
              <th style="width:100px;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.map(p => {
              const brand = brands.find(b => b.slug === p.brandSlug);
              const img = (p.images && p.images[0]) || p.main_image || '/img/detail_a.png';
              return `<tr>
                <td>
                  <div style="display:flex;align-items:center;gap:10px;">
                    <img src="${esc(img)}" alt="" style="width:40px;height:40px;object-fit:cover;border-radius:6px;background:var(--cream);">
                    <div>
                      <div style="font-weight:600;font-size:13px;">${esc(p.name_en)}</div>
                      <div style="font-size:11px;color:var(--text-muted);">${esc(p.slug || '')}</div>
                    </div>
                  </div>
                </td>
                <td>${esc(p.category || '—')}</td>
                <td>${esc(brand?.name_en || p.brandSlug || '—')}</td>
                <td>${(() => {
                  const list = Array.isArray(p.keyShapes) ? p.keyShapes : [];
                  if (!list.length) return '<span style="font-size:11px;color:var(--text-muted);">—</span>';
                  const inStock = list.filter(s => s.available !== false);
                  return `<div class="pshape-cell" title="${esc(list.map(s => `Shape ${s.shape}${s.available === false ? ' (OOS)' : ''}`).join(', '))}">
                    ${list.map(s => `<span class="pshape-badge${s.available === false ? ' off' : ''}" style="width:20px;height:20px;font-size:10px;border-radius:4px;">${esc(s.shape)}</span>`).join('')}
                    <span class="pshape-count">${inStock.length}/${list.length}</span>
                  </div>`;
                })()}</td>
                <td>${(() => {
                  const list = Array.isArray(p.colors) ? p.colors.filter(c => c && c.hex) : [];
                  if (!list.length) return '<span style="font-size:11px;color:var(--text-muted);">—</span>';
                  const enabled = list.filter(c => c.enabled !== false);
                  const shown = list.slice(0, 5);
                  return `<div class="pcolor-cell" title="${esc(list.map(c => `${c.name_en || c.name_ar || c.hex}${c.enabled === false ? ' (off)' : ''}`).join(', '))}">
                    ${shown.map(c => `<span class="pcolor-dot${c.enabled === false ? ' off' : ''}" style="background:${esc(c.hex)}"></span>`).join('')}
                    ${list.length > shown.length ? `<span class="pcolor-more">+${list.length - shown.length}</span>` : ''}
                    <span class="pcolor-count">${enabled.length}/${list.length}</span>
                  </div>`;
                })()}</td>
                <td><strong>${money(p.price)}</strong>${p.sale_price ? `<br><span style="font-size:11px;color:var(--success);">Sale: ${money(p.sale_price)}</span>` : ''}</td>
                <td><span style="color:${(p.stock||0) <= 5 ? 'var(--danger)' : 'var(--text-primary)'};font-weight:600;">${p.stock || 0}</span></td>
                <td>${p.active ? '<span class="badge badge-active">Active</span>' : '<span class="badge badge-inactive">Inactive</span>'}</td>
                <td>
                  <button class="btn btn-ghost btn-sm" data-edit-product="${esc(p.id)}" data-edit="${esc(p.id)}" title="Edit product">✏️</button>
                  <button class="btn btn-ghost btn-sm" data-toggle-product="${esc(p.id)}">${p.active ? '' : '🟢'}</button>
                  <button class="btn btn-ghost btn-sm" data-delete-product="${esc(p.id)}">🗑</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>` : '<div class="empty-state"><div class="empty-icon">📦</div><h4>No products found</h4><p>Try adjusting your search or filters.</p></div>'}
      </div>
    </div>`;
  }

  // ========================================================================
  // CATEGORIES
  // ========================================================================
  function renderCategories() {
    const categories = (state.data?.categories || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const search = (state.catSearch || '').toLowerCase();
    const filtered = search
      ? categories.filter(c => (c.name_en || '').toLowerCase().includes(search) || (c.slug || '').toLowerCase().includes(search))
      : categories;

    return `
    <div class="toolbar">
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input type="text" placeholder="Search categories..." value="${esc(state.catSearch || '')}" id="cat-search">
      </div>
      <button class="btn btn-primary" id="btn-add-category">+ Add Category</button>
    </div>
    <div class="card">
      <div class="card-body" style="padding:0;overflow-x:auto;">
        ${filtered.length ? `
        <table class="data-table">
          <thead><tr><th style="width:70px;">Image</th><th>Name</th><th>Slug</th><th>Description</th><th>Products</th><th>Order</th><th>Status</th><th style="width:140px;">Actions</th></tr></thead>
          <tbody>
            ${filtered.map(c => `<tr>
              <td>${c.image ? `<img src="${esc(c.image)}" alt="" style="width:48px;height:36px;object-fit:cover;border-radius:6px;background:var(--cream);">` : '<div style="width:48px;height:36px;background:var(--cream);border-radius:6px;display:flex;align-items:center;justify-content:center;">🏷️</div>'}</td>
              <td>
                <div style="font-weight:600;font-size:13px;">${esc(c.name_en || c.name || '—')}</div>
                ${c.name_ar ? `<div style="font-size:11px;color:var(--text-muted);" dir="rtl">${esc(c.name_ar)}</div>` : ''}
              </td>
              <td>${esc(c.slug || '')}</td>
              <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary);font-size:12px;">${esc(c.description_en || '—')}</td>
              <td>${c.product_count != null ? c.product_count : '—'}</td>
              <td>
                <input type="number" step="0.25" value="${c.order || 0}" data-cat-order="${esc(c.id)}" style="width:70px;" title="Lower numbers appear first">
              </td>
              <td>${c.active !== false ? '<span class="badge badge-active">Active</span>' : '<span class="badge badge-inactive">Inactive</span>'}</td>
              <td>
                <button class="btn btn-ghost btn-sm" data-edit-cat="${esc(c.id)}" title="Edit">✏️</button>
                <button class="btn btn-ghost btn-sm" data-toggle-cat="${esc(c.id)}" title="${c.active !== false ? 'Hide from storefront' : 'Show on storefront'}">${c.active !== false ? '🙈' : '👁'}</button>
                <button class="btn btn-ghost btn-sm" data-delete-cat="${esc(c.id)}" title="Delete">🗑</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty-state"><div class="empty-icon">🏷️</div><h4>No categories</h4><p>Add your first category to organize products.</p></div>'}
      </div>
    </div>`;
  }

  // ========================================================================
  // BRANDS
  // ========================================================================
  function renderBrands() {
    const brands = state.data?.brands || [];
    return `
    <div class="toolbar">
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input type="text" placeholder="Search brands..." id="brand-search">
      </div>
      <button class="btn btn-primary" id="btn-add-brand">+ Add Brand</button>
    </div>
    <div class="card">
      <div class="card-body" style="padding:0;">
        ${brands.length ? `
        <table class="data-table">
          <thead><tr><th>Brand</th><th>Slug</th><th>Products</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            ${brands.sort((a,b) => (a.order||0)-(b.order||0)).map(b => `<tr>
              <td>
                <div style="display:flex;align-items:center;gap:10px;">
                  ${b.logo ? `<img src="${esc(b.logo)}" style="width:36px;height:36px;object-fit:contain;border-radius:6px;">` : '<div style="width:36px;height:36px;background:var(--cream);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:18px;">🚗</div>'}
                  <strong>${esc(b.name_en)}</strong>
                </div>
              </td>
              <td>${esc(b.slug)}</td>
              <td>${b.product_count || '—'}</td>
              <td>${b.active !== false ? '<span class="badge badge-active">Active</span>' : '<span class="badge badge-inactive">Inactive</span>'}</td>
              <td>
                <button class="btn btn-ghost btn-sm" data-edit-brand="${esc(b.id)}">✏️</button>
                <button class="btn btn-ghost btn-sm" data-delete-brand="${esc(b.id)}"></button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty-state"><div class="empty-icon">🚗</div><h4>No brands</h4><p>Add your first brand.</p></div>'}
      </div>
    </div>`;
  }

  // ========================================================================
  // SHAPES — Shape management: the global key-shape catalogue
  // ========================================================================
  // Every key in the store fits one of the physical key shapes listed here
  // (A–D by default). This catalogue is the master list behind every shape
  // selector on the storefront: the product-page shape picker, Quick Add and
  // the Fitment Finder all read it, and the server refuses new orders for a
  // shape that is hidden here. Products still carry their OWN per-shape
  // availability (the Products editor), so a shape must be catalogue-active
  // AND product-available before a customer can pick it.
  const shapesList = () => ((state.data && state.data.shapes) || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const shapeProductCount = (code) => (state.data?.products || []).filter(p => (p.keyShapes || []).some(s => s.shape === code)).length;
  const shapeByCode = (code) => shapesList().find(s => String(s.code || '').toUpperCase() === String(code || '').toUpperCase());

  // ------------------------------------------------------------------------
  // SHAPE IMAGES — one uploaded visual per catalogue shape.
  // The image is a property of the SHAPE itself (stored on the catalogue row
  // via /api/admin/shapes/image → Supabase Storage bucket `shape-images`), so
  // the Shapes screen and the Products editor's Key Shapes rows manage the
  // very same file — there is exactly one image per shape code store-wide.
  // ------------------------------------------------------------------------
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read the file.'));
      reader.readAsDataURL(file);
    });
  }

  async function setShapeImageFromFile(shapeId, file) {
    const dataUrl = await fileToDataUrl(file);
    const { ok, j } = await api('POST', '/api/admin/shapes/image', { shapeId, dataUrl });
    if (!ok || !j || !j.ok) throw new Error((j && j.error) || 'Shape image upload failed');
    const s = (state.data.shapes || []).find(x => x.id === shapeId);
    if (s) s.image_url = j.url;
    return j.url;
  }

  async function setShapeImageUrl(shapeId, url) {
    const { ok, j } = await api('POST', '/api/admin/shapes/image', { shapeId, url });
    if (!ok || !j || !j.ok) throw new Error((j && j.error) || 'Shape image update failed');
    const s = (state.data.shapes || []).find(x => x.id === shapeId);
    if (s) s.image_url = j.url;
    return j.url;
  }

  async function clearShapeImage(shapeId) {
    const { ok, j } = await api('POST', '/api/admin/shapes/image/remove', { shapeId });
    if (!ok || !j || !j.ok) throw new Error((j && j.error) || 'Could not remove the shape image');
    const s = (state.data.shapes || []).find(x => x.id === shapeId);
    if (s) s.image_url = '';
    return true;
  }

  // Thumbnail markup shared by the Shapes table and the product editor rows.
  function shapeThumbHTML(s, sizePx) {
    const size = sizePx || 44;
    if (s && s.image_url) {
      return `<img src="${esc(s.image_url)}" alt="Shape ${esc(s.code || '')}" class="pshape-thumb" style="width:${size}px;height:${size}px;object-fit:cover;border-radius:8px;border:1px solid var(--border);background:#fff;">`;
    }
    return `<div class="pshape-thumb empty" style="width:${size}px;height:${size}px;border-radius:8px;border:1px dashed var(--border);background:var(--cream);display:flex;align-items:center;justify-content:center;font-size:${Math.round(size * 0.4)}px;">🗝️</div>`;
  }

  function renderShapes() {
    const shapes = shapesList();
    const search = (state.shapeSearch || '').toLowerCase();
    const filtered = search
      ? shapes.filter(s => [s.code, s.name_en, s.name_ar].some(v => String(v || '').toLowerCase().includes(search)))
      : shapes;

    return `
    <div class="toolbar">
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input type="text" placeholder="Search shapes..." value="${esc(state.shapeSearch || '')}" id="shape-search">
      </div>
      <button class="btn btn-primary" id="btn-add-shape-cat">+ Add Shape</button>
    </div>
    <div class="card">
      <div class="card-body" style="padding:0;overflow-x:auto;">
        ${filtered.length ? `
        <table class="data-table">
          <thead><tr><th style="width:70px;">Code</th><th style="width:110px;">Image</th><th>Name</th><th>Description</th><th>Products</th><th>Order</th><th>Status</th><th style="width:140px;">Actions</th></tr></thead>
          <tbody>
            ${filtered.map(s => `<tr>
              <td><div style="font-weight:700;font-size:15px;">${esc(s.code)}</div></td>
              <td>
                <div style="display:flex;align-items:center;gap:6px;">
                  ${shapeThumbHTML(s, 44)}
                  <div style="display:flex;flex-direction:column;gap:2px;">
                    <button type="button" class="btn btn-ghost btn-sm" data-shape-img-up="${esc(s.id)}" title="${s.image_url ? 'Replace the shape image' : 'Upload a shape image'}">${s.image_url ? '🔁' : '📤'}</button>
                    ${s.image_url ? `<button type="button" class="btn btn-ghost btn-sm" data-shape-img-rm="${esc(s.id)}" title="Remove the shape image">✕</button>` : ''}
                  </div>
                  <input type="file" accept="image/jpeg,image/png,image/webp,image/avif" data-shape-img-file="${esc(s.id)}" style="display:none;">
                </div>
              </td>
              <td>
                <div style="font-weight:600;font-size:13px;">${esc(s.name_en || ('Shape ' + s.code))}</div>
                ${s.name_ar ? `<div style="font-size:11px;color:var(--text-muted);" dir="rtl">${esc(s.name_ar)}</div>` : ''}
              </td>
              <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary);font-size:12px;">${esc(s.description_en || '—')}</td>
              <td>${shapeProductCount(s.code) || '—'}</td>
              <td>
                <input type="number" step="1" value="${s.order || 0}" data-shape-order="${esc(s.id)}" style="width:70px;" title="Lower numbers appear first">
              </td>
              <td>${s.active !== false ? '<span class="badge badge-active">Active</span>' : '<span class="badge badge-inactive">Hidden</span>'}</td>
              <td>
                <button class="btn btn-ghost btn-sm" data-edit-shape="${esc(s.id)}" title="Edit">✏️</button>
                <button class="btn btn-ghost btn-sm" data-toggle-shape="${esc(s.id)}" title="${s.active !== false ? 'Hide from the storefront' : 'Show on the storefront'}">${s.active !== false ? '🙈' : '👁'}</button>
                <button class="btn btn-ghost btn-sm" data-delete-shape="${esc(s.id)}" title="Delete">🗑</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
        <div style="padding:12px 16px;font-size:12px;color:var(--text-muted);border-top:1px solid var(--border);">
          Hiding a shape removes it from the product-page selector, Quick Add, the Fitment Finder and new orders — everywhere at once. Products keep their own availability flags for every shape.
        </div>` : '<div class="empty-state"><div class="empty-icon">🗝️</div><h4>No key shapes</h4><p>Add the key shapes your accessories fit.</p></div>'}
      </div>
    </div>`;
  }

  function bindShapes() {
    const search = $('#shape-search');
    if (search) search.addEventListener('input', (e) => { state.shapeSearch = e.target.value; render(); });

    const addBtn = $('#btn-add-shape-cat');
    if (addBtn) addBtn.addEventListener('click', () => showShapeEditor(null));

    $$('[data-edit-shape]').forEach(el => el.addEventListener('click', () => showShapeEditor(el.dataset.editShape)));

    // Shape image: upload / replace / remove straight from the table. The
    // image is stored on the catalogue shape itself, so every selector on the
    // storefront picks it up as soon as the upload finishes.
    $$('[data-shape-img-up]').forEach(btn => btn.addEventListener('click', () => {
      const fileInput = document.querySelector(`[data-shape-img-file="${btn.dataset.shapeImgUp}"]`);
      if (fileInput) fileInput.click();
    }));
    $$('[data-shape-img-file]').forEach(inp => inp.addEventListener('change', async () => {
      const file = inp.files && inp.files[0];
      const id = inp.dataset.shapeImgFile;
      if (!file || !id) return;
      try {
        await setShapeImageFromFile(id, file);
        toast('Shape image updated — the storefront now shows it on every selector', 'success');
        render();
      } catch (e) { toast('Upload failed: ' + e.message, 'error'); }
      inp.value = '';
    }));
    $$('[data-shape-img-rm]').forEach(btn => btn.addEventListener('click', () => {
      const id = btn.dataset.shapeImgRm;
      const s = shapesList().find(x => x.id === id);
      showConfirm('Remove Shape Image', `Remove the image of Shape ${s?.code || id}? The storefront falls back to the generated silhouette.`, async () => {
        try {
          await clearShapeImage(id);
          toast('Shape image removed', 'success');
          render();
        } catch (e) { toast('Failed: ' + e.message, 'error'); }
      });
    }));

    $$('[data-toggle-shape]').forEach(el => el.addEventListener('click', async () => {
      const id = el.dataset.toggleShape;
      const s = shapesList().find(x => x.id === id);
      if (!s) return;
      try {
        await sbUpdate('shapes', id, { active: s.active === false });
        s.active = s.active === false;
        toast(s.active ? `Shape ${s.code} is visible again` : `Shape ${s.code} hidden from the storefront`, 'success');
        render();
      } catch (e) { toast('Failed: ' + e.message, 'error'); }
    }));

    $$('[data-shape-order]').forEach(el => el.addEventListener('change', async () => {
      const id = el.dataset.shapeOrder;
      try {
        await sbUpdate('shapes', id, { order: parseFloat(el.value) || 0 });
        toast('Order saved', 'success');
        await loadData();
      } catch (e) { toast('Failed: ' + e.message, 'error'); }
    }));

    $$('[data-delete-shape]').forEach(el => el.addEventListener('click', () => {
      const id = el.dataset.deleteShape;
      const s = shapesList().find(x => x.id === id);
      const used = shapeProductCount(s?.code);
      showConfirm(
        'Delete Shape',
        `Delete shape ${s?.code || id}? It disappears from every storefront selector and new orders. ${used ? `${used} product(s) still carry availability flags for it — those flags are kept but have no effect while the shape is gone.` : ''} This cannot be undone.`,
        async () => {
          try {
            await sbDelete('shapes', id);
            state.data.shapes = (state.data.shapes || []).filter(x => x.id !== id);
            toast('Shape deleted', 'success');
            render();
          } catch (e) { toast('Failed: ' + e.message, 'error'); }
        });
    }));
  }

  // Shared Add/Edit shape dialog. The code is the business key products'
  // keyShapes flags reference, so it is locked once created (same rule as a
  // brand slug) — renaming it would orphan every product that carries it.
  function showShapeEditor(id) {
    const s = id ? shapesList().find(x => x.id === id) : null;
    const isEdit = !!s;
    showModal(`
      <div class="modal" style="max-width:640px;">
        <div class="modal-header"><h3>${isEdit ? 'Edit Shape' : 'Add Shape'}</h3><button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button></div>
        <div class="modal-body">
          <form id="shape-form">
            <div class="form-row">
              <div class="form-group">
                <label>Code *</label>
                <input name="code" value="${esc(s?.code || '')}" maxlength="8" style="text-transform:uppercase;" placeholder="A" ${isEdit ? 'readonly title="The code is what products reference — it cannot change after creation."' : ''} required>
              </div>
              <div class="form-group">
                <label>Order</label>
                <input name="order" type="number" step="1" value="${s?.order != null ? s.order : shapesList().length + 1}">
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Name (EN) *</label>
                <input name="name_en" value="${esc(s?.name_en || '')}" placeholder="Shape A" required>
              </div>
              <div class="form-group">
                <label>Name (AR)</label>
                <input name="name_ar" value="${esc(s?.name_ar || '')}" dir="rtl" placeholder="الشكل A">
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Description (EN)</label>
                <textarea name="description_en" rows="2">${esc(s?.description_en || '')}</textarea>
              </div>
              <div class="form-group">
                <label>Description (AR)</label>
                <textarea name="description_ar" rows="2" dir="rtl">${esc(s?.description_ar || '')}</textarea>
              </div>
            </div>
            ${isEdit ? `
            <div class="form-group">
              <label>Shape image</label>
              <div style="display:flex;align-items:center;gap:12px;">
                <span id="shape-img-preview">${shapeThumbHTML(s, 56)}</span>
                <div style="display:flex;flex-direction:column;gap:6px;">
                  <button type="button" class="btn btn-secondary btn-sm" id="btn-shape-img-up">${s?.image_url ? '🔁 Replace image' : '📤 Upload image'}</button>
                  ${s?.image_url ? '<button type="button" class="btn btn-ghost btn-sm" id="btn-shape-img-rm">✕ Remove image</button>' : ''}
                  <input type="file" id="shape-img-file" accept="image/jpeg,image/png,image/webp,image/avif" style="display:none;">
                </div>
              </div>
              <p style="font-size:11px;color:var(--text-muted);margin:6px 0 0;">Shown on every storefront selector for this shape (product page, Quick Add, Fitment Finder, Key Guide). A shape without an image keeps the generated silhouette.</p>
            </div>` : `
            <p style="font-size:11px;color:var(--text-muted);">Save the shape first — you can then upload its image from this editor or straight from the Shapes table.</p>`}
            <div class="form-group">
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;"><input type="checkbox" name="active" ${(!s || s.active !== false) ? 'checked' : ''}> Visible on the storefront (uncheck to hide from every selector and new orders)</label>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button class="btn btn-primary" id="btn-save-shape">${isEdit ? 'Save Changes' : 'Create Shape'}</button>
        </div>
      </div>`);

    // Shape image controls (edit mode only). The upload lands on the
    // catalogue shape through /api/admin/shapes/image, then the editor is
    // re-opened so the preview and the Replace/Remove buttons refresh.
    const shapeImgUp = $('#btn-shape-img-up');
    if (shapeImgUp && s) {
      const shapeImgFile = $('#shape-img-file');
      shapeImgUp.addEventListener('click', () => shapeImgFile && shapeImgFile.click());
      shapeImgFile.addEventListener('change', async () => {
        const file = shapeImgFile.files && shapeImgFile.files[0];
        if (!file) return;
        try {
          await setShapeImageFromFile(s.id, file);
          toast(`Shape ${s.code} image updated`, 'success');
          closeAllModals(); showShapeEditor(s.id);
        } catch (e) { toast('Upload failed: ' + e.message, 'error'); }
        shapeImgFile.value = '';
      });
      const shapeImgRm = $('#btn-shape-img-rm');
      if (shapeImgRm) shapeImgRm.addEventListener('click', () => {
        showConfirm('Remove Shape Image', `Remove the image of Shape ${s.code}? The storefront falls back to the generated silhouette.`, async () => {
          try {
            await clearShapeImage(s.id);
            toast(`Shape ${s.code} image removed`, 'success');
            closeAllModals(); showShapeEditor(s.id);
          } catch (e) { toast('Failed: ' + e.message, 'error'); }
        });
      });
    }

    $('#btn-save-shape').addEventListener('click', async () => {
      const form = $('#shape-form');
      const val = (name) => ((form.querySelector(`[name=${name}]`) || {}).value || '').trim();
      const code = val('code').toUpperCase();
      const nameEn = val('name_en');
      if (!code) { toast('The shape needs a code', 'error'); return; }
      if (!nameEn) { toast('Fill the English name', 'error'); return; }
      const others = shapesList().filter(x => !isEdit || x.id !== s.id);
      if (others.some(x => String(x.code).toUpperCase() === code)) {
        toast(`A shape with code ${code} already exists`, 'error');
        return;
      }
      const fields = {
        code,
        name_en: nameEn,
        name_ar: val('name_ar'),
        description_en: val('description_en'),
        description_ar: val('description_ar'),
        order: parseFloat(val('order')) || 0,
        active: !!(form.querySelector('[name=active]') || {}).checked,
      };
      try {
        if (isEdit) {
          await sbUpdate('shapes', s.id, fields);
          const row = (state.data.shapes || []).find(x => x.id === s.id);
          if (row) Object.assign(row, fields);
          toast(`Shape ${code} updated`, 'success');
        } else {
          const data = Object.assign({ id: 'shape_' + code.toLowerCase() }, fields);
          await sbInsert('shapes', data);
          if (!state.data.shapes) state.data.shapes = [];
          state.data.shapes.push(Object.assign({}, data));
          toast(`Shape ${code} created`, 'success');
        }
        closeAllModals();
        render();
      } catch (e) { toast('Failed: ' + e.message, 'error'); }
    });
  }

  // ========================================================================
  // ORDERS
  // ========================================================================
  // ------------------------------------------------------------------------
  // ORDERS — full list. New customer orders arrive from Supabase by polling
  // /api/admin/orders, so they appear without a manual reload.
  // ------------------------------------------------------------------------
  let orderPollTimer = null;
  function stopOrderPolling() {
    if (orderPollTimer) { clearInterval(orderPollTimer); orderPollTimer = null; }
  }
  function startOrderPolling() {
    stopOrderPolling();
    orderPollTimer = setInterval(async () => {
      if (document.hidden) return;
      try {
        const { ok, j, status } = await api('GET', '/api/admin/orders');
        if (!ok || !j || !Array.isArray(j.orders)) {
          // Surface a broken feed once (e.g. expired session or the server
          // losing its Supabase connection) — never let the list go stale
          // in silence.
          if (!state.pollErrorShown) {
            state.pollErrorShown = true;
            if (!state.dataError) state.dataError = 'Orders feed failed (HTTP ' + status + ')';
            await fetchDiagnosis();
            render();
          }
          return;
        }
        if (state.pollErrorShown) {
          state.pollErrorShown = false;
          if (/Orders feed failed/.test(state.dataError)) state.dataError = '';
        }
        const before = (state.data?.orders || []).length;
        state.data = state.data || {};
        state.data.orders = j.orders;
        state.ordersUpdatedAt = new Date();
        if (j.orders.length !== before) toast('New customer order received', 'success');
        // Don't repaint while the admin is typing or has a panel open.
        if (document.querySelector('.modal-overlay')) return;
        if (document.activeElement && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
        if (state.view === 'orders' || state.view === 'dashboard') render();
      } catch (e) { /* keep the last known list while offline */ }
    }, 10000);
  }

  const ORDER_STATUSES = ['New', 'Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];

  function renderOrders() {
    const orders = state.data?.orders || [];
    const search = state.orderSearch || '';
    const filterStatus = state.orderStatusFilter || '';

    let filtered = orders.slice();
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(o =>
        (o.id || '').toLowerCase().includes(q) ||
        (o.customer?.fullName || '').toLowerCase().includes(q) ||
        (o.customer?.phone || '').includes(q) ||
        (o.customer?.address || '').toLowerCase().includes(q));
    }
    if (filterStatus) filtered = filtered.filter(o => o.status === filterStatus);

    filtered.sort((a, b) => new Date(b.createdAt || b.created_at) - new Date(a.createdAt || a.created_at));

    return `
    <div class="toolbar">
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input type="text" placeholder="Search order ID, customer, phone or address..." value="${esc(search)}" id="order-search">
      </div>
      <select class="filter-select" id="order-status-filter">
        <option value="">All Statuses</option>
        ${ORDER_STATUSES.map(s => `<option value="${s}" ${filterStatus === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
      <button class="btn btn-secondary" id="btn-refresh-orders" title="Reload from Supabase">↻ Refresh</button>
    </div>
    <p style="font-size:11px;color:var(--text-muted);margin:-6px 0 14px;">
      Auto-refreshes every 10 seconds from Supabase${state.ordersUpdatedAt ? ` · last checked ${fmtDateTime(state.ordersUpdatedAt)}` : ''}
    </p>

    <div class="stats-grid">
      <div class="stat-card"><div class="stat-icon blue">📋</div><div class="stat-value">${orders.length}</div><div class="stat-label">Total Orders</div></div>
      <div class="stat-card"><div class="stat-icon gold">🆕</div><div class="stat-value">${orders.filter(o => o.status === 'New' || o.status === 'Pending').length}</div><div class="stat-label">New/Pending</div></div>
      <div class="stat-card"><div class="stat-icon green">✅</div><div class="stat-value">${orders.filter(o => o.status === 'Delivered').length}</div><div class="stat-label">Delivered</div></div>
      <div class="stat-card"><div class="stat-icon red">✕</div><div class="stat-value">${orders.filter(o => o.status === 'Cancelled').length}</div><div class="stat-label">Cancelled</div></div>
    </div>

    <div class="card">
      <div class="card-body" style="padding:0;overflow-x:auto;">
        ${filtered.length ? `
        <table class="data-table">
          <thead><tr><th>Order ID</th><th>Date</th><th>Customer</th><th>Phone</th><th>Address</th><th>Items</th><th>Total</th><th>Payment Method</th><th>Payment Status</th><th>Transfer Proof</th><th>Status</th><th style="width:120px;">Actions</th></tr></thead>
          <tbody>
            ${filtered.map(o => `<tr>
              <td><strong>${esc(o.id)}</strong>${(o.coatingFee || 0) > 0 ? ` <span class="badge badge-coating" title="Nano Ceramic Coating requested (+${money(o.coatingFee)})">◆ Coating</span>` : ''}</td>
              <td>${fmtDateTime(o.createdAt || o.created_at)}</td>
              <td>${esc(o.customer?.fullName || '—')}</td>
              <td>${esc(o.customer?.phone || '—')}</td>
              <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary);font-size:12px;">${esc(o.customer?.address || '—')}${o.customer?.city ? ', ' + esc(o.customer.city) : ''}</td>
              <td>${(o.items || []).length}</td>
              <td><strong>${money(o.total)}</strong></td>
              <td>${o.payment === 'InstaPay'
                ? `<span class="badge badge-gold" title="Payment method: InstaPay">⚡ InstaPay</span>`
                : `<span style="color:var(--text-muted);">Cash on Delivery</span>`}</td>
              <td>${paymentStatusBadge(effectivePaymentStatus(o))}</td>
              <td>${o.payment === 'InstaPay'
                ? (o.paymentProof?.available
                  ? `<button class="btn btn-ghost btn-sm" data-view-order="${esc(o.id)}" title="View uploaded transfer proof">View proof</button>`
                  : `<span class="badge badge-payment-rejected" title="No proof attached">Missing</span>`)
                : '<span style="color:var(--text-muted);">—</span>'}</td>
              <td>${statusBadge(o.status)}</td>
              <td>
                <button class="btn btn-ghost btn-sm" data-view-order="${esc(o.id)}" title="Open">👁</button>
                <button class="btn btn-ghost btn-sm" data-delete-order="${esc(o.id)}" title="Delete">🗑</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty-state"><div class="empty-icon">📋</div><h4>No orders found</h4></div>'}
      </div>
    </div>`;
  }

  // ========================================================================
  // CUSTOMERS
  // ========================================================================
  function renderCustomers() {
    const orders = state.data?.orders || [];
    const search = state.customerSearch || '';

    const customerMap = {};
    orders.forEach(o => {
      const key = (o.customer?.phone || '') + '|' + (o.customer?.email || '');
      if (!customerMap[key]) {
        customerMap[key] = {
          name: o.customer?.fullName || 'Unknown',
          phone: o.customer?.phone || '',
          email: o.customer?.email || '',
          address: o.customer?.address || '',
          city: o.customer?.city || '',
          orders: 0,
          total: 0,
          lastOrder: o.createdAt,
        };
      }
      customerMap[key].orders++;
      customerMap[key].total += o.total || 0;
      if (new Date(o.createdAt) > new Date(customerMap[key].lastOrder)) {
        customerMap[key].lastOrder = o.createdAt;
      }
    });

    let customers = Object.values(customerMap);
    if (search) {
      const q = search.toLowerCase();
      customers = customers.filter(c => (c.name || '').toLowerCase().includes(q) || (c.phone || '').includes(q) || (c.email || '').toLowerCase().includes(q));
    }
    customers.sort((a, b) => b.total - a.total);

    return `
    <div class="toolbar">
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input type="text" placeholder="Search customers..." value="${esc(search)}" id="customer-search">
      </div>
    </div>
    <div class="card">
      <div class="card-body" style="padding:0;overflow-x:auto;">
        ${customers.length ? `
        <table class="data-table">
          <thead><tr><th>Customer</th><th>Phone</th><th>Email</th><th>City</th><th>Orders</th><th>Total Spent</th><th>Last Order</th></tr></thead>
          <tbody>
            ${customers.map(c => `<tr>
              <td><strong>${esc(c.name)}</strong></td>
              <td>${esc(c.phone)}</td>
              <td>${esc(c.email)}</td>
              <td>${esc(c.city)}</td>
              <td><span class="badge badge-new">${c.orders}</span></td>
              <td><strong>${money(c.total)}</strong></td>
              <td>${fmtDate(c.lastOrder)}</td>
            </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty-state"><div class="empty-icon">👥</div><h4>No customers yet</h4><p>Customer data appears here after orders are placed.</p></div>'}
      </div>
    </div>`;
  }

  // ========================================================================
  // INVENTORY
  // ========================================================================
  function renderInventory() {
    const products = state.data?.products || [];
    const search = state.inventorySearch || '';
    const filter = state.inventoryFilter || '';

    let filtered = products;
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(p => (p.name_en || '').toLowerCase().includes(q));
    }
    if (filter === 'low') filtered = filtered.filter(p => (p.stock || 0) <= 5 && (p.stock || 0) > 0);
    if (filter === 'out') filtered = filtered.filter(p => (p.stock || 0) === 0);
    if (filter === 'ok') filtered = filtered.filter(p => (p.stock || 0) > 5);

    return `
    <div class="toolbar">
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input type="text" placeholder="Search inventory..." value="${esc(search)}" id="inventory-search">
      </div>
      <select class="filter-select" id="inventory-filter">
        <option value="">All Stock</option>
        <option value="low" ${filter==='low'?'selected':''}>Low Stock (≤5)</option>
        <option value="out" ${filter==='out'?'selected':''}>Out of Stock</option>
        <option value="ok" ${filter==='ok'?'selected':''}>In Stock (>5)</option>
      </select>
    </div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-icon green">✅</div><div class="stat-value">${products.filter(p=>(p.stock||0)>5).length}</div><div class="stat-label">In Stock</div></div>
      <div class="stat-card"><div class="stat-icon orange">⚠️</div><div class="stat-value">${products.filter(p=>(p.stock||0)<=5&&(p.stock||0)>0).length}</div><div class="stat-label">Low Stock</div></div>
      <div class="stat-card"><div class="stat-icon red">🚫</div><div class="stat-value">${products.filter(p=>(p.stock||0)===0).length}</div><div class="stat-label">Out of Stock</div></div>
      <div class="stat-card"><div class="stat-icon blue">📦</div><div class="stat-value">${products.reduce((s,p)=>s+(p.stock||0),0)}</div><div class="stat-label">Total Units</div></div>
    </div>
    <div class="card">
      <div class="card-body" style="padding:0;overflow-x:auto;">
        ${filtered.length ? `
        <table class="data-table">
          <thead><tr><th>Product</th><th>SKU</th><th>Stock</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            ${filtered.map(p => `<tr>
              <td><strong>${esc(p.name_en)}</strong></td>
              <td>${esc(p.sku || '—')}</td>
              <td><input type="number" value="${p.stock||0}" data-stock-id="${esc(p.id)}" style="width:70px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-weight:600;text-align:center;" min="0"></td>
              <td>${(p.stock||0)===0?'<span class="badge badge-cancelled">Out</span>':(p.stock||0)<=5?'<span class="badge badge-pending">Low</span>':'<span class="badge badge-active">OK</span>'}</td>
              <td><button class="btn btn-ghost btn-sm" data-save-stock="${esc(p.id)}">💾</button></td>
            </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty-state"><p>No products in inventory.</p></div>'}
      </div>
    </div>`;
  }

  // ========================================================================
  // DISCOUNTS
  // ========================================================================
  function renderDiscounts() {
    const discounts = state.data?.discount_codes || [];
    return `
    <div class="toolbar">
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input type="text" placeholder="Search discount codes..." id="discount-search">
      </div>
      <button class="btn btn-primary" id="btn-add-discount">+ Add Discount Code</button>
    </div>
    <div class="card">
      <div class="card-body" style="padding:0;">
        ${discounts.length ? `
        <table class="data-table">
          <thead><tr><th>Code</th><th>Type</th><th>Value</th><th>Min Order</th><th>Uses</th><th>Expires</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            ${discounts.map(d => `<tr>
              <td><strong style="font-family:monospace;font-size:14px;">${esc(d.code)}</strong></td>
              <td>${esc(d.type)}</td>
              <td><strong>${d.type === 'percentage' ? d.value + '%' : money(d.value)}</strong></td>
              <td>${money(d.min_order || 0)}</td>
              <td>${d.used_count || 0}${d.max_uses ? '/' + d.max_uses : ''}</td>
              <td>${d.expires_at ? fmtDate(d.expires_at) : '—'}</td>
              <td>${d.active ? '<span class="badge badge-active">Active</span>' : '<span class="badge badge-inactive">Inactive</span>'}</td>
              <td>
                <button class="btn btn-ghost btn-sm" data-edit-discount="${esc(d.id)}">✏️</button>
                <button class="btn btn-ghost btn-sm" data-delete-discount="${esc(d.id)}">🗑</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty-state"><div class="empty-icon">💰</div><h4>No discount codes</h4><p>Create discount codes to offer promotions.</p></div>'}
      </div>
    </div>`;
  }

  // ========================================================================
  // PACKAGES
  // ========================================================================
  function renderPackages() {
    const bundles = state.data?.bundles || [];
    const brands = state.data?.brands || [];
    const products = state.data?.products || [];

    return `
    <div class="toolbar">
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input type="text" placeholder="Search packages..." id="package-search">
      </div>
      <button class="btn btn-primary" id="btn-add-package">+ Add Package</button>
    </div>
    <div class="card">
      <div class="card-body" style="padding:0;">
        ${bundles.length ? `
        <table class="data-table">
          <thead><tr><th>Package</th><th>Brand</th><th>Bundle Price</th><th>Regular Total</th><th>Savings</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            ${bundles.map(b => {
              const brand = brands.find(x => x.slug === b.brandSlug);
              const save = Math.max(0, (b.normalTotal || 0) - (b.bundlePrice || 0));
              return `<tr>
                <td><strong>${esc(b.title_en || b.name_en || (brand?.name_en ? brand.name_en + ' Bundle' : b.brandSlug))}</strong></td>
                <td>${esc(brand?.name_en || b.brandSlug)}</td>
                <td><strong style="color:var(--spinto-gold-deep);">${money(b.bundlePrice)}</strong></td>
                <td style="text-decoration:line-through;color:var(--text-muted);">${money(b.normalTotal)}</td>
                <td><span class="badge badge-active">Save ${money(save)}</span></td>
                <td>${b.active !== false ? '<span class="badge badge-active">Active</span>' : '<span class="badge badge-inactive">Inactive</span>'}</td>
                <td>
                  <button class="btn btn-ghost btn-sm" data-edit-package="${esc(b.id)}">✏️</button>
                  <button class="btn btn-ghost btn-sm" data-delete-package="${esc(b.id)}">🗑</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>` : '<div class="empty-state"><div class="empty-icon">🎁</div><h4>No packages</h4><p>Create bundles to offer discounted sets.</p></div>'}
      </div>
    </div>`;
  }

  // ========================================================================
  // WEBSITE CONTENT
  // ========================================================================
  function renderContent() {
    const settings = state.data?.settings || {};
    const heroSlides = state.data?.heroSlides || [];
    const homeSections = state.data?.homeSections || [];
    const promoBar = state.data?.promoBar || {};

    const content = state.data?.websiteContent || [];
    const contentSearch = (state.contentSearch || '').toLowerCase();
    const filteredContent = contentSearch
      ? content.filter(c => (c.key || '').toLowerCase().includes(contentSearch)
          || (c.value_en || '').toLowerCase().includes(contentSearch)
          || (c.value_ar || '').includes(contentSearch))
      : content;

    return `
    <div class="card">
      <div class="card-header"><h3>🌐 Website Content Sections</h3></div>
      <div class="card-body">
        <p style="color:var(--text-secondary);font-size:13px;margin-bottom:12px;">
          Every editable text on the storefront, stored in Supabase (<code>website_content</code>).
          Changing a value here updates the live site.
        </p>
        <div class="toolbar" style="margin-bottom:12px;">
          <div class="search-box">
            <span class="search-icon">🔍</span>
            <input type="text" placeholder="Search ${content.length} content strings..." value="${esc(state.contentSearch || '')}" id="content-search">
          </div>
          <span style="font-size:12px;color:var(--text-muted);">${filteredContent.length} shown</span>
        </div>
        ${filteredContent.length ? `
        <div style="max-height:420px;overflow:auto;border:1px solid var(--border);border-radius:8px;">
        <table class="data-table" style="font-size:12px;">
          <thead><tr><th>Key</th><th>English</th><th>Arabic</th><th style="width:60px;"></th></tr></thead>
          <tbody>
            ${filteredContent.slice(0, 200).map(c => `<tr>
              <td><code style="font-size:11px;">${esc(c.key)}</code></td>
              <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(c.value_en || '—')}</td>
              <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" dir="rtl">${esc(c.value_ar || '—')}</td>
              <td><button class="btn btn-ghost btn-sm" data-edit-content="${esc(c.key)}">✏️</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
        </div>` : '<p style="color:var(--text-muted);font-size:13px;">No content strings found.</p>'}
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h3>📝 Hero Section</h3></div>
      <div class="card-body">
        <p style="color:var(--text-secondary);font-size:13px;margin-bottom:16px;">Manage hero slides and featured content.</p>
        ${heroSlides.length ? heroSlides.map((s, i) => `
          <div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg);border-radius:8px;margin-bottom:8px;">
            <span style="font-weight:600;color:var(--text-muted);width:24px;">#${i+1}</span>
            <div style="flex:1;">
              <div style="font-weight:600;">${esc(s.title_en || 'Untitled')}</div>
              <div style="font-size:12px;color:var(--text-muted);">${esc(s.subtitle_en || '')}</div>
            </div>
            <span class="badge ${s.active ? 'badge-active' : 'badge-inactive'}">${s.active ? 'Active' : 'Hidden'}</span>
            <button class="btn btn-ghost btn-sm" data-edit-slide="${esc(s.id)}">️</button>
          </div>
        `).join('') : '<p style="color:var(--text-muted);font-size:13px;">No hero slides configured.</p>'}
        <button class="btn btn-secondary btn-sm" id="btn-add-slide" style="margin-top:12px;">+ Add Hero Slide</button>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h3>🏠 Homepage Sections</h3></div>
      <div class="card-body">
        ${homeSections.length ? homeSections.sort((a,b)=>(a.order||0)-(b.order||0)).map((s, i) => `
          <div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg);border-radius:8px;margin-bottom:8px;">
            <span style="font-weight:600;color:var(--text-muted);width:24px;">#${i+1}</span>
            <div style="flex:1;">
              <div style="font-weight:600;">${esc(s.title_en || s.type || 'Section')}</div>
              <div style="font-size:12px;color:var(--text-muted);">Type: ${esc(s.type)}</div>
            </div>
            <button class="btn btn-ghost btn-sm" data-edit-section-title="${esc(s.id)}" title="Edit title">✏️</button>
            <label class="toggle">
              <input type="checkbox" data-toggle-section="${esc(s.id)}" ${s.enabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
        `).join('') : '<p style="color:var(--text-muted);font-size:13px;">No sections configured.</p>'}
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h3>📢 Promo Bar</h3></div>
      <div class="card-body">
        <div class="form-group">
          <label>Promo Text (English)</label>
          <input type="text" id="promo-text-en" value="${esc(promoBar.text_en || '')}" placeholder="FREE DELIVERY ON ALL ORDERS">
        </div>
        <div class="form-group">
          <label>Promo Text (Arabic)</label>
          <input type="text" id="promo-text-ar" value="${esc(promoBar.text_ar || '')}" placeholder="توصيل مجاني على جميع الطلبات">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Enabled</label>
            <select id="promo-enabled">
              <option value="true" ${promoBar.enabled ? 'selected' : ''}>Yes</option>
              <option value="false" ${!promoBar.enabled ? 'selected' : ''}>No</option>
            </select>
          </div>
          <div class="form-group">
            <label>End Time</label>
            <input type="datetime-local" id="promo-end" value="${promoBar.endTime ? promoBar.endTime.slice(0,16) : ''}">
          </div>
        </div>
        <button class="btn btn-primary" id="btn-save-promo">Save Promo Bar</button>
      </div>
    </div>`;
  }

  // ========================================================================
  // WEBSITE IMAGES
  // ========================================================================
  function renderImages() {
    const images = state.data?.website_images || [];
    return `
    <div class="toolbar">
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input type="text" placeholder="Search images..." id="image-search">
      </div>
      <button class="btn btn-primary" id="btn-upload-image">📤 Upload Image</button>
    </div>
    <div class="card">
      <div class="card-body">
        <div class="image-upload-zone" id="upload-zone">
          <div class="upload-icon">📤</div>
          <p><strong>Click to upload</strong> or drag and drop</p>
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px;">PNG, JPG, WEBP up to 5MB. Serverless hosts have a read-only disk — use "Add by URL" there.</p>
          <input type="file" id="image-file-input" accept="image/*" style="display:none;" multiple>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
          <input id="image-url-input" placeholder="https://…/image.jpg or /img/uploads/…" style="flex:1;min-width:220px;">
          <input id="image-name-input" placeholder="Name" style="width:160px;">
          <button class="btn btn-secondary" id="btn-image-by-url">+ Add by URL</button>
        </div>
        ${images.length ? `
        <div class="image-preview-grid" style="margin-top:20px;">
          ${images.map(img => `
            <div class="image-preview-item">
              <img src="${esc(img.url)}" alt="${esc(img.name)}">
              <button class="remove-img" data-delete-image="${esc(img.id)}">×</button>
            </div>
          `).join('')}
        </div>` : '<div class="empty-state" style="padding:30px;"><p>No uploaded images yet.</p></div>'}
      </div>
    </div>`;
  }

  // ========================================================================
  // CONTACT MESSAGES
  // ========================================================================
  function renderMessages() {
    const messages = state.data?.messages || [];
    const search = state.messageSearch || '';
    const filter = state.messageFilter || '';

    let filtered = messages;
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(m => (m.name || '').toLowerCase().includes(q) || (m.email || '').toLowerCase().includes(q) || (m.message || '').toLowerCase().includes(q));
    }
    if (filter === 'unread') filtered = filtered.filter(m => !m.is_read);
    if (filter === 'resolved') filtered = filtered.filter(m => m.is_resolved);
    if (filter === 'open') filtered = filtered.filter(m => !m.is_resolved);

    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return `
    <div class="toolbar">
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input type="text" placeholder="Search messages..." value="${esc(search)}" id="message-search">
      </div>
      <select class="filter-select" id="message-filter">
        <option value="">All Messages</option>
        <option value="unread" ${filter==='unread'?'selected':''}>Unread</option>
        <option value="open" ${filter==='open'?'selected':''}>Open</option>
        <option value="resolved" ${filter==='resolved'?'selected':''}>Resolved</option>
      </select>
    </div>
    <div class="card">
      <div class="card-body" style="padding:0;">
        ${filtered.length ? `
        <table class="data-table">
          <thead><tr><th>From</th><th>Email</th><th>Phone</th><th>Message</th><th>Date</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            ${filtered.map(m => `<tr style="${!m.is_read ? 'background:#fafbfc;' : ''}">
              <td><strong>${esc(m.name || '—')}</strong></td>
              <td>${esc(m.email || '—')}</td>
              <td>${esc(m.phone || '—')}</td>
              <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc((m.message || '').slice(0, 60))}${(m.message||'').length > 60 ? '...' : ''}</td>
              <td>${fmtDateTime(m.createdAt)}</td>
              <td>
                ${!m.is_read ? '<span class="badge badge-new">Unread</span>' : ''}
                ${m.is_resolved ? '<span class="badge badge-delivered">Resolved</span>' : (!m.is_read ? '' : '<span class="badge badge-active">Open</span>')}
              </td>
              <td>
                <button class="btn btn-ghost btn-sm" data-view-message="${esc(m.id)}"></button>
                <button class="btn btn-ghost btn-sm" data-toggle-read-message="${esc(m.id)}">${m.is_read ? '📭' : '📬'}</button>
                <button class="btn btn-ghost btn-sm" data-delete-message="${esc(m.id)}">🗑</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty-state"><div class="empty-icon">✉️</div><h4>No messages</h4><p>Contact form submissions appear here.</p></div>'}
      </div>
    </div>`;
  }

  // ========================================================================
  // CUSTOMIZE — Settings (which categories are available) + Requests
  // ========================================================================
  // The availability of a category for Customize lives in the `customize`
  // setting (see supabase/migrations/003_customize.sql) and NEVER touches
  // categories.active, so the normal shopping pages are unaffected by anything
  // that is changed here.
  const CUSTOMIZE_STATUSES = ['New', 'Contacted', 'In Progress', 'Completed', 'Cancelled'];
  const CZ_STATUS_CLASS = {
    'New': 'badge-new',
    'Contacted': 'badge-confirmed',
    'In Progress': 'badge-processing',
    'Completed': 'badge-delivered',
    'Cancelled': 'badge-cancelled',
  };

  function czConfig() {
    const c = state.data && state.data.customize;
    return (c && typeof c === 'object') ? c : { categories: {}, list: [], stats: { total: 0, new: 0 } };
  }

  // Every category the site has, with its Customize availability. `list` comes
  // from the server; the plain categories collection is the fallback for an
  // older payload.
  function czCategoryRows() {
    const cfg = czConfig();
    if (Array.isArray(cfg.list) && cfg.list.length) {
      return cfg.list.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    }
    return (state.data?.categories || []).slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map(c => ({
        id: c.id, slug: c.slug, name_en: c.name_en || c.name, name_ar: c.name_ar,
        image: c.image, product_count: c.product_count, order: c.order,
        active: c.active !== false,
        enabled: cfg.categories ? cfg.categories[c.id] !== false : true,
      }));
  }

  // The ON/OFF draft the admin is editing (starts from what is saved).
  function czDraft() {
    const rows = czCategoryRows();
    if (!state.czSettings) {
      const map = {};
      rows.forEach(c => { map[c.id] = c.enabled !== false; });
      state.czSettings = map;
    }
    return state.czSettings;
  }

  function renderCustomizeSettings() {
    const rows = czCategoryRows();
    const draft = czDraft();
    const enabled = rows.filter(c => draft[c.id] !== false).length;
    const cfg = czConfig();
    return `
    <div class="card">
      <div class="card-header">
        <h3>🎨 Customize Settings</h3>
        <span class="cz-hint">Switch a category ON to offer it on the public Customize page. This never changes the normal shop pages.</span>
      </div>
      <div class="card-body" style="padding:0;overflow-x:auto;">
        ${rows.length ? `
        <table class="data-table">
          <thead><tr><th style="width:70px;">Image</th><th>Category</th><th>Slug</th><th>Products</th><th>Shop page</th><th style="width:250px;">Available for Customize</th></tr></thead>
          <tbody>
            ${rows.map(c => {
              const on = draft[c.id] !== false;
              return `<tr>
                <td>${c.image ? `<img src="${esc(c.image)}" alt="" style="width:48px;height:36px;object-fit:cover;border-radius:6px;background:var(--cream);">` : '<div style="width:48px;height:36px;background:var(--cream);border-radius:6px;display:flex;align-items:center;justify-content:center;">🏷️</div>'}</td>
                <td>
                  <div style="font-weight:600;font-size:13px;">${esc(c.name_en || c.id)}</div>
                  ${c.name_ar ? `<div style="font-size:11px;color:var(--text-muted);" dir="rtl">${esc(c.name_ar)}</div>` : ''}
                </td>
                <td>${esc(c.slug || c.id)}</td>
                <td>${c.product_count != null ? c.product_count : '—'}</td>
                <td>${c.active !== false ? '<span class="badge badge-active">Active</span>' : '<span class="badge badge-inactive">Hidden</span>'}</td>
                <td>
                  <div class="cz-toggle" data-cz-row="${esc(c.id)}">
                    <button type="button" class="cz-opt ${on ? 'on' : ''}" data-cz-enable="${esc(c.id)}" data-cz-value="1" aria-pressed="${on}">ON</button>
                    <button type="button" class="cz-opt ${!on ? 'off' : ''}" data-cz-enable="${esc(c.id)}" data-cz-value="0" aria-pressed="${!on}">OFF</button>
                  </div>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>` : '<div class="empty-state"><div class="empty-icon">🏷️</div><h4>No categories yet</h4><p>Add categories under Catalog → Categories first.</p></div>'}
      </div>
      <div class="card-footer">
        <span class="cz-summary" id="cz-settings-summary">${enabled} of ${rows.length} categor${rows.length === 1 ? 'y' : 'ies'} available for Customize</span>
        <button class="btn btn-primary" id="btn-save-customize" ${state.czSaving ? 'disabled' : ''}>${state.czSaving ? 'Saving…' : '💾 Save Changes'}</button>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><h3>ℹ️ How this works</h3></div>
      <div class="card-body">
        <p class="cz-hint">Customers open <a href="/#/customize" target="_blank" rel="noopener">/#/customize</a> and only see the categories switched ON above. The standard category pages keep showing every category according to its own Active/Hidden setting.</p>
        <p class="cz-hint">${cfg.updatedAt ? `Last saved ${fmtDateTime(cfg.updatedAt)}.` : 'No Customize configuration saved yet — every existing category is offered by default.'}</p>
        <p class="cz-hint">Car photos are stored in the private <code>customize-uploads</code> bucket (${cfg.storage && cfg.storage.configured ? 'Supabase Storage' : 'inline fallback — Supabase Storage is not configured on this server'}) and are only viewable by an admin through short-lived signed links.</p>
      </div>
    </div>`;
  }

  function bindCustomizeSettings() {
    czDraft();   // make sure the draft exists before any click
    $$('[data-cz-enable]').forEach(el => el.addEventListener('click', () => {
      const id = el.dataset.czEnable;
      const on = el.dataset.czValue === '1';
      state.czSettings = Object.assign({}, czDraft(), { [id]: on });
      const row = el.closest('[data-cz-row]');
      if (row) {
        row.querySelectorAll('[data-cz-enable]').forEach(b => {
          const isOn = b.dataset.czValue === '1';
          b.classList.toggle(isOn ? 'on' : 'off', isOn === on);
          b.setAttribute('aria-pressed', String(isOn === on));
        });
      }
      const rows = czCategoryRows();
      const enabled = rows.filter(c => state.czSettings[c.id] !== false).length;
      const summary = $('#cz-settings-summary');
      if (summary) summary.textContent = `${enabled} of ${rows.length} categor${rows.length === 1 ? 'y' : 'ies'} available for Customize`;
    }));

    const save = $('#btn-save-customize');
    if (save) save.addEventListener('click', async () => {
      const categories = czDraft();
      state.czSaving = true;
      save.disabled = true;
      save.textContent = 'Saving…';
      try {
        const { ok, j } = await api('POST', '/api/admin/customize/settings', { categories });
        if (!ok || !j || !j.ok) throw new Error((j && j.error) || 'Save failed');
        if (state.data) state.data.customize = Object.assign({}, czConfig(), j.customize || {});
        state.czSettings = null;
        toast('Customize settings saved', 'success');
      } catch (e) {
        toast('Failed: ' + e.message, 'error');
      }
      state.czSaving = false;
      render();
    });
  }

  // ------------------------------------------------------------------ requests
  function czRequestCounts() {
    const all = state.czRequests || [];
    const counts = { total: all.length };
    CUSTOMIZE_STATUSES.forEach(s => { counts[s] = all.filter(r => (r.status || 'New') === s).length; });
    return counts;
  }

  function czFilteredRequests() {
    let list = (state.czRequests || []).slice();
    if (state.czFilter && state.czFilter !== 'all') list = list.filter(r => (r.status || 'New') === state.czFilter);
    const q = (state.czSearch || '').trim().toLowerCase();
    if (q) {
      list = list.filter(r => [r.id, r.customer_name, r.phone, r.whatsapp, r.email,
        r.car_brand, r.car_model, r.model_year, r.category_name_en]
        .filter(Boolean).some(v => String(v).toLowerCase().includes(q)));
    }
    return list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  }

  function renderCustomizeRequests() {
    if (state.czRequests === null && state.czLoading) {
      return `<div class="loading-state"><div class="spinner"></div> Loading customization requests…</div>`;
    }
    if (state.czRequests === null) {
      return `<div class="card"><div class="card-body">
        <div class="empty-state">
          <div class="empty-icon">⚠️</div>
          <h4>Could not load the requests</h4>
          <p>${esc(state.czError || 'Unknown error')}</p>
          <button class="btn btn-primary" id="cz-retry">Retry</button>
        </div>
      </div></div>`;
    }

    return `
    <div class="toolbar cz-toolbar">
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input type="text" placeholder="Search name, phone, request ID, car…" value="${esc(state.czSearch)}" id="cz-search">
      </div>
      <button class="btn btn-secondary btn-sm" id="cz-refresh">↻ Refresh</button>
    </div>
    <div id="cz-list-region">${czListRegionHTML()}</div>`;
  }

  function czListRegionHTML() {
    const counts = czRequestCounts();
    const list = czFilteredRequests();
    const chips = [['all', 'All']].concat(CUSTOMIZE_STATUSES.map(s => [s, s]));

    return `
    <div class="cz-chips">
      ${chips.map(([key, label]) => `<button type="button" class="cz-chip ${state.czFilter === key ? 'active' : ''}" data-cz-filter="${esc(key)}">${esc(label)} <b>${key === 'all' ? counts.total : (counts[key] || 0)}</b></button>`).join('')}
    </div>
    <div class="card">
      <div class="card-body" style="padding:0;overflow-x:auto;">
        ${list.length ? `
        <table class="data-table cz-table">
          <thead><tr><th>Request</th><th>Photo</th><th>Category</th><th>Car</th><th>Customer</th><th>Status</th><th style="width:170px;">Actions</th></tr></thead>
          <tbody>
            ${list.map(r => `<tr>
              <td>
                <div style="font-weight:600;font-size:12.5px;">${esc(r.id)}</div>
                <div style="font-size:11px;color:var(--text-muted);">${fmtDateTime(r.created_at)}</div>
              </td>
              <td>
                <button type="button" class="cz-thumb" data-cz-thumb="${esc(r.id)}" title="View car photo">
                  ${r.hasPhoto ? '<span class="cz-thumb-state">Load</span>' : '<span class="cz-thumb-none">—</span>'}
                </button>
              </td>
              <td>${esc(r.category_name_en || r.category_slug || r.category_id || '—')}</td>
              <td>
                <div style="font-size:12.5px;font-weight:600;">${esc(r.car_brand || '—')}</div>
                <div style="font-size:11px;color:var(--text-muted);">${esc([r.car_model, r.model_year].filter(Boolean).join(' · '))}</div>
              </td>
              <td>
                <div style="font-size:12.5px;font-weight:600;">${esc(r.customer_name || '—')}</div>
                <div style="font-size:11px;color:var(--text-muted);">${esc(r.phone || '')}</div>
              </td>
              <td>
                <select class="cz-status-select" data-cz-status="${esc(r.id)}">
                  ${CUSTOMIZE_STATUSES.map(s => `<option value="${esc(s)}" ${(r.status || 'New') === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
                </select>
                <div style="margin-top:4px;"><span class="badge ${CZ_STATUS_CLASS[r.status || 'New'] || 'badge-new'}">${esc(r.status || 'New')}</span></div>
              </td>
              <td>
                <button class="btn btn-ghost btn-sm" data-cz-view="${esc(r.id)}" title="Open">👁</button>
                <button class="btn btn-ghost btn-sm" data-cz-photo="${esc(r.id)}" title="Car photo">🖼</button>
                <button class="btn btn-ghost btn-sm" data-cz-delete="${esc(r.id)}" title="Delete">🗑</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>` : `<div class="empty-state"><div class="empty-icon">📸</div><h4>No customization requests</h4><p>${state.czFilter !== 'all' || state.czSearch ? 'Nothing matches this filter.' : 'Requests submitted from the Customize page appear here.'}</p></div>`}
      </div>
    </div>`;
  }

  // Signed (or inline) photo URL for one request — cached for the session.
  async function czPhoto(id) {
    if (state.czPhotoCache[id]) return state.czPhotoCache[id];
    const { ok, j } = await api('GET', `/api/admin/customize/requests/${encodeURIComponent(id)}/photo`);
    if (!ok || !j || !j.url) throw new Error((j && (j.error || j.hint)) || 'Photo unavailable');
    state.czPhotoCache[id] = j;
    return j;
  }

  function bindCustomizeRequests() {
    // First visit (or after a refresh) → fetch the list, then re-render.
    if (state.czRequests === null && !state.czLoading) {
      loadCustomizeRequests();
      return;
    }

    const search = $('#cz-search');
    if (search) search.addEventListener('input', (e) => {
      state.czSearch = e.target.value;
      clearTimeout(state.czSearchTimer);
      // Refresh only the list region — the search box keeps focus while typing.
      state.czSearchTimer = setTimeout(czRefreshList, 220);
    });

    const refresh = $('#cz-refresh');
    if (refresh) refresh.addEventListener('click', () => { state.czRequests = null; state.czPhotoCache = {}; render(); });

    const retry = $('#cz-retry');
    if (retry) retry.addEventListener('click', () => { state.czRequests = null; state.czError = ''; render(); });

    bindCzList();
  }

  // Everything inside #cz-list-region is re-bound whenever that region is
  // re-rendered (search / filter / status change), so no control is ever left
  // without its handler.
  function bindCzList() {
    $$('[data-cz-filter]').forEach(el => el.addEventListener('click', () => {
      state.czFilter = el.dataset.czFilter;
      czRefreshList();
    }));

    // Load the thumbnails (private bucket → signed link minted per request).
    const thumbs = $$('[data-cz-thumb]').slice(0, 30);
    thumbs.forEach(async (el) => {
      const id = el.dataset.czThumb;
      const row = (state.czRequests || []).find(r => r.id === id);
      if (!row || !row.hasPhoto) return;
      try {
        const p = await czPhoto(id);
        el.innerHTML = `<img src="${esc(p.url)}" alt="Car photo">`;
        el.classList.add('loaded');
      } catch (e) {
        el.innerHTML = '<span class="cz-thumb-fail">!</span>';
      }
    });

    $$('[data-cz-photo]').forEach(el => el.addEventListener('click', () => showCustomizePhoto(el.dataset.czPhoto)));
    $$('[data-cz-thumb]').forEach(el => el.addEventListener('click', () => showCustomizePhoto(el.dataset.czThumb)));
    $$('[data-cz-view]').forEach(el => el.addEventListener('click', () => showCustomizeRequestDetail(el.dataset.czView)));

    $$('[data-cz-status]').forEach(el => el.addEventListener('change', async () => {
      const id = el.dataset.czStatus;
      const status = el.value;
      el.disabled = true;
      try {
        const { ok, j } = await api('POST', `/api/admin/customize/requests/${encodeURIComponent(id)}`, { status });
        if (!ok || !j || !j.ok) throw new Error((j && j.error) || 'Update failed');
        const row = (state.czRequests || []).find(r => r.id === id);
        if (row) row.status = status;
        toast(`Marked as ${status}`, 'success');
      } catch (e) {
        toast('Failed: ' + e.message, 'error');
        el.value = ((state.czRequests || []).find(r => r.id === id) || {}).status || 'New';
      }
      el.disabled = false;
      czRefreshList();
    }));

    $$('[data-cz-delete]').forEach(el => el.addEventListener('click', () => {
      const id = el.dataset.czDelete;
      showConfirm('Delete Request', `Request ${id} and its car photo will be permanently deleted.`, async () => {
        try {
          const { ok, j } = await api('POST', `/api/admin/customize/requests/${encodeURIComponent(id)}/delete`);
          if (!ok || !j || !j.ok) throw new Error((j && j.error) || 'Delete failed');
          state.czRequests = (state.czRequests || []).filter(r => r.id !== id);
          delete state.czPhotoCache[id];
          toast('Request deleted', 'success');
          render();
        } catch (e) { toast('Failed: ' + e.message, 'error'); }
      }, 'Delete');
    }));
  }

  function czRefreshList() {
    const host = $('#cz-list-region');
    if (!host) return;
    host.innerHTML = czListRegionHTML();
    bindCzList();
  }

  async function loadCustomizeRequests() {
    state.czLoading = true;
    state.czError = '';
    render();
    try {
      const { ok, j, status } = await api('GET', '/api/admin/customize/requests');
      if (ok && j && Array.isArray(j.requests)) {
        state.czRequests = j.requests;
      } else {
        state.czRequests = [];
        state.czError = (j && (j.hint || j.error)) || ('HTTP ' + status);
      }
    } catch (e) {
      state.czRequests = [];
      state.czError = String((e && e.message) || e);
    }
    state.czLoading = false;
    render();
  }

  // Large, secure view of the private car photo.
  async function showCustomizePhoto(id) {
    showModal(`
      <div class="modal cz-photo-modal">
        <div class="modal-header"><h3>Car photo · ${esc(id)}</h3><button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button></div>
        <div class="modal-body" id="cz-photo-body"><div class="loading-state"><div class="spinner"></div> Opening secure link…</div></div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Close</button></div>
      </div>`);
    const body = $('#cz-photo-body');
    try {
      const p = await czPhoto(id);
      body.innerHTML = `<img class="cz-photo-full" src="${esc(p.url)}" alt="Customer car photo">
        <p class="cz-hint">${p.kind === 'signed'
          ? `Private storage · secure link expires in ${Math.max(1, Math.round((p.expiresIn || 300) / 60))} minute(s).`
          : 'Stored inline on the request row (Supabase Storage is not configured on this server).'}</p>`;
    } catch (e) {
      body.innerHTML = `<div class="empty-state"><div class="empty-icon">🖼</div><h4>Photo unavailable</h4><p>${esc(e.message)}</p></div>`;
    }
  }

  function czDetailRow(label, value) {
    return `<div class="cz-detail-row"><span>${esc(label)}</span><b>${value}</b></div>`;
  }

  function showCustomizeRequestDetail(id) {
    const r = (state.czRequests || []).find(x => x.id === id);
    if (!r) return;
    showModal(`
      <div class="modal cz-detail-modal">
        <div class="modal-header"><h3>Customize request · ${esc(r.id)}</h3><button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button></div>
        <div class="modal-body">
          <div class="cz-detail-grid">
            <div class="cz-detail-photo" id="cz-detail-photo">${r.hasPhoto ? '<div class="cz-thumb-state">Loading photo…</div>' : '<div class="cz-thumb-none">No photo</div>'}</div>
            <div class="cz-detail-fields">
              ${czDetailRow('Submitted', esc(fmtDateTime(r.created_at)))}
              ${czDetailRow('Category', esc(r.category_name_en || r.category_slug || r.category_id || '—'))}
              ${czDetailRow('Car', esc([r.car_brand, r.car_model, r.model_year].filter(Boolean).join(' · ') || '—'))}
              ${r.car_details ? czDetailRow('Car details', esc(r.car_details)) : ''}
              ${czDetailRow('Customer', esc(r.customer_name || '—'))}
              ${czDetailRow('Phone', esc(r.phone || '—'))}
              ${czDetailRow('WhatsApp', r.whatsapp ? `<a href="https://wa.me/${esc(String(r.whatsapp).replace(/\D/g, ''))}" target="_blank" rel="noopener">${esc(r.whatsapp)}</a>` : '—')}
              ${czDetailRow('Email', r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : '—')}
              ${czDetailRow('Preferred contact', esc(r.preferred_contact || 'Phone'))}
              ${r.additional_notes ? czDetailRow('Customer notes', esc(r.additional_notes)) : ''}
            </div>
          </div>
          <div class="cz-detail-block">
            <h4>Customization request</h4>
            <p class="cz-detail-request">${esc(r.customization_request || '')}</p>
          </div>
          <div class="form-group">
            <label>Status</label>
            <select id="cz-detail-status">${CUSTOMIZE_STATUSES.map(s => `<option value="${esc(s)}" ${(r.status || 'New') === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
          </div>
          <div class="form-group">
            <label>Internal notes (admin only)</label>
            <textarea id="cz-detail-notes" rows="4" placeholder="Called the customer, waiting for photos of the interior…">${esc(r.admin_notes || '')}</textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-danger" id="cz-detail-delete">🗑 Delete</button>
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Close</button>
          <button class="btn btn-primary" id="cz-detail-save">Save Changes</button>
        </div>
      </div>`);

    if (r.hasPhoto) {
      czPhoto(id).then(p => {
        const host = $('#cz-detail-photo');
        if (host) host.innerHTML = `<img src="${esc(p.url)}" alt="Customer car photo" data-cz-open-photo="${esc(id)}">`;
      }).catch(() => {
        const host = $('#cz-detail-photo');
        if (host) host.innerHTML = '<div class="cz-thumb-fail">Photo unavailable</div>';
      });
    }

    const saveBtn = $('#cz-detail-save');
    if (saveBtn) saveBtn.addEventListener('click', async () => {
      const status = $('#cz-detail-status').value;
      const notes = $('#cz-detail-notes').value;
      saveBtn.disabled = true;
      try {
        const { ok, j } = await api('POST', `/api/admin/customize/requests/${encodeURIComponent(id)}`, { status, admin_notes: notes });
        if (!ok || !j || !j.ok) throw new Error((j && j.error) || 'Save failed');
        Object.assign(r, { status, admin_notes: notes });
        toast('Request updated', 'success');
        closeAllModals();
        render();
      } catch (e) {
        toast('Failed: ' + e.message, 'error');
        saveBtn.disabled = false;
      }
    });

    const delBtn = $('#cz-detail-delete');
    if (delBtn) delBtn.addEventListener('click', () => {
      showConfirm('Delete Request', `Request ${id} and its car photo will be permanently deleted.`, async () => {
        try {
          const { ok, j } = await api('POST', `/api/admin/customize/requests/${encodeURIComponent(id)}/delete`);
          if (!ok || !j || !j.ok) throw new Error((j && j.error) || 'Delete failed');
          state.czRequests = (state.czRequests || []).filter(x => x.id !== id);
          delete state.czPhotoCache[id];
          toast('Request deleted', 'success');
          closeAllModals();
          render();
        } catch (e) { toast('Failed: ' + e.message, 'error'); }
      }, 'Delete');
    });
  }

  // ========================================================================
  // SETTINGS
  // ========================================================================
  function renderSettings() {
    const s = state.data?.settings || {};
    return `
    <div class="card">
      <div class="card-header"><h3>⚙️ General Settings</h3></div>
      <div class="card-body">
        <div class="form-row">
          <div class="form-group">
            <label>Shop Name</label>
            <input type="text" id="s-name" value="${esc(s.shopName || 'Vilocci')}">
          </div>
          <div class="form-group">
            <label>Tagline</label>
            <input type="text" id="s-tagline" value="${esc(s.tagline || '')}">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Contact Email</label>
            <input type="email" id="s-email" value="${esc(s.contact?.email || '')}">
          </div>
          <div class="form-group">
            <label>Contact Phone</label>
            <input type="text" id="s-phone" value="${esc(s.contact?.phone || '')}">
          </div>
        </div>
        <div class="form-group">
          <label>WhatsApp Number</label>
          <input type="text" id="s-whatsapp" value="${esc(s.contact?.whatsapp || '')}">
        </div>
        <div class="form-group">
          <label>Address</label>
          <textarea id="s-address" rows="2">${esc(s.contact?.address || '')}</textarea>
        </div>
        <h4 style="font-size:14px;font-weight:600;margin:24px 0 16px;padding-top:16px;border-top:1px solid var(--border);">Shipping</h4>
        <div class="form-row">
          <div class="form-group">
            <label>Delivery Fee (EGP)</label>
            <input type="number" id="s-shipping-fee" value="${s.shippingFee || 0}" min="0">
          </div>
          <div class="form-group">
            <label>Free Shipping Threshold (EGP)</label>
            <input type="number" id="s-free-ship" value="${s.freeShippingThreshold || 0}" min="0">
          </div>
        </div>
        <h4 style="font-size:14px;font-weight:600;margin:24px 0 16px;padding-top:16px;border-top:1px solid var(--border);">Social Media</h4>
        <div class="form-row">
          <div class="form-group">
            <label>Facebook</label>
            <input type="url" id="s-facebook" value="${esc(s.social?.facebook || '')}" placeholder="https://facebook.com/...">
          </div>
          <div class="form-group">
            <label>Instagram</label>
            <input type="url" id="s-instagram" value="${esc(s.social?.instagram || '')}" placeholder="https://instagram.com/...">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>TikTok</label>
            <input type="url" id="s-tiktok" value="${esc(s.social?.tiktok || '')}" placeholder="https://tiktok.com/...">
          </div>
          <div class="form-group">
            <label>Twitter/X</label>
            <input type="url" id="s-twitter" value="${esc(s.social?.twitter || '')}" placeholder="https://x.com/...">
          </div>
        </div>
        <h4 style="font-size:14px;font-weight:600;margin:24px 0 16px;padding-top:16px;border-top:1px solid var(--border);">Payment Settings</h4>
        <div class="form-group" style="margin-bottom:14px;">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:500;">
            <input type="checkbox" id="s-instapay-enabled" ${s.instapay?.enabled ? 'checked' : ''}>
            <span>Enable InstaPay Payment</span>
          </label>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">When enabled, customers can choose to pay via your InstaPay link at checkout.</div>
        </div>
        <div class="form-group">
          <label>InstaPay Payment Link (URL)</label>
          <input type="url" id="s-instapay-url" value="${esc(s.instapay?.url || '')}" placeholder="https://ipn.eg/... or payment link">
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Direct payment link opened when customer chooses InstaPay.</div>
        </div>
        <button class="btn btn-primary" id="btn-save-settings" style="margin-top:16px;">💾 Save Settings</button>
      </div>
    </div>`;
  }

  // ========================================================================
  // EVENT BINDING
  // ========================================================================
  function bindLogin() {
    const form = $('#login-form');
    if (form) {
      // Clear error when user starts typing
      form.querySelectorAll('input').forEach(input => {
        input.addEventListener('input', () => {
          state.loginError = '';
          const errEl = $('#login-err');
          if (errEl) errEl.textContent = '';
        });
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const email = form.querySelector('[name=email]').value.trim();
        const password = form.querySelector('[name=password]').value;
        if (!email || !password) {
          state.loginError = 'Please enter your email and password.';
          state.view = 'login';
          render();
          return;
        }
        doLogin(email, password);
      });
    }
  }

  function bindGlobal() {
    // Sidebar nav
    $$('[data-nav]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        navigate(el.dataset.nav);
      });
    });

    // Sidebar logout
    const logoutBtn = $('#sidebar-logout');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', (e) => {
        e.preventDefault();
        doLogout();
      });
    }

    // Mobile menu
    const menuBtn = $('#menu-toggle');
    const overlay = $('#sidebar-overlay');
    if (menuBtn) {
      menuBtn.addEventListener('click', () => {
        state.sidebarOpen = !state.sidebarOpen;
        const sb = $('#sidebar');
        if (sb) sb.classList.toggle('open', state.sidebarOpen);
        if (overlay) overlay.classList.toggle('show', state.sidebarOpen);
      });
    }
    if (overlay) {
      overlay.addEventListener('click', () => {
        state.sidebarOpen = false;
        const sb = $('#sidebar');
        if (sb) sb.classList.remove('open');
        overlay.classList.remove('show');
      });
    }
  }

  function bindPage() {
    switch (state.view) {
      case 'dashboard': bindDashboard(); break;
      case 'products': bindProducts(); break;
      case 'categories': bindCategories(); break;
      case 'brands': bindBrands(); break;
      case 'shapes': bindShapes(); break;
      case 'orders': bindOrders(); break;
      case 'customers': bindCustomers(); break;
      case 'inventory': bindInventory(); break;
      case 'discounts': bindDiscounts(); break;
      case 'packages': bindPackages(); break;
      case 'content': bindContent(); break;
      case 'images': bindImages(); break;
      case 'messages': bindMessages(); break;
      case 'customize-settings': bindCustomizeSettings(); break;
      case 'customize-requests': bindCustomizeRequests(); break;
      case 'settings': bindSettings(); break;
    }
  }

  function bindDashboard() {}

  function bindProducts() {
    const search = $('#product-search');
    if (search) search.addEventListener('input', (e) => { state.productSearch = e.target.value; render(); });

    const brandFilter = $('#product-brand-filter');
    if (brandFilter) brandFilter.addEventListener('change', (e) => { state.productBrandFilter = e.target.value; render(); });

    const catFilter = $('#product-cat-filter');
    if (catFilter) catFilter.addEventListener('change', (e) => { state.productCatFilter = e.target.value; render(); });

    const addBtn = $('#btn-add-product');
    if (addBtn) addBtn.addEventListener('click', () => showProductEditor(null));

    $$('[data-edit-product]').forEach(el => el.addEventListener('click', () => showProductEditor(el.dataset.editProduct)));

    $$('[data-toggle-product]').forEach(el => el.addEventListener('click', async () => {
      const id = el.dataset.toggleProduct;
      const p = state.data.products.find(x => x.id === id);
      if (!p) return;
      try {
        await sbUpdate('products', id, { active: !p.active });
        p.active = !p.active;
        toast(p.active ? 'Product activated' : 'Product deactivated', 'success');
        render();
      } catch (e) { toast('Failed to update', 'error'); }
    }));

    $$('[data-delete-product]').forEach(el => el.addEventListener('click', () => {
      const id = el.dataset.deleteProduct;
      const p = state.data.products.find(x => x.id === id);
      showConfirm('Delete Product', `Are you sure you want to delete "${p?.name_en || id}"? This cannot be undone.`, async () => {
        try {
          await sbDelete('products', id);
          state.data.products = state.data.products.filter(x => x.id !== id);
          toast('Product deleted', 'success');
          render();
        } catch (e) { toast('Failed to delete', 'error'); }
      });
    }));
  }

  // ------------------------------------------------------------------------
  // PRODUCT EDITOR — details, prices and images
  // ------------------------------------------------------------------------
  function showProductEditor(id) {
    const p = id ? state.data.products.find(x => x.id === id) : null;
    const brands = state.data.brands || [];
    const categories = (state.data.categories || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    // products.category stores the category ID ('keycase'), not the slug
    // ('keycases') — the option values must be the ids or the current category
    // would never preselect and saving would move the product.
    const fallbackCats = [...new Set((state.data.products || []).map(x => x.category).filter(Boolean))];
    const catList = categories.length ? categories : fallbackCats.map(id => ({ id, name_en: id }));
    const libraryImages = state.data.website_images || [];

    // Options for the "+ Add shape" select. The MASTER list comes from the
    // Shapes screen (Admin → Shapes); a legacy dataset without a catalogue
    // falls back to the four standard codes so the editor keeps working.
    const catalogShapes = ((state.data && state.data.shapes) || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const shapeAddOptions = catalogShapes.length
      ? catalogShapes.map(sh => ({ code: sh.code, label: sh.name_en || ('Shape ' + sh.code) }))
      : ['A', 'B', 'C', 'D'].map(code => ({ code, label: 'Shape ' + code }));

    // Working copy of the gallery so edits can be cancelled.
    let images = (p?.images && p.images.length ? p.images.slice() : (p?.main_image ? [p.main_image] : []));

    showModal(`
      <div class="modal" style="max-width:780px;">
        <div class="modal-header">
          <h3>${p ? 'Edit Product' : 'Add Product'}</h3>
          <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
        </div>
        <div class="modal-body">
          <form id="product-form">
            <div class="editor-section-title">Basics</div>
            <div class="form-row">
              <div class="form-group">
                <label>Product Name (EN) *</label>
                <input name="name_en" value="${esc(p?.name_en || '')}" required>
              </div>
              <div class="form-group">
                <label>Product Name (AR)</label>
                <input name="name_ar" value="${esc(p?.name_ar || '')}" dir="rtl">
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Slug</label>
                <input name="slug" value="${esc(p?.slug || '')}">
              </div>
              <div class="form-group">
                <label>Category *</label>
                <select name="category" required>
                  <option value="">Select category</option>
                  ${catList.map(c => `<option value="${esc(c.id)}" ${p?.category === c.id ? 'selected' : ''}>${esc(c.name_en || c.id)}</option>`).join('')}
                  ${p?.category && !catList.some(c => c.id === p.category) ? `<option value="${esc(p.category)}" selected>${esc(p.category)}</option>` : ''}
                </select>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Brand *</label>
                <select name="brandSlug" required>
                  <option value="">Select brand</option>
                  ${brands.map(b => `<option value="${esc(b.slug)}" ${p?.brandSlug === b.slug ? 'selected' : ''}>${esc(b.name_en)}</option>`).join('')}
                </select>
              </div>
              <div class="form-group">
                <label>SKU</label>
                <input name="sku" value="${esc(p?.sku || '')}">
              </div>
            </div>

            <div class="editor-section-title">Details</div>
            <div class="form-row">
              <div class="form-group">
                <label>Short description (EN)</label>
                <input name="short_en" value="${esc(p?.short_en || '')}">
              </div>
              <div class="form-group">
                <label>Short description (AR)</label>
                <input name="short_ar" value="${esc(p?.short_ar || '')}" dir="rtl">
              </div>
            </div>
            <div class="form-group">
              <label>Description (EN)</label>
              <textarea name="description_en" rows="3">${esc(p?.description_en || '')}</textarea>
            </div>
            <div class="form-group">
              <label>Description (AR)</label>
              <textarea name="description_ar" rows="3" dir="rtl">${esc(p?.description_ar || '')}</textarea>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Material (EN)</label>
                <input name="material_en" value="${esc(p?.material_en || '')}">
              </div>
              <div class="form-group">
                <label>Material (AR)</label>
                <input name="material_ar" value="${esc(p?.material_ar || '')}" dir="rtl">
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Warranty (EN)</label>
                <input name="warranty_en" value="${esc(p?.warranty_en || '')}">
              </div>
              <div class="form-group">
                <label>Badge (EN)</label>
                <input name="badge_en" value="${esc(p?.badge_en || '')}" placeholder="Limited Edition">
              </div>
            </div>

            <div class="editor-section-title">Pricing</div>
            <div class="form-row">
              <div class="form-group">
                <label>Price (EGP) *</label>
                <input name="price" id="pf-price" type="number" step="1" value="${p?.price || 0}" min="0" required>
              </div>
              <div class="form-group">
                <label>Old price (EGP)</label>
                <input name="oldPrice" id="pf-oldprice" type="number" step="1" value="${p?.oldPrice || ''}" min="0">
              </div>
              <div class="form-group">
                <label>Discount %</label>
                <input name="discount" id="pf-discount" type="number" step="1" value="${p?.discount || 0}" min="0" max="100">
              </div>
            </div>
            <p style="font-size:11px;color:var(--text-muted);margin:-6px 0 12px;">The discount % is recalculated automatically when you change the price or the old price.</p>

            <div class="editor-section-title">Images</div>
            <div class="form-group">
              <div id="product-images-list"></div>
              <div style="display:flex;gap:8px;margin-top:8px;">
                <input id="pf-new-image" placeholder="/img/asset.svg?... or https://..." style="flex:1;">
                <button type="button" class="btn btn-secondary btn-sm" id="btn-add-image">+ Add image</button>
              </div>
              ${libraryImages.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
                ${libraryImages.slice(0, 12).map(img => `<img src="${esc(img.url)}" data-lib-pick="${esc(img.url)}" title="${esc(img.name || '')}" style="width:52px;height:40px;object-fit:cover;border-radius:6px;cursor:pointer;border:1px solid var(--border);">`).join('')}
              </div>` : ''}
            </div>

            <div class="editor-section-title">Colors</div>
            <div class="form-group">
              <p style="font-size:11px;color:var(--text-muted);margin:-2px 0 10px;">This product's own color variants. The storefront shows exactly this list (enabled colors only, in this order) — add, edit, reorder, enable/disable or delete freely.</p>
              <div id="product-colors-list"></div>
              <button type="button" class="btn btn-secondary btn-sm" id="btn-add-color">+ Add color</button>
            </div>

            <div class="editor-section-title">Key shapes</div>
            <div class="form-group">
              <p style="font-size:11px;color:var(--text-muted);margin:-2px 0 10px;">Key shapes available for this product. Customers can only select shapes marked in stock; shapes hidden in Admin → Shapes are unavailable store-wide. Each row also edits the shape's store-wide details (EN/AR names + shape image, saved on the shape itself — the storefront shows the uploaded image on every selector).</p>
              <div id="product-shapes-list"></div>
              <div style="display:flex;gap:8px;margin-top:8px;align-items:center;">
                <select id="pf-new-shape" style="width:130px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;">
                  ${shapeAddOptions.map(o => `<option value="${esc(o.code)}">${esc(o.label)}</option>`).join('')}
                </select>
                <button type="button" class="btn btn-secondary btn-sm" id="btn-add-shape">+ Add shape</button>
              </div>
            </div>

            <div class="editor-section-title">Stock &amp; visibility</div>
            <div class="form-row">
              <div class="form-group">
                <label>Stock</label>
                <input name="inventory" type="number" value="${p?.inventory != null ? p.inventory : (p?.stock || 0)}" min="0">
              </div>
              <div class="form-group" style="display:flex;align-items:flex-end;gap:16px;">
                <label class="toggle" style="margin-bottom:0;">
                  <input type="checkbox" name="active" ${p?.active !== false ? 'checked' : ''}>
                  <span class="toggle-slider"></span>
                </label>
                <span style="font-size:13px;color:var(--text-secondary);">Active</span>
              </div>
            </div>
            <div style="display:flex;gap:12px;flex-wrap:wrap;">
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;"><input type="checkbox" name="featured" ${p?.featured ? 'checked' : ''}> Featured</label>
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;"><input type="checkbox" name="bestSeller" ${p?.bestSeller ? 'checked' : ''}> Best seller</label>
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;"><input type="checkbox" name="newArrival" ${p?.newArrival ? 'checked' : ''}> New arrival</label>
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;"><input type="checkbox" name="limitedEdition" ${p?.limitedEdition ? 'checked' : ''}> Limited edition</label>
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;"><input type="checkbox" name="heroProduct" ${p?.heroProduct ? 'checked' : ''}> Hero product</label>
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;"><input type="checkbox" name="preorder" ${p?.preorder ? 'checked' : ''}> Pre-order</label>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button class="btn btn-primary" id="btn-save-product">${p ? 'Update' : 'Create'} Product</button>
          <button id="ed-save" style="display:none;" type="button" aria-hidden="true"></button>
        </div>
      </div>`);

    // ---- image list (first image is the main one) ----
    const listEl = $('#product-images-list');
    function renderImageList() {
      if (!listEl) return;
      listEl.innerHTML = images.length ? images.map((url, i) => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px;background:var(--bg);border-radius:8px;margin-bottom:6px;">
          <img src="${esc(url)}" alt="" style="width:48px;height:40px;object-fit:cover;border-radius:6px;background:var(--cream);">
          <div style="flex:1;min-width:0;">
            <div style="font-size:11px;font-weight:600;color:var(--text-muted);">${i === 0 ? 'MAIN IMAGE' : 'Image ' + (i + 1)}</div>
            <div style="font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(url)}</div>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" data-img-up="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="btn btn-ghost btn-sm" data-img-down="${i}" title="Move down" ${i === images.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="btn btn-ghost btn-sm" data-img-del="${i}" title="Remove">🗑</button>
        </div>`).join('')
        : '<p style="font-size:12px;color:var(--text-muted);">No images yet — the storefront falls back to the generated artwork.</p>';

      $$('[data-img-del]', listEl).forEach(b => b.addEventListener('click', () => { images.splice(Number(b.dataset.imgDel), 1); renderImageList(); }));
      $$('[data-img-up]', listEl).forEach(b => b.addEventListener('click', () => {
        const i = Number(b.dataset.imgUp); if (i > 0) { [images[i - 1], images[i]] = [images[i], images[i - 1]]; renderImageList(); }
      }));
      $$('[data-img-down]', listEl).forEach(b => b.addEventListener('click', () => {
        const i = Number(b.dataset.imgDown); if (i < images.length - 1) { [images[i + 1], images[i]] = [images[i], images[i + 1]]; renderImageList(); }
      }));
    }
    renderImageList();

    const addImage = (url) => {
      const clean = String(url || '').trim();
      if (!clean) return;
      if (images.includes(clean)) { toast('That image is already in the gallery', 'error'); return; }
      images.push(clean);
      renderImageList();
    };
    $('#btn-add-image').addEventListener('click', () => { const i = $('#pf-new-image'); addImage(i.value); i.value = ''; });
    $$('[data-lib-pick]').forEach(el => el.addEventListener('click', () => addImage(el.dataset.libPick)));

    // ---- color variants (per-product list: add / edit / reorder / enable / delete) ----
    // Working copy — nothing is persisted until Save. The preview circle is
    // rendered live from the HEX field, exactly like the storefront swatches.
    let colors = Array.isArray(p?.colors) ? p.colors.map(c => Object.assign({}, c)) : [];

    const normalizeHex = (raw) => {
      let s = String(raw || '').trim().replace(/^#/, '');
      if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.split('').map(ch => ch + ch).join('');
      return /^[0-9a-fA-F]{6}$/.test(s) ? ('#' + s.toUpperCase()) : '';
    };

    const colorListEl = $('#product-colors-list');
    function renderColorList() {
      if (!colorListEl) return;
      colorListEl.innerHTML = colors.length ? colors.map((c, i) => {
        const hex = normalizeHex(c.hex);
        const enabled = c.enabled !== false;
        return `
        <div class="pcolor-row${enabled ? '' : ' pcolor-off'}">
          <span class="pcolor-swatch" data-csw="${i}" style="background:${hex || 'transparent'};${hex ? '' : 'border:1px dashed var(--border);'}" title="${esc(hex || 'no HEX')}"></span>
          <input class="pcolor-hex-text" data-chex="${i}" value="${esc(c.hex || '')}" maxlength="7" placeholder="#HEX" spellcheck="false">
          <input class="pcolor-hex-picker" type="color" data-cpick="${i}" value="${hex || '#000000'}" title="Pick color">
          <input class="pcolor-name" data-cname="${i}" value="${esc(c.name_en || '')}" placeholder="Color name (EN)" maxlength="60">
          <input class="pcolor-name" data-cnamear="${i}" value="${esc(c.name_ar || '')}" placeholder="اسم اللون (عربي)" dir="rtl" maxlength="60">
          <label class="toggle pcolor-toggle" title="${enabled ? 'Enabled — visible on the storefront' : 'Disabled — hidden on the storefront'}">
            <input type="checkbox" data-cenable="${i}" ${enabled ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
          <button type="button" class="btn btn-ghost btn-sm" data-cup="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="btn btn-ghost btn-sm" data-cdown="${i}" title="Move down" ${i === colors.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="btn btn-ghost btn-sm" data-cdel="${i}" title="Delete color">🗑</button>
        </div>`;
      }).join('')
      : '<p style="font-size:12px;color:var(--text-muted);margin:0 0 8px;">No colors yet — the storefront will not show a color selector for this product until you add one.</p>';

      // live HEX editing: text field + native picker stay in sync and the
      // preview circle updates immediately from the HEX value.
      $$('[data-chex]', colorListEl).forEach(inp => inp.addEventListener('input', () => {
        const i = Number(inp.dataset.chex);
        colors[i].hex = inp.value;
        const hex = normalizeHex(inp.value);
        const sw = colorListEl.querySelector(`[data-csw="${i}"]`);
        if (sw) { sw.style.background = hex || 'transparent'; sw.style.border = hex ? '' : '1px dashed var(--border)'; sw.title = hex || 'no HEX'; }
        const pick = colorListEl.querySelector(`[data-cpick="${i}"]`);
        if (pick && hex) pick.value = hex;
      }));
      $$('[data-cpick]', colorListEl).forEach(inp => inp.addEventListener('input', () => {
        const i = Number(inp.dataset.cpick);
        colors[i].hex = inp.value.toUpperCase();
        const txt = colorListEl.querySelector(`[data-chex="${i}"]`);
        if (txt) txt.value = colors[i].hex;
        const sw = colorListEl.querySelector(`[data-csw="${i}"]`);
        if (sw) { sw.style.background = colors[i].hex; sw.style.border = ''; sw.title = colors[i].hex; }
      }));
      $$('[data-cname]', colorListEl).forEach(inp => inp.addEventListener('input', () => { colors[Number(inp.dataset.cname)].name_en = inp.value; }));
      $$('[data-cnamear]', colorListEl).forEach(inp => inp.addEventListener('input', () => { colors[Number(inp.dataset.cnamear)].name_ar = inp.value; }));
      $$('[data-cenable]', colorListEl).forEach(inp => inp.addEventListener('change', () => {
        colors[Number(inp.dataset.cenable)].enabled = inp.checked;
        renderColorList();
      }));
      $$('[data-cup]', colorListEl).forEach(b => b.addEventListener('click', () => {
        const i = Number(b.dataset.cup); if (i > 0) { [colors[i - 1], colors[i]] = [colors[i], colors[i - 1]]; renderColorList(); }
      }));
      $$('[data-cdown]', colorListEl).forEach(b => b.addEventListener('click', () => {
        const i = Number(b.dataset.cdown); if (i < colors.length - 1) { [colors[i + 1], colors[i]] = [colors[i], colors[i + 1]]; renderColorList(); }
      }));
      $$('[data-cdel]', colorListEl).forEach(b => b.addEventListener('click', () => {
        const i = Number(b.dataset.cdel);
        const c = colors[i];
        showConfirm('Delete Color', `Remove "${c.name_en || c.hex || 'this color'}" from ${p ? '"' + (p.name_en || 'this product') + '"' : 'the new product'}? Existing orders keep their chosen color.`, () => {
          colors.splice(i, 1); renderColorList();
        });
      }));
    }
    renderColorList();

    $('#btn-add-color').addEventListener('click', () => {
      colors.push({ id: '', name_en: '', name_ar: '', hex: '#000000', enabled: true });
      renderColorList();
      const inputs = colorListEl.querySelectorAll('[data-cname]');
      const last = inputs[inputs.length - 1];
      if (last) last.focus();
    });

    // ---- key shapes (per-product list: add / toggle availability / reorder / delete) ----
    const defaultShapes = [
      { shape: 'A', available: true },
      { shape: 'B', available: true },
      { shape: 'C', available: true },
      { shape: 'D', available: false },
    ];
    let shapes = (Array.isArray(p?.keyShapes) && p.keyShapes.length)
      ? p.keyShapes.map(s => ({ shape: String(s.shape || s).toUpperCase(), available: s.available !== false }))
      : defaultShapes.map(s => Object.assign({}, s));

    const shapeListEl = $('#product-shapes-list');
    // Each row manages TWO things: the product's OWN availability flag for the
    // shape (saved with the product, as before) and — new — the shape's
    // store-wide details from the catalogue (Admin → Shapes): the EN/AR names
    // and the shape image. Those persist immediately on the catalogue shape,
    // because they are properties of the shape itself, not of this product.
    function renderShapeList() {
      if (!shapeListEl) return;
      shapeListEl.innerHTML = shapes.length ? shapes.map((s, i) => {
        const available = s.available !== false;
        const cat = shapeByCode(s.shape);
        const details = cat ? `
          <div class="pshape-names">
            <input class="pshape-name" data-shname-en="${i}" value="${esc(cat.name_en || '')}" placeholder="Name (EN)" maxlength="60" title="Shape name (EN) — stored on the shape itself, shown store-wide">
            <input class="pshape-name" data-shname-ar="${i}" value="${esc(cat.name_ar || '')}" dir="rtl" placeholder="اسم الشكل (عربي)" maxlength="60" title="Shape name (AR) — stored on the shape itself, shown store-wide">
          </div>
          <div class="pshape-imgcell">
            ${shapeThumbHTML(cat, 44)}
            <div style="display:flex;flex-direction:column;gap:2px;">
              <button type="button" class="btn btn-ghost btn-sm" data-shimg-up="${i}" title="${cat.image_url ? 'Replace the shape image' : 'Upload a shape image'}">${cat.image_url ? '🔁' : '📤'}</button>
              ${cat.image_url ? `<button type="button" class="btn btn-ghost btn-sm" data-shimg-rm="${i}" title="Remove the shape image">✕</button>` : ''}
            </div>
            <input type="file" accept="image/jpeg,image/png,image/webp,image/avif" data-shimg-file="${i}" style="display:none;">
          </div>`
        : `<span class="pshape-custom-note" style="font-size:11px;color:var(--text-muted);max-width:280px;">Product-local custom shape — add it to the catalogue in Admin → Shapes to manage its names and image.</span>`;
        return `
        <div class="pshape-row${available ? '' : ' pshape-off'}">
          <span class="pshape-badge${available ? '' : ' off'}">${esc(s.shape)}</span>
          ${details}
          <input type="hidden" name="shape_${esc(s.shape)}" value="${esc(s.shape)}">
          <label class="toggle pshape-toggle" title="${available ? 'In stock — selectable on the storefront' : 'Out of stock — disabled on the storefront'}">
            <input type="checkbox" name="shapeok_${esc(s.shape)}" data-shapeok="${i}" ${available ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
          <span class="stat-hint pshape-status ${available ? 'in-stock' : 'out-of-stock'}" data-stocklbl="${esc(s.shape)}" style="${available ? 'color:var(--success);' : 'color:var(--danger);'} font-weight:600;font-size:12px;min-width:85px;">${available ? 'In stock' : 'Out of stock'}</span>
          <button type="button" class="btn btn-ghost btn-sm" data-shape-up="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="btn btn-ghost btn-sm" data-shape-down="${i}" title="Move down" ${i === shapes.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="btn btn-ghost btn-sm" data-shape-del="${i}" title="Delete shape">🗑</button>
        </div>`;
      }).join('')
      : '<p style="font-size:12px;color:var(--text-muted);margin:0 0 8px;">No shapes configured — customers will see this product as out of stock.</p>';

      // ---- catalogue details: EN/AR names persist on the shape itself ----
      const saveShapeName = async (i, field, input) => {
        const cat = shapeByCode(shapes[i].shape);
        if (!cat) return;
        const value = input.value.trim();
        if (value === String(cat[field] || '')) return;
        try {
          await sbUpdate('shapes', cat.id, { [field]: value });
          cat[field] = value;
          toast(`Shape ${cat.code} name updated store-wide`, 'success');
        } catch (e) { toast('Failed to save the shape name: ' + e.message, 'error'); }
      };
      $$('[data-shname-en]', shapeListEl).forEach(inp => inp.addEventListener('change', () => saveShapeName(Number(inp.dataset.shnameEn), 'name_en', inp)));
      $$('[data-shname-ar]', shapeListEl).forEach(inp => inp.addEventListener('change', () => saveShapeName(Number(inp.dataset.shnameAr), 'name_ar', inp)));

      // ---- catalogue image: upload / replace / remove ----
      $$('[data-shimg-up]', shapeListEl).forEach(b => b.addEventListener('click', () => {
        const fileInput = shapeListEl.querySelector(`[data-shimg-file="${b.dataset.shimgUp}"]`);
        if (fileInput) fileInput.click();
      }));
      $$('[data-shimg-file]', shapeListEl).forEach(inp => inp.addEventListener('change', async () => {
        const i = Number(inp.dataset.shimgFile);
        const file = inp.files && inp.files[0];
        const cat = shapes[i] && shapeByCode(shapes[i].shape);
        if (!file || !cat) return;
        try {
          await setShapeImageFromFile(cat.id, file);
          toast(`Shape ${cat.code} image updated — the storefront now shows it on every selector`, 'success');
          renderShapeList();
        } catch (e) { toast('Upload failed: ' + e.message, 'error'); }
        inp.value = '';
      }));
      $$('[data-shimg-rm]', shapeListEl).forEach(b => b.addEventListener('click', () => {
        const i = Number(b.dataset.shimgRm);
        const cat = shapes[i] && shapeByCode(shapes[i].shape);
        if (!cat) return;
        showConfirm('Remove Shape Image', `Remove the image of Shape ${cat.code}? The storefront falls back to the generated silhouette.`, async () => {
          try {
            await clearShapeImage(cat.id);
            toast(`Shape ${cat.code} image removed`, 'success');
            renderShapeList();
          } catch (e) { toast('Failed: ' + e.message, 'error'); }
        });
      }));

      // ---- per-product availability (saved with the product, unchanged) ----
      $$('[data-shapeok]', shapeListEl).forEach(inp => inp.addEventListener('change', () => {
        const i = Number(inp.dataset.shapeok);
        shapes[i].available = inp.checked;
        renderShapeList();
      }));
      $$('[data-shape-up]', shapeListEl).forEach(b => b.addEventListener('click', () => {
        const i = Number(b.dataset.shapeUp);
        if (i > 0) { [shapes[i - 1], shapes[i]] = [shapes[i], shapes[i - 1]]; renderShapeList(); }
      }));
      $$('[data-shape-down]', shapeListEl).forEach(b => b.addEventListener('click', () => {
        const i = Number(b.dataset.shapeDown);
        if (i < shapes.length - 1) { [shapes[i + 1], shapes[i]] = [shapes[i], shapes[i + 1]]; renderShapeList(); }
      }));
      $$('[data-shape-del]', shapeListEl).forEach(b => b.addEventListener('click', () => {
        const i = Number(b.dataset.shapeDel);
        const sh = shapes[i];
        showConfirm('Remove Key Shape', `Remove Shape ${sh.shape} from ${p ? '"' + (p.name_en || 'this product') + '"' : 'the new product'}?`, () => {
          shapes.splice(i, 1);
          renderShapeList();
        });
      }));
    }
    renderShapeList();

    $('#btn-add-shape').addEventListener('click', () => {
      const select = $('#pf-new-shape');
      const chosen = (select && select.value) ? select.value.toUpperCase().trim() : '';
      if (!chosen) return;
      if (shapes.some(s => s.shape === chosen)) {
        toast('Shape ' + chosen + ' is already configured for this product', 'error');
        return;
      }
      shapes.push({ shape: chosen, available: true });
      renderShapeList();
    });

    const edSaveBtn = $('#ed-save');
    if (edSaveBtn) edSaveBtn.addEventListener('click', () => $('#btn-save-product')?.click());

    // ---- discount auto-calculation ----
    const priceEl = $('#pf-price');
    const oldEl = $('#pf-oldprice');
    const discEl = $('#pf-discount');
    function recalcDiscount() {
      const price = parseFloat(priceEl.value) || 0;
      const old = parseFloat(oldEl.value) || 0;
      if (old > price && price > 0) discEl.value = Math.round(((old - price) / old) * 100);
    }
    priceEl.addEventListener('input', recalcDiscount);
    oldEl.addEventListener('input', recalcDiscount);

    $('#btn-save-product').addEventListener('click', async () => {
      const form = $('#product-form');
      const val = (n) => form.querySelector(`[name=${n}]`).value.trim();
      const numVal = (n) => parseFloat(form.querySelector(`[name=${n}]`).value);
      const checked = (n) => form.querySelector(`[name=${n}]`).checked;

      const nameEn = val('name_en');
      const category = val('category');
      const brandSlug = val('brandSlug');
      if (!nameEn || !category || !brandSlug) { toast('Please fill the required fields', 'error'); return; }

      // ---- validate + normalize the color list (EN/AR names + HEX) ----
      const finalColors = [];
      for (let i = 0; i < colors.length; i += 1) {
        const c = colors[i] || {};
        const hex = (String(c.hex || '').trim().replace(/^#/, ''));
        const clean = /^[0-9a-fA-F]{3}$/.test(hex)
          ? '#' + hex.split('').map(ch => ch + ch).join('').toUpperCase()
          : /^[0-9a-fA-F]{6}$/.test(hex) ? '#' + hex.toUpperCase() : '';
        const nameEn = String(c.name_en || '').trim();
        const nameAr = String(c.name_ar || '').trim();
        if (!clean) { toast(`Color #${i + 1}: enter a valid HEX value (e.g. #C8A15A)`, 'error'); return; }
        if (!nameEn && !nameAr) { toast(`Color #${i + 1}: enter a name (English or Arabic)`, 'error'); return; }
        finalColors.push({
          id: c.id || uid('color'),
          name_en: nameEn, name_ar: nameAr, hex: clean,
          enabled: c.enabled !== false,
        });
      }

      // ---- validate + collect shapes list ----
      shapes.forEach((s) => {
        const chk = form.querySelector(`[name="shapeok_${s.shape}"]`);
        if (chk) s.available = chk.checked;
      });
      const finalShapes = shapes.map(s => ({
        shape: s.shape,
        available: !!s.available,
      }));

      const price = numVal('price') || 0;
      const oldPrice = numVal('oldPrice') || null;
      const data = {
        id: p?.id || ('prod_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
        name_en: nameEn,
        name_ar: val('name_ar'),
        slug: val('slug') || nameEn.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        category,
        brandSlug,
        sku: val('sku'),
        short_en: val('short_en'),
        short_ar: val('short_ar'),
        description_en: val('description_en'),
        description_ar: val('description_ar'),
        material_en: val('material_en'),
        material_ar: val('material_ar'),
        warranty_en: val('warranty_en'),
        badge_en: val('badge_en'),
        price,
        oldPrice,
        discount: numVal('discount') || 0,
        inventory: parseInt(form.querySelector('[name=inventory]').value, 10) || 0,
        images,
        main_image: images[0] || '',
        colors: finalColors,
        keyShapes: finalShapes,
        active: checked('active'),
        featured: checked('featured'),
        bestSeller: checked('bestSeller'),
        newArrival: checked('newArrival'),
        limitedEdition: checked('limitedEdition'),
        heroProduct: checked('heroProduct'),
        preorder: checked('preorder'),
        // preserved untouched: fitment, models/years, specs, order
        models: p?.models || [],
        years: p?.years || [],
        specs: p?.specs || [],
        vehicles: p?.vehicles || [],
        order: p?.order || 0,
      };

      try {
        await sbUpsert('products', data);
        const idx = state.data.products.findIndex(x => x.id === data.id);
        if (idx >= 0) state.data.products[idx] = data;
        else state.data.products.push(data);
        toast(p ? 'Product updated' : 'Product created', 'success');
        closeAllModals();
        render();
      } catch (e) {
        toast('Failed to save: ' + e.message, 'error');
      }
    });
  }

  // ------------------------------------------------------------------------
  // CATEGORY EDITOR — name, image, description, order
  // ------------------------------------------------------------------------
  function showCategoryEditor(id) {
    const c = id ? (state.data.categories || []).find(x => x.id === id) : null;
    const libraryImages = state.data.website_images || [];

    showModal(`
      <div class="modal" style="max-width:640px;">
        <div class="modal-header">
          <h3>${c ? 'Edit Category' : 'Add Category'}</h3>
          <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
        </div>
        <div class="modal-body">
          <form id="cat-form">
            <div class="form-row">
              <div class="form-group">
                <label>Name (EN) *</label>
                <input name="name_en" value="${esc(c?.name_en || '')}" required>
              </div>
              <div class="form-group">
                <label>Name (AR)</label>
                <input name="name_ar" value="${esc(c?.name_ar || '')}" dir="rtl">
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Slug *</label>
                <input name="slug" value="${esc(c?.slug || '')}" placeholder="keycases" required>
              </div>
              <div class="form-group">
                <label>Order</label>
                <input name="order" type="number" step="0.25" value="${c?.order || 0}">
              </div>
            </div>
            <div class="form-group">
              <label>Image URL</label>
              <input name="image" id="cat-image-input" value="${esc(c?.image || '')}" placeholder="/img/asset.svg?... or https://...">
              ${libraryImages.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
                ${libraryImages.slice(0, 12).map(img => `<img src="${esc(img.url)}" data-cat-pick="${esc(img.url)}" title="${esc(img.name || '')}" style="width:52px;height:40px;object-fit:cover;border-radius:6px;cursor:pointer;border:1px solid var(--border);">`).join('')}
              </div>` : ''}
              <div style="margin-top:8px;">${c?.image ? `<img id="cat-image-preview" src="${esc(c.image)}" style="max-height:90px;border-radius:8px;background:var(--cream);">` : '<img id="cat-image-preview" style="display:none;max-height:90px;border-radius:8px;background:var(--cream);">'}</div>
            </div>
            <div class="form-group">
              <label>Description (EN)</label>
              <textarea name="description_en" rows="3">${esc(c?.description_en || '')}</textarea>
            </div>
            <div class="form-group">
              <label>Description (AR)</label>
              <textarea name="description_ar" rows="3" dir="rtl">${esc(c?.description_ar || '')}</textarea>
            </div>
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;">
              <input type="checkbox" name="active" ${c?.active !== false ? 'checked' : ''}> Visible on the storefront
            </label>
          </form>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button class="btn btn-primary" id="btn-save-cat">${c ? 'Update' : 'Create'} Category</button>
        </div>
      </div>`);

    const input = $('#cat-image-input');
    const preview = $('#cat-image-preview');
    const syncPreview = () => {
      if (!preview) return;
      if (input.value.trim()) { preview.src = input.value.trim(); preview.style.display = ''; }
      else preview.style.display = 'none';
    };
    if (input) input.addEventListener('input', syncPreview);
    $$('[data-cat-pick]').forEach(el => el.addEventListener('click', () => { input.value = el.dataset.catPick; syncPreview(); }));

    $('#btn-save-cat').addEventListener('click', async () => {
      const form = $('#cat-form');
      const nameEn = form.querySelector('[name=name_en]').value.trim();
      const slug = form.querySelector('[name=slug]').value.trim().toLowerCase().replace(/\s+/g, '-');
      if (!nameEn || !slug) { toast('Name and slug are required', 'error'); return; }
      const data = {
        id: c?.id || slug,
        name_en: nameEn,
        name_ar: form.querySelector('[name=name_ar]').value.trim(),
        slug,
        image: form.querySelector('[name=image]').value.trim(),
        description_en: form.querySelector('[name=description_en]').value.trim(),
        description_ar: form.querySelector('[name=description_ar]').value.trim(),
        order: parseFloat(form.querySelector('[name=order]').value) || 0,
        active: form.querySelector('[name=active]').checked,
        product_count: c?.product_count || 0,
      };
      try {
        await sbUpsert('categories', data);
        if (!state.data.categories) state.data.categories = [];
        const idx = state.data.categories.findIndex(x => x.id === data.id);
        if (idx >= 0) state.data.categories[idx] = data; else state.data.categories.push(data);
        toast(c ? 'Category updated' : 'Category created', 'success');
        closeAllModals();
        render();
      } catch (e) { toast('Failed: ' + e.message, 'error'); }
    });
  }

  function bindCategories() {
    const search = $('#cat-search');
    if (search) search.addEventListener('input', (e) => { state.catSearch = e.target.value; render(); });

    const addBtn = $('#btn-add-category');
    if (addBtn) addBtn.addEventListener('click', () => showCategoryEditor(null));

    $$('[data-edit-cat]').forEach(el => el.addEventListener('click', () => showCategoryEditor(el.dataset.editCat)));

    $$('[data-toggle-cat]').forEach(el => el.addEventListener('click', async () => {
      const id = el.dataset.toggleCat;
      const c = (state.data.categories || []).find(x => x.id === id);
      if (!c) return;
      try {
        await sbUpdate('categories', id, { active: c.active === false });
        c.active = c.active === false;
        toast(c.active ? 'Category visible' : 'Category hidden', 'success');
        render();
      } catch (e) { toast('Failed: ' + e.message, 'error'); }
    }));

    $$('[data-cat-order]').forEach(el => el.addEventListener('change', async () => {
      const id = el.dataset.catOrder;
      try {
        await sbUpdate('categories', id, { order: parseFloat(el.value) || 0 });
        toast('Order saved', 'success');
        await loadData();
      } catch (e) { toast('Failed: ' + e.message, 'error'); }
    }));

    $$('[data-delete-cat]').forEach(el => el.addEventListener('click', () => {
      const id = el.dataset.deleteCat;
      showConfirm('Delete Category', 'Are you sure? Products in this category are not deleted.', async () => {
        try {
          await sbDelete('categories', id);
          state.data.categories = (state.data.categories || []).filter(x => x.id !== id);
          toast('Category deleted', 'success');
          render();
        } catch (e) { toast('Failed: ' + e.message, 'error'); }
      });
    }));
  }

  // Shared Add/Edit brand dialog. The table's ✏️ button existed in the markup
  // but had no handler, so a brand could never be renamed or re-logo'd after it
  // was created. Editing reuses the same form and PATCHes through
  // /api/admin/update, so every column the form does not touch (order, models,
  // emblem, tier, active) is preserved.
  function openBrandEditor(brand) {
    const isEdit = !!brand;
    const b = brand || {};
    const hadLogo = !!(b.logo && String(b.logo).trim());
    showModal(`
        <div class="modal">
          <div class="modal-header"><h3>${isEdit ? 'Edit Brand' : 'Add Brand'}</h3><button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button></div>
          <div class="modal-body">
            <form id="brand-form">
              <div class="form-group"><label>Brand Name (EN) *</label><input name="name_en" value="${esc(b.name_en || '')}" required></div>
              <div class="form-group"><label>Brand Name (AR)</label><input name="name_ar" value="${esc(b.name_ar || '')}"></div>
              <div class="form-group"><label>Slug *</label><input name="slug" value="${esc(b.slug || '')}" ${isEdit ? 'readonly title="The slug is the brand URL — existing products and links keep working while it stays the same."' : ''} required></div>
              <div class="form-group">
                <label>Brand Logo</label>
                <div class="image-upload-zone" id="brand-upload-zone" style="padding:16px;">
                  <div class="upload-icon">📤</div>
                  <p><strong>Click to upload</strong> or drag and drop a logo</p>
                  <p style="font-size:11px;color:var(--text-muted);margin-top:4px;">PNG, JPG, WEBP or SVG up to 5MB. On hosts with a read-only disk the logo is stored with the brand itself.</p>
                  <input type="file" id="brand-file-input" accept="image/*" style="display:none;">
                </div>
                <div style="display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap;">
                  <img id="brand-logo-preview" src="${esc(b.logo || '')}" alt="" style="width:44px;height:44px;object-fit:contain;border-radius:6px;background:var(--cream);${hadLogo ? '' : 'display:none;'}">
                  <input name="logo" id="brand-logo-input" value="${esc(b.logo || '')}" placeholder="/img/logos/bmw.svg or https://…/logo.png" style="flex:1;min-width:200px;">
                  <button type="button" class="btn btn-ghost btn-sm" id="brand-logo-clear">Clear</button>
                </div>
              </div>
              <div class="form-group"><label>Description</label><textarea name="description_en" rows="3">${esc(b.description_en || '')}</textarea></div>
            </form>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
            <button class="btn btn-primary" id="btn-save-brand">${isEdit ? 'Save Changes' : 'Create Brand'}</button>
          </div>
        </div>`);

    const form = $('#brand-form');
    const logoInput = $('#brand-logo-input');
    const preview = $('#brand-logo-preview');
    const setLogo = (url) => {
      logoInput.value = url || '';
      if (url) { preview.src = url; preview.style.display = ''; }
      else { preview.removeAttribute('src'); preview.style.display = 'none'; }
    };

    const zone = $('#brand-upload-zone');
    const fileInput = $('#brand-file-input');
    if (zone && fileInput) {
      zone.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (e) => {
        const file = (e.target.files || [])[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) { toast(`${file.name} is too large (max 5MB)`, 'error'); return; }
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const { ok, j } = await api('POST', '/api/admin/upload', { dataUrl: reader.result });
            if (ok && j && j.url) { setLogo(j.url); toast('Logo uploaded', 'success'); return; }
            // Read-only disk (serverless): keep the logo with the brand record
            // itself so the storefront can still serve it. Small, validated
            // images only — a stored data URL travels with the brand row.
            if (file.size <= 250 * 1024 && /^image\//.test(file.type)) {
              setLogo(reader.result);
              toast('Server disk is read-only — the logo is saved with the brand', 'success');
            } else {
              toast((j && j.error) || 'Upload failed — paste a public image URL instead', 'error');
            }
          } catch (err) { toast('Upload failed: ' + err.message, 'error'); }
        };
        reader.readAsDataURL(file);
      });
    }
    const clearBtn = $('#brand-logo-clear');
    if (clearBtn) clearBtn.addEventListener('click', () => setLogo(''));

    $('#btn-save-brand').addEventListener('click', async () => {
      const val = (name) => (form.querySelector(`[name=${name}]`) || {}).value || '';
      const nameEn = val('name_en').trim();
      const slug = val('slug').trim();
      const logo = val('logo').trim();
      if (!nameEn || !slug) { toast('Fill required fields', 'error'); return; }
      const fields = {
        name_en: nameEn,
        name_ar: val('name_ar').trim(),
        slug,
        logo,
        description_en: val('description_en').trim(),
      };
      try {
        if (isEdit) {
          await sbUpdate('brands', b.id, fields);
          const row = (state.data.brands || []).find(x => x.id === b.id);
          if (row) Object.assign(row, fields); else (state.data.brands = state.data.brands || []).push(Object.assign({}, b, fields));
          toast('Brand updated', 'success');
        } else {
          const data = Object.assign({ id: uid('brand'), active: true, product_count: 0, order: (state.data.brands || []).length }, fields);
          await sbInsert('brands', data);
          if (!state.data.brands) state.data.brands = [];
          state.data.brands.push(data);
          toast('Brand created', 'success');
        }
        closeAllModals();
        render();
      } catch (e) { toast('Failed: ' + e.message, 'error'); }
    });
  }

  function bindBrands() {
    const addBtn = $('#btn-add-brand');
    if (addBtn) addBtn.addEventListener('click', () => openBrandEditor(null));

    $$('[data-edit-brand]').forEach(el => el.addEventListener('click', () => {
      const brand = (state.data.brands || []).find(x => x.id === el.dataset.editBrand);
      if (brand) openBrandEditor(brand);
      else toast('Brand not found', 'error');
    }));

    $$('[data-delete-brand]').forEach(el => el.addEventListener('click', () => {
      const id = el.dataset.deleteBrand;
      showConfirm('Delete Brand', 'Are you sure? Products linked to this brand will not be deleted.', async () => {
        try {
          await sbDelete('brands', id);
          state.data.brands = state.data.brands.filter(x => x.id !== id);
          toast('Brand deleted', 'success');
          render();
        } catch (e) { toast('Failed', 'error'); }
      });
    }));
  }

  function bindOrders() {
    const search = $('#order-search');
    if (search) search.addEventListener('input', (e) => { state.orderSearch = e.target.value; render(); });

    const statusFilter = $('#order-status-filter');
    if (statusFilter) statusFilter.addEventListener('change', (e) => { state.orderStatusFilter = e.target.value; render(); });

    const refresh = $('#btn-refresh-orders');
    if (refresh) refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      try {
        const { ok, j } = await api('GET', '/api/admin/orders');
        if (ok && j && Array.isArray(j.orders)) {
          state.data.orders = j.orders;
          state.ordersUpdatedAt = new Date();
          toast('Orders reloaded from Supabase', 'success');
        } else toast('Could not reload orders', 'error');
      } finally { refresh.disabled = false; render(); }
    });

    $$('[data-view-order]').forEach(el => el.addEventListener('click', () => showOrderDetail(el.dataset.viewOrder)));

    $$('[data-delete-order]').forEach(el => el.addEventListener('click', () => {
      const id = el.dataset.deleteOrder;
      showConfirm('Delete Order', `Are you sure you want to permanently delete order ${id}? This action cannot be undone.`, async () => {
        try {
          await sbDelete('orders', id);
          state.data.orders = state.data.orders.filter(x => x.id !== id);
          toast('Order deleted', 'success');
          render();
        } catch (e) { toast('Failed to delete order', 'error'); }
      }, 'Delete Order');
    }));
  }

  // ------------------------------------------------------------------------
  // ORDER DETAIL — customer_phone, customer_address and the order_items rows
  // ------------------------------------------------------------------------
  async function showOrderDetail(id) {
    const local = (state.data.orders || []).find(x => x.id === id);
    // Always re-read the order from Supabase so the panel shows the stored
    // order_items rows, not a stale in-memory copy.
    let o = local;
    try {
      const { ok, j } = await api('GET', `/api/admin/order/${encodeURIComponent(id)}`);
      if (ok && j && j.id) o = j;
    } catch (e) { /* fall back to the cached copy */ }
    if (!o) { toast('Order not found', 'error'); return; }

    const items = o.items || [];
    const paymentStatus = effectivePaymentStatus(o);
    let paymentProofHTML = '';
    let paymentVerificationHTML = '';
    if (o.payment === 'InstaPay') {
      paymentVerificationHTML = `
        <div class="detail-section instapay-verification-admin" style="margin-top:18px;">
          <h4>Payment verification</h4>
          <p>Payment method: <strong>InstaPay</strong></p>
          <p>Payment status: ${paymentStatusBadge(paymentStatus)}</p>
          <div class="admin-payment-actions">
            <button class="btn btn-primary btn-sm" id="btn-verify-payment" ${paymentStatus === 'Verified' ? 'disabled' : ''}>Verify</button>
            <button class="btn btn-danger btn-sm" id="btn-reject-payment" ${paymentStatus === 'Rejected' ? 'disabled' : ''}>Reject</button>
          </div>
        </div>`;
    }
    if (o.payment === 'InstaPay') {
      if (o.paymentProof && o.paymentProof.available) {
        const proofResponse = await api('GET', `/api/admin/order/${encodeURIComponent(id)}/payment-proof`);
        if (proofResponse.ok && proofResponse.j && proofResponse.j.url) {
          const proofUrl = esc(proofResponse.j.url);
          paymentProofHTML = `
            <div class="detail-section instapay-proof-admin" style="margin-top:18px;">
              <h4>⚡ Transfer proof / uploaded proof</h4>
              <p style="font-size:12px;color:var(--text-secondary);margin:4px 0 10px;">Customer-uploaded InstaPay transfer screenshot</p>
              <a href="${proofUrl}" target="_blank" rel="noopener noreferrer" title="Open InstaPay payment proof">
                <img src="${proofUrl}" alt="Customer InstaPay payment proof" style="display:block;max-width:100%;max-height:420px;object-fit:contain;border:1px solid var(--border);border-radius:8px;background:var(--bg);">
              </a>
              <p style="font-size:11px;color:var(--text-muted);margin:8px 0 0;">Click the image to open the full-size proof.</p>
            </div>`;
        } else {
          paymentProofHTML = `<div class="detail-section" style="margin-top:18px;"><h4>⚡ Transfer proof / uploaded proof</h4><p style="color:var(--danger);font-size:12px;">The proof is saved but could not be opened right now.</p></div>`;
        }
      } else {
        paymentProofHTML = `<div class="detail-section" style="margin-top:18px;"><h4>⚡ Transfer proof / uploaded proof</h4><p style="color:var(--danger);font-size:12px;">No payment proof is attached to this InstaPay order.</p></div>`;
      }
    }
    showModal(`
      <div class="modal" style="max-width:760px;">
        <div class="modal-header">
          <h3>Order ${esc(o.id)}</h3>
          <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
        </div>
        <div class="modal-body">
          <div class="order-detail-grid">
            <div class="detail-section">
              <h4>Customer</h4>
              <p><strong>${esc(o.customer?.fullName || '—')}</strong></p>
              <p data-field="customer_phone">📞 <a href="tel:${esc(o.customer?.phone || '')}">${esc(o.customer?.phone || '—')}</a></p>
              ${o.customer?.email ? `<p>📧 ${esc(o.customer.email)}</p>` : ''}
              <p data-field="customer_address">📍 ${esc(o.customer?.address || '—')}</p>
              <p>🏙 ${esc(o.customer?.city || '—')}${o.customer?.area ? ' — ' + esc(o.customer.area) : ''}</p>
              ${o.customer?.notes ? `<p style="color:var(--text-secondary);font-size:12px;">📝 ${esc(o.customer.notes)}</p>` : ''}
            </div>
            <div class="detail-section">
              <h4>Order Info</h4>
              <p>📅 ${fmtDateTime(o.createdAt || o.created_at)}</p>
              <p>💳 Payment method: <strong>${esc(o.payment || 'Cash on Delivery')}</strong>${o.payment === 'InstaPay' ? ' <span class="badge badge-gold">InstaPay</span>' : ''}</p>
              <p>Payment status: ${paymentStatusBadge(paymentStatus)}</p>
              <p>🌐 ${esc(o.source || 'storefront')}</p>
              <p>Order status: ${statusBadge(o.status)}</p>
            </div>
          </div>
          ${paymentProofHTML}
          ${paymentVerificationHTML}

          <h4 style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin:20px 0 10px;">
            Order items <span style="color:var(--text-muted);font-weight:400;">(${items.length} line${items.length === 1 ? '' : 's'} from order_items)</span>
          </h4>
          <table class="data-table" style="font-size:12px;">
            <thead><tr><th style="width:44px;"></th><th>Product</th><th>Color</th><th>Key shape</th><th>Nano Ceramic Coating</th><th>Qty</th><th>Unit price</th><th>Line total</th></tr></thead>
            <tbody>
              ${items.length ? items.map(it => `<tr>
                <td>${it.image ? `<img src="${esc(it.image)}" alt="" style="width:36px;height:30px;object-fit:cover;border-radius:5px;background:var(--cream);">` : ''}</td>
                <td>
                  <div style="font-weight:600;">${esc(it.name_en || it.productId || '—')}</div>
                  <div style="font-size:11px;color:var(--text-muted);">${esc(it.category || '')}${it.brandSlug ? ' · ' + esc(it.brandSlug) : ''}${it.fitment && it.fitment.model ? ' · ' + esc(it.fitment.model) + ' ' + esc(it.fitment.year || '') : ''}</div>
                </td>
                <td>${it.color && it.color.hex
                  ? `<span style="display:inline-flex;align-items:center;gap:6px;"><span class="pcolor-dot" style="background:${esc(it.color.hex)}"></span>${esc(it.color.name_en || it.color.name_ar || it.color.hex)}</span>`
                  : '<span style="color:var(--text-muted);">—</span>'}</td>
                <td>${esc(it.keyShape || '—')}</td>
                <td>${it.coating
                  ? '<span class="badge badge-coating" title="Customer requested the Nano Ceramic Coating extra on this line (+EGP 100)">◆ Requested +EGP 100</span>'
                  : '<span style="color:var(--text-muted);">—</span>'}</td>
                <td>${it.qty}</td>
                <td>${money(it.price)}</td>
                <td><strong>${money(it.lineTotal != null ? it.lineTotal : (it.price || 0) * (it.qty || 0))}</strong></td>
              </tr>`).join('') : '<tr><td colspan="8" style="color:var(--text-muted);">No line items stored for this order.</td></tr>'}
            </tbody>
          </table>

          <div style="margin-top:16px;text-align:right;">
            <p style="font-size:13px;color:var(--text-secondary);">Subtotal: ${money(o.subtotal)}</p>
            ${o.bundleDiscount ? `<p style="font-size:13px;color:var(--success);">Bundle Discount: −${money(o.bundleDiscount)}</p>` : ''}
            ${o.coatingFee ? `<p style="font-size:13px;color:var(--text-secondary);">Nano Ceramic Coating: +${money(o.coatingFee)}</p>` : ''}
            <p style="font-size:13px;color:var(--text-secondary);">Delivery: ${o.deliveryFee ? money(o.deliveryFee) : 'Free'}</p>
            <p style="font-size:18px;font-weight:700;margin-top:8px;">Total: ${money(o.total)}</p>
          </div>

          ${(o.statusHistory && o.statusHistory.length) ? `
          <details style="margin-top:16px;">
            <summary style="cursor:pointer;font-size:12px;color:var(--text-muted);">Status history (${o.statusHistory.length})</summary>
            <ul style="font-size:12px;color:var(--text-secondary);margin:8px 0 0 18px;">
              ${o.statusHistory.map(h => `<li>${esc(h.status)} — ${fmtDateTime(h.at)}</li>`).join('')}
            </ul>
          </details>` : ''}

          <div class="form-group" style="margin-top:20px;">
            <label>Change Status</label>
            <select id="order-status-select">
              ${ORDER_STATUSES.map(s => `<option value="${s}" ${o.status === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Close</button>
          <button class="btn btn-primary" id="btn-update-status">Update Status</button>
        </div>
      </div>`);

    $('#btn-update-status').addEventListener('click', async () => {
      const newStatus = $('#order-status-select').value;
      try {
        await api('POST', '/api/admin/order-status', { id, status: newStatus });
        const stored = (state.data.orders || []).find(x => x.id === id);
        if (stored) {
          stored.status = newStatus;
          stored.statusHistory = [...(stored.statusHistory || []), { status: newStatus, at: new Date().toISOString() }];
        }
        toast('Order status updated', 'success');
        closeAllModals();
        render();
      } catch (e) { toast('Failed to update', 'error'); }
    });

    async function updatePaymentVerification(nextStatus) {
      try {
        const { ok, j } = await api('POST', '/api/admin/order-payment-status', { id, status: nextStatus });
        if (!ok) throw new Error((j && j.error) || 'Failed');
        const stored = (state.data.orders || []).find(x => x.id === id);
        if (stored) stored.paymentStatus = nextStatus;
        toast(`Payment ${nextStatus.toLowerCase()}`, 'success');
        closeAllModals();
        render();
      } catch (e) { toast(e.message || 'Failed to update payment status', 'error'); }
    }
    const verifyBtn = $('#btn-verify-payment');
    const rejectBtn = $('#btn-reject-payment');
    if (verifyBtn) verifyBtn.addEventListener('click', () => updatePaymentVerification('Verified'));
    if (rejectBtn) rejectBtn.addEventListener('click', () => updatePaymentVerification('Rejected'));
  }

  function bindCustomers() {
    const search = $('#customer-search');
    if (search) search.addEventListener('input', (e) => { state.customerSearch = e.target.value; render(); });
  }

  function bindInventory() {
    const search = $('#inventory-search');
    if (search) search.addEventListener('input', (e) => { state.inventorySearch = e.target.value; render(); });

    const filter = $('#inventory-filter');
    if (filter) filter.addEventListener('change', (e) => { state.inventoryFilter = e.target.value; render(); });

    $$('[data-save-stock]').forEach(el => el.addEventListener('click', async () => {
      const id = el.dataset.saveStock;
      const input = document.querySelector(`[data-stock-id="${id}"]`);
      if (!input) return;
      const newStock = parseInt(input.value) || 0;
      try {
        await sbUpdate('products', id, { stock: newStock });
        const p = state.data.products.find(x => x.id === id);
        if (p) p.stock = newStock;
        toast('Stock updated', 'success');
      } catch (e) { toast('Failed to update stock', 'error'); }
    }));
  }

  function bindDiscounts() {
    const addBtn = $('#btn-add-discount');
    if (addBtn) addBtn.addEventListener('click', () => {
      showModal(`
        <div class="modal">
          <div class="modal-header"><h3>Add Discount Code</h3><button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button></div>
          <div class="modal-body">
            <form id="discount-form">
              <div class="form-group"><label>Code *</label><input name="code" required style="font-family:monospace;text-transform:uppercase;" placeholder="SAVE20"></div>
              <div class="form-row">
                <div class="form-group"><label>Type</label><select name="type"><option value="percentage">Percentage (%)</option><option value="fixed">Fixed Amount</option></select></div>
                <div class="form-group"><label>Value *</label><input name="value" type="number" min="0" required></div>
              </div>
              <div class="form-row">
                <div class="form-group"><label>Min Order (EGP)</label><input name="min_order" type="number" min="0" value="0"></div>
                <div class="form-group"><label>Max Uses</label><input name="max_uses" type="number" min="0" placeholder="Unlimited"></div>
              </div>
              <div class="form-group"><label>Expiration Date</label><input name="expires_at" type="datetime-local"></div>
            </form>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
            <button class="btn btn-primary" id="btn-save-discount">Create Code</button>
          </div>
        </div>`);
      $('#btn-save-discount').addEventListener('click', async () => {
        const form = $('#discount-form');
        const data = {
          id: uid('disc'),
          code: form.querySelector('[name=code]').value.trim().toUpperCase(),
          type: form.querySelector('[name=type]').value,
          value: parseFloat(form.querySelector('[name=value]').value) || 0,
          min_order: parseFloat(form.querySelector('[name=min_order]').value) || 0,
          max_uses: parseInt(form.querySelector('[name=max_uses]').value) || null,
          expires_at: form.querySelector('[name=expires_at]').value || null,
          active: true,
          used_count: 0,
        };
        if (!data.code || !data.value) { toast('Fill required fields', 'error'); return; }
        try {
          await sbInsert('discount_codes', data);
          if (!state.data.discount_codes) state.data.discount_codes = [];
          state.data.discount_codes.push(data);
          toast('Discount code created', 'success');
          closeAllModals();
          render();
        } catch (e) { toast('Failed: ' + e.message, 'error'); }
      });
    });

    $$('[data-delete-discount]').forEach(el => el.addEventListener('click', () => {
      const id = el.dataset.deleteDiscount;
      showConfirm('Delete Discount Code', 'This code will no longer work.', async () => {
        try {
          await sbDelete('discount_codes', id);
          state.data.discount_codes = (state.data.discount_codes || []).filter(x => x.id !== id);
          toast('Discount deleted', 'success');
          render();
        } catch (e) { toast('Failed', 'error'); }
      });
    }));
  }

  // ------------------------------------------------------------------------
  // Package / bundle editor — shared by "+ Add Package" (id = null) and the
  // row ✏️ button (id = the bundle id), exactly like showProductEditor().
  //
  // Editing uses sbUpdate (POST /api/admin/update → db.patchRecord), which
  // merges the patch into the stored row server-side. That matters here: a
  // bundle carries fields this form deliberately does not expose
  // (keyCaseProductId / keyHolderProductId / medalProductId, sub_en, sub_ar,
  // discountMode, startDate, endDate), and a full-record upsert built from the
  // form alone would blank every one of them.
  // ------------------------------------------------------------------------
  function showPackageEditor(id) {
    if (!Array.isArray(state.data.bundles)) state.data.bundles = [];
    const bundles = state.data.bundles;
    const p = id ? bundles.find(x => x.id === id) : null;
    if (id && !p) { toast('Package not found', 'error'); return; }

    const brands = state.data.brands || [];
    const currentSlug = p?.brandSlug || '';

    showModal(`
      <div class="modal">
        <div class="modal-header"><h3>${p ? 'Edit Package/Bundle' : 'Add Package/Bundle'}</h3><button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button></div>
        <div class="modal-body">
          <form id="package-form">
            <div class="form-group"><label>Brand *</label>
              <select name="brandSlug" required>
                <option value="">Select brand</option>
                ${brands.map(b => `<option value="${esc(b.slug)}" ${currentSlug === b.slug ? 'selected' : ''}>${esc(b.name_en)}</option>`).join('')}
                ${currentSlug && !brands.some(b => b.slug === currentSlug) ? `<option value="${esc(currentSlug)}" selected>${esc(currentSlug)}</option>` : ''}
              </select>
            </div>
            <div class="form-row">
              <div class="form-group"><label>Package Name (EN)</label><input name="title_en" value="${esc(p?.title_en || p?.name_en || '')}" placeholder="Complete Your Set"></div>
              <div class="form-group"><label>Package Name (AR)</label><input name="title_ar" value="${esc(p?.title_ar || p?.name_ar || '')}" dir="rtl"></div>
            </div>
            <div class="form-row">
              <div class="form-group"><label>Bundle Price (EGP) *</label><input name="bundlePrice" id="pkg-bundle-price" type="number" min="0" step="1" value="${p?.bundlePrice != null ? p.bundlePrice : ''}" required></div>
              <div class="form-group"><label>Regular Total (EGP)</label><input name="normalTotal" id="pkg-normal-total" type="number" min="0" step="1" value="${p?.normalTotal != null ? p.normalTotal : 0}"></div>
            </div>
            <div id="pkg-savings-hint" style="font-size:12px;color:var(--text-secondary);min-height:16px;"></div>
            <div class="form-group" style="display:flex;align-items:center;gap:16px;margin-top:8px;">
              <label class="toggle" style="margin-bottom:0;">
                <input type="checkbox" name="active" ${p ? (p.active !== false ? 'checked' : '') : 'checked'}>
                <span class="toggle-slider"></span>
              </label>
              <span style="font-size:13px;color:var(--text-secondary);">Active</span>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button class="btn btn-primary" id="btn-save-package">${p ? 'Update' : 'Create'} Package</button>
        </div>
      </div>`);

    // Live savings readout so the two price fields can be sanity-checked
    // before saving — this is the "Savings" column the table renders.
    const priceEl = $('#pkg-bundle-price');
    const totalEl = $('#pkg-normal-total');
    const hintEl = $('#pkg-savings-hint');
    function recalcSavings() {
      if (!priceEl || !totalEl || !hintEl) return;
      const price = parseFloat(priceEl.value) || 0;
      const total = parseFloat(totalEl.value) || 0;
      if (!total) { hintEl.textContent = ''; return; }
      const save = total - price;
      hintEl.textContent = save > 0
        ? `Customer saves ${money(save)} (${Math.round((save / total) * 100)}%).`
        : 'Bundle price is not below the regular total — the storefront will show no savings.';
    }
    if (priceEl) priceEl.addEventListener('input', recalcSavings);
    if (totalEl) totalEl.addEventListener('input', recalcSavings);
    recalcSavings();

    $('#btn-save-package').addEventListener('click', async () => {
      const form = $('#package-form');
      const brandSlug = form.querySelector('[name=brandSlug]').value;
      const bundlePrice = parseFloat(form.querySelector('[name=bundlePrice]').value) || 0;
      const normalTotal = parseFloat(form.querySelector('[name=normalTotal]').value) || 0;
      if (!brandSlug || !bundlePrice) { toast('Fill required fields', 'error'); return; }

      const updates = {
        brandSlug,
        bundlePrice,
        normalTotal,
        title_en: form.querySelector('[name=title_en]').value.trim(),
        title_ar: form.querySelector('[name=title_ar]').value.trim(),
        active: !!form.querySelector('[name=active]')?.checked,
      };

      try {
        if (p) {
          await sbUpdate('bundles', p.id, updates);
          Object.assign(p, updates);
          toast('Package updated', 'success');
        } else {
          const created = Object.assign({ id: uid('bundle'), order: bundles.length }, updates);
          await sbInsert('bundles', created);
          bundles.push(created);
          toast('Package created', 'success');
        }
        closeAllModals();
        render();
      } catch (e) { toast('Failed: ' + e.message, 'error'); }
    });
  }

  function bindPackages() {
    const addBtn = $('#btn-add-package');
    if (addBtn) addBtn.addEventListener('click', () => showPackageEditor(null));

    $$('[data-edit-package]').forEach(el => el.addEventListener('click', () => showPackageEditor(el.dataset.editPackage)));

    $$('[data-delete-package]').forEach(el => el.addEventListener('click', () => {
      const id = el.dataset.deletePackage;
      showConfirm('Delete Package', 'This bundle will be removed.', async () => {
        try {
          await sbDelete('bundles', id);
          state.data.bundles = state.data.bundles.filter(x => x.id !== id);
          toast('Package deleted', 'success');
          render();
        } catch (e) { toast('Failed', 'error'); }
      });
    }));
  }

  function showContentEditor(key) {
    const c = (state.data.websiteContent || []).find(x => x.key === key);
    if (!c) return;
    showModal(`
      <div class="modal">
        <div class="modal-header"><h3>Edit “${esc(c.key)}”</h3><button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button></div>
        <div class="modal-body">
          <form id="content-form">
            <div class="form-group"><label>Section</label><input name="section" value="${esc(c.section || 'copy')}"></div>
            <div class="form-group"><label>English</label><textarea name="value_en" rows="3">${esc(c.value_en || '')}</textarea></div>
            <div class="form-group"><label>Arabic</label><textarea name="value_ar" rows="3" dir="rtl">${esc(c.value_ar || '')}</textarea></div>
          </form>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button class="btn btn-primary" id="btn-save-content">Save</button>
        </div>
      </div>`);
    $('#btn-save-content').addEventListener('click', async () => {
      const form = $('#content-form');
      const data = {
        id: c.id,
        section: form.querySelector('[name=section]').value.trim() || 'copy',
        key: c.key,
        value_en: form.querySelector('[name=value_en]').value,
        value_ar: form.querySelector('[name=value_ar]').value,
      };
      try {
        await sbUpsert('websiteContent', data);
        Object.assign(c, data);
        toast('Content saved', 'success');
        closeAllModals();
        render();
      } catch (e) { toast('Failed: ' + e.message, 'error'); }
    });
  }

  function bindContent() {
    const contentSearch = $('#content-search');
    if (contentSearch) contentSearch.addEventListener('input', (e) => { state.contentSearch = e.target.value; render(); });

    $$('[data-edit-content]').forEach(el => el.addEventListener('click', () => showContentEditor(el.dataset.editContent)));

    $$('[data-edit-section-title]').forEach(el => el.addEventListener('click', () => {
      const id = el.dataset.editSectionTitle;
      const sec = (state.data.homeSections || []).find(x => x.id === id);
      if (!sec) return;
      showModal(`
        <div class="modal">
          <div class="modal-header"><h3>Edit section “${esc(sec.type || sec.id)}”</h3><button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button></div>
          <div class="modal-body">
            <form id="section-form">
              <div class="form-group"><label>Title (EN)</label><input name="title" value="${esc(sec.title || '')}"></div>
              <div class="form-group"><label>Subtitle (EN)</label><input name="subtitle_en" value="${esc(sec.subtitle_en || '')}"></div>
              <div class="form-group"><label>Order</label><input name="order" type="number" step="1" value="${sec.order || 0}"></div>
            </form>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
            <button class="btn btn-primary" id="btn-save-section">Save section</button>
          </div>
        </div>`);
      $('#btn-save-section').addEventListener('click', async () => {
        const form = $('#section-form');
        const updates = {
          title: form.querySelector('[name=title]').value.trim(),
          subtitle_en: form.querySelector('[name=subtitle_en]').value.trim(),
          order: parseInt(form.querySelector('[name=order]').value, 10) || 0,
        };
        try {
          await sbUpdate('home_sections', id, updates);
          Object.assign(sec, updates);
          toast('Section saved', 'success');
          closeAllModals();
          render();
        } catch (e) { toast('Failed: ' + e.message, 'error'); }
      });
    }));

    const addSlide = $('#btn-add-slide');
    if (addSlide) addSlide.addEventListener('click', () => {
      showModal(`
        <div class="modal">
          <div class="modal-header"><h3>Add Hero Slide</h3><button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button></div>
          <div class="modal-body">
            <form id="slide-form">
              <div class="form-group"><label>Title (EN)</label><input name="title_en"></div>
              <div class="form-group"><label>Subtitle (EN)</label><input name="subtitle_en"></div>
              <div class="form-group"><label>Image URL</label><input name="image" placeholder="/img/..."></div>
            </form>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
            <button class="btn btn-primary" id="btn-save-slide">Add Slide</button>
          </div>
        </div>`);
      $('#btn-save-slide').addEventListener('click', async () => {
        const form = $('#slide-form');
        const data = {
          id: uid('slide'),
          title_en: form.querySelector('[name=title_en]').value.trim(),
          subtitle_en: form.querySelector('[name=subtitle_en]').value.trim(),
          image: form.querySelector('[name=image]').value.trim(),
          active: true,
          order: (state.data.heroSlides || []).length + 1,
        };
        try {
          await sbInsert('hero_slides', data);
          state.data.heroSlides.push(data);
          toast('Slide added', 'success');
          closeAllModals();
          render();
        } catch (e) { toast('Failed: ' + e.message, 'error'); }
      });
    });

    $$('[data-toggle-section]').forEach(el => el.addEventListener('change', async () => {
      const id = el.dataset.toggleSection;
      const sec = state.data.homeSections.find(x => x.id === id);
      if (!sec) return;
      try {
        await sbUpdate('home_sections', id, { enabled: el.checked });
        sec.enabled = el.checked;
        toast('Section updated', 'success');
      } catch (e) { toast('Failed', 'error'); }
    }));

    const savePromo = $('#btn-save-promo');
    if (savePromo) savePromo.addEventListener('click', async () => {
      const promoBar = {
        enabled: $('#promo-enabled').value === 'true',
        text_en: $('#promo-text-en').value.trim(),
        text_ar: $('#promo-text-ar').value.trim(),
        endTime: $('#promo-end').value ? new Date($('#promo-end').value).toISOString() : null,
      };
      try {
        await api('POST', '/api/admin/settings', { promoBar });
        state.data.promoBar = promoBar;
        toast('Promo bar saved', 'success');
      } catch (e) { toast('Failed', 'error'); }
    });
  }

  function bindImages() {
    const zone = $('#upload-zone');
    const input = $('#image-file-input');
    if (zone && input) {
      zone.addEventListener('click', () => input.click());
      input.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        for (const file of files) {
          if (file.size > 5 * 1024 * 1024) { toast(`${file.name} is too large (max 5MB)`, 'error'); continue; }
          const reader = new FileReader();
          reader.onload = async () => {
            try {
              const { ok, j } = await api('POST', '/api/admin/upload', { dataUrl: reader.result });
              if (!ok || !j?.url) { toast((j && j.error) || 'Upload failed', 'error'); return; }
              const imgData = { id: uid('img'), name: file.name, url: j.url, section: 'general', alt: file.name };
              await sbInsert('website_images', imgData);
              if (!state.data.website_images) state.data.website_images = [];
              state.data.website_images.push(imgData);
              toast('Image uploaded', 'success');
              render();
            } catch (err) { toast('Upload failed: ' + err.message, 'error'); }
          };
          reader.readAsDataURL(file);
        }
      });
    }

    $$('[data-delete-image]').forEach(el => el.addEventListener('click', () => {
      const id = el.dataset.deleteImage;
      showConfirm('Delete Image', 'This image will be removed from the library. Products that already reference its URL keep it.', async () => {
        try {
          await sbDelete('website_images', id);
          state.data.website_images = (state.data.website_images || []).filter(x => x.id !== id);
          toast('Image removed', 'success');
          render();
        } catch (e) { toast('Failed: ' + e.message, 'error'); }
      }, 'Delete');
    }));

    const addByUrl = $('#btn-image-by-url');
    if (addByUrl) addByUrl.addEventListener('click', async () => {
      const input = $('#image-url-input');
      const url = (input?.value || '').trim();
      if (!url) { toast('Enter an image URL', 'error'); return; }
      const name = (document.querySelector('#image-name-input')?.value || url.split('/').pop()).trim();
      const imgData = { id: uid('img'), name, url, section: 'general', alt: name };
      try {
        await sbInsert('website_images', imgData);
        if (!state.data.website_images) state.data.website_images = [];
        state.data.website_images.push(imgData);
        toast('Image added to the library', 'success');
        render();
      } catch (e) { toast('Failed: ' + e.message, 'error'); }
    });
  }

  function bindMessages() {
    const search = $('#message-search');
    if (search) search.addEventListener('input', (e) => { state.messageSearch = e.target.value; render(); });

    const filter = $('#message-filter');
    if (filter) filter.addEventListener('change', (e) => { state.messageFilter = e.target.value; render(); });

    $$('[data-view-message]').forEach(el => el.addEventListener('click', () => {
      const id = el.dataset.viewMessage;
      const m = state.data.messages.find(x => x.id === id);
      if (!m) return;
      showModal(`
        <div class="modal">
          <div class="modal-header"><h3>Message from ${esc(m.name || 'Unknown')}</h3><button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button></div>
          <div class="modal-body">
            <div class="detail-section">
              <p><strong>${esc(m.name || '—')}</strong></p>
              <p>📧 ${esc(m.email || '—')}</p>
              <p>📞 ${esc(m.phone || '—')}</p>
              <p>📅 ${fmtDateTime(m.createdAt)}</p>
            </div>
            <div style="margin-top:16px;padding:16px;background:var(--bg);border-radius:8px;">
              <p style="white-space:pre-wrap;line-height:1.7;">${esc(m.message || '')}</p>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Close</button>
            ${!m.is_read ? `<button class="btn btn-primary" id="btn-mark-read">Mark as Read</button>` : ''}
            ${!m.is_resolved ? `<button class="btn btn-secondary" id="btn-mark-resolved">Mark Resolved</button>` : ''}
          </div>
        </div>`);
      const markRead = $('#btn-mark-read');
      if (markRead) markRead.addEventListener('click', async () => {
        try {
          await sbUpdate('messages', id, { is_read: true });
          m.is_read = true;
          toast('Marked as read', 'success');
          closeAllModals();
          render();
        } catch (e) { toast('Failed', 'error'); }
      });
      const markResolved = $('#btn-mark-resolved');
      if (markResolved) markResolved.addEventListener('click', async () => {
        try {
          await sbUpdate('messages', id, { is_resolved: true });
          m.is_resolved = true;
          toast('Marked as resolved', 'success');
          closeAllModals();
          render();
        } catch (e) { toast('Failed', 'error'); }
      });
    }));

    $$('[data-toggle-read-message]').forEach(el => el.addEventListener('click', async () => {
      const id = el.dataset.toggleReadMessage;
      const m = state.data.messages.find(x => x.id === id);
      if (!m) return;
      try {
        await sbUpdate('messages', id, { is_read: !m.is_read });
        m.is_read = !m.is_read;
        render();
      } catch (e) { toast('Failed', 'error'); }
    }));

    $$('[data-delete-message]').forEach(el => el.addEventListener('click', () => {
      const id = el.dataset.deleteMessage;
      showConfirm('Delete Message', 'This message will be permanently deleted.', async () => {
        try {
          await sbDelete('messages', id);
          state.data.messages = state.data.messages.filter(x => x.id !== id);
          toast('Message deleted', 'success');
          render();
        } catch (e) { toast('Failed', 'error'); }
      });
    }));
  }

  function bindSettings() {
    const saveBtn = $('#btn-save-settings');
    if (saveBtn) saveBtn.addEventListener('click', async () => {
      const instapayEnabled = $('#s-instapay-enabled') ? $('#s-instapay-enabled').checked : false;
      const instapayUrl = $('#s-instapay-url') ? $('#s-instapay-url').value.trim() : '';
      const settings = {
        shopName: $('#s-name').value.trim() || 'Vilocci',
        tagline: $('#s-tagline').value.trim(),
        contact: {
          email: $('#s-email').value.trim(),
          phone: $('#s-phone').value.trim(),
          whatsapp: $('#s-whatsapp').value.trim(),
          address: $('#s-address').value.trim(),
        },
        shippingFee: parseFloat($('#s-shipping-fee').value) || 0,
        freeShippingThreshold: parseFloat($('#s-free-ship').value) || 0,
        social: {
          facebook: $('#s-facebook').value.trim(),
          instagram: $('#s-instagram').value.trim(),
          tiktok: $('#s-tiktok').value.trim(),
          twitter: $('#s-twitter').value.trim(),
        },
        instapay: {
          enabled: instapayEnabled,
          url: instapayUrl,
        },
      };
      try {
        await api('POST', '/api/admin/settings', { settings });
        Object.assign(state.data.settings, settings);
        toast('Settings saved', 'success');
      } catch (e) { toast('Failed to save', 'error'); }
    });
  }

  // ========================================================================
  // INIT
  // ========================================================================

  (async function init() {
    // Resolve Supabase config first (injected values, or /api/admin/config).
    await ensureSupabaseConfig();

  // Hash change listener — handles browser back/forward and direct URL navigation
  window.addEventListener('hashchange', () => {
    const route = getAdminRoute();
    if (route === 'login' && state.view === 'dashboard') {
      // Navigated to #/login while logged in — stay on dashboard
      // (login page is only for unauthenticated users)
      setAdminRoute('admin');
      return;
    }
    if (route === 'admin' && state.view === 'login' && state.user) {
      // Navigated to #/admin while logged in — show dashboard
      state.view = 'dashboard';
      if (!state.data) loadData(); else render();
      return;
    }
    // Re-check auth for the new route
    checkAuth();
  });

  // Listen for auth state changes (handles token refresh, sign out from other tabs)
  (function setupAuthListener() {
    const s = getSB();
    if (!s) return;
    s.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        state.user = null;
        state.loginError = '';
        setAdminRoute('login');
        if (state.view !== 'login') {
          state.view = 'login';
          render();
        }
      } else if (event === 'SIGNED_IN' && session?.user) {
        verifyAdminUser(session.user).then(isAdmin => {
          if (isAdmin) {
            state.user = session.user;
            if (getAdminRoute() === 'login') {
              setAdminRoute('admin');
            }
            if (state.view === 'login') {
              state.view = 'dashboard';
              if (!state.data) loadData(); else render();
            }
          }
        });
      } else if (event === 'TOKEN_REFRESHED' && session?.user) {
        // Token refreshed — session stays valid
        state.user = session.user;
      }
    });
  })();

  checkAuth();
  })();
})();
