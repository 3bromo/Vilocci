# Product slug synchronisation (`products_slug_key`) — diagnosis, fix and how to verify

> **Status: fixed in code. No database migration, no data rewrite, no destructive
> operation is required.** This document explains exactly what was wrong, what
> changed, and how to confirm it on the live project.

---

## 1. The symptom

Admin Dashboard showed:

```
upsert products: 23505: duplicate key value violates unique constraint "products_slug_key"
```

and, at the same time, a banner saying the products were being served from the
bundled backup JSON instead of the live Supabase database.

## 2. The root cause (one failure, two symptoms)

The two symptoms had a single cause. `lib/db.js` writes products with

```js
await upsertRows('products', [row], 'id');   // CONFLICT_TARGET.products = 'id'
```

i.e. PostgREST/SQL `insert … on conflict (id) do update`. A product therefore
had **two** unique keys that the write path had to satisfy:

| key | meaning | enforced by |
| --- | --- | --- |
| `id` | stable identity, what an edit matches on | primary key |
| `slug` | the product's public URL handle | `products_slug_key` (UNIQUE) |

`on conflict (id)` only resolves conflicts on `id`. When a record arrived with a
**new `id`** but a **slug that already belonged to another product**, Postgres
correctly attempted an `INSERT` and the unique index rejected it:

```
23505 duplicate key value violates unique constraint "products_slug_key"
```

There was no pre-flight slug check anywhere, so the most ordinary admin actions
could produce it:

* creating a product whose slug (auto-derived from the **name only**, e.g.
  `veloce-carbon-key-case`) was already used by another product;
* saving a record whose id was not in the live table (for example a record the
  dashboard had read from the **backup JSON** while a previous failure had
  switched the store over) but whose slug existed in production;
* leaving the slug field empty on an edit, which then re-derived a slug from the
  name and could collide.

### Why that produced "the dashboard is showing backup data"

`withFallback()` in `lib/db.js` treated **every** error as a driver failure:

```js
} catch (err) {
  remoteDown(err);      // ← flipped the WHOLE store to the JSON backup for 60s
  return fn();
}
```

A rejected record (a `23505` validation error) therefore took the entire store
offline: reads *and* writes fell back to `data/velocci-db.json`, `/api/admin/data`
reported `usingJsonFallback: true`, and the dashboard displayed its warning. One
bad slug was enough. Reproduced with the original code before fixing:

```
[data] postgrest driver unavailable — serving the JSON store for the next 60s
       instead. Reason: upsert products: 23505: duplicate key value violates
       unique constraint "products_slug_key"
health after: {"configuredDriver":"postgrest","activeDriver":"json",
               "usingJsonFallback":true,"remoteState":"unavailable", …}
```

The store itself was never damaged: the constraint did its job.

## 3. What changed

### `lib/mapping.js` — the slug rules, in one pure place

New exports: `slugify`, `uniqueSlug`, `planProductSlug`, `duplicateSlugError`.

* `slugify()` — the canonical form (lowercase, ASCII, `-` separated, trimmed).
* `uniqueSlug()` — deterministic free slug (`x`, `x-2`, `x-3`, …).
* `planProductSlug({ id, slug, name, existing })` decides the slug for a save:
  1. an existing product **keeps its slug** (its URL) unless it was changed;
     an empty slug in an edit never blanks the column;
  2. a new product with a free slug uses it;
  3. a slug owned by **another** product is **refused** (never merged, never
     renamed silently, never deleted);
  4. a product saved without a slug gets a guaranteed-unique generated one.

### `lib/db.js`

* `saveRecord('products', …)` resolves the slug **before** writing, so a
  conflicting slug never reaches Postgres. A `23505` that still slips through
  (concurrent save) is converted into the same clear `DUPLICATE_SLUG` error
  instead of the raw SQL text.
* `isInputError()` classifies constraint/validation errors (`23502`, `23503`,
  `23505`, `23514`, `22P02`, `42P10`, `PGRST102`, `PGRST204`, plus the explicit
  `INVALID_INPUT` / `DUPLICATE_SLUG` codes). `withFallback()` now rethrows those
  instead of flagging an outage — **a rejected record can no longer switch the
  app to the backup**.
* Driver errors keep their machine-readable code (`err.pgCode`) on the thrown
  Error so classification never depends on parsing a message.
* **Write safety while the backup is serving.** Admin catalog writes
  (products, categories, shapes, brands, bundles, hero slides, home sections,
  website images/content, discount codes, settings, promo bar, languages) are
  **refused** with `DB_UNAVAILABLE` (HTTP 503) when the live database is
  unreachable. Nothing is written into `data/velocci-db.json` — a backup record
  can never be mistaken for, or written over, production data. Customer intake
  (orders, pre-orders, messages, customize requests) keeps the previous fallback
  behaviour so no customer action is dropped.
* `productSlugReport()` — a **read-only** report (duplicate normalized slugs,
  blank slugs, non-canonical slugs, row counts) used by the diagnostics
  endpoint.

### `server.js`

* `/api/admin/save|update|delete|reorder|settings|lang` answer with the right
  status: **409** for a slug conflict (with `suggestion` / `existingId`),
  **503** when the live database is unreachable, **400** otherwise.
* `/api/admin/data` `_meta` gains `writesBlocked`, so the UI can state the data
  source and the write policy.
* `/api/admin/diagnose?probe=1` now returns a `productSlugs` block (read-only)
  and lists any normalized-slug collision in `issues`.

### `js/admin-app.js` (+ `public/`, `dist/` copies)

* Product editor: a typed slug that belongs to another product is refused
  **before** the request, naming the owner and suggesting a free slug; an empty
  slug is generated as a unique one automatically; an edit keeps the existing
  URL verbatim.
* Server answers are shown as written for the admin (never a raw Postgres code);
  a `DB_UNAVAILABLE` answer re-renders the banner instead of pretending success.
* Header badge: **`● LIVE database`** / **`● LIVE — config warning`** /
  **`● BACKUP — read-only`**, plus banner copy that says the backup is not the
  live catalogue and cannot be saved.

## 4. Was any production data corrected?

**No.** Nothing in this change writes, migrates, renames or deletes a row:

* product `id`s, slugs, names, prices, images, categories, brands, variants,
  colors, customization settings, orders and customers are untouched;
* the `products_slug_key` constraint stays exactly as it is;
* `data/velocci-db.json` is only ever *read* (and only when no database is
  configured, or while the live one is unreachable).

The database **cannot** contain two identical slugs while the unique index
exists, so there is no "duplicate pair" waiting to be merged or deleted.

## 5. Is a migration required?

**No.** No table, column, index or policy changes. `scripts/migrate.js` and
`supabase/migrations/*.sql` are unchanged.

If you want to *audit* the live table, run the read-only statements in
`supabase/diagnostics/product-slug-audit.sql` (SELECTs only) in
Supabase → SQL Editor, or open `/api/admin/diagnose?probe=1` and read the
`productSlugs` block. If a finding appears (e.g. two slugs that normalize to the
same value, or a product with no slug), fix it by **editing the slug in
Admin → Products** — never by deleting a product or dropping the constraint.

## 6. How to verify

```bash
npm run test:slugs     # lib/mapping.js rules, JSON driver, PostgREST driver
                       # against a fake Supabase that enforces products.slug UNIQUE
npm run test:fallback  # backup stays read-only; writes are refused with 503
npm run test:admin     # dashboard: duplicate slug blocked, 409 message shown,
                       # LIVE/BACKUP badge and banner
npm test               # full suite
```

`test/product_slug_sync.js` drives the real `lib/db.js` through the real
`@supabase/supabase-js` client against a local PostgREST-compatible endpoint that
enforces `products.slug` UNIQUE, so the exact `23505` path is exercised without
touching a real project. It asserts, among others:

* editing a product updates it in place (no second row, id and slug unchanged);
* a duplicate slug is refused with an admin-readable message and a suggestion;
* the refusal does **not** flip the store to the backup (`usingJsonFallback`
  stays `false`);
* a rename onto another product's slug is refused and the other product is
  untouched;
* with the database unreachable, an admin write is refused with
  `DB_UNAVAILABLE` and the backup file on disk is byte-identical afterwards.

## 7. Behaviour changes worth knowing

1. **Admin catalog edits fail loudly** (503, clear message) while the live
   database is unreachable, instead of "saving" into the local backup file.
2. **A slug that belongs to another product is rejected** with a 409 and a
   suggested free slug. To move a URL from one product to another, change the
   first product's slug to something else first.
3. Product slugs are now normalized on save (`"Audi Key Case"` →
   `audi-key-case`), so the same URL handle cannot be entered twice in different
   spellings.
