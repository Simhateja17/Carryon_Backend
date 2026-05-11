const {
  assertBookingIdShape,
  activeRouteWindowFor,
  coordinate,
  deviationFor,
  OVERVIEW_PRECISION,
  routeHashFor,
  routePhaseForStatus,
  routeProgressPercent,
  vehicleLabel,
} = require('../adminMaps');

describe('adminMaps', () => {
  test('rounds overview coordinates but preserves exact detail coordinates', () => {
    expect(coordinate(3.1415926, 101.686855, OVERVIEW_PRECISION)).toEqual({ lat: 3.142, lng: 101.687 });
    expect(coordinate(3.1415926, 101.686855)).toEqual({ lat: 3.1415926, lng: 101.686855 });
  });

  test('rejects invalid or empty coordinates', () => {
    expect(coordinate(91, 101)).toBeNull();
    expect(coordinate(3, 181)).toBeNull();
    expect(coordinate(0, 0)).toBeNull();
  });

  test('validates dispatch booking id shapes', () => {
    expect(assertBookingIdShape('latest')).toBe(true);
    expect(assertBookingIdShape('CO-88219-X')).toBe(true);
    expect(assertBookingIdShape('d4d93475-5d3c-41a1-9dbd-c7ab99e60947')).toBe(true);
    expect(assertBookingIdShape('../secret')).toBe(false);
    expect(assertBookingIdShape('x'.repeat(100))).toBe(false);
  });

  test('computes deviation status from latest actual point', () => {
    const booking = { updatedAt: new Date().toISOString() };
    const plannedRoute = { geometry: [{ lat: 3.0, lng: 101.0 }, { lat: 3.01, lng: 101.01 }] };

    expect(deviationFor(booking, plannedRoute, [{ position: { lat: 3.01, lng: 101.01 } }]).status).toBe('ON_ROUTE');
    expect(deviationFor(booking, plannedRoute, [{ position: { lat: 3.08, lng: 101.08 } }]).status).toBe('OFF_ROUTE');
  });

  test('resolves route phase from delivery lifecycle status', () => {
    expect(routePhaseForStatus('DRIVER_ASSIGNED')).toBe('TO_PICKUP');
    expect(routePhaseForStatus('DRIVER_ARRIVED')).toBe('TO_PICKUP');
    expect(routePhaseForStatus('PICKUP_DONE')).toBe('TO_DROPOFF');
    expect(routePhaseForStatus('IN_TRANSIT')).toBe('TO_DROPOFF');
    expect(routePhaseForStatus('ARRIVED_AT_DROP')).toBe('TO_DROPOFF');
    expect(routePhaseForStatus('SEARCHING_DRIVER')).toBe('UNAVAILABLE');
  });

  test('uses driver-to-pickup route window before pickup completion', () => {
    const booking = {
      status: 'DRIVER_ASSIGNED',
      pickupAddress: { latitude: 3.1, longitude: 101.6, label: 'Pickup Hub' },
      deliveryAddress: { latitude: 3.2, longitude: 101.7, label: 'Drop Site' },
      driver: { name: 'Marcus', currentLatitude: 3.09, currentLongitude: 101.59 },
    };

    expect(activeRouteWindowFor(booking)).toMatchObject({
      phase: 'TO_PICKUP',
      origin: { lat: 3.09, lng: 101.59 },
      destination: { lat: 3.1, lng: 101.6 },
      destinationLabel: 'Pickup Hub',
    });
  });

  test('uses pickup-to-dropoff route window after pickup completion', () => {
    const booking = {
      status: 'PICKUP_DONE',
      pickupAddress: { latitude: 3.1, longitude: 101.6, label: 'Pickup Hub' },
      deliveryAddress: { latitude: 3.2, longitude: 101.7, label: 'Drop Site' },
      driver: { name: 'Marcus', currentLatitude: 3.09, currentLongitude: 101.59 },
    };

    expect(activeRouteWindowFor(booking)).toMatchObject({
      phase: 'TO_DROPOFF',
      origin: { lat: 3.1, lng: 101.6 },
      destination: { lat: 3.2, lng: 101.7 },
      destinationLabel: 'Drop Site',
    });
  });

  test('route hash changes when route phase changes', () => {
    const booking = {
      pickupAddress: { latitude: 3.1, longitude: 101.6 },
      deliveryAddress: { latitude: 3.2, longitude: 101.7 },
    };

    const pickupHash = routeHashFor(booking, 'TO_PICKUP', { lat: 3.09, lng: 101.59 }, { lat: 3.1, lng: 101.6 });
    const dropoffHash = routeHashFor(booking, 'TO_DROPOFF', { lat: 3.1, lng: 101.6 }, { lat: 3.2, lng: 101.7 });
    expect(pickupHash).not.toBe(dropoffHash);
  });

  test('maps route progress from lifecycle status', () => {
    expect(routeProgressPercent('DRIVER_ASSIGNED')).toBe(18);
    expect(routeProgressPercent('IN_TRANSIT')).toBe(72);
    expect(routeProgressPercent('ARRIVED_AT_DROP')).toBe(92);
    expect(routeProgressPercent('UNKNOWN')).toBe(0);
  });

  test('formats vehicle labels from real vehicle data', () => {
    expect(vehicleLabel({
      make: 'Freightliner',
      model: 'M2',
      year: 2023,
      licensePlate: 'TRK-8829',
      type: 'LORRY_14FT',
    })).toBe('Freightliner M2 (2023) - TRK-8829');
    expect(vehicleLabel(null, 'VAN_9FT')).toBe('VAN_9FT');
  });
});
