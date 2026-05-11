jest.mock('../../lib/prisma', () => ({
  driver: {
    update: jest.fn(),
  },
  booking: {
    findMany: jest.fn(),
  },
}));

jest.mock('../liveTracking', () => ({
  ACTIVE_TRACKING_STATUSES: ['DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'PICKUP_DONE', 'IN_TRANSIT', 'ARRIVED_AT_DROP'],
  broadcastDriverLocation: jest.fn(),
}));

const prisma = require('../../lib/prisma');
const { broadcastDriverLocation } = require('../liveTracking');
const { normalizeDriverPosition, updateDriverPosition } = require('../driverLocation');

describe('driverLocation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('normalizes valid driver GPS coordinates', () => {
    const position = normalizeDriverPosition({
      latitude: '3.1415',
      longitude: '101.6869',
      accuracyMeters: '12',
      capturedAt: '2026-05-11T10:00:00.000Z',
    });

    expect(position.latitude).toBe(3.1415);
    expect(position.longitude).toBe(101.6869);
    expect(position.accuracyMeters).toBe(12);
    expect(position.capturedAt.toISOString()).toBe('2026-05-11T10:00:00.000Z');
  });

  test('rejects invalid coordinate ranges', () => {
    expect(() => normalizeDriverPosition({ latitude: 91, longitude: 101 })).toThrow('Valid latitude and longitude are required');
    expect(() => normalizeDriverPosition({ latitude: 3, longitude: 181 })).toThrow('Valid latitude and longitude are required');
  });

  test('updates driver position and broadcasts active booking locations', async () => {
    prisma.driver.update.mockResolvedValue({});
    prisma.booking.findMany.mockResolvedValue([{ id: 'booking-1' }, { id: 'booking-2' }]);

    const result = await updateDriverPosition('driver-1', {
      latitude: 3.1,
      longitude: 101.6,
      capturedAt: '2026-05-11T10:00:00.000Z',
    });

    expect(prisma.driver.update).toHaveBeenCalledWith({
      where: { id: 'driver-1' },
      data: { currentLatitude: 3.1, currentLongitude: 101.6 },
    });
    expect(prisma.booking.findMany).toHaveBeenCalledWith({
      where: {
        driverId: 'driver-1',
        status: { in: ['DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'PICKUP_DONE', 'IN_TRANSIT', 'ARRIVED_AT_DROP'] },
      },
      select: { id: true },
    });
    expect(broadcastDriverLocation).toHaveBeenCalledTimes(2);
    expect(result.activeBookings).toBe(2);
  });
});
