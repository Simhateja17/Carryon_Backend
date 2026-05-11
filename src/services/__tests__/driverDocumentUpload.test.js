const {
  fileLooksLikeSupportedDriverDocument,
  uploadDriverDocument,
} = require('../driverDocumentUpload');

const jpegFile = {
  mimetype: 'image/jpeg',
  buffer: Buffer.from([0xFF, 0xD8, 0xFF, 0x00, 0x01]),
};

describe('driver document upload service', () => {
  test('uploads through backend storage and upserts canonical object path', async () => {
    const upload = jest.fn().mockResolvedValue('driver-documents/driver-1/MYKAD_FRONT_123.jpg');
    const documents = {
      upsert: jest.fn().mockResolvedValue({
        id: 'doc-1',
        driverId: 'driver-1',
        type: 'MYKAD_FRONT',
        imageUrl: 'driver-documents/driver-1/MYKAD_FRONT_123.jpg',
        expiryDate: null,
        status: 'PENDING',
      }),
    };

    const result = await uploadDriverDocument({
      driverId: 'driver-1',
      file: jpegFile,
      type: 'MYKAD_FRONT',
      upload,
      documents,
      now: () => 123,
    });

    expect(upload).toHaveBeenCalledWith('driver-documents', jpegFile, 'driver-1/MYKAD_FRONT_123.jpg', { upsert: true });
    expect(documents.upsert).toHaveBeenCalledWith({
      where: { driverId_type: { driverId: 'driver-1', type: 'MYKAD_FRONT' } },
      update: expect.objectContaining({
        imageUrl: 'driver-documents/driver-1/MYKAD_FRONT_123.jpg',
        status: 'PENDING',
        rejectionReason: null,
      }),
      create: expect.objectContaining({
        driverId: 'driver-1',
        type: 'MYKAD_FRONT',
        imageUrl: 'driver-documents/driver-1/MYKAD_FRONT_123.jpg',
      }),
    });
    expect(result.status).toBe('PENDING');
  });

  test('rejects invalid document types before storage upload', async () => {
    const upload = jest.fn();

    await expect(uploadDriverDocument({
      driverId: 'driver-1',
      file: jpegFile,
      type: 'UNKNOWN',
      upload,
    })).rejects.toMatchObject({
      message: 'Invalid document type',
      statusCode: 400,
    });

    expect(upload).not.toHaveBeenCalled();
  });

  test('rejects files whose bytes are not an image', async () => {
    await expect(uploadDriverDocument({
      driverId: 'driver-1',
      file: { mimetype: 'image/jpeg', buffer: Buffer.from('not-an-image') },
      type: 'MYKAD_BACK',
      upload: jest.fn(),
    })).rejects.toMatchObject({
      message: 'File is not a valid image',
      statusCode: 400,
    });
  });

  test('stores using the detected MIME type instead of client-supplied metadata', async () => {
    const upload = jest.fn().mockResolvedValue('driver-documents/driver-1/MYKAD_BACK_456.heic');
    const documents = {
      upsert: jest.fn().mockResolvedValue({
        id: 'doc-2',
        driverId: 'driver-1',
        type: 'MYKAD_BACK',
        imageUrl: 'driver-documents/driver-1/MYKAD_BACK_456.heic',
        status: 'PENDING',
      }),
    };
    const heicBytes = Buffer.from([
      0x00, 0x00, 0x00, 0x18,
      0x66, 0x74, 0x79, 0x70,
      0x68, 0x65, 0x69, 0x63,
    ]);

    await uploadDriverDocument({
      driverId: 'driver-1',
      file: { mimetype: 'image/jpeg', buffer: heicBytes, originalname: 'mykad.jpg' },
      type: 'MYKAD_BACK',
      upload,
      documents,
      now: () => 456,
    });

    expect(upload).toHaveBeenCalledWith(
      'driver-documents',
      expect.objectContaining({ mimetype: 'image/heic' }),
      'driver-1/MYKAD_BACK_456.heic',
      { upsert: true }
    );
  });

  test('accepts supported image extensions when mobile MIME metadata is generic', () => {
    expect(fileLooksLikeSupportedDriverDocument({
      mimetype: 'application/octet-stream',
      originalname: 'mykad-back.HEIC',
    })).toBe(true);
    expect(fileLooksLikeSupportedDriverDocument({
      mimetype: 'application/octet-stream',
      originalname: 'payload.txt',
    })).toBe(false);
  });

  test('converts storage failures into sanitized upload errors', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const upload = jest.fn().mockRejectedValue(Object.assign(new Error('row-level security token secret'), {
      name: 'StorageApiError',
      statusCode: 403,
    }));

    await expect(uploadDriverDocument({
      driverId: 'driver-1',
      file: jpegFile,
      type: 'SELFIE',
      upload,
    })).rejects.toMatchObject({
      message: 'Failed to upload document',
      statusCode: 500,
    });
    expect(errorSpy).toHaveBeenCalledWith(
      '[driver-documents] storage upload failed',
      expect.stringContaining('"name":"StorageApiError"')
    );
    expect(errorSpy.mock.calls[0][1]).not.toContain('token secret');
    errorSpy.mockRestore();
  });
});
