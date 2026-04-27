jest.mock('../../lib/prisma', () => ({
  bookingRejection: {
    findMany: jest.fn(),
  },
  driverNotification: {
    findMany: jest.fn(),
  },
  booking: {
    findMany: jest.fn(),
  },
}));

jest.mock('../../lib/pushNotifications', () => ({
  sendPushToDriverIds: jest.fn(),
}));

const prisma = require('../../lib/prisma');
const { getIncomingBookingsForDriver } = require('../dispatch');

describe('Dispatch — incoming jobs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('keeps admin-targeted jobs visible but excludes rejected booking ids', async () => {
    const targetedBooking = {
      id: 'booking-targeted',
      finalPrice: 50,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      vehicleType: 'CAR',
      pickupAddress: { latitude: 3.1, longitude: 101.6 },
    };
    const nearbyBooking = {
      id: 'booking-nearby',
      finalPrice: 25,
      createdAt: new Date('2026-01-01T00:01:00.000Z'),
      vehicleType: 'CAR',
      pickupAddress: { latitude: 3.1001, longitude: 101.6001 },
    };

    prisma.bookingRejection.findMany.mockResolvedValue([
      { bookingId: 'booking-rejected' },
    ]);
    prisma.driverNotification.findMany.mockResolvedValue([
      { actionData: JSON.stringify({ targeted: true, bookingId: 'booking-targeted' }) },
      { actionData: JSON.stringify({ targeted: true, bookingId: 'booking-rejected' }) },
    ]);
    prisma.booking.findMany
      .mockResolvedValueOnce([targetedBooking])
      .mockResolvedValueOnce([nearbyBooking]);

    const result = await getIncomingBookingsForDriver(
      {
        id: 'driver-1',
        currentLatitude: 3.1,
        currentLongitude: 101.6,
        vehicle: { type: 'CAR' },
      },
      { pickupAddress: true }
    );

    expect(prisma.booking.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          id: {
            in: ['booking-targeted', 'booking-rejected'],
            notIn: ['booking-rejected'],
          },
        }),
      })
    );
    expect(prisma.booking.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          id: { notIn: ['booking-rejected'] },
        }),
      })
    );
    expect(result.map((booking) => booking.id)).toEqual(['booking-targeted', 'booking-nearby']);
  });
});
