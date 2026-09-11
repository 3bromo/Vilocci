# VELOCCI — Premium Automotive Key Accessories

A complete, production-grade **E‑commerce website + working Admin Panel** for a
premium automotive luxury brand. The customer storefront and the admin panel run
against the **same data source**, so any change made in admin is reflected on the
live site immediately.

Built as an original VELOCCI brand — it does not copy another website's branding,
assets, or design.

---

## Quick start

```bash
cd velocci
npm install        # installs express, express-session, cookie-parser
npm run seed       # (optional) seeds the store with brands/products/bundles
npm start          # starts the server on http://localhost:3000
```

Open:

- **Storefront** → http://localhost:3000
- **Admin panel** → http://localhost:3000/admin

Default admin password: **`velocci2026`** (override with `ADMIN_PASS` env var).

---

## What's built

### Storefront (customer site)
- **Promo bar** — black announcement bar with a **live countdown timer** (configurable in Admin).
- **Header** — VELOCCI logo, nav (Home / Key Cases / Key Holders / Medals / Brands / About), search (live), account, cart, **EN / AR language switcher**.
- **Hero** — premium photographic hero slides, fully manageable from Admin.
- **Shop by Car Brand** — 20 automotive brands with original stylized emblems.
- **Benefits strip** — Premium Materials / Perfect Compatibility / Cash on Delivery / Easy Returns (EN + AR).
- **Best Sellers, New Arrivals, Key Cases, Key Holders, Car Medals, Complete Your Set, Limited Edition, Why Velocci** — all populated home sections, reorderable from Admin.
- **Fitment Finder ("Find Your Key")** — Brand → Model → Year → Key Shape → compatible products only. The chosen vehicle persists while browsing.
- **Brand pages** — show only products compatible with that brand.
- **Product page** — gallery, price, old price, discount, **mandatory key-shape selector** (unavailable shapes greyed + "OUT OF STOCK" + X, unclickable), dynamic "Only N left in stock", quantity, **Complete Your Set** bundle widget.
- **Bundle upsell** — picks the matching products for the SAME car brand only; never recommends unrelated brands.
- **Cart drawer** — slide-out with images, brand, key shape, qty, remove, "Complete Your [Brand] Set & Save", real-time subtotal / bundle discount / delivery fee / total, Cash on Delivery note.
- **Checkout** — guest checkout, **Cash on Delivery only** (no Stripe/PayPal/card). Full name, phone, city, area, address, notes. Prices in EGP.
- **Order confirmation** page with order ID.
- **Pre‑orders** — marked products can be reserved with no payment; stored separately.
- **Arabic / English** — complete RTL translation, one language at a time, natural translations.
- **Support pages** — Key Guide, Shipping & Returns, Warranty, About, Workshop Story.
- **Mobile** — dedicated premium mobile experience (hamburger menu, stacked hero, RTL), not a shrunk desktop.

### Admin panel (`/admin`)
- **Dashboard** — revenue, orders, products, low-stock alerts, recent orders.
- **Products** — add / edit / delete; EN + AR names & descriptions, price, old price, discount, images, category, brand, models, years, **key shapes**, inventory, out-of-stock, featured / best seller / new arrival / limited edition / pre-order.
- **Brands** — add / edit, logo (stylized emblem), accent colour, tier, **models → years → key shapes** (fitment), enable/disable, reorder.
- **Bundles** — pick the brand's set, set bundle price; discount & % auto-computed; active/inactive.
- **Fitment** — manage brand → model → year → key-shape compatibility.
- **Homepage** — hero slides (add/edit/reorder/enable), home sections (drag-to-reorder + enable/disable), promo bar + countdown.
- **Orders** — all fields (order ID, customer, items, brand, key shape, qty, subtotal, discount, delivery, total, date) with status updates: New / Confirmed / Preparing / Shipped / Delivered / Cancelled.
- **Pre-orders** — separate list with status Pending / Confirmed / Cancelled.
- **Messages** — contact / pre-order enquiries.
- **Settings** — WhatsApp, Instagram, Facebook, TikTok, contact email, shipping fee, free-shipping threshold, return policy, warranty, copyright, currency.

### Data & architecture
- **Single shared JSON datastore** (`data/velocci-db.json`, atomic writes) — the same source powers the storefront and admin. No second database.
- On-the-fly **SVG product artwork** (`/img/asset.svg`) so every product has brand-distinguished, premium imagery and there is never an empty grid. Admin can also supply their own image URLs.
- **Server-side order validation** — totals, inventory, shapes and bundle discounts are recomputed on the server; the client is never trusted.
- Express + express-session + cookie-parser. Session-protected admin API.

---

## Requirement mapping

| Requirement | Where |
|---|---|
| 20 brands, models, years, shapes | `data/seed.js` → `brandDefs` |
| ~80 products linked by brand | `data/seed.js` → `buildProducts()` |
| Bundles (normal / bundle / save / %) | `data/seed.js` → `buildBundles()` + admin Bundle Management |
| Hero management | Admin → Homepage → Hero slides |
| Fitment Finder | storefront `#/fitment` + admin Fitment |
| Key Shape selector (A/B/C/D, OOS) | product page, `app.js` → `pdpHTML()` |
| Complete Your Set | product bundle widget + cart upsell |
| Cart drawer + real-time calc | `app.js` → `renderCartDrawer()` |
| COD-only checkout, guest | `app.js` → `checkoutHTML()` + `/api/orders` |
| EN/AR RTL | `data/seed.js` → `buildLanguages()` + `app.js` |
| Orders + status workflow | admin Orders + `/api/admin/order-status` |
| Pre-orders separate | `/api/preorders` + admin Pre-orders |
| Homepage sections reorder | admin Homepage → sections drag-and-drop |
| Social / shipping / warranties settings | admin Settings |
| Mobile experience | `public/css/styles.css` responsive blocks + mobile menu |
| SEO / accessibility / performance | semantic HTML, alt text, lazy images, optimized JPGs, meta tags |

---

## Tests

```bash
npm test          # headless storefront + admin suites (jsdom)
npm run test:e2e  # real-browser purchase flow (Playwright/Chromium)
npm run shot      # capture screenshots into /shots
```

Given a running server (`npm start`), `npm test` validates routing, product page,
shape selection, add-to-cart, cart drawer, EN/AR switching, the full her-limit flow
and the admin product/brand/bundle/order/settings views.

---

## Admin password

`ADMIN_PASS` on the server start (default `velocci2026`):

```bash
ADMIN_PASS=mysecret npm start
```

---

## Deploy to Vercel (serverless)

The app deploys with **no `functions` and no `builds`** in `vercel.json` (both are
what caused the `functions`/`builds` "cannot be used in conjunction" and the
strict-schema errors). Instead:

- **`public/`** is served automatically by Vercel's CDN (per Vercel's Express guide,
  `express.static()` is ignored on Vercel — put assets in `public/`). This covers
  `index.html`, `/css/*`, `/js/*`, `/img/logos/*`, `/img/uploads/*`, `/img/hero*`.
- **`api/index.js`** is auto-detected as a Vercel Node Function (it just re-exports
  the Express app) and handles `/api/*` and the on-the-fly product image
  `/img/asset.svg`.
- **`vercel.json`** only contains a minimal `rewrites` array:
  `/api/*` → the function, `/img/asset.svg` → the function, and `/admin` → the
  static `admin.html`. The storefront is a hash-routed SPA, so `/` is served from
  `public/index.html` and no history-API fallback is needed.

Build is handled by `package.json`: `npm run build` seeds the canonical catalog,
and the store is seeded into memory at function boot (`seed()`), so no file-based
DB write is required on Vercel.

### Option A — upload the packaged ZIP
1. Unzip the `velocci-<version>.zip` archive.
2. In the Vercel dashboard: **Add New → Project → Import** →
   choose **"Upload"**/drag the unzipped folder (or deploy the `.zip` in one go).
3. Vercel auto-detects `vercel.json` and the Node runtime; it runs `npm install`
   (which seeds the datastore via `postinstall`) and `npm run build`.

> Vercel does **not** use `.gitignore` when uploading a folder/zip, so the
> pre-seeded `data/velocci-db.json` ships with the deploy. `.vercelignore`
> keeps `shots/`, `test/` and `node_modules/` out of the function bundle.

### Option B — deploy via Git or the CLI
```bash
npm i -g vercel
cd velocci
vercel --prod
```
Or push the folder to a GitHub repo and **Import** it in Vercel.

### 3. Environment variables
Set these in **Project → Settings → Environment Variables** (copy `.env.example`):

| Variable         | Purpose                                    | Default            |
| ---------------- | ------------------------------------------ | ------------------ |
| `ADMIN_PASS`     | Password for `/admin`                      | `velocci2026`      |
| `SESSION_SECRET` | Cookie-signing secret (use a long random)  | `velocci-secret-key` |
| `PORT`           | HTTP port (Vercel injects this)            | `3000`             |
| `VELOCCI_DB`     | Optional path to the JSON datastore        | `./data/velocci-db.json` |

### Data persistence on Vercel
Vercel's serverless filesystem is **read-only and ephemeral**. The JSON
datastore (`data/velocci-db.json`) is loaded into memory at boot and seeded on a
fresh deploy from `data/seed.js` (via `postinstall`/`build`). Admin edits and new
orders are kept **in memory** for the active instance and are **not** written to
disk between invocations — the store's `save()` is wrapped in a try/catch so a
read-only FS never crashes a request.

For durable data in production, swap `lib/store.js` (the single integration
point) for a hosted database (e.g. **Vercel Postgres / KV, Supabase, or a hosted
Redis/Mongo**) and add the connection string to the environment variables above.


---

## Notes
- The store is seeded on first boot (non-destructive). Run `npm run seed -- --force`
  to reset to the defaults (brands/products/bundles).
- Currency is **EGP**. Change `shippingFee`, `freeShippingThreshold` and copy in Admin → Settings.
- All automotive imagery is original VELOCCI artwork; no trademarked brand assets are copied.
