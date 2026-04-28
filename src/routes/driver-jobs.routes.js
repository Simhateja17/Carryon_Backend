const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticateDriver, requireDriver } = require('../middleware/driverAuth');
const { AppError } = require('../middleware/errorHandler');
const { notifyUserBookingEvent } = require('../lib/pushNotifications');
const {
  canTransition,
} = require('../services/bookingLifecycle');
const { getIncomingBookingsForDriver } = require('../services/dispatch');
const { recordAudit } = require('../services/auditLog');
const {
  bookingInclude,
  toDeliveryJob,
  executeDriverLifecycleCommand,
} = require('../services/deliveryLifecycle');

const router = Router();
router.use(authenticateDriver, requireDriver);

const driverLabel = (d) => d?.name?.trim() || d?.email || d?.id || 'unknown';

// Map driver app status → backend BookingStatus
const STATUS_MAP = {
  ACCEPTED: 'DRIVER_ASSIGNED',
  HEADING_TO_PICKUP: 'DRIVER_ASSIGNED',
  ARRIVED_AT_PICKUP: 'DRIVER_ARRIVED',
  PICKED_UP: 'PICKUP_DONE',
  IN_TRANSIT: 'IN_TRANSIT',
  ARRIVED_AT_DROP: 'ARRIVED_AT_DROP',
  DELIVERED: 'DELIVERED',
};

// GET /api/driver/jobs/active
router.get('/active', async (req, res, next) => {
  try {
    console.log('[driver-jobs] GET /active — driver:', driverLabel(req.driver));
    const bookings = await prisma.booking.findMany({
      where: {
        driverId: req.driver.id,
        status: { in: ['DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'PICKUP_DONE', 'IN_TRANSIT', 'ARRIVED_AT_DROP'] },
      },
      include: bookingInclude,
      orderBy: { createdAt: 'desc' },
    });
    console.log('[driver-jobs] GET /active — driver:', driverLabel(req.driver), 'active jobs:', bookings.length);
    res.json({ success: true, data: bookings.map(toDeliveryJob) });
  } catch (err) {
    next(err);
  }
});

// GET /api/driver/jobs/scheduled
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

// GET /api/driver/jobs/completed
router.get('/completed', async (req, res, next) => {
  try {
    const bookings = await prisma.booking.findMany({
      where: {
        driverId: req.driver.id,
        status: 'DELIVERED',
        deliveredAt: { not: null },
        deliveryOtpVerifiedAt: { not: null },
        paymentStatus: 'COMPLETED',
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

// GET /api/driver/jobs/incoming
router.get('/incoming', async (req, res, next) => {
  try {
    console.log('[driver-jobs] GET /incoming — driver:', driverLabel(req.driver), 'location:', req.driver.currentLatitude, req.driver.currentLongitude, 'vehicleType:', req.driver.vehicle?.type);
    const incoming = await getIncomingBookingsForDriver(req.driver, bookingInclude);
    console.log('[driver-jobs] incoming — driver:', driverLabel(req.driver), 'jobs eligible:', incoming.length);
    const job = incoming.length > 0 ? toDeliveryJob(incoming[0]) : null;
    res.json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
});

// GET /api/driver/jobs/incoming-list
router.get('/incoming-list', async (req, res, next) => {
  try {
    console.log('[driver-jobs] GET /incoming-list — driver:', driverLabel(req.driver));
    const incoming = await getIncomingBookingsForDriver(req.driver, bookingInclude);
    res.json({ success: true, data: incoming.map(toDeliveryJob) });
  } catch (err) {
    next(err);
  }
});

// GET /api/driver/jobs/:id
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

// POST /api/driver/jobs/:id/lifecycle-command
router.post('/:id/lifecycle-command', async (req, res, next) => {
  try {
    const result = await executeDriverLifecycleCommand({
      bookingId: req.params.id,
      driver: req.driver,
      command: req.body?.command,
      payload: req.body || {},
    });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/jobs/:id/accept
router.post('/:id/accept', async (req, res, next) => {
  try {
    console.log('[driver-jobs] POST accept — driver:', driverLabel(req.driver), 'bookingId:', req.params.id);
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, include: bookingInclude });
    if (!booking) return next(new AppError('Job not found', 404));
    if (booking.status !== 'SEARCHING_DRIVER' || booking.driverId) {
      console.log('[driver-jobs] accept FAILED — driver:', driverLabel(req.driver), 'bookingId:', req.params.id, 'current status:', booking.status, 'driverId:', booking.driverId || 'null');
      return next(new AppError('Job is no longer available', 409));
    }

    const claimResult = await prisma.$transaction(async (tx) => {
      const result = await tx.booking.updateMany({
        where: {
          id: req.params.id,
          status: 'SEARCHING_DRIVER',
          driverId: null,
        },
        data: {
          driverId: req.driver.id,
          status: 'DRIVER_ASSIGNED',
        },
      });
      if (result.count === 1) {
        await recordAudit(tx, {
          actor: { actorId: req.driver.id, actorType: 'DRIVER' },
          action: 'BOOKING_ASSIGNED',
          entityType: 'Booking',
          entityId: req.params.id,
          oldValue: { status: 'SEARCHING_DRIVER', driverId: null },
          newValue: { status: 'DRIVER_ASSIGNED', driverId: req.driver.id },
        });
      }
      return result;
    });

    if (claimResult.count !== 1) {
      console.log('[driver-jobs] accept CONFLICT — driver:', driverLabel(req.driver), 'bookingId:', req.params.id, 'claim count:', claimResult.count);
      return next(new AppError('Job is no longer available', 409));
    }

    const updated = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: bookingInclude,
    });
    if (!updated) return next(new AppError('Job not found', 404));
    console.log('[driver-jobs]  Accepted — driver:', driverLabel(req.driver), 'bookingId:', req.params.id, 'customer:', booking.user?.name || 'unknown', 'status → DRIVER_ASSIGNED');

    await prisma.driverNotification.create({
      data: {
        driverId: req.driver.id,
        title: 'Job Accepted',
        message: `You accepted job ${req.params.id.slice(0, 8)}. Head to pickup.`,
        type: 'JOB_UPDATE',
      },
    });

    await notifyUserBookingEvent(updated, 'DRIVER_ASSIGNED');

    res.json({ success: true, data: toDeliveryJob(updated) });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/jobs/:id/reject
router.post('/:id/reject', async (req, res, next) => {
  try {
    console.log('[driver-jobs] POST reject — driver:', driverLabel(req.driver), 'bookingId:', req.params.id);
    await prisma.bookingRejection.upsert({
      where: { driverId_bookingId: { driverId: req.driver.id, bookingId: req.params.id } },
      create: { driverId: req.driver.id, bookingId: req.params.id },
      update: {},
    });
    res.json({ success: true, message: 'Job rejected' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/driver/jobs/:id/status
router.put('/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    console.log('[driver-jobs] PUT status — driver:', driverLabel(req.driver), 'bookingId:', req.params.id, 'driverStatus:', status);
    if (!status) return next(new AppError('Status is required', 400));

    const backendStatus = STATUS_MAP[status];
    if (!backendStatus) {
      return next(new AppError(`Invalid status: ${status}`, 400));
    }
    if (backendStatus === 'DELIVERED') {
      return next(new AppError('Use proof submission to complete delivery', 400));
    }
    if (backendStatus === 'PICKUP_DONE') {
      return next(new AppError('Use pickup OTP verification to confirm pickup', 400));
    }

    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return next(new AppError('Job not found', 404));
    if (booking.driverId !== req.driver.id) return next(new AppError('Not authorized', 403));
    if (booking.status === backendStatus) {
      const unchanged = await prisma.booking.findUnique({
        where: { id: req.params.id },
        include: bookingInclude,
      });
      return res.json({ success: true, data: toDeliveryJob(unchanged) });
    }
    if (!canTransition(booking.status, backendStatus)) {
      return next(new AppError(`Cannot transition from ${booking.status} to ${backendStatus}`, 400));
    }

    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.booking.update({
        where: { id: req.params.id },
        data: { status: backendStatus },
        include: bookingInclude,
      });
      await recordAudit(tx, {
        actor: { actorId: req.driver.id, actorType: 'DRIVER' },
        action: 'BOOKING_STATUS_CHANGED',
        entityType: 'Booking',
        entityId: req.params.id,
        oldValue: { status: booking.status },
        newValue: { status: backendStatus },
      });
      return changed;
    });
    console.log('[driver-jobs] Status updated — driver:', driverLabel(req.driver), 'customer:', updated.user?.name || 'unknown', 'bookingId:', req.params.id, 'mapped:', status, '→', backendStatus);

    await notifyUserBookingEvent(updated, backendStatus);

    res.json({ success: true, data: toDeliveryJob(updated) });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/jobs/:id/verify-pickup-otp
router.post('/:id/verify-pickup-otp', async (req, res, next) => {
  try {
    console.log('[driver-jobs] POST verify-pickup-otp — driver:', driverLabel(req.driver), 'bookingId:', req.params.id);
    const result = await executeDriverLifecycleCommand({
      bookingId: req.params.id,
      driver: req.driver,
      command: 'VERIFY_PICKUP_OTP',
      payload: req.body || {},
    });
    res.json({ success: true, data: result.job, message: result.message });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/jobs/:id/request-delivery-otp
router.post('/:id/request-delivery-otp', async (req, res, next) => {
  try {
    console.log('[driver-jobs] POST request-delivery-otp — driver:', driverLabel(req.driver), 'bookingId:', req.params.id);
    const result = await executeDriverLifecycleCommand({
      bookingId: req.params.id,
      driver: req.driver,
      command: 'REQUEST_DROP_OTP',
      payload: req.body || {},
    });
    res.json({ success: true, data: result.otpInfo, message: result.message });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/jobs/:id/proof
router.post('/:id/proof', async (req, res, next) => {
  try {
    console.log('[driver-jobs] POST proof — driver:', driverLabel(req.driver), 'bookingId:', req.params.id);
    const body = req.body || {};
    const result = await executeDriverLifecycleCommand({
      bookingId: req.params.id,
      driver: req.driver,
      command: 'COMPLETE_DELIVERY',
      payload: {
        ...body,
        otp: body.otp || body.otpCode,
        proof: {
          photoUrl: body.photoUrl,
          recipientName: body.recipientName,
        },
      },
    });
    res.json({ success: true, data: result.job, message: result.message });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/jobs/:id/cancel
router.post('/:id/cancel', async (req, res, next) => {
  try {
    console.log('[driver-jobs] POST cancel — driver:', driverLabel(req.driver), 'bookingId:', req.params.id);
    const result = await executeDriverLifecycleCommand({
      bookingId: req.params.id,
      driver: req.driver,
      command: 'CANCEL_BEFORE_PICKUP',
      payload: req.body || {},
    });
    res.json({ success: true, data: result.job, message: result.message });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
