-- ============================================================================
-- 003_customize.sql — Customize (car customization requests)
-- ----------------------------------------------------------------------------
-- Applied on top of supabase-schema.sql (001) and 002_cms_core.sql.
--
-- Adds the storage for the customer "Customize" flow:
--   * customize_requests  -> one row per submitted customization request
--                            (category, private car photo reference, car data,
--                            the request itself, customer contact details,
--                            status + internal admin notes)
--   * settings['customize'] -> which EXISTING categories are available for
--                            Customize. Stored as its own setting on purpose:
--                            it must never change public.categories.active, so
--                            the normal shopping / category pages are
--                            completely unaffected by this feature.
--   * storage bucket 'customize-uploads' (PRIVATE) for the customer car photos.
--
-- SAFETY RULES (same as 002 — this file is safe to run again and again):
--   1. Only CREATE … IF NOT EXISTS / ADD … IF NOT EXISTS. Never a DROP TABLE,
--      never a DELETE, never a TRUNCATE: no existing data is touched.
--   2. Policies are dropped-then-created so re-running is a no-op.
--   3. The Customize category setting is seeded ONLY when it does not exist
--      (on conflict do nothing), so an operator can never lose their choices
--      by re-running the migrations.
--   4. The storage part is skipped when the storage schema is absent (plain
--      PostgreSQL / local verification), so the migration still applies there.
--
-- Customer requests are NOT publicly readable: RLS is enabled and the ONLY
-- policy is for admins (public.is_admin()). Anonymous visitors have no policy
-- at all, so they read zero rows; every server-side read/write uses the
-- service-role key, which never reaches the browser.
-- ============================================================================

-- ============================================================================
-- 1. CUSTOMIZE REQUESTS
-- ============================================================================
create table if not exists public.customize_requests (
  id text primary key,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  -- selected (Customize-enabled) category — id + a denormalized snapshot of its
  -- labels so an old request still shows what the customer picked even if the
  -- category is later renamed or removed.
  category_id text,
  category_slug text,
  category_name_en text,
  category_name_ar text,

  -- car photo. Only ONE of these is filled:
  --   car_image_path -> object path inside the PRIVATE 'customize-uploads'
  --                     storage bucket (the normal, production case);
  --   car_image_data -> inline data URL, used only when Supabase Storage is not
  --                     configured (local / JSON fallback) so the admin can
  --                     still see the photo. Never served to the storefront.
  car_image_path text,
  car_image_mime text,
  car_image_size integer,
  car_image_data text,

  -- car information
  car_brand text,
  car_model text,
  model_year text,
  car_details text,

  -- what the customer wants customized
  customization_request text not null,

  -- customer information
  customer_name text not null,
  phone text not null,
  whatsapp text,
  email text,
  preferred_contact text default 'Phone',
  additional_notes text,

  -- admin workflow
  status text not null default 'New',
  admin_notes text,

  -- duplicate-submission guard: the storefront sends one stable key per form
  -- fill, so a double tap / retry can never create a second request.
  client_key text,
  locale text default 'en',
  source text default 'storefront'
);

-- One request per client key (partial index: rows without a key are unaffected).
create unique index if not exists customize_requests_client_key_idx
  on public.customize_requests (client_key)
  where client_key is not null;

create index if not exists customize_requests_created_idx on public.customize_requests (created_at desc);
create index if not exists customize_requests_status_idx on public.customize_requests (status);
create index if not exists customize_requests_category_idx on public.customize_requests (category_id);

-- Status must stay inside the documented workflow.
alter table public.customize_requests drop constraint if exists customize_requests_status_chk;
alter table public.customize_requests add constraint customize_requests_status_chk
  check (status in ('New', 'Contacted', 'In Progress', 'Completed', 'Cancelled'));

-- ============================================================================
-- 2. RLS — admin-only. No public read, ever.
-- ============================================================================
alter table public.customize_requests enable row level security;

do $$
begin
  if to_regprocedure('public.is_admin()') is not null then
    execute 'drop policy if exists "Admins manage customize requests" on public.customize_requests';
    execute 'create policy "Admins manage customize requests" on public.customize_requests
             for all using (public.is_admin()) with check (public.is_admin())';
  end if;
end $$;

-- Belt and braces: remove the grant an anonymous PostgREST caller would
-- otherwise inherit, so it cannot even attempt a read. Only the `anon` role is
-- touched: the service role keeps its own grant (all server-side reads), and an
-- authenticated admin can still read through the is_admin() policy above.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.customize_requests from anon';
  end if;
exception when others then null;
end $$;

-- ============================================================================
-- 3. CUSTOMIZE CATEGORY SETTINGS
-- ----------------------------------------------------------------------------
-- Stored as ONE settings row (key = 'customize') so the feature never writes to
-- public.categories — normal category visibility (categories.active) keeps
-- working exactly as before.
--
-- First run: every existing category is enabled, so the Customize page is not
-- empty on first deployment. `on conflict do nothing` means an operator's later
-- choices are never overwritten by a re-run.
-- ============================================================================
-- NOTE: on a first deployment the migrations run BEFORE the storefront content
-- is mapped in, so public.categories can still be empty here. The insert is
-- therefore skipped in that case (no half-filled '{ }' row) and
-- `npm run migrate -- --apply` re-runs the exact same statement right after it
-- has imported the categories.
insert into public.settings (key, value)
select
  'customize',
  jsonb_build_object(
    'categories', coalesce(jsonb_object_agg(c.id, true), '{}'::jsonb),
    'seededAt', now()
  )
from public.categories c
where c.active is not false
having count(*) > 0
on conflict (key) do nothing;

-- ============================================================================
-- 4. PRIVATE STORAGE BUCKET for customer car photos
-- ----------------------------------------------------------------------------
-- The bucket is private (public = false). Customers cannot list or read it:
-- there is no anon policy on storage.objects; uploads and signed URLs are
-- created server-side with the service-role key only.
-- ============================================================================
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public)
    values ('customize-uploads', 'customize-uploads', false)
    on conflict (id) do update set public = false;

    if to_regclass('storage.objects') is not null and to_regprocedure('public.is_admin()') is not null then
      execute 'drop policy if exists "Customize photos: admin read" on storage.objects';
      execute 'create policy "Customize photos: admin read" on storage.objects
               for select using (bucket_id = ''customize-uploads'' and public.is_admin())';
    end if;

    -- Explicitly make sure no anonymous access is possible.
    execute 'drop policy if exists "Customize photos: public read" on storage.objects';
  end if;
end $$;
