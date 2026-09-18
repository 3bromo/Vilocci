-- ============================================================================
-- 007_key_shapes.sql — Shape management: the global key-shape catalog
-- ----------------------------------------------------------------------------
-- Applied on top of supabase-schema.sql (001) … 006_nano_ceramic_coating.sql.
--
-- Until now the four key shapes (A–D) existed ONLY as per-product availability
-- flags (products.key_shapes) and as hard-coded letters in the storefront and
-- the Fitment Finder. This migration introduces the master catalogue the
-- Admin panel manages (Admin → Shapes):
--
--   key_shapes.id              'shape_a' style row id
--   key_shapes.code            the shape letter ('A' …), unique, upper-case
--   key_shapes.name_en / _ar   localized display names shown to customers
--   key_shapes.description_*   optional admin/customer-facing description
--   key_shapes.active          hidden shapes disappear from the PDP selector,
--                              Quick Add, the Fitment Finder and new orders
--   key_shapes."order"         display order (lower numbers first)
--
-- Products keep their OWN per-shape availability flags (products.key_shapes);
-- the catalogue is the master list of which shapes exist at all, their names
-- and their order. A shape offered on a product page must be catalogue-active
-- AND product-available — enforced by the server at order time.
--
-- SAFETY RULES (same as 002/003 — this file is safe to run again and again):
--   1. Only CREATE … IF NOT EXISTS / ADD … IF NOT EXISTS. Never a DROP TABLE,
--      never a DELETE, never a TRUNCATE: no existing data is touched.
--   2. Policies are dropped-then-created so re-running is a no-op.
--   3. The four default shapes are seeded with ON CONFLICT DO NOTHING, so an
--      operator who already renamed them can never lose their names by
--      re-running the migrations.
--   4. Until this migration is applied, the server DERIVES the catalogue from
--      the products' own key-shape flags (same ids A–D, default names), so a
--      pending migration can never take the storefront down — the exact
--      pattern categories already use.
-- ============================================================================

-- ============================================================================
-- 1. TABLE
-- ============================================================================
create table if not exists public.key_shapes (
  id text primary key,
  code text not null,
  name_en text,
  name_ar text,
  description_en text,
  description_ar text,
  active boolean not null default true,
  "order" integer not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- The code is the business key products reference ('A' …). Unique per shape.
create unique index if not exists key_shapes_code_uq on public.key_shapes (code);

-- ============================================================================
-- 2. ROW LEVEL SECURITY — same posture as categories/brands
-- ============================================================================
alter table public.key_shapes enable row level security;

-- Storefront visitors see active shapes only.
drop policy if exists "Public read active key shapes" on public.key_shapes;
create policy "Public read active key shapes" on public.key_shapes
  for select using (active = true);

-- Admins (is_admin()) manage everything; every server-side read/write from
-- the app uses the service-role key and never reaches the browser.
drop policy if exists "Admin full key shapes" on public.key_shapes;
create policy "Admin full key shapes" on public.key_shapes
  for all using (public.is_admin());

-- ============================================================================
-- 3. DEFAULT CONTENT — the four shapes the store already ships (A–D).
--    ON CONFLICT DO NOTHING: re-running never overwrites admin edits.
-- ============================================================================
insert into public.key_shapes (id, code, name_en, name_ar, description_en, description_ar, active, "order")
values
  ('shape_a', 'A', 'Shape A', 'الشكل A', 'Standard folded key blade profile.', 'شكل المفتاح القياسي المطوي.', true, 1),
  ('shape_b', 'B', 'Shape B', 'الشكل B', 'Slim smart-key profile.', 'شكل المفتاح الذكي النحيف.', true, 2),
  ('shape_c', 'C', 'Shape C', 'الشكل C', 'Wide smart-key profile.', 'شكل المفتاح الذكي العريض.', true, 3),
  ('shape_d', 'D', 'Shape D', 'الشكل D', 'Extended smart-key profile.', 'شكل المفتاح الذكي الممتد.', true, 4)
on conflict (id) do nothing;

-- ============================================================================
-- 4. updated_at housekeeping (same trigger style as the baseline schema)
-- ============================================================================
drop trigger if exists key_shapes_updated_at on public.key_shapes;
create trigger key_shapes_updated_at before update on public.key_shapes
  for each row execute function public.set_updated_at();
