const prisma = require('../lib/prisma');
const {
  NOTIFICATION_SETTINGS_KEY,
  DEFAULT_NOTIFICATION_SETTINGS,
  sanitizeNotificationSettings,
} = require('./adminSettings');

const NOTIFICATION_AUDIT_ACTIONS = [
  'ADMIN_NOTIFICATION_SETTINGS_UPDATED',
  'ADMIN_BOOKING_CREATED',
  'ADMIN_NOTIFICATION_SENT',
];

function sinceHours(hours, now = new Date()) {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

function minutesAgo(date, now = new Date()) {
  if (!date) return '--';
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(date).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (60 * 24))}d ago`;
}

function labelAuditAction(action) {
  return String(action || '')
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function auditIcon(action) {
  if (action === 'ADMIN_NOTIFICATION_SETTINGS_UPDATED') return 'edit';
  if (action === 'ADMIN_BOOKING_CREATED' || action === 'ADMIN_NOTIFICATION_SENT') return 'plus';
  return 'warning';
}

function normalizeStoredNotificationSettings(value) {
  try {
    return sanitizeNotificationSettings(value || DEFAULT_NOTIFICATION_SETTINGS);
  } catch {
    return DEFAULT_NOTIFICATION_SETTINGS;
  }
}

async function getNotificationSettingsSnapshot(db = prisma, now = new Date()) {
  const [
    settings,
    totalDrivers,
    onlineDrivers,
    pushReadyDrivers,
    adminActors,
    notificationCount,
    auditItems,
  ] = await Promise.all([
    db.adminSetting.findUnique({ where: { key: NOTIFICATION_SETTINGS_KEY } }).then((row) => normalizeStoredNotificationSettings(row?.value)),
    db.driver.count(),
    db.driver.count({ where: { isOnline: true } }),
    db.driver.count({ where: { pushDevices: { some: { notificationsEnabled: true } } } }),
    db.auditLog.groupBy({ by: ['actorId'], where: { actorType: 'ADMIN' } }),
    db.driverNotification.count({ where: { createdAt: { gte: sinceHours(24, now) } } }),
    db.auditLog.findMany({
      where: { action: { in: NOTIFICATION_AUDIT_ACTIONS } },
      orderBy: { createdAt: 'desc' },
      take: 4,
    }),
  ]);

  const adminCount = adminActors.length;
  const readinessRate = totalDrivers > 0 ? (pushReadyDrivers / totalDrivers) * 100 : 0;

  return {
    settings,
    groups: [
      {
        type: 'admin',
        label: 'Admins',
        badge: adminCount > 0 ? 'ACTIVE' : 'NO ACTIVITY',
        sub: `${adminCount} admin ${adminCount === 1 ? 'actor' : 'actors'} - Global access`,
      },
      {
        type: 'dispatch',
        label: 'Live Operations',
        badge: onlineDrivers > 0 ? 'ACTIVE' : 'QUIET',
        sub: `${onlineDrivers} online ${onlineDrivers === 1 ? 'driver' : 'drivers'} - Live ops`,
      },
      {
        type: 'driver',
        label: 'Drivers',
        badge: pushReadyDrivers > 0 ? 'REACHABLE' : 'NO DEVICES',
        sub: `${pushReadyDrivers}/${totalDrivers} drivers with push enabled`,
      },
    ],
    health: {
      deliveryRate: Math.min(99.9, Number(readinessRate.toFixed(1))),
      deliveredLast24h: notificationCount,
    },
    auditItems: auditItems.map((item) => ({
      icon: auditIcon(item.action),
      text: labelAuditAction(item.action),
      time: minutesAgo(item.createdAt, now),
    })),
  };
}

module.exports = {
  getNotificationSettingsSnapshot,
  minutesAgo,
  normalizeStoredNotificationSettings,
};
