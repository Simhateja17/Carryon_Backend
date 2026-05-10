-- Allow legacy driver mobile builds that uploaded under:
-- driver-documents/drivers/<Driver.id>/<documentType>_<timestamp>.<ext>
-- New builds use the canonical:
-- driver-documents/<Driver.id>/<documentType>_<timestamp>.<ext>

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'driver_documents_insert_legacy_driver_id'
  ) THEN
    CREATE POLICY "driver_documents_insert_legacy_driver_id"
      ON storage.objects
      FOR INSERT
      TO authenticated
      WITH CHECK (
        bucket_id = 'driver-documents'
        AND storage.objects.path_tokens[1] = 'drivers'
        AND EXISTS (
          SELECT 1
          FROM public."Driver" d
          WHERE d.id = storage.objects.path_tokens[2]
            AND lower(d.email) = lower(auth.jwt() ->> 'email')
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'driver_documents_read_legacy_driver_id'
  ) THEN
    CREATE POLICY "driver_documents_read_legacy_driver_id"
      ON storage.objects
      FOR SELECT
      TO authenticated
      USING (
        bucket_id = 'driver-documents'
        AND storage.objects.path_tokens[1] = 'drivers'
        AND EXISTS (
          SELECT 1
          FROM public."Driver" d
          WHERE d.id = storage.objects.path_tokens[2]
            AND lower(d.email) = lower(auth.jwt() ->> 'email')
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'driver_documents_update_legacy_driver_id'
  ) THEN
    CREATE POLICY "driver_documents_update_legacy_driver_id"
      ON storage.objects
      FOR UPDATE
      TO authenticated
      USING (
        bucket_id = 'driver-documents'
        AND storage.objects.path_tokens[1] = 'drivers'
        AND EXISTS (
          SELECT 1
          FROM public."Driver" d
          WHERE d.id = storage.objects.path_tokens[2]
            AND lower(d.email) = lower(auth.jwt() ->> 'email')
        )
      )
      WITH CHECK (
        bucket_id = 'driver-documents'
        AND storage.objects.path_tokens[1] = 'drivers'
        AND EXISTS (
          SELECT 1
          FROM public."Driver" d
          WHERE d.id = storage.objects.path_tokens[2]
            AND lower(d.email) = lower(auth.jwt() ->> 'email')
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'driver_documents_delete_legacy_driver_id'
  ) THEN
    CREATE POLICY "driver_documents_delete_legacy_driver_id"
      ON storage.objects
      FOR DELETE
      TO authenticated
      USING (
        bucket_id = 'driver-documents'
        AND storage.objects.path_tokens[1] = 'drivers'
        AND EXISTS (
          SELECT 1
          FROM public."Driver" d
          WHERE d.id = storage.objects.path_tokens[2]
            AND lower(d.email) = lower(auth.jwt() ->> 'email')
        )
      );
  END IF;
END $$;
