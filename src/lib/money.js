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

function taxExclusiveSplitFromGross(grossAmount, taxRate = 0.06) {
  const grossMinor = toMinorUnits(grossAmount);
  const normalizedTaxRate = Number.isFinite(Number(taxRate)) && Number(taxRate) > 0 ? Number(taxRate) : 0;
  const taxableMinor = normalizedTaxRate > 0
    ? Math.round(grossMinor / (1 + normalizedTaxRate))
    : grossMinor;
  const taxMinor = Math.max(grossMinor - taxableMinor, 0);
  const driverMinor = Math.round(taxableMinor * DRIVER_COMMISSION_RATE);
  const platformMinor = Math.max(taxableMinor - driverMinor, 0);

  return {
    grossAmount: fromMinorUnits(grossMinor),
    grossMinor,
    taxableAmount: fromMinorUnits(taxableMinor),
    taxableMinor,
    taxAmount: fromMinorUnits(taxMinor),
    taxMinor,
    taxRate: normalizedTaxRate,
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
  taxExclusiveSplitFromGross,
};
