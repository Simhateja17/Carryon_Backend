const { DRIVER_COMMISSION_RATE } = require('../services/businessConfig');

function toMinorUnits(amount) {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100);
}

function fromMinorUnits(amountMinor) {
  const parsed = Number(amountMinor);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed) / 100;
}

function money(value) {
  return fromMinorUnits(toMinorUnits(value));
}

function driverEarningFromGross(grossAmount) {
  const grossMinor = toMinorUnits(grossAmount);
  const driverMinor = Math.round(grossMinor * DRIVER_COMMISSION_RATE);
  const platformMinor = Math.max(grossMinor - driverMinor, 0);
  return {
    grossAmount: fromMinorUnits(grossMinor),
    grossMinor,
    driverAmount: fromMinorUnits(driverMinor),
    driverMinor,
    platformFeeAmount: fromMinorUnits(platformMinor),
    platformFeeMinor: platformMinor,
  };
}

module.exports = {
  toMinorUnits,
  fromMinorUnits,
  money,
  driverEarningFromGross,
};
