/* ==========================================================================
   SPINTO — Admin Dashboard Application
   Professional e-commerce admin panel with Supabase integration.
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
    // If URL contains a path like /rest/v1/ or /auth/v1/, strip it
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.hostname}`;
    } catch (e) {
      console.error('[Supabase] Invalid URL format:', url);
      return '';
    }
  }

  const SUPABASE_URL = sanitizeSupabaseUrl(window.__SPINTO_SUPABASE_URL || import.meta?.env?.VITE_SUPABASE_URL || '');
  const SUPABASE_ANON_KEY = (window.__SPINTO_SUPABASE_ANON_KEY || import.meta?.env?.VITE_SUPABASE_ANON_KEY || '').trim();

  if (SUPABASE_URL) {
    console.log('[Supabase] Client URL:', SUPABASE_URL);
  } else {
    console.warn('[Supabase] WARNING: No valid Supabase URL configured');
  }

  let sb = null;
  function getSB() {
    if (sb) return sb;
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
    if (!window.supabase || !window.supabase.createClient) {
      console.error('[Supabase] CDN library not loaded');
      return null;
    }
    try {
      sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true },
      });
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
  };

  function money(n) { return 'EGP ' + Math.round(n || 0).toLocaleString('en-US'); }
  function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
  function fmtDate(d) { if (!d) return '—'; const dt = new Date(d); return dt.toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' }); }
  function fmtDateTime(d) { if (!d) return '—'; const dt = new Date(d); return dt.toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); }
  function uid(p) { return (p||'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

  // Local API to existing server (for backward compat & fallback)
  async function api(method, url, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    const j = await r.json();
    return { ok: r.ok, status: r.status, j };
  }

  // Supabase-safe fetch
  async function sbQuery(table, opts = {}) {
    const s = getSB();
    if (!s) return api('GET', '/api/admin/data').then(r => r.j);
    let q = s.from(table).select('*');
    if (opts.limit) q = q.limit(opts.limit);
    if (opts.order) q = q.order(opts.order.col, { ascending: opts.order.asc !== false });
    if (opts.filter) q = q.eq(opts.filter.col, opts.filter.val);
    const { data, error } = await q;
    if (error) { console.error('[SB]', error); return []; }
    return data;
  }

  async function sbInsert(table, row) {
    const s = getSB();
    if (!s) return api('POST', '/api/admin/save', { collection: table === 'products' ? 'products' : table, record: row });
    const { data, error } = await s.from(table).insert(row).select();
    if (error) throw error;
    return data?.[0] || row;
  }

  async function sbUpdate(table, id, updates) {
    const s = getSB();
    if (!s) return api('POST', '/api/admin/save', { collection: table === 'products' ? 'products' : table, record: { id, ...updates } });
    const { data, error } = await s.from(table).update(updates).eq('id', id).select();
    if (error) throw error;
    return data?.[0];
  }

  async function sbDelete(table, id) {
    const s = getSB();
    if (!s) return api('POST', '/api/admin/delete', { collection: table === 'products' ? 'products' : table, id });
    const { error } = await s.from(table).delete().eq('id', id);
    if (error) throw error;
    return true;
  }

  async function sbUpsert(table, row) {
    const s = getSB();
    if (!s) return api('POST', '/api/admin/save', { collection: table === 'products' ? 'products' : table, record: row });
    const { data, error } = await s.from(table).upsert(row).select();
    if (error) throw error;
    return data?.[0] || row;
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
          render();
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
        // Map Supabase errors to user-friendly messages
        if (error.message.includes('Invalid path') || error.message.includes('Invalid URL')) {
          state.loginError = 'Authentication service is misconfigured. Please contact the site administrator.';
          console.error('[Supabase] URL configuration error:', error.message);
        } else if (error.message.includes('Invalid login credentials') ||
            error.message.includes('invalid_credentials') ||
            error.status === 400) {
          state.loginError = 'Invalid email or password. Please try again.';
        } else if (error.message.includes('Email not confirmed')) {
          state.loginError = 'Please verify your email address before signing in.';
        } else if (error.message.includes('Too many requests')) {
          state.loginError = 'Too many attempts. Please wait a moment and try again.';
        } else {
          state.loginError = error.message || 'Login failed. Please check your credentials.';
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
      toast('Welcome to Spinto Admin', 'gold');

      // Redirect to /admin after successful login
      setAdminRoute('admin');
      state.view = 'dashboard';
      render();
    } catch (e) {
      console.error('[Login error]', e);
      state.loginError = e.message || 'An unexpected error occurred. Please try again.';
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
  async function loadData() {
    state.loading = true;
    render();
    try {
      const { ok, j } = await api('GET', '/api/admin/data');
      if (ok && j) {
        state.data = j;
      }
      state.loading = false;
      render();
    } catch (e) {
      toast('Failed to load data', 'error');
      state.loading = false;
      render();
    }
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
        <div class="page-content">
          ${renderPage()}
        </div>
      </div>`;

    bindGlobal();
    bindPage();
  }

  function renderLoginPage() {
    return `
    <div class="login-page">
      <div class="login-card">
        <div class="login-brand">
          <div class="logo-mark">S</div>
          <h1>Spinto</h1>
          <p>Admin Dashboard</p>
        </div>
        <form class="login-form" id="login-form">
          <div class="field">
            <label>Email</label>
            <input name="email" type="email" placeholder="admin@spinto.com" autocomplete="email" required>
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
          <h1>Spinto</h1>
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
      { id: 'orders', icon: '', label: 'Orders', badge: getNewOrderCount() },
      { id: 'customers', icon: '👥', label: 'Customers' },
      { id: 'inventory', icon: '📊', label: 'Inventory' },
      { id: 'discounts', icon: '💰', label: 'Discounts' },
      { id: 'packages', icon: '🎁', label: 'Packages' },
      { id: 'content', icon: '📝', label: 'Website Content' },
      { id: 'images', icon: '🖼️', label: 'Website Images' },
      { id: 'messages', icon: '✉️', label: 'Contact Messages', badge: getUnreadMsgCount() },
      { id: 'settings', icon: '⚙️', label: 'Settings' },
    ];

    return `
    <div class="sidebar-overlay ${state.sidebarOpen ? 'show' : ''}" id="sidebar-overlay"></div>
    <aside class="sidebar ${state.sidebarOpen ? 'open' : ''}" id="sidebar">
      <div class="sidebar-brand">
        <div class="s-logo">S</div>
        <div>
          <div class="s-name">Spinto</div>
          <div class="s-sub">Admin Panel</div>
        </div>
      </div>
      <nav class="sidebar-nav">
        <div class="nav-label">Main</div>
        ${items.slice(0, 1).map(i => sidebarLink(i, v)).join('')}
        <div class="nav-label">Catalog</div>
        ${items.slice(1, 4).map(i => sidebarLink(i, v)).join('')}
        <div class="nav-label">Sales</div>
        ${items.slice(4, 8).map(i => sidebarLink(i, v)).join('')}
        <div class="nav-label">Content</div>
        ${items.slice(8, 12).map(i => sidebarLink(i, v)).join('')}
        <div class="nav-label">System</div>
        ${items.slice(12).map(i => sidebarLink(i, v)).join('')}
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

  function renderHeader() {
    const titles = {
      dashboard: 'Dashboard', products: 'Products', categories: 'Categories',
      brands: 'Brands', orders: 'Orders', customers: 'Customers',
      inventory: 'Inventory', discounts: 'Discounts', packages: 'Packages',
      content: 'Website Content', images: 'Website Images',
      messages: 'Contact Messages', settings: 'Settings',
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
      case 'orders': return renderOrders();
      case 'customers': return renderCustomers();
      case 'inventory': return renderInventory();
      case 'discounts': return renderDiscounts();
      case 'packages': return renderPackages();
      case 'content': return renderContent();
      case 'images': return renderImages();
      case 'messages': return renderMessages();
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
                <td><strong>${money(p.price)}</strong>${p.sale_price ? `<br><span style="font-size:11px;color:var(--success);">Sale: ${money(p.sale_price)}</span>` : ''}</td>
                <td><span style="color:${(p.stock||0) <= 5 ? 'var(--danger)' : 'var(--text-primary)'};font-weight:600;">${p.stock || 0}</span></td>
                <td>${p.active ? '<span class="badge badge-active">Active</span>' : '<span class="badge badge-inactive">Inactive</span>'}</td>
                <td>
                  <button class="btn btn-ghost btn-sm" data-edit-product="${esc(p.id)}">✏️</button>
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
    const categories = state.data?.categories || inferCategories();
    return `
    <div class="toolbar">
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input type="text" placeholder="Search categories..." id="cat-search">
      </div>
      <button class="btn btn-primary" id="btn-add-category">+ Add Category</button>
    </div>
    <div class="card">
      <div class="card-body" style="padding:0;">
        ${categories.length ? `
        <table class="data-table">
          <thead><tr><th>Name</th><th>Slug</th><th>Products</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            ${categories.map(c => `<tr>
              <td><strong>${esc(c.name_en || c.name)}</strong></td>
              <td>${esc(c.slug || '')}</td>
              <td>${c.product_count || '—'}</td>
              <td>${c.active !== false ? '<span class="badge badge-active">Active</span>' : '<span class="badge badge-inactive">Inactive</span>'}</td>
              <td>
                <button class="btn btn-ghost btn-sm" data-edit-cat="${esc(c.id)}">✏️</button>
                <button class="btn btn-ghost btn-sm" data-delete-cat="${esc(c.id)}"></button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty-state"><div class="empty-icon">🏷️</div><h4>No categories</h4><p>Add your first category to organize products.</p></div>'}
      </div>
    </div>`;
  }

  function inferCategories() {
    const products = state.data?.products || [];
    const cats = {};
    products.forEach(p => {
      if (p.category) {
        if (!cats[p.category]) cats[p.category] = { id: p.category, name_en: p.category, slug: p.category, product_count: 0, active: true };
        cats[p.category].product_count++;
      }
    });
    return Object.values(cats);
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
  // ORDERS
  // ========================================================================
  function renderOrders() {
    const orders = state.data?.orders || [];
    const search = state.orderSearch || '';
    const filterStatus = state.orderStatusFilter || '';

    let filtered = orders;
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(o => (o.id || '').toLowerCase().includes(q) || (o.customer?.fullName || '').toLowerCase().includes(q) || (o.customer?.phone || '').includes(q));
    }
    if (filterStatus) filtered = filtered.filter(o => o.status === filterStatus);

    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return `
    <div class="toolbar">
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input type="text" placeholder="Search orders..." value="${esc(search)}" id="order-search">
      </div>
      <select class="filter-select" id="order-status-filter">
        <option value="">All Statuses</option>
        ${['New','Pending','Confirmed','Processing','Shipped','Delivered','Cancelled'].map(s => `<option value="${s}" ${filterStatus === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
    </div>

    <div class="stats-grid">
      <div class="stat-card"><div class="stat-icon blue">📋</div><div class="stat-value">${orders.length}</div><div class="stat-label">Total Orders</div></div>
      <div class="stat-card"><div class="stat-icon gold">🆕</div><div class="stat-value">${orders.filter(o=>o.status==='New'||o.status==='Pending').length}</div><div class="stat-label">New/Pending</div></div>
      <div class="stat-card"><div class="stat-icon green">✅</div><div class="stat-value">${orders.filter(o=>o.status==='Delivered').length}</div><div class="stat-label">Delivered</div></div>
      <div class="stat-card"><div class="stat-icon red"></div><div class="stat-value">${orders.filter(o=>o.status==='Cancelled').length}</div><div class="stat-label">Cancelled</div></div>
    </div>

    <div class="card">
      <div class="card-body" style="padding:0;overflow-x:auto;">
        ${filtered.length ? `
        <table class="data-table">
          <thead><tr><th>Order ID</th><th>Customer</th><th>Phone</th><th>Date</th><th>Items</th><th>Total</th><th>Status</th><th style="width:120px;">Actions</th></tr></thead>
          <tbody>
            ${filtered.map(o => `<tr>
              <td><strong>${esc(o.id)}</strong></td>
              <td>${esc(o.customer?.fullName || '—')}</td>
              <td>${esc(o.customer?.phone || '—')}</td>
              <td>${fmtDate(o.createdAt)}</td>
              <td>${(o.items || []).length}</td>
              <td><strong>${money(o.total)}</strong></td>
              <td>${statusBadge(o.status)}</td>
              <td>
                <button class="btn btn-ghost btn-sm" data-view-order="${esc(o.id)}">👁</button>
                <button class="btn btn-ghost btn-sm" data-delete-order="${esc(o.id)}">🗑</button>
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
                <td><strong>${esc(b.name_en || brand?.name_en + ' Bundle')}</strong></td>
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

    return `
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
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px;">PNG, JPG, WEBP up to 5MB</p>
          <input type="file" id="image-file-input" accept="image/*" style="display:none;" multiple>
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
            <input type="text" id="s-name" value="${esc(s.shopName || 'Spinto')}">
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
      case 'orders': bindOrders(); break;
      case 'customers': bindCustomers(); break;
      case 'inventory': bindInventory(); break;
      case 'discounts': bindDiscounts(); break;
      case 'packages': bindPackages(); break;
      case 'content': bindContent(); break;
      case 'images': bindImages(); break;
      case 'messages': bindMessages(); break;
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

  function showProductEditor(id) {
    const p = id ? state.data.products.find(x => x.id === id) : null;
    const brands = state.data.brands || [];
    const categories = [...new Set((state.data.products || []).map(x => x.category).filter(Boolean))];

    showModal(`
      <div class="modal" style="max-width:700px;">
        <div class="modal-header">
          <h3>${p ? 'Edit Product' : 'Add Product'}</h3>
          <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
        </div>
        <div class="modal-body">
          <form id="product-form">
            <div class="form-row">
              <div class="form-group">
                <label>Product Name (EN) *</label>
                <input name="name_en" value="${esc(p?.name_en || '')}" required>
              </div>
              <div class="form-group">
                <label>Product Name (AR)</label>
                <input name="name_ar" value="${esc(p?.name_ar || '')}">
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
                  ${categories.map(c => `<option value="${esc(c)}" ${p?.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
                  <option value="keycase" ${p?.category === 'keycase' ? 'selected' : ''}>Key Case</option>
                  <option value="keyholder" ${p?.category === 'keyholder' ? 'selected' : ''}>Key Holder</option>
                  <option value="medal" ${p?.category === 'medal' ? 'selected' : ''}>Medal</option>
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
            <div class="form-group">
              <label>Description (EN)</label>
              <textarea name="description_en" rows="3">${esc(p?.description_en || '')}</textarea>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Price (EGP) *</label>
                <input name="price" type="number" value="${p?.price || 0}" min="0" required>
              </div>
              <div class="form-group">
                <label>Sale Price (EGP)</label>
                <input name="sale_price" type="number" value="${p?.sale_price || ''}" min="0">
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Stock</label>
                <input name="stock" type="number" value="${p?.stock || 0}" min="0">
              </div>
              <div class="form-group">
                <label>Discount %</label>
                <input name="discount_pct" type="number" value="${p?.discount_pct || 0}" min="0" max="100">
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Main Image URL</label>
                <input name="main_image" value="${esc(p?.main_image || '')}" placeholder="/img/uploads/...">
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
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;">
                <input type="checkbox" name="featured" ${p?.featured ? 'checked' : ''}> Featured
              </label>
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;">
                <input type="checkbox" name="new_arrival" ${p?.new_arrival ? 'checked' : ''}> New Arrival
              </label>
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;">
                <input type="checkbox" name="hero_product" ${p?.hero_product ? 'checked' : ''}> Hero Product
              </label>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button class="btn btn-primary" id="btn-save-product">${p ? 'Update' : 'Create'} Product</button>
        </div>
      </div>`);

    $('#btn-save-product').addEventListener('click', async () => {
      const form = $('#product-form');
      const data = {
        id: p?.id || uid('prod'),
        name_en: form.querySelector('[name=name_en]').value.trim(),
        name_ar: form.querySelector('[name=name_ar]').value.trim(),
        slug: form.querySelector('[name=slug]').value.trim() || form.querySelector('[name=name_en]').value.trim().toLowerCase().replace(/\s+/g, '-'),
        category: form.querySelector('[name=category]').value,
        brandSlug: form.querySelector('[name=brandSlug]').value,
        description_en: form.querySelector('[name=description_en]').value.trim(),
        sku: form.querySelector('[name=sku]').value.trim(),
        price: parseFloat(form.querySelector('[name=price]').value) || 0,
        sale_price: parseFloat(form.querySelector('[name=sale_price]').value) || null,
        stock: parseInt(form.querySelector('[name=stock]').value) || 0,
        discount_pct: parseFloat(form.querySelector('[name=discount_pct]').value) || 0,
        main_image: form.querySelector('[name=main_image]').value.trim(),
        active: form.querySelector('[name=active]').checked,
        featured: form.querySelector('[name=featured]').checked,
        new_arrival: form.querySelector('[name=new_arrival]').checked,
        hero_product: form.querySelector('[name=hero_product]').checked,
        images: p?.images || [],
        keyShapes: p?.keyShapes || [],
        order: p?.order || 0,
      };

      if (!data.name_en || !data.category || !data.brandSlug) {
        toast('Please fill required fields', 'error');
        return;
      }

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

  function bindCategories() {
    const addBtn = $('#btn-add-category');
    if (addBtn) addBtn.addEventListener('click', () => {
      showModal(`
        <div class="modal">
          <div class="modal-header"><h3>Add Category</h3><button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button></div>
          <div class="modal-body">
            <form id="cat-form">
              <div class="form-group"><label>Name (EN) *</label><input name="name_en" required></div>
              <div class="form-group"><label>Slug *</label><input name="slug" required></div>
              <div class="form-group"><label>Description</label><textarea name="description_en" rows="3"></textarea></div>
            </form>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
            <button class="btn btn-primary" id="btn-save-cat">Create Category</button>
          </div>
        </div>`);
      $('#btn-save-cat').addEventListener('click', async () => {
        const form = $('#cat-form');
        const data = {
          id: uid('cat'),
          name_en: form.querySelector('[name=name_en]').value.trim(),
          slug: form.querySelector('[name=slug]').value.trim(),
          description_en: form.querySelector('[name=description_en]').value.trim(),
          active: true,
          product_count: 0,
          order: (state.data.categories || []).length,
        };
        if (!data.name_en || !data.slug) { toast('Fill required fields', 'error'); return; }
        try {
          await sbInsert('categories', data);
          if (!state.data.categories) state.data.categories = [];
          state.data.categories.push(data);
          toast('Category created', 'success');
          closeAllModals();
          render();
        } catch (e) { toast('Failed: ' + e.message, 'error'); }
      });
    });

    $$('[data-delete-cat]').forEach(el => el.addEventListener('click', () => {
      const id = el.dataset.deleteCat;
      showConfirm('Delete Category', 'Are you sure? This cannot be undone.', async () => {
        try {
          await sbDelete('categories', id);
          state.data.categories = (state.data.categories || []).filter(x => x.id !== id);
          toast('Category deleted', 'success');
          render();
        } catch (e) { toast('Failed', 'error'); }
      });
    }));
  }

  function bindBrands() {
    const addBtn = $('#btn-add-brand');
    if (addBtn) addBtn.addEventListener('click', () => {
      showModal(`
        <div class="modal">
          <div class="modal-header"><h3>Add Brand</h3><button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button></div>
          <div class="modal-body">
            <form id="brand-form">
              <div class="form-group"><label>Brand Name (EN) *</label><input name="name_en" required></div>
              <div class="form-group"><label>Slug *</label><input name="slug" required></div>
              <div class="form-group"><label>Logo URL</label><input name="logo" placeholder="/img/brands/..."></div>
              <div class="form-group"><label>Description</label><textarea name="description_en" rows="3"></textarea></div>
            </form>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
            <button class="btn btn-primary" id="btn-save-brand">Create Brand</button>
          </div>
        </div>`);
      $('#btn-save-brand').addEventListener('click', async () => {
        const form = $('#brand-form');
        const data = {
          id: uid('brand'),
          name_en: form.querySelector('[name=name_en]').value.trim(),
          slug: form.querySelector('[name=slug]').value.trim(),
          logo: form.querySelector('[name=logo]').value.trim(),
          description_en: form.querySelector('[name=description_en]').value.trim(),
          active: true,
          product_count: 0,
          order: (state.data.brands || []).length,
        };
        if (!data.name_en || !data.slug) { toast('Fill required fields', 'error'); return; }
        try {
          await sbInsert('brands', data);
          state.data.brands.push(data);
          toast('Brand created', 'success');
          closeAllModals();
          render();
        } catch (e) { toast('Failed: ' + e.message, 'error'); }
      });
    });

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

  function showOrderDetail(id) {
    const o = state.data.orders.find(x => x.id === id);
    if (!o) return;

    showModal(`
      <div class="modal" style="max-width:700px;">
        <div class="modal-header">
          <h3>Order ${esc(o.id)}</h3>
          <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
        </div>
        <div class="modal-body">
          <div class="order-detail-grid">
            <div class="detail-section">
              <h4>Customer</h4>
              <p><strong>${esc(o.customer?.fullName || '—')}</strong></p>
              <p>📞 ${esc(o.customer?.phone || '—')}</p>
              <p>📧 ${esc(o.customer?.email || '—')}</p>
              <p>📍 ${esc(o.customer?.address || '—')}${o.customer?.city ? ', ' + esc(o.customer.city) : ''}</p>
            </div>
            <div class="detail-section">
              <h4>Order Info</h4>
              <p>📅 ${fmtDateTime(o.createdAt)}</p>
              <p>💳 ${esc(o.payment || 'Cash on Delivery')}</p>
              <p>Status: ${statusBadge(o.status)}</p>
            </div>
          </div>
          <h4 style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin:20px 0 10px;">Items</h4>
          <table class="data-table" style="font-size:12px;">
            <thead><tr><th>Product</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
            <tbody>
              ${(o.items || []).map(it => `<tr>
                <td>${esc(it.name_en || it.productId)}</td>
                <td>${it.qty}</td>
                <td>${money(it.price)}</td>
                <td><strong>${money(it.lineTotal || it.price * it.qty)}</strong></td>
              </tr>`).join('')}
            </tbody>
          </table>
          <div style="margin-top:16px;text-align:right;">
            <p style="font-size:13px;color:var(--text-secondary);">Subtotal: ${money(o.subtotal)}</p>
            ${o.bundleDiscount ? `<p style="font-size:13px;color:var(--success);">Bundle Discount: −${money(o.bundleDiscount)}</p>` : ''}
            <p style="font-size:13px;color:var(--text-secondary);">Delivery: ${o.deliveryFee ? money(o.deliveryFee) : 'Free'}</p>
            <p style="font-size:18px;font-weight:700;margin-top:8px;">Total: ${money(o.total)}</p>
          </div>
          <div class="form-group" style="margin-top:20px;">
            <label>Change Status</label>
            <select id="order-status-select">
              ${['New','Pending','Confirmed','Processing','Shipped','Delivered','Cancelled'].map(s => `<option value="${s}" ${o.status === s ? 'selected' : ''}>${s}</option>`).join('')}
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
        const updates = {
          status: newStatus,
          statusHistory: [...(o.statusHistory || []), { status: newStatus, at: new Date().toISOString() }],
        };
        await sbUpdate('orders', id, updates);
        o.status = newStatus;
        o.statusHistory = updates.statusHistory;
        toast('Order status updated', 'success');
        closeAllModals();
        render();
      } catch (e) { toast('Failed to update', 'error'); }
    });
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

  function bindPackages() {
    const addBtn = $('#btn-add-package');
    if (addBtn) addBtn.addEventListener('click', () => {
      const brands = state.data.brands || [];
      showModal(`
        <div class="modal">
          <div class="modal-header"><h3>Add Package/Bundle</h3><button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button></div>
          <div class="modal-body">
            <form id="package-form">
              <div class="form-group"><label>Brand *</label><select name="brandSlug" required><option value="">Select brand</option>${brands.map(b => `<option value="${esc(b.slug)}">${esc(b.name_en)}</option>`).join('')}</select></div>
              <div class="form-row">
                <div class="form-group"><label>Bundle Price (EGP) *</label><input name="bundlePrice" type="number" min="0" required></div>
                <div class="form-group"><label>Regular Total (EGP)</label><input name="normalTotal" type="number" min="0" value="0"></div>
              </div>
            </form>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
            <button class="btn btn-primary" id="btn-save-package">Create Package</button>
          </div>
        </div>`);
      $('#btn-save-package').addEventListener('click', async () => {
        const form = $('#package-form');
        const data = {
          id: uid('bundle'),
          brandSlug: form.querySelector('[name=brandSlug]').value,
          bundlePrice: parseFloat(form.querySelector('[name=bundlePrice]').value) || 0,
          normalTotal: parseFloat(form.querySelector('[name=normalTotal]').value) || 0,
          active: true,
          order: (state.data.bundles || []).length,
        };
        if (!data.brandSlug || !data.bundlePrice) { toast('Fill required fields', 'error'); return; }
        try {
          await sbInsert('bundles', data);
          state.data.bundles.push(data);
          toast('Package created', 'success');
          closeAllModals();
          render();
        } catch (e) { toast('Failed: ' + e.message, 'error'); }
      });
    });

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

  function bindContent() {
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
              if (ok && j?.url) {
                const imgData = { id: uid('img'), name: file.name, url: j.url, section: 'general' };
                if (!state.data.website_images) state.data.website_images = [];
                state.data.website_images.push(imgData);
                toast('Image uploaded', 'success');
                render();
              }
            } catch (err) { toast('Upload failed', 'error'); }
          };
          reader.readAsDataURL(file);
        }
      });
    }

    $$('[data-delete-image]').forEach(el => el.addEventListener('click', () => {
      const id = el.dataset.deleteImage;
      showConfirm('Delete Image', 'This image will be removed.', async () => {
        state.data.website_images = (state.data.website_images || []).filter(x => x.id !== id);
        toast('Image removed', 'success');
        render();
      }, 'Delete');
    }));
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
      const settings = {
        shopName: $('#s-name').value.trim() || 'Spinto',
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
      render();
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
              render();
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
