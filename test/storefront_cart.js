'use strict';
// Run against the same local test server as smoke.js. Never places live orders.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { FREE_SHIPPING_THRESHOLD, deliveryFeeFor } = require('../lib/shipping');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const api = process.env.STOREFRONT_TEST_URL || 'http://localhost:3000';
  const original = await (await fetch(api + '/api/data')).json();
  assert.equal(original.settings.freeShippingThreshold, FREE_SHIPPING_THRESHOLD);
  for (const lang of ['en', 'ar']) {
    for (const subtotal of [1999, 2000, 2001]) {
      // Deliberately stale stored policy must not affect authoritative fees.
      assert.equal(deliveryFeeFor({ shippingFee: 60, freeShippingThreshold: 1200 }, subtotal), subtotal < 2000 ? 60 : 0);
      const data = structuredClone(original);
      const p = data.products.find(p => p.active !== false && p.keyShapes.some(s => s.available));
      p.price = subtotal;
      p.colors = [];
      const shape = p.keyShapes.find(s => s.available).shape;
      p.category = 'keycase';
      const extras = ['keyholder', 'medal'].map((category, i) => ({ ...p, id: 'cart-test-' + i, category, price: 0 }));
      data.products.push(...extras);
      data.bundles = [{ brandSlug: p.brandSlug, active: true, normalTotal: subtotal, bundlePrice: subtotal - 100 }];
      const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), {
        url: api + '/#/product/' + p.slug, runScripts: 'dangerously', pretendToBeVisual: true,
        beforeParse(w) {
          w.fetch = async () => ({ ok: true, json: async () => data });
          w.scrollTo = () => {};
          w.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
          w.localStorage.setItem('velocci_lang', lang);
          w.localStorage.setItem('velocci_cart', JSON.stringify([p, ...extras].map(item => ({ productId: item.id, keyShape: shape, qty: 1 }))));
        },
      });
      const w = dom.window, doc = w.document;
      const click = el => { assert.ok(el); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); };
      try {
        w.eval(fs.readFileSync('public/js/engine.js', 'utf8'));
        w.eval(fs.readFileSync('public/js/app.js', 'utf8'));
        await wait(100);
        const progress = () => doc.querySelector('#cart-summary .shipping-progress');
        const before = progress().textContent;
        assert.ok(doc.querySelector('.drawer-savebox'));
        assert.ok(!/EGP\s+EGP/.test(doc.querySelector('#cart-summary').textContent));
        assert.equal(progress().querySelector('[role=progressbar]').getAttribute('aria-valuenow'), String(Math.round(Math.min(100, subtotal / 2000 * 100))));
        assert.equal(/✓/.test(before), subtotal >= 2000);
        click(doc.querySelector('[data-shape="' + shape + '"]'));
        const add = doc.querySelector('#addbtn');
        click(add);
        assert.match(add.textContent, lang === 'ar' ? /تمت الإضافة/ : /Added/);
        assert.equal(JSON.parse(w.localStorage.getItem('velocci_cart'))[0].qty, 2);
        assert.match(progress().textContent, /✓/);
        if (subtotal < 2000) assert.notEqual(progress().textContent, before);
        // Repeat click keeps quantity behavior and resets the success timer.
        click(add);
        assert.equal(JSON.parse(w.localStorage.getItem('velocci_cart'))[0].qty, 3);
        await wait(2450);
        assert.ok(!add.classList.contains('is-added'));
        // A failed persistence operation must not confirm or mutate the cart.
        const oldSet = w.Storage.prototype.setItem;
        w.Storage.prototype.setItem = () => { throw new Error('Quota exceeded'); };
        click(add);
        assert.ok(!add.classList.contains('is-added'));
        w.Storage.prototype.setItem = oldSet;
        assert.equal(JSON.parse(w.localStorage.getItem('velocci_cart'))[0].qty, 3);
        w.location.hash = '#/checkout';
        await wait(80);
        assert.ok(doc.querySelector('#checkout-totals .shipping-progress'));
        assert.ok(!/EGP\s+EGP/.test(doc.body.textContent));
        // Drawer quantity changes must refresh checkout shipping too.
        click(doc.querySelector('[data-qtyv="-1"]'));
        click(doc.querySelector('[data-qtyv="-1"]'));
        assert.equal(/✓/.test(doc.querySelector('#checkout-totals .shipping-progress').textContent), subtotal >= 2000);
        console.log(`✓ ${lang}: subtotal ${subtotal}, add/repeat/reset/failure, dynamic shipping and checkout`);
      } finally { w.close(); }
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
