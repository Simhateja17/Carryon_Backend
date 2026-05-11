const { parseStorageObjectRef } = require('../supabase');

describe('supabase storage object references', () => {
  test('parses stored bucket/object paths', () => {
    expect(parseStorageObjectRef(
      'driver-documents/driver-1/MYKAD_FRONT_1778427960302.jpg'
    )).toEqual({
      bucket: 'driver-documents',
      path: 'driver-1/MYKAD_FRONT_1778427960302.jpg',
    });
  });

  test('parses legacy public Supabase object URLs for signing', () => {
    expect(parseStorageObjectRef(
      'https://liwhjhkqlwufnbekegas.supabase.co/storage/v1/object/public/driver-documents/drivers/auth-user-1/SELFIE.jpg'
    )).toEqual({
      bucket: 'driver-documents',
      path: 'drivers/auth-user-1/SELFIE.jpg',
    });
  });

  test('parses signed Supabase object URLs back to bucket and path', () => {
    expect(parseStorageObjectRef(
      'https://liwhjhkqlwufnbekegas.supabase.co/storage/v1/object/sign/driver-documents/driver-1/SELFIE.jpg?token=abc'
    )).toEqual({
      bucket: 'driver-documents',
      path: 'driver-1/SELFIE.jpg',
    });
  });

  test('rejects non-storage URLs', () => {
    expect(() => parseStorageObjectRef('https://example.com/image.jpg')).toThrow(
      'Unsupported storage object URL'
    );
  });
});
