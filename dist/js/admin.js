/* ==========================================================================
   VELOCCI — Admin panel (single-file client)
   Fully wired to the shared store via /api/admin/*. Every change is persisted
   and immediately reflected on the live customer site (same data source).
   ========================================================================== */
(function () {
  'use strict';
  const $ = (s, root) => (root || document).querySelector(s);
  const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));
  const host = () => $('#admin');

  const state = { data: null, view: 'dashboard', editor: null, mode: 'list' };
  const MARK_OPTS = ['star3','roundel','rings','shield','oval','lexus','toyota','jeep','vw','volvo','ford','honda','hyundai','kia','tesla','trident','horse','bull','bentley'];

  const esc = (s) => VEL.esc(s);
  const money = (n) => 'EGP ' + Math.round(n || 0).toLocaleString('en-US');

  function fld(obj, base, lang) {
    if (!obj) return '';
    const loc = obj[base + '_' + lang];
    if (loc && String(loc).trim()) return loc;
    return obj[base + '_en'] || '';
  }

  // ---------------------------------------------------------------- API
  function api(method, url, body) {
    return fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(r => r.json().then(j => ({ ok: r.ok, j })));
  }

  function notify(msg, kind) {
    let w = $('#toast-wrap');
    if (!w) { w = document.createElement('div'); w.className = 'toast-wrap'; w.id = 'toast-wrap'; document.body.appendChild(w); }
    const t = document.createElement('div'); t.className = 'toast ' + (kind === 'gold' ? 'gold' : ''); t.textContent = msg;
    w.appendChild(t); setTimeout(() => t.remove(), 2400);
  }

  // ---------------------------------------------------------------- AUTH
  function checkAuth() {
    api('GET', '/api/admin/session').then(({ ok, j }) => {
      if (j && j.authenticated) { loadData(); } else renderLogin();
    });
  }
  function renderLogin() {
    host().innerHTML = `<div class="login-wrap"><form class="login-card" id="login-form">
      <div class="logo"><span>V</span>ELOCCI</div>
      <div class="field"><label>Admin password</label><input name="password" type="password" autofocus></div>
      <button class="btn btn-dark btn-block" type="submit">Sign in</button>
      <div class="err" id="login-err"></div>
    </form></div>`;
    $('#login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const p = new FormData(e.target).get('password');
      api('POST', '/api/admin/login', { password: p }).then(({ ok }) => {
        if (ok) { loadData(); } else { $('#login-err').textContent = 'Invalid password.'; }
      });
    });
  }

  function loadData() {
    api('GET', '/api/admin/data').then(({ j }) => { state.data = j; render(); });
  }

  // ---------------------------------------------------------------- LAYOUT
  const NAV = [
    ['dashboard', 'Dashboard', 'M3 13h18M3 6h18M3 20h18'],
    ['products', 'Products', 'M16 11l-6-6H4v12a2 2 0 0 0 2 2h10m-4-8a2 2 0 1 1 4 0 2 2 0 0 1-4 0'],
    ['brands', 'Brands', 'M12 2l9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 17l9 5 9-5'],
    ['bundles', 'Bundles', 'M17 3H7a2 2 0 0 0-2 2v2m0 0l-2 3v4l2 3v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2l2-3v-4l-2-3m-4 0H9'],
    ['fitment', 'Fitment', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-12v4l3 2'],
    ['hero', 'Homepage', 'M3 5h18M3 5v14h18V5M3 9h18'],
    ['orders', 'Orders', 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01'],
    ['preorders', 'Pre-orders', 'M12 8v4h3M12 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z'],
    ['messages', 'Messages', 'M4 4h16v12H7l-3 3V4z'],
    ['settings', 'Settings', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8-3a8 8 0 0 1-.3 2l2 1.5-2 3.5-2.3-1a8 8 0 0 1-1.7 1l-.3 2.5h-4l-.3-2.5a8 8 0 0 1-1.7-1L7 18l-2-3.5 2-1.5a8 8 0 0 1 0-4L5 7.5 7 4l2.3 1a8 8 0 0 1 1.7-1l.3-2.5h4l.3 2.5a8 8 0 0 1 1.7 1L18 4l2 3.5-2 1.5c.2.6.3 1.3.3 2z']
  ];

  function render() {
    if (!state.data) return;
    if (state.mode === 'editor' && state.editor) { renderEditor(); return; }
    host().innerHTML = `<div class="layout">
      <aside class="sidebar">
        <div class="brand"><span>${VEL.brandEmblem('star3', { size: 30, accent: VEL.gold })}</span><span><span class="word">VELOCCI</span><span class="sub">ADMIN</span></span></div>
        <nav>${NAV.map(n => `<a href="#" data-view="${n[0]}" class="${state.view === n[0] ? 'active' : ''}"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${n[2]}</svg></span> ${n[1]}</a>`).join('')}</nav>
        <button class="logout" id="logout">← Sign out</button>
      </aside>
      <main class="main" id="main">${viewHTML()}</main>
    </div>
    <div class="toast-wrap" id="toast-wrap"></div>`;
    bindNav();
  }

  function bindNav() {
    $$('[data-view]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); state.view = a.getAttribute('data-view'); state.mode = 'list'; state.editor = null; render(); }));
    $('#logout').addEventListener('click', () => api('POST', '/api/admin/logout', {}).then(() => renderLogin()));
    bindView();
  }

  function viewHTML() {
    switch (state.view) {
      case 'dashboard': return dashboardHTML();
      case 'products': return productsHTML();
      case 'brands': return brandsHTML();
      case 'bundles': return bundlesHTML();
      case 'fitment': return fitmentHTML();
      case 'hero': return heroHTML();
      case 'orders': return ordersHTML();
      case 'preorders': return preordersHTML();
      case 'messages': return messagesHTML();
      case 'settings': return settingsHTML();
    }
    return '';
  }

  // ------------------------------------------------------------- DASHBOARD
  function dashboardHTML() {
    const d = state.data;
    const activeOrders = d.orders.filter(o => o.status !== 'Cancelled');
    const revenue = activeOrders.reduce((s, o) => s + (o.total || 0), 0);
    const lowStock = d.products.filter(p => !p.outOfStock && p.inventory <= 5);
    const pending = d.orders.filter(o => o.status === 'Pending' || o.status === 'New').length;
    const recent = d.orders.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8);
    return `<div class="main-head"><h1>Dashboard</h1></div>
      <div class="cards">
        <div class="card"><div class="k">Total Sales Revenue</div><div class="v gold">${money(revenue)}</div><div class="sub2">${activeOrders.length} paid orders</div></div>
        <div class="card"><div class="k">Total Orders</div><div class="v">${d.orders.length}</div><div class="sub2">${pending} pending</div></div>
        <div class="card"><div class="k">Products</div><div class="v">${d.products.length}</div><div class="sub2">${d.brands.length} brands</div></div>
        <div class="card"><div class="k">Low Stock</div><div class="v" style="color:${lowStock.length ? 'var(--danger)' : 'var(--green)'}">${lowStock.length}</div><div class="sub2">items ${lowStock.length ? 'need attention' : 'all healthy'}</div></div>
      </div>
      <div class="panel"><div class="phead"><h2>Recent Orders</h2></div>
        <table><thead><tr><th>Order</th><th>Customer</th><th>Total</th><th>Status</th><th>Date</th></tr></thead>
        <tbody>${recent.map(o => `<tr><td><b>${esc(o.id)}</b></td><td>${esc(o.customer.fullName)}</td><td>${money(o.total)}</td><td><span class="status-pill status-${o.status}">${esc(o.status)}</span></td><td>${fmtDate(o.createdAt)}</td></tr>`).join('') || '<tr><td colspan="5">No orders yet.</td></tr>'}</tbody></table>
      </div>`;
  }
  function fmtDate(iso) { try { return new Date(iso).toLocaleString(); } catch (e) { return iso; } }

  // ------------------------------------------------------------- PRODUCTS
  function productsHTML() {
    const d = state.data;
    const rows = d.products.slice().sort((a, b) => (a.order||0) - (b.order||0));
    return `<div class="main-head"><h1>Products (${d.products.length})</h1><div class="actions"><a class="btn btn-gold" href="#" id="add-product">+ Add Product</a></div></div>
      <div class="panel"><table>
        <thead><tr><th></th><th>Product</th><th>Brand</th><th>Category</th><th>Price</th><th>Stock</th><th>Flags</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map(p => {
          const b = d.brands.find(x => x.slug === p.brandSlug);
          const flags = [p.featured ? 'Featured' : '', p.bestSeller ? 'Best' : '', p.newArrival ? 'New' : '', p.limitedEdition ? 'Limited' : '', p.preorder ? 'Pre-order' : ''].filter(Boolean).map(f => `<span class="tag gray">${f}</span>`).join(' ');
          return `<tr>
            <td><img src="${img(p)}"></td>
            <td><b>${esc(p.name_en)}</b><div class="stat-hint">${esc(p.name_ar)}</div></td>
            <td>${esc(b ? b.name_en : p.brandSlug)}</td>
            <td><span class="tag gold">${p.category}</span></td>
            <td><b>${money(p.price)}</b>${p.oldPrice ? `<div class="stat-hint" style="text-decoration:line-through">${money(p.oldPrice)}</div>` : ''}</td>
            <td>${lowStockBadge(p)}</td>
            <td>${flags}</td>
            <td>${p.active ? '<span class="tag green">Active</span>' : '<span class="tag red">Hidden</span>'}${p.outOfStock ? ' <span class="tag red">OOS</span>' : ''}</td>
            <td><button class="btn btn-outline btn-sm" data-edit="${p.id}">Edit</button> <button class="btn btn-danger btn-sm" data-del="${p.id}">Del</button></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>`;
  }
  function img(p) { return (p.images && p.images[0]) || '/img/asset.svg?type=keycase&brand=' + (p.brandSlug || ''); }
  function lowStockBadge(p) {
    if (p.outOfStock) return '<span class="tag red">OOS</span>';
    return p.inventory <= 5 ? `<span class="tag red">${p.inventory} left</span>` : `<span class="tag green">${p.inventory}</span>`;
  }

  function productForm(p, isNew) {
    const d = state.data;
    const brandOpts = d.brands.map(b => `<option value="${b.slug}" ${p && p.brandSlug === b.slug ? 'selected' : ''}>${esc(b.name_en)}</option>`).join('');
    const shapes = (p && p.keyShapes) ? p.keyShapes : [{ shape: 'A', available: true }, { shape: 'B', available: true }, { shape: 'C', available: true }, { shape: 'D', available: false }];
    const shapeRows = shapes.map(s => `<div class="form-grid" style="grid-template-columns:70px 1fr auto;align-items:center;gap:8px;margin-bottom:6px">
        <div class="field"><input name="shape_${s.shape}" type="text" value="${s.shape}" readonly style="text-align:center"></div>
        <label class="toggle" style="padding-top:4px"><input type="checkbox" name="shapeok_${s.shape}" ${s.available ? 'checked' : ''}> ${s.available ? '' : ''}<span>${s.available ? 'In stock' : 'Out of stock'}</span></label>
        <span class="stat-hint" data-stocklbl="${s.shape}" style="${s.available ? '' : 'color:var(--danger)'}">${s.available ? 'Available' : 'Unavailable'}</span>
      </div>`).join('');
    return `<div class="form-grid">
      <div class="field"><label>Product name — EN</label><input name="name_en" value="${esc(p.name_en || '')}"></div>
      <div class="field"><label>Product name — AR</label><input name="name_ar" value="${esc(p.name_ar || '')}"></div>
      <div class="field full"><label>Description — EN</label><textarea name="description_en">${esc(p.description_en || '')}</textarea></div>
      <div class="field full"><label>Description — AR</label><textarea name="description_ar">${esc(p.description_ar || '')}</textarea></div>
      <div class="field"><label>Short — EN</label><input name="short_en" value="${esc(p.short_en || '')}"></div>
      <div class="field"><label>Short — AR</label><input name="short_ar" value="${esc(p.short_ar || '')}"></div>
      <div class="field"><label>Price (EGP)</label><input name="price" type="number" step="1" value="${p.price || ''}"></div>
      <div class="field"><label>Old price (EGP)</label><input name="oldPrice" type="number" step="1" value="${p.oldPrice || ''}"></div>
      <div class="field"><label>Category</label><select name="category">
        <option value="keycase" ${p.category === 'keycase' ? 'selected' : ''}>Key Case</option>
        <option value="keyholder" ${p.category === 'keyholder' ? 'selected' : ''}>Key Holder</option>
        <option value="medal" ${p.category === 'medal' ? 'selected' : ''}>Car Medal</option>
      </select></div>
      <div class="field"><label>Car Brand</label><select name="brandSlug">${brandOpts}</select></div>
      <div class="field"><label>Models (comma separated, e.g. C-Class, E-Class)</label><input name="models" value="${esc((p.models || []).join(', '))}"></div>
      <div class="field"><label>Years (comma separated)</label><input name="years" value="${esc((p.years || []).join(', '))}"></div>
      <div class="field full"><label>Vehicle compatibility (exact fits)</label>
        <div id="vehicle-list">${vehicleRows(p)}</div>
        <button type="button" class="btn btn-outline btn-sm" id="add-vehicle" style="margin-top:6px">+ Add Vehicle</button>
        <div class="hint">Assign the exact car brands, models and years this product is compatible with. Shown on the product page as “Compatible Vehicles”.</div>
      </div>
      <div class="field full"><label>Specifications (bilingual)</label>
        <div id="spec-list">${specRows(p)}</div>
        <button type="button" class="btn btn-outline btn-sm" id="add-spec" style="margin-top:6px">+ Add Specification</button>
        <div class="hint">Custom key/value specs shown on the product page (e.g. Material, Weight).</div>
      </div>
      <div class="field full"><label>Images (one URL per line)</label>
        <div style="display:flex;gap:10px;align-items:stretch"><textarea name="images" rows="3" style="flex:1">${esc((p.images || []).join('\n'))}</textarea><button type="button" class="btn btn-outline" id="product-upload" style="align-self:flex-end">Upload…</button></div>
        <div class="hint">Leave blank to auto-generate premium artwork, or upload to add an image URL.</div>
      </div>
      <div class="field full"><label>Key shapes</label>${shapeRows}</div>
      <div class="field"><label>Inventory</label><input name="inventory" type="number" value="${p.inventory != null ? p.inventory : ''}"></div>
      <div class="field"><label>Badge — EN</label><input name="badge_en" value="${esc(p.badge_en || '')}"></div>
      <div class="field"><label>Badge — AR</label><input name="badge_ar" value="${esc(p.badge_ar || '')}"></div>
      <div class="field"><label>Material — EN</label><input name="material_en" value="${esc(p.material_en || '')}"></div>
      <div class="field"><label>Material — AR</label><input name="material_ar" value="${esc(p.material_ar || '')}"></div>
      <div class="field"><label>Warranty — EN</label><input name="warranty_en" value="${esc(p.warranty_en || '')}"></div>
      <div class="field"><label>Warranty — AR</label><input name="warranty_ar" value="${esc(p.warranty_ar || '')}"></div>
      <div class="field full"><div style="display:flex;flex-wrap:wrap;gap:14px;padding-top:6px">
        ${[[ 'heroProduct','Hero Products' ],[ 'featured','Featured' ],[ 'bestSeller','Best Seller' ],[ 'newArrival','New Arrival' ],[ 'limitedEdition','Limited Edition' ],[ 'preorder','Pre-Order' ],[ 'outOfStock','Out of Stock' ],[ 'active','Active' ]].map(f => `<label class="toggle"><input type="checkbox" name="${f[0]}" ${p[f[0]] ? 'checked' : ''}> ${f[1]}</label>`).join('')}
      </div></div>
    </div>`;
  }

  function openProductEditor(p) {
    state.editor = { type: 'product', record: p || defaultProduct(), isNew: !p && true };
    state.mode = 'editor'; renderEditor();
  }

  // ---- dynamic row builders for the product form ---------------------------
  function vehicleRows(p) {
    const d = state.data;
    const vehicles = (p && p.vehicles && p.vehicles.length) ? p.vehicles : [];
    if (!vehicles.length) return `<div class="empty-rows" id="vehicle-empty">No vehicles assigned yet.</div>`;
    return vehicles.map((v, i) => {
      const brandSel = d.brands.map(b => `<option value="${b.slug}" ${v.brand === b.slug ? 'selected' : ''}>${esc(b.name_en)}</option>`).join('');
      // model options for the selected brand
      const br = d.brands.find(x => x.slug === v.brand);
      const modelOpts = (br && br.models || []).map(m => `<option value="${esc(m.en)}" ${v.model === m.en ? 'selected' : ''}>${esc(m.en)}</option>`).join('');
      return `<div class="repeater-row" data-i="${i}">
        <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr auto;gap:8px;align-items:end">
          <div class="field"><label>Brand</label><select data-vbrand="${i}">${brandSel}</select></div>
          <div class="field"><label>Model</label><select data-vmodel="${i}">${modelOpts}</select></div>
          <div class="field"><label>Year</label><input data-vyear="${i}" type="text" value="${esc(v.year)}" placeholder="2022"></div>
          <button type="button" class="btn btn-danger btn-sm" data-delvehicle="${i}">×</button>
        </div>
      </div>`;
    }).join('');
  }
  function specRows(p) {
    const specs = (p && p.specs) ? p.specs : [];
    if (!specs.length) return `<div class="empty-rows" id="spec-empty">No specifications yet.</div>`;
    return specs.map((s, i) => `<div class="repeater-row" data-i="${i}">
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr 1fr auto;gap:8px;align-items:end">
        <div class="field"><label>Label — EN</label><input data-sl_en="${i}" value="${esc(s.label_en || '')}"></div>
        <div class="field"><label>Label — AR</label><input data-sl_ar="${i}" value="${esc(s.label_ar || '')}"></div>
        <div class="field"><label>Value — EN</label><input data-sv_en="${i}" value="${esc(s.value_en || '')}"></div>
        <div class="field"><label>Value — AR</label><input data-sv_ar="${i}" value="${esc(s.value_ar || '')}"></div>
        <button type="button" class="btn btn-danger btn-sm" data-delspec="${i}">×</button>
      </div>
    </div>`).join('');
  }
  function defaultProduct() {
    return { id: 'p_' + Date.now().toString(36), slug: '', category: 'keycase', brandSlug: (state.data.brands[0] && state.data.brands[0].slug) || '', name_en: '', name_ar: '', description_en: '', description_ar: '', price: 1450, oldPrice: null, inventory: 8, active: true, images: [], keyShapes: [{ shape: 'A', available: true }, { shape: 'B', available: true }, { shape: 'C', available: true }, { shape: 'D', available: false }], models: [], years: [], specs: [], vehicles: [] };
  }

  function renderEditor() {
    const e = state.editor; const d = state.data;
    let headTitle = '', body = '', foot = '';
    if (e.type === 'product') {
      const isNew = !!e.isNew;
      headTitle = (isNew ? 'Add' : 'Edit') + ' Product';
      body = productForm(e.record, isNew);
      foot = `<button class="btn btn-outline" id="ed-cancel">Cancel</button><button class="btn btn-gold" id="ed-save">Save Product</button>`;
    } else if (e.type === 'brand') {
      const isNew = !!e.isNew;
      headTitle = (isNew ? 'Add' : 'Edit') + ' Brand';
      body = brandForm(e.record, isNew);
      foot = `<button class="btn btn-outline" id="ed-cancel">Cancel</button><button class="btn btn-gold" id="ed-save">Save Brand</button>`;
    } else if (e.type === 'bundle') {
      headTitle = 'Edit Bundle';
      body = bundleForm(e.record);
      foot = `<button class="btn btn-outline" id="ed-cancel">Cancel</button><button class="btn btn-gold" id="ed-save">Save Bundle</button>`;
    } else if (e.type === 'hero') {
      headTitle = e.isNew ? 'Add Slide' : 'Edit Slide';
      body = heroForm(e.record);
      foot = `<button class="btn btn-outline" id="ed-cancel">Cancel</button><button class="btn btn-gold" id="ed-save">Save Slide</button>`;
    }
    host().innerHTML = `<div class="editor open"><div class="ehead"><h3>${headTitle}</h3><button class="eclose" id="ed-close">×</button></div>
      <div class="ebody"><form id="editor-form">${body}</form></div>
      <div class="efoot">${foot}</div></div>`;
    $('#ed-close').addEventListener('click', closeEditor);
    $('#ed-cancel').addEventListener('click', closeEditor);
    $('#ed-save').addEventListener('click', () => saveEditor());
    bindEditorExtras();
  }
  function closeEditor() { state.mode = 'list'; state.editor = null; render(); }

  function saveEditor() {
    const e = state.editor; const form = $('#editor-form'); const f = new FormData(form);
    let record;
    if (e.type === 'product') {
      const shapes = ['A', 'B', 'C', 'D'].map(sh => ({ shape: sh, available: f.get('shapeok_' + sh) === 'on' }));
      const images = String(f.get('images') || '').split('\n').map(s => s.trim()).filter(Boolean);
      record = Object.assign({}, e.record, {
        slug: e.record.slug || (e.record.brandSlug + '-' + (String(f.get('name_en') || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))),
        specs: collectSpecs(),
        vehicles: collectVehicles(),
        name_en: f.get('name_en'), name_ar: f.get('name_ar'),
        description_en: f.get('description_en'), description_ar: f.get('description_ar'),
        short_en: f.get('short_en'), short_ar: f.get('short_ar'),
        price: +f.get('price') || 0, oldPrice: f.get('oldPrice') ? +f.get('oldPrice') : null,
        category: f.get('category'), brandSlug: f.get('brandSlug'),
        models: (f.get('models') || '').split(',').map(s => s.trim()).filter(Boolean),
        years: (f.get('years') || '').split(',').map(s => s.trim()).filter(Boolean),
        images: images.length ? images : autoImages(f.get('category'), f.get('brandSlug')),
        keyShapes: shapes,
        inventory: +f.get('inventory') || 0,
        badge_en: f.get('badge_en'), badge_ar: f.get('badge_ar'),
        material_en: f.get('material_en'), material_ar: f.get('material_ar'),
        warranty_en: f.get('warranty_en'), warranty_ar: f.get('warranty_ar'),
        discount: computeDiscount(f.get('price'), f.get('oldPrice')),
        heroProduct: f.get('heroProduct') === 'on',
        featured: f.get('featured') === 'on', bestSeller: f.get('bestSeller') === 'on',
        newArrival: f.get('newArrival') === 'on', limitedEdition: f.get('limitedEdition') === 'on',
        preorder: f.get('preorder') === 'on', outOfStock: f.get('outOfStock') === 'on',
        active: f.get('active') === 'on',
        order: e.record.order != null ? e.record.order : 99,
      });
      if (record.oldPrice == null) record.discount = 0;
      delete record.isNew;
      saveRecord('products', record);
    } else if (e.type === 'brand') {
      record = Object.assign({}, e.record, {
        name_en: f.get('name_en'), name_ar: f.get('name_ar'), mark: f.get('mark'),
        emblem: f.get('emblem'), tier: f.get('tier'), active: f.get('active') === 'on',
        models: parseModels(f),
        order: e.record.order != null ? e.record.order : 99,
      });
      delete record.isNew;
      saveRecord('brands', record);
    } else if (e.type === 'bundle') {
      const normalTotal = computeNormalTotalForBrand(e.record.brandSlug);
      const mode = f.get('discountMode') === 'fixed' ? 'fixed' : 'percent';
      let bundlePrice;
      if (mode === 'fixed') {
        const amt = parseInt(f.get('discountAmount')) || 0;
        bundlePrice = Math.max(0, normalTotal - amt);
      } else {
        const pct = parseFloat(f.get('discountPercent')) || 0;
        bundlePrice = Math.round(normalTotal * (1 - pct / 100));
      }
      const discount = Math.max(0, normalTotal - bundlePrice);
      record = Object.assign({}, e.record, {
        bundlePrice,
        active: f.get('active') === 'on',
        normalTotal,
        discount,
        discountPercent: normalTotal ? Math.round((discount / normalTotal) * 100) : 0,
        discountMode: mode,
      });
      saveRecord('bundles', record);
    } else if (e.type === 'hero') {
      record = Object.assign({}, e.record, {
        headline_en: f.get('headline_en'), headline_ar: f.get('headline_ar'),
        sub_en: f.get('sub_en'), sub_ar: f.get('sub_ar'),
        btn1_en: f.get('btn1_en'), btn1_ar: f.get('btn1_ar'), btn1_link: f.get('btn1_link'),
        btn2_en: f.get('btn2_en'), btn2_ar: f.get('btn2_ar'), btn2_link: f.get('btn2_link'),
        accent_en: f.get('accent_en'), accent_ar: f.get('accent_ar'),
        active: f.get('active') === 'on', order: e.record.order != null ? e.record.order : 99,
      });
      delete record.isNew;
      saveRecord('heroSlides', record);
    }
  }

  function computeDiscount(price, old) {
    if (!old || !price) return 0;
    return Math.max(0, Math.round((old - price) / old * 100));
  }
  function autoImages(cat, slug) {
    const t = cat === 'keycase' ? 'keycase' : cat === 'keyholder' ? 'keyholder' : 'medal';
    const style = cat === 'keycase' ? 'carbon' : '';
    return [`/img/asset.svg?type=${t}&brand=${slug}${style ? '&style=' + style : ''}`, `/img/asset.svg?type=detail-a&brand=${slug}`, `/img/asset.svg?type=detail-b&brand=${slug}`];
  }
  function computeNormalTotalForBrand(slug, override) {
    const ds = state.data; const caseP = ds.products.find(p => p.brandSlug === slug && p.category === 'keycase');
    const holderP = ds.products.find(p => p.brandSlug === slug && p.category === 'keyholder');
    const medalP = ds.products.find(p => p.brandSlug === slug && p.category === 'medal');
    return (caseP ? caseP.price : 0) + (holderP ? holderP.price : 0) + (medalP ? medalP.price : 0);
  }

  function saveRecord(collection, record) {
    api('POST', '/api/admin/save', { collection, record }).then(({ ok }) => {
      if (ok) {
        notify('Saved — live site updated', 'gold');
        state.mode = 'list'; state.editor = null;
        loadData();
      } else notify('Save failed');
    });
  }

  // ------------------------------------------------------------- BRANDS
  function brandsHTML() {
    const d = state.data;
    const rows = d.brands.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    return `<div class="main-head"><h1>Brands (${d.brands.length})</h1><div class="actions"><a class="btn btn-gold" href="#" id="add-brand">+ Add Brand</a></div></div>
      <div class="panel"><table>
        <thead><tr><th></th><th>Brand</th><th>Mark</th><th>Models</th><th>Products</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map(b => `<tr>
          <td><span class="badge">${VEL.brandEmblem(b.mark, { size: 26, accent: b.emblem })}</span></td>
          <td><b>${esc(b.name_en)}</b><div class="stat-hint">${esc(b.name_ar)}</div></td>
          <td><span class="tag gray">${b.mark}</span></td>
          <td>${b.models.length}</td>
          <td>${d.products.filter(p => p.brandSlug === b.slug).length}</td>
          <td>${b.active ? '<span class="tag green">Active</span>' : '<span class="tag red">Hidden</span>'}</td>
          <td><button class="btn btn-outline btn-sm" data-editb="${b.id}">Edit</button> <button class="btn btn-danger btn-sm" data-delbrand="${b.id}">Del</button> <span data-drag="${b.id}"></span></td>
        </tr>`).join('')}</tbody>
      </table></div>`;
  }

  function brandForm(b, isNew) {
    const models = (b && b.models) ? b.models : [];
    const modelRows = models.map((m, i) => `
      <div class="model-row" data-i="${i}" style="border:1px solid var(--line);border-radius:6px;padding:10px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center"><b>${esc(m.en || 'Model')}</b><button type="button" class="btn btn-danger btn-sm" data-delmodel="${i}">×</button></div>
        <div class="form-grid" style="grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
          <div class="field"><label>Model — EN</label><input name="men_${i}" value="${esc(m.en || '')}"></div>
          <div class="field"><label>Model — AR</label><input name="mar_${i}" value="${esc(m.ar || '')}"></div>
          <div class="field"><label>Years (e.g. 2018,2019,2020)</label><input name="myears_${i}" value="${esc((m.years || []).join(','))}"></div>
          <div class="field"><label>Key shapes (e.g. A,B)</label><input name="mshapes_${i}" value="${esc((m.shapes || []).join(','))}"></div>
        </div>
      </div>`).join('');
    return `<div class="form-grid">
      <div class="field"><label>Brand name — EN</label><input name="name_en" value="${esc(b.name_en || '')}"></div>
      <div class="field"><label>Brand name — AR</label><input name="name_ar" value="${esc(b.name_ar || '')}"></div>
      <div class="field"><label>Emblem mark</label><select name="mark">${MARK_OPTS.map(m => `<option value="${m}" ${b.mark === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
      <div class="field"><label>Emblem accent (hex)</label><input name="emblem" value="${esc(b.emblem || '')}"></div>
      <div class="field"><label>Tier</label><select name="tier"><option value="luxury" ${b.tier === 'luxury' ? 'selected' : ''}>Luxury</option><option value="mainstream" ${b.tier === 'mainstream' ? 'selected' : ''}>Mainstream</option><option value="ev" ${b.tier === 'ev' ? 'selected' : ''}>EV</option></select></div>
      <div class="field"><label>Active</label><div class="toggle" style="padding-top:8px"><input type="checkbox" name="active" ${b.active ? 'checked' : ''}> <span>Show on website</span></div></div>
      <div class="field full"><label>Models / fitment</label>
        <div id="model-list">${modelRows}</div>
        <button type="button" class="btn btn-outline btn-sm" id="add-model" style="margin-top:6px">+ Add Model</button>
      </div>
    </div>`;
  }

  // collect the dynamic spec rows into {label_en,label_ar,value_en,value_ar}
  function collectSpecs() {
    const rows = $$('#spec-list .repeater-row');
    return rows.map(r => {
      const i = r.getAttribute('data-i');
      return {
        label_en: ($('[data-sl_en="' + i + '"]', r) || {}).value || '',
        label_ar: ($('[data-sl_ar="' + i + '"]', r) || {}).value || '',
        value_en: ($('[data-sv_en="' + i + '"]', r) || {}).value || '',
        value_ar: ($('[data-sv_ar="' + i + '"]', r) || {}).value || '',
      };
    }).filter(s => (s.label_en && s.value_en) || (s.label_ar && s.value_ar));
  }
  // collect the dynamic vehicle rows into {brand, model, year}
  function collectVehicles() {
    const rows = $$('#vehicle-list .repeater-row');
    return rows.map(r => {
      const i = r.getAttribute('data-i');
      const brand = ($('[data-vbrand="' + i + '"]', r) || {}).value || '';
      const model = ($('[data-vmodel="' + i + '"]', r) || {}).value || '';
      const year = ($('[data-vyear="' + i + '"]', r) || {}).value || '';
      return { brand, model, year: year.trim() ? +year : null };
    }).filter(v => v.brand && v.model);
  }

  function parseModels(f) {
    const n = parseInt($('#model-count') ? $('#model-count').value : '0') || 0;
    const count = f.get('model_count') != null ? +f.get('model_count') : 0;
    // count model rows from their men_ fields
    const keys = Array.from(f.keys()).filter(k => k.startsWith('men_'));
    const idxs = keys.map(k => k.split('_')[1]);
    const models = [];
    const seen = new Set();
    idxs.forEach(i => {
      if (seen.has(i)) return; seen.add(i);
      const en = f.get('men_' + i) || '';
      if (!en.trim()) return;
      models.push({ en: en.trim(), ar: f.get('mar_' + i) || en.trim(), years: (f.get('myears_' + i) || '').split(',').map(s => s.trim()).filter(Boolean), shapes: (f.get('mshapes_' + i) || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean) });
    });
    return models;
  }

  function openBrandEditor(b) {
    state.editor = { type: 'brand', record: b || defaultBrand(), isNew: !b && true };
    state.mode = 'editor'; renderEditor();
  }
  function defaultBrand() {
    return { id: 'b_' + Date.now().toString(36), slug: '', name_en: '', name_ar: '', mark: 'default', emblem: '#C8A15A', tier: 'luxury', models: [{ en: '', ar: '', years: [2021, 2022, 2023], shapes: ['A', 'B'] }], active: true, order: 99 };
  }

  // ------------------------------------------------------------- BUNDLES
  function bundlesHTML() {
    const d = state.data;
    const rows = d.bundles.slice();
    return `<div class="main-head"><h1>Bundle Management</h1><div class="stat-hint">A matching set unlocks the bundle discount on the live site.</div></div>
      <div class="panel"><table>
        <thead><tr><th>Brand</th><th>Set</th><th>Normal</th><th>Bundle</th><th>Save</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map(b => {
          const br = d.brands.find(x => x.slug === b.brandSlug);
          return `<tr>
            <td><b>${esc(br ? br.name_en : b.brandSlug)}</b></td>
            <td><span class="stat-hint">${esc(prodName(b.keyCaseProductId))} + ${esc(prodName(b.keyHolderProductId))} + ${esc(prodName(b.medalProductId))}</span></td>
            <td>${money(b.normalTotal)}</td>
            <td><b class="tag gold">${money(b.bundlePrice)}</b></td>
            <td><span style="color:var(--gold-deep);font-weight:700">${money(b.discount)}</span> (${b.discountPercent}%)</td>
            <td>${b.active ? '<span class="tag green">Active</span>' : '<span class="tag red">Inactive</span>'}</td>
            <td><button class="btn btn-outline btn-sm" data-editbundle="${b.id}">Edit</button></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>`;
  }
  function prodName(id) { const p = state.data.products.find(x => x.id === id); return p ? p.name_en : ''; }
  function bundleForm(b) {
    const caseP = state.data.products.find(p => p.brandSlug === b.brandSlug && p.category === 'keycase');
    const holderP = state.data.products.find(p => p.brandSlug === b.brandSlug && p.category === 'keyholder');
    const medalP = state.data.products.find(p => p.brandSlug === b.brandSlug && p.category === 'medal');
    const normal = (caseP ? caseP.price : 0) + (holderP ? holderP.price : 0) + (medalP ? medalP.price : 0);
    const priorDiscount = Math.max(0, (b.normalTotal || normal) - (b.bundlePrice || normal));
    const mode = b.discountMode === 'fixed' ? 'fixed' : 'percent';
    const pct = +b.discountPercent || Math.round((priorDiscount / (normal || 1)) * 100) || 10;
    const amt = +b.discount || priorDiscount;
    return `<div id="bundle-form"><div class="form-grid">
      <div class="field full"><label>Car Brand</label><input value="${esc(b.brandSlug)}" disabled></div>
      <div class="field full"><div class="stat-hint">Set products (auto — based on brand):<br>Key Case: ${esc(caseP ? caseP.name_en : '—')} (${money(caseP ? caseP.price : 0)})<br>Key Holder: ${esc(holderP ? holderP.name_en : '—')} (${money(holderP ? holderP.price : 0)})<br>Medal: ${esc(medalP ? medalP.name_en : '—')} (${money(medalP ? medalP.price : 0)})</div></div>
      <div class="field"><label>Discount by</label><select name="discountMode"><option value="percent" ${mode === 'percent' ? 'selected' : ''}>Percentage (%)</option><option value="fixed" ${mode === 'fixed' ? 'selected' : ''}>Fixed amount (EGP)</option></select></div>
      <div class="field"><label id="discount-lbl">Discount (%)</label><input name="discountPercent" type="number" step="0.5" value="${pct}" id="bf-pct"></div>
      <div class="field full"><label>Discount amount (EGP) — used in Fixed mode</label><input name="discountAmount" type="number" value="${amt}" id="bf-amt"></div>
      <div class="field full"><div class="bundle-preview">Normal EGP ${money(normal)} → Bundle <b id="bf-preview">${money(b.bundlePrice || normal)}</b> · saves <span id="bf-save">${money(priorDiscount)}</span> (${b.discountPercent || Math.round((priorDiscount/(normal||1))*100)}%)</div></div>
      <div class="field"><label>Bundle discount</label><select name="active"><option value="on" ${b.active ? 'selected' : ''}>ON — show & apply</option><option value="off" ${!b.active ? 'selected' : ''}>OFF — hide & disable</option></select></div>
      <div class="field full"><div class="stat-hint">Toggling OFF hides the "Complete Your Set" cross-sell and disables the discount on the live site. The computed bundle price is what the customer pays for the full set.</div></div>
    </div></div>`;
  }
  function recalcBundlePreview() {
    const form = $('#bundle-form'); if (!form) return;
    const d = state.data;
    const slugEl = form.querySelector('input[value]'); // brand slug disabled input not ideal; read from editor record
    const slug = state.editor && state.editor.record.brandSlug;
    const caseP = d.products.find(p => p.brandSlug === slug && p.category === 'keycase');
    const holderP = d.products.find(p => p.brandSlug === slug && p.category === 'keyholder');
    const medalP = d.products.find(p => p.brandSlug === slug && p.category === 'medal');
    const normal = (caseP ? caseP.price : 0) + (holderP ? holderP.price : 0) + (medalP ? medalP.price : 0);
    const mode = form.querySelector('[name="discountMode"]').value;
    let bundle;
    if (mode === 'percent') {
      const pct = parseFloat(form.querySelector('[name="discountPercent"]').value) || 0;
      bundle = Math.round(normal * (1 - pct / 100));
    } else {
      const amt = parseInt(form.querySelector('[name="discountAmount"]').value) || 0;
      bundle = Math.max(0, normal - amt);
    }
    const save = Math.max(0, normal - bundle);
    const pctR = normal ? Math.round((save / normal) * 100) : 0;
    const pre = $('#bf-preview'); if (pre) pre.textContent = money(bundle);
    const sv = $('#bf-save'); if (sv) sv.textContent = money(save) + ' (' + pctR + '%)';
    const lbl = $('#discount-lbl'); if (lbl) lbl.textContent = mode === 'percent' ? 'Discount (%)' : 'Discount (EGP)';
  }

  // ---------------------------------------------------------------- IMAGE UPLOAD
  function fileToDataUrl(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); }
  function resizedDataUrl(dataUrl, maxW, maxH, quality) {
    return new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxW || h > maxH) { const r = Math.min(maxW / w, maxH / h); w = Math.round(w * r); h = Math.round(h * r); }
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        res(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => res(dataUrl);
      img.src = dataUrl;
    });
  }
  function uploadImage() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
    inp.addEventListener('change', () => {
      const file = inp.files[0]; if (!file) return;
      fileToDataUrl(file).then(du => resizedDataUrl(du, 1600, 900, 0.82)).then(cd => {
        api('POST', '/api/admin/upload', { dataUrl: cd }).then(({ ok, j }) => {
          if (ok && j.url) { notify('Image uploaded', 'gold'); completeUpload(j.url); } else notify('Upload failed');
        });
      });
    });
    inp.click();
  }
  function completeUpload(url) {
    const e = state.editor;
    if (!e) return;
    if (e.type === 'hero') {
      const inp = $('#editor-form [name="image"]'); if (inp) inp.value = url;
      const pv = $('#hero-preview'); if (pv) pv.innerHTML = `<img src="${esc(url)}" style="max-width:100%;max-height:130px;border-radius:6px;border:1px solid var(--line)">`;
    } else if (e.type === 'product') {
      const ta = $('#editor-form [name="images"]'); if (ta) { const cur = ta.value.trim(); ta.value = cur ? cur + '\n' + url : url; }
    }
  }

  // ------------------------------------------------------------- FITMENT
  function fitmentHTML() {
    const d = state.data;
    const rows = d.brands.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const oosShapes = d.products.reduce((acc, p) => { (p.keyShapes || []).forEach(s => { if (!s.available) (acc[p.brandSlug] = acc[p.brandSlug] || new Set()).add(s.shape); }); return acc; }, {});
    return `<div class="main-head"><h1>Fitment & Inventory</h1><div class="actions"><a class="btn btn-gold" href="#" id="fit-add-brand">+ Add Brand</a></div><div class="stat-hint">Manage brand → model → year → key-shape compatibility, and toggle each key shape's stock. Out-of-stock shapes become unclickable in the customer Fitment Finder instantly.</div></div>
      <div class="panel"><div style="overflow-x:auto"><table>
        <thead><tr><th>Brand</th><th>Models</th><th>Year range</th><th>Key shapes</th><th>OOS shapes</th><th>Compat. products</th><th></th></tr></thead>
        <tbody>${rows.map(b => {
          const totalYears = new Set(b.models.flatMap(m => m.years || []));
          const maxI = b.models.reduce((acc, m) => acc.concat(m.shapes || []), []);
          const oos = oosShapes[b.slug] ? [...oosShapes[b.slug]].sort().join(', ') : '';
          return `<tr>
            <td><b>${esc(b.name_en)}</b></td>
            <td>${b.models.map(m => esc(m.ar || m.en)).join(', ') || '—'}</td>
            <td>${[...totalYears].sort((x, y) => x - y).slice(0, 1).concat([[...totalYears].sort((x, y) => y - x).slice(0, 1)]).filter(Boolean).join(' – ') || '—'}</td>
            <td>${[...new Set(maxI)].sort().join(', ') || '—'}</td>
            <td>${oos ? `<span class="tag red">${oos}</span>` : '<span class="tag green">All in stock</span>'}</td>
            <td>${d.products.filter(p => p.brandSlug === b.slug).length}</td>
            <td><button class="btn btn-outline btn-sm" data-editb="${b.id}">Edit Fitment</button> <button class="btn btn-danger btn-sm" data-delbrand="${b.id}">Del</button></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div></div>`;
  }
  function deleteBrand(id) {
    const d = state.data;
    const b = d.brands.find(x => x.id === id);
    if (!b) return;
    const prodCount = d.products.filter(p => p.brandSlug === b.slug).length;
    const msg = `Delete "${b.name_en}"?${prodCount ? ` This will also delete its ${prodCount} product(s) and its bundle set.` : ''}`;
    if (!confirm(msg)) return;
    const tasks = [];
    d.products.filter(p => p.brandSlug === b.slug).forEach(p => tasks.push(api('POST', '/api/admin/delete', { collection: 'products', id: p.id })));
    const bundle = d.bundles.find(x => x.brandSlug === b.slug);
    if (bundle) tasks.push(api('POST', '/api/admin/delete', { collection: 'bundles', id: bundle.id }));
    Promise.all(tasks).then(() => api('POST', '/api/admin/delete', { collection: 'brands', id }).then(({ ok }) => { if (ok) notify('Brand deleted', 'gold'); loadData(); }));
  }

  // ------------------------------------------------------------- HERO / HOMEPAGE
  function heroHTML() {
    const d = state.data;
    const sections = d.homeSections.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const slides = d.heroSlides.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const brands = d.brands.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const products = d.products.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    return `<div class="main-head"><h1>Homepage</h1><div class="actions"><a class="btn btn-gold" href="#" id="add-slide">+ Add Slide</a></div></div>
      <div class="panel"><div class="phead"><h2>Hero slides (drag to reorder)</h2></div>
        <ul class="reorder-list" id="slides-sort">${slides.map(s => `<li data-id="${s.id}"><span class="handle">≡</span> <img src="${s.image}" style="width:64px;height:64px;object-fit:cover;border-radius:4px"> <span style="flex:1">${esc(fld(s, 'headline').replace(/\n/g, ' '))}</span> <span class="tag ${s.active ? 'green' : 'red'}">${s.active ? 'Active' : 'Hidden'}</span> <button class="btn btn-outline btn-sm" data-editsl="${s.id}">Edit</button></li>`).join('') || '<li>No slides.</li>'}
        </ul>
      </div>
      <div class="panel"><div class="phead"><h2>Car brand logos (drag to reorder)</h2></div>
        <ul class="reorder-list brand-reorder" id="brands-sort">${brands.map(b => `<li data-id="${b.id}"><span class="handle">≡</span> <span class="badge">${VEL.brandEmblem(b.mark, { size: 26, accent: b.emblem })}</span> <span style="flex:1">${esc(b.name_en)}</span> <span class="tag ${b.active ? 'green' : 'red'}">${b.active ? 'Visible' : 'Hidden'}</span></li>`).join('') || '<li>No brands.</li>'}
        </ul>
      </div>
      <div class="panel"><div class="phead"><h2>Homepage sections (drag to reorder)</h2></div>
        <ul class="reorder-list" id="sections-sort">${sections.map(s => `<li data-id="${s.id}"><span class="handle">≡</span> <span style="flex:1">${esc(s.title)}</span> <label class="toggle"><input type="checkbox" data-sec="${s.id}" ${s.enabled ? 'checked' : ''}> Enabled</label></li>`).join('')}</ul>
      </div>
      <div class="main-head" style="margin-top:10px"><h2 style="font-size:15px">Hero Products</h2></div>
      <div class="panel"><div class="stat-hint" style="padding:4px 0 2px">Toggle which products appear in the homepage "Hero Products" section. Select multiple products — they display as a product grid. Every change applies to the live site instantly.</div>
        <table><thead><tr><th>Product</th><th>Hero Products</th></tr></thead>
        <tbody>${products.map(p => { const oos = p.outOfStock ? ' <span class="tag red">OOS</span>' : ''; return `<tr><td><b>${esc(p.name_en)}</b>${oos}</td><td><input type="checkbox" class="feat-toggle" data-pid="${p.id}" data-flag="heroProduct" ${p.heroProduct ? 'checked' : ''}></td></tr>`; }).join('')}</tbody>
      </table></div>
      <div class="main-head" style="margin-top:10px"><h2 style="font-size:15px">Best Sellers & Featured products</h2></div>
      <div class="panel"><div class="stat-hint" style="padding:4px 0 2px">Toggle which products appear in the homepage "Best Sellers" and "Featured" sections. Every change applies to the live site instantly.</div>
        <table><thead><tr><th>Product</th><th>Featured</th><th>Best Seller</th></tr></thead>
        <tbody>${products.map(p => { const oos = p.outOfStock ? ' <span class="tag red">OOS</span>' : ''; return `<tr><td><b>${esc(p.name_en)}</b>${oos}</td><td><input type="checkbox" class="feat-toggle" data-pid="${p.id}" data-flag="featured" ${p.featured ? 'checked' : ''}></td><td><input type="checkbox" class="feat-toggle" data-pid="${p.id}" data-flag="bestSeller" ${p.bestSeller ? 'checked' : ''}></td></tr>`; }).join('')}</tbody>
      </table></div>
      <div class="main-head" style="margin-top:10px"><h2 style="font-size:15px">Promo bar & countdown</h2></div>
      <div class="panel">
        <div class="field full" style="padding:16px"><div class="check"><input type="checkbox" id="promo-on" ${d.promoBar.enabled ? 'checked' : ''}> <span>Enable promo bar</span></div></div>
        <div style="display:flex;gap:16px;padding:0 16px 16px">
          <div class="field" style="flex:1"><label>Text — EN</label><input id="promo-text-en" value="${esc(d.promoBar.text_en)}"></div>
          <div class="field" style="flex:1"><label>Text — AR</label><input id="promo-text-ar" value="${esc(d.promoBar.text_ar)}"></div>
        </div>
        <div style="display:flex;gap:16px;padding:0 16px 16px;align-items:flex-end">
          <div class="field" style="flex:1"><label>Countdown end (date/time)</label><input id="promo-end" type="datetime-local" value="${toLocal(d.promoBar.endTime)}"></div>
          <button class="btn btn-gold" id="save-promo">Save promo</button>
        </div>
      </div>`;
  }
  function toLocal(iso) { try { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; } catch (e) { return ''; } }

  function heroForm(s) {
    return `<div class="form-grid">
      <div class="field"><label>Headline — EN (use \n for line breaks)</label><textarea name="headline_en" rows="3">${esc(fld(s, 'headline'))}</textarea></div>
      <div class="field"><label>Headline — AR</label><textarea name="headline_ar" rows="3">${esc(s.headline_ar || '')}</textarea></div>
      <div class="field"><label>Sub — EN</label><textarea name="sub_en" rows="2">${esc(s.sub_en || '')}</textarea></div>
      <div class="field"><label>Sub — AR</label><textarea name="sub_ar" rows="2">${esc(s.sub_ar || '')}</textarea></div>
      <div class="field"><label>Accent — EN</label><input name="accent_en" value="${esc(s.accent_en || '')}"></div>
      <div class="field"><label>Accent — AR</label><input name="accent_ar" value="${esc(s.accent_ar || '')}"></div>
      <div class="field"><label>Button 1 — EN</label><input name="btn1_en" value="${esc(s.btn1_en || '')}"></div>
      <div class="field"><label>Button 1 link</label><input name="btn1_link" value="${esc(s.btn1_link || '')}"></div>
      <div class="field"><label>Button 1 — AR</label><input name="btn1_ar" value="${esc(s.btn1_ar || '')}"></div>
      <div class="field"><label>Button 2 — EN</label><input name="btn2_en" value="${esc(s.btn2_en || '')}"></div>
      <div class="field"><label>Button 2 link</label><input name="btn2_link" value="${esc(s.btn2_link || '')}"></div>
      <div class="field"><label>Button 2 — AR</label><input name="btn2_ar" value="${esc(s.btn2_ar || '')}"></div>
      <div class="field full"><label>Hero banner image</label>
        <div style="display:flex;gap:10px;align-items:flex-end"><input name="image" value="${esc(s.image || '')}" style="flex:1"><button type="button" class="btn btn-outline" id="hero-upload">Upload…</button></div>
        <div class="hint">Paste an image URL or upload a file (auto-compressed to a web-friendly size).</div>
        <div id="hero-preview" style="margin-top:10px">${s.image ? `<img src="${esc(s.image)}" style="max-width:100%;max-height:130px;border-radius:6px;border:1px solid var(--line)">` : ''}</div>
      </div>
      <div class="field"><label>Active</label><div class="toggle" style="padding-top:8px"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}> <span>Show on website</span></div></div>
    </div>`;
  }

  // ------------------------------------------------------------- ORDERS
  const ORDER_STATUSES = ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
  function orderStatusOptions(status) {
    // keep any legacy status (e.g. 'New') visible without being lost
    const list = ORDER_STATUSES.includes(status) ? ORDER_STATUSES : [status, ...ORDER_STATUSES];
    return list.map(s => `<option value="${s}" ${status === s ? 'selected' : ''}>${s}</option>`).join('');
  }
  function pendingOrdersCount() { return state.data.orders.filter(o => o.status === 'Pending' || o.status === 'New').length; }
  function ordersHTML() {
    const d = state.data;
    const rows = d.orders.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return `<div class="main-head"><h1>Orders (${d.orders.length})</h1><div class="stat-hint">${pendingOrdersCount()} awaiting action</div></div>
      <div class="panel"><div style="overflow-x:auto"><table>
        <thead><tr><th>Order</th><th>Date</th><th>Customer Name</th><th>Phone</th><th>Detailed Address</th><th>Total</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map(o => `<tr>
          <td><b>${esc(o.id)}</b></td>
          <td style="white-space:nowrap">${fmtDate(o.createdAt)}</td>
          <td>${esc(o.customer.fullName)}</td>
          <td dir="ltr" style="white-space:nowrap">${esc(o.customer.phone || '—')}</td>
          <td>${esc(o.customer.city || '')}${o.customer.area ? ', ' + esc(o.customer.area) : ''}${esc(o.customer.address ? ' · ' + o.customer.address : '')}</td>
          <td><b>${money(o.total)}</b></td>
          <td style="white-space:nowrap"><span class="status-pill status-${o.status}">${esc(o.status)}</span><div style="margin-top:6px"><select class="order-status" data-status="${o.id}">${orderStatusOptions(o.status)}</select></div></td>
          <td><button class="btn btn-outline btn-sm" data-orderdetails="${o.id}">Details</button></td>
        </tr>`).join('') || '<tr><td colspan="8">No orders yet.</td></tr>'}</tbody>
      </table></div></div>`;
  }

  function openOrderDetails(id) {
    const o = state.data.orders.find(x => x.id === id);
    if (!o) return;
    const overlay = document.createElement('div');
    overlay.innerHTML = orderDetailsHTML(o);
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#od-close').addEventListener('click', close);
    overlay.querySelector('#od-close2') && overlay.querySelector('#od-close2').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    const save = overlay.querySelector('#od-save');
    if (save) save.addEventListener('click', () => {
      const status = overlay.querySelector('#od-status').value;
      api('POST', '/api/admin/order-status', { id, status }).then(({ ok }) => { if (ok) { notify('Order status updated', 'gold'); } close(); loadData(); });
    });
  }

  function orderDetailsHTML(o) {
    const bundleApplied = (o.bundleDiscount || 0) > 0;
    const items = (o.items || []).map(it => {
      // the admin UI is English-first, so show the English name (the Arabic
      // name is held on the item for the bilingual storefront)
      const name = it.name_en ? it.name_en : it.name_ar;
      const fit = it.fitment || {};
      const fitParts = [];
      if (fit.brand) { const b = state.data.brands.find(x => x.slug === fit.brand); fitParts.push(b ? b.name_en : fit.brand); }
      if (fit.model) fitParts.push(fit.model);
      if (fit.year) fitParts.push(String(fit.year));
      const shape = it.keyShape ? ptShape(it.keyShape) : '';
      return `<div class="od-item">
        <img src="${it.image}">
        <div class="od-info">
          <div class="od-name">${esc(name)}</div>
          ${(fitParts.length || shape) ? `<div class="od-fit">${esc(fitParts.join(' · ') + (fitParts.length && shape ? ' · ' : '') + shape)}</div>` : `<div class="od-fit">${esc(it.brandSlug || '')}</div>`}
          <div class="od-qty">Qty: ${it.qty} @ ${money(it.price)}</div>
        </div>
        <div class="od-price">${money(it.lineTotal || it.price * it.qty)}</div>
      </div>`;
    }).join('');
    const customer = o.customer || {};
    return `<div class="modal-overlay" id="order-modal">
      <div class="modal modal-lg">
        <div class="mhead"><h3>Order ${esc(o.id)}</h3><button class="eclose" id="od-close">×</button></div>
        <div class="mbody">
          <div class="od-meta">
            <div class="od-kv"><span>Date</span><b>${fmtDate(o.createdAt)}</b></div>
            <div class="od-kv"><span>Payment</span><b>${esc(o.payment || 'Cash on Delivery')}</b></div>
            <div class="od-kv"><span>Completed Set</span><b class="${bundleApplied ? 'gold' : ''}">${bundleApplied ? 'Complete Your Set — Applied ✓' : 'No bundle'}</b></div>
            <div class="od-kv"><span>Bundle saving</span><b>${o.bundleDiscount ? money(o.bundleDiscount) : money(0)}</b></div>
          </div>
          <div class="od-cust">
            <h4>Customer</h4>
            <div class="od-name-row"><b>${esc(customer.fullName)}</b> <span dir="ltr">· ${esc(customer.phone || '')}</span></div>
            <div>${esc(customer.city || '')}${customer.area ? ', ' + esc(customer.area) : ''}${customer.address ? ' — ' + esc(customer.address) : ''}</div>
            ${customer.notes ? `<div class="od-notes">Notes: ${esc(customer.notes)}</div>` : ''}
          </div>
          <div class="od-items">
            <h4>Items (${(o.items || []).length}) — vehicle fitment</h4>
            ${items}
          </div>
          <div class="od-totals">
            <div class="row"><span>Subtotal</span><span>${money(o.subtotal || 0)}</span></div>
            <div class="row"><span>Bundle Discount</span><span class="disc">${o.bundleDiscount ? '− ' + money(o.bundleDiscount) : money(0)}</span></div>
            <div class="row"><span>Delivery Fee</span><span>${o.deliveryFee ? money(o.deliveryFee) : 'Free'}</span></div>
            <div class="row total"><span>Total</span><span>${money(o.total)}</span></div>
          </div>
        </div>
        <div class="mfoot">
          <div class="mf-status"><label>Status</label><select id="od-status">${orderStatusOptions(o.status)}</select></div>
          <div class="mf-actions"><button class="btn btn-outline" id="od-close2">Close</button><button class="btn btn-gold" id="od-save">Save Status</button></div>
        </div>
      </div>
    </div>`;
  }
  function ptShape(s) { return s ? 'Shape ' + s : ''; }

  // ------------------------------------------------------------- PREORDERS
  function preordersHTML() {
    const d = state.data;
    const rows = d.preorders.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const statuses = ['Pending', 'Confirmed', 'Cancelled'];
    return `<div class="main-head"><h1>Pre-orders (${d.preorders.length})</h1><div class="stat-hint">No payment collected until confirmed.</div></div>
      <div class="panel"><table>
        <thead><tr><th>Ref</th><th>Product</th><th>Customer</th><th>Shape</th><th>Status</th><th>Date</th><th></th></tr></thead>
        <tbody>${rows.map(o => `<tr>
          <td><b>${esc(o.id)}</b></td>
          <td>${esc(o.name_en)}</td>
          <td>${esc(o.customer.fullName)} · ${esc(o.customer.phone)}</td>
          <td>${esc(o.keyShape || '—')}</td>
          <td><span class="status-pill status-${o.status}">${o.status}</span></td>
          <td>${fmtDate(o.createdAt)}</td>
          <td><select class="preorder-status" data-status="${o.id}">${statuses.map(s => `<option value="${s}" ${o.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
        </tr>`).join('') || '<tr><td colspan="7">No pre-orders yet.</td></tr>'}</tbody>
      </table></div>`;
  }

  // ------------------------------------------------------------- MESSAGES
  function messagesHTML() {
    const d = state.data;
    const rows = d.messages.slice().reverse();
    return `<div class="main-head"><h1>Messages (${d.messages.length})</h1></div>
      <div class="panel"><table>
        <thead><tr><th>Date</th><th>Subject</th><th>From</th><th>Message</th></tr></thead>
        <tbody>${rows.map(m => `<tr><td>${fmtDate(m.createdAt)}</td><td><b>${esc(m.subject || '—')}</b></td><td>${esc(m.name || '')} ${esc(m.phone ? '· ' + m.phone : '')}</td><td>${esc(m.message || '')}</td></tr>`).join('') || '<tr><td colspan="4">No messages.</td></tr>'}</tbody>
      </table></div>`;
  }

  // ------------------------------------------------------------- SETTINGS
  function settingsHTML() {
    const s = state.data.settings;
    const sp = (k) => esc(s[k] || '');
    return `<div class="main-head"><h1>Site Settings</h1><div class="actions"><button class="btn btn-gold" id="save-settings">Save Settings</button></div></div>
      <div class="panel" style="padding:22px"><div class="form-grid">
        <div class="field"><label>WhatsApp number</label><input id="s-whatsapp" value="${sp('whatsapp')}"></div>
        <div class="field"><label>Instagram</label><input id="s-instagram" value="${sp('instagram')}"></div>
        <div class="field"><label>Facebook</label><input id="s-facebook" value="${sp('facebook')}"></div>
        <div class="field"><label>TikTok</label><input id="s-tiktok" value="${sp('tiktok')}"></div>
        <div class="field"><label>Contact email</label><input id="s-email" value="${esc(s.contact && s.contact.email || '')}"></div>
        <div class="field"><label>Currency</label><input id="s-currency" value="${sp('currency')}"></div>
        <div class="field"><label>Shipping fee (EGP)</label><input id="s-shipping" type="number" value="${s.shippingFee}"></div>
        <div class="field"><label>Free shipping threshold (EGP)</label><input id="s-freethreshold" type="number" value="${s.freeShippingThreshold}"></div>
        <div class="field"><label>Return policy days</label><input id="s-return" type="number" value="${s.returnPolicy.days}"></div>
        <div class="field"><label>Return note — EN</label><input id="s-return-en" value="${esc(s.returnPolicy.note_en)}"></div>
        <div class="field"><label>Return note — AR</label><input id="s-return-ar" value="${esc(s.returnPolicy.note_ar)}"></div>
        <div class="field"><label>Warranty — EN</label><input id="s-warranty-en" value="${sp('warranty_en')}"></div>
        <div class="field"><label>Warranty — AR</label><input id="s-warranty-ar" value="${sp('warranty_ar')}"></div>
        <div class="field full"><label>Copyright — EN</label><input id="s-copy-en" value="${sp('copyright_en')}"></div>
        <div class="field full"><label>Copyright — AR</label><input id="s-copy-ar" value="${sp('copyright_ar')}"></div>
      </div></div>`;
  }

  // ------------------------------------------------------------- VIEW BINDINGS
  function bindView() {
    // products
    $('#add-product') && $('#add-product').addEventListener('click', (e) => { e.preventDefault(); openProductEditor(defaultProduct()); });
    $$('[data-edit]').forEach(b => b.addEventListener('click', () => { const p = state.data.products.find(x => x.id === b.getAttribute('data-edit')); openProductEditor(p); }));
    $$('[data-del]').forEach(b => b.addEventListener('click', (e) => {
      if (!confirm('Delete this product?')) return;
      api('POST', '/api/admin/delete', { collection: 'products', id: b.getAttribute('data-del') }).then(({ ok }) => { if (ok) notify('Deleted'); loadData(); });
    }));
    // brands
    $('#add-brand') && $('#add-brand').addEventListener('click', (e) => { e.preventDefault(); openBrandEditor(defaultBrand()); });
    $('#fit-add-brand') && $('#fit-add-brand').addEventListener('click', (e) => { e.preventDefault(); openBrandEditor(defaultBrand()); });
    $$('[data-editb]').forEach(b => b.addEventListener('click', () => { const br = state.data.brands.find(x => x.id === b.getAttribute('data-editb')); openBrandEditor(br); }));
    $$('[data-delbrand]').forEach(b => b.addEventListener('click', () => deleteBrand(b.getAttribute('data-delbrand'))));
    // bundles
    $$('[data-editbundle]').forEach(b => b.addEventListener('click', () => { const bl = state.data.bundles.find(x => x.id === b.getAttribute('data-editbundle')); state.editor = { type: 'bundle', record: bl }; state.mode = 'editor'; renderEditor(); }));
    // orders
    $$('.order-status').forEach(sel => sel.addEventListener('change', () => api('POST', '/api/admin/order-status', { id: sel.getAttribute('data-status'), status: sel.value }).then(() => notify('Order status updated', 'gold'))));
    $$('[data-orderdetails]').forEach(b => b.addEventListener('click', () => openOrderDetails(b.getAttribute('data-orderdetails'))));
    $$('.preorder-status').forEach(sel => sel.addEventListener('change', () => api('POST', '/api/admin/preorder-status', { id: sel.getAttribute('data-status'), status: sel.value }).then(() => notify('Pre-order updated', 'gold'))));
    // hero
    $('#add-slide') && $('#add-slide').addEventListener('click', (e) => { e.preventDefault(); state.editor = { type: 'hero', record: defaultSlide(), isNew: true }; state.mode = 'editor'; renderEditor(); });
    $$('[data-editsl]').forEach(b => b.addEventListener('click', () => { const s = state.data.heroSlides.find(x => x.id === b.getAttribute('data-editsl')); state.editor = { type: 'hero', record: s }; state.mode = 'editor'; renderEditor(); }));
    bindDrag('#slides-sort', 'heroSlides');
    bindDrag('#sections-sort', 'homeSections');
    bindDrag('#brands-sort', 'brands');
    $$('[data-sec]').forEach(cb => cb.addEventListener('change', () => {
      const id = cb.getAttribute('data-sec'); const sec = state.data.homeSections.find(x => x.id === id);
      api('POST', '/api/admin/save', { collection: 'homeSections', record: Object.assign({}, sec, { enabled: cb.checked }) }).then(() => notify('Section updated', 'gold'));
    }));
    $$('.feat-toggle').forEach(cb => cb.addEventListener('change', () => {
      const p = state.data.products.find(x => x.id === cb.getAttribute('data-pid'));
      const flag = cb.getAttribute('data-flag');
      if (!p) return;
      api('POST', '/api/admin/save', { collection: 'products', record: Object.assign({}, p, { [flag]: cb.checked }) }).then(() => notify('Homepage section updated', 'gold'));
    }));
    // promo
    $('#save-promo') && $('#save-promo').addEventListener('click', () => {
      const promoBar = { enabled: $('#promo-on').checked, text_en: $('#promo-text-en').value, text_ar: $('#promo-text-ar').value, endTime: new Date($('#promo-end').value).toISOString(), sub_en: state.data.promoBar.sub_en, sub_ar: state.data.promoBar.sub_ar };
      api('POST', '/api/admin/settings', { promoBar }).then(() => notify('Promo saved', 'gold'));
    });
    // settings
    $('#save-settings') && $('#save-settings').addEventListener('click', () => {
      const settings = Object.assign({}, state.data.settings, {
        whatsapp: $('#s-whatsapp').value, instagram: $('#s-instagram').value, facebook: $('#s-facebook').value, tiktok: $('#s-tiktok').value,
        contact: Object.assign({}, state.data.settings.contact, { email: $('#s-email').value }),
        currency: $('#s-currency').value, shippingFee: +$('#s-shipping').value, freeShippingThreshold: +$('#s-freethreshold').value,
        returnPolicy: Object.assign({}, state.data.settings.returnPolicy, { days: +$('#s-return').value, note_en: $('#s-return-en').value, note_ar: $('#s-return-ar').value }),
        warranty_en: $('#s-warranty-en').value, warranty_ar: $('#s-warranty-ar').value,
        copyright_en: $('#s-copy-en').value, copyright_ar: $('#s-copy-ar').value,
      });
      api('POST', '/api/admin/settings', { settings }).then(() => notify('Settings saved', 'gold'));
    });
  }

  function defaultSlide() { return { id: 'h' + Date.now().toString(36), order: (state.data.heroSlides.length || 0) + 1, active: true, image: '/img/asset.svg?type=hero&brand=mercedes-benz', headline_en: 'NEW HEADLINE', headline_ar: 'عنوان جديد', sub_en: 'New supporting text', sub_ar: 'نص جديد', btn1_en: 'SHOP COLLECTION', btn1_ar: 'تسوق المفاتيح', btn1_link: '/category/keycases', btn2_en: 'SHOP BY CAR BRAND', btn2_ar: 'تسوق حسب الماركة', btn2_link: '/brands', accent_en: 'Limited Edition', accent_ar: 'إصدار محدود' }; }

  function bindDrag(sel, collection) {
    const list = $(sel); if (!list) return;
    let dragEl = null;
    list.addEventListener('dragstart', (e) => { if (e.target.closest('li')) { dragEl = e.target.closest('li'); dragEl.classList.add('dragging'); } });
    list.addEventListener('dragend', () => { if (dragEl) dragEl.classList.remove('dragging'); saveOrder(list, collection); });
    list.addEventListener('dragover', (e) => { e.preventDefault(); const after = getDragAfter(list, e.clientY); const dragging = list.querySelector('.dragging'); if (dragging && after) list.insertBefore(dragging, after); else if (dragging) list.appendChild(dragging); });
  }
  function getDragAfter(container, y) {
    const els = [...container.querySelectorAll('li:not(.dragging)')];
    return els.reduce((closest, child) => {
      const box = child.getBoundingClientRect(); const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
  }
  function saveOrder(list, collection) {
    const ids = [...list.querySelectorAll('li[data-id]')].map(li => li.getAttribute('data-id'));
    api('POST', '/api/admin/reorder', { collection, ids }).then(() => notify('Order saved', 'gold'));
  }

  function bindEditorExtras() {
    // brand model add/remove
    const addModel = $('#add-model');
    if (addModel) {
      let i = 0;
      addModel.addEventListener('click', () => {
        const list = $('#model-list');
        const idx = list.children.length;
        const div = document.createElement('div');
        div.className = 'model-row'; div.setAttribute('data-i', idx);
        div.style.cssText = 'border:1px solid var(--line);border-radius:6px;padding:10px;margin-bottom:8px';
        div.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center"><b>New model</b><button type="button" class="btn btn-danger btn-sm" data-delmodel="${idx}">×</button></div>
          <div class="form-grid" style="grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
            <div class="field"><label>Model — EN</label><input name="men_${idx}" value=""></div>
            <div class="field"><label>Model — AR</label><input name="mar_${idx}" value=""></div>
            <div class="field"><label>Years</label><input name="myears_${idx}" value="2021,2022,2023"></div>
            <div class="field"><label>Key shapes</label><input name="mshapes_${idx}" value="A,B"></div>
          </div>`;
        list.appendChild(div);
        bindDelModel(list);
      });
    }
    bindDelModel($('#model-list'));
    bindSpecVehicles();
    // bundle editor — live discount preview
    const bform = $('#bundle-form');
    if (bform) {
      bform.addEventListener('input', recalcBundlePreview);
      bform.addEventListener('change', recalcBundlePreview);
    }
    // per-key-shape stock toggle label
    $$('input[name^="shapeok_"]').forEach(cb => cb.addEventListener('change', () => {
      const lbl = cb.closest('.form-grid');
      const tgl = lbl ? lbl.querySelector('label.toggle span') : null;
      const helper = lbl ? lbl.querySelector('[data-stocklbl]') : null;
      if (tgl) tgl.textContent = cb.checked ? 'In stock' : 'Out of stock';
      if (helper) { helper.textContent = cb.checked ? 'Available' : 'Unavailable'; helper.style.color = cb.checked ? '' : 'var(--danger)'; }
    }));
    // image upload buttons
    $('#hero-upload') && $('#hero-upload').addEventListener('click', uploadImage);
    $('#product-upload') && $('#product-upload').addEventListener('click', uploadImage);
  }
  function bindDelModel(list) {
    if (!list) return;
    list.querySelectorAll('[data-delmodel]').forEach(b => b.addEventListener('click', () => { b.closest('.model-row').remove(); }));
  }

  // dynamic Specifications + Vehicle Compatibility builders in the product form
  function bindSpecVehicles() {
    // --- Specification rows ---
    const addSpec = $('#add-spec');
    if (addSpec) {
      addSpec.addEventListener('click', () => {
        const list = $('#spec-list');
        list.querySelector('.empty-rows') && list.querySelector('.empty-rows').remove();
        const idx = list.children.length;
        const div = document.createElement('div');
        div.className = 'repeater-row'; div.setAttribute('data-i', idx);
        div.innerHTML = `<div class="form-grid" style="grid-template-columns:1fr 1fr 1fr 1fr auto;gap:8px;align-items:end">
          <div class="field"><label>Label — EN</label><input data-sl_en="${idx}" value=""></div>
          <div class="field"><label>Label — AR</label><input data-sl_ar="${idx}" value=""></div>
          <div class="field"><label>Value — EN</label><input data-sv_en="${idx}" value=""></div>
          <div class="field"><label>Value — AR</label><input data-sv_ar="${idx}" value=""></div>
          <button type="button" class="btn btn-danger btn-sm" data-delspec="${idx}">×</button>
        </div>`;
        list.appendChild(div);
        bindDelSpecs(list);
      });
    }
    bindDelSpecs($('#spec-list'));

    // --- Vehicle compatibility rows ---
    const addVehicle = $('#add-vehicle');
    if (addVehicle) {
      addVehicle.addEventListener('click', () => {
        const list = $('#vehicle-list');
        list.querySelector('.empty-rows') && list.querySelector('.empty-rows').remove();
        const idx = list.children.length;
        const d = state.data;
        const brandOpts = d.brands.map(b => `<option value="${b.slug}">${esc(b.name_en)}</option>`).join('');
        const firstBrand = d.brands[0];
        const modelOpts = (firstBrand && firstBrand.models || []).map(m => `<option value="${esc(m.en)}">${esc(m.en)}</option>`).join('');
        const div = document.createElement('div');
        div.className = 'repeater-row'; div.setAttribute('data-i', idx);
        div.innerHTML = `<div class="form-grid" style="grid-template-columns:1fr 1fr 1fr auto;gap:8px;align-items:end">
          <div class="field"><label>Brand</label><select data-vbrand="${idx}" data-kind="brand">${brandOpts}</select></div>
          <div class="field"><label>Model</label><select data-vmodel="${idx}" data-kind="model">${modelOpts}</select></div>
          <div class="field"><label>Year</label><input data-vyear="${idx}" type="text" placeholder="2022"></div>
          <button type="button" class="btn btn-danger btn-sm" data-delvehicle="${idx}">×</button>
        </div>`;
        list.appendChild(div);
        bindDelVehicles(list);
        bindVehicleCascade(list);
      });
    }
    bindDelVehicles($('#vehicle-list'));
    bindVehicleCascade($('#vehicle-list'));
  }

  function bindDelSpecs(list) {
    if (!list) return;
    list.querySelectorAll('[data-delspec]').forEach(b => b.addEventListener('click', () => {
      b.closest('.repeater-row').remove();
      if (!list.querySelector('.repeater-row')) list.innerHTML = '<div class="empty-rows">No specifications yet.</div>';
    }));
  }
  function bindDelVehicles(list) {
    if (!list) return;
    list.querySelectorAll('[data-delvehicle]').forEach(b => b.addEventListener('click', () => {
      b.closest('.repeater-row').remove();
      if (!list.querySelector('.repeater-row')) list.innerHTML = '<div class="empty-rows">No vehicles assigned yet.</div>';
    }));
  }
  // keep the model dropdown in sync when the brand changes
  function bindVehicleCascade(list) {
    if (!list) return;
    list.querySelectorAll('select[data-kind="brand"]').forEach(sel => {
      sel.addEventListener('change', () => {
        const idx = sel.getAttribute('data-vbrand');
        const row = sel.closest('.repeater-row');
        const brand = sel.value;
        const br = state.data.brands.find(x => x.slug === brand);
        const modelSel = row.querySelector('[data-vmodel="' + idx + '"]');
        if (!modelSel) return;
        modelSel.innerHTML = (br && br.models || []).map(m => `<option value="${esc(m.en)}">${esc(m.en)}</option>`).join('') || '<option value="">—</option>';
      });
    });
  }

  // ---------------------------------------------------------------- BOOT
  checkAuth();
})();
