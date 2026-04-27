const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticateDriver, requireDriver } = require('../middleware/driverAuth');
const { AppError } = require('../middleware/errorHandler');
const { notifyUserBookingEvent } = require('../lib/pushNotifications');
const { driverEarningFromGross } = require('../lib/money');
const {
  isSettlementEligible,
  canDriverCancel,
  canTransition,
} = require('../services/bookingLifecycle');
const { OFFER_EXPIRY_MS } = require('../services/businessConfig');
const { getIncomingBookingsForDriver } = require('../services/dispatch');
const {
  generateDeliveryOtp,
  deliveryOtpWindow,
  deliveryOtpPayload,
  maskEmail,
  sendEmailOtp,
  verifyDeliveryOtp,
} = require('../services/deliveryOtp');

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
  ARRIVED_AT_DROP: 'IN_TRANSIT',
  DELIVERED: 'DELIVERED',
};

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

const bookingInclude = {
  pickupAddress: true,
  deliveryAddress: true,
  user: { select: { id: true, name: true, email: true, phone: true, profileImage: true } },
};

function toDeliveryJob(booking) {
  const expiresAt = new Date(booking.createdAt.getTime() + OFFER_EXPIRY_MS);
  const proofConfirmed = !!booking.deliveryProofUrl || !!booking.deliveryOtpVerifiedAt || !!booking.deliveredAt;
  return {
    id: booking.id,
    displayOrderId: booking.orderCode || booking.id,
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
      contactEmail: booking.deliveryAddress.contactEmail || '',
      instructions: booking.deliveryAddress.landmark || '',
    },
    customerName: booking.user?.name || '',
    customerEmail: booking.user?.email || '',
    customerPhone: booking.user?.phone || '',
    packageType: booking.vehicleType,
    packageSize: 'MEDIUM',
    estimatedEarnings: driverEarningFromGross(booking.finalPrice || booking.estimatedPrice).driverAmount,
    distance: booking.distance,
    estimatedDuration: booking.duration,
    createdAt: booking.createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    scheduledAt: booking.scheduledTime?.toISOString() || null,
    acceptedAt: null,
    pickedUpAt: null,
    deliveredAt: booking.deliveredAt?.toISOString() || null,
    completedAt: booking.deliveredAt?.toISOString() || null,
    notes: '',
    proofOfDelivery: proofConfirmed
      ? {
        photoUrl: booking.deliveryProofUrl || null,
        signatureUrl: null,
        otpCode: null,
        deliveredAt: booking.deliveredAt?.toISOString() || null,
        recipientName: booking.deliveryAddress?.contactName || booking.user?.name || null,
      }
      : null,
  };
}

// GET /api/driver/jobs/active
router.get('/active', async (req, res, next) => {
  try {
    console.log('[driver-jobs] GET /active — driver:', driverLabel(req.driver));
    const bookings = await prisma.booking.findMany({
      where: {
        driverId: req.driver.id,
        status: { in: ['DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'PICKUP_DONE', 'IN_TRANSIT'] },
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

    const claimResult = await prisma.booking.updateMany({
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

    const updated = await prisma.booking.update({
      where: { id: req.params.id },
      data: { status: backendStatus },
      include: bookingInclude,
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
    const { otp } = req.body;
    console.log('[driver-jobs] POST verify-pickup-otp — driver:', driverLabel(req.driver), 'bookingId:', req.params.id);
    if (!otp) return next(new AppError('OTP is required', 400));

    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return next(new AppError('Job not found', 404));
    if (booking.driverId !== req.driver.id) return next(new AppError('Not authorized', 403));
    if (booking.status !== 'DRIVER_ARRIVED') {
      return next(new AppError('OTP verification is only allowed when driver has arrived at pickup', 400));
    }
    if (booking.otp !== String(otp).trim()) {
      console.log('[driver-jobs] verify-pickup-otp — OTP mismatch — driver:', driverLabel(req.driver), 'bookingId:', req.params.id);
      return next(new AppError('Invalid OTP', 400));
    }

    const updated = await prisma.booking.update({
      where: { id: req.params.id },
      data: { status: 'PICKUP_DONE' },
      include: bookingInclude,
    });
    console.log('[driver-jobs] verify-pickup-otp — driver:', driverLabel(req.driver), 'customer:', updated.user?.name || 'unknown', 'bookingId:', req.params.id, 'OTP matched, status → PICKUP_DONE');

    await notifyUserBookingEvent(updated, 'PICKUP_DONE');

    res.json({ success: true, data: toDeliveryJob(updated) });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/jobs/:id/request-delivery-otp
router.post('/:id/request-delivery-otp', async (req, res, next) => {
  try {
    const forceResend = req.body?.forceResend === true;
    const now = new Date();
    console.log('[driver-jobs] POST request-delivery-otp — driver:', driverLabel(req.driver), 'bookingId:', req.params.id);
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: bookingInclude,
    });
    if (!booking) return next(new AppError('Job not found', 404));
    if (booking.driverId !== req.driver.id) return next(new AppError('Not authorized', 403));
    if (booking.status === 'DELIVERED' || booking.status === 'CANCELLED') {
      return next(new AppError('Cannot request OTP for completed/cancelled job', 400));
    }

    const recipientEmail = booking.deliveryAddress?.contactEmail || booking.user?.email || '';
    const isAdminDispatch = booking.dispatchSource === 'ADMIN';
    if (!isAdminDispatch && !recipientEmail) {
      return next(new AppError('Recipient email is required to send delivery OTP', 400));
    }

    const existingWindow = deliveryOtpWindow(booking.deliveryOtpSentAt, now);
    const hasActiveAdminOtp = isAdminDispatch && booking.deliveryOtp && existingWindow.active;
    const hasActiveEmailOtp = !isAdminDispatch && booking.deliveryOtpSentAt && existingWindow.active;
    if (!forceResend && (hasActiveAdminOtp || hasActiveEmailOtp)) {
      return res.json({
        success: true,
        data: deliveryOtpPayload({
          booking,
          recipientEmail,
          now,
          adminOtp: isAdminDispatch ? booking.deliveryOtp : null,
          alreadySent: true,
        }),
        message: recipientEmail
          ? `OTP already sent for ${maskEmail(recipientEmail)}`
          : 'OTP already generated',
      });
    }

    if (forceResend && booking.deliveryOtpSentAt && !existingWindow.canResend) {
      return res.json({
        success: true,
        data: deliveryOtpPayload({
          booking,
          recipientEmail,
          now,
          adminOtp: isAdminDispatch ? booking.deliveryOtp : null,
          alreadySent: true,
        }),
        message: `OTP can be resent after ${existingWindow.resendAvailableAt.toISOString()}`,
      });
    }

    const generatedOtp = generateDeliveryOtp();
    const updateData = {
      deliveryOtpSentAt: now,
      deliveryOtpVerifiedAt: null,
    };
    if (isAdminDispatch) {
      updateData.deliveryOtp = generatedOtp;
    } else {
      updateData.deliveryOtp = '';
    }
    const updatedBooking = await prisma.booking.update({
      where: { id: req.params.id },
      data: updateData,
      include: bookingInclude,
    });

    if (!isAdminDispatch && recipientEmail) {
      await sendEmailOtp(recipientEmail);
    }

    console.log(
      '[driver-jobs] request-delivery-otp — driver:',
      driverLabel(req.driver),
      'bookingId:',
      req.params.id,
      'dispatchSource:',
      booking.dispatchSource,
      'recipient:',
      maskEmail(recipientEmail),
      'otpStoredForAdmin:',
      isAdminDispatch ? generatedOtp : '[supabase-email-otp]'
    );

    await notifyUserBookingEvent(updatedBooking, 'DELIVERY_OTP_REQUESTED');

    res.json({
      success: true,
      data: deliveryOtpPayload({
        booking: updatedBooking,
        recipientEmail,
        now,
        adminOtp: isAdminDispatch ? generatedOtp : null,
        alreadySent: false,
      }),
      message: recipientEmail
        ? `OTP sent for ${maskEmail(recipientEmail)}`
        : 'OTP generated (recipient email missing)',
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/jobs/:id/proof
router.post('/:id/proof', async (req, res, next) => {
  try {
    const { photoUrl, recipientName, otpCode } = req.body;
    console.log('[driver-jobs] POST proof — driver:', driverLabel(req.driver), 'bookingId:', req.params.id);
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return next(new AppError('Job not found', 404));
    if (booking.driverId !== req.driver.id) return next(new AppError('Not authorized', 403));
    if (booking.status === 'DELIVERED') {
      if (!isSettlementEligible(booking)) {
        return next(new AppError('Delivered booking is missing handover verification', 409));
      }
      const alreadyDelivered = await prisma.booking.findUnique({
        where: { id: req.params.id },
        include: bookingInclude,
      });
      return res.json({ success: true, data: toDeliveryJob(alreadyDelivered) });
    }
    if (!otpCode || String(otpCode).trim().length < 4) {
      return next(new AppError('Recipient OTP is required', 400));
    }

    const recipientEmail = booking.deliveryAddress?.contactEmail || booking.user?.email || '';
    const otpWindow = deliveryOtpWindow(booking.deliveryOtpSentAt);
    if (!booking.deliveryOtpSentAt || !otpWindow.active) {
      return next(new AppError('Recipient OTP expired. Please resend the OTP.', 400));
    }

    const otpResult = await verifyDeliveryOtp({ booking, otp: otpCode, recipientEmail });
    if (!otpResult.valid) {
      return next(new AppError(otpResult.error, 400));
    }

    const now = new Date();

    const updated = await prisma.$transaction(async (tx) => {
      const { creditDriverEarning } = require('../services/bookingLifecycle');

      const deliverResult = await tx.booking.updateMany({
        where: {
          id: req.params.id,
          driverId: req.driver.id,
          status: { not: 'DELIVERED' },
        },
        data: {
          status: 'DELIVERED',
          deliveryProofUrl: photoUrl || null,
          deliveryOtp: '',
          deliveryOtpVerifiedAt: now,
          deliveredAt: now,
          paymentStatus: 'COMPLETED',
        },
      });

      const deliveredBooking = await tx.booking.findUnique({
        where: { id: req.params.id },
        include: bookingInclude,
      });
      if (!deliveredBooking) throw new AppError('Job not found', 404);
      if (deliverResult.count !== 1) return deliveredBooking;

      await tx.order.upsert({
        where: { bookingId: req.params.id },
        update: { completedAt: now },
        create: { bookingId: req.params.id, completedAt: now },
      });

      await creditDriverEarning(tx, req.driver.id, deliveredBooking);

      await tx.driver.update({
        where: { id: req.driver.id },
        data: { totalTrips: { increment: 1 } },
      });

      return deliveredBooking;
    });

    await notifyUserBookingEvent(updated, 'DELIVERED');

    res.json({ success: true, data: toDeliveryJob(updated) });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/jobs/:id/cancel
router.post('/:id/cancel', async (req, res, next) => {
  try {
    console.log('[driver-jobs] POST cancel — driver:', driverLabel(req.driver), 'bookingId:', req.params.id);
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return next(new AppError('Job not found', 404));
    if (booking.driverId !== req.driver.id) return next(new AppError('Not authorized', 403));

    if (!canDriverCancel(booking.status)) {
      if (booking.status === 'DELIVERED' || booking.status === 'CANCELLED') {
        return next(new AppError('Job is already completed or cancelled', 400));
      }
      return next(new AppError('Cannot cancel after picking up the package', 400));
    }

    const updated = await prisma.booking.update({
      where: { id: req.params.id },
      data: { status: 'SEARCHING_DRIVER', driverId: null },
      include: bookingInclude,
    });
    console.log('[driver-jobs] cancel — driver:', driverLabel(req.driver), 'bookingId:', req.params.id, 'status → SEARCHING_DRIVER, driver unassigned');

    res.json({ success: true, data: toDeliveryJob(updated) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
