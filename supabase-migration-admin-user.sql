-- ============================================================================
-- SPINTO — Admin User Migration
-- Inserts the admin user into admin_users table.
--
-- PREREQUISITE: The user must already exist in Supabase Authentication.
-- Run this in Supabase SQL Editor AFTER creating the auth user.
-- ============================================================================

-- Insert the admin user
INSERT INTO public.admin_users (id, email, full_name, role)
VALUES (
  '363fc336-b630-493d-8f58-b614bc4fcfc8',
  '3brosnfroo15@gmail.com',
  'Admin',
  'admin'
)
ON CONFLICT (id) DO UPDATE SET
  email = EXCLUDED.email,
  role = EXCLUDED.role;

-- Verify the insertion
SELECT id, email, full_name, role, created_at FROM public.admin_users;
