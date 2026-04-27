const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { notifyUserBookingEvent } = require('../lib/pushNotifications');
const {
  serverQuote,
  generateNextOrderCode,
  isOrderCodeConflict,
  settleDeliveredBooking,
  canTransition,
  canUserCancel,
  money,
  isDeliveryOtpActive,
  generatePickupOtp,
} = require('../services/bookingLifecycle');
const { reserveBookingPayment, refundBooking } = require('../services/walletLedger');
const { notifyNearbyDrivers } = require('../services/dispatch');
const { verifyUserDeliveryOtp } = require('../services/deliveryOtp');

const router = Router();
router.use(authenticate);

const bookingIncludes = {
  pickupAddress: true,
  deliveryAddress: true,
  driver: true,
};
const isEmail = (value = '') => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());

// POST /api/bookings
router.post('/', async (req, res, next) => {
  try {
    const {
      pickupAddress, deliveryAddress,
      vehicleType, scheduledTime, estimatedPrice,
      distance, duration, paymentMethod,
      senderName, senderPhone, receiverName, receiverPhone,
      receiverEmail, deliveryMode, notes
    } = req.body;

    console.log('[booking] POST /api/bookings — userId:', req.user.userId, 'vehicleType:', vehicleType, 'paymentMethod:', paymentMethod || 'CASH', 'pickup:', pickupAddress?.address, 'delivery:', deliveryAddress?.address);

    if (!pickupAddress || !deliveryAddress) {
      return next(new AppError('pickupAddress and deliveryAddress are required', 400));
    }
    const recipientEmail = deliveryAddress.contactEmail || receiverEmail || '';
    if (!isEmail(recipientEmail)) {
      return next(new AppError('A valid recipient email is required for delivery OTP.', 400));
    }
    const quote = serverQuote({ pickupAddress, deliveryAddress, vehicleType, deliveryMode, estimatedPrice, distance, duration });
    const normalizedPaymentMethod = String(paymentMethod || 'WALLET').toUpperCase();
    if (normalizedPaymentMethod !== 'WALLET') {
      return next(new AppError('Wallet payment is required. Please top up your wallet before booking.', 400));
    }

    let booking = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        booking = await prisma.$transaction(async (tx) => {
          const pickup = await tx.address.create({
            data: {
              userId: req.user.userId,
              address: pickupAddress.address || '',
              latitude: pickupAddress.latitude || 0,
              longitude: pickupAddress.longitude || 0,
              contactName: pickupAddress.contactName || senderName || '',
              contactPhone: pickupAddress.contactPhone || senderPhone || '',
              contactEmail: pickupAddress.contactEmail || '',
              landmark: pickupAddress.landmark || '',
              label: '',
              type: 'OTHER',
            },
          });

          const delivery = await tx.address.create({
            data: {
              userId: req.user.userId,
              address: deliveryAddress.address || '',
              latitude: deliveryAddress.latitude || 0,
              longitude: deliveryAddress.longitude || 0,
              contactName: deliveryAddress.contactName || receiverName || '',
              contactPhone: deliveryAddress.contactPhone || receiverPhone || '',
              contactEmail: recipientEmail,
              landmark: deliveryAddress.landmark || '',
              label: '',
              type: 'OTHER',
            },
          });

          const orderCode = await generateNextOrderCode(tx);
          const amountDue = money(quote.estimatedPrice);

          const createdBooking = await tx.booking.create({
            data: {
              orderCode,
              userId: req.user.userId,
              pickupAddressId: pickup.id,
              deliveryAddressId: delivery.id,
              vehicleType: vehicleType || '',
              scheduledTime: scheduledTime ? new Date(scheduledTime) : null,
              estimatedPrice: quote.estimatedPrice,
              finalPrice: amountDue,
              distance: quote.distance,
              duration: quote.duration,
              paymentMethod: 'WALLET',
              paymentStatus: 'COMPLETED',
              otp: generatePickupOtp(),
              dispatchSource: 'USER_APP',
              status: 'SEARCHING_DRIVER',
            },
            include: bookingIncludes,
          });

          await reserveBookingPayment(tx, req.user.userId, createdBooking.id, orderCode, amountDue);

          return createdBooking;
        });
        break;
      } catch (err) {
        if (!isOrderCodeConflict(err) || attempt === 2) throw err;
      }
    }

    console.log('[booking] Created booking id:', booking.id, 'status:', booking.status, 'estimatedPrice:', booking.estimatedPrice);

    // Fire-and-forget dispatch to nearby drivers
    notifyNearbyDrivers(booking).catch((err) => {
      console.error('[booking] FCM push to drivers failed:', err.message);
    });

    res.status(201).json({ success: true, data: booking });
  } catch (err) {
    next(err);
  }
});

// POST /api/bookings/quote
router.post('/quote', async (req, res, next) => {
  try {
    const {
      pickupAddress,
      deliveryAddress,
      vehicleType,
      deliveryMode,
      estimatedPrice,
      distance,
      duration,
    } = req.body;

    if (!pickupAddress || !deliveryAddress) {
      return next(new AppError('pickupAddress and deliveryAddress are required', 400));
    }

    const quote = serverQuote({
      pickupAddress,
      deliveryAddress,
      vehicleType,
      deliveryMode,
      estimatedPrice,
      distance,
      duration,
    });

    res.json({
      success: true,
      data: {
        estimatedPrice: quote.estimatedPrice,
        distance: quote.distance,
        duration: quote.duration,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/bookings
router.get('/', async (req, res, next) => {
  try {
    const status = req.query.status;
    const where = { userId: req.user.userId };
    if (status) where.status = status;

    console.log('[booking] GET /api/bookings — userId:', req.user.userId, 'statusFilter:', status || 'all');

    const bookings = await prisma.booking.findMany({
      where,
      include: bookingIncludes,
      orderBy: { createdAt: 'desc' },
    });
    console.log('[booking] GET /api/bookings — returned', bookings.length, 'bookings');
    res.json({ success: true, data: bookings });
  } catch (err) {
    next(err);
  }
});

// GET /api/bookings/:id
router.get('/:id', async (req, res, next) => {
  try {
    console.log('[booking] GET /api/bookings/:id — userId:', req.user.userId, 'bookingId:', req.params.id);
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: { ...bookingIncludes, order: true, invoice: true },
    });
    if (!booking) return next(new AppError('Booking not found', 404));
    if (booking.userId !== req.user.userId) return next(new AppError('Not authorized', 403));

    res.json({ success: true, data: booking });
  } catch (err) {
    next(err);
  }
});

// POST /api/bookings/:id/verify-delivery
router.post('/:id/verify-delivery', async (req, res, next) => {
  try {
    const { otp, deliveryProofUrl } = req.body;
    console.log('[booking] POST verify-delivery — userId:', req.user.userId, 'bookingId:', req.params.id);
    if (!otp) return next(new AppError('OTP is required', 400));

    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: bookingIncludes,
    });
    if (!booking) return next(new AppError('Booking not found', 404));
    if (booking.userId !== req.user.userId) return next(new AppError('Not authorized', 403));
    if (booking.status === 'DELIVERED') {
      return next(new AppError('Booking already delivered', 400));
    }
    if (booking.status === 'CANCELLED') {
      return next(new AppError('Booking is cancelled', 400));
    }
    if (!booking.driverId || booking.status !== 'IN_TRANSIT') {
      return next(new AppError('Delivery verification is only allowed when the job is in transit', 400));
    }
    if (!booking.deliveryOtpSentAt && !booking.deliveryOtp) {
      return next(new AppError('Delivery OTP has not been requested yet', 400));
    }
    if (!isDeliveryOtpActive(booking.deliveryOtpSentAt)) {
      return next(new AppError('Delivery OTP expired. Please request a new code.', 400));
    }

    const recipientEmail = booking.deliveryAddress?.contactEmail || booking.user?.email || req.user.email || '';
    const result = await verifyUserDeliveryOtp({ booking, otp, recipientEmail });
    if (!result.valid) {
      console.log('[booking] verify-delivery — OTP mismatch for bookingId:', req.params.id);
      return next(new AppError(result.error, 400));
    }

    const now = new Date();
    const updatedBooking = await prisma.$transaction((tx) =>
      settleDeliveredBooking(tx, booking, now, deliveryProofUrl)
    );
    console.log('[booking] verify-delivery — bookingId:', req.params.id, 'OTP matched, status → DELIVERED');

    await notifyUserBookingEvent(updatedBooking, 'DELIVERED');

    res.json({ success: true, data: updatedBooking, message: 'Delivery verified successfully' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/bookings/:id/status
router.put('/:id/status', async (req, res, next) => {
  try {
    const { status, eta } = req.body;
    console.log('[booking] PUT status — userId:', req.user.userId, 'bookingId:', req.params.id, 'newStatus:', status);
    if (!status) return next(new AppError('Status is required', 400));

    const validStatuses = [
      'PENDING', 'SEARCHING_DRIVER', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVED',
      'PICKUP_DONE', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED',
    ];
    if (!validStatuses.includes(status)) {
      return next(new AppError('Invalid status', 400));
    }

    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return next(new AppError('Booking not found', 404));
    if (booking.userId !== req.user.userId) return next(new AppError('Not authorized', 403));

    if (!canTransition(booking.status, status)) {
      return next(new AppError(`Cannot transition from ${booking.status} to ${status}`, 400));
    }

    const updateData = { status };
    if (eta !== undefined) updateData.eta = eta;
    if (status === 'DELIVERED') {
      updateData.deliveredAt = new Date();
    }
    if (status === 'CANCELLED') {
      updateData.paymentStatus = 'REFUNDED';
    }

    const updatedBooking = await prisma.booking.update({
      where: { id: req.params.id },
      data: updateData,
      include: bookingIncludes,
    });
    console.log('[booking] Status updated — bookingId:', req.params.id, booking.status, '→', updatedBooking.status);

    await notifyUserBookingEvent(updatedBooking, updatedBooking.status);

    res.json({ success: true, data: updatedBooking });
  } catch (err) {
    next(err);
  }
});

// GET /api/bookings/:id/eta
router.get('/:id/eta', async (req, res, next) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: { driver: true, deliveryAddress: true },
    });
    if (!booking) return next(new AppError('Booking not found', 404));
    if (booking.userId !== req.user.userId) return next(new AppError('Not authorized', 403));

    let etaMinutes = booking.eta || booking.duration || 0;
    let statusMessage = '';

    switch (booking.status) {
      case 'PENDING':
      case 'SEARCHING_DRIVER':
        statusMessage = 'Looking for a driver nearby...';
        break;
      case 'DRIVER_ASSIGNED':
        statusMessage = `${booking.driver?.name || 'Driver'} is on the way to pickup`;
        etaMinutes = booking.eta || 10;
        break;
      case 'DRIVER_ARRIVED':
        statusMessage = 'Driver has arrived at pickup location';
        etaMinutes = 0;
        break;
      case 'PICKUP_DONE':
        statusMessage = 'Package picked up, heading to delivery';
        break;
      case 'IN_TRANSIT':
        statusMessage = `${booking.driver?.name || 'Driver'} is on the way to deliver`;
        break;
      case 'DELIVERED':
        statusMessage = 'Package delivered successfully';
        etaMinutes = 0;
        break;
      case 'CANCELLED':
        statusMessage = 'Booking cancelled';
        etaMinutes = 0;
        break;
    }

    res.json({
      success: true,
      data: {
        status: booking.status,
        etaMinutes,
        statusMessage,
        driverName: booking.driver?.name || null,
        driverPhone: booking.driver?.phone || null,
        driverLocation: booking.driver
          ? { lat: booking.driver.currentLatitude, lng: booking.driver.currentLongitude }
          : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/bookings/:id/cancel
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const { reason } = req.body;
    console.log('[booking] POST cancel — userId:', req.user.userId, 'bookingId:', req.params.id, 'reason:', reason || 'none');

    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return next(new AppError('Booking not found', 404));
    if (booking.userId !== req.user.userId) return next(new AppError('Not authorized', 403));

    if (!canUserCancel(booking.status)) {
      return next(new AppError(`Cannot cancel a ${booking.status.toLowerCase()} booking`, 400));
    }

    const updatedBooking = await prisma.booking.update({
      where: { id: req.params.id },
      data: { status: 'CANCELLED' },
      include: bookingIncludes,
    });
    console.log('[booking] Cancelled — bookingId:', req.params.id, 'previousStatus:', booking.status);

    // Refund wallet if paid via wallet
    if (booking.paymentMethod === 'WALLET' && booking.paymentStatus === 'COMPLETED') {
      const amount = booking.finalPrice || booking.estimatedPrice;
      console.log('[booking] Cancel refund — bookingId:', req.params.id, 'refund amount:', amount);
      await refundBooking(prisma, req.user.userId, req.params.id, amount);
    }

    await notifyUserBookingEvent(updatedBooking, 'CANCELLED');

    res.json({ success: true, data: updatedBooking, message: 'Booking cancelled successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
