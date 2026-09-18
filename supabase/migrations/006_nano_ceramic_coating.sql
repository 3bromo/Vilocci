-- ============================================================================
-- 006_nano_ceramic_coating.sql — Nano Ceramic Coating optional extra
-- ----------------------------------------------------------------------------
-- Safe additive migration for the option that replaces "Premium Gift
-- Packaging": a flat EGP 100 extra on Key Holder / Key Case order lines.
--
--   orders.coating_fee     total coating charge on the order
--                          (100 × number of coated lines; 0/absent = none)
--   order_items.coating    the customer's per-line opt-in snapshot
--
-- Existing orders and order items are left untouched — both columns default
-- to "no coating". Until this migration is applied, the server simply omits
-- the columns from un-coated writes (the InstaPay-proof pattern from 005), so
-- Cash on Delivery and InstaPay orders WITHOUT coating keep working exactly
-- as before; orders that DO include the coating fail safely (and only those)
-- until the two columns exist.
-- ============================================================================

alter table public.orders add column if not exists coating_fee numeric default 0;
alter table public.order_items add column if not exists coating boolean default false;
