const { money } = require('../lib/money');

const ADJUSTMENT_STATUS_APPLIED = 'APPLIED';
const PICKUP_WAIT_TIME_ADJUSTMENT = 'PICKUP_WAIT_TIME';

function baseFareForBooking(booking) {
  return money(booking?.finalPrice || booking?.estimatedPrice || 0);
}

function normalizeAdjustment(adjustment) {
  return {
    id: adjustment.id,
    bookingId: adjustment.bookingId,
    type: adjustment.type,
    amount: money(adjustment.amount || 0),
    description: adjustment.description || '',
    status: adjustment.status || ADJUSTMENT_STATUS_APPLIED,
    metadata: adjustment.metadata || null,
    createdAt: adjustment.createdAt,
    updatedAt: adjustment.updatedAt,
  };
}

function adjustmentTotal(adjustments = []) {
  return money(adjustments.reduce((total, adjustment) => {
    if ((adjustment.status || ADJUSTMENT_STATUS_APPLIED) !== ADJUSTMENT_STATUS_APPLIED) {
      return total;
    }
    return total + Number(adjustment.amount || 0);
  }, 0));
}

function invoiceAmountsForBooking(booking, adjustments = []) {
  const taxRate = 0.05;
  const baseFare = baseFareForBooking(booking);
  const adjustmentsTotal = adjustmentTotal(adjustments);
  const total = money(baseFare + adjustmentsTotal);
  const subtotal = money(total / (1 + taxRate));
  const tax = money(total - subtotal);

  return {
    baseFare,
    adjustmentsTotal,
    subtotal,
    tax,
    total,
    taxRate,
  };
}

async function findAppliedBookingAdjustments(db, bookingId) {
  const adjustments = await db.bookingAdjustment.findMany({
    where: {
      bookingId,
      status: ADJUSTMENT_STATUS_APPLIED,
    },
    orderBy: { createdAt: 'asc' },
  });
  return adjustments.map(normalizeAdjustment);
}

async function upsertPickupWaitTimeAdjustmentTx(tx, { bookingId, waitTimeMinutes, waitTimeCharge }) {
  const amount = money(waitTimeCharge || 0);
  if (amount <= 0) return null;

  return tx.bookingAdjustment.upsert({
    where: {
      bookingId_type: {
        bookingId,
        type: PICKUP_WAIT_TIME_ADJUSTMENT,
      },
    },
    create: {
      bookingId,
      type: PICKUP_WAIT_TIME_ADJUSTMENT,
      amount,
      description: 'Pickup wait-time charge',
      status: ADJUSTMENT_STATUS_APPLIED,
      metadata: { waitTimeMinutes },
    },
    update: {
      amount,
      description: 'Pickup wait-time charge',
      status: ADJUSTMENT_STATUS_APPLIED,
      metadata: { waitTimeMinutes },
    },
  });
}

async function invoiceAmountsForBookingWithAdjustments(db, booking) {
  const adjustments = await findAppliedBookingAdjustments(db, booking.id);
  return {
    adjustments,
    amounts: invoiceAmountsForBooking(booking, adjustments),
  };
}

module.exports = {
  ADJUSTMENT_STATUS_APPLIED,
  PICKUP_WAIT_TIME_ADJUSTMENT,
  adjustmentTotal,
  baseFareForBooking,
  findAppliedBookingAdjustments,
  invoiceAmountsForBooking,
  invoiceAmountsForBookingWithAdjustments,
  upsertPickupWaitTimeAdjustmentTx,
};
