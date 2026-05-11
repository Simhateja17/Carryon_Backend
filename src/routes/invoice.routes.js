const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { COMPANY_INVOICE_PROFILE } = require('../services/businessConfig');
const { findAppliedBookingAdjustments } = require('../services/bookingAdjustments');
const { getOrCreateInvoiceForBooking } = require('../services/invoices');

const router = Router();
router.use(authenticate);

// POST /api/invoices/:bookingId - Generate invoice for a booking
router.post('/:bookingId', async (req, res, next) => {
  try {
    console.log('[invoice] POST generate — userId:', req.user.userId, 'bookingId:', req.params.bookingId);
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.bookingId },
      include: { pickupAddress: true, deliveryAddress: true, driver: true, invoice: true },
    });
    if (!booking) return next(new AppError('Booking not found', 404));
    if (booking.userId !== req.user.userId) return next(new AppError('Not authorized', 403));

    const hadInvoice = !!booking.invoice;
    const invoice = await getOrCreateInvoiceForBooking(prisma, booking);
    console.log('[invoice] Generated — invoiceId:', invoice.id, 'invoiceNumber:', invoice.invoiceNumber, 'bookingId:', req.params.bookingId, 'total:', invoice.total);

    res.status(hadInvoice ? 200 : 201).json({ success: true, data: invoice });
  } catch (err) {
    next(err);
  }
});

// GET /api/invoices/:bookingId - Get invoice for a booking
router.get('/:bookingId', async (req, res, next) => {
  try {
    console.log('[invoice] GET by bookingId — userId:', req.user.userId, 'bookingId:', req.params.bookingId);
    const invoice = await prisma.invoice.findUnique({
      where: { bookingId: req.params.bookingId },
    });
    if (!invoice) return next(new AppError('Invoice not found', 404));
    if (invoice.userId !== req.user.userId) return next(new AppError('Not authorized', 403));

    res.json({ success: true, data: invoice });
  } catch (err) {
    next(err);
  }
});

// GET /api/invoices - List all user's invoices
router.get('/', async (req, res, next) => {
  try {
    const invoices = await prisma.invoice.findMany({
      where: { userId: req.user.userId },
      orderBy: { issuedAt: 'desc' },
      include: {
        booking: {
          select: {
            id: true,
            vehicleType: true,
            status: true,
            pickupAddress: { select: { address: true } },
            deliveryAddress: { select: { address: true } },
            createdAt: true,
          },
        },
      },
    });

    res.json({ success: true, data: invoices });
  } catch (err) {
    next(err);
  }
});

// GET /api/invoices/:bookingId/detail - Full invoice detail for rendering
router.get('/:bookingId/detail', async (req, res, next) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { bookingId: req.params.bookingId },
    });
    if (!invoice) return next(new AppError('Invoice not found', 404));
    if (invoice.userId !== req.user.userId) return next(new AppError('Not authorized', 403));

    const booking = await prisma.booking.findUnique({
      where: { id: req.params.bookingId },
      include: {
        pickupAddress: true,
        deliveryAddress: true,
        driver: { select: { name: true, phone: true, vehicleNumber: true } },
        user: { select: { name: true, email: true, phone: true } },
      },
    });
    const adjustments = await findAppliedBookingAdjustments(prisma, req.params.bookingId);

    res.json({
      success: true,
      data: {
        invoice,
        adjustments,
        booking: {
          id: booking.id,
          vehicleType: booking.vehicleType,
          distance: booking.distance,
          duration: booking.duration,
          status: booking.status,
          paymentMethod: booking.paymentMethod,
          createdAt: booking.createdAt,
          deliveredAt: booking.deliveredAt,
          pickupAddress: booking.pickupAddress,
          deliveryAddress: booking.deliveryAddress,
          driver: booking.driver,
        },
        customer: {
          name: booking.user.name,
          email: booking.user.email,
          phone: booking.user.phone,
        },
        company: COMPANY_INVOICE_PROFILE,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
