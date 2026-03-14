const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');

const router = Router();
router.use(authenticate);

// POST /api/ratings/:bookingId - Submit a rating for a booking
router.post('/:bookingId', async (req, res, next) => {
  try {
    const { rating, review, tags, tipAmount } = req.body;
    if (!rating || rating < 1 || rating > 5) {
      return next(new AppError('Rating must be between 1 and 5', 400));
    }

    const booking = await prisma.booking.findUnique({
      where: { id: req.params.bookingId },
      include: { order: true },
    });
    if (!booking) return next(new AppError('Booking not found', 404));
    if (booking.userId !== req.user.userId) return next(new AppError('Not authorized', 403));
    if (booking.status !== 'DELIVERED') {
      return next(new AppError('Can only rate delivered bookings', 400));
    }

    // Create or update the order with rating
    const order = await prisma.order.upsert({
      where: { bookingId: req.params.bookingId },
      create: {
        bookingId: req.params.bookingId,
        rating,
        review: review || null,
        tags: tags || [],
        tipAmount: tipAmount || 0,
      },
      update: {
        rating,
        review: review || null,
        tags: tags || [],
        tipAmount: tipAmount || 0,
      },
    });

    // Update driver's average rating
    if (booking.driverId) {
      const driverOrders = await prisma.order.findMany({
        where: {
          booking: { driverId: booking.driverId },
          rating: { not: null },
        },
        select: { rating: true },
      });

      const avgRating =
        driverOrders.reduce((sum, o) => sum + o.rating, 0) / driverOrders.length;

      await prisma.driver.update({
        where: { id: booking.driverId },
        data: { rating: Math.round(avgRating * 10) / 10 },
      });

      // If tip, credit to driver wallet (future: driver wallet)
      if (tipAmount && tipAmount > 0) {
        // Deduct from user wallet if they have balance
        const wallet = await prisma.wallet.findUnique({ where: { userId: req.user.userId } });
        if (wallet && wallet.balance >= tipAmount) {
          await prisma.$transaction([
            prisma.wallet.update({
              where: { id: wallet.id },
              data: { balance: { decrement: tipAmount } },
            }),
            prisma.walletTransaction.create({
              data: {
                walletId: wallet.id,
                type: 'PAYMENT',
                amount: -tipAmount,
                description: 'Tip for driver',
                referenceId: req.params.bookingId,
              },
            }),
          ]);
        }
      }
    }

    res.json({ success: true, data: order });
  } catch (err) {
    next(err);
  }
});

// GET /api/ratings/:bookingId - Get rating for a booking
router.get('/:bookingId', async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({
      where: { bookingId: req.params.bookingId },
    });
    if (!order) return next(new AppError('Rating not found', 404));

    res.json({ success: true, data: order });
  } catch (err) {
    next(err);
  }
});

// GET /api/ratings/driver/:driverId - Get driver's ratings
router.get('/driver/:driverId', async (req, res, next) => {
  try {
    const driver = await prisma.driver.findUnique({
      where: { id: req.params.driverId },
      select: { id: true, name: true, rating: true, totalTrips: true },
    });
    if (!driver) return next(new AppError('Driver not found', 404));

    const reviews = await prisma.order.findMany({
      where: {
        booking: { driverId: req.params.driverId },
        rating: { not: null },
      },
      orderBy: { completedAt: 'desc' },
      take: 20,
      select: {
        rating: true,
        review: true,
        tags: true,
        completedAt: true,
      },
    });

    res.json({ success: true, data: { driver, reviews } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
