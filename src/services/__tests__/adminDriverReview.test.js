const {
  detailProjection,
  driverListProjection,
  listDriverReviewCandidates,
  reviewCandidateOrderBy,
  reviewCandidateWhere,
  signDriverDocuments,
} = require('../adminDriverReview');

function driver(overrides = {}) {
  return {
    id: 'driver-1',
    name: 'Driver One',
    email: 'driver@example.com',
    phone: '+60123456789',
    photo: null,
    isOnline: false,
    isVerified: false,
    verificationStatus: 'PENDING',
    rating: 0,
    totalTrips: 0,
    emergencyContact: '',
    stripeConnectAccountId: null,
    stripeDetailsSubmitted: false,
    stripePayoutsEnabled: false,
    stripeRequirements: null,
    createdAt: new Date('2026-05-10T00:00:00Z'),
    onboardingSubmittedAt: null,
    documents: [
      { id: 'doc-1', type: 'DRIVERS_LICENSE', status: 'PENDING' },
      { id: 'doc-2', type: 'INSURANCE', status: 'APPROVED' },
    ],
    pushDevices: [],
    vehicle: { id: 'vehicle-1', type: 'CAR', make: 'Honda', model: 'City' },
    onboardingSubmissions: [],
    mykadNumber: '900101011234',
    bankAccountNumber: '1234567890',
    ...overrides,
  };
}

describe('admin driver review read model', () => {
  test('review queue includes legacy unverified drivers without onboardingSubmittedAt', async () => {
    const db = {
      driver: {
        findMany: jest.fn().mockResolvedValue([driver()]),
      },
    };

    const result = await listDriverReviewCandidates({ db });

    expect(db.driver.findMany).toHaveBeenCalledWith({
      where: reviewCandidateWhere(),
      include: expect.any(Object),
      orderBy: reviewCandidateOrderBy(),
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({
      id: 'driver-1',
      documentsCount: 2,
      documentsApproved: 1,
      documentsPending: 1,
      reviewSource: 'LEGACY_UNVERIFIED',
      onlineReadiness: expect.objectContaining({
        canGoOnline: false,
        status: 'ADMIN_REVIEW_REQUIRED',
      }),
    }));
  });

  test('list projection exposes payout setup blocker for approved existing drivers', () => {
    const projected = driverListProjection(driver({
      isVerified: true,
      verificationStatus: 'APPROVED',
      documents: [
        { id: 'doc-1', type: 'DRIVERS_LICENSE', status: 'APPROVED', expiryDate: '2027-01-01' },
        { id: 'doc-2', type: 'DRIVERS_LICENSE_BACK', status: 'APPROVED', expiryDate: '2027-01-01' },
        { id: 'doc-3', type: 'VEHICLE_REGISTRATION', status: 'APPROVED' },
        { id: 'doc-4', type: 'VEHICLE_PHOTO_FRONT', status: 'APPROVED' },
        { id: 'doc-5', type: 'VEHICLE_PHOTO_BACK', status: 'APPROVED' },
      ],
    }));

    expect(projected.onlineReadiness).toMatchObject({
      canGoOnline: false,
      status: 'PAYOUT_SETUP_REQUIRED',
      primaryBlocker: { code: 'STRIPE_PAYOUTS_DISABLED' },
    });
  });

  test('submitted drivers are marked as submitted onboarding review source', () => {
    const projected = driverListProjection(driver({
      onboardingSubmittedAt: new Date('2026-05-11T00:00:00Z'),
    }));

    expect(projected.reviewSource).toBe('SUBMITTED_ONBOARDING');
  });

  test('detail projection masks sensitive fields by default', () => {
    const projected = detailProjection(driver());

    expect(projected.sensitive.mykadNumber).toEqual({
      masked: '********1234',
      hasValue: true,
    });
    expect(projected.sensitive.bankAccountNumber).toEqual({
      masked: '******7890',
      hasValue: true,
    });
    expect(projected).not.toHaveProperty('mykadNumber');
    expect(projected).not.toHaveProperty('bankAccountNumber');
  });

  test('signs every document image reference before admin display', async () => {
    const imageUrl = 'https://liwhjhkqlwufnbekegas.supabase.co/storage/v1/object/public/driver-documents/drivers/auth-user-1/SELFIE.jpg';
    const record = driver({
      documents: [
        {
          id: 'doc-1',
          type: 'SELFIE',
          status: 'PENDING',
          imageUrl,
        },
      ],
    });
    const sign = jest.fn().mockResolvedValue('https://signed.example/doc-1');

    await signDriverDocuments(record, { sign });

    expect(sign).toHaveBeenCalledWith(imageUrl, 3600);
    expect(record.documents[0].imageUrl).toBe('https://signed.example/doc-1');
  });
});
