const { taxExclusiveSplitFromGross } = require('../lib/money');

function taxLiabilityDataForBooking(booking, taxRate = 0.06) {
  const split = taxExclusiveSplitFromGross(booking.finalPrice || booking.estimatedPrice || 0, taxRate);
  return {
    split,
    data: {
      bookingId: booking.id,
      userId: booking.userId,
      taxableAmount: split.taxableAmount,
      taxAmount: split.taxAmount,
      totalAmount: split.grossAmount,
      taxRate: split.taxRate,
      currency: 'MYR',
      status: 'PENDING',
      source: 'BOOKING',
    },
  };
}

async function upsertBookingTaxLiabilityTx(tx, booking, taxRate = 0.06) {
  if (!tx.taxLiability || !booking?.id || !booking?.userId) return null;

  const { data } = taxLiabilityDataForBooking(booking, taxRate);
  return tx.taxLiability.upsert({
    where: { bookingId: booking.id },
    create: data,
    update: {
      taxableAmount: data.taxableAmount,
      taxAmount: data.taxAmount,
      totalAmount: data.totalAmount,
      taxRate: data.taxRate,
      currency: data.currency,
      source: data.source,
    },
  });
}

module.exports = {
  taxLiabilityDataForBooking,
  upsertBookingTaxLiabilityTx,
};
