const { Router } = require('express');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { sendPushNotifications } = require('../lib/firebase');
const { haversineKm } = require('../lib/distance');

const router = Router();
const DRIVER_SEARCH_RADIUS_KM = 10;
const FALLBACK_TEST_USER_EMAIL = 'admin.test.rider@carryon.local';

function generateDeliveryOtp() {
  return Math.floor(1000 + Math.random() * 9000).toString();
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

function sanitizeAddress(input) {
  return {
    address: input?.address?.trim() || '',
    latitude: Number(input?.latitude),
    longitude: Number(input?.longitude),
    contactName: input?.contactName?.trim() || '',
    contactPhone: input?.contactPhone?.trim() || '',
    contactEmail: input?.contactEmail?.trim() || '',
    landmark: input?.landmark?.trim() || '',
  };
}

// GET /api/admin/notifications — list recent push notifications sent
router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const [notifications, total] = await Promise.all([
      prisma.driverNotification.findMany({
        orderBy: { createdAt: 'desc' },
        take: Number(limit),
        skip,
        include: {
          driver: { select: { id: true, name: true, email: true } },
        },
      }),
      prisma.driverNotification.count(),
    ]);

    res.json({ success: true, data: notifications, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/notifications/ride-request — create a real booking and notify drivers
router.post('/ride-request', async (req, res, next) => {
  try {
    const {
      from,
      to,
      price,
      vehicleType = 'CAR',
      paymentMethod = 'CASH',
      driverIds = [],
    } = req.body;

    console.log('[admin-notifications] POST ride-request — vehicleType:', vehicleType, 'price:', price);

    if (!from || !to) {
      return next(new AppError('from and to are required', 400));
    }

    const pickup = sanitizeAddress(from);
    const delivery = sanitizeAddress(to);
    if (!pickup.address || !delivery.address) {
      return next(new AppError('from.address and to.address are required', 400));
    }
    if (!Number.isFinite(pickup.latitude) || !Number.isFinite(pickup.longitude) || !Number.isFinite(delivery.latitude) || !Number.isFinite(delivery.longitude)) {
      return next(new AppError('Valid latitude and longitude are required for from/to', 400));
    }

    const parsedPrice = Number(price);
    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      return next(new AppError('price must be a valid number greater than 0', 400));
    }

    const validVehicleTypes = ['BIKE', 'CAR', 'PICKUP', 'VAN_7FT', 'VAN_9FT', 'LORRY_10FT', 'LORRY_14FT', 'LORRY_17FT'];
    if (!validVehicleTypes.includes(vehicleType)) {
      return next(new AppError(`Invalid vehicleType. Must be one of: ${validVehicleTypes.join(', ')}`, 400));
    }

    const validPaymentMethods = ['CASH', 'UPI', 'CARD', 'WALLET'];
    if (!validPaymentMethods.includes(paymentMethod)) {
      return next(new AppError(`Invalid paymentMethod. Must be one of: ${validPaymentMethods.join(', ')}`, 400));
    }
    if (!Array.isArray(driverIds)) {
      return next(new AppError('driverIds must be an array', 400));
    }

    const testUserEmail = process.env.ADMIN_TEST_USER_EMAIL || FALLBACK_TEST_USER_EMAIL;
    const testUser = await prisma.user.upsert({
      where: { email: testUserEmail },
      update: {},
      create: {
        name: 'Admin Test Rider',
        email: testUserEmail,
        phone: '',
      },
    });

    const distance = haversineKm(
      pickup.latitude,
      pickup.longitude,
      delivery.latitude,
      delivery.longitude
    );
    const duration = Math.max(5, Math.round((distance / 30) * 60));

    let booking = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        booking = await prisma.$transaction(async (tx) => {
          const pickupAddress = await tx.address.create({
            data: {
              userId: testUser.id,
              address: pickup.address,
              latitude: pickup.latitude,
              longitude: pickup.longitude,
              contactName: pickup.contactName,
              contactPhone: pickup.contactPhone,
              contactEmail: pickup.contactEmail || '',
              landmark: pickup.landmark,
              label: 'Admin Test Pickup',
              type: 'OTHER',
            },
          });

          const deliveryAddress = await tx.address.create({
            data: {
              userId: testUser.id,
              address: delivery.address,
              latitude: delivery.latitude,
              longitude: delivery.longitude,
              contactName: delivery.contactName,
              contactPhone: delivery.contactPhone,
              contactEmail: delivery.contactEmail || '',
              landmark: delivery.landmark,
              label: 'Admin Test Drop',
              type: 'OTHER',
            },
          });

          const orderCode = await generateNextOrderCode(tx);

          return tx.booking.create({
            data: {
              orderCode,
              userId: testUser.id,
              pickupAddressId: pickupAddress.id,
              deliveryAddressId: deliveryAddress.id,
              vehicleType,
              estimatedPrice: parsedPrice,
              finalPrice: parsedPrice,
              distance,
              duration,
              paymentMethod,
              status: 'SEARCHING_DRIVER',
              otp: generateDeliveryOtp(),
              dispatchSource: 'ADMIN',
            },
            include: {
              pickupAddress: true,
              deliveryAddress: true,
            },
          });
        });
        break;
      } catch (err) {
        if (!isOrderCodeConflict(err) || attempt === 2) throw err;
      }
    }

    const isDirectTargeted = driverIds.length > 0;
    const driverWhere = isDirectTargeted
      ? { id: { in: driverIds } }
      : { isOnline: true };

    const candidateDrivers = await prisma.driver.findMany({
      where: driverWhere,
      select: {
        id: true,
        name: true,
        email: true,
        fcmToken: true,
        currentLatitude: true,
        currentLongitude: true,
        vehicle: { select: { type: true } },
      },
    });

    const nearbyDrivers = candidateDrivers.filter((driver) => {
      if (isDirectTargeted) return true;
      const withinRadius =
        haversineKm(
          booking.pickupAddress.latitude,
          booking.pickupAddress.longitude,
          driver.currentLatitude,
          driver.currentLongitude
        ) <= DRIVER_SEARCH_RADIUS_KM;
      const vehicleMatches =
        !driver.vehicle?.type || driver.vehicle.type === booking.vehicleType;
      return withinRadius && vehicleMatches;
    });

    const targetedDrivers = nearbyDrivers.map((d) => ({
      id: d.id,
      name: d.name,
      email: d.email,
    }));

    if (nearbyDrivers.length > 0) {
      await prisma.driverNotification.createMany({
        data: nearbyDrivers.map((driver) => ({
          driverId: driver.id,
          title: 'New Ride Request!',
          message: `${booking.pickupAddress.address} → ${booking.deliveryAddress.address} (${parsedPrice.toFixed(2)})`,
          type: 'JOB_REQUEST',
          actionData: JSON.stringify({
            bookingId: booking.id,
            source: 'admin',
            targeted: isDirectTargeted,
          }),
        })),
      });
    }

    const driversWithToken = nearbyDrivers.filter((d) => d.fcmToken != null && d.fcmToken.length > 0);
    const driversWithoutToken = nearbyDrivers.filter((d) => !d.fcmToken || d.fcmToken.length === 0);
    const fcmTokens = driversWithToken.map((d) => d.fcmToken);

    let pushResult = {
      successCount: 0,
      failureCount: 0,
      failedTokens: [],
      invalidTokens: [],
      cleanedInvalidTokens: 0,
    };
    if (fcmTokens.length > 0) {
      pushResult = await sendPushNotifications(
        fcmTokens,
        {
          title: 'New Ride Request!',
          body: `${booking.pickupAddress.address} → ${booking.deliveryAddress.address}`,
        },
        {
          type: 'JOB_REQUEST',
          bookingId: booking.id,
          source: 'admin',
          targeted: isDirectTargeted ? 'true' : 'false',
        }
      );
    }

    const failedTokenSet = new Set(pushResult.failedTokens);
    const deliveredDrivers = driversWithToken
      .filter((d) => !failedTokenSet.has(d.fcmToken))
      .map((d) => ({ id: d.id, name: d.name, email: d.email }));
    const failedDrivers = driversWithToken
      .filter((d) => failedTokenSet.has(d.fcmToken))
      .map((d) => ({ id: d.id, name: d.name, email: d.email }));
    const noTokenDrivers = driversWithoutToken
      .map((d) => ({ id: d.id, name: d.name, email: d.email }));

    res.status(201).json({
      success: true,
      data: {
        bookingId: booking.id,
        status: booking.status,
        vehicleType: booking.vehicleType,
        estimatedPrice: booking.estimatedPrice,
        distance: booking.distance,
        duration: booking.duration,
        targetedDrivers,
        targetingMode: isDirectTargeted ? 'selected_drivers' : 'nearby_online_drivers',
        push: {
          attempted: fcmTokens.length,
          delivered: pushResult.successCount,
          failed: pushResult.failureCount,
          invalidTokens: pushResult.invalidTokens.length,
          cleanedInvalidTokens: pushResult.cleanedInvalidTokens,
          driversWithoutToken: driversWithoutToken.length,
          deliveredDrivers,
          failedDrivers,
          noTokenDrivers,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/notifications/send — send push notification to drivers
router.post('/send', async (req, res, next) => {
  try {
    const { title, message, type = 'PROMO', audience = 'all' } = req.body;
    console.log('[admin-notifications] POST send — audience:', audience, 'type:', type, 'title:', title);

    if (!title || !message) {
      return next(new AppError('Title and message are required', 400));
    }

    const validTypes = ['JOB_REQUEST', 'JOB_UPDATE', 'PAYMENT', 'PROMO', 'SYSTEM', 'ALERT'];
    if (!validTypes.includes(type)) {
      return next(new AppError(`Invalid type. Must be one of: ${validTypes.join(', ')}`, 400));
    }

    // Determine target drivers — also fetch fcmToken for push delivery
    let whereClause = {};
    if (audience === 'online') {
      whereClause = { isOnline: true };
    }

    const drivers = await prisma.driver.findMany({
      where: whereClause,
      select: { id: true, name: true, email: true, fcmToken: true },
    });
    console.log('[admin-notifications] send — audience:', audience, 'drivers targeted:', drivers.length);

    if (drivers.length === 0) {
      return res.json({ success: true, data: { sent: 0, message: 'No matching drivers found' } });
    }

    // Insert a notification record for each driver
    const notifications = await prisma.driverNotification.createMany({
      data: drivers.map((driver) => ({
        driverId: driver.id,
        title,
        message,
        type,
      })),
    });

    // Send actual FCM push notifications to drivers who have tokens
    const driversWithToken = drivers.filter((d) => d.fcmToken != null && d.fcmToken.length > 0);
    const driversWithoutToken = drivers.filter((d) => !d.fcmToken || d.fcmToken.length === 0);
    const fcmTokens = driversWithToken.map((d) => d.fcmToken);

    let pushResult = {
      successCount: 0,
      failureCount: 0,
      failedTokens: [],
      invalidTokens: [],
      cleanedInvalidTokens: 0,
    };
    if (fcmTokens.length > 0) {
      console.log('[admin-notifications] send — sending FCM to', fcmTokens.length, 'tokens');
      pushResult = await sendPushNotifications(
        fcmTokens,
        { title, body: message },
        { type, source: 'admin' }
      );
      console.log('[admin-notifications] FCM result — successCount:', pushResult.successCount, 'failureCount:', pushResult.failureCount);
    }

    const failedTokenSet = new Set(pushResult.failedTokens);
    const deliveredDrivers = driversWithToken
      .filter((d) => !failedTokenSet.has(d.fcmToken))
      .map((d) => ({ id: d.id, name: d.name, email: d.email }));
    const failedDrivers = driversWithToken
      .filter((d) => failedTokenSet.has(d.fcmToken))
      .map((d) => ({ id: d.id, name: d.name, email: d.email }));
    const noTokenDrivers = driversWithoutToken
      .map((d) => ({ id: d.id, name: d.name, email: d.email }));

    res.json({
      success: true,
      data: {
        sent: notifications.count,
        audience,
        driversCount: drivers.length,
        push: {
          attempted: fcmTokens.length,
          delivered: pushResult.successCount,
          failed: pushResult.failureCount,
          invalidTokens: pushResult.invalidTokens.length,
          cleanedInvalidTokens: pushResult.cleanedInvalidTokens,
          driversWithoutToken: driversWithoutToken.length,
          deliveredDrivers,
          failedDrivers,
          noTokenDrivers,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/drivers — list drivers for the dashboard
router.get('/drivers', async (req, res, next) => {
  try {
    const drivers = await prisma.driver.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        isOnline: true,
        isVerified: true,
        totalTrips: true,
        rating: true,
        fcmToken: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: drivers.map((d) => ({ ...d, hasFcmToken: !!d.fcmToken, fcmToken: undefined })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/stats — dashboard stats
router.get('/stats', async (req, res, next) => {
  try {
    const [totalDrivers, onlineDrivers, totalBookings, activeBookings, totalNotifications] =
      await Promise.all([
        prisma.driver.count(),
        prisma.driver.count({ where: { isOnline: true } }),
        prisma.booking.count(),
        prisma.booking.count({ where: { status: { in: ['SEARCHING_DRIVER', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'PICKUP_DONE', 'IN_TRANSIT'] } } }),
        prisma.driverNotification.count(),
      ]);

    res.json({
      success: true,
      data: { totalDrivers, onlineDrivers, totalBookings, activeBookings, totalNotifications },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/notifications/recipient-otps — monitor recipient OTPs for admin-dispatched bookings
router.get('/recipient-otps', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const status = String(req.query.status || 'all').toLowerCase();
    const where = {
      dispatchSource: 'ADMIN',
      ...(status === 'active' ? { deliveryOtp: { not: '' } } : {}),
      ...(status === 'verified' ? { deliveryOtpVerifiedAt: { not: null } } : {}),
    };

    const bookings = await prisma.booking.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, email: true } },
        deliveryAddress: true,
        driver: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    const data = bookings.map((booking) => ({
      bookingId: booking.id,
      orderCode: booking.orderCode,
      bookingStatus: booking.status,
      dispatchSource: booking.dispatchSource,
      recipientName: booking.deliveryAddress?.contactName || booking.user?.name || '',
      recipientEmail: booking.deliveryAddress?.contactEmail || booking.user?.email || '',
      deliveryOtp: booking.deliveryOtp || '',
      otpSentAt: booking.deliveryOtpSentAt?.toISOString() || null,
      otpVerifiedAt: booking.deliveryOtpVerifiedAt?.toISOString() || null,
      createdAt: booking.createdAt?.toISOString() || null,
      driver: booking.driver
        ? { id: booking.driver.id, name: booking.driver.name, email: booking.driver.email }
        : null,
    }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
