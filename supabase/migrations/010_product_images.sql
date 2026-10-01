-- ============================================================================
-- 010_product_images.sql — Product image uploads (public `product-images` bucket)
-- ----------------------------------------------------------------------------
-- Applied on top of supabase-schema.sql (001) … 009_shape_images.sql.
--
-- The Admin product editor used to accept product images only as a typed URL.
-- It now opens the device photo gallery, uploads the picked photo and adds the
-- resulting URL to the product:
--
--   POST /api/admin/products/image → lib/storage.js → Supabase Storage
--   products.images (text[]) / product_images.url keep the durable PUBLIC URL,
--   exactly like key_shapes.image_url (009), brands.logo and categories.image.
--
-- NO TABLE CHANGES ARE NEEDED: products.images and the normalized
-- product_images child table already exist (002), so this migration only
-- provisions the storage half — the public bucket and its policies. The
-- application server also creates/verifies the bucket on the first upload
-- (lib/storage.js → ensureProductBucket), so this file is the belt-and-braces
-- version an operator can run in Supabase → SQL Editor up front.
--
-- SAFETY RULES (same as 002–009 — this file is safe to run again and again):
--   1. No DROP TABLE, no DELETE, no TRUNCATE: no existing data is touched.
--   2. Every existing product image keeps working — generated artwork
--      (/img/asset.svg), pasted public URLs and /img/uploads files are all just
--      strings in products.images and are never rewritten by this migration.
--   3. The storage block is conditional, so it is a no-op in the embedded/local
--      PostgreSQL test database where Supabase's storage schema is absent.
-- ============================================================================

-- ============================================================================
-- 1. PUBLIC STORAGE BUCKET + POLICIES
-- ----------------------------------------------------------------------------
-- Product photos are storefront content (the customer sees them in the product
-- gallery), so the bucket is PUBLIC and the row stores the durable URL — no
-- signed URLs, unlike the private Customize / payment-proof photos.
-- ============================================================================
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public)
    values ('product-images', 'product-images', true)
    on conflict (id) do update set
      name = excluded.name,
      public = true;
  end if;

  if to_regclass('storage.objects') is not null then
    -- Public storefront reads.
    execute 'drop policy if exists "Product images: public read" on storage.objects';
    execute 'create policy "Product images: public read" on storage.objects
             for select using (bucket_id = ''product-images'')';

    -- Authenticated admins may manage objects directly. The application server
    -- normally uses the service-role key (which bypasses RLS), but these
    -- policies keep the bucket correct for any authenticated admin tooling too.
    execute 'drop policy if exists "Product images: admin upload" on storage.objects';
    execute 'create policy "Product images: admin upload" on storage.objects
             for insert with check (bucket_id = ''product-images'' and public.is_admin())';
    execute 'drop policy if exists "Product images: admin update" on storage.objects';
    execute 'create policy "Product images: admin update" on storage.objects
             for update using (bucket_id = ''product-images'' and public.is_admin())
             with check (bucket_id = ''product-images'' and public.is_admin())';
    execute 'drop policy if exists "Product images: admin delete" on storage.objects';
    execute 'create policy "Product images: admin delete" on storage.objects
             for delete using (bucket_id = ''product-images'' and public.is_admin())';
  end if;
end $$;
