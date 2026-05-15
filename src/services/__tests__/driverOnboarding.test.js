const {
  parseOnboardingSubmission,
  submitDriverOnboarding,
} = require('../driverOnboarding');

function validSubmission(overrides = {}) {
  return {
    profile: {
      name: 'Test Driver',
      phone: '+60123456789',
      language: 'en',
      nationality: 'MALAYSIAN',
      mykadNumber: '900101011234',
      driversLicenseNumber: 'D1234567',
      licenseClass: 'D',
      addressLine1: '1 Jalan Test',
      city: 'Kuala Lumpur',
      postcode: '50000',
      state: 'KUALA_LUMPUR',
      workingStates: ['KUALA_LUMPUR'],
      emergencyContactName: 'Emergency Contact',
      emergencyContactRelation: 'Sibling',
      emergencyContactPhone: '+60129876543',
      bankName: 'Maybank',
      bankAccountNumber: '1234567890',
      bankAccountHolder: 'Test Driver',
      pdpaConsent: true,
      backgroundCheckConsent: true,
      noOffencesDeclared: true,
      agreementVersion: 'driver-partner-v1.0',
    },
    vehicle: {
      type: 'CAR',
      make: 'Honda',
      model: 'City',
      year: 2022,
      licensePlate: 'ABC1234',
      color: 'White',
      hasCommercialCover: true,
    },
    documents: [
      {
        type: 'MYKAD_FRONT',
        imageUrl: 'driver-documents/driver-1/MYKAD_FRONT_123.jpg',
      },
      {
        type: 'MYKAD_BACK',
        imageUrl: 'driver-documents/driver-1/MYKAD_BACK_123.jpg',
      },
      {
        type: 'SELFIE',
        imageUrl: 'driver-documents/driver-1/SELFIE_123.jpg',
      },
      {
        type: 'DRIVERS_LICENSE',
        imageUrl: 'driver-documents/driver-1/DRIVERS_LICENSE_123.jpg',
        expiryDate: '2027-01-01',
      },
      {
        type: 'DRIVERS_LICENSE_BACK',
        imageUrl: 'driver-documents/driver-1/DRIVERS_LICENSE_BACK_123.jpg',
        expiryDate: '2027-01-01',
      },
      {
        type: 'VEHICLE_REGISTRATION',
        imageUrl: 'driver-documents/driver-1/VEHICLE_REGISTRATION_123.jpg',
      },
      {
        type: 'VEHICLE_PHOTO_FRONT',
        imageUrl: 'driver-documents/driver-1/VEHICLE_PHOTO_FRONT_123.jpg',
      },
      {
        type: 'VEHICLE_PHOTO_BACK',
        imageUrl: 'driver-documents/driver-1/VEHICLE_PHOTO_BACK_123.jpg',
      },
    ],
    agreementAccepted: true,
    agreementVersion: 'driver-partner-v1.0',
    ...overrides,
  };
}

describe('driver onboarding service', () => {
  test('accepts a valid aggregate onboarding payload', () => {
    const parsed = parseOnboardingSubmission(validSubmission());
    expect(parsed.profile.name).toBe('Test Driver');
    expect(parsed.vehicle.type).toBe('CAR');
    expect(parsed.documents).toHaveLength(8);
  });

  test('rejects foreign driver submissions', () => {
    expect(() => parseOnboardingSubmission(validSubmission({
      profile: {
        ...validSubmission().profile,
        nationality: 'FOREIGNER',
      },
    }))).toThrow('Malaysian drivers only');
  });

  test('requires the reduced Malaysian onboarding document package', () => {
    expect(() => parseOnboardingSubmission(validSubmission({
      documents: [
        { type: 'DRIVERS_LICENSE', imageUrl: 'driver-documents/driver-1/license.jpg' },
      ],
    }))).toThrow('Missing required driver documents');
  });

  test('rejects duplicate document types', () => {
    expect(() => parseOnboardingSubmission(validSubmission({
      documents: [
        { type: 'DRIVERS_LICENSE', imageUrl: 'driver-documents/driver-1/a.jpg' },
        { type: 'DRIVERS_LICENSE', imageUrl: 'driver-documents/driver-1/b.jpg' },
      ],
    }))).toThrow('Duplicate document type');
  });

  test('rejects public document URLs', async () => {
    const documents = validSubmission().documents.map((document) => ({ ...document }));
    documents[0] = { ...documents[0], imageUrl: 'https://example.com/license.jpg' };
    await expect(submitDriverOnboarding('driver-1', validSubmission({
      documents,
    }), { db: {} })).rejects.toMatchObject({
      message: 'Public document URLs are not accepted. Submit storage object paths only.',
      statusCode: 400,
    });
  });

  test('persists driver, vehicle, documents, snapshot, and audit in one transaction', async () => {
    const tx = {
      driver: {
        findUnique: jest.fn()
          .mockResolvedValueOnce({ id: 'driver-1', verificationStatus: 'PENDING', isVerified: false })
          .mockResolvedValueOnce({ id: 'driver-1', documents: [], vehicle: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      driverVehicle: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      driverDocument: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      driverOnboardingSubmission: {
        create: jest.fn().mockResolvedValue({ id: 'submission-1' }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const db = {
      $transaction: jest.fn((fn) => fn(tx)),
    };

    await submitDriverOnboarding('driver-1', validSubmission(), { db });

    expect(tx.driver.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'driver-1' },
      data: expect.objectContaining({
        verificationStatus: 'IN_REVIEW',
        mykadNumber: '900101011234',
        bankAccountNumber: '1234567890',
      }),
    }));
    expect(tx.driverVehicle.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { driverId: 'driver-1' },
      create: expect.objectContaining({ driverId: 'driver-1', type: 'CAR' }),
    }));
    expect(tx.driverDocument.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { driverId_type: { driverId: 'driver-1', type: 'DRIVERS_LICENSE' } },
    }));
    expect(tx.driverDocument.upsert).toHaveBeenCalledTimes(8);
    expect(tx.driverOnboardingSubmission.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ driverId: 'driver-1', agreementVersion: 'driver-partner-v1.0' }),
    }));
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'DRIVER_ONBOARDING_SUBMITTED' }),
    }));
  });
});
