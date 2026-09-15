# Supabase CMS — schema, content migration, and the admin panel

This document covers the work that moves the store from the bundled JSON file
onto Supabase **without replacing any existing storefront content**, and the
admin screens that manage that content.

---

## 1. Schema

| File | Version | What it does |
| --- | --- | --- |
| `supabase-schema.sql` | `001` | Baseline: 15 tables, `is_admin()`, `set_updated_at()`, RLS policies. Idempotent. |
| `supabase/migrations/002_cms_core.sql` | `002` | CMS core: `order_items`, `product_images`, `product_prices`, normalized `customer_*` columns on `orders`, and the remaining product/brand/bundle/slide/section/promo columns the live storefront actually uses. |

Both are additive. `002` never drops a table or a column and never deletes a
row; policies and triggers are dropped-then-created so the file can be re-run.

Three latent bugs in the baseline are fixed by `002`:

1. Admin policies were `for all using (is_admin())` **without `with check`**, so
   admin `INSERT`/`UPDATE` were rejected by RLS.
2. `categories_updated_at` fired on a table that had no `updated_at` column, so
   *every* category update raised an error.
3. `products.order` was an integer, but the live catalogue stores fractional
   order values (96 of 117 products) — rounding them would silently re-sort the
   storefront. The column is `numeric`.

## 2. Applying the schema

`scripts/migrate.js` is the single entry point. It tracks applied versions and
file checksums in `supabase_migrations.schema_migrations`.

```bash
npm run migrate                 # dry run: plan + content mapping, no writes
npm run migrate -- --json       # same plan as JSON (used by the tests)
npm run migrate -- --apply      # run migrations + upsert the mapped content
npm run migrate -- --print-sql  # paste-ready SQL bundle, no connection needed
npm run migrate -- --only=products
```

It needs a Postgres connection: `SUPABASE_DB_URL` (or `DATABASE_URL` /
`POSTGRES_URL`), e.g.

```
postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

> DDL cannot be applied over the PostgREST REST API, even with the service-role
> key — `--apply` requires a real Postgres connection string (or a Supabase
> Management API token). `npm run migrate -- --print-sql` exists for the case
> where you only have the Supabase SQL editor.

## 3. Content mapping — existing content only

`lib/mapping.js` holds the camelCase ⇄ snake_case mapping and the column
whitelists; `scripts/migrate.js` reads `data/velocci-db.json` (the file the live
storefront already serves) and upserts it. **Nothing is invented and nothing is
deleted.** The dry run prints the per-table row counts *and* re-verifies every
mapped row against the source file:

```
products 117/117 verified · categories 3 · brands 29 · bundles 29 ·
hero_slides 3 · home_sections 14 · settings 25 (24 keys + languages) · promo_bar 1 ·
website_content 167 · orders 23 · order_items 65 · product_images 279 ·
product_prices 117
```

Notable mapping decisions:

- **Categories are derived from the existing catalogue**, not written from
  scratch: slugs `keycase|keyholder|medal`, names from
  `languages.dict.{en,ar}.{key_cases,key_holders,car_medals}`
  ("Key Cases" / "Key Holders" / "Car Medals"), image = the first product image
  already in that category, `product_count` counted from the products.
- 9 of the 29 brands and 9 of the 29 bundles have no `id` in the source (slug
  only). The ids that do exist follow `b_<slug>`, so the missing ones are
  completed with the same deterministic id (`b_<slug>` for brands,
  `b_<brandSlug>` for bundles) — re-running the mapping can never insert a
  second row for the same brand.
- `products.order` is kept as-is (numeric) — see §1.
- `languages.dict` becomes one `settings` row (`key = 'languages'`);
  `websiteContent` becomes one `website_content` row per key (`id = wc_<key>`).
- `products.inventory` → `products.stock`; `discount` → `discount_pct`;
  `bundlePrice` → `bundle_price`; `keyCaseProductId` → `key_case_id`; etc.

## 4. Runtime

`lib/db.js` picks a driver from the environment:

| Driver | When | Notes |
| --- | --- | --- |
| `sql` | `SUPABASE_DB_URL` set | `node-postgres`, transactional `createOrder`. |
| `postgrest` | only `VITE_SUPABASE_URL` + service key | REST calls, order+items written sequentially. |
| `json` | neither | the bundled store, unchanged behaviour. |

`GET /api/admin/diagnose` reports which one is active.

Every admin mutation goes through the server (`/api/admin/save`,
`/api/admin/update`, `/api/admin/delete`, `/api/admin/order-status`) rather than
writing to Supabase from the browser — the browser only ever had the anon key,
and the old client-side `sbUpsert` wrote camelCase keys against real SQL
columns, so browser writes failed against a live database.

### Admin panel (`js/admin-app.js`)

- **Categories** — full CRUD: image (thumbnail + library picker), EN/AR names,
  slug, description, inline order number, show/hide, delete.
- **Products** — grouped editor: Basics, Details (short/long description,
  material, warranty, badge), Pricing (price, old price, auto-calculated
  discount %), Images (add by URL, library picker, reorder, remove, first image
  is the main one), Stock & flags. `keyShapes`, `models`, `years`, `specs`,
  `vehicles` and `order` are preserved on save.
- **Orders** — full list with Customer / Phone / Address columns, search and
  status filter, auto-refresh every 10 s, and a detail panel showing
  `customer_phone`, `customer_address`, the `order_items` rows (image, product,
  key shape, qty, unit price, line total), totals, status history and a status
  change control.
- **Website content** — searchable list of the 167 content strings with an
  EN/AR editor, plus home-section titles.
- **Website images** — add by URL into `website_images`, delete persisted.

Storefront checkouts are written to `orders` + `order_items` by
`POST /api/orders` and appear in the admin Orders list on the next poll.

> `js/*` and `css/*` are copied into `public/` (and `dist/`) at build time and
> `public/` is what Vercel serves — run `npm run build` after editing them.

## 5. Tests

```bash
npm run test:db     # embedded PostgreSQL 18.4: migrations, RLS, checkout -> admin,
                    # admin edit -> storefront, dry-run mapping. 41 checks.
npm test            # jsdom suites against a local server on :3000:
                    #   storefront smoke (34), admin auth (7), admin CMS (36).
```

`npm test` needs a server first. Use a scratch copy of the seed data so the
tests cannot write into the committed dataset:

```bash
cp data/velocci-db.json /tmp/velocci-test-db.json
VELOCCI_DB=/tmp/velocci-test-db.json node server.js
```

`test/admin_cms.js` builds its fixture with `lib/mapping.js` — the same module
the server uses to build `GET /api/admin/data` — so the admin panel is tested
against the exact shape it receives from Supabase.
