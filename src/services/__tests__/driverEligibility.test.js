const {
  documentExpiryReminderDays,
  evaluateDriverEligibility,
  isExpiredDocument,
} = require('../driverEligibility');

describe('driverEligibility', () => {
  const now = new Date('2026-05-08T00:00:00.000Z');

  test('blocks drivers missing required approved documents', () => {
    const eligibility = evaluateDriverEligibility({
      isVerified: true,
      verificationStatus: 'APPROVED',
      stripePayoutsEnabled: true,
      documents: [
        { type: 'DRIVERS_LICENSE', status: 'APPROVED', expiryDate: '2027-01-01' },
      ],
    }, now);

    expect(eligibility.canGoOnline).toBe(false);
    expect(eligibility.missingRequiredDocuments).toEqual([
      'DRIVERS_LICENSE_BACK',
      'VEHICLE_REGISTRATION',
      'VEHICLE_PHOTO_FRONT',
      'VEHICLE_PHOTO_BACK',
    ]);
  });

  test('blocks expired required documents', () => {
    const eligibility = evaluateDriverEligibility({
      isVerified: true,
      verificationStatus: 'APPROVED',
      stripePayoutsEnabled: true,
      documents: [
        { type: 'DRIVERS_LICENSE', status: 'APPROVED', expiryDate: '2027-01-01' },
        { type: 'DRIVERS_LICENSE_BACK', status: 'APPROVED', expiryDate: '2026-05-07' },
        { type: 'VEHICLE_REGISTRATION', status: 'APPROVED', expiryDate: '2027-01-01' },
        { type: 'VEHICLE_PHOTO_FRONT', status: 'APPROVED' },
        { type: 'VEHICLE_PHOTO_BACK', status: 'APPROVED' },
      ],
    }, now);

    expect(eligibility.canGoOnline).toBe(false);
    expect(eligibility.expiredDocuments).toEqual(['DRIVERS_LICENSE_BACK']);
  });

  test('allows verified driver with approved unexpired required documents', () => {
    const eligibility = evaluateDriverEligibility({
      isVerified: true,
      verificationStatus: 'APPROVED',
      stripePayoutsEnabled: true,
      documents: [
        { type: 'DRIVERS_LICENSE', status: 'APPROVED', expiryDate: '2027-01-01' },
        { type: 'DRIVERS_LICENSE_BACK', status: 'APPROVED', expiryDate: '2027-01-01' },
        { type: 'VEHICLE_REGISTRATION', status: 'APPROVED', expiryDate: '2027-01-01' },
        { type: 'VEHICLE_PHOTO_FRONT', status: 'APPROVED' },
        { type: 'VEHICLE_PHOTO_BACK', status: 'APPROVED' },
      ],
    }, now);

    expect(eligibility.canGoOnline).toBe(true);
  });

  test('blocks verified drivers until Stripe payouts are enabled', () => {
    const eligibility = evaluateDriverEligibility({
      isVerified: true,
      verificationStatus: 'APPROVED',
      stripePayoutsEnabled: false,
      stripeConnectAccountId: 'acct_123',
      stripeDetailsSubmitted: true,
      documents: [
        { type: 'DRIVERS_LICENSE', status: 'APPROVED', expiryDate: '2027-01-01' },
        { type: 'DRIVERS_LICENSE_BACK', status: 'APPROVED', expiryDate: '2027-01-01' },
        { type: 'VEHICLE_REGISTRATION', status: 'APPROVED', expiryDate: '2027-01-01' },
        { type: 'VEHICLE_PHOTO_FRONT', status: 'APPROVED' },
        { type: 'VEHICLE_PHOTO_BACK', status: 'APPROVED' },
      ],
    }, now);

    expect(eligibility.canGoOnline).toBe(false);
    expect(eligibility.status).toBe('PAYOUT_SETUP_REQUIRED');
    expect(eligibility.primaryBlocker).toMatchObject({
      code: 'STRIPE_PAYOUTS_DISABLED',
    });
    expect(eligibility.payoutRequirements).toMatchObject({
      stripeAccountId: 'acct_123',
      detailsSubmitted: true,
      payoutsEnabled: false,
    });
  });

  test('returns readiness blockers for admin review', () => {
    const eligibility = evaluateDriverEligibility({
      isVerified: false,
      verificationStatus: 'IN_REVIEW',
      stripePayoutsEnabled: false,
      documents: [],
    }, now);

    expect(eligibility.canGoOnline).toBe(false);
    expect(eligibility.status).toBe('ADMIN_REVIEW_REQUIRED');
    expect(eligibility.label).toBe('Admin review required');
    expect(eligibility.blockers.map((blocker) => blocker.code)).toEqual([
      'ADMIN_APPROVAL_REQUIRED',
      'REQUIRED_DOCUMENT_MISSING',
      'REQUIRED_DOCUMENT_MISSING',
      'REQUIRED_DOCUMENT_MISSING',
      'REQUIRED_DOCUMENT_MISSING',
      'REQUIRED_DOCUMENT_MISSING',
      'STRIPE_PAYOUTS_DISABLED',
    ]);
  });

  test('detects expiry reminders by days remaining', () => {
    expect(isExpiredDocument({ expiryDate: '2026-05-07' }, now)).toBe(true);
    expect(documentExpiryReminderDays({ expiryDate: '2026-05-22' }, now)).toBe(14);
  });
});
