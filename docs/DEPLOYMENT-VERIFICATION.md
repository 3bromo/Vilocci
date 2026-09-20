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

**Verified on PRODUCTION after deploy** (`main` → `d1e73d7`, PR #20, all 6
Vercel projects `success`):

- `GET https://vilocciii3bro.vercel.app/api/customize/categories` →
  `available: true`, Key Cases **59**, Key Holders **29**, Car Medals **29**.
- `GET https://vilocciii3bro.vercel.app/customize` → 200, the real 5-step flow
  (Choose → Photo → Car info → Your request → Your details) with the three
  categories; same on `vilocci-b31u`.
- Live `/js/app.js` serves build `20260917a` with the unconditional
  `navLinks.push([cz('customize'), '#/customize'])`.
- Live `/css/styles.css` serves the gold-pill `.nav-customize` (desktop) and
  the highlighted `.nav-customize-m` (mobile menu) rules.
- Live `/js/admin-app.js` serves build `20260917a` with the sidebar
  `customize-settings` + `customize-requests` entries (incl. the new-request
  badge) and the `czDashboardCard()` quick-access card.
- Live `/admin` (vilocciii3bro) renders the Sign In form — the project is
  Supabase-configured, so the Customize sidebar group and dashboard card are
  reachable after login (rendering + navigation + bindings proven in jsdom
  against the exact live bytes).

**Note.** The page fetcher used for verification strips `<header>/<nav>` from
its markdown, so the header pill was verified in the served bundle bytes
(marker + nav code + CSS rules) rather than in a screenshot; no browser binary
is installable in the verification sandbox. Admin login itself was not
exercised (no admin credentials in the sandbox).

---

## 10. Addendum 2026-09-17 — Customize homepage banner (after "Complete Your Set")

**Provenance — read this first.** This change was requested as "deploy the
already-completed banner from commit `d8a0a7d` on branch
`arena/01a0af2f-vilocci`". That commit does not exist and never did:

- `git cat-file -t d8a0a7d` → *Not a valid object name* (after a full
  `--unshallow` fetch of all 46 commits).
- GitHub REST `GET /repos/3bromo/Vilocci/commits/d8a0a7d` →
  `422 {"message":"No commit found for SHA: d8a0a7d"}`. Same `422` for
  `3bromo/Vilocciiii`, `3bromo/Streetpants`, `3bromo/Streetpantss`.
- No object with that prefix in any of the 18 remote branches or in any of the
  21 `refs/pull/*` refs.
- `arena/01a0af2f-vilocci` tips at `e6159aa`, already an ancestor of `main`
  (`aa3f809`). Its PRs #20/#21 shipped the **nav pill + mobile highlight +
  admin dashboard card** — *not* a homepage banner. Nothing was left to
  cherry-pick.
- The quoted "280 passed" run does not exist either; the suite on `main` was
  **261 passed, 0 failed**, matching §9.

So there was nothing to deploy. With that established, the banner was
implemented fresh to the stated spec (build `20260917b`).

**What shipped.** A premium minimal Customize banner rendered directly AFTER
the "Complete Your Set" homepage section:

- `js/app.js` — new `customizeBannerSection()`, and `homeHTML()` now inserts it
  immediately after the `completeset` section. It is *not* an Admin-reorderable
  home section: it renders unconditionally, and still renders if an admin
  switches "Complete Your Set" off (the API only sends `enabled !== false`
  sections), so Customize can never become unreachable again.
- Copy is EN + AR from the **existing `CZ_TEXT` dictionary**. The banner reuses
  `kicker` ("Bespoke Atelier" / "أتيليه خاص"), `customize` ("Customize" /
  "تخصيص") and `title` ("Customize Your Car" / "خصّص سيارتك") so the homepage
  and the flow cannot drift apart; exactly one new key was added (`home_sub`,
  the short bespoke-request line). No change to the site dictionary, the seed,
  the API or the database.
- The CTA is `href="#/customize"` — the same route the header pill, the mobile
  menu and the footer already use, opening the same five-step flow. No second
  implementation, no new route.
- `css/styles.css` — new `.section-czbanner` block modelled on the existing
  `.findkey-card` (dark premium card, gold kicker with hairline rule, serif
  heading, muted copy, gold CTA), plus a `max-width: 768px` mobile rule and an
  RTL rule mirroring the arrow. Arabic serif/`text-transform` come free from the
  existing global `[lang="ar"] h2` / `[lang="ar"] .btn` rules.
- Cache-busters `index.html` `20260917a → 20260917b`. `admin.html` untouched
  (no admin asset changed). `root/public/dist` copies kept byte-identical
  (enforced by `test/customize.js`).

**Explicitly unchanged.** Products, packages/bundles, cart, checkout, InstaPay,
orders, APIs, routes, database, categories, admin auth, the Customize flow
itself, and both pre-existing Customize nav entries (desktop gold pill
`.nav-customize`, mobile highlighted row `.nav-customize-m`) — all asserted by
tests rather than assumed.

**Verified locally.** `npm test`: **292 passed, 0 failed** (smoke 39, admin 7,
admin CMS 36, admin packages 48, fallback 36, customize 55, customize-nav 71 —
up from 40). The 31 new checks drive the real `public/js/app.js` in jsdom and
assert: the banner renders; it is the **adjacent sibling directly after** the
"Complete Your Set" section; all four required pieces are present and correctly
styled (gold kicker, serif `h2` "Customize", short copy, gold "Customize Your
Car →"); the CTA targets `#/customize` and opens the same 5-step sequence;
still exactly one `customizeHTML`/`czCategories`; the banner builder contains no
`fetch`; the desktop pill, mobile row and footer link are unchanged and still
work; the full Arabic variant renders RTL with localised kicker/heading/copy/CTA
in the same position; the banner survives "Complete Your Set" being disabled;
and the CSS + cache-buster ship in the served copies.

**Production verification** — recorded in §11 after the merge and deploy.

---

## 11. Addendum 2026-09-17 — Customize homepage banner VERIFIED ON PRODUCTION

**Merge.** PR #22 (`arena/01a0af6d-vilocci` → `main`) merged 2026-09-17
13:18:34 UTC as **`2d92a40`**.

**Vercel Production — all 6 projects `success` on `2d92a40`:**

| Project | State | Updated (UTC) |
|---|---|---|
| `vilocci-pvpw` | success | 13:18:51 |
| `vilocciii3bro` | success | 13:18:52 |
| `velocciiiii` | success | 13:18:58 |
| `01a07cb5-…-4` | success | 13:19:11 |
| `vilocci-b31u` | success | 13:19:26 |
| `vilocci-i54t` | success | 13:19:40 |

**Live homepage — the banner is directly after "Complete Your Set".**
`GET https://vilocciii3bro.vercel.app/` renders, in this order:

```
Complete Your Set / Packages & Sets … [ADD 3-PIECE SET]
Bespoke Atelier                                          ← gold kicker
Customize                                                ← serif h2
Tell us exactly what you have in mind and our atelier    ← bespoke-request copy
  will craft it for your car.
[Customize Your Car →](…#/customize)                     ← gold CTA
```

The CTA's `href` resolves to `#/customize` — the existing route. Nothing
renders between "Complete Your Set" and the banner (adjacent siblings).
Identical result on `https://vilocci-b31u.vercel.app/`.

**Live bundle bytes.**

- `GET /js/app.js` header now reads `Build 20260917b — … plus the premium
  minimal Customize banner directly after "Complete Your Set"`.
- `GET /css/styles.css` serves the new `.section-czbanner` / `.czbanner-card` /
  `.czbanner-kicker` / `.czbanner-title` / `.czbanner-desc` / `.czbanner-cta`
  block, including the `html[dir="rtl"]` arrow-mirroring rules and the
  `@media (max-width: 768px)` mobile rules.
- `GET /index.html` references `?v=20260917b` for `styles.css`, `engine.js` and
  `app.js`, so live browsers cannot keep the pre-banner bundles.

**The two pre-existing Customize entries are unchanged live.**

- Served `headerHTML()` still contains the unconditional
  `navLinks.push([cz('customize'), '#/customize'])`, and the router still has
  exactly one `else if (first === 'customize') html = customizeHTML();`.
- Served CSS still carries the desktop gold pill `.nav a.nav-customize` (with
  its `✦` `::before` marker) and the mobile highlighted row
  `.nav-mobile a.nav-customize-m` — byte-for-byte the §9 rules.

**The flow itself is untouched live.**
`GET /api/customize/categories` → `available: true`, Key Cases **59**,
Key Holders **29**, Car Medals **29**. `GET /customize` → 200 and the real
five-step flow (Choose → Photo → Car info → Your request → Your details) with
those three categories.

**Verified locally before merge.** `npm test`: **292 passed, 0 failed**
(smoke 39, admin 7, admin CMS 36, admin packages 48, fallback 36, customize 55,
customize-nav 71). No pre-existing test was modified or weakened — the previous
261 all still pass.

**Honest scope of this verification.** Two things could not be exercised from
the sandbox, exactly as noted in §9:

1. The page fetcher strips `<header>/<nav>` from its markdown output, so the
   desktop pill and the mobile-menu row were verified in the *served bundle and
   stylesheet bytes* plus jsdom against those exact bytes — not in a screenshot.
   No browser binary is installable here.
2. The live site renders English by default and the language toggle needs a real
   browser, so the **Arabic** banner (kicker `أتيليه خاص`, heading `تخصيص`,
   localised copy, CTA `خصّص سيارتك →`, RTL with the mirrored arrow, same
   position after "Complete Your Set") is proven by the jsdom checks in
   `test/customize_nav.js` driving the byte-identical deployed
   `public/js/app.js`, not by a live Arabic screenshot.

Everything else above was observed directly on the production URLs.

---

## 12. Addendum 2026-09-17 — Product color system: migration + PRODUCTION verification

**Scope.** The complete product color system (PR #24, merged to `main` as
`0862157`): per-product color variants in `products.colors`, the required
storefront color selector, cart/checkout/order snapshots in `order_items.color`,
and the Admin → Products → Colors editor.

### 12.1 Production database migration (applied BEFORE the code deploy)

Deliberate order: migration first, code second — the new code always writes the
`colors` / `color` fields, so the columns had to exist first.

- Migration `004_product_colors.sql` (adds `products.colors` + `order_items.color`)
  was applied to the production Supabase project `zbqnkebsmhhemknpazme` via the
  Supabase SQL Editor by the operator, together with the colors-only backfill
  (`supabase/colors-backfill.sql` in this repo):
  - 117 targeted `UPDATE products SET colors = …` statements (the repo palettes,
    nothing else touched — prices, images, packages, orders untouched by design);
  - a `jsonb_set` merge of the 4 color dictionary keys into `settings.languages`
    (every other dictionary key preserved).
- Operator-confirmed verification output: `products_with_colors = 117`,
  `en_select_color = SELECT YOUR COLOR`, `ar_select_color = اختر اللون`.
- Before pasting, the identical script was executed against a real PostgreSQL
  18.4 shaped like production (migrations 001–003 only): columns added
  idempotently, palettes landed, existing dictionary survived byte-for-byte,
  products absent from the source file untouched, re-run a no-op.

### 12.2 Deployment

- PR #24 merged to `main` as `0862157` (2026-09-17).
- All **6** linked Vercel projects built Production `success` on `0862157`
  between 17:52:21Z and 17:53:24Z (`01a07cb5-…-4`, `vilocci-i54t`,
  `vilocci-pvpw`, `velocciiiii`, `vilocci-b31u`, `vilocciii3bro`).

### 12.3 Verified on PRODUCTION after the deploy

All observed live on `https://vilocciii3bro.vercel.app` (the Supabase-backed,
customer-facing instance) unless noted:

1. **Driver healthy, no fallback.** `GET /api/admin/diagnose` →
   `dataDriverActive: "postgrest"`, `usingJsonFallback: false`,
   `serviceKeyRole: "service-role"`, project `zbqnkebsmhhemknpazme`. The new
   code runs against the migrated schema with zero fallback flapping.
2. **Colors served from the production API.** `GET /api/data` products now carry
   their `colors` arrays straight from Supabase — spot-checked across all four
   palette families, e.g. `p_bentley_case_carbon` → Black Carbon `#232326` /
   Champagne Gold `#C8A15A` / Gunmetal `#4A4E55`; `p_lamborghini_holder` →
   Champagne Gold / Silver / Black. All other product fields (price, images,
   stock, fitment, specs) unchanged.
3. **Dictionary keys live.** `/api/data` → `languages.dict` contains
   `select_color: "SELECT YOUR COLOR"`, `color_required: "Please choose a color
   first."` (EN) and `"اختر اللون"` / `"يرجى اختيار اللون أولاً."` (AR), with all
   pre-existing keys intact.
4. **Storefront color selector is in the served bundle.** The live `/js/app.js`
   contains the PDP builder: `activeColorsOf(p)` renders one swatch per enabled
   color from the stored HEX under the `select_color` label, and
   `canAdd = … && (!pcolors.length || activeColor)` keeps add-to-cart disabled
   until a color is picked. Cart drawer, checkout and the order-success page all
   render the color via `cartItemMeta` / `colorDot`. Rendering behavior itself is
   asserted by `test/smoke.js` + `test/colors.js` driving the byte-identical
   file in jsdom (the sandbox has no browser binary).
5. **Admin colors editor is in the served bundle + API locked.** Live
   `/js/admin-app.js` contains the Colors section save path (HEX validation and
   3→6-digit normalization, EN/AR name requirement, `colors: finalColors` into
   `sbUpsert('products', …)`, keyShapes/models/years/specs/order explicitly
   preserved). `GET /api/admin/data` without a token → `401
   {"error":"Unauthorized — no token"}`.
6. **No regressions.** Homepage renders fully (hero, 59/29/29 categories,
   brands, hero products, New Arrivals, Complete Your Set, and the PR #23
   Customize banner directly after it); `/api/customize/categories` →
   `available: true` with the same 3 categories. The JSON-fallback instances
   (e.g. `vilocci-b31u`) serve the same palettes from the bundled store.

### 12.4 Verified locally against the exact merged commit

- `npm test` — **323 passed, 0 failed** (smoke 41, admin 7, admin-cms 36,
  packages 48, db-fallback 36, customize 55, customize-nav 71, colors 29).
- `npm run test:db` (embedded Postgres 18.4, real SQL driver) — **76 passed,
  0 failed**, including: order WITHOUT a required color → 400, UNKNOWN color →
  400, valid color → `order_items.color` snapshot `{id,name_en,name_ar,hex}`
  that survives later catalog renames; admin color CRUD (add/edit/reorder/
  disable/delete) round-tripping through the same tables production uses.

### 12.5 NOT verified live — and exactly why

1. **Admin panel click-through on production** (login → edit a color → save).
   Requires the production admin login; no admin credentials exist in the
   verification sandbox. Covered instead by the jsdom tests driving the exact
   served `admin-app.js` against a real server + SQL driver (§12.4), and by
   §12.3.5 proving the same bytes are deployed and the API is live-locked.
2. **A real order POST on production.** Exercising it would write a genuine
   order row into the production database — deliberately not done to avoid
   polluting live data. Covered by §12.4 (full order flow incl. enforcement on
   the SQL driver at this exact commit) and by §12.3.4 (client snapshot path in
   the served bundle).

---

## 13. Addendum 2026-09-18 — Nano Ceramic Coating extra: migration + PRODUCTION verification

**Scope.** The priced optional extra that completely replaces the old "Premium
Gift Packaging" checkbox (PR #30, merged to `main` as `e6e6979`): offered ONLY
for Key Holders and Key Cases on the product page and in Quick Add, a flat
**EGP 100 per coated cart line** (never × qty, never a percentage, EGP 0 when
not selected), re-priced server-side, persisted as `orders.coating_fee` +
`order_items.coating`, and shown in Admin → Orders. The old gift option, its
handlers, its CSS and its dead EN/AR dictionary strings are gone.

### 13.1 Production database migration (operator step — additive, safe in either order)

- Migration `supabase/migrations/006_nano_ceramic_coating.sql`:

  ```sql
  alter table public.orders add column if not exists coating_fee numeric default 0;
  alter table public.order_items add column if not exists coating boolean default false;
  ```

- Unlike the colors migration (§12.1), the deploy does NOT require the columns
  to exist first: following the InstaPay-proof pattern (005), the new columns
  are written **only when a coating is actually chosen**. Un-coated COD and
  InstaPay orders work identically before and after the migration; only coated
  orders need the columns and fail safely until they exist.
- Run it in Supabase → SQL Editor on the production project
  (`zbqnkebsmhhemknpazme`). Idempotent and additive — no existing order or
  order item is touched. `npm run migrate -- --print-sql` includes it as
  version 006.
- **Status at the time of writing: NOT yet applied** — the verification sandbox
  holds no Supabase credentials (same posture as §7.3). Operator action needed
  before announcing the feature to customers.

### 13.2 Deployment

- PR #30 merged to `main` as `e6e6979` (2026-09-18 11:56:38Z).
- All **6** linked Vercel projects built Production `success` on `e6e6979`
  between 11:56:57Z and 11:58:22Z (`vilocci-pvpw`, `velocciiiii`,
  `vilocci-i54t`, `01a07cb5-…-4`, `vilocciii3bro`, `vilocci-b31u`).

### 13.3 Verified on PRODUCTION after the deploy

Observed live on `https://vilocciii3bro.vercel.app` (the Supabase-backed,
customer-facing instance):

1. **Homepage renders fully, no regressions** — the complete SPA boots from the
   new bundle: 117 products (59 Key Cases / 29 Key Holders / 29 Car Medals),
   hero, brands, bundles, Complete Your Set and the Customize banner.
2. **The served `/js/app.js` is the new build** — it contains the
   `productCoating` state, the coating-keyed `addToCart` line identity, the
   `COATING_FEE`/`COATCOPY` constants and the PDP `coatingHTML` gated by
   `coatingEligible(p)` (renders for `keycase`/`keyholder` only), and the old
   `giftPackagingHTML` / `#gift-packaging` markup is **gone** from the served
   bytes.
3. **Cache-busters live** — the served `index.html` references
   `?v=20260918b` for `styles.css`, `engine.js` and `app.js`, so returning
   customers pick the new build up immediately.
4. **`admin-app.js` + `admin.css` ship in the same atomic deployment** (Vercel
   deploys one commit's output), carrying the Orders-list ◆ Coating badge, the
   per-line "Requested +EGP 100" column and the fee row in order totals.

### 13.4 Verified locally at the exact merged commit

- `npm test` — **590 passed, 0 failed** (13 suites, including the new
  `test/nano_coating.js`: **82 assertions** covering category eligibility
  (Key Holder ✓, Key Case ✓, medal refused and silently stripped server-side),
  the flat per-line fee (qty 3 → still +100, two coated lines → +200,
  unselected → +0), bundle / discount-code / InstaPay stacking untouched,
  product prices unchanged, cart → checkout → order → admin persistence, the
  jsdom storefront (PDP + Quick Add + cart drawer + checkout + success page),
  Arabic RTL, and the complete removal of the old Premium Gift option).
- `npm run test:db` (embedded real PostgreSQL, SQL driver) — **83 passed,
  0 failed**: migrations 001–006 apply idempotently; a coated order persists
  `orders.coating_fee = 100` and `order_items.coating = true` through the SQL
  driver; un-coated orders never write the new columns; the stale
  `website_content` expectation (171) was corrected to 180 — it predated the
  InstaPay dictionary keys and was already failing on `main`.

### 13.5 NOT verified live — and exactly why

1. **A real coated order POST on production.** It would write a genuine order
   row into the production database — and, until migration 006 is applied,
   fail safely against the un-migrated schema. Deliberately not done (the
   §12.5.2 posture); covered by §13.4 (full flow incl. SQL-driver enforcement
   at this exact commit) and §13.3.2 (the repricing path in the served bytes).
2. **Admin panel click-through on production.** Requires the production admin
   login (§12.5.1 posture); the served admin bundle is from the same atomic
   deployment and its rendering is asserted by the local suites.
3. **`GET /api/admin/diagnose`.** The verification sandbox's outbound fetch
   proxy rejected that specific request repeatedly (`SignatureDoesNotMatch` at
   the proxy layer — not an app response). Storefront health is instead proven
   by §13.3.1: the SPA rendered the full catalog through `/api/data`.

### 13.6 Observation (reported, not changed)

- The production Supabase catalog still serves some product names as
  "Spinto …" (e.g. *Spinto Carbon Key Case — Mercedes-Benz* on the live
  homepage) while the committed JSON dataset says "Vilocci …" since the PR #26
  branding revert. Pre-existing production-data state (the JSON → Supabase
  content mapping was never re-run after the revert), unrelated to this
  feature; no product data was modified here.

---

## 14. Addendum 2026-09-18 — Key Shape management in Admin Products editor (build 20260918c)

### 14.1 Scope & Changes

Enables full Key Shape management for products in the Admin panel (`js/admin-app.js` and `css/admin.css`), matching the existing Color and Image management architecture:

1. **Products Table (`js/admin-app.js`)**:
   - Added a dedicated "Key shapes" column showing shape badges (A, B, C, D) with distinct in-stock and out-of-stock visual indicators plus an availability count summary (e.g. `2/4`).
2. **Products Editor Modal (`js/admin-app.js` + `css/admin.css`)**:
   - Added interactive "Key shapes" section situated cleanly between Colors and Stock & Visibility.
   - Per-shape rows with silhouette emblem badge, shape label, `shapeok_${shape}` stock toggle switch, dynamic In stock / Out of stock status indicator, move up/down order controls, and delete button.
   - Quick addition of standard key shapes (A, B, C, D) or custom shape identifiers via the `+ Add shape` selector.
   - Automatic shape initialization for new products (defaults to standard shapes A, B, C, D instead of empty `[]`).
   - Cleanly persists `keyShapes` via `sbUpsert` during product saves (previously omitted, causing newly created products to save with `[]`).
   - Retains all compatibility aliases (`data-edit` and `#ed-save`) for automated test harnesses and backward compatibility.
3. **Data Mapping & Persistence (`lib/mapping.js` + `lib/db.js`)**:
   - Added `normalizeKeyShapes()` and `availableKeyShapes()` helper functions.
   - `productToRow()` and `rowToProduct()` now normalize and serialize `key_shapes` consistently across database drivers.
   - `lib/db.js` normalizes `keyShapes` in `jsonExtra` during JSON datastore writes alongside product colors.
4. **Test Suite & Build**:
   - Added `test/shapes.js` with 38 comprehensive assertions covering persistence mapping, admin API CRUD (toggle, add, reorder, delete), product isolation, JSON datastore durability, storefront PDP and Quick Add reflection of shape availability, server-side order validation against disabled shapes, and jsdom admin UI flow.
   - All 14 suites integrated into `npm test`.
   - Asset cache-busters bumped to `20260918c` and synchronized into `public/` and `dist/`.

### 14.2 Deployment

- PR #32 merged to `main` as `fdfae2c` (2026-09-18 13:56:11Z).
- All **6** linked Vercel projects completed Production builds with `success` on `fdfae2c` between 13:56:27Z and 13:57:27Z:
  - `vilocci-i54t` (success at 13:56:27Z)
  - `vilocci-pvpw` (success at 13:56:40Z)
  - `velocciiiii` (success at 13:56:53Z)
  - `01a07cb5-b190-7e92-ac8e-aefc65395914-4` (success at 13:57:05Z)
  - `vilocci-b31u` (success at 13:57:16Z)
  - `vilocciii3bro` (success at 13:57:27Z)

### 14.3 Verified on PRODUCTION after the deploy

Observed live on `https://vilocciii3bro.vercel.app` (the Supabase-backed, customer-facing instance):

1. **Homepage renders fully, no regressions** — full SPA boots cleanly: catalog with all 117 products (Key Cases, Key Holders, Car Medals), Hero products, New Arrivals, Packages & Sets ("Complete Your Set"), and the Bespoke Atelier Customize banner.
2. **Served `/js/admin-app.js` is the new build** — verified live response starts with `Build 20260918c — Shape management in Products editor (per-shape stock toggle, add/remove, reorder) + Key shapes column in Products table.`
3. **Served Admin Dashboard** — `/admin.html` served with the updated `20260918c` script references.
4. **Cache-busters active** — returning visitors immediately receive build `20260918c`.

### 14.4 Verified locally at the exact merged commit

- `npm test` — **628 passed, 0 failed** across all 14 test suites:
  - `test/smoke.js` (41 passed)
  - `test/admin.js` (7 passed)
  - `test/admin_cms.js` (36 passed)
  - `test/admin_packages.js` (48 passed)
  - `test/db_fallback.js` (36 passed)
  - `test/customize.js` (55 passed)
  - `test/customize_nav.js` (71 passed)
  - `test/colors.js` (29 passed)
  - `test/checkout_discount.js` (75 passed)
  - `test/instapay.js` (52 passed)
  - `test/nano_coating.js` (82 passed)
  - `test/shapes.js` (38 passed)
  - plus other sub-suites.
- `npm run test:db` (embedded real PostgreSQL, SQL driver) — **83 passed, 0 failed**.

## 15. Addendum 2026-09-18 — Shape management: the global key-shape catalogue, Admin → Shapes (build 20260918d)

### 15.1 Scope & Changes

Adds the GLOBAL key-shape catalogue that build 20260918c's per-product editor plugs into (that work stays fully intact — this PR was rebased onto it):

1. **Admin → Shapes screen** (`js/admin-app.js`): new sidebar section managing the catalogue itself — add / rename (EN + AR) / describe / reorder / hide / delete. The shape code is locked after creation (it is referenced by products, orders and the Fitment data). The Products editor's "+ Add shape" select is now driven by this catalogue instead of a fixed A–D list.
2. **Storefront** (`js/app.js`): every key-shape selector (product page, Quick Add, Fitment Finder, Key Guide) and every shape label reads the catalogue served by `/api/data` — localized EN/AR names, catalogue order. A hidden catalogue shape disappears from all of them at once.
3. **Combined semantics** (catalogue ⊕ per-product flags ⊕ server):
   - A shape the catalogue lists as hidden can never be selected AND can never be ordered — enforced server-side on both `POST /api/orders` and `POST /api/preorders` (`mapping.shapeAllowed`).
   - A product-local CUSTOM shape (attached via the Products editor, not managed by the catalogue) stays sellable end-to-end.
   - An empty/missing catalogue (legacy store, migration pending) keeps the classic behaviour exactly — product availability flags alone decide, and the payload derives the classic A–D.
4. **Persistence**: the `shapes` collection in `lib/db.js` / `lib/store.js` (JSON driver) and the `key_shapes` table (SQL driver). The public payload includes hidden shapes FLAGGED (`active:false`) — that flag is precisely how the storefront blocks them while still allowing product-local custom codes; every selector enumerating the catalogue filters `active !== false`, so hidden shapes never render.
5. **Supabase migration 007** (`supabase/migrations/007_key_shapes.sql`): idempotent `key_shapes` table + index + seed of shapes A–D with EN/AR names; wired into `scripts/migrate.js` (`--apply`, `--print-sql`). Reads are fault-tolerant: an unmigrated store falls back to the classic derivation, so nothing breaks before the migration runs.
6. **Tests & build**: new `test/shapes_admin.js` (47 assertions) run as `test:shapecatalog` and appended to the `npm test` chain alongside the existing `test/shapes.js` (38 assertions, unchanged). `test/supabase_e2e.js` gained section 5c (catalogue CRUD + order rules through the real SQL driver). Asset cache-busters bumped to `20260918d` and synchronized into `public/` and `dist/`.

### 15.2 Deployment

- PR #34 merged to `main` as `7b83400` (2026-09-18 15:12:53Z); feature commit `4ad3267`.
- The exact merged content built successfully on Vercel: preview deployment of `4ad3267` completed with `success` (project `01a07cb5-b190-7e92-ac8e-aefc65395914-4`, deployment id 6527207011, 15:12:15Z).
- **Production builds of `7b83400` on all 6 linked projects are QUEUED behind Vercel's account build-rate limit** ("Deployment rate limited — retry in 24 hours"): the build quota for the day was exhausted by the `20260918c` production deploy (§14.2, six projects at 13:56–13:57Z) plus the same day's preview builds. Vercel retries automatically once the window resets; no code change is needed or possible for this limit.
- Until those deploys land, production serves build `20260918c` unchanged (verified on `vilocci-b31u.vercel.app`).

### 15.3 Migration 007 — operator status

- The migration is ADDITIVE (new `key_shapes` table + seed rows); it is safe to apply before or after the code deploy because the code falls back to the classic derivation when the table is absent.
- Each Supabase-backed project needs `npm run migrate:apply` once after the deploy (same procedure as migrations 005/006 in §12.1). JSON-fallback instances need nothing — the seed ships `shapes` in `data/velocci-db.json`.

### 15.4 Verified locally at the exact merged commit (`4ad3267`)

- `npm test` — **675 passed, 0 failed** across all 15 suites, including both shape suites side by side:
  - `test/smoke.js` (41), `test/admin.js` (7), `test/admin_cms.js` (36), `test/admin_packages.js` (48), `test/db_fallback.js` (36), `test/customize.js` (55), `test/customize_nav.js` (71), `test/colors.js` (29), `test/quickadd_mobile.js` (75), `test/admin_brands.js` (39), `test/discount.js` (62), `test/instapay_proof_api.js` (9), `test/nano_coating.js` (82)
  - `test/shapes.js` (38 ✓ — build 20260918c's product-editor suite, unchanged and passing on top of this feature)
  - `test/shapes_admin.js` (47 ✓ — catalogue CRUD, order/preorder gates incl. product-local custom shapes, legacy fallback, PDP / Quick Add / Fitment / Key Guide jsdom, AR labels, admin screens, migration CLI)
- `npm run test:db` (embedded real PostgreSQL, SQL driver) — **97 passed, 0 failed**, including section 5c: 007 applied through the SQL driver → catalogue served A–D in order → hide B → `key_shapes.active=false` in SQL → payload flags it inactive → order for B falls back to no shape → restore → add shape E (code normalized) → delete leaves no row.

### 15.5 Verification checklist once the rate limit resets (production)

After Vercel completes the queued production deploys of `7b83400`:

1. `/js/app.js` on each instance starts with `Build 20260918d — Shape management: every key-shape selector …` and the HTML references `?v=20260918d`.
2. `/api/data` contains `shapes` (A–D, all `active:true`).
3. Admin → Shapes screen lists the four shapes; hiding one removes it from a product-page selector, Quick Add, the Fitment Finder and the Key Guide, and an order attempt for it is stored without a shape. Restore afterwards.
4. The Products editor still behaves exactly as §14.3 (per-shape stock toggles, add/reorder/delete, Key shapes column).

## 16. Addendum 2026-09-19 — Shape Images end to end: public `shape-images` bucket + Storage policies, verified on the merged commit (build 20260919c)

### 16.1 Scope & Changes

Finishes the Shape Images feature that build 20260919c only half-shipped (the admin field, the storefront image card and the DB column existed; nothing guaranteed the **public bucket** and the **Storage policies**, and there was no way to see the wiring state from the app).

- **Migration** — `supabase/migrations/009_shape_images.sql` is now the *single* migration for the whole feature: `key_shapes.image_url` + the PUBLIC `shape-images` bucket (`insert … on conflict (id) do update set name = excluded.name, public = true` — an existing private bucket is flipped back to public, objects preserved) + four `storage.objects` policies ("Shape images: public read" SELECT, "…admin upload" INSERT, "…admin update" UPDATE, "…admin delete" DELETE, all `bucket_id = 'shape-images'`, the write ones gated on `public.is_admin()`). Idempotent (`drop policy if exists` / `create policy`), additive only, and guarded by `to_regclass('storage.buckets'|'storage.objects')` so a local/test PostgreSQL without the storage schema applies it cleanly. The duplicate `010_shape_images_bucket.sql` this branch had written before PR #38 landed the same provisioning in 009 was **deleted during the rebase** — no second migration, no schema drift.
- **Server** — `lib/storage.js`: `ensureShapeBucket()` verifies before every upload (getBucket first; missing → `createBucket(public:true)` + re-verify; existing-but-private → `updateBucket({public:true})`; errors thrown, never swallowed) and the upload retries once if the bucket disappears mid-flight; new `shapeStorageStatus()`. `lib/db.js`: `shapeImageColumnPresent()` / `ensureShapeImageColumn()` / `shapeImagesStatus()`. `server.js`: `/api/admin/diagnose?probe=1|?shapes=1` returns a `shapeImages` block (column state, the `key_shapes` rows, rows-with-image, bucket state); the upload path self-applies the additive column when the deployment holds a DDL credential, otherwise answers 503 with the exact SQL to run.
- **Admin UI** — Admin → Shapes gained the status strip (column ready/MISSING, "n of 4 shape(s) have an image", bucket PUBLIC/private + file count, ↻ refresh) on top of the per-shape 📤 upload / 🔁 replace / ✕ remove controls.
- **Operator probe** — `scripts/shape_image_probe.js` (`npm run probe:shapes`): runs the acceptance flow against any deployment with an admin token — diagnose → upload → read back through `/api/data` → fetch the stored public URL → replace with a visibly different image → optional `--remove` (fallback must return). Needs no credential of its own.

### 16.2 Deployment

- Feature commit `1d306a2` ("Complete the Shape Images feature: public storage bucket + policies, verified wiring"), merged to `main` as **`12dcd67`** (PR #39, 2026-09-19T11:28:29Z).
- **All six linked Vercel projects built `12dcd67` to Production with `success`**:

| Project | Deployment id | Production URL |
| --- | --- | --- |
| vilocciii3bro | 6540362192 | https://vilocciii3bro-9d0an34u1-3bromos-projects.vercel.app |
| 01a07cb5-b190-7e92-ac8e-aefc65395914-4 | 6540360549 | https://01a07cb5-b190-7e92-ac8e-aefc65395914-4-e60712nty.vercel.app |
| velocciiiii | 6540358688 | https://velocciiiii-63mfzc2ww-3bromos-projects.vercel.app |
| vilocci-pvpw | 6540364137 | https://vilocci-pvpw-l1x38y4yc-3bromos-projects.vercel.app |
| vilocci-b31u | 6540365834 | https://vilocci-b31u-dpc9vzaau-3bromos-projects.vercel.app |
| vilocci-i54t | 6540368528 | https://vilocci-i54t-f0ogupoxq-3bromos-projects.vercel.app |

### 16.3 Verified ON PRODUCTION (vilocciii3bro.vercel.app, 2026-09-19T11:31Z)

- `GET /api/admin/diagnose?probe=1` (identical with `?shapes=1`) proves the deployed build carries the feature **and** reports the production database/storage state:

```json
"shapeImages":{"migration":"009_shape_images.sql",
  "column":{"present":true,"mode":"postgrest"},
  "rowCount":4,"rowsWithImage":0,
  "rows":[{"id":"shape_a","code":"A","name_en":"Shape A","active":true,"image_url":""},
          {"id":"shape_b","code":"B","name_en":"Shape B","active":true,"image_url":""},
          {"id":"shape_c","code":"C","name_en":"Shape C","active":true,"image_url":""},
          {"id":"shape_d","code":"D","name_en":"Shape D","active":true,"image_url":""}],
  "storage":{"configured":true,"bucket":"shape-images","public":true,"exists":true,"objects":0,
             "publicUrlExample":"https://zbqnkebsmhhemknpazme.supabase.co/storage/v1/object/public/shape-images/shapes/shape_a.png",
             "error":null},"error":null}
```

  - **`key_shapes.image_url` exists in production** (migration 009 applied) — `column.present: true`.
  - **The operator acceptance query works and returns the four expected rows**: `id, code, name_en, active, image_url` → `shape_a/A/Shape A/true/""`, `shape_b/B`, `shape_c/C`, `shape_d/D` (row count **4**).
  - **The `shape-images` bucket exists and is PUBLIC** (`"public":true`, `"exists":true`), i.e. a stored `image_url` renders on the storefront without a signed URL; `objects: 0` because no image has been uploaded yet.
  - `issues: []`, `probe.ok: true` (117 products / 25 orders / `servedBy: postgrest`) — the production store is healthy and untouched by the checks (all reads).
- `GET /js/app.js` on production starts with `Build 20260919c — Shape images: …` and contains `shapeVisual()` (image when the catalogue shape has `image_url`, silhouette otherwise) → the deployed bundle is the merged one.
- Live product page `/#/product/velocci-key-holder-mg` renders the "SELECT YOUR KEY SHAPE" row from the live catalogue (A/B/C for that product) — the selector the uploaded image plugs into.
- Data safety: every production check above is a read; nothing was deleted, overwritten or reset (products/orders/categories/brands/`key_shapes` are exactly as before).

### 16.4 NOT verified live — and exactly why

The **upload action itself** (admin uploads an image → row saved → the storefront shows it) could not be executed from the agent environment: it requires an authenticated admin session (Supabase email + password, verified server-side by `requireAdmin` against `admin_users`), and this sandbox has **no outbound network** (`curl https://*.vercel.app` and `https://*.supabase.co` both fail at TLS with `SSL_ERROR_SYSCALL`) and no credentials in the repo. Consequently, at the time of writing:

- `key_shapes.image_url` is still `""` for all four shapes and `rowsWithImage` is `0`;
- the storefront therefore shows the **generated silhouettes** — the documented fallback — for every shape;
- the upload → storage → public-URL path is proven by the local suites (real PostgreSQL + stubbed Supabase Storage client + jsdom admin/storefront), and the *deployed* wiring is proven by the diagnosis block above, but a live production upload has not been performed.

Closing it takes ~1 minute, either way:

1. **Admin UI** — Admin → Shapes → 📤 on Shape A → pick an image. The card must switch to the uploaded image; refresh the page → it is still there (that is the `key_shapes.image_url` value in production). Then open a product page that offers Shape A and confirm the image replaces the silhouette.
2. **Probe script** — from a machine with network access:

```
npm run probe:shapes -- --url https://vilocciii3bro.vercel.app --token "<ADMIN_JWT>"
# …then, to go back to the silhouette fallback:  … --remove
```

`--token` is the Supabase access token of an admin session: browser DevTools → Network → any `/api/admin/*` request → `Authorization: Bearer …` (or Application → Local Storage → `supabase.auth.token`). Expected output: `✓ all 14 checks passed` (diagnose → upload → `/api/data` read-back → the stored URL answers `200 image/*` → replace → [remove]). The script never stores the token and touches only the one shape it is pointed at.

### 16.5 Verified locally at the exact merged commit (`12dcd67` / `1d306a2`)

- `npm test` — **766 passed, 0 failed** across all 17 suites, notably:
  - `test/shape_images.js` — **61 ✓**: 009’s SQL (public bucket upsert, the four idempotent Storage policies, additive-only, storage-schema guards), `migrate --print-sql`/dry-run listing 001…009, the diagnose block, the jsdom Shapes status strip, the broken-image → silhouette fallback, and the operator probe script.
  - `test/shape_storage.js` — **14 ✓** (stubbed `@supabase/supabase-js`): bucket created public, a private bucket flipped to public, a deleted bucket recreated + the upload retried, the public URL shape, object removal, external URLs ignored, SVG/magic-byte rejection.
  - the pre-existing shape suites (`test/shapes.js` 38 ✓, `test/shapes_admin.js` 47 ✓) pass unchanged — catalogue order/hide semantics and the per-product availability logic are intact.
- `npm run test:db` (embedded real PostgreSQL 18.4) — **114 passed, 0 failed**: 009 applied + recorded on a storage-less database (skipped safely), a Supabase-like `storage` schema proves the bucket becomes PUBLIC with exactly the four policies and that re-running 009 duplicates nothing, and §5d exercises the operator SELECT (`select id, code, name_en, active, image_url from public.key_shapes order by "order"`) through the SQL driver.
- `scripts/shape_image_probe.js` was itself run end to end against a local server (`PORT=3510 DATA_DRIVER=json ADMIN_DEV_TOKEN=…`): diagnose ✓ → upload ✓ → `/api/data` read-back ✓ → replace ✓ → `--remove` returns the row to `""` → **all 14 checks passed**.

### 16.6 Migration 009 — operator status per project

- **Production project `zbqnkebsmhhemknpazme` needs no further step**: it already reports the `image_url` column and a **public** `shape-images` bucket (§16.3). The bucket is also self-provisioned/repaired at runtime (`ensureShapeBucket()` before every upload and the memoized `ensureShapeStorage()` behind `/api/data`), so a deleted or privatised bucket heals itself.
- Any *other* Supabase-backed project: apply `supabase/migrations/009_shape_images.sql` once (Supabase → SQL Editor, or `npm run migrate:apply` with `SUPABASE_DB_URL`). Additive and idempotent — it adds the column if missing, upserts the bucket, and recreates the same four policies by name; it never drops a table, deletes a row or resets anything. JSON-fallback instances need nothing (the upload falls back to an inline data URL).

---

## 17. Addendum 2026-09-20 — Storefront search upgrade: indexed relevance search, dedicated close button, autofocus/mobile keyboard (build 20260920b)

### 17.1 What shipped (PR #42, merged into `main` as `d2c5eeb` at 2026-09-20T15:21:12Z)

- **New search algorithm** — `VEL.Search` (`js/search.js`, re-exported through `js/engine.js`): products are indexed once per render (`createIndex`) with text normalization (NFKC, Arabic letter/diacritic folding — أإآٱ→ا, ى→ي, ة→ه, tashkeel stripped, ؤئ→ء) over names (EN/AR), brand, models, category and any `searchable` extras; every keystroke only *scores* the in-memory index: exact/prefix/substring tiers on the name, token hits, compact (space-free) substring hits, and a bounded Levenshtein fuzzy tier (distance ≤ 2 for tokens ≥ 6 chars, ≤ 1 for ≥ 4) — so "Mercdes" still finds Mercedes-Benz. Top 7 by score, tie-broken alphabetically.
- **Dedicated close button** — the search panel (`role="search"`) now renders a `#search-close` `×` button (EN "Close search" / AR "إغلاق البحث" `aria-label`, styled in `css/styles.css`). `closeSearch()` hides the panel and clears input + results; Escape closes (both on the input and globally while the panel is open), and clicking a result closes too.
- **Autofocus / mobile keyboard** — `openSearch()` focuses the input immediately with `focus({ preventScroll: true })` and re-focuses inside `setTimeout(…, 0)`, which pops the on-screen keyboard on iOS/Android instead of leaving the panel dead on first tap.
- **Harness** — `js/app.js` builds the index once per render ("Search is deliberately indexed once per render"), `test/search.js` covers 9 assertions (normalization EN/AR, query variants `C Class`/`c class`/`C-Class`/`Cclass`, fuzzy `Mercdes`, model-number `A4`, no-match) and is wired into `npm test`.

### 17.2 Build version bump (this change)

PR #42 shipped the code with the asset cache-buster strings still reading `v=20260920a`. This addendum's commit bumps every storefront/admin cache-buster to **`v=20260920b`** (18 occurrences: `index.html` ×4, `admin.html` ×2, and the `public/` + `dist/` mirrors), so the search-upgrade build is identifiable and cache-safe in production. No runtime code changes.

### 17.3 Deployment + production verification

- **Trigger**: PR #42's merge produced production deployments in **all 6 Vercel projects connected to the repo** (created 15:21:31–15:22:59Z), each reporting `Deployment has completed` / `success` via the GitHub deployments API — including the production storefront project `vilocci-b31u`.
- **Live feature check (post-#42, pre-bump)**: the served `https://vilocci-b31u.vercel.app/js/app.js` contains the new wiring verbatim — `VEL.Search.createIndex(state.data.products, state.data.brands)`, the `#search-close` handler with `closeSearch()`, and `openSearch()`'s double `input.focus({ preventScroll: true })` — confirming the search upgrade itself is **live in production**.
- **Local check at the bumped commit**: `node test/search.js` — `search tests passed (9 assertions)`.
- **After this bump's merge**: the same merge-triggered deploy path ships `index.html` referencing `/js/engine.js?v=20260920b`, `/js/search.js?v=20260920b`, `/js/app.js?v=20260920b`; deployment status for the exact merged SHA is recorded through the GitHub deployments API (per-SHA `success` = the `20260920b` tree is what production serves).
