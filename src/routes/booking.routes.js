const { Router } = require('express');
const { createClient } = require('@supabase/supabase-js');
const prisma = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { haversineKm } = require('../lib/distance');
const {
  sendPushToDriverIds,
  notifyUserBookingEvent,
} = require('../lib/pushNotifications');

const DRIVER_SEARCH_RADIUS_KM = 10;
const DELIVERY_OTP_TTL_MS = 10 * 60 * 1000;
const VEHICLE_RATE_PER_KM = {
  BIKE: { regular: 0.90, priority: 1.50, pooling: 0.68 },
  CAR: { regular: 1.17, priority: 1.88, pooling: 0.88 },
  PICKUP: { regular: 3.40, priority: 5.90, pooling: 3.00 },
  VAN_7FT: { regular: 5.40, priority: 9.44, pooling: 4.85 },
  VAN_9FT: { regular: 6.40, priority: 10.69, pooling: 5.83 },
  LORRY_10FT: { regular: 8.23, priority: 14.40, pooling: 7.40 },
  LORRY_14FT: { regular: 11.60, priority: 22.60, pooling: 10.44 },
  LORRY_17FT: { regular: 15.60, priority: 26.60, pooling: 13.70 },
};

const router = Router();
router.use(authenticate);
let _supabaseAdmin;
function getSupabaseAdmin() {
  if (!_supabaseAdmin) {
    _supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }
  return _supabaseAdmin;
}

const bookingIncludes = {
  pickupAddress: true,
  deliveryAddress: true,
  driver: true,
};
const isEmail = (value = '') => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());

function generateDeliveryOtp() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function isDeliveryOtpActive(sentAt, now = new Date()) {
  return !!sentAt && now < new Date(new Date(sentAt).getTime() + DELIVERY_OTP_TTL_MS);
}

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function positiveNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function coordinate(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function estimateMinutes(distanceKm) {
  if (!distanceKm || distanceKm <= 0) return 0;
  return Math.max(5, Math.ceil((distanceKm / 30) * 60));
}

function normalizedDeliveryMode(deliveryMode) {
  const mode = String(deliveryMode || 'Regular').trim().toLowerCase();
  if (mode === 'priority') return 'priority';
  if (mode === 'pooling') return 'pooling';
  return 'regular';
}

function serverQuote({ pickupAddress, deliveryAddress, vehicleType, deliveryMode, estimatedPrice, distance, duration }) {
  const pickupLat = coordinate(pickupAddress?.latitude);
  const pickupLng = coordinate(pickupAddress?.longitude);
  const deliveryLat = coordinate(deliveryAddress?.latitude);
  const deliveryLng = coordinate(deliveryAddress?.longitude);
  const directDistance = pickupLat != null && pickupLng != null && deliveryLat != null && deliveryLng != null
    ? haversineKm(pickupLat, pickupLng, deliveryLat, deliveryLng)
    : 0;
  const resolvedDistance = money(Math.max(positiveNumber(distance), directDistance));
  const rates = VEHICLE_RATE_PER_KM[vehicleType] || VEHICLE_RATE_PER_KM.CAR;
  const rate = rates[normalizedDeliveryMode(deliveryMode)] || rates.regular;
  const calculatedPrice = money(resolvedDistance * rate);
  const clientPrice = money(positiveNumber(estimatedPrice));

  return {
    estimatedPrice: Math.max(clientPrice, calculatedPrice),
    distance: resolvedDistance,
    duration: positiveNumber(duration) || estimateMinutes(resolvedDistance),
  };
}

function nextOrderCodeFromLast(lastOrderCode) {
  const match = /^ORD-(\d+)$/.exec(lastOrderCode || '');
  const next = match ? Number(match[1]) + 1 : 1;
  return `ORD-${String(next).padStart(6, '0')}`;
}

async function generateNextOrderCode(tx) {
  const latest = await tx.booking.findFirst({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { orderCode: true },
  });
  return nextOrderCodeFromLast(latest?.orderCode);
}

function isOrderCodeConflict(err) {
  const target = err?.meta?.target;
  if (err?.code !== 'P2002') return false;
  if (Array.isArray(target)) return target.includes('orderCode');
  return typeof target === 'string' && target.includes('orderCode');
}

async function settleDeliveredBooking(tx, booking, now, deliveryProofUrl = null) {
  const updated = await tx.booking.update({
    where: { id: booking.id },
    data: {
      status: 'DELIVERED',
      otp: '',
      deliveryOtp: '',
      deliveryOtpVerifiedAt: booking.deliveryOtpVerifiedAt || now,
      deliveryProofUrl: deliveryProofUrl || booking.deliveryProofUrl || null,
      deliveredAt: booking.deliveredAt || now,
      paymentStatus: 'COMPLETED',
    },
    include: bookingIncludes,
  });

  await tx.order.upsert({
    where: { bookingId: booking.id },
    create: { bookingId: booking.id, completedAt: now },
    update: { completedAt: now },
  });

  if (booking.driverId) {
    const wallet = await tx.driverWallet.findUnique({ where: { driverId: booking.driverId } });
    if (wallet) {
      const existingEarning = await tx.driverWalletTransaction.findFirst({
        where: {
          walletId: wallet.id,
          type: 'DELIVERY_EARNING',
          jobId: booking.id,
        },
      });

      if (!existingEarning) {
        const earning = money(booking.finalPrice || booking.estimatedPrice);
        await tx.driverWalletTransaction.create({
          data: {
            walletId: wallet.id,
            type: 'DELIVERY_EARNING',
            amount: earning,
            description: `Delivery earning for job ${booking.id.slice(0, 8)}`,
            jobId: booking.id,
          },
        });
        await tx.driverWallet.update({
          where: { id: wallet.id },
          data: {
            balance: { increment: earning },
            lifetimeEarnings: { increment: earning },
          },
        });
      }
    }

    if (!booking.deliveredAt) {
      await tx.driver.update({
        where: { id: booking.driverId },
        data: { totalTrips: { increment: 1 } },
      });
    }
  }

  return updated;
}

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

          return tx.booking.create({
            data: {
              orderCode,
              userId: req.user.userId,
              pickupAddressId: pickup.id,
              deliveryAddressId: delivery.id,
              vehicleType: vehicleType || '',
              scheduledTime: scheduledTime ? new Date(scheduledTime) : null,
              estimatedPrice: quote.estimatedPrice,
              distance: quote.distance,
              duration: quote.duration,
              paymentMethod: paymentMethod || 'CASH',
              otp: generateDeliveryOtp(),
              dispatchSource: 'USER_APP',
              status: 'SEARCHING_DRIVER',
            },
            include: bookingIncludes,
          });
        });
        break;
      } catch (err) {
        if (!isOrderCodeConflict(err) || attempt === 2) throw err;
      }
    }

    console.log('[booking] Created booking id:', booking.id, 'status:', booking.status, 'estimatedPrice:', booking.estimatedPrice);

    // Fire-and-forget FCM push to nearby online drivers with matching vehicle type
    prisma.driver.findMany({
      where: { isOnline: true },
      select: { id: true, name: true, currentLatitude: true, currentLongitude: true, vehicle: { select: { type: true } } },
    }).then((drivers) => {
      const pickupLat = booking.pickupAddress.latitude;
      const pickupLng = booking.pickupAddress.longitude;
      const bookingVehicleType = booking.vehicleType;
      console.log('[booking] FCM driver search — booking:', booking.id, '| vehicleType:', bookingVehicleType, '| online drivers:', drivers.length);
      const nearbyDrivers = drivers.filter(d => {
        const withinRadius = haversineKm(pickupLat, pickupLng, d.currentLatitude, d.currentLongitude) <= DRIVER_SEARCH_RADIUS_KM;
        const vehicleMatches = !bookingVehicleType || !d.vehicle?.type || d.vehicle.type === bookingVehicleType;
        return withinRadius && vehicleMatches;
      });
      console.log('[booking] FCM nearby drivers (within', DRIVER_SEARCH_RADIUS_KM, 'km):', nearbyDrivers.length,
        '| notifying:', nearbyDrivers.map(d => d.name));
      const nearbyDriverIds = nearbyDrivers.map((driver) => driver.id);
      if (nearbyDriverIds.length === 0) {
        console.log('[booking] FCM — no nearby drivers found for booking:', booking.id);
        return;
      }
      return sendPushToDriverIds(
        nearbyDriverIds,
        { title: 'New Ride Request!', body: 'A new delivery job is available near you.' },
        { type: 'JOB_REQUEST', bookingId: booking.id }
      ).then((result) => {
        console.log(
          '[booking] FCM push sent for booking',
          booking.id,
          '— successCount:',
          result?.successCount,
          'failureCount:',
          result?.failureCount,
          'noDeviceDrivers:',
          result?.noDeviceActorIds?.length || 0
        );
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
    if (!booking.driverId || booking.status !== 'IN_TRANSIT') {
      return next(new AppError('Delivery verification is only allowed when the job is in transit', 400));
    }
    if (!booking.deliveryOtpSentAt && !booking.deliveryOtp) {
      return next(new AppError('Delivery OTP has not been requested yet', 400));
    }
    if (!isDeliveryOtpActive(booking.deliveryOtpSentAt)) {
      return next(new AppError('Delivery OTP expired. Please request a new code.', 400));
    }

    const normalizedOtp = String(otp).trim();
    if (booking.deliveryOtp) {
      if (booking.deliveryOtp !== normalizedOtp) {
        console.log('[booking] verify-delivery — OTP mismatch for bookingId:', req.params.id);
        return next(new AppError('Invalid delivery OTP', 400));
      }
    } else {
      const recipientEmail = booking.deliveryAddress?.contactEmail || booking.user?.email || req.user.email || '';
      if (!recipientEmail) {
        return next(new AppError('Recipient email is required to verify delivery OTP', 400));
      }
      const { error } = await getSupabaseAdmin().auth.verifyOtp({
        email: recipientEmail,
        token: normalizedOtp,
        type: 'email',
      });
      if (error) {
        console.log('[booking] verify-delivery — Supabase OTP mismatch for bookingId:', req.params.id);
        return next(new AppError('Invalid delivery OTP', 400));
      }
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

    // State machine: only allow valid transitions
    const allowedTransitions = {
      PENDING: ['SEARCHING_DRIVER', 'CANCELLED'],
      SEARCHING_DRIVER: ['DRIVER_ASSIGNED', 'CANCELLED'],
      DRIVER_ASSIGNED: ['DRIVER_ARRIVED', 'CANCELLED'],
      DRIVER_ARRIVED: ['PICKUP_DONE', 'CANCELLED'],
      PICKUP_DONE: ['IN_TRANSIT', 'CANCELLED'],
      IN_TRANSIT: ['DELIVERED', 'CANCELLED'],
      DELIVERED: [],
      CANCELLED: [],
    };
    const allowed = allowedTransitions[booking.status] || [];
    if (!allowed.includes(status)) {
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

    await notifyUserBookingEvent(updatedBooking, 'CANCELLED');

    res.json({ success: true, data: updatedBooking, message: 'Booking cancelled successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
