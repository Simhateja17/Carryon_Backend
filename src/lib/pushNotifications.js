const { sendPushNotifications } = require('./firebase');
const {
  getActivePushDevicesForUsers,
  getActivePushDevicesForDrivers,
} = require('./pushDevices');

function dedupe(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function buildUserBookingMessage(booking, eventType) {
  const driverName = booking.driver?.name?.trim() || 'Your driver';

  switch (eventType) {
    case 'DRIVER_ASSIGNED':
      return {
        title: 'Driver assigned',
        body: `${driverName} is heading to your pickup point.`,
      };
    case 'DRIVER_ARRIVED':
      return {
        title: 'Driver arrived',
        body: `${driverName} has arrived at the pickup location.`,
      };
    case 'PICKUP_DONE':
      return {
        title: 'Package picked up',
        body: 'Your package has been picked up and is moving to the drop-off location.',
      };
    case 'IN_TRANSIT':
      return {
        title: 'Delivery in transit',
        body: 'Your shipment is on the way.',
      };
    case 'DELIVERED':
      return {
        title: 'Delivery complete',
        body: 'Your shipment has been delivered successfully.',
      };
    case 'CANCELLED':
      return {
        title: 'Delivery cancelled',
        body: 'This booking has been cancelled.',
      };
    case 'DELIVERY_OTP_REQUESTED':
      return {
        title: 'Delivery handoff ready',
        body: 'Your driver is ready to complete the delivery. Keep the OTP handy.',
      };
    default:
      return null;
  }
}

function buildPushResult(devices, pushResult, actorKey) {
  const deviceIdsByActor = new Map();
  for (const device of devices) {
    const actorId = device[actorKey];
    if (!actorId) continue;
    const actorDevices = deviceIdsByActor.get(actorId) || [];
    actorDevices.push(device);
    deviceIdsByActor.set(actorId, actorDevices);
  }

  const failedTokenSet = new Set(pushResult.failedTokens || []);
  const deliveredActorIds = [];
  const failedActorIds = [];
  for (const [actorId, actorDevices] of deviceIdsByActor.entries()) {
    const hasSuccess = actorDevices.some((device) => !failedTokenSet.has(device.token));
    if (hasSuccess) {
      deliveredActorIds.push(actorId);
    } else {
      failedActorIds.push(actorId);
    }
  }

  return {
    ...pushResult,
    deliveredActorIds,
    failedActorIds,
    actorIdsWithDevices: Array.from(deviceIdsByActor.keys()),
  };
}

async function sendPushToUserIds(userIds, notification, data = {}) {
  const targetUserIds = dedupe(userIds);
  const devices = await getActivePushDevicesForUsers(targetUserIds);
  const tokens = devices.map((device) => device.token);
  const pushResult = await sendPushNotifications(tokens, notification, data);
  return {
    devices,
    noDeviceActorIds: targetUserIds.filter((userId) => !devices.some((device) => device.userId === userId)),
    ...buildPushResult(devices, pushResult, 'userId'),
  };
}

async function sendPushToDriverIds(driverIds, notification, data = {}) {
  const targetDriverIds = dedupe(driverIds);
  const devices = await getActivePushDevicesForDrivers(targetDriverIds);
  const tokens = devices.map((device) => device.token);
  const pushResult = await sendPushNotifications(tokens, notification, data);
  return {
    devices,
    noDeviceActorIds: targetDriverIds.filter((driverId) => !devices.some((device) => device.driverId === driverId)),
    ...buildPushResult(devices, pushResult, 'driverId'),
  };
}

async function notifyUserBookingEvent(booking, eventType) {
  const notification = buildUserBookingMessage(booking, eventType);
  if (!notification || !booking?.userId) {
    return {
      successCount: 0,
      failureCount: 0,
      failedTokens: [],
      invalidTokens: [],
      cleanedInvalidTokens: 0,
      deliveredActorIds: [],
      failedActorIds: [],
      actorIdsWithDevices: [],
      noDeviceActorIds: booking?.userId ? [booking.userId] : [],
      devices: [],
    };
  }

  return sendPushToUserIds(
    [booking.userId],
    notification,
    {
      type: eventType,
      bookingId: booking.id,
      status: booking.status,
      targetScreen: 'BOOKING_TRACKING',
    }
  );
}

module.exports = {
  sendPushToUserIds,
  sendPushToDriverIds,
  notifyUserBookingEvent,
};
