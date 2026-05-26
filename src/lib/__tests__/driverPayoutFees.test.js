describe('driverPayoutFees', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('defaults to RM 50 minimum and no fee', () => {
    delete process.env.DRIVER_WITHDRAWAL_MIN_AMOUNT;
    delete process.env.DRIVER_WITHDRAWAL_FEE_FLAT;
    delete process.env.DRIVER_WITHDRAWAL_FEE_RATE;

    const { calculateDriverWithdrawal } = require('../driverPayoutFees');
    expect(calculateDriverWithdrawal(100)).toMatchObject({
      requestedAmount: 100,
      feeAmount: 0,
      transferAmount: 100,
      minimumAmount: 50,
    });
  });

  test('deducts configured flat and percentage fees from transfer amount', () => {
    process.env.DRIVER_WITHDRAWAL_FEE_FLAT = '2';
    process.env.DRIVER_WITHDRAWAL_FEE_RATE = '0.015';

    const { calculateDriverWithdrawal } = require('../driverPayoutFees');
    expect(calculateDriverWithdrawal(100)).toMatchObject({
      requestedAmount: 100,
      feeAmount: 3.5,
      transferAmount: 96.5,
    });
  });
});
