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
      documents: [
        { type: 'DRIVERS_LICENSE', status: 'APPROVED', expiryDate: '2027-01-01' },
      ],
    }, now);

    expect(eligibility.canGoOnline).toBe(false);
    expect(eligibility.missingRequiredDocuments).toEqual(['ROAD_TAX', 'INSURANCE']);
  });

  test('blocks expired required documents', () => {
    const eligibility = evaluateDriverEligibility({
      isVerified: true,
      verificationStatus: 'APPROVED',
      documents: [
        { type: 'DRIVERS_LICENSE', status: 'APPROVED', expiryDate: '2027-01-01' },
        { type: 'ROAD_TAX', status: 'APPROVED', expiryDate: '2026-05-07' },
        { type: 'INSURANCE', status: 'APPROVED', expiryDate: '2027-01-01' },
      ],
    }, now);

    expect(eligibility.canGoOnline).toBe(false);
    expect(eligibility.expiredDocuments).toEqual(['ROAD_TAX']);
  });

  test('allows verified driver with approved unexpired required documents', () => {
    const eligibility = evaluateDriverEligibility({
      isVerified: true,
      verificationStatus: 'APPROVED',
      documents: [
        { type: 'DRIVERS_LICENSE', status: 'APPROVED', expiryDate: '2027-01-01' },
        { type: 'ROAD_TAX', status: 'APPROVED', expiryDate: '2027-01-01' },
        { type: 'INSURANCE', status: 'APPROVED', expiryDate: '2027-01-01' },
      ],
    }, now);

    expect(eligibility.canGoOnline).toBe(true);
  });

  test('detects expiry reminders by days remaining', () => {
    expect(isExpiredDocument({ expiryDate: '2026-05-07' }, now)).toBe(true);
    expect(documentExpiryReminderDays({ expiryDate: '2026-05-22' }, now)).toBe(14);
  });
});
