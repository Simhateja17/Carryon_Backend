const { DRIVER_COMMISSION_RATE } = require('../../services/businessConfig');
const { driverEarningFromGross, taxExclusiveSplitFromGross } = require('../money');

describe('Money helpers', () => {
  test('driverEarningFromGross uses the business config commission rate', () => {
    const payout = driverEarningFromGross(100);

    expect(payout.grossAmount).toBe(100);
    expect(payout.driverAmount).toBe(Math.round(10000 * DRIVER_COMMISSION_RATE) / 100);
    expect(payout.platformFeeAmount).toBe(100 - payout.driverAmount);
  });

  test('taxExclusiveSplitFromGross carves tax out before driver/platform split', () => {
    const payout = taxExclusiveSplitFromGross(4.65, 0.06);

    expect(payout.grossAmount).toBe(4.65);
    expect(payout.taxableAmount).toBe(4.39);
    expect(payout.taxAmount).toBe(0.26);
    expect(payout.driverAmount).toBe(3.86);
    expect(payout.platformFeeAmount).toBe(0.53);
    expect(payout.driverAmount + payout.platformFeeAmount + payout.taxAmount).toBeCloseTo(4.65, 2);
  });
});
