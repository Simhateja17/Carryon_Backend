const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { sendPushNotifications } = require('../lib/firebase');
const { haversineKm } = require('../lib/distance');

const DRIVER_SEARCH_RADIUS_KM = 10;

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
    const {
      pickupAddress, deliveryAddress,
      vehicleType, scheduledTime, estimatedPrice,
      distance, duration, paymentMethod,
      senderName, senderPhone, receiverName, receiverPhone, notes
    } = req.body;

    console.log('[booking] POST /api/bookings — userId:', req.user.userId, 'vehicleType:', vehicleType, 'paymentMethod:', paymentMethod || 'CASH', 'pickup:', pickupAddress?.address, 'delivery:', deliveryAddress?.address);

    if (!pickupAddress || !deliveryAddress) {
      return next(new AppError('pickupAddress and deliveryAddress are required', 400));
    }

    const booking = await prisma.$transaction(async (tx) => {
      const pickup = await tx.address.create({
        data: {
          userId: req.user.userId,
          address: pickupAddress.address || '',
          latitude: pickupAddress.latitude || 0,
          longitude: pickupAddress.longitude || 0,
          contactName: pickupAddress.contactName || senderName || '',
          contactPhone: pickupAddress.contactPhone || senderPhone || '',
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
          landmark: deliveryAddress.landmark || '',
          label: '',
          type: 'OTHER',
        },
      });

      return tx.booking.create({
        data: {
          userId: req.user.userId,
          pickupAddressId: pickup.id,
          deliveryAddressId: delivery.id,
          vehicleType: vehicleType || '',
          scheduledTime: scheduledTime ? new Date(scheduledTime) : null,
          estimatedPrice: estimatedPrice || 0,
          distance: distance || 0,
          duration: duration || 0,
          paymentMethod: paymentMethod || 'CASH',
          otp: generateDeliveryOtp(),
          status: 'SEARCHING_DRIVER',
        },
        include: bookingIncludes,
      });
    });

    console.log('[booking] Created booking id:', booking.id, 'status:', booking.status, 'estimatedPrice:', booking.estimatedPrice);

    // Fire-and-forget FCM push to nearby online drivers
    prisma.driver.findMany({
      where: { isOnline: true, fcmToken: { not: null } },
      select: { fcmToken: true, currentLatitude: true, currentLongitude: true },
    }).then((drivers) => {
      const pickupLat = booking.pickupAddress.latitude;
      const pickupLng = booking.pickupAddress.longitude;
      const nearbyTokens = drivers
        .filter(d => haversineKm(pickupLat, pickupLng, d.currentLatitude, d.currentLongitude) <= DRIVER_SEARCH_RADIUS_KM)
        .map(d => d.fcmToken);
      console.log('[booking] FCM — online drivers found:', drivers.length, 'nearby within', DRIVER_SEARCH_RADIUS_KM, 'km:', nearbyTokens.length, 'tokens to notify');
      if (nearbyTokens.length === 0) return;
      return sendPushNotifications(
        nearbyTokens,
        { title: 'New Ride Request!', body: 'A new delivery job is available near you.' },
        { type: 'JOB_REQUEST', bookingId: booking.id }
      ).then((result) => {
        console.log('[booking] FCM push sent for booking', booking.id, '— successCount:', result?.successCount, 'failureCount:', result?.failureCount);
      });
    }).catch((err) => {
      console.error('[booking] FCM push to drivers failed:', err.message);
    });

    res.status(201).json({ success: true, data: booking });
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

// ── Delivery OTP Verification (#17) ──────────────────────

// POST /api/bookings/:id/verify-delivery - Verify delivery OTP
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

    if (booking.otp !== otp) {
      console.log('[booking] verify-delivery — OTP mismatch for bookingId:', req.params.id);
      return next(new AppError('Invalid delivery OTP', 400));
    }

    const updatedBooking = await prisma.booking.update({
      where: { id: req.params.id },
      data: {
        status: 'DELIVERED',
        deliveryProofUrl: deliveryProofUrl || null,
        deliveredAt: new Date(),
        paymentStatus: booking.paymentMethod === 'CASH' ? 'COMPLETED' : booking.paymentStatus,
      },
      include: bookingIncludes,
    });
    console.log('[booking] verify-delivery — bookingId:', req.params.id, 'OTP matched, status → DELIVERED');

    // Auto-create order record
    await prisma.order.upsert({
      where: { bookingId: req.params.id },
      create: { bookingId: req.params.id },
      update: {},
    });

    // Update driver trip count
    if (booking.driverId) {
      await prisma.driver.update({
        where: { id: booking.driverId },
        data: { totalTrips: { increment: 1 } },
      });
    }

    res.json({ success: true, data: updatedBooking, message: 'Delivery verified successfully' });
  } catch (err) {
    next(err);
  }
});

// ── ETA & Status Updates (#18) ───────────────────────────

// PUT /api/bookings/:id/status - Update booking status
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

    res.json({ success: true, data: updatedBooking });
  } catch (err) {
    next(err);
  }
});

// GET /api/bookings/:id/eta - Get ETA for a booking
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

// POST /api/bookings/:id/cancel - Cancel a booking
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const { reason } = req.body;
    console.log('[booking] POST cancel — userId:', req.user.userId, 'bookingId:', req.params.id, 'reason:', reason || 'none');

    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return next(new AppError('Booking not found', 404));
    if (booking.userId !== req.user.userId) return next(new AppError('Not authorized', 403));

    const nonCancellable = ['DELIVERED', 'CANCELLED'];
    if (nonCancellable.includes(booking.status)) {
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
      const wallet = await prisma.wallet.findUnique({ where: { userId: req.user.userId } });
      if (wallet) {
        await prisma.$transaction([
          prisma.wallet.update({
            where: { id: wallet.id },
            data: { balance: { increment: amount } },
          }),
          prisma.walletTransaction.create({
            data: {
              walletId: wallet.id,
              type: 'REFUND',
              amount,
              description: 'Booking cancellation refund',
              referenceId: req.params.id,
            },
          }),
          prisma.booking.update({
            where: { id: req.params.id },
            data: { paymentStatus: 'REFUNDED' },
          }),
        ]);
      }
    }

    res.json({ success: true, data: updatedBooking, message: 'Booking cancelled successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
