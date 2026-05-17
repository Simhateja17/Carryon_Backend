const {
  createAdminDriverRegistration,
  parseAdminDriverRegistration,
} = require('../adminDriverRegistration');

describe('admin driver registration', () => {
  const validPayload = {
    name: 'Nur Aisyah',
    email: 'Driver@Example.com',
    phone: '+60123456789',
    dateOfBirth: '1990-01-01',
    governmentId: '900101-01-1234',
    addressLine1: '12 Jalan Ampang',
  };

  test('normalizes a valid registration payload', () => {
    expect(parseAdminDriverRegistration(validPayload)).toEqual(expect.objectContaining({
      name: 'Nur Aisyah',
      email: 'driver@example.com',
      phone: '+60123456789',
      governmentId: '900101-01-1234',
    }));
  });

  test('rejects extra fields before persistence', () => {
    expect(() => parseAdminDriverRegistration({
      ...validPayload,
      isVerified: true,
    })).toThrow('Invalid driver registration');
  });

  test('creates a pending driver draft with wallet and audit entry', async () => {
    const createdDriver = {
      id: 'driver-1',
      name: 'Nur Aisyah',
      email: 'driver@example.com',
      phone: '+60123456789',
      isOnline: false,
      isVerified: false,
      verificationStatus: 'PENDING',
      rating: 0,
      totalTrips: 0,
      emergencyContact: '',
      createdAt: new Date('2026-05-17T00:00:00Z'),
      onboardingSubmittedAt: null,
      documents: [],
      vehicle: null,
      pushDevices: [],
    };
    const tx = {
      driver: {
        create: jest.fn().mockResolvedValue(createdDriver),
      },
      driverWallet: {
        create: jest.fn().mockResolvedValue({ id: 'wallet-1' }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      },
    };
    const db = {
      $transaction: jest.fn(async (callback) => callback(tx)),
    };

    const result = await createAdminDriverRegistration({
      db,
      body: validPayload,
      actor: { actorId: 'admin-1', actorType: 'ADMIN' },
    });

    expect(result).toBe(createdDriver);
    expect(tx.driver.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        email: 'driver@example.com',
        nationality: 'MALAYSIAN',
        verificationStatus: 'PENDING',
        isVerified: false,
      }),
    }));
    expect(tx.driverWallet.create).toHaveBeenCalledWith({ data: { driverId: 'driver-1' } });
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        actorId: 'admin-1',
        actorType: 'ADMIN',
        action: 'ADMIN_DRIVER_REGISTERED',
        entityId: 'driver-1',
      }),
    }));
  });
});
