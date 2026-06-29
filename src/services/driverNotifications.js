const prisma = require('../lib/prisma');
const { sendPushToDriverIds } = require('../lib/pushNotifications');

function notificationActionData(data = {}) {
  return JSON.stringify(data || {});
}

async function createDriverNotificationWithPush({
  db = prisma,
  pushSender = sendPushToDriverIds,
  driverId,
  type,
  title,
  message,
  data = {},
}) {
  const notification = await db.driverNotification.create({
    data: {
      driverId,
      type,
      title,
      message,
      actionData: notificationActionData(data),
    },
  });

  try {
    const pushData = {
      ...data,
      type,
      title,
      body: message,
      notificationId: notification.id,
    };
    await pushSender([driverId], { title, body: message }, pushData);
  } catch (err) {
    console.warn('[driver-notifications] push failed', {
      driverId,
      type,
      notificationId: notification.id,
      error: err.message,
    });
  }

  return notification;
}

module.exports = {
  createDriverNotificationWithPush,
  notificationActionData,
};
