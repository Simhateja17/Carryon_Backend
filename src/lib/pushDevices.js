const prisma = require('./prisma');
const { AppError } = require('../middleware/errorHandler');

const PUSH_PLATFORMS = new Set(['ANDROID', 'IOS']);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePlatform(value) {
  const normalized = normalizeString(value).toUpperCase();
  return PUSH_PLATFORMS.has(normalized) ? normalized : null;
}

function parsePushRegistrationBody(body, fallbackPlatform = 'ANDROID') {
  const token = normalizeString(body?.token ?? body?.fcmToken);
  const deviceId = normalizeString(body?.deviceId);
  const appVersion = normalizeString(body?.appVersion) || null;
  const platform = normalizePlatform(body?.platform) || fallbackPlatform;

  if (!token) {
    throw new AppError('token field is required', 400);
  }
  if (!deviceId) {
    throw new AppError('deviceId field is required', 400);
  }
  if (!PUSH_PLATFORMS.has(platform)) {
    throw new AppError('platform must be ANDROID or IOS', 400);
  }

  return { token, deviceId, platform, appVersion };
}

async function deactivateExistingToken(tx, token, actorKey, actorId, deviceId) {
  await tx.pushDevice.deleteMany({
    where: {
      token,
      OR: [
        { [actorKey]: { not: actorId } },
        { deviceId: { not: deviceId } },
      ],
    },
  });
}

async function upsertPushDevice({ actorType, actorId, token, platform, deviceId, appVersion = null }) {
  const actorKey = actorType === 'user' ? 'userId' : 'driverId';
  const legacyDeviceId = actorType === 'driver' ? 'legacy-driver-device' : 'legacy-user-device';

  return prisma.$transaction(async (tx) => {
    await deactivateExistingToken(tx, token, actorKey, actorId, deviceId);

    const device = await tx.pushDevice.upsert({
      where: actorType === 'user'
        ? { userId_deviceId: { userId: actorId, deviceId } }
        : { driverId_deviceId: { driverId: actorId, deviceId } },
      update: {
        token,
        platform,
        appVersion,
        notificationsEnabled: true,
        lastSeenAt: new Date(),
      },
      create: {
        [actorKey]: actorId,
        token,
        platform,
        deviceId,
        appVersion,
        notificationsEnabled: true,
        lastSeenAt: new Date(),
      },
    });

    if (actorType === 'driver') {
      await tx.driver.update({
        where: { id: actorId },
        data: { fcmToken: token },
      });

      if (deviceId !== legacyDeviceId) {
        await tx.pushDevice.deleteMany({
          where: {
            driverId: actorId,
            deviceId: legacyDeviceId,
            token: { not: token },
          },
        });
      }
    }

    return device;
  });
}

async function removePushDevice({ actorType, actorId, deviceId }) {
  const actorKey = actorType === 'user' ? 'userId' : 'driverId';

  const removed = await prisma.pushDevice.deleteMany({
    where: {
      [actorKey]: actorId,
      deviceId,
    },
  });

  if (actorType === 'driver') {
    const remaining = await prisma.pushDevice.findFirst({
      where: {
        driverId: actorId,
        notificationsEnabled: true,
      },
      orderBy: [{ lastSeenAt: 'desc' }, { updatedAt: 'desc' }],
      select: { token: true },
    });

    await prisma.driver.update({
      where: { id: actorId },
      data: { fcmToken: remaining?.token || null },
    });
  }

  return removed.count;
}

async function getActivePushDevicesForUsers(userIds) {
  if (!userIds || userIds.length === 0) return [];
  return prisma.pushDevice.findMany({
    where: {
      userId: { in: userIds },
      notificationsEnabled: true,
    },
    select: {
      id: true,
      userId: true,
      token: true,
      deviceId: true,
      platform: true,
    },
  });
}

async function getActivePushDevicesForDrivers(driverIds) {
  if (!driverIds || driverIds.length === 0) return [];
  return prisma.pushDevice.findMany({
    where: {
      driverId: { in: driverIds },
      notificationsEnabled: true,
    },
    select: {
      id: true,
      driverId: true,
      token: true,
      deviceId: true,
      platform: true,
    },
  });
}

async function removeInvalidPushTokens(tokens) {
  if (!tokens || tokens.length === 0) return { deletedDevices: 0, clearedLegacyDriverTokens: 0 };

  const uniqueTokens = Array.from(new Set(tokens.filter(Boolean)));
  if (uniqueTokens.length === 0) {
    return { deletedDevices: 0, clearedLegacyDriverTokens: 0 };
  }

  const [deletedDevices, clearedDrivers] = await prisma.$transaction([
    prisma.pushDevice.deleteMany({
      where: { token: { in: uniqueTokens } },
    }),
    prisma.driver.updateMany({
      where: { fcmToken: { in: uniqueTokens } },
      data: { fcmToken: null },
    }),
  ]);

  return {
    deletedDevices: deletedDevices.count,
    clearedLegacyDriverTokens: clearedDrivers.count,
  };
}

module.exports = {
  parsePushRegistrationBody,
  upsertPushDevice,
  removePushDevice,
  getActivePushDevicesForUsers,
  getActivePushDevicesForDrivers,
  removeInvalidPushTokens,
};
