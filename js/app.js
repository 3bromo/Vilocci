/* ==========================================================================
   VELOCCI — Storefront application (single-file client SPA)
   Loads the shared store once, renders the whole site, and keeps the cart in
   localStorage. Reads live data from /api/data so admin changes reflect.
   ========================================================================== */
(function () {
  'use strict';
  const $ = (s, root) => (root || document).querySelector(s);
  const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));
  const main = () => $('#main');

  const state = {
    data: null,
    lang: 'en',
    cart: [],
    fitment: null,          // { brand, model, year, shape }
    fitStep: 0,             // which fitment step is active (1 brand, 2 model, 3 year, 4 shape)
    route: { name: 'home', params: {} },
    productShape: {},       // pdp selected key shape per productId
    productQty: 1,
    productOption: 0,       // complete-your-set combo index
    lastOrder: null,        // most recently placed order, for the thank-you page
  };

  const LANG_KEY = 'velocci_lang';
  const CART_KEY = 'velocci_cart';
  const FIT_KEY = 'velocci_fitment';

  // ------------------------------------------------------------------ i18n
  function t(key, vars, lang) {
    const L = (state.data && state.data.languages.dict) || {};
    const dict = L[lang || state.lang] || L.en || {};
    let s = dict[key] != null ? dict[key] : (L.en[key] != null ? L.en[key] : key);
    if (vars) {
      for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
    }
    return s;
  }
  const pt = (key, vars) => t(key, vars, state.lang);
  const L = () => state.lang;
  const A = () => state.lang === 'ar';
  const brandName = (b) => (b && (b['name_' + L()] || b.name_en)) || '';

  // Pick a category-balanced subset so curated sections never look monotone.
  function pickBalanced(list, n) {
    const cats = ['keycase', 'keyholder', 'medal'];
    const pools = cats.map(c => list.filter(p => p.category === c));
    const ordered = [...pools[0], ...pools[2], ...pools[1]]; // case, medal, holder
    return ordered.slice(0, n);
  }

  // Render the hero headline; the middle line is highlighted in gold
  // (mirrors "LUXURY FOR / THE KEY YOU / CARRY EVERY DAY").
  function heroHeadline(raw) {
    const lines = String(raw || '').split('\n').filter(x => x && x.trim());
    const total = lines.length;
    return lines.map((line, i) => {
      // First line dark, all subsequent lines gold (matches reference design)
      const cls = (total >= 2 && i >= 1) ? ' class="gold"' : '';
      return `<span${cls}>${VEL.esc(line)}</span>`;
    }).join('<br>');
  }
  const prodName = (p) => (p && (p['name_' + L()] || p.name_en)) || '';

  // Field pick — choose localised text or fallback to EN
  function fld(obj, base) {
    if (!obj) return '';
    const loc = obj[base + '_' + L()];
    if (loc && String(loc).trim()) return loc;
    return obj[base + '_en]'] || obj[base + '_en'] || obj[base] || '';
  }

  function setLang(lang) { state.lang = lang; localStorage.setItem(LANG_KEY, lang); document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'; }

  // ------------------------------------------------------------------ cart
  function loadCart() { try { state.cart = JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch (e) { state.cart = []; } }
  function saveCart() { localStorage.setItem(CART_KEY, JSON.stringify(state.cart)); renderCartBadge(); renderCartDrawer(); }
  function cartCount() { return state.cart.reduce((s, i) => s + i.qty, 0); }

  function currentFitment() {
    const f = state.fitment || {};
    return { brand: f.brand || '', model: f.model || '', year: (f.year != null ? String(f.year) : '') };
  }
  // inherit the active vehicle from an existing cart item of the same brand, else the current context
  function fitForItem(prod) {
    const it = state.cart.find(i => { const p = product(i.productId); return p && p.brandSlug === prod.brandSlug && i.fitment && (i.fitment.brand || i.fitment.model || i.fitment.year); });
    return (it && it.fitment) ? it.fitment : currentFitment();
  }
  // localized vehicle line (Brand · Model · Year) — falls back to brand name alone
  function vehicleLabel(fit) {
    if (!fit) return '';
    const parts = [];
    if (fit.brand) { const b = brand(fit.brand); parts.push(b ? brandName(b) : fit.brand); }
    if (fit.model) parts.push(fit.model);
    if (fit.year) parts.push(String(fit.year));
    return parts.join(' · ');
  }
  // sub-line markup for a cart item: shows the fitted vehicle, or brand + shape
  function cartItemMeta(it, opts) {
    opts = opts || {};
    const style = opts.style ? ` style="${opts.style}"` : '';
    const v = vehicleLabel(it.fitment);
    const shapePart = it.keyShape ? pt('shape') + ' ' + it.keyShape : '';
    if (v) return `<div class="di-vehicle"${style}>${VEL.esc(v)}${shapePart ? ' · ' + VESt(shapePart) : ''}</div>`;
    return `<div class="di-meta"${style}>${VEL.esc(brandName(brandOfAsset(it.prod)))}${shapePart ? ' · ' + VESt(shapePart) : ''}</div>`;
  }

  function addToCart(productId, keyShape, qty, opts) {
    opts = opts || {};
    const prod = product(productId);
    if (!prod) return;
    const fit = opts.fitment || fitForItem(prod);
    // if already in cart with same shape, bump qty
    const existing = state.cart.find(i => i.productId === productId && i.keyShape === (keyShape || ''));
    if (existing) { existing.qty += (qty || 1); existing.fitment = existing.fitment || fit; }
    else {
      state.cart.push({ productId, keyShape: keyShape || '', qty: qty || 1, fitment: fit });
    }
    saveCart();
    if (opts.openCart === true) { openCart(); }
    notify(pt('add_to_cart'), 'gold');
  }

  function setQty(productId, keyShape, qty) {
    const item = state.cart.find(i => i.productId === productId && i.keyShape === keyShape);
    if (!item) return;
    qty = parseInt(qty) || 1;
    if (qty <= 0) { state.cart = state.cart.filter(i => !(i.productId === productId && i.keyShape === keyShape)); }
    else item.qty = qty;
    saveCart();
  }
  function removeCartItem(productId, keyShape) { state.cart = state.cart.filter(i => !(i.productId === productId && i.keyShape === keyShape)); saveCart(); }

  // Cart totals — mirrors server logic (full set => bundle discount)
  function cartTotals() {
    const items = state.cart.map(item => {
      const prod = product(item.productId);
      return { ...item, prod };
    }).filter(i => i.prod);
    let subtotal = 0;
    const byBrand = {};
    for (const it of items) {
      subtotal += it.prod.price * it.qty;
      const b = byBrand[it.prod.brandSlug] = byBrand[it.prod.brandSlug] || { cats: {}, lineTotal: 0 };
      b.cats[it.prod.category] = true;
      b.lineTotal += it.prod.price * it.qty;
    }
    let bundleDiscount = 0, bundleSubtotal = 0;
    const bundles = state.data.bundles || [];
    for (const slug in byBrand) {
      const b = byBrand[slug];
      if (b.cats.keycase && b.cats.keyholder && b.cats.medal) {
        const bundle = bundles.find(x => x.brandSlug === slug);
        if (bundle && bundle.active) {
          bundleDiscount += Math.max(0, bundle.normalTotal - bundle.bundlePrice);
          bundleSubtotal += b.lineTotal;
        }
      }
    }
    const shipFee = state.data.settings.shippingFee || 0;
    const threshold = state.data.settings.freeShippingThreshold || 0;
    const deliveryFee = subtotal >= threshold ? 0 : shipFee;
    const total = subtotal - bundleDiscount + deliveryFee;
    return { items, subtotal, bundleDiscount, bundleSubtotal, deliveryFee, total };
  }

  function product(id) { return (state.data && state.data.products.find(p => p.id === id)) || null; }
  function brand(slug) { return (state.data && state.data.brands.find(b => b.slug === slug)) || null; }
  function brandOfAsset(prod) { return brand(prod.brandSlug); }
  function bundleOfBrand(slug) { return (state.data && state.data.bundles.find(b => b.brandSlug === slug)) || null; }

  // Bundle set items for a brand
  function brandSetItems(slug) {
    const caseProd = state.data.products.find(p => p.brandSlug === slug && p.category === 'keycase');
    const holderProd = state.data.products.find(p => p.brandSlug === slug && p.category === 'keyholder');
    const medalProd = state.data.products.find(p => p.brandSlug === slug && p.category === 'medal');
    return { keyCase: caseProd, keyHolder: holderProd, medal: medalProd };
  }

  // Cart items of a given brand (dedupe by category)
  function cartHasBrandCat(slug, cat) { return state.cart.some(i => { const p = product(i.productId); return p && p.brandSlug === slug && p.category === cat; }); }
  function cartHasProduct(id) { return state.cart.some(i => i.productId === id); }

  // ================================================================ RENDER
  const app = () => $('#app');
  const img = (p) => (p && p.images && p.images[0]) || '/img/detail_a.png';
  const catLabel = (c) => ({ keycase: pt('key_cases'), keyholder: pt('key_holders'), medal: pt('car_medals') }[c] || c);

  function productCard(p, opts) {
    opts = opts || {};
    const br = brandOfAsset(p);
    const deliveryLabel = p.preorder ? (L()==='ar'?'طلب مسبق':'Pre-order') : '';
    const brandLogo = br ? `<img src="${VEL.brandLogoUrl(br.slug)}" alt="${VEL.esc(brandName(br))}" class="pc-brand-logo" loading="lazy">` : '';
    return `<article class="product-card reveal ${opts.fadeClass || ''}" data-slug="${p.slug}">
      <div class="media">
        <a href="#/product/${p.slug}"><img src="${img(p)}" alt="${VEL.esc(p.name_en)}" loading="lazy"></a>
        ${(p.badge_en && L() === 'en') ? `<span class="badge">${VEL.esc(p.badge_en)}</span>` : (p.badge_ar && L() === 'ar') ? `<span class="badge">${VEL.esc(p.badge_ar)}</span>` : ''}
        ${p.discount ? `<span class="disc">-${p.discount}%</span>` : ''}
        ${deliveryLabel ? `<span class="badge badge-bottom">${deliveryLabel}</span>` : ''}
      </div>
      <div class="body">
        <span class="cat">${brandLogo}<span class="cat-text">${VEL.esc(brandName(br))}</span></span>
        <a href="#/product/${p.slug}" class="name">${VEL.esc(prodName(p))}</a>
        <div class="price-row">
          <span class="price">${VEL.money(p.price)}</span>
          ${p.oldPrice ? `<span class="old">${VEL.money(p.oldPrice)}</span>` : ''}
        </div>
        <div class="card-footer">
          <button class="btn btn-gold btn-sm btn-block add" data-add="${p.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14"><path d="M3 3h2l2 12h11l2-8H6"/><circle cx="9" cy="20" r="1"/><circle cx="17" cy="20" r="1"/></svg>${pt('add_to_cart')}</button>
        </div>
      </div>
    </article>`;
  }

  function productGrid(prods, opts) {
    prods = prods || [];
    if (!prods.length) {
      return `<div class="empty" style="grid-column:1/-1"><div class="em-ic">◆</div>${pt('no_products')}</div>`;
    }
    return `<div class="product-grid">${prods.map(p => productCard(p, opts)).join('')}</div>`;
  }

  // Section header
  function sectionHead(kicker, title, link) {
    return `<div class="section-head">
      <div><span class="kicker">${VEL.esc(kicker)}</span><h2>${VEL.esc(title)}</h2></div>
      ${link ? `<a class="link-all" href="${link}">${pt('view_all')} →</a>` : ''}
    </div>`;
  }

  // Benefits strip
  function benefitsHTML() {
    const items = [
      ['box', 'premium_materials', 'pm_sub'],
      ['fit', 'perfect_compatibility', 'pc_sub'],
      ['cash', 'cash_on_delivery', 'cod_sub'],
      ['return', 'easy_returns', 'er_sub']
    ];
    const ics = {
      box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M12 3 4 7v10l8 4 8-4V7z"/><path d="M4 7l8 4 8-4M12 11v10"/></svg>',
      fit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="12" cy="6" r="2.4"/><path d="M12 9v5m0 0-3 6m3-6 3 6"/></svg>',
      cash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="12" cy="12" r="2.4"/><path d="M3 9h18M3 15h18"/><rect x="3" y="6" width="18" height="12" rx="2"/></svg>',
      return: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>'
    };
    return `<div class="benefits" data-section="benefits"><div class="container"><div class="inner">
      ${items.map(it => `<div class="benefit"><span class="ic">${ics[it[0]]}</span><div><b>${pt(it[1])}</b><span>${pt(it[2])}</span></div></div>`).join('')}
    </div></div></div>`;
  }

  // Natural per-language plural for the product count on brand cards
  function productsLabel(n) {
    if (L() === 'ar') {
      const two = n % 100;
      if (n === 0) return 'منتجات';
      if (n === 1) return 'منتج';
      if (n === 2) return 'منتجان';
      if (two >= 3 && two <= 10) return 'منتجات';
      return 'منتجًا';
    }
    return n === 1 ? 'product' : 'products';
  }

  function brandCard(b) {
    const count = state.data.products.filter(p => p.brandSlug === b.slug).length;
    const medal = state.data.products.find(p => p.brandSlug === b.slug && p.category === 'medal');
    const sculpturePreview = medal ? `<div class="brand-sculpture-preview"><img src="${img(medal)}" alt="" loading="lazy"></div>` : '';
    return `<a class="brand-tile" href="#/brand/${b.slug}">
      <span class="logo-circle">${VEL.brandLogoImg(b.slug, { h: 44 })}</span>
      <span class="name">${VEL.esc(brandName(b))}</span>
      <span class="cat">${count} ${productsLabel(count)}</span>
      ${sculpturePreview}
    </a>`;
  }

  function brandsStrip(opts) {
    opts = opts || {};
    const list = state.data.brands || [];
    return `<div class="section brands-section" id="s-brands"><div class="container" data-section="brands">
      ${sectionHead(pt('shop_by_car_brand'), pt('shop_by_car_brand'), '#/brands')}
      <div class="brand-strip-wrap">
        <button class="brand-scroll-arrow brand-prev" id="brand-prev" aria-label="${pt('prev')}" type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M15 6l-6 6 6 6"/></svg>
        </button>
        <div class="brand-strip" data-grid="home" id="brand-strip">
          ${list.map(b => brandCard(b)).join('')}
        </div>
        <button class="brand-scroll-arrow brand-next" id="brand-next" aria-label="${pt('next')}" type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 6l6 6-6 6"/></svg>
        </button>
      </div>
    </div></div>`;
  }

  // ============================================================== HOMEPAGE
  function homeHTML() {
    const slides = (state.data.heroSlides || []).filter(s => s.active);
    const hero = slides[0] || { headline_en: 'LUXURY FOR THE KEY', sub_en: '' };
    let heroHTML = '';
    const slide = hero;
    heroHTML = `<section class="hero" data-section="hero">
      <div class="container">
        <div class="hero-slide">
          <div class="hero-copy">
            <div class="eyebrow">${VEL.esc(fld(slide, 'accent'))}</div>
            <h1>${heroHeadline(fld(slide, 'headline'))}</h1>
            <p>${VEL.esc(fld(slide, 'sub'))}</p>
            <div class="hero-actions">
              <a class="btn btn-gold" href="${fld(slide, 'btn1_link') || '#/category/keycases'}">${VEL.esc(fld(slide, 'btn1'))} <span class="btn-arrow">→</span></a>
              <a class="btn btn-ghost" href="${fld(slide, 'btn2_link') || '#/brands'}">${VEL.esc(fld(slide, 'btn2'))} <span class="btn-arrow">→</span></a>
            </div>
          </div>
          <div class="hero-media"><img src="${slide.image || '/img/hero.jpg'}" alt="SPINTO premium key accessory"></div>
        </div>
      </div>
    </section>`;

    const sectionsHtml = (state.data.homeSections || []).map(sec => renderHomeSection(sec)).join('');
    return heroHTML + sectionsHtml;
  }

  // "Find Your Key" entry banner on the homepage → the fitment wizard
  function fitCTA() {
    return `<section class="section fit-cta-section" data-section="fitcta">
      <div class="container">
        <div class="fit-cta" role="banner">
          <div class="fcta-txt">
            <span class="kicker">${pt('fitment_finder')}</span>
            <h2 class="fcta-title">${pt('find_your_key')}</h2>
            <p class="fcta-sub">${pt('choose_brand')}</p>
          </div>
          <div class="fcta-art" aria-hidden="true">
            ${VEL.keyShapeSVG('B', { color: 'var(--champagne)', w: 40, h: 62 })}
          </div>
          <a class="btn btn-gold" href="#/category/keycases">${pt('find_your_key')} →</a>
        </div>
      </div>
    </section>`;
  }

  function renderHomeSection(sec) {
    const base = `<div class="section">`;
    switch (sec.type) {
      case 'categoryNav': return categoryNavSection();
      case 'findYourKey': return findYourKeySection();
      case 'heroProduct': return heroProductSection();
      case 'brands': return brandsStrip();
      case 'bestsellers': return '';
      case 'newarrivals': {
        const list = state.data.products.filter(p => p.newArrival).slice(0, 4);
        return `<div class="section" id="s-${sec.id}"><div class="container">
          ${sectionHead(pt('new_arrivals'), pt('new_arrivals'), '#/collections')}
          ${productGrid(list)}
        </div></div>`;
      }
      case 'keycases': {
        const list = state.data.products.filter(p => p.category === 'keycase').slice(0, 4);
        return `<div class="section section-keycases" id="s-${sec.id}"><div class="container">
          ${sectionHead(pt('key_cases'), pt('key_cases'), '#/category/keycases')}
          <div class="keycases-cta"><a class="link-all" href="#/category/keycases">${pt('find_your_key')} →</a></div>
          ${productGrid(list)}
        </div></div>`;
      }
      case 'keyholders': {
        const list = state.data.products.filter(p => p.category === 'keyholder').slice(0, 4);
        return `<div class="section section-keyholders" id="s-${sec.id}"><div class="container">
          ${sectionHead(pt('key_holders'), pt('key_holders'), '#/category/keyholders')}
          ${productGrid(list)}
        </div></div>`;
      }
      case 'medals': {
        const list = state.data.products.filter(p => p.category === 'medal').slice(0, 8);
        return `<div class="section section-medals" id="s-${sec.id}"><div class="container">
          ${sectionHead(pt('car_medals'), pt('car_medals'), '#/category/medals')}
          ${productGrid(list)}
        </div></div>`;
      }
      case 'completeset': {
        return `<div class="section" id="s-${sec.id}"><div class="container">
          ${sectionHead(pt('complete_your_set'), pt('packages_sets'), '#/packages')}
          ${sampleBundleSection()}
        </div></div>`;
      }
      case 'benefits': return benefitsHTML();
      case 'limited': return '';
      case 'why': return '';
      case 'hero': return '';
      default: return '';
    }
  }

  // THREE MAIN CATEGORIES — premium product showcase
  function categoryNavSection() {
    const lang = L();
    // Use diverse product images for visual richness
    const products = state.data.products;
    const holderP = products.find(p => p.category === 'keyholder') || products[2];
    const caseP = products.find(p => p.category === 'keycase') || products[0];
    const medalP = products.find(p => p.category === 'medal') || products[3];
    const cats = [
      { name_en: 'Key Holders', name_ar: 'حاملات المفاتيح', link: '#/category/keyholders', img: img(holderP), sub_en: 'Illuminated 3D metal displays', sub_ar: 'حاملات مفاتيح معدنية فاخرة بتفاصيل ثلاثية الأبعاد', count: products.filter(p=>p.category==='keyholder').length },
      { name_en: 'Key Cases', name_ar: 'جرابات المفاتيح', link: '#/category/keycases', img: img(caseP), sub_en: 'Carbon fibre & leather cases', sub_ar: 'جرابات من ألياف الكربون والجلد', count: products.filter(p=>p.category==='keycase').length },
      { name_en: 'Car Medals', name_ar: 'ميداليات السيارات', link: '#/category/medals', img: img(medalP), sub_en: 'Collector-grade medals', sub_ar: 'ميداليات فاخرة للمقتنين', count: products.filter(p=>p.category==='medal').length },
    ];
    return `<section class="section section-catnav" data-section="catnav">
      <div class="container">
        <div class="catnav-grid">
          ${cats.map(c => `<a class="catnav-card has-img" href="${c.link}">
            <div class="catnav-img"><img src="${c.img}" alt="${VEL.esc(lang === 'ar' ? c.name_ar : c.name_en)}" loading="lazy"></div>
            <div class="catnav-body">
              <span class="catnav-count">${c.count} ${lang === 'ar' ? 'منتج' : 'products'}</span>
              <span class="catnav-name">${VEL.esc(lang === 'ar' ? c.name_ar : c.name_en)}</span>
              <span class="catnav-sub">${VEL.esc(lang === 'ar' ? c.sub_ar : c.sub_en)}</span>
              <span class="catnav-cta">${lang === 'ar' ? 'تسوق الآن' : 'Shop Now'} →</span>
            </div>
          </a>`).join('')}
        </div>
      </div>
    </section>`;
  }


  // FIND YOUR KEY — interactive 17-brand filter on homepage
  function findYourKeySection() {
    const lang = L();
    const FYK_BRANDS = ['mercedes-benz','bmw','mg','audi','hyundai','kia','peugeot','byd','gac','jetour','toyota','jeep','citroen','haval','cupra','volkswagen','skoda'];
    const brands = state.data.brands.filter(b => FYK_BRANDS.includes(b.slug));
    return `<section class="section section-findkey" data-section="findkey">
      <div class="container">
        <div class="findkey-card">
          <div class="findkey-content">
            <span class="findkey-kicker">${pt('fitment_finder')}</span>
            <h2 class="findkey-title">${pt('find_your_key')}</h2>
            <p class="findkey-desc">${lang === 'ar' ? 'اختر علامة سيارتك للعثور على المنتجات المتوافقة تمامًا مع مفتاحك.' : 'Select your car brand to find accessories perfectly compatible with your key.'}</p>
            <div class="fk-brand-strip">
              ${brands.map(b => `<a class="fk-brand" href="#/category/keycases?brand=${b.slug}" title="${VEL.esc(brandName(b))}">
                <span>${VEL.esc(brandName(b))}</span>
              </a>`).join('')}
            </div>
            <a class="btn btn-gold btn-sm" href="#/fitment">${lang === 'ar' ? 'استخدم أداة البحث المتقدمة' : 'Use Advanced Fitment Tool'} →</a>
          </div>
        </div>
      </div>
    </section>`;
  }

  // HERO PRODUCTS — multiple products controlled from admin (like New Arrivals)
  function heroProductSection() {
    const list = state.data.products.filter(p => p.heroProduct && p.active).slice(0, 8);
    if (!list.length) return '';
    return `<section class="section section-heroproduct" data-section="heroproduct">
      <div class="container">
        ${sectionHead(pt('hero_products'), pt('hero_products'), '#/collections')}
        ${productGrid(list)}
      </div>
    </section>`;
  }

  function sampleBundleSection() {
    const b = (state.data.bundles || [])[0];
    if (!b) return '<div class="empty">No bundles</div>';
    const items = brandSetItems(b.brandSlug);
    const br = brand(b.brandSlug);
    const trio = [items.keyCase, items.medal, items.keyHolder].filter(Boolean);
    if (!trio.length) return '<div class="empty">No bundles</div>';
    const heroItem = trio[0];
    const save = Math.max(0, b.normalTotal - b.bundlePrice);
    return `<div class="set-banner" data-section="set">
      <div class="set-brand">
        <span class="set-logo">${VEL.brandLogoImg(br.slug, { h: 42 })}</span>
        <span class="kicker">${pt('complete_your_set')}</span>
        <h3>${VEL.esc(fld(b, 'title'))}</h3>
        <p>${VEL.esc(fld(b, 'sub'))}</p>
        <div class="set-save">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M20 12 12 20 4 12 12 4z"/><path d="M9 12h6"/></svg>
          <b>${pt('you_save')} ${VEL.money(save)}</b>
        </div>
      </div>
      <div class="set-items">
        ${trio.map(it => `
          <a class="set-item" href="#/product/${it.slug}">
            <img src="${img(it)}" alt="${VEL.esc(prodName(it))}">
            <span class="si-name">${VEL.esc(catLabel(it.category))}</span>
          </a>`).join('<span class="set-plus">+</span>')}
      </div>
      <div class="set-pricing">
        <div class="price-block">
          <span class="rp"><span class="pl">${pt('regular_price')}</span>${VEL.money(b.normalTotal)}</span>
          <span class="bp"><span class="pl">${pt('bundle_price')}</span>${VEL.money(b.bundlePrice)}</span>
        </div>
        <a class="btn btn-gold btn-block" href="#/product/${heroItem.slug}">${pt('add_3_piece_set')}</a>
      </div>
    </div>`;
  }

  function whyVelocci() {
    const points = [
      ['Real materials', 'Carbon fibre, full-grain leather and machined alloy — never a cheap print.'],
      ['Guaranteed compatibility', 'Engineered to your exact key shape and car model.'],
      ['Cash on delivery', 'Pay only when the order reaches your door.'],
      ['7-day easy returns', 'Changed your mind? Send it back within 7 days.']
    ];
    return `<div class="section-head"><div><span class="kicker">${pt('why_velocci')}</span><h2>${pt('why_velocci')}</h2></div></div>
      <div class="product-grid">${points.map(p =>
        `<div class="bundle-card" style="margin-top:0">
          <div class="bs-head" style="color:var(--gold-deep);font-size:14px">${p[0]}</div>
          <div class="bs-sub" style="margin-bottom:0;line-height:1.6">${p[1]}</div>
        </div>`).join('')}</div>`;
  }

  // ============================================================== PRODUCT PAGE
  // Product-page vehicle context line: shows the persisted fitment (if the
  // product is truly compatible with it) or a plain brand compatibility line.
  function pdpFitLine(p, br) {
    const f = state.fitment;
    if (f && f.brand && f.brand === p.brandSlug) {
      const avShape = (p.keyShapes || []).find(s => s.shape === f.shape && s.available);
      // only claim exact fit when the product's data supports model/year/shape
      const modelOk = !f.model || !(p.models && p.models.length) || p.models.includes(f.model);
      const yearOk = !f.year || !(p.years && p.years.length) || p.years.some(y => String(y) === String(f.year));
      if (f.shape && !avShape) {
        // shape not available for this product — show the generic brand line
        return `<div class="brand-line" style="color:var(--muted);font-weight:500;text-transform:none;letter-spacing:.02em;font-size:13px;margin-top:-6px">${pt('compatible_with', { brand: brandName(br) })}</div>`;
      }
      if (modelOk && yearOk) {
        const info = fitSummary(f);
        return `<div class="brand-line fit-vehicle-line" style="margin-top:-6px"><span class="fv-k">${pt('your_vehicle')}</span><span class="fv-v">${VEL.esc(info)}</span></div>`;
      }
    }
    return `<div class="brand-line" style="color:var(--muted);font-weight:500;text-transform:none;letter-spacing:.02em;font-size:13px;margin-top:-6px">${pt('compatible_with', { brand: brandName(br) })}</div>`;
  }

  // Bilingual spec value/label lookup
  function specTxt(spec, base) {
    const key = base + '_' + L();
    return (spec && spec[key]) ? String(spec[key]) : (spec ? (spec[base + '_en'] || spec[base] || '') : '');
  }
  // Elegant "Specifications" panel rendered from the product's explicit spec list
  function specsBlock(p) {
    const specs = (p.specs || []).filter(s => s && (specTxt(s, 'label') || specTxt(s, 'value')));
    if (!specs.length && !p.material_en) return '';
    return `<div class="pdp-specs">
      <h3 class="s-head">${pt('specifications')}</h3>
      <table class="spec-table">
        <tbody>${specs.map(s => `<tr><th>${VEL.esc(specTxt(s, 'label'))}</th><td>${VEL.esc(specTxt(s, 'value'))}</td></tr>`).join('')}</tbody>
      </table>
    </div>`;
  }
  // Group the explicit vehicle list by brand, listing each assigned model + year.
  function compatVehiclesBlock(p) {
    const vehicles = p.vehicles || [];
    if (!vehicles.length) return '';
    // resolve display names from brand model records, group by brand
    const byBrand = {};
    vehicles.forEach(v => {
      const br = brand(v.brand);
      if (!br) return;
      const bGroup = byBrand[v.brand] || (byBrand[v.brand] = { br, models: {} });
      const mGroup = bGroup.models[v.model] || (bGroup.models[v.model] = { years: [] });
      if (v.year != null && mGroup.years.indexOf(v.year) < 0) mGroup.years.push(v.year);
    });
    const hasAny = Object.keys(byBrand).length > 0;
    if (!hasAny) return '';
    const brandCards = Object.values(byBrand).map(g => {
      const mArr = Object.keys(g.models).map(mEn => {
        const rec = (g.br.models || []).find(x => x.en === mEn);
        const mName = rec ? modelName(rec) : mEn;
        const years = g.models[mEn].years.slice().sort((a, b) => a - b);
        const yrTxt = years.length ? `<span class="cv-years">${years.join(' · ')}</span>` : '';
        return `<div class="cv-model"><span class="cv-name">${VEL.esc(mName)}</span>${yrTxt}</div>`;
      });
      return `<div class="cv-brand">
        <div class="cv-brand-head"><span class="cv-logo">${VEL.brandLogoImg(g.br.slug, { h: 22 })}</span><span class="cv-brand-name">${VEL.esc(brandName(g.br))}</span></div>
        <div class="cv-models">${mArr.join('')}</div>
      </div>`;
    });
    return `<div class="pdp-vehicles">
      <h3 class="s-head">${pt('compatible_vehicles')}</h3>
      <div class="cv-grid">${brandCards.join('')}</div>
    </div>`;
  }

  function pdpHTML(slug) {
    const p = state.data.products.find(x => x.slug === slug);
    if (!p) return notFound();
    const br = brandOfAsset(p);
    const lang = L();
    const shapes = p.keyShapes || [];
    // auto-select the fitted shape when arriving from the Fitment Finder
    if (!state.productShape[p.id] && state.fitment && state.fitment.brand === p.brandSlug) {
      const fs = state.fitment.shape;
      const mOk = !state.fitment.model || !(p.models && p.models.length) || p.models.includes(state.fitment.model);
      const yOk = !state.fitment.year || !(p.years && p.years.length) || p.years.some(y => String(y) === String(state.fitment.year));
      if (fs && mOk && yOk && shapes.some(s => s.shape === fs && s.available)) state.productShape[p.id] = fs;
    }
    const activeShape = shapes.find(sh => sh.shape === (state.productShape[p.id] || ''));
    const qty = state.productQty || 1;
    const canAdd = !p.outOfStock && activeShape && activeShape.available;

    const b = bundleOfBrand(p.brandSlug);
    const setItems = b ? brandSetItems(p.brandSlug) : null;

    // selected shape options html
    const shapeHTML = `<div class="shape-selector">
      <div class="label">${pt('select_key_shape')} <span style="color:var(--gold-deep)">${activeShape ? '— ' + pt('shape') + ' ' + activeShape.shape : ''}</span></div>
      <div class="shape-options">
        ${shapes.map(sh => {
          const cls = sh.available ? 'selectable' : 'unavailable';
          const sel = activeShape && activeShape.shape === sh.shape ? 'selected' : '';
          const colr = sh.available ? '#2b2b2b' : '#B9B9B9';
          return `<button class="shape-opt ${cls} ${sel}" data-shapecopy="0" data-shape="${sh.shape}" ${sh.available ? '' : 'disabled'}>
            ${sh.available ? '' : `<svg class="xstar" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" stroke="#999" stroke-width="2" stroke-linecap="round"/></svg>`}
            ${VEL.keyShapeSVG(sh.shape, { color: colr, w: 60, h: 92 })}
            <div class="lbl">${pt('shape')} ${sh.shape}</div>
            ${sh.available ? '' : `<div class="oos">${pt('out_of_stock')}</div>`}
          </button>`;
        }).join('')}
      </div>
    </div>`;

    let invHTML = '';
    if (canAdd) {
      const left = p.inventory;
      invHTML = `<div class="inv-note ${left > 5 ? 'many' : ''}">${left <= 5 ? pt('only_left', { n: left }) : '● ' + pt('premium_quality')}</div>`;
    } else if (activeShape && !activeShape.available) {
      invHTML = `<div class="inv-note">${pt('out_of_stock')}</div>`;
    }

    const preorderDays = state.data.settings.preorderDays || 5;
    const isPreorder = p.preorder;
    const deliveryHTML = `<div class="delivery-info-box ${isPreorder ? 'preorder' : 'standard'}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="20" height="20"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
      <div class="delivery-info-text">
        ${isPreorder
          ? (lang === 'ar' ? `<strong>طلب مسبق / تصنيع حسب الطلب</strong><br>يتم التصنيع خلال ${preorderDays} أيام ثم الشحن` : `<strong>Pre-order / Made to Order</strong><br>Production takes ~${preorderDays} days, then shipped`)
          : (lang === 'ar' ? `<strong>جاهز للشحن</strong><br>يتم الشحن في نفس اليوم أو اليوم التالي` : `<strong>Ready to Ship</strong><br>Ships same day or next business day`)}
      </div>
    </div>`;

    const giftPackagingHTML = `<div class="gift-packaging-option">
      <label class="gift-toggle">
        <input type="checkbox" id="gift-packaging" data-gifttoggle="1">
        <span class="gift-check"></span>
        <span class="gift-label">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="16" height="16"><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M3 12h18v9H3z"/><path d="M12 8c-1.5-2-4-3-4-3s1.5 2 4 3zm0 0c1.5-2 4-3 4-3s-1.5 2-4 3z"/></svg>
          ${lang === 'ar' ? 'تغليف هدية فاخر' : 'Premium Gift Packaging'}
        </span>
      </label>
      <div class="gift-details" id="gift-details" style="display:none">
        <p class="gift-desc">${lang === 'ar' ? 'يتم تغليف المنتج في صندوق هدية فاخر مع شريط ذهبي وبطاقة إهداء مخصصة.' : 'Your item arrives in a luxury gift box with a gold ribbon and personalized gift card.'}</p>
      </div>
    </div>`;

    const preorderHTML = isPreorder ? `
      <div class="preorder-banner"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#C8A15A"><path d="M12 2v7m0 0-2-2m2 2 2-2"/><rect x="3" y="6" width="18" height="14" rx="2"/></svg>
        <span class="pp">${pt('preorder_note')}</span></div>` : '';

    // Gallery
    const gallery = `<div class="gallery">
      <div class="thumbs">${p.images.map((im, i) => `<div class="thumb ${i === 0 ? 'active' : ''}" data-thumb="${i}"><img src="${im}" alt=""></div>`).join('')}</div>
      <div class="main"><img id="gallery-main" src="${img(p)}" alt=""></div>
    </div>`;

    const tabs = `<div class="pdp-tabs">
      <div class="tab-head">
        <button class="tab active" data-tab="desc">${pt('description')}</button>
        <button class="tab" data-tab="material">${pt('material')}</button>
        <button class="tab" data-tab="compat">${pt('compatibility')}</button>
        <button class="tab" data-tab="ship">${pt('shipping_returns')}</button>
      </div>
      <div class="tab-body" id="tab-body">
        <p id="tab-desc">${VEL.esc(fld(p, 'description'))}</p>
      </div>
    </div>`;

    // Complete your set widget
    const setHTML = setItems ? buildSetWidget(p, setItems, b) : '';

    return `
    ${crumbs([pt('breadcrumb_home'), catLabel(p.category), (prodName(p))])}
    <div class="container">
      <div class="pdp">
        ${gallery}
        <div class="pdp-info">
          <div class="brand-line"><span style="display:inline-flex;align-items:center;height:20px;width:auto;max-width:56px">${VEL.brandLogoImg(br.slug, { h: 18 })}</span> ${VEL.esc(brandName(br))}</div>
          <h1>${VEL.esc(prodName(p))}</h1>
          ${pdpFitLine(p, br)}
          <div class="rating-row"><span class="rating">★★★★★</span> <b style="color:var(--ink);font-weight:600">${(4.6 + (p.price % 5) / 10).toFixed(1)}</b> <span>(${40 + (p.price % 110)} ${pt('can_review')})</span></div>
          <div class="price-block">
            <span class="price">${VEL.money(p.price)}</span>
            ${p.oldPrice ? `<span class="old">${VEL.money(p.oldPrice)}</span>` : ''}
            ${p.discount ? `<span class="disc-chip">-${p.discount}%</span>` : ''}
          </div>
          <div class="trust">
            <div class="t"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 2 4 5v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V5z"/></svg> ${pt('premium_quality')}</div>
            <div class="t"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M20 6 9 17l-5-5"/></svg> ${pt('warranty')}</div>
          </div>
          ${deliveryHTML}
          ${preorderHTML}
          ${giftPackagingHTML}
          ${shapeHTML}
          ${invHTML}
          <div class="qty-row">
            <div class="qty">
              <button data-qtymax="1" id="qty-dec">−</button>
              <input id="qty" type="text" inputmode="numeric" value="${qty}">
              <button id="qty-inc">+</button>
            </div>
            ${p.preorder ? `<button class="btn btn-gold" id="preorder-btn" data-preorder="${p.id}" style="flex:1">${pt('reserve')}</button>`
              : `<button class="btn btn-gold" id="addbtn" data-addpdp="${p.id}" ${canAdd ? '' : 'disabled'}>${pt('add_to_cart')}</button>`}
          </div>
          ${setHTML}
          ${tabs}
          ${specsBlock(p)}
          ${compatVehiclesBlock(p)}
        </div>
      </div>
    </div>`;
  }

  function buildSetWidget(baseProduct, setItems, bundle) {
    if (!bundle) return '';
    const br = brand(bundle.brandSlug);
    const isCase = baseProduct.category === 'keycase';
    // referenced items
    const items = [
      { label: pt('key_cases'), prod: setItems.keyCase },
      { label: pt('key_holders'), prod: setItems.keyHolder },
      { label: pt('car_medals'), prod: setItems.medal }
    ].filter(x => x.prod);
    const missing = items.filter(x => x.prod.id !== baseProduct.id);

    const options = [];
    // combo definitions (relative to baseProduct)
    const combos = [
      { label: pt('three_piece'), all: true },
      { label: pt('key_case_only'), only: 'keycase' },
      { label: pt('key_case_medal'), cats: ['keycase', 'medal'] },
      { label: pt('key_case_holder'), cats: ['keycase', 'keyholder'] }
    ];

    return `<div class="bundle-card" data-section="set">
      <div class="bs-head">${pt('complete_your_set', { brand: brandName(br) }).toUpperCase()}</div>
      <div class="bs-sub">${VEL.esc(fld(bundle, 'sub'))}</div>
      <div class="bundle-items">
        ${items.map(it => `<div class="bundle-item">
            <img src="${img(it.prod)}" alt="">
            <div><div class="bi-name">${VEL.esc(prodName(it.prod))}</div><div class="bi-price">${VEL.money(it.prod.price)}</div></div>
          </div>`).join('')}
        <span class="bundle-plus">+</span>
      </div>
      <div class="bundle-price-row">
        <div><div class="bs-sub" style="margin:0">${pt('regular_price')}</div><span class="rp">${VEL.money(bundle.normalTotal)}</span></div>
        <div><div class="bs-sub" style="margin:0">${pt('bundle_price')}</div><span class="nprice">${VEL.money(bundle.bundlePrice)}</span></div>
        <span class="save">${pt('you_save')} ${VEL.money(bundle.discount)}</span>
      </div>
      <div class="bundle-choices">
        ${combos.map((c, i) => {
          const comboItems = itemCombo(baseProduct, c);
          const price = comboPrice(comboItems, bundle);
          const active = state.productOption === i;
          return `<button class="choice-btn ${active ? 'active' : ''}" data-option="${i}" data-base="${baseProduct.id}">
            ${VEL.esc(c.label)} <span class="pb">${VEL.money(price)}</span></button>`;
        }).join('')}
      </div>
      <button class="btn btn-gold btn-block" id="addset" data-base="${baseProduct.id}"><span id="addset-label">${pt('add_3_piece_set')}</span></button>
    </div>`;
  }

  function itemCombo(base, combo) {
    const set = brandSetItems(base.brandSlug);
    const all = [set.keyCase, set.keyHolder, set.medal].filter(Boolean);
    if (combo.all) return all;
    if (combo.only) return [set[combo.only === 'keycase' ? 'keyCase' : combo.only]];
    if (combo.cats) {
      return all.filter(x => x && combo.cats.includes(x.category));
    }
    return [base];
  }
  function comboPrice(comboItems, bundle) {
    if (!comboItems || !comboItems.length) return 0;
    const cats = comboItems.map(x => x.category);
    if (cats.includes('keycase') && cats.includes('keyholder') && cats.includes('medal')) return bundle.bundlePrice;
    return comboItems.reduce((s, x) => s + x.price, 0);
  }

  // ============================================================== CATEGORY
  function categoryHTML(type) {
    const map = { keycases: 'keycase', keyholders: 'keyholder', medals: 'medal' };
    const cat = map[type] || 'keycase';
    const lang = L();
    const title = catLabel(cat);
    // Only show the 17 specified brands in the category filter
    const ALLOWED_BRANDS = ['mercedes-benz','bmw','mg','audi','hyundai','kia','peugeot','byd','gac','jetour','toyota','jeep','citroen','haval','cupra','volkswagen','skoda'];
    const brands = state.data.brands.filter(b => ALLOWED_BRANDS.includes(b.slug));
    // Get active filter from URL params
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const activeBrand = params.get('brand') || '';
    const activeModel = params.get('model') || '';
    const activeYear = params.get('year') || '';
    // Filter products
    let list = state.data.products.filter(p => p.category === cat);
    if (activeBrand) list = list.filter(p => p.brandSlug === activeBrand);
    if (activeModel) list = list.filter(p => p.models && p.models.includes(activeModel));
    if (activeYear) list = list.filter(p => p.years && p.years.some(y => String(y) === activeYear));
    // Get models for selected brand
    const selBrand = brands.find(b => b.slug === activeBrand);
    const models = selBrand ? (selBrand.models || []) : [];
    // Filter models that actually have products in this category
    const availModels = models.filter(m => list.some(p => p.models && p.models.includes(m.en)));
    // Get years for selected model
    const selModel = availModels.find(m => m.en === activeModel);
    const years = selModel ? (selModel.years || []) : [];
    // Filter years that have matching products
    const availYears = years.filter(y => list.some(p => p.years && p.years.some(py => String(py) === String(y))));
    const resultCount = list.length;
    const hasFilters = activeBrand || activeModel || activeYear;

    const catMeta = {
      keycase: {
        icon: '🔑',
        desc: lang === 'ar' ? 'جرابات مفاتيح فاخرة من ألياف الكربون والجلد المصنوع يدويًا — حماية وأناقة لمفتاح سيارتك' : 'Premium key cases crafted from aerospace-grade carbon fibre and hand-stitched leather. Protect your key in style.',
        accent: '--gold-deep'
      },
      keyholder: {
        icon: '✨',
        desc: lang === 'ar' ? 'حاملات مفاتيح معدنية فاخرة بتفاصيل ثلاثية الأبعاد — إكسسوار مميز يجمع بين الأناقة والعملية' : 'Signature metal key holders with 3D-machined details. A premium everyday accessory that combines elegance and function.',
        accent: '--gold-rich'
      },
      medal: {
        icon: '🏅',
        desc: lang === 'ar' ? 'ميداليات سيارات فاخرة للمقتنين — اللمسة الأخيرة لعشاق التفاصيل' : 'Collector-grade car medals finished in deep black and champagne gold. The perfect finishing touch.',
        accent: '--gold'
      }
    };
    const meta = catMeta[cat] || catMeta.keycase;

    return `${crumbs([pt('breadcrumb_home'), title])}
      <div class="container">
        <div class="cat-page">
          <div class="cat-header">
            <div>
              <span class="kicker">${title}</span>
              <h1 class="cat-title"><span class="cat-icon">${meta.icon}</span> ${title}</h1>
              <p class="cat-desc">${meta.desc}</p>
            </div>
            <div class="cat-result-count">
              <span class="crc-num">${resultCount}</span>
              <span class="crc-label">${lang === 'ar' ? 'منتج' : 'product'+(resultCount!==1?'s':'')}</span>
            </div>
          </div>

          <div class="cat-filter" id="cat-filter">
            <div class="cf-label">${lang === 'ar' ? 'اختر سيارتك' : 'Select Your Vehicle'}</div>
            <div class="cf-brands" id="cf-brands">
              <button class="cf-brand-pill${!activeBrand ? ' active' : ''}" data-cfbrand="" title="${lang === 'ar' ? 'الكل' : 'All'}">
                <span class="cf-brand-all">${lang === 'ar' ? 'الكل' : 'All'}</span>
              </button>
              ${brands.map(b => {
                const count = state.data.products.filter(p => p.brandSlug === b.slug && p.category === cat).length;
                return `<button class="cf-brand-pill${activeBrand === b.slug ? ' active' : ''}" data-cfbrand="${b.slug}" title="${VEL.esc(brandName(b))}">
                  <img src="${VEL.brandLogoUrl(b.slug)}" alt="${VEL.esc(brandName(b))}" class="cf-brand-logo" loading="lazy">
                  <span class="cf-brand-name">${VEL.esc(brandName(b))}</span>
                  <span class="cf-brand-count">${count}</span>
                </button>`;
              }).join('')}
            </div>
            <div class="cf-dropdowns">
              <div class="cf-dd-wrap${!activeBrand ? ' disabled' : ''}">
                <label class="cf-dd-label">${lang === 'ar' ? 'الموديل' : 'Model'}</label>
                <select class="cf-dd" id="cf-model" data-cfmodel ${!activeBrand ? 'disabled' : ''}>
                  <option value="">${lang === 'ar' ? 'اختر الموديل' : 'Select Model'}</option>
                  ${availModels.map(m => `<option value="${VEL.esc(m.en)}"${activeModel === m.en ? ' selected' : ''}>${VEL.esc(lang === 'ar' ? (m.ar || m.en) : m.en)}</option>`).join('')}
                </select>
              </div>
              <div class="cf-dd-wrap${!activeModel ? ' disabled' : ''}">
                <label class="cf-dd-label">${lang === 'ar' ? 'السنة' : 'Year'}</label>
                <select class="cf-dd" id="cf-year" data-cfyear ${!activeModel ? 'disabled' : ''}>
                  <option value="">${lang === 'ar' ? 'اختر السنة' : 'Select Year'}</option>
                  ${availYears.map(y => `<option value="${y}"${activeYear === String(y) ? ' selected' : ''}>${y}</option>`).join('')}
                </select>
              </div>
              ${hasFilters ? `<button class="cf-clear" id="cf-clear" title="${lang === 'ar' ? 'مسح الفلاتر' : 'Clear filters'}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M18 6L6 18M6 6l12 12"/></svg>
                ${lang === 'ar' ? 'مسح' : 'Clear'}
              </button>` : ''}
            </div>
          </div>

          ${resultCount > 0 ? productGrid(list) : `<div class="empty"><div class="em-ic">◆</div>${lang === 'ar' ? 'لا توجد منتجات مطابقة' : 'No products match your selection'}<div style="margin-top:16px"><button class="btn btn-outline" id="cf-clear-empty">${lang === 'ar' ? 'مسح الفلاتر' : 'Clear Filters'}</button></div></div>`}
        </div>
      </div>`;
  }

  function brandChips(cat) { return ''; }

  // ============================================================== BRAND PAGE
  function brandHTML(slug) {
    const br = brand(slug);
    if (!br) return notFound();
    const lang = L();
    let list = state.data.products.filter(p => p.brandSlug === slug);
    if (state.fitment) list = fitFilter(list, state.fitment);
    // group by category
    const groups = [
      ['keycases', pt('key_cases'), list.filter(p => p.category === 'keycase')],
      ['keyholders', pt('key_holders'), list.filter(p => p.category === 'keyholder')],
      ['medals', pt('car_medals'), list.filter(p => p.category === 'medal')]
    ].filter(g => g[2].length);
    const b = bundleOfBrand(slug);
    const bName = VEL.esc(brandName(br));
    const totalProducts = list.length;

    // Update page title for SEO
    document.title = `${brandName(br)} — ${lang === 'ar' ? 'إكسسوارات مفاتيح فاخرة' : 'Premium Key Accessories'} | SPINTO`;

    return `${crumbs([pt('breadcrumb_home'), bName])}
      <div class="container">
        <div class="brand-landing">
          <div class="brand-hero">
            <div class="brand-hero-logo">${VEL.brandLogoImg(br.slug, { h: 64 })}</div>
            <div class="brand-hero-info">
              <span class="kicker">${lang === 'ar' ? 'مجموعة' : 'Collection'}</span>
              <h1 class="brand-hero-title">${bName}</h1>
              <p class="brand-hero-sub">${lang === 'ar'
                ? `إكسسوارات مفاتيح فاخرة مصممة خصيصًا لسيارات ${bName}. جرابات مفاتيح، حاملات وميداليات بجودة استثنائية.`
                : `Premium key accessories designed exclusively for ${bName}. Key cases, holders and medals crafted with exceptional quality.`}</p>
              <div class="brand-hero-stats">
                <span class="bhs-item"><strong>${totalProducts}</strong> ${lang === 'ar' ? 'منتج' : (totalProducts === 1 ? 'product' : 'products')}</span>
                ${groups.map(g => `<span class="bhs-item">${g[1]}: ${g[2].length}</span>`).join('')}
              </div>
            </div>
          </div>

          ${b ? `<div class="brand-bundle-cta">
            <div class="bbc-inner">
              <div class="bbc-text">
                <strong>${lang === 'ar' ? 'وفّر أكثر مع الطقم الكامل' : 'Save More with the Complete Set'}</strong>
                <span>${lang === 'ar' ? `طقم ${bName} الكامل: جراب + حامل + ميدالية` : `Complete ${bName} set: Key Case + Holder + Medal`}</span>
              </div>
              <a class="btn btn-gold btn-sm" href="#/packages">${lang === 'ar' ? 'تسوق الباقات' : 'Shop Packages'} →</a>
            </div>
          </div>` : ''}

          <div class="brand-categories">
            ${groups.map(g => `
              <div class="brand-cat-section">
                <div class="brand-cat-head">
                  <h2>${g[1]}</h2>
                  <a class="link-all" href="#/category/${g[0]}?brand=${slug}">${pt('view_all')} →</a>
                </div>
                ${productGrid(g[2])}
              </div>
            `).join('')}
          </div>

          ${totalProducts === 0 ? `<div class="empty"><div class="em-ic">◆</div>${lang === 'ar' ? 'لا توجد منتجات حاليًا لهذه الماركة' : 'No products available for this brand yet.'}<div style="margin-top:16px"><a class="btn btn-outline" href="#/collections">${lang === 'ar' ? 'تصفح المجموعات' : 'Browse Collections'}</a></div></div>` : ''}
        </div>
      </div>`;
  }

  // ============================================================== BRANDS PAGE
  function brandsHTML() {
    return `${crumbs([pt('breadcrumb_home'), pt('brands')])}<div class="container">
      <div class="section"><div class="container" style="padding:0">
        <div class="section-head"><div><span class="kicker">${pt('shop_by_car_brand')}</span><h2>${pt('shop_by_car_brand')}</h2></div></div>
        <div class="brand-grid" data-grid="all">${state.data.brands.map(b => brandCard(b)).join('')}</div>
      </div></div>
    </div>`;
  }

  // ============================================================== FITMENT
  // Localised model display name (models are {en, ar} objects)
  function modelName(m) { return (m && (L() === 'ar' ? (m.ar || m.en) : (m.en || m.ar))) || ''; }
  // Localised summary of the current selection
  function fitSummary(f) {
    if (!f || !f.brand) return '';
    const br = brand(f.brand);
    const bits = [];
    if (br) bits.push(brandName(br));
    const m = (br && br.models || []).find(x => x.en === f.model);
    if (m) bits.push(modelName(m));
    if (f.year) bits.push(f.year);
    if (f.shape) bits.push(pt('shape') + ' ' + f.shape);
    return bits.join(' · ');
  }

  // alias used by category / brand pages — persistent "Your Vehicle" context bar
  function fitmentChip() {
    const f = state.fitment;
    if (!f || !f.brand) return '';
    return fitVehicleContext(f, !!(f.brand && f.model && f.year && f.shape));
  }

  function fitmentHTML() {
    const brands = state.data.brands;
    const f = state.fitment || {};
    const curBrand = f.brand ? brand(f.brand) : null;
    const models = curBrand ? curBrand.models : [];
    const curModel = (f.model && models) ? models.find(m => m.en === f.model) : null;
    const years = curModel ? curModel.years : [];
    // shapes the vehicle really supports (from the brand model record), refined
    // to those that actually have an in-stock, compatible product — so an
    // out-of-stock key shape becomes unclickable in the Fitment Finder.
    const modelShapes = curModel ? (curModel.shapes || []) : [];
    const inStockShapes = new Set();
    state.data.products.forEach(p => {
      if (p.brandSlug !== f.brand) return;
      if (f.model && p.models && p.models.length && !p.models.includes(f.model)) return;
      if (f.year && p.years && p.years.length && !p.years.some(y => String(y) === String(f.year))) return;
      (p.keyShapes || []).forEach(s => { if (s.available) inStockShapes.add(s.shape); });
    });
    const supShapes = modelShapes.filter(sh => inStockShapes.has(sh));
    const step = state.fitStep || 1;
    const done1 = !!f.brand, done2 = !!f.model, done3 = !!f.year, done4 = !!f.shape;
    const complete = done1 && done2 && done3 && done4;

    let results = [];
    if (complete) results = state.data.products.filter(p => compatibleWithModel(p, f));

    const stepsMeta = [
      { n: 1, label: pt('brand'), done: done1 },
      { n: 2, label: pt('model'), done: done2 },
      { n: 3, label: pt('year'), done: done3 },
      { n: 4, label: pt('key_shape'), done: done4 },
    ];

    // ---- step-specific selectors (visual, not dropdowns) ----
    let body = '';
    if (step === 1) {
      body = `<div class="fit-subhead"><span class="kicker">${pt('step')} 1</span><h3>${pt('select_car_brand')}</h3></div>
        <div class="fit-brand-grid">
          ${brands.map(b => `<button class="fit-brand-card ${f.brand === b.slug ? 'sel' : ''}" data-fitbrand="${b.slug}" type="button">
            <span class="logo-circle">${VEL.brandLogoImg(b.slug, { h: 44 })}</span>
            <span class="name">${VEL.esc(brandName(b))}</span>
          </button>`).join('')}
        </div>`;
    } else if (step === 2) {
      body = `<div class="fit-subhead"><span class="kicker">${pt('step')} 2</span><h3>${pt('select_car_model')}</h3></div>
        ${models.length ? `<div class="fit-model-grid">
          ${models.map(m => `<button class="fit-model-card ${f.model === m.en ? 'sel' : ''}" data-fitmodel="${VEL.esc(m.en)}" type="button">
            <span class="model-name">${VEL.esc(modelName(m))}</span>
          </button>`).join('')}
        </div>` : `<div class="empty"><div class="em-ic">◆</div>${pt('no_results')}</div>`}`;
    } else if (step === 3) {
      body = `<div class="fit-subhead"><span class="kicker">${pt('step')} 3</span><h3>${pt('select_year_of_model')}</h3></div>
        <div class="fit-year-grid">
          ${years.map(y => `<button class="fit-year ${f.year === y ? 'sel' : ''}" data-fityear="${y}" type="button">${y}</button>`).join('')}
        </div>`;
    } else {
      body = `<div class="fit-subhead"><span class="kicker">${pt('step')} 4</span><h3>${pt('select_key_shape')}</h3></div>
        <div class="shape-options">
          ${['A','B','C','D'].map(sh => {
            const av = supShapes.includes(sh);
            const sel = f.shape === sh;
            return `<button class="shape-opt ${av ? 'selectable' : 'unavailable'} ${sel ? 'selected' : ''}" data-fit-shape="${sh}" ${av ? '' : 'disabled'} type="button">
              ${av ? '' : `<svg class="xstar" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" stroke="#999" stroke-width="2" stroke-linecap="round"/></svg>`}
              ${VEL.keyShapeSVG(sh, { color: av ? '#2b2b2b' : '#B9B9B9', w: 60, h: 92 })}
              <div class="lbl">${pt('shape')} ${sh}</div>
              ${av ? '' : `<div class="oos">${pt('not_available')}</div>`}
            </button>`;
          }).join('')}
        </div>
        <div class="fit-hint">${pt('exact_match')}</div>`;
    }

    return `${crumbs([pt('breadcrumb_home'), pt('fitment_finder')])}
    <div class="container">
      <div class="fitment-hero">
        <span class="fit-eyebrow">${pt('fitment_finder')}</span>
        <h1 class="fit-title">${pt('find_your_key')}</h1>
        <p class="fit-sub">${pt('choose_brand')}</p>
      </div>

      <div class="fit-steps">
        ${stepsMeta.map(s => `<button class="fit-step ${step === s.n ? 'active' : ''} ${s.done ? 'done' : ''}" data-fitstep="${s.n}" type="button">
          <span class="dot">${s.done ? '✓' : s.n}</span><span class="lbl">${s.label}</span>
        </button>`).join('')}
      </div>

      ${fitVehicleContext(f, complete)}
      <div class="fitment-body">
        ${body}
      </div>

      ${complete ? `<div class="section fit-results" style="padding-top:26px">
        <div class="container" style="padding:0">
          <div class="section-head"><div><span class="kicker">${pt('results_for')}</span><h2>${pt('compatible_products')}</h2></div></div>
          ${results.length ? resultsGrid(results, f) : `<div class="empty"><div class="em-ic">◆</div>${pt('no_results')}</div>`}
        </div>
      </div>` : ''}
    </div>`;
  }

  // Persistent vehicle context bar (seen while browsing the fitment page)
  function fitVehicleContext(f, complete) {
    if (!f || !f.brand) return '';
    const info = fitSummary(f);
    return `<div class="fit-vehicle">
      <div class="fh">
        <span class="fh-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><path d="M3 14 4 9h16l1 5"/><rect x="2" y="14" width="20" height="5" rx="1"/></svg></span>
        <div class="fh-txt">
          <span class="fh-label">${pt('your_vehicle')}</span>
          <span class="fh-value">${VEL.esc(info)}</span>
        </div>
      </div>
      <div class="fit-vehicle-actions">
        <button class="btn btn-ghost btn-sm" id="fit-change" type="button">${pt('change')}</button>
        ${complete ? `<button class="btn btn-ghost btn-sm" id="clear-fitment" type="button">${pt('clear_fitment')}</button>` : ''}
      </div>
    </div>`;
  }

  function compatibleWithModel(p, f) {
    if (!f || !f.brand) return true;
    if (p.brandSlug !== f.brand) return false;
    if (f.model && p.models && p.models.length && !p.models.includes(f.model)) return false;
    if (f.year && p.years && p.years.length && !p.years.some(y => String(y) === String(f.year))) return false;
    if (f.shape) {
      const rec = (p.keyShapes || []).find(s => s.shape === f.shape);
      if (!rec || !rec.available) return false;
    }
    return true;
  }

  function fitFilter(list, f) {
    if (!f || !f.brand) return list;
    return list.filter(p => compatibleWithModel(p, f));
  }

  // Fitment result card — image, name, brand, compatibility, price, discount,
  // stock status, View Product + Add to Cart.
  // localised model names for a product, using the brand's {en,ar} records
  function modelLabelList(p, br) {
    const rec = (br && br.models) || [];
    return (p.models || []).map(en => {
      const m = rec.find(x => x.en === en);
      return m ? modelName(m) : en;
    }).join(' · ');
  }

  function fitResultCard(p, f) {
    const br = brandOfAsset(p);
    const shape = f.shape;
    const shapeAvail = (p.keyShapes || []).some(s => s.shape === shape && s.available);
    const inStock = !p.outOfStock && shapeAvail;
    const compatModels = modelLabelList(p, br);
    const stock = inStock ? (p.inventory <= 5 ? pt('only_left', { n: p.inventory }) : pt('available')) : pt('out_of_stock');
    return `<article class="product-card reveal fit-card" data-slug="${p.slug}">
      <div class="media">
        <a href="#/product/${p.slug}"><img src="${img(p)}" alt="${VEL.esc(p.name_en)}" loading="lazy"></a>
        ${p.discount ? `<span class="disc">-${p.discount}%</span>` : ''}
        <span class="stock ${inStock ? 'ok' : 'no'}">${VEL.esc(stock)}</span>
      </div>
      <div class="body">
        <span class="cat">${VEL.esc(brandName(br))} · ${catLabel(p.category)}</span>
        <a href="#/product/${p.slug}" class="name">${VEL.esc(prodName(p))}</a>
        <span class="compat">${VEL.esc(pt('compatible_with', { brand: brandName(br) }))} — ${VEL.esc(compatModels)} · ${f.year}</span>
        <div class="price-row">
          <span class="price">${VEL.money(p.price)}</span>
          ${p.oldPrice ? `<span class="old">${VEL.money(p.oldPrice)}</span>` : ''}
        </div>
        <div class="fit-actions">
          <a class="btn btn-outline btn-sm" href="#/product/${p.slug}">${pt('view_product')}</a>
          <button class="btn btn-gold btn-sm" data-addfit="${p.id}" ${inStock ? '' : 'disabled'}>${pt('add_to_cart')}</button>
        </div>
      </div>
    </article>`;
  }

  function resultsGrid(results, f) {
    return `<div class="product-grid">${results.map(p => fitResultCard(p, f)).join('')}</div>`;
  }
  // ============================================================== STATIC PAGES
  function staticHTML(kind) {
    const pages = {
      keyguide: { title: 'Key Guide', body: keyGuideHTML() },
      shipping: { title: pt('shipping'), body: `<p>${VEL.esc(state.data.settings.deliveryNote_en)}</p><p>Free delivery on orders over ${VEL.money(state.data.settings.freeShippingThreshold)}. Delivery fee is ${VEL.money(state.data.settings.shippingFee)} otherwise.</p><p><b>${pt('easy_returns')}:</b> ${VEL.esc(state.data.settings.returnPolicy.note_en)}</p>` },
      warranty: { title: pt('warranty_page'), body: `<p>${VEL.esc(state.data.settings.warranty_en)}</p><ul><li>Coverage against manufacturing defects</li><li>2-year warranty on Carbon Edition</li><li>1-year warranty on leather, holders and medals</li></ul>` },
      about: { title: pt('about_velocci'), body: `<p>${VEL.esc(state.data.settings.footerAbout_en)}</p><p>SPINTO was born from a simple belief — that the key you carry every day deserves the same attention to design as the car you love. Every case, holder and medal is engineered with real materials and guaranteed compatibility.</p>` },
      workshop: { title: pt('workshop'), body: `<p>Every Spinto piece passes through our workshop where craftsmen check the fit, the finish and the feel. From carbon-fibre layup to the final gold bezel, nothing leaves without being tested against a real car key.</p>` }
    };
    const pg = pages[kind];
    if (!pg) return notFound();
    return `${crumbs([pt('breadcrumb_home'), pg.title])}<div class="container">
      <div class="section"><div class="container" style="padding:0;max-width:820px">
        <div class="section-head"><div><span class="kicker">${pg.title}</span><h2>${pg.title}</h2></div></div>
        ${pg.body}
      </div></div></div>`;
  }

  function keyGuideHTML() {
    return `<p>To find the right case for your key, identify the shape of your keyfob:</p>
      <div class="shape-options" style="margin:20px 0">
        ${['A','B','C','D'].map(sh => `<div class="shape-opt selectable"><svg viewBox="0 0 60 92" width="60" height="92">${VEL.keyShapeSVG(sh, { color: '#2b2b2b', w:60, h:92 }).split('<svg')[0]}</svg><div class="lbl">${pt('shape')} ${sh}</div></div>`).join('')}
      </div>
      <ul><li><b>${pt('shape')} A</b> — slim rectangular fob with a single rubber button.</li>
      <li><b>${pt('shape')} B</b> — rounder fob with a metal ring and two buttons.</li>
      <li><b>${pt('shape')} C</b> — wide oval fob with a large screen area.</li>
      <li><b>${pt('shape')} D</b> — key card / slim card-style key.</li></ul>
      <p>Still unsure? Use the <a href="#/fitment" style="color:var(--gold-deep);font-weight:700">Fitment Finder</a> to match your exact model.</p>`;
  }

  function notFound() {
    return `<div class="container"><div class="empty"><div class="em-ic">◆</div><h2>Page not found</h2><p>${pt('no_results')}</p><a class="btn btn-gold" href="#/">${pt('back_home')}</a></div></div>`;
  }

  function crumbs(items) {
    const arr = items.map((it, i) => {
      if (i === items.length - 1) return `<b>${VEL.esc(it)}</b>`;
      const href = i === 0 ? '#/' : '';
      return `<a href="${href}">${VEL.esc(it)}</a>`;
    });
    return `<div class="container"><nav class="crumbs">${arr.join('<span class="sep">›</span>')}</nav></div>`;
  }

  // ============================================================== CART DRAWER
  function renderCartDrawer() {
    const drawer = $('#cart-drawer');
    if (!drawer) return;
    const lang = L();
    const totals = cartTotals();
    const empty = !totals.items.length;

    let itemsHTML = '';
    if (!empty) {
      itemsHTML = totals.items.map(it => `
        <div class="drawer-item">
          <img src="${img(it.prod)}" alt="">
          <div class="di-info">
            <div class="di-name">${VEL.esc(prodName(it.prod))}</div>
            ${cartItemMeta(it)}
            <div class="di-qty">
              <button data-qtyd="${it.productId}|${it.keyShape}" data-qtyv="-1">−</button>
              <input type="text" value="${it.qty}" readonly>
              <button data-qtyd="${it.productId}|${it.keyShape}" data-qtyv="1">+</button>
            </div>
          </div>
          <div class="di-side">
            <div class="di-price">${VEL.money(it.prod.price * it.qty)}</div>
            <button class="di-remove" data-remove="${it.productId}|${it.keyShape}" title="${lang === 'ar' ? 'إزالة' : 'Remove'}" aria-label="${lang === 'ar' ? 'إزالة من السلة' : 'Remove from cart'}">✕</button>
          </div>
        </div>`).join('');
    } else {
      itemsHTML = `<div class="empty" style="padding:40px 0"><div class="em-ic">🛒</div>${pt('empty_cart')}</div>`;
    }

    const free = state.data.settings.freeShippingThreshold || 0;
    const sub = totals.subtotal;
    const freeRemaining = Math.max(0, free - sub);

    const head = $('#drawer-head-count');
    if (head) head.textContent = '(' + cartCount() + ')';
    $('#drawer-body').innerHTML = itemsHTML;
    const bundleActive = totals.bundleDiscount > 0;
    $('#cart-summary').innerHTML = `
      <div class="summary">
        ${bundleActive ? `<div class="bundle-tag">${pt('bundle_applied')}</div>
        <div class="bundle-price-box"><div class="bp-label">${pt('bundle_price')}</div><div class="bp-val"><span class="old">${VEL.money(totals.bundleSubtotal)}</span><span class="bp-arrow">→</span><span class="bp-new">${VEL.money(totals.bundleSubtotal - totals.bundleDiscount)}</span></div></div>
        <div class="drawer-savebox"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20 12 12 20 4 12 12 4z"/><path d="M9 12h6"/></svg><div class="txt">${pt('you_saved', { n: VEL.money(totals.bundleDiscount) })}</div></div>` : ''}
        <div class="row"><span>${pt('subtotal')}</span><span>${VEL.money(totals.subtotal)}</span></div>
        <div class="row"><span>${pt('bundle_discount')}</span><span class="disc">${bundleActive ? '− ' + VEL.money(totals.bundleDiscount) : VEL.money(0)}</span></div>
        <div class="row"><span>${pt('delivery_fee')}</span><span class="mut">${totals.deliveryFee ? VEL.money(totals.deliveryFee) : (freeRemaining <= 0 ? pt('free') : VEL.money(totals.deliveryFee))}</span></div>
        ${sub < free ? `<div class="row"><span class="free">${pt('free_shipping', { n: freeRemaining.toLocaleString('en-US') })}</span></div>` : ''}
        <div class="row total"><span>${pt('total')}</span><span>${VEL.money(totals.total)}</span></div>
      </div>`;
  }

  function openCart() { $('#drawer-overlay').classList.add('open'); $('#cart-drawer').classList.add('open'); document.body.style.overflow = 'hidden'; }
  function closeCart() { $('#drawer-overlay').classList.remove('open'); $('#cart-drawer').classList.remove('open'); document.body.style.overflow = ''; }

  // ============================================================== CHECKOUT
  function checkoutHTML() {
    const totals = cartTotals();
    if (!totals.items.length) {
      return `<div class="container"><div class="empty"><div class="em-ic">🛒</div>${pt('empty_cart')}<div style="margin-top:16px"><a class="btn btn-gold" href="#/">${pt('continue_shopping')}</a></div></div></div>`;
    }
    const date = new Date().toISOString().slice(0, 10);
    return `${crumbs([pt('breadcrumb_home'), pt('cash')])}<div class="container">
      <div class="checkout-grid">
        <div class="form-card">
          <h2>${pt('order_summary')}</h2>
          <form id="checkout-form" novalidate>
            <div class="frow">
              <div class="field"><label>${pt('full_name')} <span class="req">*</span></label><input name="fullName" required maxlength="60"><div class="field-hint">${L()==='ar'?'الحد الأقصى 60 حرف':'Max 60 characters'}</div></div>
              <div class="field"><label>${pt('phone')} <span class="req">*</span></label><input name="phone" required inputmode="tel" maxlength="20" pattern="[\d\s+\-()]{6,20}"><div class="field-hint">${L()==='ar'?'الحد الأقصى 20 رقم':'Max 20 digits'}</div></div>
            </div>
            <div class="frow">
              <div class="field"><label>${pt('city')} <span class="req">*</span></label><input name="city" required maxlength="40"></div>
              <div class="field"><label>${pt('area')}</label><input name="area"></div>
            </div>
            <div class="field"><label>${pt('full_address')} <span class="req">*</span></label><textarea name="address" rows="3" required maxlength="200"></textarea><div class="field-hint">${L()==='ar'?'الحد أقصى 200 حرف':'Max 200 characters'}</div></div>
            <div class="field"><label>${pt('order_notes')}</label><textarea name="notes" rows="2" maxlength="300"></textarea><div class="field-hint">${L()==='ar'?'الحد أقصى 300 حرف':'Max 300 characters'}</div></div>
            <div style="display:flex;align-items:center;gap:10px;padding:16px;background:var(--ivory);border:1px solid var(--line);border-radius:8px;margin-top:8px">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#C8A15A"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/></svg>
              <div><b>${pt('cash')}</b><div style="font-size:12px;color:var(--muted)">${pt('cod_note')}</div></div>
            </div>
            <button class="btn btn-gold btn-block" type="submit" style="margin-top:20px">${pt('place_order')}</button>
          </form>
        </div>
        <div>
          <div class="form-card">
            <h2>${pt('your_cart')} (${cartCount()})</h2>
            ${totals.items.map(it => `<div class="drawer-item" style="padding:10px 0"><img src="${img(it.prod)}" alt=""><div class="di-info"><div class="di-name" style="font-size:12.5px">${VEL.esc(prodName(it.prod))}</div>${cartItemMeta(it, {style:'font-size:11px'})}</div><div class="di-side"><div style="font-size:11px;color:var(--muted)">× ${it.qty}</div><div class="di-price" style="font-size:13px">${VEL.money(it.prod.price * it.qty)}</div></div></div>`).join('')}
            ${totals.bundleDiscount ? `<div class="bundle-tag" style="margin-top:14px">${pt('bundle_applied')}</div>
            <div class="bundle-price-box"><div class="bp-label">${pt('bundle_price')}</div><div class="bp-val"><span class="old">${VEL.money(totals.bundleSubtotal)}</span><span class="bp-arrow">→</span><span class="bp-new">${VEL.money(totals.bundleSubtotal - totals.bundleDiscount)}</span></div></div>` : ''}
            <div class="summary">
              <div class="row"><span>${pt('subtotal')}</span><span>${VEL.money(totals.subtotal)}</span></div>
              <div class="row"><span>${pt('bundle_discount')}</span><span class="mut">${totals.bundleDiscount ? '− ' + VEL.money(totals.bundleDiscount) : VEL.money(0)}</span></div>
              <div class="row"><span>${pt('delivery_fee')}</span><span class="mut">${totals.deliveryFee ? VEL.money(totals.deliveryFee) : pt('free')}</span></div>
              <div class="row total"><span>${pt('total')}</span><span>${VEL.money(totals.total)}</span></div>
            </div>
            ${totals.bundleDiscount ? `<div class="free" style="color:#5b8a54;font-size:12px;font-weight:700">✓ ${pt('you_saved', { n: VEL.money(totals.bundleDiscount) })}</div>` : ''}
          </div>
        </div>
      </div>
    </div>`;
  }

  function submitOrder(payload) {
    return fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(r => r.json().then(j => ({ ok: r.ok, j })));
  }

  // ============================================================== HEADER / FOOTER / PROMO
  function headerHTML() {
    const lang = L();
    const navLinks = [
      [pt('key_cases'), '#/category/keycases'],
      [lang === 'ar' ? 'حاملات المفاتيح' : 'Key Holders', '#/category/keyholders'],
      [lang === 'ar' ? 'ميداليات السيارات' : 'Car Medals', '#/category/medals'],
      [lang === 'ar' ? 'الباقات' : 'Packages', '#/packages'],
    ];
    const topBrandSlugs = ['mercedes-benz','bmw','audi','toyota','hyundai','kia'];
    const topBrands = state.data.brands.filter(b => topBrandSlugs.includes(b.slug));
    return `<header class="header" id="header">
      <div class="container header-inner">
        <button class="mobile-toggle" id="menu-btn" aria-label="Menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg></button>
        <a class="logo" href="#/">
          <span class="mark">${VEL.logoMark(26, '#B8862E')}</span>
          <span class="word">SPINTO</span>
        </a>
        <nav class="nav">
          ${navLinks.map(l => `<a href="${l[1]}" data-nav="${l[0]}">${l[0]}</a>`).join('')}
          <a href="#/brands" data-nav="${pt('brands')}">${pt('brands')}</a>
        </nav>
        <div class="header-actions">
          <div style="position:relative">
            <button class="icon-btn" id="search-btn" aria-label="Search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/></svg></button>
            <div class="search-panel hidden" id="search-panel">
              <input id="search-input" placeholder="${VEL.esc(pt('search'))}...">
              <div class="results" id="search-results"></div>
            </div>
          </div>
          <button class="icon-btn" id="cart-btn" aria-label="${VEL.esc(pt('cart'))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h2l2 12h11l2-8H6"/><circle cx="9" cy="20" r="1"/><circle cx="17" cy="20" r="1"/></svg><span class="badge" id="cart-badge">${cartCount()}</span></button>
          <div class="lang-switch">
            <button data-lang="en" class="${L() === 'en' ? 'active' : ''}">EN</button>
            <button data-lang="ar" class="${L() === 'ar' ? 'active' : ''}">ع</button>
          </div>
        </div>
      </div>
      <div class="nav-mobile hidden" id="nav-mobile">
        <button class="close" id="mobile-close">×</button>
        <a href="#/">${pt('home')}</a>
        ${navLinks.map(l => `<a href="${l[1]}">${l[0]}</a>`).join('')}
        <a href="#/fitment">${pt('find_your_key')}</a>
        <a href="#/about">${pt('about_velocci')}</a>
        <div class="nav-brands-section">
          <span class="nav-brands-label">${lang === 'ar' ? 'تسوق حسب الماركة' : 'Shop by Brand'}</span>
          ${topBrands.map(b => `<a href="#/brand/${b.slug}" class="nav-brand-link">${VEL.esc(brandName(b))}</a>`).join('')}
          <a href="#/brands" class="nav-brand-link nav-brand-all">${lang === 'ar' ? 'كل الماركات →' : 'All Brands →'}</a>
        </div>
        <div class="langrow">
          <button class="btn btn-outline btn-sm" data-lang="en">English</button>
          <button class="btn btn-outline btn-sm" data-lang="ar">العربية</button>
        </div>
      </div>
    </header>`;
  }

  function footerHTML() {
    const s = state.data.settings;
    const lang = L();
    return `<footer class="footer">
      <div class="container">
        <div class="footer-grid">
          <div>
            <a class="logo" href="#/"><span class="mark">${VEL.logoMark(28, '#DCC58F')}</span><span class="word" style="color:#fff">SPINTO</span></a>
            <p>${VEL.esc(fld(s, 'footerAbout'))}</p>
            <div class="socials">
              <a href="https://instagram.com/${VEL.esc(s.instagram)}" target="_blank" rel="noopener" aria-label="Instagram"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17" cy="7" r="1"/></svg></a>
              <a href="https://facebook.com/${VEL.esc(s.facebook)}" target="_blank" rel="noopener" aria-label="Facebook"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"><path d="M15 3h-2a4 4 0 0 0-4 4v3H6v4h3v7h4v-7h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg></a>
              <a href="https://tiktok.com/@${VEL.esc(s.tiktok)}" target="_blank" rel="noopener" aria-label="TikTok"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"><path d="M16 4c.5 2 2 3.5 4 3.7v3c-1.5 0-3-.5-4-1.3v6a6 6 0 1 1-4-5.7"/></svg></a>
              <a href="https://wa.me/${VEL.esc(s.whatsapp.replace(/\D/g, ''))}" target="_blank" rel="noopener" aria-label="WhatsApp"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"><path d="M12 3a9 9 0 0 0-7.4 14L3 21l4.3-1.4A9 9 0 1 0 12 3Z"/></svg></a>
            </div>
          </div>
          <div>
            <h4>${lang === 'ar' ? 'روابط مهمة' : 'Quick Links'}</h4>
            <ul>
              <li><a href="#/about">${pt('about_velocci')}</a></li>
              <li><a href="#/keyguide">${pt('keyguide')}</a></li>
              <li><a href="#/shipping">${pt('shipping')}</a></li>
              <li><a href="#/warranty">${pt('warranty_page')}</a></li>
            </ul>
          </div>
        </div>
        <div class="footer-bottom">
          <span>${VEL.esc(fld(s, 'copyright'))}</span>
          <span>${VEL.esc(fld(s, 'deliveryNote'))}</span>
        </div>
      </div>
    </footer>`;
  }

  function promoHTML() {
    const p = state.data.promoBar;
    if (!p) return '';
    return `<div class="promo"><div class="container"><div class="inner">
      <strong>${VEL.esc(fld(p, 'text'))}</strong>
      <span class="sub">${VEL.esc(fld(p, 'sub'))}</span>
      <span class="count" id="countdown"><span class="cell" id="cd-d">--</span><span class="sep">:</span><span class="cell" id="cd-h">--</span><span class="sep">:</span><span class="cell" id="cd-m">--</span><span class="sep">:</span><span class="cell" id="cd-s">--</span></span>
    </div></div></div>`;
  }


  // ============================================================== PACKAGES PAGE
  function packagesHTML() {
    const lang = L();
    const bundles = (state.data.bundles || []).filter(b => b.active);
    return `${crumbs([pt('breadcrumb_home'), lang === 'ar' ? 'الباقات والمجموعات' : 'Packages & Sets'])}
    <div class="container">
      <div class="section">
        <div class="section-head"><div><span class="kicker">${lang === 'ar' ? 'وفّر أكثر' : 'Save More'}</span><h2>${lang === 'ar' ? 'الباقات والمجموعات' : 'Packages & Sets'}</h2></div></div>
        <p class="packages-intro">${lang === 'ar' ? 'احصل على مجموعة كاملة من أغطية المفاتيح والحاملات والميداليات لسيارتك المفضلة بسعر مخفض.' : 'Get a complete set of key covers, holders, and medals for your favorite car brand at a bundled price.'}</p>
        ${bundles.length ? `<div class="packages-grid">${bundles.map(b => {
          const br = brand(b.brandSlug);
          const items = brandSetItems(b.brandSlug);
          const trio = [items.keyCase, items.medal, items.keyHolder].filter(Boolean);
          const save = Math.max(0, b.normalTotal - b.bundlePrice);
          return `<div class="package-card">
            <div class="pc-brand">${br ? VEL.brandLogoImg(br.slug, { h: 36 }) : ''}</div>
            <h3 class="pc-title">${VEL.esc(fld(b, 'title'))}</h3>
            <p class="pc-sub">${VEL.esc(fld(b, 'sub'))}</p>
            <div class="pc-items">
              ${trio.map(it => `<div class="pc-item"><img src="${img(it)}" alt=""><span>${VEL.esc(catLabel(it.category))}</span></div>`).join('')}
            </div>
            <div class="pc-pricing">
              <span class="pc-regular">${VEL.money(b.normalTotal)}</span>
              <span class="pc-bundle">${VEL.money(b.bundlePrice)}</span>
              <span class="pc-save">${lang === 'ar' ? 'توفير' : 'Save'} ${VEL.money(save)}</span>
            </div>
            <a class="btn btn-gold btn-block" href="#/brand/${b.brandSlug}">${lang === 'ar' ? 'تسوق المجموعة' : 'Shop This Set'}</a>
          </div>`;
        }).join('')}</div>` : ''}
        <div class="packages-all">
          <h3>${lang === 'ar' ? 'أو تسوق حسب فئة المنتج' : 'Or Shop by Product Category'}</h3>
          <div class="packages-cats">
            <a class="btn btn-outline" href="#/category/keycases">${pt('key_cases')}</a>
            <a class="btn btn-outline" href="#/category/keyholders">${lang === 'ar' ? 'حاملات المفاتيح' : 'Key Holders'}</a>
            <a class="btn btn-outline" href="#/category/medals">${lang === 'ar' ? 'ميداليات السيارات' : 'Car Medals'}</a>
            <a class="btn btn-gold" href="#/fitment">${pt('find_your_key')} →</a>
          </div>
        </div>
      </div>
    </div>`;
  }

  // ============================================================== ROUTER
  let lastProductSlug = null;

  // COLLECTIONS OVERVIEW PAGE — shows all categories
  function collectionsHTML() {
    const lang = L();
    const cats = [
      { key: 'keycase', name: lang === 'ar' ? 'جرابات المفاتيح' : 'Key Cases', desc: lang === 'ar' ? 'جرابات مفاتيح فاخرة من ألياف الكربون والجلد' : 'Premium key covers in carbon fibre and leather', icon: '🔑' },
      { key: 'keyholder', name: lang === 'ar' ? 'حاملات المفاتيح' : 'Key Holders', desc: lang === 'ar' ? 'حاملات مفاتيح معدنية فاخرة بتفاصيل ثلاثية الأبعاد' : 'Illuminated 3D metal key holders', icon: '💡' },
      { key: 'medal', name: lang === 'ar' ? 'ميداليات السيارات' : 'Car Medals', desc: lang === 'ar' ? 'ميداليات فاخرة للمقتنين' : 'Collector-grade car medals', icon: '🏅' },
    ];
    return `${crumbs([pt('breadcrumb_home'), lang === 'ar' ? 'المجموعات' : 'Collections'])}
      <div class="container">
        <div class="collections-page">
          <div class="collections-head">
            <h1 class="collections-title">${lang === 'ar' ? 'المجموعات' : 'Collections'}</h1>
            <p class="collections-sub">${lang === 'ar' ? 'اختر مجموعة لاستكشاف منتجاتنا الفاخرة' : 'Choose a collection to explore our premium products'}</p>
          </div>
          <div class="collections-grid">
            ${cats.map(c => {
              const count = state.data.products.filter(p => p.category === c.key && p.active).length;
              return `<a class="collection-card" href="#/category/${c.key}">
                <div class="collection-icon">${c.icon}</div>
                <div class="collection-info">
                  <h2 class="collection-name">${c.name}</h2>
                  <p class="collection-desc">${c.desc}</p>
                  <span class="collection-count">${count} ${lang === 'ar' ? 'منتج' : 'products'}</span>
                </div>
                <span class="collection-arrow">→</span>
              </a>`;
            }).join('')}
          </div>
        </div>
      </div>`;
  }

  function route() {
    const hash = (location.hash || '#/').slice(1) || '/';
    const parts = hash.split('?')[0].split('/').filter(Boolean);
    const query = {};
    (location.hash.split('?')[1] || '').split('&').forEach(kv => { const [k, v] = kv.split('='); if (k) query[k] = decodeURIComponent(v || ''); });

    let html = '';
    const first = parts[0] || '';
    if (first === '' ) html = homeHTML();
    else if (first === 'product') {
      if (parts[1] !== lastProductSlug) { state.productShape = {}; state.productQty = 1; state.productOption = 0; }
      lastProductSlug = parts[1];
      html = pdpHTML(parts[1]);
    }
    else if (first === 'collections') html = collectionsHTML();
    else if (first === 'category') html = categoryHTML(parts[1]);
    else if (first === 'brand' && parts[1]) html = brandHTML(parts[1]);
    else if (first === 'brands') html = brandsHTML();
    else if (first === 'fitment') html = fitmentHTML();
    else if (first === 'packages') html = packagesHTML();
    else if (first === 'checkout') html = checkoutHTML();
    else if (first === 'success') html = successHTML(parts[1] || query.id);
    else if (first === 'keyguide') html = staticHTML('keyguide');
    else if (first === 'shipping') html = staticHTML('shipping');
    else if (first === 'warranty') html = staticHTML('warranty');
    else if (first === 'about') html = staticHTML('about');
    else if (first === 'workshop') html = staticHTML('workshop');
    else if (first === 'account') html = accountHTML();
    else html = notFound();

    main().innerHTML = html;
    window.scrollTo(0, 0);
    bindPage();
  }

  function fmtDate(iso) { try { return new Date(iso).toLocaleDateString(L() === 'ar' ? 'ar-EG' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' }); } catch (e) { return iso || ''; } }

  function successHTML(id) {
    const o = state.lastOrder && state.lastOrder.id === id ? state.lastOrder : null;
    if (!o) {
      return `<div class="container"><div class="success">
        <div class="check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg></div>
        <h1>${pt('order_confirmed')}</h1>
        <p>${pt('your_order_is')}</p>
        <p style="color:var(--muted)">${pt('order_id')}: <b style="color:var(--gold-deep)">${VESt(id)}</b></p>
        <div style="margin-top:20px"><a class="btn btn-gold" href="#/">${pt('back_home')}</a></div>
      </div></div>`;
    }
    const itemsHTML = o.items.map(it => {
      const v = vehicleLabel(it.fitment);
      const nm = L() === 'ar' ? (it.name_ar || it.name_en) : (it.name_en || it.name_ar);
      const shape = it.keyShape ? VESt(pt('shape') + ' ' + it.keyShape) : '';
      return `<div class="s-item"><img src="${it.image}" alt=""><div class="s-info"><div class="s-name">${VESt(nm)}</div>${v ? `<div class="s-vehicle">${VESt(v)}${shape ? ' · ' + shape : ''}</div>` : (shape ? `<div class="s-vehicle">${shape}</div>` : '')}<div class="s-qty">${pt('quantity')}: ${it.qty}</div></div><div class="s-price">${VEL.money(it.lineTotal)}</div></div>`;
    }).join('');
    return `<div class="container"><div class="success">
      <div class="check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg></div>
      <h1>${pt('order_confirmed')}</h1>
      <p>${pt('your_order_is')}</p>

      <div class="success-card">
        <div class="sc-row"><span>${pt('order_id')}</span><b class="gold">${VESt(o.id)}</b></div>
        <div class="sc-row"><span>${pt('order_date')}</span><span>${VESt(fmtDate(o.createdAt))}</span></div>
        <div class="sc-row"><span>${pt('payment_method')}</span><b class="cod"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/></svg> ${pt('cash_on_delivery')}</b></div>
        <div class="sc-note">${pt('cod_note')}</div>
      </div>

      ${o.bundleDiscount ? `<div class="bundle-tag" style="display:flex;gap:8px;justify-content:center;margin:22px 0 6px">${pt('bundle_applied')}</div>
      <div class="bundle-price-box" style="border:1px dashed var(--gold);border-radius:10px;background:var(--ivory);padding:16px 20px"><div class="bp-label">${pt('bundle_price')}</div><div class="bp-val"><span class="old">${VEL.money(o.subtotal)}</span><span class="bp-arrow">→</span><span class="bp-new">${VEL.money(o.subtotal - o.bundleDiscount)}</span></div></div>
      <div class="drawer-savebox" style="margin:12px 0 0"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20 12 12 20 4 12 12 4z"/><path d="M9 12h6"/></svg><div class="txt">${pt('you_saved', { n: VEL.money(o.bundleDiscount) })}</div></div>` : ''}

      <div class="success-card">
        <h3>${pt('order_items')}</h3>
        ${itemsHTML}
        <div class="s-totals">
          <div class="row"><span>${pt('subtotal')}</span><span>${VEL.money(o.subtotal)}</span></div>
          ${o.bundleDiscount ? `<div class="row"><span>${pt('bundle_discount')}</span><span class="disc">− ${VEL.money(o.bundleDiscount)}</span></div>` : ''}
          <div class="row"><span>${pt('delivery_fee')}</span><span>${o.deliveryFee ? VEL.money(o.deliveryFee) : pt('free')}</span></div>
          <div class="row total"><span>${pt('total')}</span><span>${VEL.money(o.total)}</span></div>
        </div>
      </div>

      <div class="success-card">
        <h3>${pt('customer_details')}</h3>
        <div class="sc-cust"><b>${VESt(o.customer.fullName)}</b> · ${VESt(o.customer.phone)}</div>
        <div class="sc-cust">${VESt(o.customer.city)}${o.customer.area ? ', ' + VESt(o.customer.area) : ''} · ${VESt(o.customer.address)}${o.customer.notes ? '<br>' + VESt(o.customer.notes) : ''}</div>
      </div>

      <div style="margin-top:20px"><a class="btn btn-gold" href="#/">${pt('back_home')}</a> <a class="btn btn-line" href="#/category/keycases">${pt('continue_shopping')}</a></div>
    </div></div>`;
  }
  const VESt = (s) => VEL.esc(s || '');

  function accountHTML() {
    return `<div class="container"><div class="section" style="padding-top:40px"><div class="container" style="padding:0;max-width:640px">
      <div class="form-card">
        <h2>${pt('account')}</h2>
        <p style="color:var(--muted);font-size:13px">${pt('cod_note')}</p>
        <p style="color:var(--muted);font-size:13px">You can also pre-order reserved items or contact us on WhatsApp.</p>
        <a class="btn btn-gold" href="#/checkout">${pt('proceed_to_checkout')}</a>
      </div>
    </div></div></div>`;
  }

  // ============================================================== BINDINGS
  function bindPage() {
    // reveal (progressive fade-in that never leaves content hidden)
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((es) => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.06 });
      $$('.reveal', main()).forEach(el => io.observe(el));
      // safety net: any element still hidden after a moment reveals itself
      setTimeout(() => { $$('.reveal', main()).forEach(el => el.classList.add('in')); }, 900);
    } else {
      $$('.reveal', main()).forEach(el => el.classList.add('in'));
    }

    // gift packaging toggle
    const giftToggle = $('#gift-packaging');
    if (giftToggle) {
      giftToggle.addEventListener('change', () => {
        const details = $('#gift-details');
        if (details) details.style.display = giftToggle.checked ? 'block' : 'none';
      });
    }

    // gallery thumbs
    $$('[data-thumb]').forEach(t => t.addEventListener('click', () => {
      const i = t.getAttribute('data-thumb');
      $$('[data-thumb]').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const main = $('#gallery-main'); if (main) main.src = state.route.params.srcs ? '' : product(currentSlug()).images[i];
    }));

    // shape select
    $$('[data-shape]').forEach(b => b.addEventListener('click', () => {
      const slug = currentSlug(); const p = productBySlug(slug);
      if (!p) return;
      state.productShape[p.id] = b.getAttribute('data-shape');
      // re-render pdp to update price/inv/button
      route();
    }));

    // qty
    $('#qty-inc') && $('#qty-inc').addEventListener('click', () => { state.productQty = Math.min(99, state.productQty + 1); $('#qty').value = state.productQty; });
    $('#qty-dec') && $('#qty-dec').addEventListener('click', () => { state.productQty = Math.max(1, state.productQty - 1); $('#qty').value = state.productQty; });

    // add to cart (product page)
    $('#addbtn') && $('#addbtn').addEventListener('click', () => {
      const p = productBySlug(currentSlug()); if (!p) return;
      const shape = state.productShape[p.id];
      if (!shape) { notify(pt('select_key_shape')); return; }
      addToCart(p.id, shape, state.productQty);
    });

    // preorder
    $('#preorder-btn') && $('#preorder-btn').addEventListener('click', () => {
      const p = productBySlug(currentSlug()); if (!p) return;
      openPreorderModal(p);
    });

    // add set
    $('#addset') && $('#addset').addEventListener('click', () => {
      const base = product($('#addset').getAttribute('data-base')); if (!base) return;
      const set = brandSetItems(base.brandSlug);
      const combo = [
        { label: pt('three_piece'), all: true },
        { label: pt('key_case_only'), only: 'keycase' },
        { label: pt('key_case_medal'), cats: ['keycase', 'medal'] },
        { label: pt('key_case_holder'), cats: ['keycase', 'keyholder'] }
      ][state.productOption];
      const items = itemCombo(base, combo);
      let added = false;
      items.forEach(it => {
        if (!it) return;
        const shape = (it.keyShapes || []).find(s => s.available);
        if (cartHasProduct(it.id)) return;
        addToCart(it.id, shape ? shape.shape : '', 1, { openCart: false });
        added = true;
      });
      if (!added) { notify(pt('empty_cart')); return; }
      saveCart(); openCart();
    });

    // option choices on pdp
    $$('[data-option]').forEach(b => b.addEventListener('click', () => {
      state.productOption = parseInt(b.getAttribute('data-option'));
      $$('[data-option]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const lbl = $('#addset-label');
      if (lbl) lbl.textContent = state.productOption === 0 ? pt('add_3_piece_set') : pt('add_to_cart');
    }));

    // tabs
    const tabContent = {
      desc: (p) => `<p>${VEL.esc(fld(p, 'description'))}</p>`,
      material: (p) => `<p><b>${pt('material')}:</b> ${VEL.esc(fld(p, 'material'))}</p><ul><li>${VEL.esc(fld(p, 'material'))}</li><li>${pt('premium_quality')}</li></ul>`,
      compat: (p) => {
        if (p.vehicles && p.vehicles.length) {
          const byBr = {};
          p.vehicles.forEach(v => { const br = brand(v.brand); if (!br) return; const gp = byBr[v.brand] || (byBr[v.brand] = { br, m: {} }); const mm = gp.m[v.model] || (gp.m[v.model] = new Set()); if (v.year != null) mm.add(v.year); });
          return Object.values(byBr).map(g => `<p><b>${VEL.esc(brandName(g.br))}</b><ul style="margin:6px 0 0 18px">${Object.keys(g.m).map(mEn => { const rec = (g.br.models || []).find(x => x.en === mEn); const nm = rec ? modelName(rec) : mEn; return `<li>${VEL.esc(nm)} — ${[...g.m[mEn]].sort((a,b)=>a-b).join(' · ')}</li>`; }).join('')}</ul></p>`).join('');
        }
        return `<p>${VEL.esc(brandName(brandOfAsset(p)))} ${(p.models || []).join(', ')} · ${(p.years || []).join(' / ')}</p>`;
      },
      ship: (p) => `<p>${VEL.esc(fld(state.data.settings, 'deliveryNote'))}</p><p>${VEL.esc(fld(state.data.settings.returnPolicy, 'note'))}</p><p>${VEL.esc(fld(state.data.settings, 'warranty'))}</p>`
    };
    $$('.tab').forEach(tb => tb.addEventListener('click', () => {
      $$('.tab').forEach(x => x.classList.remove('active'));
      tb.classList.add('active');
      const p = productBySlug(currentSlug());
      $('#tab-body').innerHTML = tabContent[tb.getAttribute('data-tab')](p);
    }));

    // brand strip horizontal scroll — single row, swipe + arrow buttons
    const strip = $('#brand-strip');
    if (strip) {
      const step = () => 240;
      $('#brand-next') && $('#brand-next').addEventListener('click', () => strip.scrollBy({ left: step(), behavior: 'smooth' }));
      $('#brand-prev') && $('#brand-prev').addEventListener('click', () => strip.scrollBy({ left: -step(), behavior: 'smooth' }));
      // mouse drag-to-scroll (touch uses native overflow scrolling)
      let down = false, startX = 0, startLeft = 0;
      strip.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') { down = true; startX = e.clientX; startLeft = strip.scrollLeft; } });
      window.addEventListener('pointermove', (e) => { if (down) { strip.scrollLeft = startLeft - (e.clientX - startX); } });
      window.addEventListener('pointerup', () => { down = false; });
      // hide prev arrow at the left edge
      const sync = () => {
        const canPrev = strip.scrollLeft > 10;
        const canNext = strip.scrollLeft < (strip.scrollWidth - strip.clientWidth - 10);
        $('#brand-prev') && $('#brand-prev').classList.toggle('is-hidden', !canPrev);
        $('#brand-next') && $('#brand-next').classList.toggle('is-hidden', !canNext);
      };
      strip.addEventListener('scroll', sync, { passive: true });
      sync();
    }

    // Category page filter — brand pills, model dropdown, year dropdown
    function rebuildCatUrl() {
      const base = location.hash.split('?')[0];
      const params = new URLSearchParams();
      const ab = document.querySelector('.cf-brand-pill.active');
      const brand = ab ? ab.getAttribute('data-cfbrand') : '';
      const modelEl = $('#cf-model');
      const yearEl = $('#cf-year');
      if (brand) params.set('brand', brand);
      if (modelEl && modelEl.value) params.set('model', modelEl.value);
      if (yearEl && yearEl.value) params.set('year', yearEl.value);
      const qs = params.toString();
      location.hash = base + (qs ? '?' + qs : '');
    }
    $$('.cf-brand-pill').forEach(pill => pill.addEventListener('click', () => {
      $$('.cf-brand-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      // When brand changes, reset model and year
      const modelEl = $('#cf-model');
      const yearEl = $('#cf-year');
      if (modelEl) { modelEl.value = ''; }
      if (yearEl) { yearEl.value = ''; }
      rebuildCatUrl();
    }));
    const cfModel = $('#cf-model');
    if (cfModel) cfModel.addEventListener('change', () => {
      const yearEl = $('#cf-year');
      if (yearEl) yearEl.value = '';
      rebuildCatUrl();
    });
    const cfYear = $('#cf-year');
    if (cfYear) cfYear.addEventListener('change', rebuildCatUrl);
    const cfClear = $('#cf-clear') || $('#cf-clear-empty');
    if (cfClear) cfClear.addEventListener('click', () => {
      location.hash = location.hash.split('?')[0];
    });

    // fitment wizard
    bindFitment();

    // wishlist
    $$('[data-wish]', main()).forEach(b => b.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      b.classList.toggle('active');
      notify(b.classList.contains('active') ? '♥ ' + pt('add_to_cart') : '✓');
    }));

    // cart drawer actions — delegated on the drawer so dynamically-rendered
    // items (qty, remove, cross-sell "add to set") always respond.
    $$('[data-add]', main()).forEach(b => b.addEventListener('click', (e) => { e.preventDefault(); const p = product(b.getAttribute('data-add')); if (p) openProductQuickAdd(p); }));
    const drawer = $('#cart-drawer');
    if (drawer && !drawer.dataset.dlgBound) {
      drawer.dataset.dlgBound = '1';
      drawer.addEventListener('click', (e) => {
        const q = e.target.closest('[data-qtyd]');
        if (q) { const [pid, sh] = q.getAttribute('data-qtyd').split('|'); const item = state.cart.find(i => i.productId === pid && i.keyShape === sh); if (item) setQty(pid, sh, item.qty + parseInt(q.getAttribute('data-qtyv') || '1')); return; }
        const rm = e.target.closest('[data-remove]');
        if (rm) { const [pid, sh] = rm.getAttribute('data-remove').split('|'); removeCartItem(pid, sh); notify(L() === 'ar' ? 'تمت الإزالة' : 'Item removed'); return; }
        const ab = e.target.closest('[data-addbundle]');
        if (ab) { const p = product(ab.getAttribute('data-addbundle')); if (!p) return; const shape = (p.keyShapes||[]).find(s=>s.available); addToCart(p.id, shape?shape.shape:'', 1); return; }
      });
    }

    // checkout form
    const form = $('#checkout-form');
    if (form) form.addEventListener('submit', submitCheckout);

    // clear fitment
    $('#clear-fitment') && $('#clear-fitment').addEventListener('click', () => { state.fitment = null; localStorage.removeItem(FIT_KEY); route(); });
  }

  function currentSlug() { const parts = (location.hash||'').slice(1).split('?')[0].split('/').filter(Boolean); return parts[1] || ''; }
  function productBySlug(slug) { return state.data.products.find(p => p.slug === slug); }

  // deepest step already completed — used to clamp forward navigation
  function fitDeep() {
    const f = state.fitment || {};
    let d = 1;
    if (f.brand) d = 2;
    if (f.brand && f.model) d = 3;
    if (f.brand && f.model && f.year) d = 4;
    return d;
  }

  function saveFit() {
    if (state.fitment && state.fitment.brand) localStorage.setItem(FIT_KEY, JSON.stringify(state.fitment));
    else localStorage.removeItem(FIT_KEY);
  }

  function bindFitment() {
    const m = main();

    // step selector: clicking a completed / reachable step jumps to it (back nav)
    $$('[data-fitstep]', m).forEach(b => b.addEventListener('click', () => {
      const want = Number(b.getAttribute('data-fitstep'));
      const deep = fitDeep();          // how far the user may already have gone
      const allowed = Math.min(want, Math.max(deep, 1));
      state.fitStep = allowed;
      // clear any fields belonging to steps beyond `allowed`
      const f = Object.assign({}, state.fitment || {});
      if (allowed <= 1) { f.brand = null; f.model = null; f.year = null; f.shape = null; }
      if (allowed <= 2) { f.model = null; f.year = null; f.shape = null; }
      if (allowed <= 3) { f.year = null; f.shape = null; }
      if (allowed <= 4 && want <= 3) { f.shape = null; }
      if (want >= allowed) { } // no-op
      state.fitment = (f.brand || f.model || f.year || f.shape) ? f : null;
      saveFit();
      route();
    }));

    // 1) brand
    $$('[data-fitbrand]', m).forEach(b => b.addEventListener('click', () => {
      state.fitment = Object.assign({}, state.fitment || {}, { brand: b.getAttribute('data-fitbrand'), model: null, year: null, shape: null });
      state.fitStep = 2; saveFit(); route();
    }));
    // 2) model
    $$('[data-fitmodel]', m).forEach(b => b.addEventListener('click', () => {
      state.fitment = Object.assign({}, state.fitment || {}, { model: b.getAttribute('data-fitmodel'), year: null, shape: null });
      state.fitStep = 3; saveFit(); route();
    }));
    // 3) year
    $$('[data-fityear]', m).forEach(b => b.addEventListener('click', () => {
      state.fitment = Object.assign({}, state.fitment || {}, { year: Number(b.getAttribute('data-fityear')), shape: null });
      state.fitStep = 4; saveFit(); route();
    }));
    // 4) shape (only selectable/unavailable-safe — unavailable ones are disabled)
    $$('[data-fit-shape]', m).forEach(b => b.addEventListener('click', () => {
      const shape = b.getAttribute('data-fit-shape');
      state.fitment = Object.assign({}, state.fitment || {}, { shape });
      state.fitStep = 4; saveFit(); route();
    }));

    // change vehicle → return to brand step
    $('#fit-change') && $('#fit-change').addEventListener('click', () => {
      state.fitment = null; state.fitStep = 1; localStorage.removeItem(FIT_KEY); route();
    });
    // clear
    $('#clear-fitment') && $('#clear-fitment').addEventListener('click', () => {
      state.fitment = null; state.fitStep = 1; localStorage.removeItem(FIT_KEY); route();
    });

    // add-to-cart from fitment results — shape already known
    $$('[data-addfit]', m).forEach(b => b.addEventListener('click', (e) => {
      e.preventDefault();
      const p = product(b.getAttribute('data-addfit'));
      const f = state.fitment || {};
      const shape = p ? (p.keyShapes || []).find(s => s.shape === f.shape && s.available) : null;
      if (!p) return;
      if (shape) { addToCart(p.id, shape.shape, 1); }
      else openProductQuickAdd(p);
    }));
  }

  function openProductQuickAdd(p) {
    // open a quick modal to choose a shape (if required) then add
    const avail = (p.keyShapes || []).filter(s => s.available);
    if (!avail.length) { notify(pt('out_of_stock')); return; }
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `<div class="modal">
      <h3 style="margin:0 0 6px">${VEL.esc(prodName(p))}</h3>
      <div style="color:var(--muted);font-size:13px;margin-bottom:16px">${VEL.money(p.price)}</div>
      <div class="label" style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px">${pt('select_key_shape')}</div>
      <div class="shape-options">${avail.map(sh => `<button class="shape-opt selectable" data-qa="${sh.shape}" style="width:88px">${VEL.keyShapeSVG(sh.shape, { color: '#2b2b2b', w: 52, h: 80 })}<div class="lbl">${pt('shape')} ${sh.shape}</div></button>`).join('')}</div>
      <button class="btn btn-gold btn-block" style="margin-top:18px" id="qa-add" disabled>${pt('add_to_cart')}</button>
    </div>`;
    document.body.appendChild(modal);
    let chosen = '';
    modal.querySelectorAll('[data-qa]').forEach(b => b.addEventListener('click', () => {
      modal.querySelectorAll('[data-qa]').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected'); chosen = b.getAttribute('data-qa');
      modal.querySelector('#qa-add').disabled = false;
    }));
    modal.querySelector('#qa-add').addEventListener('click', () => { if (chosen) addToCart(p.id, chosen, 1); modal.remove(); });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  }

  function openPreorderModal(p) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `<div class="modal">
      <h3 style="margin:0 0 6px">${pt('reserve')}</h3>
      <p style="color:var(--muted);font-size:13px;margin:0 0 16px">${VEL.esc(prodName(p))} — ${pt('preorder_note')}</p>
      <form id="preorder-form">
        <div class="field"><label>${pt('full_name')} *</label><input name="fullName" required maxlength="60"></div>
        <div class="field"><label>${pt('phone')} *</label><input name="phone" required maxlength="20"></div>
        <div class="field"><label>${pt('city')}</label><input name="city" maxlength="40"></div>
        <div class="field"><label>${pt('full_address')}</label><textarea name="address" rows="2" maxlength="200"></textarea></div>
        <button class="btn btn-gold btn-block" type="submit">${pt('place_order')}</button>
      </form>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#preorder-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      fetch('/api/preorders', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ productId: p.id, keyShape: state.productShape[p.id]||'', customer: { fullName: f.get('fullName'), phone: f.get('phone'), city: f.get('city'), address: f.get('address') } }) })
        .then(r => r.json()).then(res => { modal.remove(); notify(pt('order_confirmed'), 'gold'); });
    });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  }

  function submitCheckout(e) {
    e.preventDefault();
    const form = e.target;
    const f = new FormData(form);
    const customer = { fullName: f.get('fullName'), phone: f.get('phone'), city: f.get('city'), area: f.get('area'), address: f.get('address'), notes: f.get('notes') };
    const cart = state.cart.map(i => ({ productId: i.productId, keyShape: i.keyShape, qty: i.qty, fitment: i.fitment || null }));
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = '…';
    submitOrder({ customer, cart }).then(({ ok, j }) => {
      if (ok) {
        const totals = cartTotals();
        state.lastOrder = {
          id: j.orderId, createdAt: new Date().toISOString(), customer,
          items: totals.items.map(it => ({ productId: it.productId, keyShape: it.keyShape, qty: it.qty, fitment: it.fitment || null, name_en: it.prod.name_en, name_ar: it.prod.name_ar, price: it.prod.price, lineTotal: it.prod.price * it.qty, image: img(it.prod), brandSlug: it.prod.brandSlug, category: it.prod.category })),
          subtotal: totals.subtotal, bundleDiscount: totals.bundleDiscount, deliveryFee: totals.deliveryFee, total: totals.total,
        };
        state.cart = []; saveCart(); location.hash = '#/success/' + j.orderId;
      }
      else { alert(j.error || 'Something went wrong'); btn.disabled = false; btn.textContent = pt('place_order'); }
    }).catch(() => { btn.disabled = false; });
  }

  // ============================================================== GLOBAL BINDINGS
  function bindGlobal() {
    // header scroll
    window.addEventListener('scroll', () => { $('#header') && $('#header').classList.toggle('scrolled', window.scrollY > 10); });

    // language
    $$('[data-lang]').forEach(b => b.addEventListener('click', () => { setLang(b.getAttribute('data-lang')); renderSite(); }));

    // cart
    $('#cart-btn').addEventListener('click', openCart);
    $('#drawer-close').addEventListener('click', closeCart);
    $('#drawer-overlay').addEventListener('click', closeCart);
    $('#cart-proceed').addEventListener('click', () => { if (cartCount()) { closeCart(); location.hash = '#/checkout'; } });

    // search
    $('#search-btn').addEventListener('click', () => $('#search-panel').classList.toggle('hidden'));
    $('#search-input').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      const res = $('#search-results');
      if (!q) { res.innerHTML = ''; return; }
      const matches = state.data.products.filter(p => (p.name_en + ' ' + p.name_ar + ' ' + (p.category||'')).toLowerCase().includes(q)).slice(0, 7);
      res.innerHTML = matches.map(p => `<a class="result" href="#/product/${p.slug}"><img src="${img(p)}"><div><div style="font-size:13px;font-weight:600">${VEL.esc(prodName(p))}</div><div style="font-size:12px;color:var(--gold-deep)">${VEL.money(p.price)}</div></div></a>`).join('') || `<div style="color:var(--muted);padding:8px">${pt('no_results')}</div>`;
    });

    // mobile menu
    $('#menu-btn').addEventListener('click', () => { $('#nav-mobile').classList.remove('hidden'); $('#nav-mobile').classList.add('open'); });
    $('#mobile-close').addEventListener('click', () => { $('#nav-mobile').classList.add('hidden'); $('#nav-mobile').classList.remove('open'); });
    $$('#nav-mobile a').forEach(a => a.addEventListener('click', () => { $('#nav-mobile').classList.add('hidden'); $('#nav-mobile').classList.remove('open'); }));

    // routing (global listeners bound once in renderSite)
    window.addEventListener('hashchange', () => { route(); });
  }

  function renderCartBadge() { const b = $('#cart-badge'); if (b) b.textContent = cartCount(); }

  function notify(msg, kind) {
    const wrap = $('#toast-wrap');
    const t = document.createElement('div');
    t.className = 'toast ' + (kind === 'gold' ? 'gold' : '');
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => t.remove(), 2400);
  }

  function startCountdown() {
    const p = state.data.promoBar;
    if (!p) return;
    let end = new Date(p.endTime).getTime();
    const upd = () => {
      const n = Math.max(0, end - Date.now());
      const d = Math.floor(n / 86400000), h = Math.floor(n / 3600000) % 24, m = Math.floor(n / 60000) % 60, s = Math.floor(n / 1000) % 60;
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v).padStart(2, '0'); };
      set('cd-d', d); set('cd-h', h); set('cd-m', m); set('cd-s', s);
    };
    upd(); setInterval(upd, 1000);
  }

  function renderSite() {
    app().innerHTML = headerHTML() + promoHTML() + `<main id="main"></main>` + footerHTML() + `
      <div class="drawer-overlay" id="drawer-overlay"></div>
      <aside class="drawer" id="cart-drawer">
        <div class="drawer-head"><h3>${pt('your_cart')} <span style="color:var(--gold-deep)" id="drawer-head-count">(${cartCount()})</span></h3><button class="drawer-close" id="drawer-close">×</button></div>
        <div class="drawer-body" id="drawer-body"></div>
        <div id="cart-summary"></div>
        <div class="drawer-foot">
          <button class="btn btn-gold btn-block" id="cart-proceed">${pt('proceed_to_checkout')}</button>
          <div class="cashnote"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/></svg> ${pt('cash')} — ${pt('cod_note')}</div>
        </div>
      </aside>
      <div class="toast-wrap" id="toast-wrap"></div>`;
    // render current route into #main which is inside the shell
    route();
    renderCartBadge();
    renderCartDrawer();
    startCountdown();
    bindGlobal();
  }

  function init() {
    setLang(localStorage.getItem(LANG_KEY) || 'en');
    loadCart();
    const savedFit = localStorage.getItem(FIT_KEY); if (savedFit) { try { state.fitment = JSON.parse(savedFit); } catch (e) {} }
    state.fitStep = fitDeep();
    $('#app').innerHTML = `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;color:var(--muted)">SPINTO …</div>`;
    fetch('/api/data').then(r => r.json()).then(data => {
      state.data = data;
      renderSite();
    }).catch(err => { $('#app').innerHTML = '<div style="padding:40px;text-align:center">Failed to load. Please restart the server.</div>'; console.error(err); });
  }

  // hash query helpers
  window.addEventListener('DOMContentLoaded', init);
})();
