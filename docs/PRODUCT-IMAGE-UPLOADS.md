# Product images — the admin media library, uploads, and the Supabase/Vercel setup

**Feature:** Admin → Products → add/edit → **Images** → **🖼️ Add image** opens the admin's
**existing media library** (Admin → *Website Images*) as a chooser. Select an image and its
URL populates the product gallery immediately, with its preview — no URL is ever typed. The
picker stays open, so several images can be added one after another; **📷 Upload a new
photo** inside the picker saves a new image *into that same library* (so every product can
reuse it) and adds it to the product.

This document is the **complete** list of what must exist in Supabase and in Vercel for the
uploads behind that picker to be stored durably, how to verify it in under a minute, and what
to do when a check fails. Nothing here is optional for production except the items explicitly
marked *optional*.

> Selecting an image that is **already in the library needs no configuration at all** — it
> works on any host, because it only writes a URL into `products.images`. The setup below is
> what makes **new uploads** durable.

---

## 1. Where an image comes from, and where it is stored

**A. Selecting from the library** (the default path): `website_images.url` → the product's
`images[]`. Nothing is uploaded, nothing to configure.

**B. Uploading a new photo from the picker** — `js/admin-app.js` → `uploadImageToLibrary()`:

1. `POST /api/admin/upload` — the library's own endpoint (the same one Admin → Website Images
   and the brand-logo upload use). Writes `/img/uploads/<file>` and returns its URL.
2. If that fails (Vercel's read-only filesystem answers `507`), it falls back to
   `POST /api/admin/products/image` → `lib/storage.js` → **Supabase Storage**.
3. Whichever answered, the URL is inserted as a `website_images` row (the library grows) and
   added to the product gallery.

`POST /api/admin/products/image` storage order:

| Order | Where the photo goes | When | Durable on Vercel? |
| --- | --- | --- | --- |
| 1 | **Supabase Storage, PUBLIC bucket `product-images`**, object `products/<productId>-<unique>.<ext>`. The product row keeps the returned public URL in `products.images` (+ the normalized `product_images` children), and the library keeps it in `website_images`. | `VITE_SUPABASE_URL` **and** `SUPABASE_SERVICE_ROLE_KEY` are set | ✅ **yes — this is the production path for new uploads** |
| 2 | `/img/uploads/<file>` on the app's own disk | Storage not configured, disk writable (local `npm start`) | ❌ no (Vercel's filesystem is read-only) |
| 3 | inline `data:` URL stored with the product (≤ 512 KB) | Storage not configured **and** disk read-only | ⚠️ survives only as long as the data store does, and bloats every `/api/data` payload |

So on Vercel: **selecting library images always works**, but *new uploads* need
`SUPABASE_SERVICE_ROLE_KEY` — without it they fall back to a small inline data URL (fallback
3), which is not what you want in production.

Validation is the same as every other upload in this project (`lib/storage.js`):
real image bytes only (magic-number check), JPG/PNG/WebP/HEIC/AVIF, **SVG is rejected**,
max `CUSTOMIZE_MAX_IMAGE_BYTES` (default 6 MB). The browser shrinks a big phone photo first
(JPEG, longest edge 1600 px, quality 0.85; one tighter retry at 1200 px / 0.72) and refuses
anything still above ≈3 MB, because **Vercel caps a serverless request body at 4.5 MB**.

**No database table changes are needed.** `products.images` (`text[]`) and `product_images`
already exist (migrations `001`/`002`), which is why every existing product and every
existing image URL — generated `/img/asset.svg` artwork, pasted `https://…` URLs,
`/img/uploads/…` files — keeps working untouched.

---

## 2. Supabase — what to add

### 2.1 Keys (Project Settings → API)

Copy these three; they are the values for the Vercel variables in §3:

| Copied from Supabase | Becomes the Vercel variable |
| --- | --- |
| Project Settings → API → **Project URL** (`https://<ref>.supabase.co`) | `VITE_SUPABASE_URL` |
| Project Settings → API → **anon / public** key | `VITE_SUPABASE_ANON_KEY` |
| Project Settings → API → **service_role** key (secret) | `SUPABASE_SERVICE_ROLE_KEY` |

> Paste the keys with no trailing spaces, quotes or smart characters. A key containing a
> character that cannot be sent in an HTTP header (a pasted bullet `•`, anything above
> U+00FF) is detected at boot and reported by `/api/admin/diagnose` as
> `serviceKeyIssue` / `anonKeyIssue` — the app then falls back to the JSON store.

The **service_role** key is what allows the server to create/verify the bucket and write
objects. It is server-side only: it is never sent to the browser (`/api/admin/config`
returns the URL + anon key only).

### 2.2 Admin login (needed to reach the product editor at all)

1. **Authentication → Users → Add user** → email + password, *Auto Confirm User* on.
2. Register that user as an admin. Run in **SQL Editor** (replace the UUID and email with
   yours — copy the UUID from Authentication → Users):

```sql
-- creates admin_users + is_admin() + RLS if they are missing, then links your user
\i supabase-admin-auth-setup.sql   -- or paste the file's contents into the SQL Editor

insert into public.admin_users (id, email, full_name, role)
values ('<YOUR-AUTH-USER-UUID>', '<you@example.com>', 'Admin', 'admin')
on conflict (id) do update set email = excluded.email, role = excluded.role;

select id, email, role from public.admin_users;
```

The repo ships `supabase-admin-auth-setup.sql` and `supabase-migration-admin-user.sql` with a
previously used UUID/email — **replace them with your own** or the admin login will answer
*Not an admin user* (HTTP 403 on every `/api/admin/*` call, including the upload).

### 2.3 Database schema + the product-images bucket

Product images need **no column**, only the public bucket. Two ways, pick one:

**(a) Automatic — do nothing.** The first upload creates `product-images`, forces it
`public = true`, and retries once if the bucket vanished (`lib/storage.js` →
`ensureProductBucket()`), using the service_role key. This is the path the tests cover.

**(b) Explicit — run the migration** (recommended for a fresh project, so the bucket and its
policies exist before anyone uploads). In **SQL Editor**, run in order:

| File | Version | Needed for product images? |
| --- | --- | --- |
| `supabase-schema.sql` | `001` | yes — baseline tables, `is_admin()`, RLS |
| `supabase/migrations/002_cms_core.sql` | `002` | yes — `product_images`, `product_prices` |
| `003` … `008` | | for Customize / colors / InstaPay / shapes (unaffected by this feature) |
| `supabase/migrations/009_shape_images.sql` | `009` | only for *shape* images |
| **`supabase/migrations/010_product_images.sql`** | **`010`** | **the public `product-images` bucket + Storage policies** |

Or let the CLI do all of it (needs the direct Postgres URL, §3 row 4):

```bash
SUPABASE_DB_URL='postgresql://postgres.<ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres' \
  npm run migrate            # dry run: prints the plan
SUPABASE_DB_URL='…' npm run migrate:apply
SUPABASE_DB_URL='…' npm run migrate:sql      # prints the bundle to paste into the SQL Editor
```

Migration `010` is additive and idempotent: it only upserts the bucket row (forcing
`public = true`) and recreates four `storage.objects` policies scoped to
`bucket_id = 'product-images'`. It contains **no `alter table`, no `delete`, no `drop
table`**, and it is a no-op where the `storage` schema does not exist (local/embedded
Postgres).

**(c) Manual equivalent** — Dashboard → Storage → *New bucket* → name `product-images` →
**Public** ✅ → Create. (A *private* bucket is the classic failure: uploads succeed but every
stored URL answers 400 in the browser. The server repairs this on the next upload, and the
probe in §4 reports it.)

### 2.4 Optional Supabase knobs

| Variable | Default | Meaning |
| --- | --- | --- |
| `PRODUCT_IMAGE_BUCKET` | `product-images` | bucket name for product photos (override only if your project already uses another name) |
| `SHAPE_IMAGE_BUCKET` | `shape-images` | bucket name for shape photos (existing feature) |
| `CUSTOMIZE_MAX_IMAGE_BYTES` | `6291456` (6 MB) | per-image byte cap for **all** validated uploads, product photos included |

---

## 3. Vercel — exactly what to add

**Project → Settings → Environment Variables**, add these and enable them for
**Production** *and* **Preview**:

| # | Variable | Value | Required for this feature? |
| --- | --- | --- | --- |
| 1 | `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` (no path, no trailing slash) | **yes** — Storage endpoint + admin auth |
| 2 | `VITE_SUPABASE_ANON_KEY` | anon/public key | **yes** — admin login in the browser |
| 3 | `SUPABASE_SERVICE_ROLE_KEY` | service_role key | **yes** — creates/verifies the bucket and writes the photo |
| 4 | `SUPABASE_DB_URL` | `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres` | *optional* — switches the data driver from `postgrest` to transactional `sql`; also needed for `npm run migrate:apply` |
| 5 | `PRODUCT_IMAGE_BUCKET` | `product-images` | *optional* — only to rename the bucket |
| 6 | `CUSTOMIZE_MAX_IMAGE_BYTES` | `6291456` | *optional* — only to change the per-image cap |

Then:

1. **Redeploy.** Environment variables are baked in at deploy time — an existing deployment
   does not pick them up. Push to `main`, or `vercel --prod`, or Deployment → ⋯ → *Redeploy*
   (with "Use existing Build Cache" **off**).
2. No `vercel.json` change is needed: `/api/:path*` → `api/index.js` already routes
   `POST /api/admin/products/image`, and the function is configured with `memory: 1024`,
   `maxDuration: 10`.
3. `/admin` is served **statically** on Vercel, so the `%VITE_SUPABASE_URL%` placeholders in
   `admin.html` are not replaced — the SPA reads `GET /api/admin/config` instead (already
   implemented). Nothing to do; just don't be surprised by the placeholders in the HTML.
4. **Do not** expect `/img/uploads/…` to work on Vercel: the filesystem is read-only, so
   fallback 2 is impossible there and only Storage (or the small inline fallback) applies.

---

## 4. Verify before you test the Admin panel

### 4.1 One request, no credentials — is the wiring there?

```bash
curl -s 'https://<your-deployment>/api/admin/diagnose?products=1' | python3 -m json.tool
```

Read `productImages` (added by this feature) plus the two key flags:

```jsonc
{
  "serviceKeyPresent": true,             // ← false = SUPABASE_SERVICE_ROLE_KEY missing/not redeployed
  "anonKeyPresent": true,
  "serviceKeyIssue": null,               // ← non-null = the pasted key is corrupted (see §2.1)
  "productImages": {
    "endpoint": "POST /api/admin/products/image",
    "migration": "010_product_images.sql",
    "schema": "no table change — products.images (text[]) + product_images.url already exist",
    "imageCount": 243,                   // what the served galleries are made of:
    "uploadedFromStorage": 0,            //   … from the product-images bucket
    "generatedArtwork": 243,             //   … /img/asset.svg
    "localUploads": 0,                   //   … /img/uploads
    "inlineDataUrls": 0,                 //   … data: URLs
    "externalUrls": 0,                   //   … pasted https:// URLs
    "storage": {
      "configured": true,                // ← false = the two Supabase variables are missing
      "bucket": "product-images",
      "exists": true,                    // ← false = never uploaded yet (auto-created) or migration 010 not run
      "public": true,                    // ← false = the bucket is PRIVATE: stored URLs cannot render
      "objects": 0
    }
  }
}
```

`exists: false` on a brand-new project is fine — the first upload creates it. `public: false`
is **not** fine.

### 4.2 One command — the whole flow against the deployment

```bash
npm run probe:productimages -- --url https://<your-deployment> --token '<ADMIN_JWT>'
```

`<ADMIN_JWT>` is your own admin session token: open `/admin`, sign in, then in DevTools →
Network pick any `/api/admin/*` request and copy its `Authorization: Bearer …` value (it is
also in `localStorage["sb-<ref>-auth-token"]` → `access_token`). The script never stores it.

It runs diagnose → upload → **fetch the stored public URL** → second upload (a gallery must
never overwrite) → validation → "the catalog is untouched", prints ✓/✗ per check, and on
failure prints the exact fix. **It does not modify any product** — the two uploaded files are
inert objects under `product-images/products/` (delete them in the dashboard if you like).

Useful variants:

```bash
# local JSON server (no Supabase): accept the /img/uploads fallback instead of failing
npm run probe:productimages -- --url http://localhost:3000 --dev-token "$ADMIN_DEV_TOKEN" --allow-fallback
# upload a real photo of yours instead of the built-in test card
npm run probe:productimages -- --url https://<deployment> --token '<JWT>' --file ./my-photo.jpg
# machine-readable
npm run probe:productimages -- --url https://<deployment> --token '<JWT>' --json
```

### 4.3 The real thing, on your phone or desktop

1. `https://<your-deployment>/admin` → sign in.
2. **Products** → edit any product (or **+ Add Product**) → scroll to **Images**.
3. Tap **🖼️ Add image** → the **image library** opens over the editor (the editor stays open).
4. Tap any thumbnail → it is added to the product gallery with its preview and marked
   *✓ added*; the picker stays open, so tap more images to build the gallery. **Done** closes it.
5. Need a photo that is not in the library? Inside the picker tap **📷 Upload a new photo** →
   iOS shows *Photo Library / Take Photo / Browse* → pick it. It is uploaded, **saved into the
   library** (visible in Admin → Website Images and in the picker from now on) and added to the
   product.
6. Reorder with ↑ ↓, remove with 🗑, then **Update/Create Product**.
7. Reopen the product: the images are still there. Open the storefront product page: the
   gallery shows them.
8. After a *new upload*, `curl …/api/admin/diagnose?products=1` shows `uploadedFromStorage`
   and `storage.objects` going up.

---

## 5. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| The picker says *The image library is empty* | no `website_images` rows yet | tap **📷 Upload a new photo** in the picker (it saves into the library), or add images in Admin → Website Images |
| Selecting a library image does nothing | the image is already in that product's gallery | the row is marked *✓ added*; a duplicate is refused on purpose |
| Toast: *Supabase is not configured on this server…* / upload falls back to `inline-data-url` | `SUPABASE_SERVICE_ROLE_KEY` (or `VITE_SUPABASE_URL`) missing, or set **after** the last deploy | add both (§3) → **redeploy** → re-check `serviceKeyPresent` |
| `serviceKeyIssue` non-null in diagnose | the pasted key contains a character that cannot go in an HTTP header (`•`, smart quotes, a newline) | re-copy the key from Supabase → API, paste clean, redeploy |
| Upload OK but the image does not render on the storefront; probe says *bucket is PUBLIC* ✗ | the `product-images` bucket is private | run migration `010`, or Dashboard → Storage → `product-images` → make **Public** (the next upload also repairs it) |
| `502 Product image upload failed: …` | Storage rejected the write (wrong key role, bucket deleted mid-flight, Storage API disabled) | the message carries Supabase's own text; check the key role and the bucket, then retry |
| `400 The product image must be an uploaded image file.` | the request carried no `dataUrl` (e.g. a URL was posted) | use the picker; a URL belongs in the collapsed *Paste an image URL instead* field |
| `400 Unsupported image type…` on an SVG | SVG is rejected on purpose (it can carry script) | export the artwork as PNG/JPG/WebP |
| `400 … too large (max 6 MB)` | the photo is bigger than `CUSTOMIZE_MAX_IMAGE_BYTES` after compression | raise that variable, or pick a smaller photo |
| *That photo is still about X MB after compression* (in the panel) | Vercel's 4.5 MB request-body cap | pick a smaller photo (the editor already compressed it twice) |
| `401`/`403` on the upload | the session is not an admin (`public.admin_users`) | §2.2 — link your auth user, then sign in again |
| `413` from Vercel before the function logs anything | request body over Vercel's cap | same as above; the client guard normally prevents it |
| Uploaded photo disappears after a while | the deployment is on the **in-memory JSON store** (no Supabase data driver) — see `docs/DEPLOYMENT-VERIFICATION.md` §3.2 | set `SUPABASE_DB_URL` (or URL + service key for `postgrest`) so products persist, then re-save |

---

## 6. Where the code lives

| Piece | Where |
| --- | --- |
| Library picker UI (chooser over the editor) | `js/admin-app.js` → `openImageLibraryPicker()` |
| Library reads/writes (the one media library) | `js/admin-app.js` → `libraryImages()`, `uploadImageToLibrary()`, `addImageToLibrary()` (`website_images` rows, `/api/admin/upload`) |
| Device-photo compression + Storage upload | `js/admin-app.js` → `uploadProductImageFile()` / `shrinkDataUrl()` |
| HTTP endpoints | `server.js` → `POST /api/admin/upload` (library, existing) and `POST /api/admin/products/image` (Storage, + 12 mb body for that route only) |
| Storage: bucket, validation, object naming, public URL | `lib/storage.js` → `uploadProductImage()`, `ensureProductBucket()`, `productStorageStatus()`, `isProductImageUrl()` |
| Health reporting | `server.js` → `GET /api/admin/diagnose?products=1` → `productImages` |
| Bucket + policies | `supabase/migrations/010_product_images.sql` (registered in `scripts/migrate.js`) |
| Operator probe | `scripts/product_image_probe.js` (`npm run probe:productimages`) |
| Tests | `test/product_images.js` (`npm run test:productimages`), `test/product_image_storage.js` (`npm run test:productimagestorage`) — both in `npm test` |
| Persistence of the gallery itself | unchanged: the editor's **Save** → `/api/admin/save` → `lib/db.js` (`products.images` + `product_images`) |
