-- Fix support chat real-time: is_support_admin() was checking app_metadata
-- but admin role lives in user_metadata. Also set REPLICA IDENTITY FULL
-- so Supabase Realtime can deliver UPDATE events through RLS.

-- 1. Fix is_support_admin() to check both app_metadata AND user_metadata
CREATE OR REPLACE FUNCTION private.is_support_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
    OR coalesce(auth.jwt() -> 'app_metadata' ->> 'admin', '') = 'true'
    OR coalesce(auth.jwt() -> 'user_metadata' ->> 'role', '') = 'admin';
$$;

-- 2. Backfill raw_app_meta_data for existing admin users so future JWTs
--    carry the role in app_metadata (the canonical location for server-set claims)
UPDATE auth.users
SET raw_app_meta_data = raw_app_meta_data || '{"role": "admin"}'::jsonb
WHERE raw_user_meta_data ->> 'role' = 'admin'
  AND coalesce(raw_app_meta_data ->> 'role', '') <> 'admin';

-- 3. Set REPLICA IDENTITY FULL on support tables so Supabase Realtime
--    can evaluate RLS policies on UPDATE events (default identity only
--    includes the PK, which is insufficient for column-level RLS checks)
ALTER TABLE public."SupportTicket" REPLICA IDENTITY FULL;
ALTER TABLE public."TicketMessage" REPLICA IDENTITY FULL;
ALTER TABLE public."DriverSupportTicket" REPLICA IDENTITY FULL;
ALTER TABLE public."DriverTicketMessage" REPLICA IDENTITY FULL;
