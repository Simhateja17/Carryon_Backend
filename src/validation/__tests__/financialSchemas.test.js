const { parseBody } = require('../../lib/validation');
const {
  bookingCreateSchema,
  driverWithdrawSchema,
  walletPaySchema,
  walletTopupIntentSchema,
} = require('../financialSchemas');

describe('financial request schemas', () => {
  test('accepts numeric strings for money amounts and rejects non-positive amounts', () => {
    expect(parseBody(walletTopupIntentSchema, { amount: '25.50' })).toEqual({ amount: 25.5 });
    expect(() => parseBody(driverWithdrawSchema, { amount: 0 })).toThrow('Invalid request payload');
  });

  test('requires wallet payment booking ids', () => {
    expect(() => parseBody(walletPaySchema, { bookingId: '' })).toThrow('Invalid request payload');
  });

  test('strips client-owned pricing fields from booking creation', () => {
    const parsed = parseBody(bookingCreateSchema, {
      pickupAddress: { address: 'A', latitude: 3.1, longitude: 101.1 },
      deliveryAddress: { address: 'B', latitude: 3.2, longitude: 101.2 },
      offloading: 'false',
      estimatedPrice: 1,
      distance: 1,
      duration: 1,
    });

    expect(parsed.offloading).toBe(false);
    expect(parsed).not.toHaveProperty('estimatedPrice');
    expect(parsed).not.toHaveProperty('distance');
    expect(parsed).not.toHaveProperty('duration');
  });
});
