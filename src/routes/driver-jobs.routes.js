const { Router } = require('express');
const { createClient } = require('@supabase/supabase-js');
const prisma = require('../lib/prisma');
const { authenticateDriver, requireDriver } = require('../middleware/driverAuth');
const { AppError } = require('../middleware/errorHandler');
const { haversineKm } = require('../lib/distance');
const { OTP_LENGTH, generateOtp, isValidOtp, normalizeOtp } = require('../lib/otp');

const DRIVER_SEARCH_RADIUS_KM = 10;
const OFFER_EXPIRY_MS = 60 * 1000;

const router = Router();
router.use(authenticateDriver, requireDriver);

// Helper: display name for logs (falls back to email if name is blank)
const driverLabel = (d) => d?.name?.trim() || d?.email || d?.id || 'unknown';
const maskEmail = (email = '') => {
  const [local = '', domain = ''] = String(email).split('@');
  if (!local || !domain) return email;
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
};
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

function isSettlementEligibleBooking(booking) {
  return (
    booking.status === 'DELIVERED' &&
    !!booking.deliveredAt &&
    !!booking.deliveryOtpVerifiedAt &&
    booking.paymentStatus === 'COMPLETED'
  );
}

// Common include for booking queries
const bookingInclude = {
  pickupAddress: true,
  deliveryAddress: true,
  user: { select: { id: true, name: true, email: true, phone: true, profileImage: true } },
};

// Transform a booking into a DeliveryJob shape for the driver app
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
    estimatedEarnings: booking.finalPrice || booking.estimatedPrice,
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

function bookingPayout(booking) {
  return Number(booking.finalPrice || booking.estimatedPrice || 0);
}

function sortIncomingBookings(bookings) {
  return [...bookings].sort((a, b) => {
    const payoutDiff = bookingPayout(b) - bookingPayout(a);
    if (payoutDiff !== 0) return payoutDiff;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

function activeOfferWhereClause(extraWhere = {}) {
  return {
    status: 'SEARCHING_DRIVER',
    driverId: null,
    createdAt: { gte: new Date(Date.now() - OFFER_EXPIRY_MS) },
    ...extraWhere,
  };
}

async function getIncomingBookingsForDriver(driver) {
  // Fetch bookings this driver has already rejected
  const rejections = await prisma.bookingRejection.findMany({
    where: { driverId: driver.id },
    select: { bookingId: true },
  });
  const rejectedIds = rejections.map(r => r.bookingId);

  // First priority: explicit admin-targeted requests for this driver.
  const targetedNotifications = await prisma.driverNotification.findMany({
    where: {
      driverId: driver.id,
      type: 'JOB_REQUEST',
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { actionData: true },
  });

  const targetedBookingIds = targetedNotifications
    .map((n) => {
      try {
        const payload = n.actionData ? JSON.parse(n.actionData) : null;
        if (!payload || payload.targeted !== true || !payload.bookingId) return null;
        return String(payload.bookingId);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const targetedBookings = targetedBookingIds.length > 0
    ? await prisma.booking.findMany({
      where: activeOfferWhereClause({
        id: {
          in: targetedBookingIds,
          ...(rejectedIds.length > 0 && { notIn: rejectedIds }),
        },
      }),
      include: bookingInclude,
      take: 50,
    })
    : [];

  const bookings = await prisma.booking.findMany({
    where: activeOfferWhereClause(
      rejectedIds.length > 0 ? { id: { notIn: rejectedIds } } : {}
    ),
    include: bookingInclude,
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  const driverLat = driver.currentLatitude;
  const driverLng = driver.currentLongitude;
  const driverVehicleType = driver.vehicle?.type;

  const nearby = bookings.filter((booking) => {
    const withinRadius =
      haversineKm(
        driverLat,
        driverLng,
        booking.pickupAddress.latitude,
        booking.pickupAddress.longitude
      ) <= DRIVER_SEARCH_RADIUS_KM;
    const vehicleMatches = !driverVehicleType || booking.vehicleType === driverVehicleType;
    return withinRadius && vehicleMatches;
  });

  const dedupedById = new Map();
  [...targetedBookings, ...nearby].forEach((booking) => {
    if (!dedupedById.has(booking.id)) {
      dedupedById.set(booking.id, booking);
    }
  });

  return sortIncomingBookings(Array.from(dedupedById.values()));
}

// GET /api/driver/jobs/active — bookings assigned to driver in active statuses
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

// GET /api/driver/jobs/completed — only settled, handover-confirmed deliveries
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

// GET /api/driver/jobs/incoming — SEARCHING_DRIVER bookings (available to accept)
router.get('/incoming', async (req, res, next) => {
  try {
    console.log('[driver-jobs] GET /incoming — driver:', driverLabel(req.driver), 'location:', req.driver.currentLatitude, req.driver.currentLongitude, 'vehicleType:', req.driver.vehicle?.type);
    const incoming = await getIncomingBookingsForDriver(req.driver);
    console.log('[driver-jobs] incoming — driver:', driverLabel(req.driver), 'jobs eligible:', incoming.length);
    const job = incoming.length > 0 ? toDeliveryJob(incoming[0]) : null;
    res.json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
});

// GET /api/driver/jobs/incoming-list — incoming offers sorted by payout desc
router.get('/incoming-list', async (req, res, next) => {
  try {
    console.log('[driver-jobs] GET /incoming-list — driver:', driverLabel(req.driver));
    const incoming = await getIncomingBookingsForDriver(req.driver);
    res.json({ success: true, data: incoming.map(toDeliveryJob) });
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

    res.json({ success: true, data: toDeliveryJob(updated) });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/jobs/:id/reject
router.post('/:id/reject', async (req, res, next) => {
  try {
    console.log('[driver-jobs] POST reject — driver:', driverLabel(req.driver), 'bookingId:', req.params.id);
    // Record rejection so this booking won't show up again for this driver
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

// PUT /api/driver/jobs/:id/status — update status with mapping
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

    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return next(new AppError('Job not found', 404));
    if (booking.driverId !== req.driver.id) return next(new AppError('Not authorized', 403));

    const updated = await prisma.booking.update({
      where: { id: req.params.id },
      data: { status: backendStatus },
      include: bookingInclude,
    });
    console.log('[driver-jobs] Status updated — driver:', driverLabel(req.driver), 'customer:', updated.user?.name || 'unknown', 'bookingId:', req.params.id, 'mapped:', status, '→', backendStatus);

    res.json({ success: true, data: toDeliveryJob(updated) });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/jobs/:id/verify-pickup-otp — verify OTP at pickup
router.post('/:id/verify-pickup-otp', async (req, res, next) => {
  try {
    const { otp } = req.body;
    console.log('[driver-jobs] POST verify-pickup-otp — driver:', driverLabel(req.driver), 'bookingId:', req.params.id);
    if (!isValidOtp(otp)) return next(new AppError(`OTP must be ${OTP_LENGTH} digits`, 400));

    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return next(new AppError('Job not found', 404));
    if (booking.driverId !== req.driver.id) return next(new AppError('Not authorized', 403));
    if (booking.status !== 'DRIVER_ARRIVED') {
      return next(new AppError('OTP verification is only allowed when driver has arrived at pickup', 400));
    }
    const normalizedOtp = normalizeOtp(otp);
    if (booking.otp !== normalizedOtp) {
      console.log('[driver-jobs] verify-pickup-otp — OTP mismatch — driver:', driverLabel(req.driver), 'bookingId:', req.params.id);
      return next(new AppError('Invalid OTP', 400));
    }

    const updated = await prisma.booking.update({
      where: { id: req.params.id },
      data: { status: 'PICKUP_DONE' },
      include: bookingInclude,
    });
    console.log('[driver-jobs] verify-pickup-otp — driver:', driverLabel(req.driver), 'customer:', updated.user?.name || 'unknown', 'bookingId:', req.params.id, 'OTP matched, status → PICKUP_DONE');

    res.json({ success: true, data: toDeliveryJob(updated) });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/jobs/:id/request-delivery-otp — generate/send recipient OTP at drop-off
router.post('/:id/request-delivery-otp', async (req, res, next) => {
  try {
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
    const generatedOtp = generateOtp();
    const updateData = {
      deliveryOtpSentAt: new Date(),
      deliveryOtpVerifiedAt: null,
    };
    const isAdminDispatch = booking.dispatchSource === 'ADMIN';
    if (isAdminDispatch) {
      updateData.deliveryOtp = generatedOtp;
    } else {
      updateData.deliveryOtp = '';
    }
    await prisma.booking.update({
      where: { id: req.params.id },
      data: updateData,
    });

    if (!isAdminDispatch && recipientEmail) {
      const { error } = await getSupabaseAdmin().auth.signInWithOtp({
        email: recipientEmail,
        options: { shouldCreateUser: true },
      });
      if (error) {
        return next(new AppError(`Failed to send recipient OTP email: ${error.message}`, 500));
      }
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

    res.json({
      success: true,
      data: {
        recipientEmail: recipientEmail ? maskEmail(recipientEmail) : '',
        otpSentAt: new Date().toISOString(),
        adminOtp: isAdminDispatch ? generatedOtp : null,
      },
      message: recipientEmail
        ? `OTP sent for ${maskEmail(recipientEmail)}`
        : 'OTP generated (recipient email missing)',
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/jobs/:id/proof — proof of delivery
router.post('/:id/proof', async (req, res, next) => {
  try {
    const { photoUrl, recipientName, otpCode } = req.body;
    console.log('[driver-jobs] POST proof — driver:', driverLabel(req.driver), 'bookingId:', req.params.id);
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return next(new AppError('Job not found', 404));
    if (booking.driverId !== req.driver.id) return next(new AppError('Not authorized', 403));
    if (booking.status === 'DELIVERED') {
      if (!isSettlementEligibleBooking(booking)) {
        return next(new AppError('Delivered booking is missing handover verification', 409));
      }
      const alreadyDelivered = await prisma.booking.findUnique({
        where: { id: req.params.id },
        include: bookingInclude,
      });
      return res.json({ success: true, data: toDeliveryJob(alreadyDelivered) });
    }
    if (!isValidOtp(otpCode)) {
      return next(new AppError(`Recipient OTP must be ${OTP_LENGTH} digits`, 400));
    }
    const normalizedOtp = normalizeOtp(otpCode);
    const recipientEmail = booking.deliveryAddress?.contactEmail || booking.user?.email || '';

    if (booking.dispatchSource === 'ADMIN') {
      if (!booking.deliveryOtp || booking.deliveryOtp !== normalizedOtp) {
        return next(new AppError('Invalid recipient OTP', 400));
      }
    } else if (recipientEmail) {
      const { error } = await getSupabaseAdmin().auth.verifyOtp({
        email: recipientEmail,
        token: normalizedOtp,
        type: 'email',
      });
      if (error) {
        return next(new AppError('Invalid recipient OTP', 400));
      }
    } else if (!booking.deliveryOtp || booking.deliveryOtp !== normalizedOtp) {
      return next(new AppError('Invalid recipient OTP', 400));
    }

    const now = new Date();

    const updated = await prisma.$transaction(async (tx) => {
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

      const wallet = await tx.driverWallet.findUnique({ where: { driverId: req.driver.id } });
      if (wallet) {
        const existingEarning = await tx.driverWalletTransaction.findFirst({
          where: {
            walletId: wallet.id,
            type: 'DELIVERY_EARNING',
            jobId: req.params.id,
          },
        });
        if (!existingEarning) {
          const earning = deliveredBooking.finalPrice || deliveredBooking.estimatedPrice;
          console.log('[driver-jobs] proof — driver:', driverLabel(req.driver), 'customer:', deliveredBooking.user?.name || 'unknown', 'bookingId:', req.params.id, 'crediting earnings:', earning);
          await tx.driverWalletTransaction.create({
            data: {
              walletId: wallet.id,
              type: 'DELIVERY_EARNING',
              amount: earning,
              description: `Delivery earning for job ${req.params.id.slice(0, 8)}`,
              jobId: req.params.id,
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

      await tx.driver.update({
        where: { id: req.driver.id },
        data: { totalTrips: { increment: 1 } },
      });

      return deliveredBooking;
    });

    res.json({ success: true, data: toDeliveryJob(updated) });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/jobs/:id/cancel — cancel an accepted job (re-queues it)
router.post('/:id/cancel', async (req, res, next) => {
  try {
    console.log('[driver-jobs] POST cancel — driver:', driverLabel(req.driver), 'bookingId:', req.params.id);
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return next(new AppError('Job not found', 404));
    if (booking.driverId !== req.driver.id) return next(new AppError('Not authorized', 403));

    if (booking.status === 'DELIVERED' || booking.status === 'CANCELLED') {
      return next(new AppError('Job is already completed or cancelled', 400));
    }
    if (['PICKUP_DONE', 'IN_TRANSIT'].includes(booking.status)) {
      return next(new AppError('Cannot cancel after picking up the package', 400));
    }

    // DRIVER_ASSIGNED or DRIVER_ARRIVED — re-queue the job
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
