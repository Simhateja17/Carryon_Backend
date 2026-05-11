const { randomInt } = require('crypto');
const { invoiceAmountsForBookingWithAdjustments } = require('./bookingAdjustments');

const MAX_INVOICE_NUMBER_ATTEMPTS = 5;

function generateInvoiceNumber(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const rand = randomInt(1000, 10000);
  return `CO-${y}${m}${d}-${rand}`;
}

function isUniqueConstraintError(err, field) {
  const target = err?.meta?.target;
  if (err?.code !== 'P2002') return false;
  if (Array.isArray(target)) return target.includes(field);
  return typeof target === 'string' && target.includes(field);
}

async function createInvoiceForBooking(db, booking, { now = new Date() } = {}) {
  const { amounts } = await invoiceAmountsForBookingWithAdjustments(db, booking);

  for (let attempt = 0; attempt < MAX_INVOICE_NUMBER_ATTEMPTS; attempt += 1) {
    try {
      return await db.invoice.create({
        data: {
          bookingId: booking.id,
          userId: booking.userId,
          invoiceNumber: generateInvoiceNumber(now),
          subtotal: amounts.subtotal,
          tax: amounts.tax,
          discount: booking.discountAmount || 0,
          total: amounts.total,
          taxRate: amounts.taxRate,
          currency: 'MYR',
        },
      });
    } catch (err) {
      if (isUniqueConstraintError(err, 'bookingId')) {
        const existing = await db.invoice.findUnique({ where: { bookingId: booking.id } });
        if (existing) return existing;
      }
      if (isUniqueConstraintError(err, 'invoiceNumber') && attempt < MAX_INVOICE_NUMBER_ATTEMPTS - 1) {
        continue;
      }
      throw err;
    }
  }

  throw new Error('Unable to generate unique invoice number');
}

async function getOrCreateInvoiceForBooking(db, booking, options) {
  if (booking.invoice) return booking.invoice;

  const existing = await db.invoice.findUnique({ where: { bookingId: booking.id } });
  if (existing) return existing;

  return createInvoiceForBooking(db, booking, options);
}

module.exports = {
  createInvoiceForBooking,
  generateInvoiceNumber,
  getOrCreateInvoiceForBooking,
  isUniqueConstraintError,
};
