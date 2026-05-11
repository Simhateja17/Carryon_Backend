const { Router } = require('express');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { recordAudit } = require('../services/auditLog');
const {
  NOTIFICATION_SETTINGS_KEY,
  DEFAULT_NOTIFICATION_SETTINGS,
  getAdminSetting,
  sanitizeNotificationSettings,
  setAdminSettingTx,
} = require('../services/adminSettings');

const router = Router();

function sinceHours(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

function minutesAgo(date) {
  if (!date) return '--';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

router.get('/notifications', async (_req, res, next) => {
  try {
    const [settings, totalDrivers, onlineDrivers, adminsAudit, notificationCount, auditItems] =
      await Promise.all([
        getAdminSetting(NOTIFICATION_SETTINGS_KEY, DEFAULT_NOTIFICATION_SETTINGS),
        prisma.driver.count(),
        prisma.driver.count({ where: { isOnline: true } }),
        prisma.auditLog.count({ where: { actorType: 'ADMIN' } }),
        prisma.driverNotification.count({ where: { createdAt: { gte: sinceHours(24) } } }),
        prisma.auditLog.findMany({
          where: { action: { in: ['ADMIN_NOTIFICATION_SETTINGS_UPDATED', 'ADMIN_BOOKING_CREATED'] } },
          orderBy: { createdAt: 'desc' },
          take: 4,
        }),
      ]);

    res.json({
      success: true,
      data: {
        settings,
        groups: [
          { type: 'admin', label: 'Admins', badge: 'ACTIVE', sub: `${adminsAudit || 1} Admin actors - Global Access` },
          { type: 'dispatch', label: 'Dispatchers', badge: 'ACTIVE', sub: `${onlineDrivers} online drivers - Live ops` },
          { type: 'driver', label: 'Drivers', badge: 'RESTRICTED', sub: `${totalDrivers} drivers - Mobile Only` },
        ],
        health: {
          deliveryRate: totalDrivers > 0 ? Math.min(99.9, (onlineDrivers / totalDrivers) * 100) : 0,
          deliveredLast24h: notificationCount,
        },
        auditItems: auditItems.map((item) => ({
          icon: item.action === 'ADMIN_NOTIFICATION_SETTINGS_UPDATED' ? 'edit' : 'plus',
          text: item.action.replace(/_/g, ' '),
          time: minutesAgo(item.createdAt),
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.put('/notifications', async (req, res, next) => {
  try {
    let nextSettings;
    try {
      nextSettings = sanitizeNotificationSettings(req.body);
    } catch (err) {
      return next(new AppError(err.message, 400));
    }

    const previous = await getAdminSetting(NOTIFICATION_SETTINGS_KEY, DEFAULT_NOTIFICATION_SETTINGS);
    const saved = await prisma.$transaction(async (tx) => {
      const setting = await setAdminSettingTx(tx, NOTIFICATION_SETTINGS_KEY, nextSettings);
      await recordAudit(tx, {
        actor: req.adminActor,
        action: 'ADMIN_NOTIFICATION_SETTINGS_UPDATED',
        entityType: 'AdminSetting',
        entityId: NOTIFICATION_SETTINGS_KEY,
        oldValue: previous,
        newValue: nextSettings,
      });
      return setting;
    });

    res.json({ success: true, data: saved.value });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
