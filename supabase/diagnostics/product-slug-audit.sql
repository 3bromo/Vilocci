-- ============================================================================
-- VELOCCI — product slug audit (READ ONLY)
-- ----------------------------------------------------------------------------
-- This file contains SELECT statements only. It creates/alters/drops NOTHING,
-- writes NO rows and deletes NO data. It is safe to paste into
-- Supabase → SQL Editor on the production project.
--
-- Why: Admin saves used to fail with
--   upsert products: 23505: duplicate key value violates unique constraint
--   "products_slug_key"
-- and then the dashboard switched to the bundled backup JSON. `slug` is UNIQUE,
-- so the database cannot hold two identical slugs; what it CAN hold are values
-- Postgres considers different but the admin form normalizes to the same thing
-- ("Audi Key Case" vs "audi-key-case"), and rows with NO slug at all (the
-- column is nullable + unique, so several NULLs are allowed).
--
-- Read the results, then fix any finding through Admin → Products by giving one
-- of the products a distinct slug. Never delete a product to resolve a slug.
-- ============================================================================

-- 1. Exact duplicate slugs (cannot happen while the unique index exists; kept
--    as proof, and it is the first thing to look at if the index was ever
--    dropped and re-created on a live table).
select slug, count(*) as products
from public.products
where slug is not null
group by slug
having count(*) > 1
order by products desc, slug;

-- 2. Slugs that collapse to the same value once normalized the way the admin
--    form normalizes them (lowercase, non-alphanumerics → '-'). These are the
--    ones that behave like duplicates in the editor.
with normalized as (
  select id,
         slug,
         name_en,
         trim(both '-' from regexp_replace(lower(slug), '[^a-z0-9]+', '-', 'g')) as normalized_slug
  from public.products
  where slug is not null and btrim(slug) <> ''
)
select normalized_slug, count(*) as products, array_agg(id order by id) as product_ids,
       array_agg(slug order by id) as slugs
from normalized
group by normalized_slug
having count(*) > 1
order by products desc, normalized_slug;

-- 3. Products with no slug (they have no URL handle and cannot be matched by
--    slug; they are never deleted by this audit — give them one in the admin).
select id, name_en, category, brand_slug, created_at
from public.products
where slug is null or btrim(slug) = ''
order by created_at nulls last, id;

-- 4. Slugs that are not already in canonical form (spaces, uppercase, accents,
--    trailing hyphens). Normalizing them changes the product URL, so review
--    before editing; existing slugs are preserved by the save path unless an
--    admin deliberately changes them.
select id, name_en, slug,
       trim(both '-' from regexp_replace(lower(slug), '[^a-z0-9]+', '-', 'g')) as canonical_slug
from public.products
where slug is not null
  and slug <> trim(both '-' from regexp_replace(lower(slug), '[^a-z0-9]+', '-', 'g'))
order by id;

-- 5. The constraint itself — proof that the unique index is still in place.
--    (Read only: this does NOT create or drop anything.)
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'products' and indexname = 'products_slug_key';

-- 6. Duplicate ids are impossible (primary key), but this confirms the row
--    count so the numbers above can be sanity-checked against the dashboard.
select count(*) as products, count(slug) as products_with_slug from public.products;
