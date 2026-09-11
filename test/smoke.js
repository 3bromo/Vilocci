// Headless smoke test for the VELOCCI storefront using jsdom.
// Loads the real scripts + real /api/data, exercises home, product page,
// shape selection, add-to-cart, cart drawer, language switch, fitment and checkout.
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const API = (global.API || 'http://localhost:3000');

// Fetch the real data and asset SVG
async function getJSON(url) {
  const r = await fetch(url);
  return r.json();
}

function read(url) {
  if (url.startsWith('/api/data')) {
    return getJSON(API + '/api/data').then(d => ({ status: 200, json: () => Promise.resolve(d) }));
  }
  return null;
}

(async function main() {
  const data = await getJSON(API + '/api/data');

  // ---- set up jsdom env with mocks ----
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: API + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    resources: undefined,
    beforeParse(window) {
      window.fetch = (u, o) => {
        const url = typeof u === 'string' ? u : u.url;
        if (url.indexOf('/api/data') >= 0) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
        }
        if (url.indexOf('/api/orders') >= 0) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, orderId: 'ORD-TEST', total: 1234 }) });
        }
        if (url.indexOf('/api/preorders') >= 0) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, preorderId: 'PRE-TEST' }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      };
      window.IntersectionObserver = class { observe(){} unobserve(){} disconnect(){} };
      window.alert = () => {};
      window.confirm = () => true;
    }
  });

  const { window } = dom;
  const { document } = window;

  // inject scripts (engine + app) manually after defining globals
  window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'engine.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8'));

  // wait for app init (fetch is resolved async -> renderSite)
  await new Promise(r => setTimeout(r, 120));

  function text(sel) { const e = document.querySelector(sel); return e ? e.textContent.trim() : ''; }
  function click(el) { if (el) { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); } }
  function setHash(h) { window.location.hash = h; window.dispatchEvent(new window.HashChangeEvent('hashchange')); }

  let pass = 0, fail = 0;
  function check(name, cond) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } }

  console.log('\n== HOME ==');
  check('app rendered header logo', text('.logo .word') === 'VELOCCI');
  check('hero headline present', /LUXURY|KEY/i.test(text('.hero-copy h1')));
  check('promo bar visible', !!document.querySelector('.promo'));
  check('countdown cells present', document.querySelectorAll('.count .cell').length === 4);
  check('category nav cards present', document.querySelectorAll('.catnav-card').length >= 3);
  check('find your key section present', !!document.querySelector('.section-findkey'));
  check('product cards on home >= 4', document.querySelectorAll('.product-card').length >= 4);

  console.log('\n== PRODUCT PAGE ==');
  const slug = data.products[0].slug;
  setHash('#/product/' + slug);
  await new Promise(r => setTimeout(r, 40));
  check('pdp title renders', text('.pdp h1').length > 5);
  check('gallery thumbs present', document.querySelectorAll('.gallery .thumb').length >= 2);
  check('price shown', /EGP/.test(text('.pdp .price')));
  check('key shape options present', document.querySelectorAll('.shape-opt').length >= 4);
  const hasDisabledShape = !!document.querySelector('.shape-opt.unavailable');
  check('at least one unavailable shape (OOS)', hasDisabledShape);
  check('add disabled until shape chosen', !!document.querySelector('#addbtn') && document.querySelector('#addbtn').disabled === true);

  // select an available shape
  const selShape = document.querySelector('.shape-opt.selectable');
  if (selShape) { click(selShape); await new Promise(r => setTimeout(r, 40)); }
  check('add enabled after shape selection', !!document.querySelector('#addbtn') && document.querySelector('#addbtn').disabled === false);
  check('bundle card "COMPLETE YOUR SET" present', /COMPLETE.*SET/i.test(text('.bundle-card')));

  console.log('\n== ADD TO CART ==');
  const addBtn = document.querySelector('#addbtn');
  if (addBtn) { click(addBtn); await new Promise(r => setTimeout(r, 60)); }
  check('cart badge incremented', text('#cart-badge') === '1');
  check('drawer opened', document.querySelector('#cart-drawer').classList.contains('open'));
  check('drawer item rendered', !!document.querySelector('.drawer-item'));
  check('drawer recommendations rendered', !!document.querySelector('.drawer-reco') || !!document.querySelector('.drawer-bundle'));

  console.log('\n== LANGUAGE SWITCH ==');
  click(document.querySelector('[data-lang="ar"]'));
  await new Promise(r => setTimeout(r, 40));
  check('html dir becomes rtl', document.documentElement.dir === 'rtl');
  check('drawer title is Arabic', /سلة/.test(text('.drawer-head h3')));

  console.log('\n== FITMENT (full flow) ==');
  // start clean (no persisted fitment) so steps begin at 1
  window.localStorage.removeItem('velocci_fitment');
  setHash('#/fitment'); await new Promise(r => setTimeout(r, 40));
  check('fitment hero present', !!document.querySelector('.fit-title'));
  check('4-step indicator present', document.querySelectorAll('.fit-step').length === 4);
  check('brand grid present', document.querySelectorAll('.fit-brand-card').length >= 10);
  // step 1: pick brand (Mercedes) — should advance to step 2 with its models
  click(document.querySelector('[data-fitbrand="mercedes-benz"]')); await new Promise(r => setTimeout(r, 40));
  check('step 2 active after brand', document.querySelector('.fit-step[data-fitstep="2"]') && document.querySelector('.fit-step[data-fitstep="2"]').classList.contains('active'));
  check('only this brand models shown', document.querySelectorAll('.fit-model-card').length >= 1);
  // step 2: pick C-Class
  click(document.querySelector('[data-fitmodel="C-Class"]')); await new Promise(r => setTimeout(r, 40));
  check('year chips shown', document.querySelectorAll('.fit-year').length >= 1);
  // step 3: pick 2022
  click(document.querySelector('[data-fityear="2022"]')); await new Promise(r => setTimeout(r, 40));
  check('shape buttons shown', document.querySelectorAll('[data-fit-shape]').length >= 4);
  check('some shapes unavailable/OOS', document.querySelectorAll('.shape-opt.unavailable').length >= 1);
  // step 4: pick shape B (available for C-Class)
  click(document.querySelector('[data-fit-shape="B"]')); await new Promise(r => setTimeout(r, 40));
  check('vehicle context bar shows selection', /Mercedes|مرسيدس/i.test(document.querySelector('.fit-vehicle') ? document.querySelector('.fit-vehicle').textContent : ''));
  check('compatible products shown', document.querySelectorAll('.product-grid .product-card').length >= 1);
  check('brand chip tab matches mercedes only', [...document.querySelectorAll('.product-grid .product-card .cat')].every(c => /Mercedes|مرسيدس/i.test(c.textContent)));

  console.log('\n== CHECKOUT ==');
  setHash('#/checkout'); await new Promise(r => setTimeout(r, 40));
  check('checkout form present', !!document.querySelector('#checkout-form'));
  check('COD note present', /استلام|Cash|توصيل/i.test(document.body.textContent));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SMOKE ERROR:', e); process.exit(1); });
