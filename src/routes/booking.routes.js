const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');

const router = Router();
router.use(authenticate);

const bookingIncludes = {
  pickupAddress: true,
  deliveryAddress: true,
  driver: true,
};

function generateDeliveryOtp() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// POST /api/bookings
router.post('/', async (req, res, next) => {
  try {
    const { pickupAddressId, deliveryAddressId, vehicleType, scheduledTime, estimatedPrice, distance, duration, paymentMethod } = req.body;

    // Verify both addresses belong to the user
    const [pickup, delivery] = await Promise.all([
      prisma.address.findUnique({ where: { id: pickupAddressId } }),
      prisma.address.findUnique({ where: { id: deliveryAddressId } }),
    ]);

    if (!pickup || pickup.userId !== req.user.userId) {
      return next(new AppError('Invalid pickup address', 400));
    }
    if (!delivery || delivery.userId !== req.user.userId) {
      return next(new AppError('Invalid delivery address', 400));
    }

    const booking = await prisma.booking.create({
      data: {
        userId: req.user.userId,
        pickupAddressId,
        deliveryAddressId,
        vehicleType: vehicleType || '',
        scheduledTime: scheduledTime ? new Date(scheduledTime) : null,
        estimatedPrice: estimatedPrice || 0,
        distance: distance || 0,
        duration: duration || 0,
        paymentMethod: paymentMethod || 'CASH',
        otp: generateDeliveryOtp(),
      },
      include: bookingIncludes,
    });

    res.status(201).json({ success: true, data: booking });
  } catch (err) {
    next(err);
  }
});

// GET /api/bookings
router.get('/', async (req, res, next) => {
  try {
    const bookings = await prisma.booking.findMany({
      where: { userId: req.user.userId },
      include: bookingIncludes,
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: bookings });
  } catch (err) {
    next(err);
  }
});

// GET /api/bookings/:id
router.get('/:id', async (req, res, next) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: bookingIncludes,
    });
    if (!booking) return next(new AppError('Booking not found', 404));
    if (booking.userId !== req.user.userId) return next(new AppError('Not authorized', 403));

    res.json({ success: true, data: booking });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
