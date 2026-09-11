-- ============================================================================
-- SUPINTO — Admin Auth Setup
-- Creates the admin_users table, enables RLS, adds policies, and inserts
-- the admin user.
--
-- Run this in Supabase SQL Editor. It creates everything needed for admin
-- authentication.
-- ============================================================================

-- Create the admin_users table
CREATE TABLE IF NOT EXISTS public.admin_users (
  id uuid REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  email text UNIQUE NOT NULL,
  full_name text,
  role text DEFAULT 'admin',
  created_at timestamptz DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;

-- Helper function to check if user is admin
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.admin_users
    WHERE id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Policy: authenticated admins can fully access admin_users
CREATE POLICY "Admin full access" ON public.admin_users
  FOR ALL USING (public.is_admin());

-- Policy: authenticated admins can read it
CREATE POLICY "Admin read access" ON public.admin_users
  FOR SELECT USING (public.is_admin());

-- Policy: authenticated admins can insert into it
CREATE POLICY "Admin insert access" ON public.admin_users
  FOR INSERT WITH CHECK (public.is_admin());

-- Policy: authenticated admins can update it
CREATE POLICY "Admin update access" ON public.admin_users
  FOR UPDATE USING (public.is_admin());

-- Policy: authenticated admins can delete from it
CREATE POLICY "Admin delete access" ON public.admin_users
  FOR DELETE USING (public.is_admin());

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
  full_name = EXCLUDED.full_name,
  role = EXCLUDED.role;

-- Verify the setup
SELECT id, email, full_name, role, created_at FROM public.admin_users;
