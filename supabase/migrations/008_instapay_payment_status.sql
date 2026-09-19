-- ============================================================================
-- 008_instapay_payment_status.sql — admin verification state for InstaPay
-- ----------------------------------------------------------------------------
-- Adds a separate payment_status so order fulfillment statuses (Pending,
-- Processing, Shipped, Delivered, Cancelled) keep their existing meaning while
-- manual InstaPay transfers can move through Pending Verification -> Verified
-- or Rejected in Admin -> Orders.
-- ============================================================================

alter table public.orders add column if not exists payment_status text default 'Not Required';

update public.orders
set payment_status = case
  when payment = 'InstaPay' then 'Pending Verification'
  else coalesce(payment_status, 'Not Required')
end
where payment_status is null;
