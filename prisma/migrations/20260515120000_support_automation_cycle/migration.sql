ALTER TABLE public."SupportTicket"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "intakePath" JSONB,
  ADD COLUMN "intakeAnswers" JSONB,
  ADD COLUMN "assignedAdminId" TEXT,
  ADD COLUMN "assignedAdminEmail" TEXT,
  ADD COLUMN "assignedAt" TIMESTAMP(3),
  ADD COLUMN "resolvedAt" TIMESTAMP(3),
  ADD COLUMN "closedAt" TIMESTAMP(3);

ALTER TABLE public."TicketMessage"
  ADD COLUMN "messageType" TEXT NOT NULL DEFAULT 'USER_MESSAGE',
  ADD COLUMN "isCustomerVisible" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public."DriverSupportTicket"
  ADD COLUMN "bookingId" TEXT,
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "intakePath" JSONB,
  ADD COLUMN "intakeAnswers" JSONB,
  ADD COLUMN "assignedAdminId" TEXT,
  ADD COLUMN "assignedAdminEmail" TEXT,
  ADD COLUMN "assignedAt" TIMESTAMP(3),
  ADD COLUMN "resolvedAt" TIMESTAMP(3),
  ADD COLUMN "closedAt" TIMESTAMP(3);

ALTER TABLE public."DriverTicketMessage"
  ADD COLUMN "messageType" TEXT NOT NULL DEFAULT 'USER_MESSAGE',
  ADD COLUMN "isCustomerVisible" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE public."TicketAttachment" (
  "id" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "uploadedById" TEXT NOT NULL,
  "uploadedByType" TEXT NOT NULL,
  "fileUrl" TEXT NOT NULL,
  "storagePath" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "fileSize" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TicketAttachment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE public."DriverTicketAttachment" (
  "id" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "uploadedById" TEXT NOT NULL,
  "uploadedByType" TEXT NOT NULL,
  "fileUrl" TEXT NOT NULL,
  "storagePath" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "fileSize" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DriverTicketAttachment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupportTicket_status_updatedAt_idx" ON public."SupportTicket"("status", "updatedAt");
CREATE INDEX "SupportTicket_assignedAdminId_status_idx" ON public."SupportTicket"("assignedAdminId", "status");
CREATE INDEX "DriverSupportTicket_bookingId_idx" ON public."DriverSupportTicket"("bookingId");
CREATE INDEX "DriverSupportTicket_status_updatedAt_idx" ON public."DriverSupportTicket"("status", "updatedAt");
CREATE INDEX "DriverSupportTicket_assignedAdminId_status_idx" ON public."DriverSupportTicket"("assignedAdminId", "status");
CREATE INDEX "TicketAttachment_ticketId_createdAt_idx" ON public."TicketAttachment"("ticketId", "createdAt");
CREATE INDEX "TicketAttachment_messageId_idx" ON public."TicketAttachment"("messageId");
CREATE INDEX "DriverTicketAttachment_ticketId_createdAt_idx" ON public."DriverTicketAttachment"("ticketId", "createdAt");
CREATE INDEX "DriverTicketAttachment_messageId_idx" ON public."DriverTicketAttachment"("messageId");

ALTER TABLE public."DriverSupportTicket"
  ADD CONSTRAINT "DriverSupportTicket_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES public."Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE public."TicketAttachment"
  ADD CONSTRAINT "TicketAttachment_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES public."SupportTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."TicketAttachment"
  ADD CONSTRAINT "TicketAttachment_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES public."TicketMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."DriverTicketAttachment"
  ADD CONSTRAINT "DriverTicketAttachment_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES public."DriverSupportTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."DriverTicketAttachment"
  ADD CONSTRAINT "DriverTicketAttachment_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES public."DriverTicketMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."TicketAttachment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."DriverTicketAttachment" ENABLE ROW LEVEL SECURITY;

CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.is_support_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
    OR coalesce(auth.jwt() -> 'app_metadata' ->> 'admin', '') = 'true';
$$;

CREATE OR REPLACE FUNCTION private.can_access_customer_support_ticket(target_ticket_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT private.is_support_admin()
  OR EXISTS (
    SELECT 1
    FROM public."SupportTicket" t
    JOIN public."User" u ON u.id = t."userId"
    WHERE t.id = target_ticket_id
      AND lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

CREATE OR REPLACE FUNCTION private.can_access_driver_support_ticket(target_ticket_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT private.is_support_admin()
  OR EXISTS (
    SELECT 1
    FROM public."DriverSupportTicket" t
    JOIN public."Driver" d ON d.id = t."driverId"
    WHERE t.id = target_ticket_id
      AND lower(d.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

REVOKE ALL ON FUNCTION private.can_access_customer_support_ticket(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.can_access_driver_support_ticket(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.is_support_admin() FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_support_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_access_customer_support_ticket(text) TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_access_driver_support_ticket(text) TO authenticated;

DROP POLICY IF EXISTS "support ticket participants can read customer tickets" ON public."SupportTicket";
CREATE POLICY "support ticket participants can read customer tickets"
ON public."SupportTicket"
FOR SELECT
TO authenticated
USING (private.can_access_customer_support_ticket(id));

DROP POLICY IF EXISTS "support ticket participants can read customer messages" ON public."TicketMessage";
CREATE POLICY "support ticket participants can read customer messages"
ON public."TicketMessage"
FOR SELECT
TO authenticated
USING (private.can_access_customer_support_ticket("ticketId") AND ("isCustomerVisible" OR private.is_support_admin()));

DROP POLICY IF EXISTS "support ticket participants can read customer attachments" ON public."TicketAttachment";
CREATE POLICY "support ticket participants can read customer attachments"
ON public."TicketAttachment"
FOR SELECT
TO authenticated
USING (private.can_access_customer_support_ticket("ticketId"));

DROP POLICY IF EXISTS "support ticket participants can read driver tickets" ON public."DriverSupportTicket";
CREATE POLICY "support ticket participants can read driver tickets"
ON public."DriverSupportTicket"
FOR SELECT
TO authenticated
USING (private.can_access_driver_support_ticket(id));

DROP POLICY IF EXISTS "support ticket participants can read driver messages" ON public."DriverTicketMessage";
CREATE POLICY "support ticket participants can read driver messages"
ON public."DriverTicketMessage"
FOR SELECT
TO authenticated
USING (private.can_access_driver_support_ticket("ticketId") AND ("isCustomerVisible" OR private.is_support_admin()));

DROP POLICY IF EXISTS "support ticket participants can read driver attachments" ON public."DriverTicketAttachment";
CREATE POLICY "support ticket participants can read driver attachments"
ON public."DriverTicketAttachment"
FOR SELECT
TO authenticated
USING (private.can_access_driver_support_ticket("ticketId"));

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public."SupportTicket";
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public."TicketMessage";
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public."DriverSupportTicket";
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public."DriverTicketMessage";
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL;
END $$;
