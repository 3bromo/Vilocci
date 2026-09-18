-- ============================================================================
-- 005_instapay_payment_proof.sql — required proof for manual InstaPay orders
-- ----------------------------------------------------------------------------
-- Safe additive migration. Existing COD orders and all existing order data are
-- left untouched. Production proofs are private objects in the existing
-- customize-uploads bucket and are opened through an authenticated signed URL.
-- ============================================================================

alter table public.orders add column if not exists payment_proof_path text;
alter table public.orders add column if not exists payment_proof_mime text;
alter table public.orders add column if not exists payment_proof_size integer;
alter table public.orders add column if not exists payment_proof_data text;

-- Keep order proof references private. The server uses the service-role key for
-- storefront writes and authenticated admin reads.
alter table public.orders enable row level security;

-- The existing orders policies remain in place; this migration intentionally
-- adds no public policy and does not alter Cash on Delivery behavior.

-- Reuse the private bucket created by 003_customize.sql. This is conditional so
-- the migration also runs safely in local Postgres verification environments.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public)
    values ('customize-uploads', 'customize-uploads', false)
    on conflict (id) do update set public = false;
  end if;
end $$;
