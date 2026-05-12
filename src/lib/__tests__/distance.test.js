const { haversineKm } = require('../distance');

describe('haversineKm', () => {
  test('returns ~0 for identical points', () => {
    expect(haversineKm(3.139, 101.687, 3.139, 101.687)).toBeCloseTo(0, 5);
  });

  test('calculates KL to Penang (~300 km)', () => {
    const km = haversineKm(3.139, 101.687, 5.416, 100.333);
    expect(km).toBeGreaterThan(280);
    expect(km).toBeLessThan(320);
  });

  test('calculates short distance within KL (~10 km)', () => {
    // KL Sentral to KLCC
    const km = haversineKm(3.1343, 101.6865, 3.1588, 101.7118);
    expect(km).toBeGreaterThan(3);
    expect(km).toBeLessThan(5);
  });

  test('returns NaN for NaN inputs', () => {
    expect(haversineKm(NaN, 101.687, 3.139, 101.687)).toBeNaN();
    expect(haversineKm(3.139, NaN, 3.139, 101.687)).toBeNaN();
    expect(haversineKm(3.139, 101.687, NaN, 101.687)).toBeNaN();
    expect(haversineKm(3.139, 101.687, 3.139, NaN)).toBeNaN();
  });

  test('returns NaN for Infinity inputs', () => {
    expect(haversineKm(Infinity, 101.687, 3.139, 101.687)).toBeNaN();
    expect(haversineKm(3.139, -Infinity, 3.139, 101.687)).toBeNaN();
  });

  test('returns NaN for undefined/null inputs', () => {
    expect(haversineKm(undefined, 101.687, 3.139, 101.687)).toBeNaN();
    expect(haversineKm(3.139, 101.687, null, 101.687)).toBeNaN();
  });

  test('handles antipodal points (~20000 km)', () => {
    const km = haversineKm(0, 0, 0, 180);
    expect(km).toBeGreaterThan(20000);
    expect(km).toBeLessThan(20100);
  });

  test('handles negative coordinates', () => {
    // Sydney to Auckland
    const km = haversineKm(-33.87, 151.21, -36.85, 174.76);
    expect(km).toBeGreaterThan(2100);
    expect(km).toBeLessThan(2200);
  });
});
