const { taxLiabilityDataForBooking } = require('../taxLiabilities');

describe('taxLiabilities', () => {
  test('builds a pending tax payable entry from a tax-inclusive booking total', () => {
    const { split, data } = taxLiabilityDataForBooking({
      id: 'booking-1',
      userId: 'user-1',
      finalPrice: 4.65,
    });

    expect(split.driverAmount).toBe(3.86);
    expect(split.platformFeeAmount).toBe(0.53);
    expect(data).toEqual({
      bookingId: 'booking-1',
      userId: 'user-1',
      taxableAmount: 4.39,
      taxAmount: 0.26,
      totalAmount: 4.65,
      taxRate: 0.06,
      currency: 'MYR',
      status: 'PENDING',
      source: 'BOOKING',
    });
  });
});
