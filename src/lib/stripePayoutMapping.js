function stripeObjectId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.id === 'string') return value.id;
  return null;
}

function stripePayoutIdFromTransfer(transfer) {
  const direct = stripeObjectId(transfer?.payout);
  if (direct?.startsWith('po_')) return direct;

  const destinationPayment = transfer?.destination_payment;
  const nested = stripeObjectId(destinationPayment?.payout);
  if (nested?.startsWith('po_')) return nested;

  const destinationPaymentId = stripeObjectId(destinationPayment);
  if (destinationPaymentId?.startsWith('po_')) return destinationPaymentId;

  return null;
}

module.exports = {
  stripeObjectId,
  stripePayoutIdFromTransfer,
};
