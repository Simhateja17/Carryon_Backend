const prisma = require('../lib/prisma');
const { sendPushToDriverIds } = require('../lib/pushNotifications');
const { recordAudit } = require('./auditLog');

const ADMIN_NOTIFICATION_TYPES = ['JOB_REQUEST', 'JOB_UPDATE', 'PAYMENT', 'PROMO', 'SYSTEM', 'ALERT'];

function emptyPushResult() {
  return {
    successCount: 0,
    failureCount: 0,
    failedTokens: [],
    invalidTokens: [],
    cleanedInvalidTokens: 0,
    deliveredActorIds: [],
    failedActorIds: [],
    noDeviceActorIds: [],
    devices: [],
  };
}

function validateAdminNotificationPayload(input = {}) {
  const title = String(input.title || '').trim();
  const message = String(input.message || '').trim();
  const type = String(input.type || 'PROMO').trim();
  const audience = String(input.audience || 'all').trim();

  if (!title || !message) {
    throw new Error('Title and message are required');
  }
  if (!ADMIN_NOTIFICATION_TYPES.includes(type)) {
    throw new Error(`Invalid type. Must be one of: ${ADMIN_NOTIFICATION_TYPES.join(', ')}`);
  }
  if (!['all', 'online'].includes(audience)) {
    throw new Error('Invalid audience');
  }

  return { title, message, type, audience };
}

function driverSummaries(drivers, ids) {
  const idSet = new Set(ids || []);
  return drivers
    .filter((driver) => idSet.has(driver.id))
    .map((driver) => ({ id: driver.id, name: driver.name, email: driver.email }));
}

function toAdminNotificationSendResult({ notifications, audience, drivers, pushResult }) {
  const noTokenDrivers = driverSummaries(drivers, pushResult.noDeviceActorIds);
  return {
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
      deliveredDrivers: driverSummaries(drivers, pushResult.deliveredActorIds),
      failedDrivers: driverSummaries(drivers, pushResult.failedActorIds),
      noTokenDrivers,
    },
  };
}

async function recordDispatchAudit(db, event) {
  try {
    await recordAudit(db, event);
    return true;
  } catch (err) {
    console.warn('[admin-notifications] audit write failed after dispatch', {
      action: event.action,
      entityId: event.entityId,
      error: err.message,
    });
    return false;
  }
}

async function dispatchAdminNotification(input, actor, db = prisma, pushSender = sendPushToDriverIds) {
  const payload = validateAdminNotificationPayload(input);
  const where = payload.audience === 'online' ? { isOnline: true } : {};

  const drivers = await db.driver.findMany({
    where,
    select: { id: true, name: true, email: true },
  });

  if (drivers.length === 0) {
    await recordDispatchAudit(db, {
      actor,
      action: 'ADMIN_NOTIFICATION_SENT',
      entityType: 'DriverNotification',
      entityId: 'none',
      newValue: {
        audience: payload.audience,
        type: payload.type,
        sent: 0,
        driversCount: 0,
        pushDelivered: 0,
        pushFailed: 0,
      },
    });
    return { sent: 0, message: 'No matching drivers found' };
  }

  const notifications = await db.driverNotification.createMany({
    data: drivers.map((driver) => ({
      driverId: driver.id,
      title: payload.title,
      message: payload.message,
      type: payload.type,
    })),
  });

  const pushResult = await pushSender(
    drivers.map((driver) => driver.id),
    { title: payload.title, body: payload.message },
    { type: payload.type, source: 'admin' }
  );

  const result = toAdminNotificationSendResult({
    notifications,
    audience: payload.audience,
    drivers,
    pushResult: { ...emptyPushResult(), ...pushResult },
  });

  await recordDispatchAudit(db, {
    actor,
    action: 'ADMIN_NOTIFICATION_SENT',
    entityType: 'DriverNotification',
    entityId: 'bulk',
    newValue: {
      audience: payload.audience,
      type: payload.type,
      sent: result.sent,
      driversCount: result.driversCount,
      pushAttempted: result.push.attempted,
      pushDelivered: result.push.delivered,
      pushFailed: result.push.failed,
      driversWithoutToken: result.push.driversWithoutToken,
    },
  });

  return result;
}

module.exports = {
  ADMIN_NOTIFICATION_TYPES,
  dispatchAdminNotification,
  validateAdminNotificationPayload,
};
