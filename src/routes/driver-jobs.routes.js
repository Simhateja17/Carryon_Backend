const { Router } = require('express');
const multer = require('multer');
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
const { evaluateDriverEligibility } = require('../services/driverEligibility');
const { haversineKm } = require('../lib/distance');
const { DRIVER_SEARCH_RADIUS_KM, OFFER_EXPIRY_MS } = require('../services/businessConfig');
const { uploadToSupabase } = require('../lib/supabase');
const { validateImageMagicBytes } = require('../lib/imageValidation');

const router = Router();

const uploadProof = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new AppError('Only image files are allowed', 400), false);
    }
  },
});
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

    // If job is assigned to a driver, only that driver can view it
    if (booking.driverId && booking.driverId !== req.driver.id) {
      return next(new AppError('Job not found', 404));
    }

    // If job is unassigned, verify this driver is eligible to see it
    if (!booking.driverId) {
      const eligible = await getIncomingBookingsForDriver(req.driver, bookingInclude);
      const isEligible = eligible.some(b => b.id === booking.id);
      if (!isEligible) {
        return next(new AppError('Job not found', 404));
      }
    }

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

    // ── Eligibility checks ──────────────────────────────────
    // 1. Driver must be verified with approved, unexpired documents
    const driverWithDocs = await prisma.driver.findUnique({
      where: { id: req.driver.id },
      include: { documents: true, vehicle: true },
    });
    const eligibility = evaluateDriverEligibility(driverWithDocs);
    if (!eligibility.canGoOnline) {
      return next(new AppError('You must be verified with approved documents to accept jobs', 403));
    }

    // 2. Driver must be online
    if (driverWithDocs.isOnline === false) {
      return next(new AppError('You must be online to accept jobs', 403));
    }

    // 3. Vehicle type must match
    if (booking.vehicleType && driverWithDocs.vehicle?.type && driverWithDocs.vehicle.type !== booking.vehicleType) {
      return next(new AppError('Your vehicle type does not match this job', 400));
    }

    // 4. Distance check — require valid location unless admin-targeted
    const isAdminTargeted = await (async () => {
      // actionData is a String column containing JSON — query candidates then parse
      const candidates = await prisma.driverNotification.findMany({
        where: {
          driverId: req.driver.id,
          type: 'JOB_REQUEST',
          actionData: { contains: booking.id },
        },
        select: { actionData: true },
      });
      return candidates.some((n) => {
        try {
          const parsed = JSON.parse(n.actionData);
          return parsed && parsed.bookingId === booking.id;
        } catch {
          return false;
        }
      });
    })();

    if (!isAdminTargeted) {
      if (!Number.isFinite(driverWithDocs.currentLatitude) || !Number.isFinite(driverWithDocs.currentLongitude)) {
        return next(new AppError('Current location is required to accept jobs', 400));
      }
      if (booking.pickupAddress) {
        const distance = haversineKm(
          driverWithDocs.currentLatitude,
          driverWithDocs.currentLongitude,
          booking.pickupAddress.latitude,
          booking.pickupAddress.longitude
        );
        if (distance > DRIVER_SEARCH_RADIUS_KM) {
          return next(new AppError('You are too far from the pickup location', 400));
        }
      }
    }

    // 5. Must not have rejected this job
    const rejection = await prisma.bookingRejection.findUnique({
      where: { driverId_bookingId: { driverId: req.driver.id, bookingId: req.params.id } },
    });
    if (rejection) {
      return next(new AppError('You cannot accept a job you previously rejected', 400));
    }

    // 6. Offer must not be expired
    const offerAge = Date.now() - new Date(booking.createdAt).getTime();
    if (offerAge > OFFER_EXPIRY_MS) {
      return next(new AppError('This job offer has expired', 410));
    }

    const claimResult = await prisma.$transaction(async (tx) => {
      const assignedAt = new Date();
      const result = await tx.booking.updateMany({
        where: {
          id: req.params.id,
          status: 'SEARCHING_DRIVER',
          driverId: null,
        },
        data: {
          driverId: req.driver.id,
          status: 'DRIVER_ASSIGNED',
          driverAssignedAt: assignedAt,
          driverArrivedAt: null,
        },
      });
      if (result.count === 1) {
        await recordAudit(tx, {
          actor: { actorId: req.driver.id, actorType: 'DRIVER' },
          action: 'BOOKING_ASSIGNED',
          entityType: 'Booking',
          entityId: req.params.id,
          oldValue: { status: 'SEARCHING_DRIVER', driverId: null },
          newValue: { status: 'DRIVER_ASSIGNED', driverId: req.driver.id, driverAssignedAt: assignedAt },
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

// POST /api/driver/jobs/:id/extra-charges/upload-proof — upload receipt proof image
router.post('/:id/extra-charges/upload-proof', uploadProof.single('proof'), async (req, res, next) => {
  try {
    if (!req.file) return next(new AppError('No proof image provided', 400));

    const detected = validateImageMagicBytes(req.file);
    if (!detected) return next(new AppError('File is not a valid image', 400));

    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return next(new AppError('Job not found', 404));
    if (booking.driverId !== req.driver.id) return next(new AppError('Not authorized', 403));

    const ext = detected.ext;
    const fileName = `${req.driver.id}/${booking.id}_${Date.now()}.${ext}`;

    try {
      const proofPath = await uploadToSupabase('extra-charge-proofs', req.file, fileName, { upsert: true });
      res.status(201).json({ success: true, data: { proofPath } });
    } catch (error) {
      console.error('Supabase upload error:', error);
      return next(new AppError('Failed to upload proof', 500));
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/jobs/:id/extra-charges — submit toll/parking for admin approval
router.post('/:id/extra-charges', async (req, res, next) => {
  try {
    const type = String(req.body?.type || '').trim().toUpperCase();
    const amount = Number(req.body?.amount);
    const proofPath = String(req.body?.proofPath || '').trim();
    const note = String(req.body?.note || '').trim();
    if (!['TOLL', 'PARKING'].includes(type)) {
      return next(new AppError('Extra charge type must be TOLL or PARKING', 400));
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return next(new AppError('Amount must be greater than 0', 400));
    }
    if (!proofPath) {
      return next(new AppError('Receipt proof path is required', 400));
    }

    // Reject HTTP URLs — only accept object paths
    if (proofPath.startsWith('http')) {
      return next(new AppError('Public URLs are not accepted. Submit the storage object path only.', 400));
    }

    // Validate path belongs to this driver — format: extra-charge-proofs/<driverId>/<bookingId>_<timestamp>.<ext>
    const allowedPrefix = `extra-charge-proofs/${req.driver.id}/`;
    if (!proofPath.startsWith(allowedPrefix)) {
      return next(new AppError('Proof path must belong to your driver storage', 403));
    }

    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return next(new AppError('Job not found', 404));
    if (booking.driverId !== req.driver.id) return next(new AppError('Not authorized', 403));
    if (['CANCELLED', 'DELIVERED'].includes(booking.status)) {
      return next(new AppError('Extra charges can only be submitted for active jobs', 400));
    }

    const charge = await prisma.bookingExtraCharge.create({
      data: {
        bookingId: booking.id,
        driverId: req.driver.id,
        type,
        amount: Math.round(amount * 100) / 100,
        proofUrl: proofPath,
        note,
      },
    });
    res.status(201).json({ success: true, data: charge });
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
