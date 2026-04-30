const {
  canTransition,
  isTerminal,
  canUserCancel,
  canDriverCancel,
  isSettlementEligible,
  money,
  isDeliveryOtpActive,
  ALLOWED_TRANSITIONS,
} = require('../bookingLifecycle');

describe('Booking Lifecycle — State Machine', () => {
  test('SEARCHING_DRIVER → DRIVER_ASSIGNED is allowed', () => {
    expect(canTransition('SEARCHING_DRIVER', 'DRIVER_ASSIGNED')).toBe(true);
  });

  test('SEARCHING_DRIVER → CANCELLED is allowed', () => {
    expect(canTransition('SEARCHING_DRIVER', 'CANCELLED')).toBe(true);
  });

  test('SEARCHING_DRIVER → DELIVERED is rejected', () => {
    expect(canTransition('SEARCHING_DRIVER', 'DELIVERED')).toBe(false);
  });

  test('DELIVERED → any is rejected (terminal)', () => {
    expect(canTransition('DELIVERED', 'CANCELLED')).toBe(false);
    expect(canTransition('DELIVERED', 'IN_TRANSIT')).toBe(false);
  });

  test('CANCELLED → any is rejected (terminal)', () => {
    expect(canTransition('CANCELLED', 'SEARCHING_DRIVER')).toBe(false);
  });

  test('IN_TRANSIT → ARRIVED_AT_DROP is allowed before delivery', () => {
    expect(canTransition('IN_TRANSIT', 'ARRIVED_AT_DROP')).toBe(true);
    expect(canTransition('ARRIVED_AT_DROP', 'DELIVERED')).toBe(true);
    expect(canTransition('IN_TRANSIT', 'DELIVERED')).toBe(false);
  });

  test('DRIVER_ASSIGNED → SEARCHING_DRIVER is allowed (driver cancel re-queues)', () => {
    expect(canTransition('DRIVER_ASSIGNED', 'SEARCHING_DRIVER')).toBe(true);
  });

  test('isTerminal correctly identifies terminal states', () => {
    expect(isTerminal('DELIVERED')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(isTerminal('IN_TRANSIT')).toBe(false);
    expect(isTerminal('SEARCHING_DRIVER')).toBe(false);
  });

  test('every status has an entry in ALLOWED_TRANSITIONS', () => {
    const allStatuses = [
      'PENDING', 'SEARCHING_DRIVER', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVED',
      'PICKUP_DONE', 'IN_TRANSIT', 'ARRIVED_AT_DROP', 'DELIVERED', 'CANCELLED',
    ];
    for (const status of allStatuses) {
      expect(ALLOWED_TRANSITIONS).toHaveProperty(status);
    }
  });
});

describe('Booking Lifecycle — Cancellation rules', () => {
  test('user can cancel SEARCHING_DRIVER', () => {
    expect(canUserCancel('SEARCHING_DRIVER')).toBe(true);
  });

  test('user cannot cancel DELIVERED', () => {
    expect(canUserCancel('DELIVERED')).toBe(false);
  });

  test('user cannot cancel CANCELLED', () => {
    expect(canUserCancel('CANCELLED')).toBe(false);
  });

  test('driver can cancel DRIVER_ASSIGNED', () => {
    expect(canDriverCancel('DRIVER_ASSIGNED')).toBe(true);
  });

  test('driver can cancel DRIVER_ARRIVED', () => {
    expect(canDriverCancel('DRIVER_ARRIVED')).toBe(true);
  });

  test('driver cannot cancel PICKUP_DONE', () => {
    expect(canDriverCancel('PICKUP_DONE')).toBe(false);
  });

  test('driver cannot cancel IN_TRANSIT', () => {
    expect(canDriverCancel('IN_TRANSIT')).toBe(false);
  });

  test('driver cannot cancel DELIVERED', () => {
    expect(canDriverCancel('DELIVERED')).toBe(false);
  });
});

describe('Booking Lifecycle — Settlement eligibility', () => {
  test('eligible when DELIVERED with all fields', () => {
    expect(isSettlementEligible({
      status: 'DELIVERED',
      deliveredAt: new Date(),
      deliveryOtpVerifiedAt: new Date(),
      paymentStatus: 'COMPLETED',
    })).toBe(true);
  });

  test('not eligible without deliveredAt', () => {
    expect(isSettlementEligible({
      status: 'DELIVERED',
      deliveredAt: null,
      deliveryOtpVerifiedAt: new Date(),
      paymentStatus: 'COMPLETED',
    })).toBe(false);
  });

  test('not eligible without OTP verification', () => {
    expect(isSettlementEligible({
      status: 'DELIVERED',
      deliveredAt: new Date(),
      deliveryOtpVerifiedAt: null,
      paymentStatus: 'COMPLETED',
    })).toBe(false);
  });

  test('not eligible for non-DELIVERED status', () => {
    expect(isSettlementEligible({
      status: 'IN_TRANSIT',
      deliveredAt: new Date(),
      deliveryOtpVerifiedAt: new Date(),
      paymentStatus: 'COMPLETED',
    })).toBe(false);
  });
});

describe('Booking Lifecycle — Helpers', () => {
  test('money rounds to 2 decimal places', () => {
    expect(money(1.006)).toBe(1.01);
    expect(money(1.004)).toBe(1.0);
    expect(money(null)).toBe(0);
  });

  test('isDeliveryOtpActive returns true within TTL', () => {
    const now = new Date();
    const sentAt = new Date(now.getTime() - 5 * 60 * 1000); // 5 min ago
    expect(isDeliveryOtpActive(sentAt, now)).toBe(true);
  });

  test('isDeliveryOtpActive returns false after TTL', () => {
    const now = new Date();
    const sentAt = new Date(now.getTime() - 15 * 60 * 1000); // 15 min ago
    expect(isDeliveryOtpActive(sentAt, now)).toBe(false);
  });

  test('isDeliveryOtpActive returns false for null', () => {
    expect(isDeliveryOtpActive(null)).toBe(false);
  });
});
