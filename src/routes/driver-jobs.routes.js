const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticateDriver, requireDriver } = require('../middleware/driverAuth');
const { AppError } = require('../middleware/errorHandler');
const { haversineKm } = require('../lib/distance');

const DRIVER_SEARCH_RADIUS_KM = 10;

const router = Router();
router.use(authenticateDriver, requireDriver);

// Map driver app status → backend BookingStatus
const STATUS_MAP = {
  ACCEPTED: 'DRIVER_ASSIGNED',
  HEADING_TO_PICKUP: 'DRIVER_ASSIGNED',
  ARRIVED_AT_PICKUP: 'DRIVER_ARRIVED',
  PICKED_UP: 'PICKUP_DONE',
  IN_TRANSIT: 'IN_TRANSIT',
  ARRIVED_AT_DROP: 'IN_TRANSIT',
  DELIVERED: 'DELIVERED',
};

// Map backend BookingStatus → driver app status
function toDriverStatus(bookingStatus, extraData) {
  switch (bookingStatus) {
    case 'SEARCHING_DRIVER': return 'PENDING';
    case 'DRIVER_ASSIGNED': return extraData?.driverArrived ? 'HEADING_TO_PICKUP' : 'ACCEPTED';
    case 'DRIVER_ARRIVED': return 'ARRIVED_AT_PICKUP';
    case 'PICKUP_DONE': return 'PICKED_UP';
    case 'IN_TRANSIT': return 'IN_TRANSIT';
    case 'DELIVERED': return 'DELIVERED';
    case 'CANCELLED': return 'CANCELLED';
    default: return 'PENDING';
  }
}

// Common include for booking queries
const bookingInclude = {
  pickupAddress: true,
  deliveryAddress: true,
  user: { select: { id: true, name: true, phone: true, profileImage: true } },
};

// Transform a booking into a DeliveryJob shape for the driver app
function toDeliveryJob(booking) {
  return {
    id: booking.id,
    status: toDriverStatus(booking.status),
    pickup: {
      address: booking.pickupAddress.address,
      shortAddress: booking.pickupAddress.label || booking.pickupAddress.address.split(',')[0],
      latitude: booking.pickupAddress.latitude,
      longitude: booking.pickupAddress.longitude,
      contactName: booking.pickupAddress.contactName,
      contactPhone: booking.pickupAddress.contactPhone,
      instructions: booking.pickupAddress.landmark || '',
    },
    dropoff: {
      address: booking.deliveryAddress.address,
      shortAddress: booking.deliveryAddress.label || booking.deliveryAddress.address.split(',')[0],
      latitude: booking.deliveryAddress.latitude,
      longitude: booking.deliveryAddress.longitude,
      contactName: booking.deliveryAddress.contactName,
      contactPhone: booking.deliveryAddress.contactPhone,
      instructions: booking.deliveryAddress.landmark || '',
    },
    customerName: booking.user?.name || '',
    customerPhone: booking.user?.phone || '',
    packageType: booking.vehicleType,
    packageSize: 'MEDIUM',
    estimatedEarnings: booking.finalPrice || booking.estimatedPrice,
    distance: booking.distance,
    estimatedDuration: booking.duration,
    createdAt: booking.createdAt.toISOString(),
    scheduledAt: booking.scheduledTime?.toISOString() || null,
    acceptedAt: null,
    pickedUpAt: null,
    deliveredAt: booking.deliveredAt?.toISOString() || null,
    completedAt: booking.deliveredAt?.toISOString() || null,
    notes: '',
    proofOfDelivery: booking.deliveryProofUrl ? {
      photoUrl: booking.deliveryProofUrl,
      signatureUrl: null,
      otpCode: null,
      deliveredAt: booking.deliveredAt?.toISOString() || null,
      recipientName: null,
    } : null,
  };
}

// GET /api/driver/jobs/active — bookings assigned to driver in active statuses
router.get('/active', async (req, res, next) => {
  try {
    console.log('[driver-jobs] GET /active — driverId:', req.driver.id);
    const bookings = await prisma.booking.findMany({
      where: {
        driverId: req.driver.id,
        status: { in: ['DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'PICKUP_DONE', 'IN_TRANSIT'] },
      },
      include: bookingInclude,
      orderBy: { createdAt: 'desc' },
    });
    console.log('[driver-jobs] GET /active — driverId:', req.driver.id, 'active jobs:', bookings.length);
    res.json({ success: true, data: bookings.map(toDeliveryJob) });
  } catch (err) {
    next(err);
  }
});

// GET /api/driver/jobs/scheduled — future scheduled bookings
router.get('/scheduled', async (req, res, next) => {
  try {
    const bookings = await prisma.booking.findMany({
      where: {
        driverId: req.driver.id,
        status: 'DRIVER_ASSIGNED',
        scheduledTime: { gt: new Date() },
      },
      include: bookingInclude,
      orderBy: { scheduledTime: 'asc' },
    });
    res.json({ success: true, data: bookings.map(toDeliveryJob) });
  } catch (err) {
    next(err);
  }
});

// GET /api/driver/jobs/completed — delivered/cancelled bookings
router.get('/completed', async (req, res, next) => {
  try {
    const bookings = await prisma.booking.findMany({
      where: {
        driverId: req.driver.id,
        status: { in: ['DELIVERED', 'CANCELLED'] },
      },
      include: bookingInclude,
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
    res.json({ success: true, data: bookings.map(toDeliveryJob) });
  } catch (err) {
    next(err);
  }
});

// GET /api/driver/jobs/incoming — SEARCHING_DRIVER bookings (available to accept)
router.get('/incoming', async (req, res, next) => {
  try {
    console.log('[driver-jobs] GET /incoming — driverId:', req.driver.id, 'location:', req.driver.currentLatitude, req.driver.currentLongitude);
    const bookings = await prisma.booking.findMany({
      where: {
        status: 'SEARCHING_DRIVER',
        driverId: null,
      },
      include: bookingInclude,
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    const driverLat = req.driver.currentLatitude;
    const driverLng = req.driver.currentLongitude;
    const nearby = bookings.filter(b =>
      haversineKm(driverLat, driverLng, b.pickupAddress.latitude, b.pickupAddress.longitude)
      <= DRIVER_SEARCH_RADIUS_KM
    );
    console.log('[driver-jobs] incoming — driverId:', req.driver.id, 'SEARCHING_DRIVER bookings found:', bookings.length, 'passed distance filter:', nearby.length);

    const job = nearby.length > 0 ? toDeliveryJob(nearby[0]) : null;
    res.json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
});

// GET /api/driver/jobs/:id — full detail
router.get('/:id', async (req, res, next) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: bookingInclude,
    });
    if (!booking) return next(new AppError('Job not found', 404));
    res.json({ success: true, data: toDeliveryJob(booking) });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/jobs/:id/accept
router.post('/:id/accept', async (req, res, next) => {
  try {
    console.log('[driver-jobs] POST accept — driverId:', req.driver.id, 'bookingId:', req.params.id);
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return next(new AppError('Job not found', 404));
    if (booking.status !== 'SEARCHING_DRIVER') {
      return next(new AppError('Job is no longer available', 400));
    }

    const updated = await prisma.booking.update({
      where: { id: req.params.id },
      data: { driverId: req.driver.id, status: 'DRIVER_ASSIGNED' },
      include: bookingInclude,
    });
    console.log('[driver-jobs] Accepted — driverId:', req.driver.id, 'bookingId:', req.params.id, 'status → DRIVER_ASSIGNED');

    await prisma.driverNotification.create({
      data: {
        driverId: req.driver.id,
        title: 'Job Accepted',
        message: `You accepted job ${req.params.id.slice(0, 8)}. Head to pickup.`,
        type: 'JOB_UPDATE',
      },
    });

    res.json({ success: true, data: toDeliveryJob(updated) });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/jobs/:id/reject
router.post('/:id/reject', async (req, res, next) => {
  try {
    console.log('[driver-jobs] POST reject — driverId:', req.driver.id, 'bookingId:', req.params.id);
    // Just acknowledge — we don't modify the booking
    res.json({ success: true, message: 'Job rejected' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/driver/jobs/:id/status — update status with mapping
router.put('/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    console.log('[driver-jobs] PUT status — driverId:', req.driver.id, 'bookingId:', req.params.id, 'driverStatus:', status);
    if (!status) return next(new AppError('Status is required', 400));

    const backendStatus = STATUS_MAP[status];
    if (!backendStatus) {
      return next(new AppError(`Invalid status: ${status}`, 400));
    }

    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return next(new AppError('Job not found', 404));
    if (booking.driverId !== req.driver.id) return next(new AppError('Not authorized', 403));

    const updated = await prisma.booking.update({
      where: { id: req.params.id },
      data: { status: backendStatus },
      include: bookingInclude,
    });
    console.log('[driver-jobs] Status updated — driverId:', req.driver.id, 'bookingId:', req.params.id, 'mapped:', status, '→', backendStatus);

    res.json({ success: true, data: toDeliveryJob(updated) });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/jobs/:id/verify-pickup-otp — verify OTP at pickup
router.post('/:id/verify-pickup-otp', async (req, res, next) => {
  try {
    const { otp } = req.body;
    console.log('[driver-jobs] POST verify-pickup-otp — driverId:', req.driver.id, 'bookingId:', req.params.id);
    if (!otp) return next(new AppError('OTP is required', 400));

    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return next(new AppError('Job not found', 404));
    if (booking.driverId !== req.driver.id) return next(new AppError('Not authorized', 403));
    if (booking.status !== 'DRIVER_ARRIVED') {
      return next(new AppError('OTP verification is only allowed when driver has arrived at pickup', 400));
    }
    if (booking.otp !== otp) {
      console.log('[driver-jobs] verify-pickup-otp — OTP mismatch for bookingId:', req.params.id);
      return next(new AppError('Invalid OTP', 400));
    }

    const updated = await prisma.booking.update({
      where: { id: req.params.id },
      data: { status: 'PICKUP_DONE' },
      include: bookingInclude,
    });
    console.log('[driver-jobs] verify-pickup-otp — bookingId:', req.params.id, 'OTP matched, status → PICKUP_DONE');

    res.json({ success: true, data: toDeliveryJob(updated) });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/jobs/:id/proof — proof of delivery
router.post('/:id/proof', async (req, res, next) => {
  try {
    const { photoUrl, recipientName, otpCode } = req.body;
    console.log('[driver-jobs] POST proof — driverId:', req.driver.id, 'bookingId:', req.params.id);
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return next(new AppError('Job not found', 404));
    if (booking.driverId !== req.driver.id) return next(new AppError('Not authorized', 403));

    const now = new Date();

    // Update booking to DELIVERED
    const updated = await prisma.booking.update({
      where: { id: req.params.id },
      data: {
        status: 'DELIVERED',
        deliveryProofUrl: photoUrl || null,
        deliveredAt: now,
        paymentStatus: 'COMPLETED',
      },
      include: bookingInclude,
    });

    // Create Order record
    await prisma.order.upsert({
      where: { bookingId: req.params.id },
      update: { completedAt: now },
      create: { bookingId: req.params.id, completedAt: now },
    });

    // Create earning transaction
    const wallet = await prisma.driverWallet.findUnique({ where: { driverId: req.driver.id } });
    if (wallet) {
      const earning = updated.finalPrice || updated.estimatedPrice;
      console.log('[driver-jobs] proof — bookingId:', req.params.id, 'crediting earnings:', earning, 'to driverId:', req.driver.id);
      await prisma.driverWalletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'DELIVERY_EARNING',
          amount: earning,
          description: `Delivery earning for job ${req.params.id.slice(0, 8)}`,
          jobId: req.params.id,
        },
      });
      await prisma.driverWallet.update({
        where: { id: wallet.id },
        data: {
          balance: { increment: earning },
          lifetimeEarnings: { increment: earning },
        },
      });
    }

    // Update driver stats
    await prisma.driver.update({
      where: { id: req.driver.id },
      data: { totalTrips: { increment: 1 } },
    });

    res.json({ success: true, data: toDeliveryJob(updated) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
