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
