-- ============================================================================
-- reset-for-launch.sql
--
-- Clears ALL user/driver + transactional data so everyone re-signs up fresh,
-- while PRESERVING the reference/config tables:
--     Vehicle, AdminSetting, HelpArticle, Coupon   (+ _prisma_migrations)
--
-- This is DESTRUCTIVE and IRREVERSIBLE. Take a Supabase snapshot / pg_dump first.
--
-- This clears the Postgres application data ONLY. You MUST also purge Supabase
-- Auth identities (auth.users) or phones/emails stay registered and users can't
-- sign up fresh -> run scripts/purge-supabase-auth.js after this.
--
-- Usage (psql against your Supabase connection string):
--     psql "$DATABASE_URL" -f scripts/reset-for-launch.sql
--
-- The allowlist below is what SURVIVES. Everything else in the public schema is
-- truncated dynamically, so tables added by future migrations are cleared too
-- (fail-safe: new data tables get wiped rather than silently left behind).
-- ============================================================================

DO $$
DECLARE
    -- Tables to PRESERVE (exact PascalCase names as Prisma creates them).
    preserved text[] := ARRAY[
        'Vehicle',
        'AdminSetting',
        'HelpArticle',
        'Coupon',
        '_prisma_migrations'
    ];
    target_tables text;
BEGIN
    SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
      INTO target_tables
      FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename <> ALL (preserved);

    IF target_tables IS NULL THEN
        RAISE NOTICE 'Nothing to truncate.';
        RETURN;
    END IF;

    RAISE NOTICE 'Truncating: %', target_tables;

    -- RESTART IDENTITY resets any serial sequences; CASCADE follows FKs so we
    -- don't have to hand-order children-before-parents.
    EXECUTE 'TRUNCATE TABLE ' || target_tables || ' RESTART IDENTITY CASCADE';

    RAISE NOTICE 'Done. Preserved: %', array_to_string(preserved, ', ');
END $$;
