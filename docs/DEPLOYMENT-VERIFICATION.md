# Deployment Verification — VELOCCI / SPINTO

**Date:** 2026-09-14 (UTC)
**Performed:** GitHub → Vercel → Production end-to-end verification
**Method:** Live production endpoint checks + GitHub deployment/commit-status API.

This document truthfully records what was verified. It is also the commit used
to prove that a new push to `main` automatically triggers a Vercel Production
deployment. It changes **no application code and no data**.

---

## 1. URLs

| Surface | URL |
| --- | --- |
| Production storefront | https://vilocci-b31u.vercel.app |
| Admin panel | https://vilocci-b31u.vercel.app/admin |
| Repository | https://github.com/3bromo/Vilocci |

---

## 2. Verified WORKING on Production (evidence-backed)

- **Storefront serves (HTTP 200).** Title: "SPINTO — Luxury Key Accessories for Your Car".
- **Catalog renders with the full live data.** Home page category cards show:
  - Key Cases — **59 products**
  - Key Holders — **29 products**
  - Car Medals — **29 products**
  - **Total = 117 products** across **3 categories**.
- **Product images render** (on-the-fly SVG via `/img/asset.svg` + brand logo SVGs under `/img/logos/`).
- **Brands, bundles, fitment finder, EGP pricing, EN/AR** all render.
- **`GET /api/data`** returns the full public payload (settings, languages, hero slides, home sections, brands, bundles, products).
- **GitHub → Vercel is connected.** `main` deploys to Vercel automatically; commit statuses report `success`.

### Data snapshot (deployed source of truth: `data/velocci-db.json`)
| Entity | Count |
| --- | --- |
| Products (active) | 117 |
| Categories | 3 (keycase=59, keyholder=29, medal=29) |
| Brands | 29 |
| Bundles | 29 |
| Orders | 23 |
| Pre-orders | 0 |

> The production instance is seeded from `data/velocci-db.json` at boot. These
> counts were confirmed both in the committed file and in the live `/api/data`
> / storefront rendering.

---

## 3. CRITICAL open issues (must read)

### 3.1 Admin login is NOT functional on Production — Supabase is not configured
`GET /admin` renders **"Authentication Not Configured — Supabase credentials are
not set up. Please configure `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`."**

`GET /api/admin/diagnose` (no secrets) returns:
```json
{"rawEnvUrl":"(not set)","sanitizedUrl":"(empty)","urlIsValid":false,
 "anonKeyPresent":false,"serviceKeyPresent":false,"serverClientAvailable":false,
 "env":"production"}
```
➡️ **You cannot log in to the production Admin Panel** until the Supabase
environment variables are added in the Vercel project settings.

### 3.2 Store/admin DATA is NOT Supabase-backed — it is an ephemeral in-memory JSON store
- Supabase is used **only for admin authentication** (JWT verification). It is
  **not** the product/order data store.
- Products/orders are served from `lib/store.js`, an **in-memory JSON store**
  seeded from `data/velocci-db.json`.
- On Vercel serverless this is **ephemeral**: admin edits and new orders are
  kept only in a warm instance's memory, are **not persisted** to disk, reset to
  the committed seed on cold start, and can differ across concurrent instances.

➡️ Therefore the statements "storefront and Admin use the same live Supabase
data" and "change a product in Admin durably updates the storefront without a
commit" are **not currently true** for the deployed app. Durability requires
pointing `lib/store.js` at a real database (e.g. Supabase tables — see
`supabase-schema.sql`, `supabase-admin-setup.sql`).

---

## 4. What was verified vs. blocked

| # | Request | Status |
| --- | --- | --- |
| GitHub → Vercel → Production auto-deploy | ✅ Verified (this commit) |
| Production deployment succeeds | ✅ Verified (status `success`) |
| Storefront live + 117 products + categories + images | ✅ Verified |
| `/admin` has products/orders (login required) | ⛔ Blocked — Supabase not configured |
| Storefront + admin share live Supabase data | ⛔ Not true — data is in-memory JSON |
| Place test order → appears in admin | ⛔ Blocked — admin auth + durable store absent |
| Edit product in admin → updates storefront durably | ⛔ Blocked — admin auth + durable store absent |

---

## 5. Recommended manual steps to reach "fully working"

1. **Vercel → Project → Settings → Environment Variables** (Production), add:
   - `VITE_SUPABASE_URL` = `https://<project-ref>.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = `<anon key>`
   - `SUPABASE_SERVICE_ROLE_KEY` = `<service role key>` (server only)
   - `SESSION_SECRET` = a long random string
   Then redeploy.
2. In Supabase, run `supabase-schema.sql` + `supabase-admin-auth-setup.sql` and
   create the first admin user so `/admin` login works.
3. (For durable storefront data) migrate `lib/store.js` reads/writes to Supabase
   so orders/edits persist across serverless cold starts.
4. Re-run this checklist after the above.

---

## 6. 2026-09-14 15:38 UTC — Production re-deploy trigger + config hand-off

**Scope:** documentation only. No application code, no data, no Vercel project
settings, no storefront design/behaviour were changed by this commit. It exists to
(a) record the exact production configuration the deployment still needs and
(b) act as the push-to-`main` event that makes Vercel's GitHub integration build a
new **Production** deployment of `main`.

### 6.1 Pipeline state at trigger time

| Item | Value |
| --- | --- |
| Repository | https://github.com/3bromo/Vilocci (production branch: `main`) |
| Previously deployed production commit | `d99be2b` |
| Vercel team | `3bromos-projects` |
| Production URL used as reference | https://vilocci-b31u.vercel.app |
| Vercel projects linked to this repo (each builds `main` into Production) | `vilocci-b31u`, `velocciiiii`, `vilocciii3bro`, `vilocci-i54t`, `vilocci-pvpw`, `01a07cb5-b190-7e92-ac8e-aefc65395914-4` |

> Every push to `main` currently builds **all six** linked projects. Keeping only
> one project linked (Vercel → Project → Settings → Git → "Connected Git
> Repository" → Disconnect on the extras) is an operator decision; nothing was
> unlinked or deleted automatically.

### 6.2 Vercel environment variables still missing

Live probe of the deployed Production function —
`GET https://vilocci-b31u.vercel.app/api/admin/diagnose`:

```json
{"rawEnvUrl":"(not set)","sanitizedUrl":"(empty)","urlIsValid":false,"urlHasPath":"",
 "anonKeyPresent":false,"serviceKeyPresent":false,"serverClientAvailable":false,
 "publicDir":"/var/task/dist","distExists":true,"env":"production"}
```

`GET /api/admin/config` → `{"url":"","anonKey":""}` (browser side of the admin SPA).

| Variable | Scope | Value | Needed for |
| --- | --- | --- | --- |
| `VITE_SUPABASE_URL` | Production (all environments) | `https://<project-ref>.supabase.co` — root URL only, no trailing path/slash | admin HTML injection + server JWT verification |
| `VITE_SUPABASE_ANON_KEY` | Production | the project's **anon/public** key | browser sign-in (`/admin` login form) |
| `SUPABASE_SERVICE_ROLE_KEY` | Production, **server only** | the project's **service_role** key | `requireAdmin` guard, `/api/admin/*` |

Not required by the deployed code: `ADMIN_PASS`, `SESSION_SECRET` (legacy
password/session path is no longer used — admin auth is Supabase JWT only).
`SESSION_SECRET` is still listed in `.env.example`; it is inert.

Env-var changes only apply to a **new** deployment: after saving them, either push
to `main` or use Vercel → Deployments → `⋯` → **Redeploy** (enable "Override
Environment Variables" if offered).

### 6.3 Supabase SQL (run once, in Supabase → SQL Editor)

Requires the admin login to already exist in Supabase → Authentication → Users
(email confirmation temporarily off, or the user confirmed).

```sql
-- 1) schema + RLS + policies (idempotent)
--    run the whole of supabase-schema.sql, or at minimum the admin_users part:
create table if not exists public.admin_users (
  id uuid references auth.users(id) on delete cascade primary key,
  email text unique not null,
  full_name text,
  role text default 'admin',
  created_at timestamptz default now()
);
alter table public.admin_users enable row level security;
create or replace function public.is_admin()
returns boolean as $$
  select exists (select 1 from public.admin_users where id = auth.uid());
$$ language sql security definer stable;
drop policy if exists "Admin full access" on public.admin_users;
create policy "Admin full access" on public.admin_users
  for all using (public.is_admin()) with check (public.is_admin());

-- 2) link the admin account BY EMAIL (do not hardcode a uuid)
insert into public.admin_users (id, email, full_name, role)
select u.id, u.email, 'Admin', 'admin'
from auth.users u
where u.email = '3brosnfroo15@gmail.com'
on conflict (id) do update
  set email = excluded.email, full_name = excluded.full_name, role = excluded.role;

-- 3) must return exactly one row, otherwise /admin login will be rejected
select id, email, role from public.admin_users;
```

`supabase-admin-setup.sql` / `supabase-admin-auth-setup.sql` /
`supabase-migration-admin-user.sql` in the repo root insert the admin row with a
**hardcoded** uuid (`363fc336-…`); use them only if that uuid really matches the
auth user, otherwise use the block above.

### 6.4 Verification checklist after the production build goes Ready

```
GET /                        → 200, <title>SPINTO — Luxury Key Accessories for Your Car</title>
GET /api/data                → 200 JSON with settings/languages/brands/bundles/products (117 active products)
GET /css/admin.css           → 200 (static asset served by Vercel CDN from dist/)
GET /admin                   → 200 admin SPA; "Authentication Not Configured" until 6.2 is done
GET /api/admin/diagnose      → urlIsValid:true, anonKeyPresent:true, serviceKeyPresent:true, serverClientAvailable:true
GET /api/admin/data          → 401 {"error":"Unauthorized — no token"} when logged out
GET /data/velocci-db.json    → 404 (vercel.json blocks the datastore)
```

### 6.5 Known blocker found while verifying (reported, not changed)

`server.js` verifies the admin JWT with `sb.auth.admin.getUserByToken(token)`.
That method does not exist in the installed `@supabase/supabase-js@2.116.0`
(`typeof sb.auth.admin.getUserByToken === 'undefined'`), so the call throws a
`TypeError`, which the `catch` turns into `401 {"error":"Authentication failed"}`
for **every** admin API request — including `/api/admin/session`, which then
always answers `{"authenticated":false}`. Verified locally with
`VITE_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` set to valid-format values,
using a patched copy outside the repo: replacing the two call sites with
`sb.auth.getUser(token)` changes the response from "Authentication failed" to
"Invalid session" (i.e. the Supabase call is actually issued).

Consequence: `/admin` login cannot succeed in production until (1) §6.2 env vars
are set, (2) §6.3 SQL is run, **and** (3) these two lines are fixed. No code was
changed here, per the "do not modify the working site" instruction.

> **Update (2026-09-16):** the two call sites were since changed to
> `sb.auth.getUser(token)`; the blocker above is resolved in the code. Condition
> (1) §6.2 is still open — see §7.

---

## 7. Customize feature — what was verified, and what still needs production credentials

**Date:** 2026-09-16 (UTC)
**Scope:** the new `Customize` flow (storefront wizard + `Admin → Customize`),
migration `003_customize.sql`, the private photo bucket.

### 7.1 Verified LOCALLY (this is not a production verification)

| What | How | Result |
| --- | --- | --- |
| Migration `003` on a real PostgreSQL 18.4 | `npm run test:db` (embedded Postgres) | table + 29 columns, RLS enabled, `anon` cannot read (0 rows / no grant), `settings['customize']` seeded with all 3 existing categories, re-run is a no-op |
| Whole customer flow | `npm run test:customize` (jsdom drives `public/js/app.js`) | 5 steps, only admin-enabled categories, photo preview/replace, client-side validation, in-flight duplicate guard, submit payload, success message + request id, EN/AR + RTL |
| Whole admin flow | `npm run test:customize` (jsdom drives `public/js/admin-app.js`) + `npm run test:db` | ON/OFF per category + save, list/detail, photo through the authenticated endpoint, status, internal notes, delete with confirmation — persisted (in Postgres in `test:db`) |
| Availability is isolated | `npm run test:db` | disabling a category removes it from `/api/customize/categories` while `/api/data` still serves all 3 and `categories.active` is unchanged |
| Private photo | `npm run test:db` | row holds a bucket path or inline data — never a public URL; the admin list payload contains no photo bytes |
| Everything else | `npm test` | 221 checks green (smoke 39, admin auth 7, admin CMS 36, admin packages 48, fallback 36, customize 55) |
| Storefront render (served copy) | `curl http://127.0.0.1:3000/#/customize`-equivalent via jsdom on `public/` | wizard renders; `root/public/dist` copies byte-identical |

### 7.2 Verified on PRODUCTION after the deploy

```
GET /                              → 200 (storefront, unchanged)
GET /api/data                      → 200, payload now includes `customize`
GET /api/customize/categories      → 200, { available: true, categories: [...], contactMethods: [...] }
GET /api/admin/customize/...       → 401 without an admin token
```

### 7.3 NOT verified on production — blocked by missing Supabase credentials

`GET https://vilocci-b31u.vercel.app/api/admin/diagnose` (checked 2026-09-16):

```json
{"rawEnvUrl":"(not set)","sanitizedUrl":"(empty)","urlIsValid":false,
 "anonKeyPresent":false,"serviceKeyPresent":false,"serverClientAvailable":false,
 "dataDriver":"json","dataDriverActive":"json","dbUrlPresent":false,
 "publicDir":"/var/task/dist","distExists":true,"env":"production"}
```

The production project still has **no** Supabase environment variables, so:

- **Admin login is still impossible in production** (§6.2/§6.3 not done), which
  means `Admin → Customize Settings / Requests` cannot be exercised there.
- The store runs on the **JSON driver** (ephemeral on Vercel serverless):
  customization requests are not durable across cold starts, and car photos are
  kept **inline** in the row (`photoStored: "inline-fallback"`) instead of going
  to the private `customize-uploads` bucket. The private bucket, the signed-URL
  admin path and the RLS-protected `customize_requests` table are therefore
  **unverified against real Supabase** — they are only proven against a real
  PostgreSQL server locally (`npm run test:db`).

### 7.4 Operator checklist to finish production

1. Vercel → Project → Settings → Environment Variables: `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (`SUPABASE_DB_URL` for
   the migration CLI; the `CUSTOMIZE_*` variables are optional).
2. `npm run migrate -- --apply` (applies `003`, seeds `settings['customize']`
   from the existing categories and creates the private bucket).
3. Supabase → Storage: confirm `customize-uploads` exists and is **private**.
4. Redeploy, then re-run the §6.4 checklist plus
   `GET /api/customize/categories` and one end-to-end Customize submission from
   `Admin → Customize → Requests` (status change, internal note, delete).

---

## 8. Addendum 2026-09-17 — Customize was unreachable on the live site (fixed)

**Symptom.** The Customize flow was implemented and deployed, but the live
storefront showed **no Customize entry at all** — not in the header, not in the
mobile menu, not in the footer.

**Why the earlier "verified" claim was wrong.** §1 of this document names
`https://vilocci-b31u.vercel.app` as production. That project runs on the
**JSON fallback driver**, which *derives* the categories from the products, so
it reported 3 categories and the nav entry appeared. The real customer-facing
instance is the Supabase-backed one:

| Project | Driver | `/api/customize/categories` before the fix |
| --- | --- | --- |
| `vilocciii3bro.vercel.app` | `postgrest` (Supabase `zbqnkebsmhhemknpazme`) | `{"available":false,"categories":[]}` |
| `vilocci-b31u.vercel.app` | `json` fallback | 3 categories |
| `velocciiiii.vercel.app`, `vilocci-pvpw.vercel.app` | `json` fallback | 3 categories |

Verifying only the JSON-backed project hid the bug completely.

**Two independent causes, both fixed.**

1. `headerHTML()` pushed the entry only when the catalogue reported categories:
   `if (czCategories().length) navLinks.push([… '#/customize'])`. A primary
   customer flow must not depend on a data condition to appear. It is now
   pushed unconditionally (desktop `.nav`, mobile `.nav-mobile`, footer), and
   `czCategories()` falls back to the site's own categories instead of `[]`.
2. `lib/db.js getCatalog()` derived the categories from the products for the
   **JSON** driver only. The production database has the three `categories` rows
   written by the migration but **all switched off**, so the `postgrest` driver
   reported an empty catalogue. Note the RLS trap that makes this easy to
   misread:

   ```sql
   create policy "Public read active categories" on public.categories
     for select using (active = true);
   ```

   A read with the **anon** key returns `[]` for *both* "no rows" and "no active
   rows"; only the service role the server uses can tell them apart. The fix
   derives whenever **no stored category is active**, which covers both.

`/customize` also works as a direct path now (Vercel rewrite → `index.html`,
normalised into the existing hash route on boot), so there is still exactly one
implementation of the page.

**Verified on production after deploy** (`main` → `29821c0`, 6 Vercel
projects `success`):

- `GET https://vilocciii3bro.vercel.app/api/customize/categories` →
  `available: true`, Key Cases **59**, Key Holders **29**, Car Medals **29**.
- `GET https://vilocciii3bro.vercel.app/customize` → 200, the real 5-step flow
  (Choose → Photo → Car info → Your request → Your details) with the three
  categories and their real product counts.
- Storefront home unchanged: products, brands, fitment, packages, bundles,
  cart and InstaPay all render.
- `npm test`: **261 passed, 0 failed**, including the new
  `test/customize_nav.js`, which drives the real `postgrest` driver against a
  PostgREST stub for three shapes — empty table, all rows inactive (the live
  shape) and one category hidden by the admin — then the real
  `public/js/app.js` in jsdom for the nav, the categories and both routes.

**Not verified:** a visual/pixel check of the rendered header on the live
domain. The nav is asserted in the DOM by `test/customize_nav.js` against the
same `app.js` bytes that are deployed, and the deployed bundle was read back to
confirm the unconditional `navLinks.push`, but no browser binary is installable
in the verification sandbox.

**Operator follow-up (recommended, not required).** The three `categories` rows
in Supabase are still `active = false`. The app now derives them, so nothing is
broken, but switching them on in `Admin → Categories` would make the stored
rows the source of truth again and let the admin edit their names and images.

---

## 9. Addendum 2026-09-17 — Customize UI exposure (nav prominence + cache-buster)

**Report.** "Customize exists in code/API but cannot be found in the UI — not in
the public nav, not in the Admin Dashboard."

**Finding.** The implementation was already complete and deployed (§7/§8): the
header, mobile menu and footer all render a `Customize → #/customize` entry
unconditionally, `/customize` serves the 5-step flow, and the Admin sidebar has
a `Customize` group (`Customize Settings` + `Customize Requests`). No backend,
route, API, table, bucket or category-system change was needed, so none was
made. Two things made the feature easy to miss:

1. The header entry was a plain text link among six others — nothing drew the
   eye to the primary bespoke flow.
2. The §8 fix shipped without a cache-buster bump, so browsers/CDN could keep
   serving the pre-fix `app.js` (no `Customize` entry) under the same
   `?v=20260916b` URL.

**Change (UI exposure only, build `20260917a`).**

- Public site: the `Customize` desktop nav entry is now a gold pill
  (`.nav-customize`, `✦` marker via CSS only — link text and `#/customize`
  target unchanged); the mobile-menu entry is a highlighted gold-tinted row
  (`.nav-customize-m`); footer Quick Links unchanged. Position, order and all
  other nav items unchanged; the 5-step flow untouched.
- Admin: new `🎨 Customize — bespoke requests` quick-access card on the
  dashboard (new/total counts, enabled-categories count, buttons to both
  Customize screens via the existing global `[data-nav]` binding + store-page
  link). Sidebar group untouched.
- Cache-busters: `index.html` refs bumped `20260916b → 20260917a`;
  `admin.html` refs gained `?v=20260917a`. `root/public/dist` copies kept
  byte-identical (enforced by `test/customize.js`).
- No changes to products, packages, orders, checkout, InstaPay, categories,
  brands, admin auth, or any API/route/table.

**Verified locally.** `npm test`: **261 passed, 0 failed** (smoke 39, admin 7,
admin CMS 36, admin packages 48, fallback 36, customize 55, customize-nav 40)
against a local server. jsdom checks on the exact deployed bytes: desktop pill
and mobile entry render with `#/customize` and open the 5-step wizard; admin
sidebar group + badge + dashboard card render and the card buttons navigate to
both Customize screens.
