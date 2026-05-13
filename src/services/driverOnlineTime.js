const prisma = require('../lib/prisma');
const { assertDriverCanGoOnline } = require('./driverEligibility');

function hoursBetween(start, end) {
  return Math.max(0, end.getTime() - start.getTime()) / (60 * 60 * 1000);
}

function sessionOverlapHours(session, windowStart, windowEnd) {
  const startedAt = new Date(session.startedAt);
  const endedAt = session.endedAt ? new Date(session.endedAt) : windowEnd;
  const start = startedAt > windowStart ? startedAt : windowStart;
  const end = endedAt < windowEnd ? endedAt : windowEnd;
  return hoursBetween(start, end);
}

function normalizeOnlineLocation(input) {
  const latitude = Number(input?.latitude);
  const longitude = Number(input?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    const err = new Error('Valid latitude and longitude are required');
    err.statusCode = 400;
    throw err;
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    const err = new Error('Valid latitude and longitude are required');
    err.statusCode = 400;
    throw err;
  }
  return { latitude, longitude };
}

async function setDriverOnlineStatus(
  driverId,
  isOnline,
  { db = prisma, now = new Date(), location = null, serviceAreaCheck = undefined } = {},
) {
  const position = isOnline && location ? normalizeOnlineLocation(location) : null;
  if (isOnline) {
    await assertDriverCanGoOnline(driverId, { db, now, driverLocation: position, serviceAreaCheck });
  }
  return db.$transaction(async (tx) => {
    const driver = await tx.driver.update({
      where: { id: driverId },
      data: {
        isOnline,
        ...(position
          ? {
            currentLatitude: position.latitude,
            currentLongitude: position.longitude,
          }
          : {}),
      },
    });

    if (isOnline) {
      const openSession = await tx.driverOnlineSession.findFirst({
        where: { driverId, endedAt: null },
        orderBy: { startedAt: 'desc' },
      });
      if (!openSession) {
        await tx.driverOnlineSession.create({
          data: { driverId, startedAt: now },
        });
      }
    } else {
      await tx.driverOnlineSession.updateMany({
        where: { driverId, endedAt: null },
        data: { endedAt: now },
      });
    }

    return driver;
  });
}

async function onlineHoursForWindow(driverId, windowStart, windowEnd = new Date(), { db = prisma } = {}) {
  const sessions = await db.driverOnlineSession.findMany({
    where: {
      driverId,
      startedAt: { lte: windowEnd },
      OR: [
        { endedAt: null },
        { endedAt: { gte: windowStart } },
      ],
    },
    select: { startedAt: true, endedAt: true },
  });

  const total = sessions.reduce((sum, session) => (
    sum + sessionOverlapHours(session, windowStart, windowEnd)
  ), 0);
  return Math.round(total * 100) / 100;
}

module.exports = {
  setDriverOnlineStatus,
  normalizeOnlineLocation,
  onlineHoursForWindow,
  sessionOverlapHours,
};
