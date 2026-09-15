-- ============================================================================
-- 002_cms_core.sql — CMS core
-- ----------------------------------------------------------------------------
-- Applied on top of supabase-schema.sql (migration 001 / baseline).
--
-- Adds the tables + columns the Admin CMS and the durable order pipeline need:
--   * orders            -> normalized customer columns (customer_phone,
--                          customer_address, …) + lookup indexes
--   * order_items       -> one row per ordered line (not JSON-only any more)
--   * product_images    -> normalized product gallery (no duplicate images)
--   * product_prices    -> normalized price list per product
--   * products/brands/bundles/hero_slides/home_sections/promo_bar
--                       -> the remaining columns the live storefront content
--                          actually uses, so mapping it is lossless
--
-- SAFETY RULES (this migration is safe to run more than once):
--   1. It only CREATEs / ALTER … ADD COLUMN IF NOT EXISTS. It never DROPs a
--      table or a column and it never DELETEs a row.
--   2. Every policy and trigger is dropped-then-created, so re-running is a
--      no-op instead of an "already exists" error.
--   3. Existing storefront data is untouched. The content mapping that fills
--      these tables lives in scripts/migrate.js and is upsert-only.
-- ============================================================================

create extension if not exists "uuid-ossp";

-- ============================================================================
-- 1. PRODUCTS — remaining detail columns used by the storefront + admin.
--    Baseline 001 created the table; this only adds what is missing.
--    (`inventory` is an integer count in the live data, so it maps onto the
--    existing `stock` column rather than getting a second copy.)
-- ============================================================================
alter table public.products add column if not exists short_en text;
alter table public.products add column if not exists short_ar text;
alter table public.products add column if not exists material_en text;
alter table public.products add column if not exists material_ar text;
alter table public.products add column if not exists old_price numeric;
alter table public.products add column if not exists best_seller boolean default false;
alter table public.products add column if not exists limited_edition boolean default false;
alter table public.products add column if not exists preorder boolean default false;
alter table public.products add column if not exists out_of_stock boolean default false;
alter table public.products add column if not exists warranty_en text;
alter table public.products add column if not exists warranty_ar text;
alter table public.products add column if not exists badge_en text;
alter table public.products add column if not exists badge_ar text;
alter table public.products add column if not exists models jsonb default '[]'::jsonb;
alter table public.products add column if not exists years jsonb default '[]'::jsonb;
alter table public.products add column if not exists specs jsonb default '[]'::jsonb;
alter table public.products add column if not exists vehicles jsonb default '[]'::jsonb;

-- The live catalog interleaves the products of a brand with fractional order
-- values (0, 0.25, 0.5, 0.75, 1, …). 001 declared the column as integer, which
-- would round that ordering away and re-sort the storefront, so it is widened
-- here to keep the existing order exactly as it is.
alter table public.products alter column "order" type numeric using "order";

create index if not exists products_category_idx on public.products (category);
create index if not exists products_brand_idx on public.products (brand_slug);
create index if not exists products_active_idx on public.products (active);

-- ============================================================================
-- 2. CATEGORIES — the CMS edits name / image / description / order.
--    Baseline 001 already has: id, name_en, name_ar, slug, description_en,
--    description_ar, image, active, icon, product_count, "order".
--    001 also created a before-update trigger that writes updated_at, but never
--    created the column — that would break every category UPDATE, so the
--    column is added here.
-- ============================================================================
alter table public.categories add column if not exists updated_at timestamptz default now();
create index if not exists categories_order_idx on public.categories ("order");

-- ============================================================================
-- 3. BRANDS — mark / tier / fitment models used by the live brand data
-- ============================================================================
alter table public.brands add column if not exists mark text;
alter table public.brands add column if not exists tier text;
alter table public.brands add column if not exists accent text;
alter table public.brands add column if not exists models jsonb default '[]'::jsonb;
alter table public.brands add column if not exists updated_at timestamptz default now();

-- ============================================================================
-- 4. BUNDLES — the live bundle rows carry titles, subtitles and a computed
--    discount; keep them instead of losing them on the way into SQL.
-- ============================================================================
alter table public.bundles add column if not exists title_en text;
alter table public.bundles add column if not exists title_ar text;
alter table public.bundles add column if not exists sub_en text;
alter table public.bundles add column if not exists sub_ar text;
alter table public.bundles add column if not exists discount numeric default 0;
alter table public.bundles add column if not exists discount_percent numeric default 0;
alter table public.bundles add column if not exists discount_mode text default 'percent';
alter table public.bundles add column if not exists discount_amount numeric default 0;
alter table public.bundles add column if not exists start_date timestamptz;
alter table public.bundles add column if not exists end_date timestamptz;
alter table public.bundles add column if not exists updated_at timestamptz default now();

-- ============================================================================
-- 5. HERO SLIDES — the live slides carry headlines, two buttons and an accent
-- ============================================================================
alter table public.hero_slides add column if not exists headline_en text;
alter table public.hero_slides add column if not exists headline_ar text;
alter table public.hero_slides add column if not exists sub_en text;
alter table public.hero_slides add column if not exists sub_ar text;
alter table public.hero_slides add column if not exists btn1_en text;
alter table public.hero_slides add column if not exists btn1_ar text;
alter table public.hero_slides add column if not exists btn1_link text;
alter table public.hero_slides add column if not exists btn2_en text;
alter table public.hero_slides add column if not exists btn2_ar text;
alter table public.hero_slides add column if not exists btn2_link text;
alter table public.hero_slides add column if not exists accent_en text;
alter table public.hero_slides add column if not exists accent_ar text;
alter table public.hero_slides add column if not exists updated_at timestamptz default now();

-- ============================================================================
-- 6. HOME SECTIONS — website content sections edited from the admin panel
-- ============================================================================
alter table public.home_sections add column if not exists updated_at timestamptz default now();
create index if not exists home_sections_order_idx on public.home_sections ("order");

-- ============================================================================
-- 7. PROMO BAR — subtitle columns
-- ============================================================================
alter table public.promo_bar add column if not exists sub_en text;
alter table public.promo_bar add column if not exists sub_ar text;

-- ============================================================================
-- 8. ORDERS — normalized customer columns.
--    The `customer`/`items` jsonb columns from 001 stay (nothing is dropped),
--    so the legacy shape keeps working while the admin panel reads real
--    columns: customer_phone / customer_address are first-class and indexable.
-- ============================================================================
alter table public.orders add column if not exists customer_name text;
alter table public.orders add column if not exists customer_phone text;
alter table public.orders add column if not exists customer_email text;
alter table public.orders add column if not exists customer_city text;
alter table public.orders add column if not exists customer_area text;
alter table public.orders add column if not exists customer_address text;
alter table public.orders add column if not exists customer_notes text;
alter table public.orders add column if not exists currency text default 'EGP';
alter table public.orders add column if not exists source text default 'storefront';
alter table public.orders add column if not exists updated_at timestamptz default now();

create index if not exists orders_created_at_idx on public.orders (created_at desc);
create index if not exists orders_status_idx on public.orders (status);
create index if not exists orders_customer_phone_idx on public.orders (customer_phone);

-- ============================================================================
-- 9. ORDER ITEMS — one row per ordered line
-- ============================================================================
create table if not exists public.order_items (
  id text primary key,
  order_id text not null references public.orders(id) on delete cascade,
  product_id text,
  name_en text,
  name_ar text,
  slug text,
  category text,
  brand_slug text,
  key_shape text,
  qty integer not null default 1,
  unit_price numeric not null default 0,
  line_total numeric not null default 0,
  image text,
  fitment jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists order_items_order_idx on public.order_items (order_id);
create index if not exists order_items_product_idx on public.order_items (product_id);

-- ============================================================================
-- 10. PRODUCT IMAGES — normalized gallery.
--     unique (product_id, url) makes re-running the content mapping a no-op
--     instead of creating duplicate images for the same product.
-- ============================================================================
create table if not exists public.product_images (
  id text primary key,
  product_id text not null references public.products(id) on delete cascade,
  url text not null,
  alt text,
  position integer not null default 0,
  is_main boolean not null default false,
  created_at timestamptz default now(),
  unique (product_id, url)
);

create index if not exists product_images_product_idx on public.product_images (product_id, position);

-- ============================================================================
-- 11. PRODUCT PRICES — normalized price list (default + optional variants)
-- ============================================================================
create table if not exists public.product_prices (
  id text primary key,
  product_id text not null references public.products(id) on delete cascade,
  label text not null default 'default',
  price numeric not null default 0,
  sale_price numeric,
  old_price numeric,
  discount_pct numeric default 0,
  currency text default 'EGP',
  active boolean default true,
  "order" integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (product_id, label)
);

create index if not exists product_prices_product_idx on public.product_prices (product_id);

-- ============================================================================
-- ROW LEVEL SECURITY for the new tables
-- ============================================================================
alter table public.order_items enable row level security;
alter table public.product_images enable row level security;
alter table public.product_prices enable row level security;

-- public.is_admin() comes from 001 (baseline).
drop policy if exists "Admin full order items" on public.order_items;
create policy "Admin full order items" on public.order_items
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admin full product images" on public.product_images;
create policy "Admin full product images" on public.product_images
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Public read product images" on public.product_images;
create policy "Public read product images" on public.product_images
  for select using (true);

drop policy if exists "Admin full product prices" on public.product_prices;
create policy "Admin full product prices" on public.product_prices
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Public read active product prices" on public.product_prices;
create policy "Public read active product prices" on public.product_prices
  for select using (active = true);

-- Re-create the baseline admin policies WITH the `with check` half. 001
-- declared them as `for all using (…)` only, which means an INSERT through
-- the anon/authenticated roles passes `using` but fails `with check` — admin
-- writes from the panel would be rejected.
drop policy if exists "Admin full products" on public.products;
create policy "Admin full products" on public.products
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Admin full categories" on public.categories;
create policy "Admin full categories" on public.categories
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Admin full brands" on public.brands;
create policy "Admin full brands" on public.brands
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Admin full bundles" on public.bundles;
create policy "Admin full bundles" on public.bundles
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Admin full orders" on public.orders;
create policy "Admin full orders" on public.orders
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Admin full content" on public.website_content;
create policy "Admin full content" on public.website_content
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Admin full images" on public.website_images;
create policy "Admin full images" on public.website_images
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Admin full settings" on public.settings;
create policy "Admin full settings" on public.settings
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Admin full slides" on public.hero_slides;
create policy "Admin full slides" on public.hero_slides
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Admin full sections" on public.home_sections;
create policy "Admin full sections" on public.home_sections
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Admin full promo" on public.promo_bar;
create policy "Admin full promo" on public.promo_bar
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Admin full preorders" on public.preorders;
create policy "Admin full preorders" on public.preorders
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Admin full messages" on public.messages;
create policy "Admin full messages" on public.messages
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Admin full discounts" on public.discount_codes;
create policy "Admin full discounts" on public.discount_codes
  for all using (public.is_admin()) with check (public.is_admin());

-- ============================================================================
-- GRANTS — only for roles that actually exist in this database
-- (Supabase always has anon / authenticated / service_role; a plain Postgres
--  instance used for local verification may not).
-- ============================================================================
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant usage on schema public to %I', r);
      execute format('grant select, insert, update, delete on all tables in schema public to %I', r);
    end if;
  end loop;
end $$;

-- ============================================================================
-- updated_at triggers for the tables that gained the column
-- (public.set_updated_at comes from 001). Drop-then-create keeps this
-- re-runnable.
-- ============================================================================
drop trigger if exists categories_updated_at on public.categories;
create trigger categories_updated_at before update on public.categories
  for each row execute function public.set_updated_at();

drop trigger if exists brands_updated_at on public.brands;
create trigger brands_updated_at before update on public.brands
  for each row execute function public.set_updated_at();

drop trigger if exists hero_slides_updated_at on public.hero_slides;
create trigger hero_slides_updated_at before update on public.hero_slides
  for each row execute function public.set_updated_at();

drop trigger if exists home_sections_updated_at on public.home_sections;
create trigger home_sections_updated_at before update on public.home_sections
  for each row execute function public.set_updated_at();

drop trigger if exists orders_updated_at on public.orders;
create trigger orders_updated_at before update on public.orders
  for each row execute function public.set_updated_at();

drop trigger if exists product_prices_updated_at on public.product_prices;
create trigger product_prices_updated_at before update on public.product_prices
  for each row execute function public.set_updated_at();
