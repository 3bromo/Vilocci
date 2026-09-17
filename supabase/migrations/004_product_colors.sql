-- ============================================================================
-- 004_product_colors.sql — per-product color variants
-- ----------------------------------------------------------------------------
-- Applied on top of supabase-schema.sql (001), 002_cms_core.sql (002) and
-- 003_customize.sql (003).
--
-- Gives EVERY product its own ordered list of color variants, managed in
-- Admin → Products → Colors:
--
--   products.colors jsonb — [ { id, name_en, name_ar, hex, enabled }, … ]
--     * array position IS the display order (admins reorder colors)
--     * enabled = false keeps the color in admin without showing it in the
--       storefront
--     * the SAME column feeds the storefront, cart/checkout validation,
--       orders and the Customize flow — there is no second color system
--
--   order_items.color jsonb — snapshot of the color the customer picked for
--     that line: { id, name_en, name_ar, hex }. A snapshot on purpose, so an
--     order keeps showing the chosen color even if the catalog color is later
--     renamed, disabled or deleted. (orders.items jsonb already carries the
--     same payload for legacy rows.)
--
-- SAFETY RULES (same as 002 / 003 — this file is safe to run again and again):
--   1. Only ADD COLUMN IF NOT EXISTS / defaults. Never a DROP, never a DELETE,
--      never a TRUNCATE: no existing row is touched.
--   2. Existing products get '[]' — the storefront shows no color selector for
--      them until the admin adds colors, exactly like today.
-- ============================================================================

-- 1. Product color variants --------------------------------------------------
alter table public.products add column if not exists colors jsonb default '[]'::jsonb;

-- 2. The color chosen by the customer on each order line ---------------------
alter table public.order_items add column if not exists color jsonb;
