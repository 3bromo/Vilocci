-- ============================================================================
-- SPINTO — Supabase Database Schema
-- Run this in your Supabase SQL Editor to create all required tables.
-- ============================================================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ============================================================================
-- 1. ADMIN USERS (extends Supabase Auth)
-- ============================================================================
create table if not exists public.admin_users (
  id uuid references auth.users(id) on delete cascade primary key,
  email text unique not null,
  full_name text,
  role text default 'admin',
  created_at timestamptz default now()
);

-- ============================================================================
-- 2. PRODUCTS
-- ============================================================================
create table if not exists public.products (
  id text primary key,
  name_en text not null,
  name_ar text,
  slug text unique,
  category text not null,
  brand_slug text not null,
  description_en text,
  description_ar text,
  price numeric not null default 0,
  sale_price numeric,
  discount_pct numeric default 0,
  active boolean default true,
  featured boolean default false,
  new_arrival boolean default false,
  hero_product boolean default false,
  stock integer default 0,
  sku text,
  key_shapes jsonb default '[]'::jsonb,
  images text[] default '{}',
  main_image text,
  fitment jsonb default '{}'::jsonb,
  "order" integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================================
-- 3. CATEGORIES
-- ============================================================================
create table if not exists public.categories (
  id text primary key,
  name_en text not null,
  name_ar text,
  slug text unique,
  description_en text,
  description_ar text,
  image text,
  active boolean default true,
  icon text,
  product_count integer default 0,
  "order" integer default 0,
  created_at timestamptz default now()
);

-- ============================================================================
-- 4. BRANDS
-- ============================================================================
create table if not exists public.brands (
  id text primary key,
  name_en text not null,
  name_ar text,
  slug text unique not null,
  description_en text,
  description_ar text,
  logo text,
  emblem text,
  active boolean default true,
  product_count integer default 0,
  "order" integer default 0,
  created_at timestamptz default now()
);

-- ============================================================================
-- 5. BUNDLES / PACKAGES
-- ============================================================================
create table if not exists public.bundles (
  id text primary key,
  brand_slug text not null,
  name_en text,
  name_ar text,
  active boolean default true,
  bundle_price numeric not null default 0,
  normal_total numeric default 0,
  key_case_id text,
  key_holder_id text,
  medal_id text,
  "order" integer default 0,
  created_at timestamptz default now()
);

-- ============================================================================
-- 6. ORDERS
-- ============================================================================
create table if not exists public.orders (
  id text primary key,
  created_at timestamptz default now(),
  customer jsonb not null,
  items jsonb not null,
  subtotal numeric default 0,
  bundle_discount numeric default 0,
  delivery_fee numeric default 0,
  total numeric default 0,
  status text default 'New',
  status_history jsonb default '[]'::jsonb,
  payment text default 'Cash on Delivery',
  notes text
);

-- ============================================================================
-- 7. PRE-ORDERS
-- ============================================================================
create table if not exists public.preorders (
  id text primary key,
  product_id text,
  name_en text,
  name_ar text,
  brand_slug text,
  key_shape text,
  customer jsonb not null,
  status text default 'Pending',
  created_at timestamptz default now()
);

-- ============================================================================
-- 8. CONTACT MESSAGES
-- ============================================================================
create table if not exists public.messages (
  id text primary key,
  name text,
  email text,
  phone text,
  message text,
  subject text,
  is_read boolean default false,
  is_resolved boolean default false,
  created_at timestamptz default now()
);

-- ============================================================================
-- 9. DISCOUNT CODES
-- ============================================================================
create table if not exists public.discount_codes (
  id text primary key,
  code text unique not null,
  type text default 'percentage',
  value numeric not null default 0,
  min_order numeric default 0,
  max_uses integer,
  used_count integer default 0,
  expires_at timestamptz,
  active boolean default true,
  created_at timestamptz default now()
);

-- ============================================================================
-- 10. WEBSITE CONTENT
-- ============================================================================
create table if not exists public.website_content (
  id text primary key,
  section text not null,
  key text not null,
  value_en text,
  value_ar text,
  type text default 'text',
  updated_at timestamptz default now(),
  unique(section, key)
);

-- ============================================================================
-- 11. WEBSITE IMAGES
-- ============================================================================
create table if not exists public.website_images (
  id text primary key,
  name text not null,
  url text not null,
  section text,
  alt text,
  created_at timestamptz default now()
);

-- ============================================================================
-- 12. WEBSITE SETTINGS
-- ============================================================================
create table if not exists public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);

-- ============================================================================
-- 13. HERO SLIDES
-- ============================================================================
create table if not exists public.hero_slides (
  id text primary key,
  title_en text,
  title_ar text,
  subtitle_en text,
  subtitle_ar text,
  image text,
  product_id text,
  active boolean default true,
  "order" integer default 0,
  created_at timestamptz default now()
);

-- ============================================================================
-- 14. HOME SECTIONS
-- ============================================================================
create table if not exists public.home_sections (
  id text primary key,
  type text not null,
  title_en text,
  title_ar text,
  subtitle_en text,
  subtitle_ar text,
  enabled boolean default true,
  "order" integer default 0,
  config jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

-- ============================================================================
-- 15. PROMO BAR
-- ============================================================================
create table if not exists public.promo_bar (
  id text primary key default 'promo',
  enabled boolean default true,
  text_en text,
  text_ar text,
  end_time timestamptz,
  updated_at timestamptz default now()
);

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
alter table public.admin_users enable row level security;
alter table public.products enable row level security;
alter table public.categories enable row level security;
alter table public.brands enable row level security;
alter table public.bundles enable row level security;
alter table public.orders enable row level security;
alter table public.preorders enable row level security;
alter table public.messages enable row level security;
alter table public.discount_codes enable row level security;
alter table public.website_content enable row level security;
alter table public.website_images enable row level security;
alter table public.settings enable row level security;
alter table public.hero_slides enable row level security;
alter table public.home_sections enable row level security;
alter table public.promo_bar enable row level security;

-- Helper function to check if user is admin
create or replace function public.is_admin()
returns boolean as $$
  select exists (
    select 1 from public.admin_users
    where id = auth.uid()
  );
$$ language sql security definer stable;

-- ADMIN: full access
create policy "Admin full access" on public.admin_users
  for all using (public.is_admin());

-- PRODUCTS: public read active, admin full
create policy "Public read active products" on public.products
  for select using (active = true);
create policy "Admin full products" on public.products
  for all using (public.is_admin());

-- CATEGORIES: public read active, admin full
create policy "Public read active categories" on public.categories
  for select using (active = true);
create policy "Admin full categories" on public.categories
  for all using (public.is_admin());

-- BRANDS: public read active, admin full
create policy "Public read active brands" on public.brands
  for select using (active = true);
create policy "Admin full brands" on public.brands
  for all using (public.is_admin());

-- BUNDLES: public read active, admin full
create policy "Public read active bundles" on public.bundles
  for select using (active = true);
create policy "Admin full bundles" on public.bundles
  for all using (public.is_admin());

-- ORDERS: admin only
create policy "Admin full orders" on public.orders
  for all using (public.is_admin());

-- PRE-ORDERS: admin only
create policy "Admin full preorders" on public.preorders
  for all using (public.is_admin());

-- MESSAGES: admin only
create policy "Admin full messages" on public.messages
  for all using (public.is_admin());

-- DISCOUNT CODES: public read active, admin full
create policy "Public read active discounts" on public.discount_codes
  for select using (active = true);
create policy "Admin full discounts" on public.discount_codes
  for all using (public.is_admin());

-- WEBSITE CONTENT: public read, admin write
create policy "Public read content" on public.website_content
  for select using (true);
create policy "Admin full content" on public.website_content
  for all using (public.is_admin());

-- WEBSITE IMAGES: public read, admin write
create policy "Public read images" on public.website_images
  for select using (true);
create policy "Admin full images" on public.website_images
  for all using (public.is_admin());

-- SETTINGS: public read, admin write
create policy "Public read settings" on public.settings
  for select using (true);
create policy "Admin full settings" on public.settings
  for all using (public.is_admin());

-- HERO SLIDES: public read active, admin full
create policy "Public read active slides" on public.hero_slides
  for select using (active = true);
create policy "Admin full slides" on public.hero_slides
  for all using (public.is_admin());

-- HOME SECTIONS: public read enabled, admin full
create policy "Public read enabled sections" on public.home_sections
  for select using (enabled = true);
create policy "Admin full sections" on public.home_sections
  for all using (public.is_admin());

-- PROMO BAR: public read enabled, admin write
create policy "Public read promo" on public.promo_bar
  for select using (enabled = true);
create policy "Admin full promo" on public.promo_bar
  for all using (public.is_admin());

-- ============================================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================================

-- Auto-update updated_at
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger products_updated_at before update on public.products
  for each row execute function public.set_updated_at();

create trigger categories_updated_at before update on public.categories
  for each row execute function public.set_updated_at();

create trigger brands_updated_at before update on public.brands
  for each row execute function public.set_updated_at();

create trigger bundles_updated_at before update on public.bundles
  for each row execute function public.set_updated_at();

create trigger content_updated_at before update on public.website_content
  for each row execute function public.set_updated_at();

create trigger settings_updated_at before update on public.settings
  for each row execute function public.set_updated_at();

-- ============================================================================
-- STORAGE BUCKETS (run separately in Supabase Dashboard > Storage)
-- ============================================================================
-- insert into storage.buckets (id, name, public) values ('product-images', 'product-images', true);
-- insert into storage.buckets (id, name, public) values ('brand-logos', 'brand-logos', true);
-- insert into storage.buckets (id, name, public) values ('website-images', 'website-images', true);

-- Storage policies
-- create policy "Public read product images" on storage.objects
--   for select using (bucket_id = 'product-images');
-- create policy "Admin upload product images" on storage.objects
--   for insert with check (bucket_id = 'product-images' and public.is_admin());
-- create policy "Admin delete product images" on storage.objects
--   for delete using (bucket_id = 'product-images' and public.is_admin());
