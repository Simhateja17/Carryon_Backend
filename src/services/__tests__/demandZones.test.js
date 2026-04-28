jest.mock('../../lib/prisma', () => ({
  booking: { findMany: jest.fn() },
  driver: { findMany: jest.fn() },
}));

const prisma = require('../../lib/prisma');
const { computeDemandZones } = require('../demandZones');

function booking(id, lat, lng, vehicleType = 'CAR') {
  return {
    id,
    vehicleType,
    pickupAddress: { latitude: lat, longitude: lng },
    createdAt: new Date(),
  };
}

function driver(id, lat, lng, vehicleType = 'CAR') {
  return {
    id,
    currentLatitude: lat,
    currentLongitude: lng,
    isOnline: true,
    isVerified: true,
    vehicle: { type: vehicleType },
  };
}

describe('demand zones', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns empty zones with no nearby demand', async () => {
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.driver.findMany.mockResolvedValue([]);

    const result = await computeDemandZones({ lat: 3.1, lng: 101.6, radiusKm: 5 });

    expect(result.zones).toEqual([]);
  });

  test('scores high demand when bookings outnumber nearby drivers', async () => {
    prisma.booking.findMany.mockResolvedValue([
      booking('b1', 3.1, 101.6),
      booking('b2', 3.101, 101.601),
      booking('b3', 3.102, 101.602),
    ]);
    prisma.driver.findMany.mockResolvedValue([driver('d1', 3.12, 101.62)]);

    const result = await computeDemandZones({ lat: 3.1, lng: 101.6, radiusKm: 10, vehicleType: 'CAR' });

    expect(result.zones[0].level).toBe('HIGH');
    expect(result.zones[0].score).toBeGreaterThanOrEqual(3);
  });

  test('filters bookings and drivers by radius and vehicle type', async () => {
    prisma.booking.findMany.mockResolvedValue([
      booking('near-car', 3.1, 101.6, 'CAR'),
      booking('far-car', 4.1, 102.6, 'CAR'),
    ]);
    prisma.driver.findMany.mockResolvedValue([
      driver('near-car-driver', 3.1, 101.6, 'CAR'),
      driver('near-bike-driver', 3.1, 101.6, 'BIKE'),
    ]);

    const result = await computeDemandZones({ lat: 3.1, lng: 101.6, radiusKm: 5, vehicleType: 'CAR' });

    expect(result.zones).toHaveLength(1);
    expect(result.zones[0].demandCount).toBe(1);
    expect(result.zones[0].onlineDriverCount).toBe(1);
  });
});
