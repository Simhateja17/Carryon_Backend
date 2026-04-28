const { quoteBookingFare } = require('../bookingPricing');

function addresses() {
  return {
    pickupAddress: { latitude: 3.139, longitude: 101.6869 },
    deliveryAddress: { latitude: 3.15, longitude: 101.7 },
  };
}

describe('Booking Pricing — authoritative fare', () => {
  test('uses backend route distance and vehicle base price/rate', async () => {
    const db = {
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({ basePrice: 5, pricePerKm: 2 }),
      },
    };
    const routeProvider = {
      calculateRoute: jest.fn().mockResolvedValue({ distance: 10, duration: 18, isEstimated: false }),
      fallbackRouteDistance: jest.fn(),
    };

    const quote = await quoteBookingFare({
      ...addresses(),
      vehicleType: 'CAR',
      deliveryMode: 'Regular',
      db,
      routeProvider,
    });

    expect(quote.price).toBe(25);
    expect(quote.distance).toBe(10);
    expect(quote.breakdown).toMatchObject({
      basePrice: 5,
      pricePerKm: 2,
      distanceFare: 20,
      total: 25,
    });
    expect(routeProvider.fallbackRouteDistance).not.toHaveBeenCalled();
  });

  test('falls back to estimated road distance when route provider fails', async () => {
    const db = {
      vehicle: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const routeProvider = {
      calculateRoute: jest.fn().mockRejectedValue(new Error('maps unavailable')),
      fallbackRouteDistance: jest.fn().mockReturnValue({ distance: 13, duration: 26 }),
    };

    const quote = await quoteBookingFare({
      ...addresses(),
      vehicleType: 'CAR',
      deliveryMode: 'Regular',
      db,
      routeProvider,
    });

    expect(quote.isEstimated).toBe(true);
    expect(quote.distance).toBe(13);
    expect(quote.price).toBe(15.21);
  });

  test('rejects missing coordinates before pricing', async () => {
    await expect(
      quoteBookingFare({
        pickupAddress: { latitude: null, longitude: 101.6869 },
        deliveryAddress: { latitude: 3.15, longitude: 101.7 },
        vehicleType: 'CAR',
        db: { vehicle: { findFirst: jest.fn() } },
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
