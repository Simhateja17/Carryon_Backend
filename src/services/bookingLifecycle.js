// ── Booking Lifecycle Module ────────────────────────────────
// Owns Booking state transitions, pricing, settlement, and
// cancellation. Routes are thin HTTP adapters that call here.

const { haversineKm } = require('../lib/distance');
const { driverEarningFromGross } = require('../lib/money');
const { notifyUserBookingEvent } = require('../lib/pushNotifications');
const { VEHICLE_RATE_PER_KM, DELIVERY_OTP_TTL_MS } = require('./businessConfig');

// ── Helpers ─────────────────────────────────────────────────

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function positiveNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function coordinate(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function estimateMinutes(distanceKm) {
  if (!distanceKm || distanceKm <= 0) return 0;
  return Math.max(5, Math.ceil((distanceKm / 30) * 60));
}

function normalizedDeliveryMode(deliveryMode) {
  const mode = String(deliveryMode || 'Regular').trim().toLowerCase();
  if (mode === 'priority') return 'priority';
  if (mode === 'pooling') return 'pooling';
  return 'regular';
}

// ── Status Transition State Machine ─────────────────────────

const ALLOWED_TRANSITIONS = {
  PENDING:          ['SEARCHING_DRIVER', 'CANCELLED'],
  SEARCHING_DRIVER: ['DRIVER_ASSIGNED', 'CANCELLED'],
  DRIVER_ASSIGNED:  ['DRIVER_ARRIVED', 'SEARCHING_DRIVER', 'CANCELLED'],
  DRIVER_ARRIVED:   ['PICKUP_DONE', 'CANCELLED'],
  PICKUP_DONE:      ['IN_TRANSIT', 'CANCELLED'],
  IN_TRANSIT:       ['ARRIVED_AT_DROP', 'CANCELLED'],
  ARRIVED_AT_DROP:  ['DELIVERED', 'CANCELLED'],
  DELIVERED:        [],
  CANCELLED:        [],
};

const TERMINAL_STATUSES = ['DELIVERED', 'CANCELLED'];
const NON_CANCELLABLE_BY_USER = ['DELIVERED', 'CANCELLED'];
const NON_CANCELLABLE_BY_DRIVER = ['DELIVERED', 'CANCELLED', 'PICKUP_DONE', 'IN_TRANSIT', 'ARRIVED_AT_DROP'];

function canTransition(fromStatus, toStatus) {
  const allowed = ALLOWED_TRANSITIONS[fromStatus];
  return Array.isArray(allowed) && allowed.includes(toStatus);
}

function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

function canUserCancel(status) {
  return !NON_CANCELLABLE_BY_USER.includes(status);
}

function canDriverCancel(status) {
  return !NON_CANCELLABLE_BY_DRIVER.includes(status);
}

// ── Pricing ─────────────────────────────────────────────────

function serverQuote({ pickupAddress, deliveryAddress, vehicleType, deliveryMode, estimatedPrice, distance, duration }) {
  const pickupLat = coordinate(pickupAddress?.latitude);
  const pickupLng = coordinate(pickupAddress?.longitude);
  const deliveryLat = coordinate(deliveryAddress?.latitude);
  const deliveryLng = coordinate(deliveryAddress?.longitude);
  const directDistance = pickupLat != null && pickupLng != null && deliveryLat != null && deliveryLng != null
    ? haversineKm(pickupLat, pickupLng, deliveryLat, deliveryLng)
    : 0;
  const resolvedDistance = money(Math.max(positiveNumber(distance), directDistance));
  const rates = VEHICLE_RATE_PER_KM[vehicleType] || VEHICLE_RATE_PER_KM.CAR;
  const rate = rates[normalizedDeliveryMode(deliveryMode)] || rates.regular;
  const calculatedPrice = money(resolvedDistance * rate);
  const clientPrice = money(positiveNumber(estimatedPrice));

  return {
    estimatedPrice: Math.max(clientPrice, calculatedPrice),
    distance: resolvedDistance,
    duration: positiveNumber(duration) || estimateMinutes(resolvedDistance),
  };
}

// ── Order Code Generation ───────────────────────────────────

function nextOrderCodeFromLast(lastOrderCode) {
  const match = /^ORD-(\d+)$/.exec(lastOrderCode || '');
  const next = match ? Number(match[1]) + 1 : 1;
  return `ORD-${String(next).padStart(6, '0')}`;
}

async function generateNextOrderCode(tx) {
  const latest = await tx.booking.findFirst({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { orderCode: true },
  });
  return nextOrderCodeFromLast(latest?.orderCode);
}

function isOrderCodeConflict(err) {
  const target = err?.meta?.target;
  if (err?.code !== 'P2002') return false;
  if (Array.isArray(target)) return target.includes('orderCode');
  return typeof target === 'string' && target.includes('orderCode');
}

// ── Settlement ──────────────────────────────────────────────

function isSettlementEligible(booking) {
  return (
    booking.status === 'DELIVERED' &&
    !!booking.deliveredAt &&
    !!booking.deliveryOtpVerifiedAt &&
    booking.paymentStatus === 'COMPLETED'
  );
}

async function settleDeliveredBooking(tx, booking, now, deliveryProofUrl = null) {
  const updated = await tx.booking.update({
    where: { id: booking.id },
    data: {
      status: 'DELIVERED',
      otp: '',
      deliveryOtp: '',
      deliveryOtpVerifiedAt: booking.deliveryOtpVerifiedAt || now,
      deliveryProofUrl: deliveryProofUrl || booking.deliveryProofUrl || null,
      deliveredAt: booking.deliveredAt || now,
      paymentStatus: 'COMPLETED',
    },
    include: {
      pickupAddress: true,
      deliveryAddress: true,
      driver: true,
    },
  });

  await tx.order.upsert({
    where: { bookingId: booking.id },
    create: { bookingId: booking.id, completedAt: now },
    update: { completedAt: now },
  });

  if (booking.driverId) {
    await creditDriverEarning(tx, booking.driverId, booking);

    if (!booking.deliveredAt) {
      await tx.driver.update({
        where: { id: booking.driverId },
        data: { totalTrips: { increment: 1 } },
      });
    }
  }

  return updated;
}

async function creditDriverEarning(tx, driverId, booking) {
  const wallet = await tx.driverWallet.findUnique({ where: { driverId } });
  if (!wallet) return;

  const existingEarning = await tx.driverWalletTransaction.findFirst({
    where: {
      walletId: wallet.id,
      type: 'DELIVERY_EARNING',
      jobId: booking.id,
    },
  });
  if (existingEarning) return;

  const payout = driverEarningFromGross(booking.finalPrice || booking.estimatedPrice);
  const earning = payout.driverAmount;
  await tx.driverWalletTransaction.create({
    data: {
      walletId: wallet.id,
      type: 'DELIVERY_EARNING',
      amount: earning,
      grossAmount: payout.grossAmount,
      platformFeeAmount: payout.platformFeeAmount,
      description: `Delivery earning for job ${booking.id.slice(0, 8)}`,
      jobId: booking.id,
    },
  });
  await tx.driverWallet.update({
    where: { id: wallet.id },
    data: {
      balance: { increment: earning },
      lifetimeEarnings: { increment: earning },
    },
  });
}

// ── OTP Helpers (pickup) ────────────────────────────────────

function generatePickupOtp() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// ── Delivery OTP Active Check ───────────────────────────────

function isDeliveryOtpActive(sentAt, now = new Date()) {
  return !!sentAt && now < new Date(new Date(sentAt).getTime() + DELIVERY_OTP_TTL_MS);
}

module.exports = {
  // State machine
  ALLOWED_TRANSITIONS,
  canTransition,
  isTerminal,
  canUserCancel,
  canDriverCancel,

  // Pricing
  serverQuote,

  // Order codes
  generateNextOrderCode,
  isOrderCodeConflict,

  // Settlement
  isSettlementEligible,
  settleDeliveredBooking,
  creditDriverEarning,

  // Helpers
  money,
  positiveNumber,
  generatePickupOtp,
  isDeliveryOtpActive,
};
