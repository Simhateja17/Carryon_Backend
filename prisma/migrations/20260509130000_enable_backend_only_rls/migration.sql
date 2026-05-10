-- CarryOn uses Express as the authoritative data access Module.
-- RLS is enabled here to deny direct Supabase table access for anon/authenticated
-- clients while preserving backend access through the Postgres/service roles.

ALTER TABLE public."_prisma_migrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Otp" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Address" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Vehicle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Driver" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Booking" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Coupon" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."UserCoupon" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Referral" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ChatMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Wallet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."WalletTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SupportTicket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."TicketMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Invoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."DriverDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."DriverVehicle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."DriverWallet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."DriverWalletTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."DriverNotification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."DriverSupportTicket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."DriverTicketMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."HelpArticle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."BookingRejection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."RevokedToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."AdminAuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PushDevice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."WalletTopUpPayment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."DriverPayout" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."DeliveryLifecycleEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."IdempotencyKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."WebhookEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."DriverOnlineSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."BookingExtraCharge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."BookingAdjustment" ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.can_access_booking_chat(target_booking_id text)
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

REVOKE ALL ON FUNCTION public.can_access_booking_chat(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_access_booking_chat(text) TO authenticated;

DROP POLICY IF EXISTS "authenticated users can read their booking chat" ON public."ChatMessage";
CREATE POLICY "authenticated users can read their booking chat"
ON public."ChatMessage"
FOR SELECT
TO authenticated
USING (public.can_access_booking_chat("bookingId"));
