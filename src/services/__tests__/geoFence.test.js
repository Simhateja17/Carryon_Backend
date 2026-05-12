// Mock adminSettings before requiring geoFence
const mockGetAdminSetting = jest.fn();
jest.mock('../adminSettings', () => ({
  getAdminSetting: mockGetAdminSetting,
  FLEET_SETTINGS_KEY: 'fleetInfrastructureSettings',
  DEFAULT_FLEET_SETTINGS: {},
}));

const {
  isPointInServiceArea,
  getEnabledGeoFences,
  clearGeoFenceCache,
  validateBookingLocations,
  validateOptionalBookingLocations,
  assertDriverInServiceArea,
} = require('../geoFence');

const KL_REGION = {
  id: 'klang-valley',
  name: 'Klang Valley',
  enabled: true,
  latitude: 3.139,
  longitude: 101.6869,
  radiusKm: 40,
};

const PENANG_REGION = {
  id: 'penang',
  name: 'Penang',
  enabled: true,
  latitude: 5.4164,
  longitude: 100.3327,
  radiusKm: 25,
};

const DISABLED_REGION = {
  id: 'johor',
  name: 'Johor Bahru',
  enabled: false,
  latitude: 1.4927,
  longitude: 103.7414,
  radiusKm: 30,
};

function setRegions(regions) {
  mockGetAdminSetting.mockResolvedValue({ regions });
}

beforeEach(() => {
  clearGeoFenceCache();
  mockGetAdminSetting.mockReset();
});

// ── isPointInServiceArea ──

describe('isPointInServiceArea', () => {
  test('allows point inside KL region', async () => {
    setRegions([KL_REGION, PENANG_REGION]);
    const result = await isPointInServiceArea(3.15, 101.70);
    expect(result.allowed).toBe(true);
    expect(result.region.id).toBe('klang-valley');
  });

  test('allows point inside Penang region', async () => {
    setRegions([KL_REGION, PENANG_REGION]);
    const result = await isPointInServiceArea(5.42, 100.34);
    expect(result.allowed).toBe(true);
    expect(result.region.id).toBe('penang');
  });

  test('rejects point outside all regions', async () => {
    setRegions([KL_REGION, PENANG_REGION]);
    // London coordinates
    const result = await isPointInServiceArea(51.5074, -0.1278);
    expect(result.allowed).toBe(false);
    expect(result.region).toBeNull();
  });

  test('allows everything when no regions configured (graceful degradation)', async () => {
    setRegions([]);
    const result = await isPointInServiceArea(51.5074, -0.1278);
    expect(result.allowed).toBe(true);
    expect(result.region).toBeNull();
  });

  test('ignores disabled regions', async () => {
    setRegions([DISABLED_REGION]);
    // Point inside JB but region is disabled
    const result = await isPointInServiceArea(1.49, 103.74);
    // No enabled regions → graceful degradation → allowed
    expect(result.allowed).toBe(true);
  });

  test('ignores regions without coordinates', async () => {
    setRegions([{ id: 'test', name: 'Test', enabled: true }]);
    const result = await isPointInServiceArea(3.15, 101.70);
    expect(result.allowed).toBe(true); // no valid geo-fences → allow all
  });

  test('point on exact boundary is allowed', async () => {
    setRegions([KL_REGION]);
    // Use center point — distance is 0, which is <= radiusKm
    const result = await isPointInServiceArea(KL_REGION.latitude, KL_REGION.longitude);
    expect(result.allowed).toBe(true);
  });
});

// ── Cache behavior ──

describe('cache', () => {
  test('uses cached regions within TTL', async () => {
    setRegions([KL_REGION]);
    await getEnabledGeoFences();
    await getEnabledGeoFences();
    expect(mockGetAdminSetting).toHaveBeenCalledTimes(1);
  });

  test('clearGeoFenceCache forces reload', async () => {
    setRegions([KL_REGION]);
    await getEnabledGeoFences();
    clearGeoFenceCache();
    await getEnabledGeoFences();
    expect(mockGetAdminSetting).toHaveBeenCalledTimes(2);
  });
});

// ── validateBookingLocations ──

describe('validateBookingLocations', () => {
  test('validates both pickup and delivery inside service area', async () => {
    setRegions([KL_REGION]);
    const result = await validateBookingLocations(
      { latitude: 3.15, longitude: 101.70 },
      { latitude: 3.10, longitude: 101.65 },
    );
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
    expect(result.pickupRegion.id).toBe('klang-valley');
    expect(result.deliveryRegion.id).toBe('klang-valley');
  });

  test('rejects when pickup is outside service area', async () => {
    setRegions([KL_REGION]);
    const result = await validateBookingLocations(
      { latitude: 51.50, longitude: -0.12 }, // London
      { latitude: 3.10, longitude: 101.65 }, // KL
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Service is not available at the pickup location.');
  });

  test('rejects when delivery is outside service area', async () => {
    setRegions([KL_REGION]);
    const result = await validateBookingLocations(
      { latitude: 3.15, longitude: 101.70 }, // KL
      { latitude: 51.50, longitude: -0.12 }, // London
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Service is not available at the delivery location.');
  });

  test('checks pickup before delivery (pickup error takes precedence)', async () => {
    setRegions([KL_REGION]);
    const result = await validateBookingLocations(
      { latitude: 51.50, longitude: -0.12 }, // London
      { latitude: 40.71, longitude: -74.01 }, // NYC
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Service is not available at the pickup location.');
  });
});

// ── validateOptionalBookingLocations ──

describe('validateOptionalBookingLocations', () => {
  test('passes when both coords are null', async () => {
    setRegions([KL_REGION]);
    const result = await validateOptionalBookingLocations(null, null);
    expect(result.valid).toBe(true);
  });

  test('validates only pickup when delivery is null', async () => {
    setRegions([KL_REGION]);
    const result = await validateOptionalBookingLocations(
      { latitude: 3.15, longitude: 101.70 },
      null,
    );
    expect(result.valid).toBe(true);
  });

  test('rejects invalid pickup even when delivery is null', async () => {
    setRegions([KL_REGION]);
    const result = await validateOptionalBookingLocations(
      { latitude: 51.50, longitude: -0.12 },
      null,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Service is not available at the pickup location.');
  });

  test('validates only delivery when pickup is null', async () => {
    setRegions([KL_REGION]);
    const result = await validateOptionalBookingLocations(
      null,
      { latitude: 51.50, longitude: -0.12 },
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Service is not available at the delivery location.');
  });
});

// ── assertDriverInServiceArea ──

describe('assertDriverInServiceArea', () => {
  test('does not throw when driver is in service area', async () => {
    setRegions([KL_REGION]);
    await expect(assertDriverInServiceArea(3.15, 101.70)).resolves.not.toThrow();
  });

  test('throws 403 when driver is outside service area', async () => {
    setRegions([KL_REGION]);
    try {
      await assertDriverInServiceArea(51.50, -0.12);
      fail('Expected error to be thrown');
    } catch (err) {
      expect(err.message).toBe('You are outside the service area. Move to an active region to go online.');
      expect(err.statusCode).toBe(403);
    }
  });

  test('does not throw when no regions configured (graceful degradation)', async () => {
    setRegions([]);
    await expect(assertDriverInServiceArea(51.50, -0.12)).resolves.not.toThrow();
  });
});
