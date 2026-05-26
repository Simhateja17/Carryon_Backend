const { fromMinorUnits, toMinorUnits } = require('./money');
const {
  DRIVER_WITHDRAWAL_FEE_FLAT,
  DRIVER_WITHDRAWAL_FEE_RATE,
  DRIVER_WITHDRAWAL_MIN_AMOUNT,
} = require('../services/businessConfig');

function driverWithdrawalMinimumMinor() {
  return toMinorUnits(DRIVER_WITHDRAWAL_MIN_AMOUNT);
}

function calculateDriverWithdrawal(amount) {
  const requestedMinor = toMinorUnits(amount);
  const flatFeeMinor = Math.max(0, toMinorUnits(DRIVER_WITHDRAWAL_FEE_FLAT));
  const rateFeeMinor = Math.max(0, Math.round(requestedMinor * DRIVER_WITHDRAWAL_FEE_RATE));
  const feeMinor = Math.min(requestedMinor, flatFeeMinor + rateFeeMinor);
  const transferMinor = Math.max(0, requestedMinor - feeMinor);

  return {
    requestedAmount: fromMinorUnits(requestedMinor),
    requestedMinor,
    feeAmount: fromMinorUnits(feeMinor),
    feeMinor,
    transferAmount: fromMinorUnits(transferMinor),
    transferMinor,
    minimumAmount: fromMinorUnits(driverWithdrawalMinimumMinor()),
    minimumMinor: driverWithdrawalMinimumMinor(),
  };
}

module.exports = {
  calculateDriverWithdrawal,
  driverWithdrawalMinimumMinor,
};
