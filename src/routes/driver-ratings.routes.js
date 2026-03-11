const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticateDriver, requireDriver } = require('../middleware/driverAuth');
const { AppError } = require('../middleware/errorHandler');

const router = Router();
router.use(authenticateDriver, requireDriver);

// GET /api/driver/ratings — aggregate ratings from Orders
router.get('/', async (req, res, next) => {
  try {
    const bookings = await prisma.booking.findMany({
      where: { driverId: req.driver.id, status: 'DELIVERED' },
      include: {
        order: true,
        user: { select: { name: true } },
      },
    });

    const ratedOrders = bookings
      .filter(b => b.order && b.order.rating)
      .map(b => ({
        id: b.order.id,
        customerName: b.user?.name || 'Customer',
        rating: b.order.rating,
        comment: b.order.review || '',
        timestamp: b.order.completedAt.toISOString(),
        jobId: b.id,
      }));

    const totalRatings = ratedOrders.length;
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let sum = 0;
    for (const r of ratedOrders) {
      distribution[r.rating] = (distribution[r.rating] || 0) + 1;
      sum += r.rating;
    }

    const averageRating = totalRatings > 0 ? sum / totalRatings : 0;

    res.json({
      success: true,
      data: {
        averageRating: Math.round(averageRating * 10) / 10,
        totalRatings,
        fiveStarCount: distribution[5],
        fourStarCount: distribution[4],
        threeStarCount: distribution[3],
        twoStarCount: distribution[2],
        oneStarCount: distribution[1],
        recentFeedback: ratedOrders.slice(0, 10),
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/ratings/:bookingId — rate customer
router.post('/:bookingId', async (req, res, next) => {
  try {
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) {
      return next(new AppError('Rating must be between 1 and 5', 400));
    }

    const booking = await prisma.booking.findUnique({
      where: { id: req.params.bookingId },
      include: { order: true },
    });

    if (!booking) return next(new AppError('Booking not found', 404));
    if (booking.driverId !== req.driver.id) return next(new AppError('Not authorized', 403));

    // Store driver's rating of customer in Order (add fields if needed, or use tags)
    if (booking.order) {
      await prisma.order.update({
        where: { id: booking.order.id },
        data: {
          tags: { push: `driver_rating:${rating}` },
          ...(comment && { review: booking.order.review ? `${booking.order.review} | Driver: ${comment}` : `Driver: ${comment}` }),
        },
      });
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
