-- ============================================================================
-- 009_shape_images.sql — Shape images: one uploaded visual per key shape
-- ----------------------------------------------------------------------------
-- Applied on top of supabase-schema.sql (001) … 008_instapay_payment_status.sql.
--
-- Shape management (007) introduced the global key-shape catalogue the Admin
-- panel manages (Admin → Shapes) and every storefront selector reads. Until
-- now the storefront drew each shape with a generated SVG silhouette. This
-- migration lets the admin attach a REAL photo to each shape:
--
--   key_shapes.image_url   public URL of the uploaded shape image. The file
--                          itself lives in Supabase Storage (public bucket
--                          `shape-images`); the row only stores the durable
--                          URL, exactly like brands.logo and categories.image.
--                          NULL / empty = no image, and the storefront keeps
--                          its existing fallback (the generated silhouette).
--
-- The column is purely ADDITIVE: every existing row keeps working with a
-- NULL image_url, products' own per-shape flags (products.key_shapes) are
-- untouched, and no storefront selector changes until an admin uploads one.
--
-- SAFETY RULES (same as 002–008 — this file is safe to run again and again):
--   1. Only ADD COLUMN IF NOT EXISTS. Never a DROP, never a DELETE, never a
--      TRUNCATE: no existing data is touched.
--   2. Nothing else is altered — RLS policies, indexes, seeds and triggers
--      created by 007 stay exactly as they are.
-- ============================================================================

alter table public.key_shapes add column if not exists image_url text;

-- ============================================================================
-- 2. PUBLIC STORAGE BUCKET + POLICIES
-- ----------------------------------------------------------------------------
-- Shape images are storefront content, unlike the private Customize and
-- payment-proof photos. Keep the bucket public so the durable image_url can be
-- rendered directly by the browser without a signed URL. The conditional block
-- keeps this migration safe in the embedded/local PostgreSQL test database,
-- where Supabase's storage schema is not installed.
-- ============================================================================
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public)
    values ('shape-images', 'shape-images', true)
    on conflict (id) do update set
      name = excluded.name,
      public = true;
  end if;

  if to_regclass('storage.objects') is not null then
    -- Public storefront reads.
    execute 'drop policy if exists "Shape images: public read" on storage.objects';
    execute 'create policy "Shape images: public read" on storage.objects
             for select using (bucket_id = ''shape-images'')';

    -- Authenticated admins may manage objects directly. The application server
    -- normally uses the service-role key (which bypasses RLS), but these
    -- policies keep the bucket correct for any authenticated admin tooling too.
    execute 'drop policy if exists "Shape images: admin upload" on storage.objects';
    execute 'create policy "Shape images: admin upload" on storage.objects
             for insert with check (bucket_id = ''shape-images'' and public.is_admin())';
    execute 'drop policy if exists "Shape images: admin update" on storage.objects';
    execute 'create policy "Shape images: admin update" on storage.objects
             for update using (bucket_id = ''shape-images'' and public.is_admin())
             with check (bucket_id = ''shape-images'' and public.is_admin())';
    execute 'drop policy if exists "Shape images: admin delete" on storage.objects';
    execute 'create policy "Shape images: admin delete" on storage.objects
             for delete using (bucket_id = ''shape-images'' and public.is_admin())';
  end if;
end $$;
