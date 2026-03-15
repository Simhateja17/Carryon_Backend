const { Router } = require('express');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { sendPushNotifications } = require('../lib/firebase');

const router = Router();

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

    let pushResult = { successCount: 0, failureCount: 0, failedTokens: [] };
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

module.exports = router;
