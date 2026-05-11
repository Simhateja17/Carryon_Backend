const {
  createInvoiceForBooking,
  getOrCreateInvoiceForBooking,
  isUniqueConstraintError,
} = require('../invoices');

describe('invoice service', () => {
  const booking = {
    id: 'booking-1',
    userId: 'user-1',
    finalPrice: 20,
    estimatedPrice: 20,
    discountAmount: 0,
  };

  function dbMock() {
    return {
      bookingAdjustment: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'adjustment-1',
            bookingId: 'booking-1',
            type: 'PICKUP_WAIT_TIME',
            amount: 1.5,
            status: 'APPLIED',
          },
        ]),
      },
      invoice: {
        create: jest.fn().mockResolvedValue({ id: 'invoice-1', bookingId: 'booking-1', total: 21.5 }),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
  }

  test('creates invoice totals with applied booking adjustments', async () => {
    const db = dbMock();

    await createInvoiceForBooking(db, booking, { now: new Date('2026-05-11T00:00:00.000Z') });

    expect(db.invoice.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookingId: 'booking-1',
        userId: 'user-1',
        subtotal: 20.48,
        tax: 1.02,
        total: 21.5,
        taxRate: 0.05,
        currency: 'MYR',
      }),
    });
  });

  test('returns existing invoice without creating a duplicate', async () => {
    const db = dbMock();
    db.invoice.findUnique.mockResolvedValue({ id: 'invoice-existing', bookingId: 'booking-1' });

    const invoice = await getOrCreateInvoiceForBooking(db, booking);

    expect(invoice.id).toBe('invoice-existing');
    expect(db.invoice.create).not.toHaveBeenCalled();
  });

  test('returns existing invoice when bookingId unique conflict races creation', async () => {
    const db = dbMock();
    db.invoice.create.mockRejectedValueOnce({ code: 'P2002', meta: { target: ['bookingId'] } });
    db.invoice.findUnique.mockResolvedValueOnce({ id: 'invoice-existing', bookingId: 'booking-1' });

    const invoice = await createInvoiceForBooking(db, booking);

    expect(invoice.id).toBe('invoice-existing');
    expect(db.invoice.create).toHaveBeenCalledTimes(1);
  });

  test('detects Prisma unique conflicts for array and string targets', () => {
    expect(isUniqueConstraintError({ code: 'P2002', meta: { target: ['invoiceNumber'] } }, 'invoiceNumber')).toBe(true);
    expect(isUniqueConstraintError({ code: 'P2002', meta: { target: 'Invoice_invoiceNumber_key' } }, 'invoiceNumber')).toBe(true);
    expect(isUniqueConstraintError({ code: 'P2002', meta: { target: ['bookingId'] } }, 'invoiceNumber')).toBe(false);
  });
});
