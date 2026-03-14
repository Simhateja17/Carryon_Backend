const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');

const router = Router();
router.use(authenticate);

function generateInvoiceNumber() {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `CO-${y}${m}${d}-${rand}`;
}

// POST /api/invoices/:bookingId - Generate invoice for a booking
router.post('/:bookingId', async (req, res, next) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.bookingId },
      include: { pickupAddress: true, deliveryAddress: true, driver: true, invoice: true },
    });
    if (!booking) return next(new AppError('Booking not found', 404));
    if (booking.userId !== req.user.userId) return next(new AppError('Not authorized', 403));

    // Return existing invoice if already generated
    if (booking.invoice) {
      return res.json({ success: true, data: booking.invoice });
    }

    const price = booking.finalPrice || booking.estimatedPrice;
    const taxRate = 0.06; // 6% SST Malaysia
    const subtotal = Math.round((price / (1 + taxRate)) * 100) / 100;
    const tax = Math.round((price - subtotal) * 100) / 100;

    const invoice = await prisma.invoice.create({
      data: {
        bookingId: req.params.bookingId,
        userId: req.user.userId,
        invoiceNumber: generateInvoiceNumber(),
        subtotal,
        tax,
        discount: booking.discountAmount || 0,
        total: price,
        taxRate,
        currency: 'MYR',
      },
    });

    res.status(201).json({ success: true, data: invoice });
  } catch (err) {
    next(err);
  }
});

// GET /api/invoices/:bookingId - Get invoice for a booking
router.get('/:bookingId', async (req, res, next) => {
  try {
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

    res.json({
      success: true,
      data: {
        invoice,
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
        company: {
          name: 'CarryOn Logistics Sdn Bhd',
          registration: '202301XXXXXX (XXXXXXX-X)',
          sstNo: 'W10-XXXX-XXXXXXXX',
          address: 'Level XX, Tower X, KLCC\n50088 Kuala Lumpur, Malaysia',
          phone: '+60 3-XXXX XXXX',
          email: 'billing@carryon.my',
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
