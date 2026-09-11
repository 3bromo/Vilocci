-- ============================================================================
-- SPINTO — Admin Setup
-- Creates admin_users table and links existing Supabase Auth user.
-- Run this ONCE in Supabase SQL Editor.
-- ============================================================================

-- Create the admin_users table (if it doesn't exist)
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

-- Drop existing policies if they exist (to avoid conflicts on re-run)
DO $$
BEGIN
  DROP POLICY IF EXISTS "Admin full access" ON public.admin_users;
  DROP POLICY IF EXISTS "Admin read access" ON public.admin_users;
  DROP POLICY IF EXISTS "Admin insert access" ON public.admin_users;
  DROP POLICY IF EXISTS "Admin update access" ON public.admin_users;
  DROP POLICY IF EXISTS "Admin delete access" ON public.admin_users;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- RLS policies: only authenticated admins can access
CREATE POLICY "Admin full access" ON public.admin_users
  FOR ALL USING (public.is_admin());

-- Link existing Supabase Auth user to admin_users
-- This inserts the user if not present, updates if already there
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

-- Verify the admin user is linked
SELECT id, email, full_name, role, created_at
FROM public.admin_users
WHERE id = '363fc336-b630-493d-8f58-b614bc4fcfc8';
