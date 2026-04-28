jest.mock('../../lib/prisma', () => ({
  booking: {
    findFirst: jest.fn(),
  },
}));

jest.mock('../../middleware/auth', () => ({
  resolveAuthenticatedUserFromToken: jest.fn(),
}));

const prisma = require('../../lib/prisma');
const { canUserTrackBooking } = require('../liveTracking');

describe('Live Tracking — authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('allows tracking only for an active booking owned by the user', async () => {
    prisma.booking.findFirst.mockResolvedValue({ id: 'booking-1', driver: null });

    const booking = await canUserTrackBooking('user-1', 'booking-1');

    expect(booking).toEqual({ id: 'booking-1', driver: null });
    expect(prisma.booking.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'booking-1',
        userId: 'user-1',
        status: { in: ['DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'PICKUP_DONE', 'IN_TRANSIT'] },
      },
      select: {
        id: true,
        driver: { select: { id: true, currentLatitude: true, currentLongitude: true } },
      },
    });
  });

  test('rejects missing or inactive booking', async () => {
    prisma.booking.findFirst.mockResolvedValue(null);

    await expect(canUserTrackBooking('user-1', 'booking-1')).resolves.toBeNull();
  });
});
