jest.mock('../../lib/prisma', () => ({
  $transaction: jest.fn(),
  booking: {
    findUnique: jest.fn(),
  },
}));

jest.mock('../../lib/pushNotifications', () => ({
  notifyUserBookingEvent: jest.fn().mockResolvedValue(undefined),
}));

const prisma = require('../../lib/prisma');
const { executeDriverLifecycleCommand } = require('../deliveryLifecycle');

describe('deliveryLifecycle wait-time charging', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('records pickup wait time as pending payment when pickup OTP is verified after free window', async () => {
    const arrivedAt = new Date(Date.now() - 8 * 60 * 1000);
    const booking = {
      id: 'booking-1',
      userId: 'user-1',
      driverId: 'driver-1',
      status: 'DRIVER_ARRIVED',
      otp: '1234',
      driverArrivedAt: arrivedAt,
      pickupAddress: { latitude: 3.1, longitude: 101.6, address: 'Pickup' },
      deliveryAddress: { latitude: 3.2, longitude: 101.7, address: 'Drop' },
      user: { id: 'user-1', name: 'Customer', email: 'customer@example.com', phone: '123' },
      createdAt: new Date(),
      estimatedPrice: 20,
      finalPrice: 20,
      distance: 5,
      duration: 20,
    };
    const tx = {
      booking: {
        update: jest.fn().mockResolvedValue({
          ...booking,
          status: 'PICKUP_DONE',
          waitTimeMinutes: 8,
          waitTimeCharge: 1.5,
        }),
      },
      bookingAdjustment: {
        upsert: jest.fn().mockResolvedValue({
          id: 'adjustment-1',
          bookingId: 'booking-1',
          type: 'PICKUP_WAIT_TIME',
          amount: 1.5,
          status: 'PENDING_PAYMENT',
        }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      },
      deliveryLifecycleEvent: {
        create: jest.fn().mockResolvedValue({ id: 'event-1' }),
      },
    };
    prisma.booking.findUnique.mockResolvedValue(booking);
    prisma.$transaction.mockImplementation((callback) => callback(tx));

    const result = await executeDriverLifecycleCommand({
      bookingId: 'booking-1',
      driver: { id: 'driver-1' },
      command: 'VERIFY_PICKUP_OTP',
      payload: { otp: '1234' },
    });

    expect(result.job.status).toBe('PICKED_UP');
    expect(tx.booking.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'PICKUP_DONE',
        waitTimeMinutes: expect.any(Number),
        waitTimeCharge: expect.any(Number),
      }),
    }));
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
        amount: expect.any(Number),
        status: 'PENDING_PAYMENT',
      }),
      update: expect.objectContaining({
        amount: expect.any(Number),
        status: 'PENDING_PAYMENT',
      }),
    });
  });
});
