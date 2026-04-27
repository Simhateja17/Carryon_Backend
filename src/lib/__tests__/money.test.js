const { DRIVER_COMMISSION_RATE } = require('../../services/businessConfig');
const { driverEarningFromGross } = require('../money');

describe('Money helpers', () => {
  test('driverEarningFromGross uses the business config commission rate', () => {
    const payout = driverEarningFromGross(100);

    expect(payout.grossAmount).toBe(100);
    expect(payout.driverAmount).toBe(Math.round(10000 * DRIVER_COMMISSION_RATE) / 100);
    expect(payout.platformFeeAmount).toBe(100 - payout.driverAmount);
  });
});
