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

    expect(quote.price).toBe(26.25);
    expect(quote.distance).toBe(10);
    expect(quote.breakdown).toMatchObject({
      basePrice: 5,
      pricePerKm: 2,
      distanceFare: 20,
      offloadingFee: 0,
      tax: 1.25,
      total: 26.25,
    });
    expect(routeProvider.fallbackRouteDistance).not.toHaveBeenCalled();
  });

  test('adds backend-owned offloading fee before tax', async () => {
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
      offloading: true,
      db,
      routeProvider,
    });

    expect(quote.breakdown).toMatchObject({
      offloadingFee: 30,
      tax: 2.75,
      total: 57.75,
    });
    expect(quote.price).toBe(57.75);
  });

  test('fails closed when route provider fails', async () => {
    const db = {
      vehicle: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const routeProvider = {
      calculateRoute: jest.fn().mockRejectedValue(new Error('maps unavailable')),
      fallbackRouteDistance: jest.fn(),
    };

    await expect(
      quoteBookingFare({
        ...addresses(),
        vehicleType: 'CAR',
        deliveryMode: 'Regular',
        db,
        routeProvider,
      })
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(routeProvider.fallbackRouteDistance).not.toHaveBeenCalled();
  });

  test('fails closed when route provider returns an estimated fallback route', async () => {
    const db = {
      vehicle: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const routeProvider = {
      calculateRoute: jest.fn().mockResolvedValue({ distance: 13, duration: 26, isEstimated: true }),
      fallbackRouteDistance: jest.fn(),
    };

    await expect(
      quoteBookingFare({
        ...addresses(),
        vehicleType: 'CAR',
        deliveryMode: 'Regular',
        db,
        routeProvider,
      })
    ).rejects.toMatchObject({ statusCode: 503 });
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
