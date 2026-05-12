describe('supabase storage object references', () => {
  test('parses stored bucket/object paths', () => {
    const { parseStorageObjectRef } = require('../supabase');

    expect(parseStorageObjectRef(
      'driver-documents/driver-1/MYKAD_FRONT_1778427960302.jpg'
    )).toEqual({
      bucket: 'driver-documents',
      path: 'driver-1/MYKAD_FRONT_1778427960302.jpg',
    });
  });

  test('parses legacy public Supabase object URLs for signing', () => {
    const { parseStorageObjectRef } = require('../supabase');

    expect(parseStorageObjectRef(
      'https://liwhjhkqlwufnbekegas.supabase.co/storage/v1/object/public/driver-documents/drivers/auth-user-1/SELFIE.jpg'
    )).toEqual({
      bucket: 'driver-documents',
      path: 'drivers/auth-user-1/SELFIE.jpg',
    });
  });

  test('parses signed Supabase object URLs back to bucket and path', () => {
    const { parseStorageObjectRef } = require('../supabase');

    expect(parseStorageObjectRef(
      'https://liwhjhkqlwufnbekegas.supabase.co/storage/v1/object/sign/driver-documents/driver-1/SELFIE.jpg?token=abc'
    )).toEqual({
      bucket: 'driver-documents',
      path: 'driver-1/SELFIE.jpg',
    });
  });

  test('rejects non-storage URLs', () => {
    const { parseStorageObjectRef } = require('../supabase');

    expect(() => parseStorageObjectRef('https://example.com/image.jpg')).toThrow(
      'Unsupported storage object URL'
    );
  });
});

describe('supabase service-role storage client', () => {
  const originalEnv = process.env;

  afterEach(() => {
    jest.resetModules();
    jest.dontMock('@supabase/supabase-js');
    process.env = originalEnv;
  });

  test('forces service role key into Authorization as well as apikey', () => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_KEY: 'service-role-key',
    };
    const createClient = jest.fn(() => ({ storage: { listBuckets: jest.fn() } }));
    jest.doMock('@supabase/supabase-js', () => ({ createClient }));

    const { getSupabaseAdmin } = require('../supabase');
    getSupabaseAdmin();

    expect(createClient).toHaveBeenCalledWith(
      'https://project.supabase.co',
      'service-role-key',
      expect.objectContaining({
        auth: {
          autoRefreshToken: false,
          detectSessionInUrl: false,
          persistSession: false,
        },
        global: {
          headers: {
            apikey: 'service-role-key',
            Authorization: 'Bearer service-role-key',
          },
        },
      })
    );
  });

  test('uses a separate service-role client for storage operations', () => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_KEY: 'service-role-key',
    };
    const createClient = jest.fn(() => ({ storage: { listBuckets: jest.fn() } }));
    jest.doMock('@supabase/supabase-js', () => ({ createClient }));

    const { getSupabaseAdmin, getSupabaseStorageAdmin } = require('../supabase');
    const generalClient = getSupabaseAdmin();
    const storageClient = getSupabaseStorageAdmin();

    expect(createClient).toHaveBeenCalledTimes(2);
    expect(generalClient).not.toBe(storageClient);
  });

  test('inspectStorageBuckets reports missing and misconfigured buckets', () => {
    const { inspectStorageBuckets } = require('../supabase');

    expect(inspectStorageBuckets([
      {
        name: 'driver-documents',
        public: true,
        file_size_limit: 10 * 1024 * 1024,
        allowed_mime_types: ['image/jpeg'],
      },
    ])).toEqual({
      bucketNames: ['driver-documents'],
      missingBuckets: ['package-images', 'extra-charge-proofs'],
      misconfiguredBuckets: [
        {
          name: 'driver-documents',
          issues: [
            'public must be false',
            'allowed MIME types are incomplete',
          ],
        },
      ],
    });
  });

  test('runStorageUploadProbe uploads and removes an allowed image object', async () => {
    const upload = jest.fn().mockResolvedValue({ error: null });
    const remove = jest.fn().mockResolvedValue({ error: null });
    const client = {
      storage: {
        from: jest.fn(() => ({ upload, remove })),
      },
    };
    const { runStorageUploadProbe } = require('../supabase');

    await expect(runStorageUploadProbe(client)).resolves.toMatchObject({
      bucket: 'driver-documents',
    });
    expect(client.storage.from).toHaveBeenCalledWith('driver-documents');
    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(/^_health\/service-role-upload-.+\.jpg$/),
      Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]),
      { contentType: 'image/jpeg', upsert: true }
    );
    expect(remove).toHaveBeenCalledWith([
      expect.stringMatching(/^_health\/service-role-upload-.+\.jpg$/),
    ]);
  });
});
