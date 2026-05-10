const {
  computeCancellationOutcome,
  computePickupWaitCharge,
  isRegularBookingMode,
} = require('../bookingPolicy');

describe('bookingPolicy', () => {
  test('treats missing and regular modes as MVP-compatible', () => {
    expect(isRegularBookingMode(undefined)).toBe(true);
    expect(isRegularBookingMode('Regular')).toBe(true);
    expect(isRegularBookingMode('pooling')).toBe(false);
    expect(isRegularBookingMode('Priority')).toBe(false);
  });

  test('does not charge customer cancellation before assignment grace window', () => {
    const now = new Date('2026-05-08T10:03:00.000Z');
    const outcome = computeCancellationOutcome({
      now,
      actorType: 'USER',
      booking: {
        vehicleType: 'CAR',
        finalPrice: 20,
        driverId: 'driver-1',
        driverAssignedAt: new Date('2026-05-08T10:01:00.001Z'),
      },
    });

    expect(outcome.feeApplies).toBe(false);
    expect(outcome.refundAmount).toBe(20);
  });

  test('charges customer cancellation after assignment grace window and splits fee', () => {
    const now = new Date('2026-05-08T10:03:00.000Z');
    const outcome = computeCancellationOutcome({
      now,
      actorType: 'USER',
      booking: {
        vehicleType: 'VAN_7FT',
        finalPrice: 30,
        driverId: 'driver-1',
        driverAssignedAt: new Date('2026-05-08T10:00:00.000Z'),
      },
    });

    expect(outcome.feeApplies).toBe(true);
    expect(outcome.fee).toBe(5);
    expect(outcome.driverShare).toBe(3.5);
    expect(outcome.platformShare).toBe(1.5);
    expect(outcome.refundAmount).toBe(25);
  });

  test('does not charge when driver cancels', () => {
    const outcome = computeCancellationOutcome({
      actorType: 'DRIVER',
      booking: {
        vehicleType: 'LORRY_10FT',
        finalPrice: 40,
        driverId: 'driver-1',
        driverAssignedAt: new Date('2026-05-08T10:00:00.000Z'),
      },
    });

    expect(outcome.feeApplies).toBe(false);
    expect(outcome.refundAmount).toBe(40);
  });

  test('computes pickup wait charge after free window and cap', () => {
    expect(computePickupWaitCharge({
      arrivedAt: new Date('2026-05-08T10:00:00.000Z'),
      pickedUpAt: new Date('2026-05-08T10:08:00.000Z'),
    })).toEqual({ waitTimeMinutes: 8, billableMinutes: 3, waitTimeCharge: 1.5 });

    expect(computePickupWaitCharge({
      arrivedAt: new Date('2026-05-08T10:00:00.000Z'),
      pickedUpAt: new Date('2026-05-08T10:40:00.000Z'),
    })).toEqual({ waitTimeMinutes: 40, billableMinutes: 35, waitTimeCharge: 10 });
  });
});
