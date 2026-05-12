const { money } = require('../lib/money');
const { validateBookingLocations, validateOptionalBookingLocations } = require('./geoFence');

const LEGACY_REGULAR_MODES = new Set(['', 'REGULAR']);
const CANCELLATION_GRACE_MS = 3 * 60 * 1000;
const CANCELLATION_DRIVER_SHARE = 0.7;
const WAIT_FREE_MINUTES = 5;
const WAIT_RATE_PER_MINUTE = 0.5;
const WAIT_CHARGE_CAP = 10;

const CANCELLATION_FEE_BY_VEHICLE = {
  BIKE: 3,
  CAR: 3,
  PICKUP: 5,
  VAN_7FT: 5,
  VAN_9FT: 5,
  LORRY_10FT: 8,
  LORRY_14FT: 8,
  LORRY_17FT: 8,
};

function normalizeDeliveryMode(value) {
  return String(value || 'Regular').trim().toUpperCase();
}

function isRegularBookingMode(value) {
  return LEGACY_REGULAR_MODES.has(normalizeDeliveryMode(value));
}

function coerceMvpBookingMode() {
  return 'Regular';
}

function cancellationFeeForVehicle(vehicleType) {
  return money(CANCELLATION_FEE_BY_VEHICLE[String(vehicleType || '').trim().toUpperCase()] || 3);
}

function computeCancellationOutcome({ booking, actorType, now = new Date() }) {
  const cancelledBy = String(actorType || '').toUpperCase();
  const base = {
    cancelledBy,
    fee: 0,
    driverShare: 0,
    platformShare: 0,
    refundAmount: money(booking.finalPrice || booking.estimatedPrice || 0),
    feeApplies: false,
  };

  if (cancelledBy !== 'USER' || !booking.driverId || !booking.driverAssignedAt) {
    return base;
  }

  const assignedAt = new Date(booking.driverAssignedAt);
  if (!Number.isFinite(assignedAt.getTime())) return base;
  if (now.getTime() - assignedAt.getTime() < CANCELLATION_GRACE_MS) return base;

  const fee = Math.min(cancellationFeeForVehicle(booking.vehicleType), base.refundAmount);
  const driverShare = money(fee * CANCELLATION_DRIVER_SHARE);
  const platformShare = money(fee - driverShare);

  return {
    ...base,
    fee,
    driverShare,
    platformShare,
    refundAmount: money(base.refundAmount - fee),
    feeApplies: fee > 0,
  };
}

function computePickupWaitCharge({ arrivedAt, pickedUpAt = new Date() }) {
  if (!arrivedAt) {
    return { waitTimeMinutes: 0, waitTimeCharge: 0, billableMinutes: 0 };
  }
  const start = new Date(arrivedAt);
  const end = new Date(pickedUpAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    return { waitTimeMinutes: 0, waitTimeCharge: 0, billableMinutes: 0 };
  }

  const waitTimeMinutes = Math.floor((end.getTime() - start.getTime()) / 60000);
  const billableMinutes = Math.max(waitTimeMinutes - WAIT_FREE_MINUTES, 0);
  const waitTimeCharge = money(Math.min(billableMinutes * WAIT_RATE_PER_MINUTE, WAIT_CHARGE_CAP));
  return { waitTimeMinutes, waitTimeCharge, billableMinutes };
}

module.exports = {
  CANCELLATION_GRACE_MS,
  WAIT_FREE_MINUTES,
  WAIT_RATE_PER_MINUTE,
  WAIT_CHARGE_CAP,
  coerceMvpBookingMode,
  computeCancellationOutcome,
  computePickupWaitCharge,
  isRegularBookingMode,
  validateBookingLocations,
  validateOptionalBookingLocations,
};
