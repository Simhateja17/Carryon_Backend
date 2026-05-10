-- Allow the mobile driver app to upload private driver documents using the
-- canonical backend path: driver-documents/<Driver.id>/<documentType>_<timestamp>.<ext>
--
-- The live bucket stays private. A Supabase-authenticated driver can only
-- access objects whose first path segment matches their Driver row id and
-- whose Driver.email matches the email claim in their Supabase JWT.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'driver_documents_insert_by_driver_id'
  ) THEN
    CREATE POLICY "driver_documents_insert_by_driver_id"
      ON storage.objects
      FOR INSERT
      TO authenticated
      WITH CHECK (
        bucket_id = 'driver-documents'
        AND EXISTS (
          SELECT 1
          FROM public."Driver" d
          WHERE d.id = storage.objects.path_tokens[1]
            AND lower(d.email) = lower(auth.jwt() ->> 'email')
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'driver_documents_read_by_driver_id'
  ) THEN
    CREATE POLICY "driver_documents_read_by_driver_id"
      ON storage.objects
      FOR SELECT
      TO authenticated
      USING (
        bucket_id = 'driver-documents'
        AND EXISTS (
          SELECT 1
          FROM public."Driver" d
          WHERE d.id = storage.objects.path_tokens[1]
            AND lower(d.email) = lower(auth.jwt() ->> 'email')
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'driver_documents_update_by_driver_id'
  ) THEN
    CREATE POLICY "driver_documents_update_by_driver_id"
      ON storage.objects
      FOR UPDATE
      TO authenticated
      USING (
        bucket_id = 'driver-documents'
        AND EXISTS (
          SELECT 1
          FROM public."Driver" d
          WHERE d.id = storage.objects.path_tokens[1]
            AND lower(d.email) = lower(auth.jwt() ->> 'email')
        )
      )
      WITH CHECK (
        bucket_id = 'driver-documents'
        AND EXISTS (
          SELECT 1
          FROM public."Driver" d
          WHERE d.id = storage.objects.path_tokens[1]
            AND lower(d.email) = lower(auth.jwt() ->> 'email')
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'driver_documents_delete_by_driver_id'
  ) THEN
    CREATE POLICY "driver_documents_delete_by_driver_id"
      ON storage.objects
      FOR DELETE
      TO authenticated
      USING (
        bucket_id = 'driver-documents'
        AND EXISTS (
          SELECT 1
          FROM public."Driver" d
          WHERE d.id = storage.objects.path_tokens[1]
            AND lower(d.email) = lower(auth.jwt() ->> 'email')
        )
      );
  END IF;
END $$;
