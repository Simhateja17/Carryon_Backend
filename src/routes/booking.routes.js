const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { notifyUserBookingEvent } = require('../lib/pushNotifications');
const { parseBody } = require('../lib/validation');
const {
  generateNextOrderCode,
  isOrderCodeConflict,
  canTransition,
  canUserCancel,
  money,
  generatePickupOtp,
} = require('../services/bookingLifecycle');
const { quoteBookingFare } = require('../services/bookingPricing');
const {
  creditDriverAdjustmentTx,
  reserveBookingPayment,
  refundBookingTx,
} = require('../services/walletLedger');
const { notifyNearbyDrivers } = require('../services/dispatch');
const { recordAudit } = require('../services/auditLog');
const { computeCancellationOutcome, isRegularBookingMode } = require('../services/bookingPolicy');
const { executeUserLifecycleCommand } = require('../services/deliveryLifecycle');
const {
  idempotencyKeyFromRequest,
  validateIdempotencyKey,
  idempotencyExpiresAt,
  isIdempotencyConflict,
} = require('../services/idempotency');
const {
  bookingCancelSchema,
  bookingCreateSchema,
  bookingQuoteSchema,
  bookingStatusSchema,
  bookingVerifyDeliverySchema,
} = require('../validation/financialSchemas');

const router = Router();
router.use(authenticate);
const enforceRegularOnly = () => process.env.ENFORCE_REGULAR_BOOKING_MODE === 'true';

const bookingIncludes = {
  pickupAddress: true,
  deliveryAddress: true,
  driver: true,
};
const isEmail = (value = '') => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());

function parseCoordinate(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requireCoordinates(address, label) {
  const latitude = parseCoordinate(address?.latitude);
  const longitude = parseCoordinate(address?.longitude);
  if (latitude == null || longitude == null) {
    throw new AppError(`Valid ${label} latitude and longitude are required`, 400);
  }
  return { latitude, longitude };
}

async function findIdempotentBooking(userId, key) {
  const record = await prisma.idempotencyKey.findUnique({
    where: { userId_key: { userId, key } },
    include: {
      booking: { include: bookingIncludes },
    },
  });
  if (!record || record.expiresAt <= new Date()) return null;
  return record.booking;
}

// POST /api/bookings
router.post('/', async (req, res, next) => {
  try {
    const {
      pickupAddress, deliveryAddress,
      vehicleType, scheduledTime,
      paymentMethod,
      senderName, senderPhone, receiverName, receiverPhone,
      receiverEmail, deliveryMode, offloading, notes
    } = parseBody(bookingCreateSchema, req.body);

    console.log('[booking] POST /api/bookings — userId:', req.user.userId, 'vehicleType:', vehicleType, 'paymentMethod:', paymentMethod || 'CASH');

    const idempotencyKey = idempotencyKeyFromRequest(req);
    if (!validateIdempotencyKey(idempotencyKey)) {
      return next(new AppError('Idempotency-Key header is required for booking creation', 400));
    }
    const idempotentBooking = await findIdempotentBooking(req.user.userId, idempotencyKey);
    if (idempotentBooking) {
      return res.status(201).json({ success: true, data: idempotentBooking, idempotent: true });
    }
    await prisma.idempotencyKey.deleteMany({
      where: { userId: req.user.userId, key: idempotencyKey, expiresAt: { lte: new Date() } },
    });
    if (enforceRegularOnly() && (scheduledTime || !isRegularBookingMode(deliveryMode))) {
      return next(new AppError('Only regular immediate bookings are supported.', 400));
    }

    const recipientEmail = deliveryAddress.contactEmail || receiverEmail || '';
    if (!isEmail(recipientEmail)) {
      return next(new AppError('A valid recipient email is required for delivery OTP.', 400));
    }
    const pickupCoords = requireCoordinates(pickupAddress, 'pickup');
    const deliveryCoords = requireCoordinates(deliveryAddress, 'delivery');
    const normalizedPickupAddress = { ...pickupAddress, ...pickupCoords };
    const normalizedDeliveryAddress = { ...deliveryAddress, ...deliveryCoords };
    const quote = await quoteBookingFare({
      pickupAddress: normalizedPickupAddress,
      deliveryAddress: normalizedDeliveryAddress,
      vehicleType,
      deliveryMode,
      offloading,
    });
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
              address: normalizedPickupAddress.address || '',
              latitude: normalizedPickupAddress.latitude,
              longitude: normalizedPickupAddress.longitude,
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
              address: normalizedDeliveryAddress.address || '',
              latitude: normalizedDeliveryAddress.latitude,
              longitude: normalizedDeliveryAddress.longitude,
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
              scheduledTime: null,
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
          await tx.idempotencyKey.create({
            data: {
              userId: req.user.userId,
              key: idempotencyKey,
              bookingId: createdBooking.id,
              expiresAt: idempotencyExpiresAt(),
            },
          });
          await recordAudit(tx, {
            actor: { actorId: req.user.userId, actorType: 'USER' },
            action: 'BOOKING_CREATED',
            entityType: 'Booking',
            entityId: createdBooking.id,
            newValue: {
              status: createdBooking.status,
              finalPrice: createdBooking.finalPrice,
              distance: createdBooking.distance,
              idempotencyKey,
            },
          });

          return createdBooking;
        });
        break;
      } catch (err) {
        if (isIdempotencyConflict(err)) {
          const existing = await findIdempotentBooking(req.user.userId, idempotencyKey);
          if (existing) {
            return res.status(201).json({ success: true, data: existing, idempotent: true });
          }
        }
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
      offloading,
    } = parseBody(bookingQuoteSchema, req.body);
    if (enforceRegularOnly() && !isRegularBookingMode(deliveryMode)) {
      return next(new AppError('Only regular immediate bookings are supported.', 400));
    }

    const quote = await quoteBookingFare({
      pickupAddress,
      deliveryAddress,
      vehicleType,
      deliveryMode,
      offloading,
    });

    res.json({
      success: true,
      data: {
        estimatedPrice: quote.estimatedPrice,
        price: quote.price,
        distance: quote.distance,
        duration: quote.duration,
        breakdown: quote.breakdown,
        isEstimated: quote.isEstimated,
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
    const { otp, deliveryProofUrl } = parseBody(bookingVerifyDeliverySchema, req.body);
    console.log('[booking] POST verify-delivery — userId:', req.user.userId, 'bookingId:', req.params.id);
    await executeUserLifecycleCommand({
      bookingId: req.params.id,
      user: req.user,
      command: 'COMPLETE_DELIVERY',
      payload: {
        otp,
        proof: {
          photoUrl: deliveryProofUrl || null,
          recipientName: req.user.name || req.user.email || null,
        },
      },
    });
    const updatedBooking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: bookingIncludes,
    });
    res.json({ success: true, data: updatedBooking, message: 'Delivery verified successfully' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/bookings/:id/status
// This endpoint is disabled for customers. All status changes must go through
// dedicated endpoints: POST /bookings/:id/cancel for cancellation,
// driver endpoints for operational statuses.
router.put('/:id/status', async (req, res, next) => {
  return next(new AppError('Invalid status', 400));
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
      case 'ARRIVED_AT_DROP':
        statusMessage = 'Driver has arrived at drop-off';
        etaMinutes = 0;
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
    const { reason } = parseBody(bookingCancelSchema, req.body);
    console.log('[booking] POST cancel — userId:', req.user.userId, 'bookingId:', req.params.id, 'reason:', reason || 'none');

    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return next(new AppError('Booking not found', 404));
    if (booking.userId !== req.user.userId) return next(new AppError('Not authorized', 403));

    if (!canUserCancel(booking.status)) {
      return next(new AppError(`Cannot cancel a ${booking.status.toLowerCase()} booking`, 400));
    }

    const updatedBooking = await prisma.$transaction(async (tx) => {
      const shouldRefund = booking.paymentMethod === 'WALLET' && booking.paymentStatus === 'COMPLETED';
      const cancellation = shouldRefund
        ? computeCancellationOutcome({ booking, actorType: 'USER' })
        : {
          cancelledBy: 'USER',
          fee: 0,
          driverShare: 0,
          platformShare: 0,
          refundAmount: 0,
          feeApplies: false,
        };
      const updated = await tx.booking.update({
        where: { id: req.params.id },
        data: {
          status: 'CANCELLED',
          cancelledBy: 'USER',
          cancelReason: reason || '',
          cancellationFee: cancellation.fee,
          cancellationDriverShare: cancellation.driverShare,
          cancellationPlatformShare: cancellation.platformShare,
          ...(shouldRefund && { paymentStatus: 'REFUNDED' }),
        },
        include: bookingIncludes,
      });
      await recordAudit(tx, {
        actor: { actorId: req.user.userId, actorType: 'USER' },
        action: 'BOOKING_CANCELLED',
        entityType: 'Booking',
        entityId: req.params.id,
        oldValue: { status: booking.status },
        newValue: {
          status: 'CANCELLED',
          reason: reason || '',
          cancellationFee: cancellation.fee,
          cancellationDriverShare: cancellation.driverShare,
          cancellationPlatformShare: cancellation.platformShare,
          refundAmount: cancellation.refundAmount,
        },
      });
      if (shouldRefund && cancellation.refundAmount > 0) {
        console.log('[booking] Cancel refund — bookingId:', req.params.id, 'refund amount:', cancellation.refundAmount);
        await refundBookingTx(tx, req.user.userId, req.params.id, cancellation.refundAmount);
      }
      if (cancellation.driverShare > 0 && booking.driverId) {
        await creditDriverAdjustmentTx(
          tx,
          booking.driverId,
          req.params.id,
          cancellation.driverShare,
          'Customer cancellation compensation'
        );
      }
      return updated;
    });
    console.log('[booking] Cancelled — bookingId:', req.params.id, 'previousStatus:', booking.status);

    await notifyUserBookingEvent(updatedBooking, 'CANCELLED');

    res.json({ success: true, data: updatedBooking, message: 'Booking cancelled successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
