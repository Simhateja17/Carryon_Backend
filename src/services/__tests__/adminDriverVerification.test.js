const {
  driverApprovalBlockers,
  normalizeDriverDecisionInput,
  updateDriverVerificationDecision,
} = require('../adminDriverVerification');

function driver(overrides = {}) {
  return {
    id: 'driver-1',
    verificationStatus: 'IN_REVIEW',
    isVerified: false,
    verificationRejectionReason: null,
    pdpaConsent: true,
    backgroundCheckConsent: true,
    noOffencesDeclared: true,
    vehicle: { id: 'vehicle-1' },
    documents: [
      { id: 'doc-1', type: 'MYKAD_FRONT', status: 'APPROVED' },
      { id: 'doc-2', type: 'MYKAD_BACK', status: 'APPROVED' },
      { id: 'doc-3', type: 'SELFIE', status: 'APPROVED' },
      { id: 'doc-4', type: 'DRIVERS_LICENSE', status: 'APPROVED' },
      { id: 'doc-5', type: 'DRIVERS_LICENSE_BACK', status: 'APPROVED' },
      { id: 'doc-6', type: 'VEHICLE_REGISTRATION', status: 'APPROVED' },
      { id: 'doc-7', type: 'VEHICLE_PHOTO_FRONT', status: 'APPROVED' },
      { id: 'doc-8', type: 'VEHICLE_PHOTO_BACK', status: 'APPROVED' },
    ],
    ...overrides,
  };
}

describe('admin driver verification decisions', () => {
  test('requires a rejection reason when rejecting a driver', () => {
    expect(() => normalizeDriverDecisionInput({
      verificationStatus: 'REJECTED',
      rejectionReason: ' ',
    })).toThrow('rejectionReason is required');
  });

  test('blocks approval until documents, vehicle, and declarations are complete', () => {
    const blockers = driverApprovalBlockers(driver({
      vehicle: null,
      pdpaConsent: false,
      documents: [{ id: 'doc-1', status: 'PENDING' }],
    }));

    expect(blockers).toEqual(expect.arrayContaining([
      'Vehicle details must be submitted before approval.',
      '1 document still pending review.',
      'Required approved documents are missing: MYKAD_FRONT, MYKAD_BACK, SELFIE, DRIVERS_LICENSE, DRIVERS_LICENSE_BACK, VEHICLE_REGISTRATION, VEHICLE_PHOTO_FRONT, VEHICLE_PHOTO_BACK.',
      'PDPA consent is missing.',
    ]));
  });

  test('approves an eligible driver and records an audit event', async () => {
    const existing = driver();
    const tx = {
      driver: {
        update: jest.fn().mockResolvedValue({ ...existing, verificationStatus: 'APPROVED', isVerified: true }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      },
    };
    const db = {
      driver: {
        findUnique: jest.fn().mockResolvedValue(existing),
      },
      $transaction: jest.fn(async (callback) => callback(tx)),
    };

    const result = await updateDriverVerificationDecision({
      db,
      driverId: 'driver-1',
      body: { verificationStatus: 'APPROVED' },
      actor: { actorId: 'admin-1', actorType: 'ADMIN' },
    });

    expect(result.isVerified).toBe(true);
    expect(db.driver.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        documents: { select: { id: true, type: true, status: true } },
      }),
    }));
    expect(tx.driver.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        verificationStatus: 'APPROVED',
        isVerified: true,
        verificationRejectionReason: null,
        verificationReviewedByAdminId: 'admin-1',
      }),
    }));
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'DRIVER_VERIFICATION_CHANGED',
        actorId: 'admin-1',
      }),
    }));
  });

  test('rejects approval for incomplete drivers', async () => {
    const db = {
      driver: {
        findUnique: jest.fn().mockResolvedValue(driver({
          documents: [{ id: 'doc-1', status: 'PENDING' }],
        })),
      },
      $transaction: jest.fn(),
    };

    await expect(updateDriverVerificationDecision({
      db,
      driverId: 'driver-1',
      body: { verificationStatus: 'APPROVED' },
      actor: { actorId: 'admin-1' },
    })).rejects.toMatchObject({ statusCode: 400 });

    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
