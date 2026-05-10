CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.can_access_booking_chat(target_booking_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."Booking" b
    JOIN public."User" u ON u.id = b."userId"
    WHERE b.id = target_booking_id
      AND lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
  OR EXISTS (
    SELECT 1
    FROM public."Booking" b
    JOIN public."Driver" d ON d.id = b."driverId"
    WHERE b.id = target_booking_id
      AND lower(d.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

REVOKE ALL ON FUNCTION private.can_access_booking_chat(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.can_access_booking_chat(text) FROM anon;
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_access_booking_chat(text) TO authenticated;

DROP POLICY IF EXISTS "authenticated users can read their booking chat" ON public."ChatMessage";
CREATE POLICY "authenticated users can read their booking chat"
ON public."ChatMessage"
FOR SELECT
TO authenticated
USING (private.can_access_booking_chat("bookingId"));

DROP FUNCTION IF EXISTS public.can_access_booking_chat(text);
