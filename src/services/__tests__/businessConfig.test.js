const config = require('../businessConfig');

describe('Business Config', () => {
  test('exports all required vehicle types', () => {
    const expectedTypes = ['BIKE', 'CAR', 'PICKUP', 'VAN_7FT', 'VAN_9FT', 'LORRY_10FT', 'LORRY_14FT', 'LORRY_17FT'];
    for (const type of expectedTypes) {
      expect(config.VEHICLE_RATE_PER_KM).toHaveProperty(type);
    }
    expect(config.VALID_VEHICLE_TYPES).toEqual(expectedTypes);
  });

  test('every vehicle type has regular, priority, and pooling rates', () => {
    for (const [type, rates] of Object.entries(config.VEHICLE_RATE_PER_KM)) {
      expect(rates).toHaveProperty('regular');
      expect(rates).toHaveProperty('priority');
      expect(rates).toHaveProperty('pooling');
      expect(rates.priority).toBeGreaterThan(rates.regular);
      expect(rates.regular).toBeGreaterThan(rates.pooling);
    }
  });

  test('driver commission rate is between 0 and 1', () => {
    expect(config.DRIVER_COMMISSION_RATE).toBeGreaterThan(0);
    expect(config.DRIVER_COMMISSION_RATE).toBeLessThanOrEqual(1);
  });

  test('driver search radius is positive', () => {
    expect(config.DRIVER_SEARCH_RADIUS_KM).toBeGreaterThan(0);
  });

  test('OTP TTL is at least 1 minute', () => {
    expect(config.DELIVERY_OTP_TTL_MS).toBeGreaterThanOrEqual(60 * 1000);
  });

  test('OTP resend cooldown is less than TTL', () => {
    expect(config.DELIVERY_OTP_RESEND_COOLDOWN_MS).toBeLessThan(config.DELIVERY_OTP_TTL_MS);
  });

  test('referral reward amount is positive', () => {
    expect(config.REFERRAL_REWARD_AMOUNT).toBeGreaterThan(0);
  });

  test('offer expiry is positive', () => {
    expect(config.OFFER_EXPIRY_MS).toBeGreaterThan(0);
  });

  test('valid payment methods includes WALLET', () => {
    expect(config.VALID_PAYMENT_METHODS).toContain('WALLET');
  });
});
