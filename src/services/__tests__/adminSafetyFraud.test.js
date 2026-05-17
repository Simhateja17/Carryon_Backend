const {
  preventionRate,
  riskStatus,
  trendPercent,
} = require('../adminSafetyFraud');

describe('adminSafetyFraud read model helpers', () => {
  test('classifies fraud case status from bounded risk score', () => {
    expect(riskStatus(82)).toBe('Pending Review');
    expect(riskStatus(45)).toBe('Watchlist');
    expect(riskStatus(12)).toBe('Resolved');
  });

  test('computes trend percentage with empty previous windows', () => {
    expect(trendPercent(0, 0)).toBe(0);
    expect(trendPercent(3, 0)).toBe(100);
    expect(trendPercent(6, 4)).toBe(50);
    expect(trendPercent(2, 4)).toBe(-50);
  });

  test('computes prevention rate from lifecycle event outcomes', () => {
    expect(preventionRate(95, 100)).toBe(95);
    expect(preventionRate(0, 0)).toBe(100);
  });
});
