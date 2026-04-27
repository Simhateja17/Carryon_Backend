const {
  generateDeliveryOtp,
  generatePickupOtp,
  deliveryOtpWindow,
  isDeliveryOtpActive,
  maskEmail,
  deliveryOtpPayload,
} = require('../deliveryOtp');

describe('Delivery OTP — Generation', () => {
  test('generateDeliveryOtp returns a 6-digit string', () => {
    for (let i = 0; i < 100; i++) {
      const otp = generateDeliveryOtp();
      expect(otp).toMatch(/^\d{6}$/);
      expect(Number(otp)).toBeGreaterThanOrEqual(100000);
      expect(Number(otp)).toBeLessThanOrEqual(999999);
    }
  });

  test('generatePickupOtp returns a 4-digit string', () => {
    for (let i = 0; i < 100; i++) {
      const otp = generatePickupOtp();
      expect(otp).toMatch(/^\d{4}$/);
      expect(Number(otp)).toBeGreaterThanOrEqual(1000);
      expect(Number(otp)).toBeLessThanOrEqual(9999);
    }
  });
});

describe('Delivery OTP — Window', () => {
  test('returns inactive window when sentAt is null', () => {
    const window = deliveryOtpWindow(null);
    expect(window.active).toBe(false);
    expect(window.canResend).toBe(true);
    expect(window.expiresAt).toBeNull();
  });

  test('returns active window when within TTL', () => {
    const now = new Date();
    const sentAt = new Date(now.getTime() - 5 * 60 * 1000); // 5 min ago
    const window = deliveryOtpWindow(sentAt, now);
    expect(window.active).toBe(true);
    expect(window.expiresAt).toBeInstanceOf(Date);
    expect(window.expiresAt.getTime()).toBeGreaterThan(now.getTime());
  });

  test('returns inactive window after TTL', () => {
    const now = new Date();
    const sentAt = new Date(now.getTime() - 15 * 60 * 1000); // 15 min ago
    const window = deliveryOtpWindow(sentAt, now);
    expect(window.active).toBe(false);
  });

  test('cannot resend within cooldown', () => {
    const now = new Date();
    const sentAt = new Date(now.getTime() - 10 * 1000); // 10 sec ago
    const window = deliveryOtpWindow(sentAt, now);
    expect(window.canResend).toBe(false);
  });

  test('can resend after cooldown', () => {
    const now = new Date();
    const sentAt = new Date(now.getTime() - 60 * 1000); // 60 sec ago
    const window = deliveryOtpWindow(sentAt, now);
    expect(window.canResend).toBe(true);
  });
});

describe('Delivery OTP — isDeliveryOtpActive', () => {
  test('active within TTL', () => {
    const now = new Date();
    expect(isDeliveryOtpActive(new Date(now.getTime() - 5 * 60 * 1000), now)).toBe(true);
  });

  test('inactive after TTL', () => {
    const now = new Date();
    expect(isDeliveryOtpActive(new Date(now.getTime() - 15 * 60 * 1000), now)).toBe(false);
  });

  test('inactive for null', () => {
    expect(isDeliveryOtpActive(null)).toBe(false);
  });
});

describe('Delivery OTP — Email masking', () => {
  test('masks email correctly', () => {
    expect(maskEmail('john@example.com')).toBe('jo**@example.com');
    expect(maskEmail('ab@example.com')).toBe('ab*@example.com');
    expect(maskEmail('a@example.com')).toBe('a*@example.com');
  });

  test('handles empty/invalid input', () => {
    expect(maskEmail('')).toBe('');
    expect(maskEmail(undefined)).toBe('');
  });
});

describe('Delivery OTP — Payload shaping', () => {
  test('returns correct payload shape', () => {
    const now = new Date();
    const booking = { deliveryOtpSentAt: now };
    const payload = deliveryOtpPayload({
      booking,
      recipientEmail: 'test@example.com',
      now,
      adminOtp: null,
      alreadySent: false,
    });

    expect(payload).toHaveProperty('recipientEmail');
    expect(payload).toHaveProperty('otpSentAt');
    expect(payload).toHaveProperty('otpExpiresAt');
    expect(payload).toHaveProperty('resendAvailableAt');
    expect(payload).toHaveProperty('alreadySent', false);
    expect(payload).toHaveProperty('adminOtp', null);
    expect(payload.recipientEmail).toBe('te**@example.com');
  });

  test('includes admin OTP when provided', () => {
    const now = new Date();
    const payload = deliveryOtpPayload({
      booking: { deliveryOtpSentAt: now },
      recipientEmail: '',
      now,
      adminOtp: '123456',
      alreadySent: true,
    });
    expect(payload.adminOtp).toBe('123456');
    expect(payload.alreadySent).toBe(true);
  });
});
