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
- **Product page** — gallery, price, old price, discount, **mandatory key-shape selector** (unavailable shapes greyed + "OUT OF STOCK" + X, unclickable), **mandatory color selector** for products with admin-configured colors (round swatches from the stored HEX), the optional **Nano Ceramic Coating** extra on Key Holder / Key Case pages (+ EGP 100, always shown with its price), dynamic "Only N left in stock", quantity, **Complete Your Set** bundle widget. All product-page content (description, material, compatibility, specifications table, vehicle list, tabs, buttons) fits the mobile viewport with no horizontal overflow.
- **Quick Add** — every product card opens a two-step modal: **SELECT YOUR KEY SHAPE → SELECT YOUR COLOR → ADD TO CART**.
  The colors are the product's own list from Admin → Products → Colors (enabled colors only, admin order, round swatches).
  Add to Cart never fires without both choices and instead shows the localized validation message; the shape **and** the color
  are stored on the cart line (same product with different shape/color combinations stays separate) and travel through checkout
  into the order. Products without configured colors keep the shape-only fallback. For Key Holders and Key Cases the modal
  also offers the **optional** Nano Ceramic Coating checkbox (+ EGP 100) under the two mandatory steps.
- **Bundle upsell** — picks the matching products for the SAME car brand only; never recommends unrelated brands.
- **Cart drawer** — slide-out with images, brand, key shape, qty, remove, "Complete Your [Brand] Set & Save", real-time subtotal / bundle discount / coating fee / delivery fee / total, Cash on Delivery note. Coated lines carry a gold "Nano Ceramic Coating · + EGP 100" chip.
- **Checkout** — guest checkout, **Cash on Delivery only** (no Stripe/PayPal/card). Full name, phone, city, area, address, notes. Prices in EGP.
- **Discount codes** — the customer types a code in the checkout summary; it is checked by `POST /api/validate-discount`
  against the codes in **Admin → Discounts**, the saving is shown immediately (cart drawer, checkout summary and the
  confirmation page all stay in step) and the total is updated. See "Discount codes" below.
- **Nano Ceramic Coating** — optional extra that replaced the old "Premium Gift Packaging" option (which is gone from the
  entire site). Key Holders and Key Cases only; a flat **+ EGP 100 per cart line** that opts in — never × quantity, never
  a percentage, EGP 0 when not selected. See "Nano Ceramic Coating" below.
- **Order confirmation** page with order ID.
- **Pre‑orders** — marked products can be reserved with no payment; stored separately.
- **Arabic / English** — complete RTL translation, one language at a time, natural translations.
- **Support pages** — Key Guide, Shipping & Returns, Warranty, About, Workshop Story.
- **Mobile** — dedicated premium mobile experience (hamburger menu, stacked hero, RTL), not a shrunk desktop.
  The search panel opens as a viewport-wide sheet pinned to equal left/right insets (LTR **and** RTL, 320–820px), so it can
  never be clipped; the promo bar is compacted (the second "Limited Time Only" line is hidden on mobile) so the hero starts higher.

### Admin panel (`/admin`)
- **Dashboard** — revenue, orders, products, low-stock alerts, recent orders.
- **Products** — add / edit / delete; EN + AR names & descriptions, price, old price, discount, images, category, brand, models, years, **key shapes**, inventory, out-of-stock, featured / best seller / new arrival / limited edition / pre-order.
  **Product images are selected from the admin's image library, not typed**: *🖼️ Add image* opens the **existing media
  library** (Admin → *Website Images*, the `website_images` rows) as a chooser on top of the editor — search it, click a
  thumbnail and its URL populates the product gallery with a preview. The picker stays open, so a product with several
  images is built one selection at a time (duplicates are refused, *✓ added* marks what is already in the gallery);
  reorder with ↑ ↓, remove with 🗑, first image = main image. An image that is not in the library yet is added with
  *📷 Upload a new photo* **inside the same picker**: it opens the device gallery (iOS Safari *Photo Library / Take Photo*,
  Android's picker, the desktop file dialog), shrinks a big phone photo in the browser, uploads it through the library's own
  `POST /api/admin/upload` — falling back to `POST /api/admin/products/image` → `lib/storage.js` → the PUBLIC Supabase bucket
  `product-images` (migration `010`) on a read-only host such as Vercel — and **saves it into the library**, so every other
  product can reuse it. Existing images — generated `/img/asset.svg` artwork, pasted public URLs, `/img/uploads` files —
  are untouched and keep working, and pasting a URL is still available behind *Paste an image URL instead*. Setup and
  verification: **`docs/PRODUCT-IMAGE-UPLOADS.md`**.
- **Brands** — add / edit / delete; EN + AR name, slug, description and **logo upload** (or paste a public URL).
  A saved logo is served to the storefront (brand strip, all-brands page, brand page, product pages); brands without one keep the
  shipped `/img/logos/<slug>` file. On read-only hosts (Vercel) an upload that cannot be written to disk is kept with the brand record
  as a small data URL instead of failing. Editing PATCHes through `/api/admin/update`, so models/years/fitment, tier, order and the
  accent colour are never overwritten.
- **Shapes** — Shape management: the global **key-shape catalogue** (A–D by default). Add / rename (EN + AR) /
  describe / reorder / hide / delete shapes. The catalogue is the master list behind **every** shape selector on the
  storefront — the product-page picker, Quick Add, the Fitment Finder and the Key Guide — and a hidden shape
  disappears from all of them **and** can no longer be ordered (the server falls back to no shape). Products keep
  their own per-shape availability flags (the product editor exposes the catalogue as checkboxes), so a shape must be
  catalogue-active *and* product-available before a customer can pick it. Until migration `007` is applied the
  catalogue is derived from the products' own flags, so nothing breaks mid-deploy.
- **Bundles** — pick the brand's set, set bundle price; discount & % auto-computed; active/inactive.
- **Discounts** — create promo codes: code, **percentage or fixed amount**, minimum order, maximum uses (or unlimited),
  expiration date, active/inactive, and a live `uses / max` counter. Codes are the ones the checkout accepts.
- **Fitment** — manage brand → model → year → key-shape compatibility.
- **Homepage** — hero slides (add/edit/reorder/enable), home sections (drag-to-reorder + enable/disable), promo bar + countdown.
- **Orders** — all fields (order ID, customer, items, brand, key shape, color, **Nano Ceramic Coating** per-line badge + fee, qty, subtotal, discount, delivery, total, date) with status updates: New / Confirmed / Preparing / Shipped / Delivered / Cancelled.
- **Pre-orders** — separate list with status Pending / Confirmed / Cancelled.
- **Messages** — contact / pre-order enquiries.
- **Settings** — WhatsApp, Instagram, Facebook, TikTok, contact email, shipping fee, free-shipping threshold, return policy, warranty, copyright, currency.

### Data & architecture
- **Single shared JSON datastore** (`data/velocci-db.json`, atomic writes) — the same source powers the storefront and admin. No second database.
- On-the-fly **SVG product artwork** (`/img/asset.svg`) so every product has brand-distinguished, premium imagery and there is never an empty grid. Admin can also supply their own image URLs.
- **Server-side order validation** — totals, inventory, shapes, bundle discounts, discount codes **and the Nano Ceramic Coating fee/eligibility** are recomputed on the server; the client is never trusted.

### Discount codes

Codes are created in **Admin → Discounts** and stored in the `discount_codes` table. The storefront never receives them:
`/api/data` does not contain them, and a code is only ever checked by `POST /api/validate-discount`, server-side.

```
customer types code  ->  POST /api/validate-discount { code, cart }
                     ->  checked against Admin -> Discounts
                     ->  { ok:true, code, type, value, discount }   (or { ok:false, reason })
                     ->  checkout shows the saving and updates the total
                     ->  POST /api/orders { …, discountCode }
                     ->  server RE-validates, re-prices, charges the lower total
                     ->  used_count incremented
```

Rules (one implementation, `lib/discounts.js`, shared by both endpoints):

| | |
| --- | --- |
| Matching | case-insensitive and whitespace-insensitive — `save20`, `SAVE20` and `" save20 "` are the same code |
| Percentage | applied to the merchandise subtotal (before the bundle saving, excluding delivery) |
| Fixed | taken off the merchandise subtotal |
| Stacking | a code and a bundle saving both apply, but a code can never discount more than the merchandise left after the bundle, so the total can never fall below the delivery fee |
| Refused when | unknown, inactive, expired, `used_count >= max_uses`, or the subtotal is under the code's minimum order |

The order endpoint re-runs the same check, so a code that expires between quoting and checkout is refused with a
reason the storefront explains in the customer's language — it can never buy a discount. The redemption counter is
incremented only after the order is safely written.

> The `orders` table has no column for the code itself, so the durable record of a redemption is the discounted
> `total` plus the code's `used_count` in Admin → Discounts. Storing the code on the order would need a small
> migration (`alter table public.orders add column discount_code text`).

Tests: `npm run test:discount` (62 assertions: the rules, the endpoint against the real server, the order total,
the usage counter, and the checkout UI in jsdom driving the real endpoint).

### Nano Ceramic Coating

The optional extra that **replaced the old "Premium Gift Packaging"** checkbox (the old option — which was purely
cosmetic, never priced and never stored — is gone from the storefront, the styles and the language dictionary).

```
product page / Quick Add  ->  customer ticks "Nano Ceramic Coating  + EGP 100"
                          ->  the opt-in is stored ON the cart line (like shape + color)
                          ->  cart drawer / checkout show a "Nano Ceramic Coating  + EGP 100" totals row
                          ->  POST /api/orders { …, cart:[{ …, coating:true }] }
                          ->  server RE-checks the category and RE-prices: +100 per coated line
                          ->  orders.coating_fee + order_items.coating persist for the Admin
                          ->  Admin → Orders shows a ◆ Coating badge and the fee in the totals
```

Rules (one implementation, mirrored in `js/app.js` for display and enforced in `server.js`):

| | |
| --- | --- |
| Eligible products | **Key Holders and Key Cases only** — medals and anything else never show the option, and a coated medal claimed by a hand-edited client is silently stripped server-side |
| Price | flat **EGP 100 per coated cart line** — never × quantity, never a percentage of the product price |
| Not selected | EGP 0 — no row, no fee, no stored flag |
| Stacking | the fee is an additional charge like delivery: bundle savings and discount codes are computed from the merchandise subtotal and never reduce it, and product prices are untouched |
| Persistence | `order_items.coating` (per-line snapshot) + `orders.coating_fee` (order total) via migration `006_nano_ceramic_coating.sql`; both columns are only written when a coating was actually chosen, so un-coated COD/InstaPay orders keep working even before the migration is applied (the InstaPay-proof pattern) |

Tests: `npm run test:coating` (82 assertions: the persistence mapping, the real server — eligibility, flat fee,
qty independence, bundle/discount/InstaPay stacking, admin APIs — and the storefront in jsdom: PDP + Quick Add
eligibility, cart drawer, checkout, success page, Arabic RTL, stored order).

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
| Shape management (key-shape catalogue) | Admin → Shapes · `lib/mapping.js` + migration `007` · `app.js` (every selector) · `server.js` (order rule) |
| Product images from the admin media library (+ uploads) | Admin → Products → edit → Images · `js/admin-app.js` → `openImageLibraryPicker()` / `uploadImageToLibrary()` · `website_images` library · `/api/admin/upload` + `/api/admin/products/image` · `lib/storage.js` (public `product-images` bucket) + migration `010` · `docs/PRODUCT-IMAGE-UPLOADS.md` |
| Complete Your Set | product bundle widget + cart upsell |
| Cart drawer + real-time calc | `app.js` → `renderCartDrawer()` |
| Nano Ceramic Coating (+EGP 100, Key Holder/Case only) | `app.js` (PDP + Quick Add + totals) · `server.js` (eligibility + re-pricing) · `lib/mapping.js` + migration `006` |
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
npm test                        # headless storefront + admin suites (jsdom)
npm run test:productimages      # product images: library picker, uploads, persistence, storefront
npm run test:productimagestorage# the Supabase Storage calls behind a product photo upload
npm run probe:productimages     # operator probe: the whole upload flow against a DEPLOYED store
npm run test:e2e                # real-browser purchase flow (Playwright/Chromium)
npm run shot                    # capture screenshots into /shots
```

`npm test` needs a running server on `:3000` (`npm start`); every other suite spawns its own.

Given a running server (`npm start`), `npm test` validates routing, product page,
shape selection, add-to-cart, cart drawer, EN/AR switching, the full her-limit flow,
the admin product/brand/bundle/order/settings views, `test/quickadd_mobile.js`
(`npm run test:quickadd`) which covers the Quick Add shape → color → add flow
(localized validation, enabled colors only, variant separation, cart → checkout →
order), the mobile-safe layout rules (search sheet, promo/hero, product-page fit)
and the fact that the public site exposes no admin entry while `/admin` keeps working,
and `test/admin_brands.js` (`npm run test:brands`) which covers Admin → Brands:
renaming a brand, uploading/changing its logo (including the read-only-disk fallback),
the patch reaching `/api/data`, and the storefront rendering the new name + logo,
and `test/nano_coating.js` (`npm run test:coating`) which covers the Nano Ceramic
Coating extra end to end: category eligibility (Key Holder / Key Case only), the flat
+EGP 100 per coated line (never × qty), bundle/discount/InstaPay stacking, cart →
checkout → order → admin persistence, and the removal of the old Premium Gift option.

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

| Variable         | Purpose                                    | Default            | Required |
| ---------------- | ------------------------------------------ | ------------------ | -------- |
| `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` — admin login **and** Supabase Storage (product/shape image uploads) | *(empty → JSON store, no admin login)* | **yes** in production |
| `VITE_SUPABASE_ANON_KEY` | anon/public key — the admin SPA's auth client (safe in the browser, RLS protects data) | *(empty)* | **yes** in production |
| `SUPABASE_SERVICE_ROLE_KEY` | service-role key — server-side only: writes catalog rows and **uploads images to Storage** | *(empty → uploads fall back to disk/inline)* | **yes** for durable image uploads |
| `SUPABASE_DB_URL` | direct Postgres URL → transactional `sql` driver; also needed by `npm run migrate:apply` | *(empty → `postgrest` driver)* | optional |
| `PRODUCT_IMAGE_BUCKET` | bucket for product photos (public, auto-created/verified) | `product-images` | optional |
| `SHAPE_IMAGE_BUCKET` | bucket for key-shape photos (public, auto-created/verified) | `shape-images` | optional |
| `CUSTOMIZE_BUCKET` | **private** bucket for customer car photos + payment proofs | `customize-uploads` | optional |
| `CUSTOMIZE_MAX_IMAGE_BYTES` | per-image byte cap for **every** validated upload (products included) | `6291456` (6 MB) | optional |
| `CUSTOMIZE_SIGNED_URL_TTL` | lifetime (s) of the admin signed URL for a private photo | `300` | optional |
| `ADMIN_DEV_TOKEN` | local-only admin bypass for the test suite (inert when a real Supabase project is configured) | *(unset)* | never in production |
| `PORT`           | HTTP port (Vercel injects this)            | `3000`             | — |
| `VELOCCI_DB`     | Optional path to the JSON datastore        | `./data/velocci-db.json` | optional |
| `DATA_DRIVER`    | Force a driver (`json` / `sql` / `postgrest`) | auto-detected     | optional |
| `ADMIN_PASS`, `SESSION_SECRET` | legacy session fallback (Supabase Auth is the real gate) | `velocci2026`, `velocci-secret-key` | optional |

Copy `.env.example` for the same list with comments. **After changing any variable in Vercel you
must redeploy** — environment variables are baked in at deploy time. The image-upload half of
this table (what each variable does for the product-image picker, how to verify it, and what
each failure means) is documented step by step in **`docs/PRODUCT-IMAGE-UPLOADS.md`**.

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
- Currency is **EGP**. Change `shippingFee` and copy in Admin → Settings. Complimentary shipping starts at EGP 2,000 (merchandise subtotal, before discounts and add-ons). `lib/shipping.js` owns this policy; public/admin settings and server order pricing use that same value, overriding obsolete stored thresholds.
- All automotive imagery is original VELOCCI artwork; no trademarked brand assets are copied.
