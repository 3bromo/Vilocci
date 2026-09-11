// Headless test for the VELOCCI admin panel.
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const PUBLIC = path.join(__dirname, '..', 'public');
const API = 'http://localhost:3000';

(async function main() {
  // authenticate and keep the session cookie
  const loginRes = await fetch(API + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'velocci2026' }) });
  const setCookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  const data = await (await fetch(API + '/api/admin/data', { headers: { cookie: setCookie } })).json();
  const html = fs.readFileSync(path.join(PUBLIC, 'admin.html'), 'utf8');

  const dom = new JSDOM(html, {
    url: API + '/admin',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (u, o) => {
        const url = typeof u === 'string' ? u : u.url;
        const body = o && o.body ? JSON.parse(o.body) : {};
        if (url.indexOf('/api/admin/session') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve({ authenticated: true }) });
        if (url.indexOf('/api/admin/data') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
        if (url.indexOf('/api/admin/save') >= 0) { window.__saved = window.__saved || []; window.__saved.push(body); return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }); }
        if (url.indexOf('/api/admin/delete') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
        if (url.indexOf('/api/admin/order-status') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      };
      window.confirm = () => true;
      window.alert = () => {};
    }
  });

  const { window } = dom;
  const { document } = window;
  window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'engine.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'admin.js'), 'utf8'));
  await new Promise(r => setTimeout(r, 150));

  let pass = 0, fail = 0;
  const check = (n, c) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n); } };
  const text = (s) => (document.querySelector(s) || { textContent: '' }).textContent.trim();
  const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  console.log('\n== ADMIN AUTH + LAYOUT ==');
  check('sidebar rendered', !!document.querySelector('.sidebar'));
  check('dashboard stats cards >= 4', document.querySelectorAll('.card').length >= 4);
  check('recent orders table present', !!document.querySelector('.panel table'));

  console.log('\n== PRODUCTS VIEW ==');
  click(document.querySelector('[data-view="products"]'));
  await new Promise(r => setTimeout(r, 30));
  check('products table lists rows', document.querySelectorAll('tbody tr').length >= 10);
  check('add product button present', !!document.querySelector('#add-product'));

  console.log('\n== PRODUCT EDITOR ==');
  click(document.querySelector('#add-product'));
  await new Promise(r => setTimeout(r, 30));
  check('editor opens', !!document.querySelector('.editor.open'));
  check('editor form fields present', !!document.querySelector('[name="name_en"]'));
  check('brand select present', !!document.querySelector('[name="brandSlug"]'));
  // fill required fields for a keycase and save
  const set = (name, val) => { const el = document.querySelector(`[name="${name}"]`); if (el) el.value = val; };
  set('name_en', 'Test Carbon Case — BMW'); set('name_ar', 'جراب كربون — بي إم دبليو');
  set('price', '1299'); set('oldPrice', '1499');
  // ensure a shape is available
  const a = document.querySelector('[name="shapeok_A"]'); if (a) a.checked = true;
  click(document.querySelector('#ed-save'));
  await new Promise(r => setTimeout(r, 30));
  check('product saved (save fired)', (window.__saved || []).some(s => s.record && s.record.name_en === 'Test Carbon Case — BMW'));
  check('editor closed after save', !document.querySelector('.editor.open'));

  console.log('\n== BRANDS VIEW ==');
  click(document.querySelector('[data-view="brands"]'));
  await new Promise(r => setTimeout(r, 30));
  check('brands table lists rows', document.querySelectorAll('tbody tr').length === data.brands.length);

  console.log('\n== BUNDLES VIEW ==');
  click(document.querySelector('[data-view="bundles"]'));
  await new Promise(r => setTimeout(r, 30));
  check('bundles table lists rows', document.querySelectorAll('tbody tr').length === data.bundles.length);

  console.log('\n== ORDERS VIEW ==');
  click(document.querySelector('[data-view="orders"]'));
  await new Promise(r => setTimeout(r, 30));
  const or = document.querySelector('.order-status');
  check('order status select present', !!or);

  console.log('\n== PREORDERS ==');
  click(document.querySelector('[data-view="preorders"]'));
  await new Promise(r => setTimeout(r, 30));
  check('preorders table present', !!document.querySelector('.panel table'));

  console.log('\n== SETTINGS ==');
  click(document.querySelector('[data-view="settings"]'));
  await new Promise(r => setTimeout(r, 30));
  check('shipping fee field', !!document.querySelector('#s-shipping'));
  check('whatsapp field', !!document.querySelector('#s-whatsapp'));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ADMIN TEST ERROR:', e); process.exit(1); });
