const {
  invoiceAmountsForBooking,
  upsertPickupWaitTimeAdjustmentTx,
} = require('../bookingAdjustments');

describe('bookingAdjustments', () => {
  test('invoice totals include applied booking adjustments without mutating base fare', () => {
    const booking = { finalPrice: 20, estimatedPrice: 18 };
    const amounts = invoiceAmountsForBooking(booking, [
      { amount: 1.5, status: 'APPLIED' },
      { amount: 4, status: 'PENDING' },
    ]);

    expect(amounts).toEqual({
      baseFare: 20,
      adjustmentsTotal: 1.5,
      subtotal: 20.28,
      tax: 1.22,
      total: 21.5,
      taxRate: 0.06,
    });
  });

  test('pickup wait-time adjustment is idempotent by booking and type', async () => {
    const tx = {
      bookingAdjustment: {
        upsert: jest.fn().mockResolvedValue({ id: 'adjustment-1' }),
      },
    };

    await upsertPickupWaitTimeAdjustmentTx(tx, {
      bookingId: 'booking-1',
      waitTimeMinutes: 8,
      waitTimeCharge: 1.5,
    });

    expect(tx.bookingAdjustment.upsert).toHaveBeenCalledWith({
      where: {
        bookingId_type: {
          bookingId: 'booking-1',
          type: 'PICKUP_WAIT_TIME',
        },
      },
      create: expect.objectContaining({
        bookingId: 'booking-1',
        type: 'PICKUP_WAIT_TIME',
        amount: 1.5,
        metadata: { waitTimeMinutes: 8 },
      }),
      update: expect.objectContaining({
        amount: 1.5,
        metadata: { waitTimeMinutes: 8 },
      }),
    });
  });
});
