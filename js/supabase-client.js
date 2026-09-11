/* ==========================================================================
   SPINTO — Supabase client (browser)
   Uses the anon key. All sensitive writes are protected by Row Level Security.
   ========================================================================== */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// Sanitize Supabase URL: must be https://<project-ref>.supabase.co with no path
function sanitizeSupabaseUrl(url) {
  if (!url || typeof url !== 'string') return '';
  url = url.trim();
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch (e) {
    console.error('[Supabase] Invalid URL format:', url);
    return '';
  }
}

const SUPABASE_URL = sanitizeSupabaseUrl(
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_SUPABASE_URL)
  || window.__SPINTO_SUPABASE_URL
  || ''
);

const SUPABASE_ANON_KEY = (
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_SUPABASE_ANON_KEY)
  || window.__SPINTO_SUPABASE_ANON_KEY
  || ''
).trim();

let _client = null;

export function getSupabase() {
  if (_client) return _client;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn('[Supabase] Missing credentials — admin features will be unavailable.');
    return null;
  }
  _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  return _client;
}

export async function supabaseAuth() {
  const sb = getSupabase();
  if (!sb) return null;
  const { data: { session } } = await sb.auth.getSession();
  return session;
}

export async function supabaseSignIn(email, password) {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase not configured');
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function supabaseSignOut() {
  const sb = getSupabase();
  if (!sb) return;
  await sb.auth.signOut();
}
