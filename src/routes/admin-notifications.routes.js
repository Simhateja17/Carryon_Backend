const { Router } = require('express');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { parsePagination } = require('../lib/pagination');
const { sendPushToDriverIds } = require('../lib/pushNotifications');

const router = Router();

// GET /api/admin/notifications
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);

    const [notifications, total] = await Promise.all([
      prisma.driverNotification.findMany({
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
        include: {
          driver: { select: { id: true, name: true, email: true } },
        },
      }),
      prisma.driverNotification.count(),
    ]);

    res.json({ success: true, data: notifications, total, page, limit });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/notifications/send
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

    let whereClause = {};
    if (audience === 'online') {
      whereClause = { isOnline: true };
    }

    const drivers = await prisma.driver.findMany({
      where: whereClause,
      select: { id: true, name: true, email: true },
    });
    console.log('[admin-notifications] send — audience:', audience, 'drivers targeted:', drivers.length);

    if (drivers.length === 0) {
      return res.json({ success: true, data: { sent: 0, message: 'No matching drivers found' } });
    }

    const notifications = await prisma.driverNotification.createMany({
      data: drivers.map((driver) => ({
        driverId: driver.id,
        title,
        message,
        type,
      })),
    });

    let pushResult = {
      successCount: 0,
      failureCount: 0,
      failedTokens: [],
      invalidTokens: [],
      cleanedInvalidTokens: 0,
      deliveredActorIds: [],
      failedActorIds: [],
      noDeviceActorIds: [],
    };
    if (drivers.length > 0) {
      console.log('[admin-notifications] send — sending FCM to', drivers.length, 'drivers');
      pushResult = await sendPushToDriverIds(
        drivers.map((driver) => driver.id),
        { title, body: message },
        { type, source: 'admin' }
      );
      console.log('[admin-notifications] FCM result — successCount:', pushResult.successCount, 'failureCount:', pushResult.failureCount);
    }

    const deliveredDrivers = drivers
      .filter((driver) => pushResult.deliveredActorIds.includes(driver.id))
      .map((driver) => ({ id: driver.id, name: driver.name, email: driver.email }));
    const failedDrivers = drivers
      .filter((driver) => pushResult.failedActorIds.includes(driver.id))
      .map((driver) => ({ id: driver.id, name: driver.name, email: driver.email }));
    const noTokenDrivers = drivers
      .filter((driver) => pushResult.noDeviceActorIds.includes(driver.id))
      .map((driver) => ({ id: driver.id, name: driver.name, email: driver.email }));

    res.json({
      success: true,
      data: {
        sent: notifications.count,
        audience,
        driversCount: drivers.length,
        push: {
          attempted: pushResult.devices?.length || 0,
          delivered: pushResult.successCount,
          failed: pushResult.failureCount,
          invalidTokens: pushResult.invalidTokens.length,
          cleanedInvalidTokens: pushResult.cleanedInvalidTokens,
          driversWithoutToken: noTokenDrivers.length,
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

// GET /api/admin/drivers
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
        pushDevices: {
          where: { notificationsEnabled: true },
          select: { id: true },
          take: 1,
        },
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: drivers.map((d) => ({ ...d, hasFcmToken: d.pushDevices.length > 0, pushDevices: undefined })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/stats
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

// GET /api/admin/notifications/recipient-otps
router.get('/recipient-otps', async (req, res, next) => {
  try {
    const { limit } = parsePagination(req.query, { defaultLimit: 50 });
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
