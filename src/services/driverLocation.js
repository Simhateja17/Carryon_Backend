const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { ACTIVE_TRACKING_STATUSES, broadcastDriverLocation } = require('./liveTracking');

function parseCoordinate(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AppError(`Valid ${label} is required`, 400);
  }
  return parsed;
}

function normalizeDriverPosition(input) {
  const latitude = parseCoordinate(input?.latitude, 'latitude');
  const longitude = parseCoordinate(input?.longitude, 'longitude');

  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new AppError('Valid latitude and longitude are required', 400);
  }

  return {
    latitude,
    longitude,
    accuracyMeters: input?.accuracyMeters == null ? null : Number(input.accuracyMeters),
    capturedAt: input?.capturedAt ? new Date(input.capturedAt) : new Date(),
  };
}

async function updateDriverPosition(driverId, input, { broadcast = true } = {}) {
  if (!driverId) {
    throw new AppError('Driver id is required', 400);
  }

  const position = normalizeDriverPosition(input);
  if (position.accuracyMeters != null && (!Number.isFinite(position.accuracyMeters) || position.accuracyMeters < 0)) {
    throw new AppError('Valid accuracyMeters is required', 400);
  }
  if (Number.isNaN(position.capturedAt.getTime())) {
    throw new AppError('Valid capturedAt is required', 400);
  }

  await prisma.driver.update({
    where: { id: driverId },
    data: {
      currentLatitude: position.latitude,
      currentLongitude: position.longitude,
    },
  });

  let activeBookings = [];
  if (broadcast) {
    activeBookings = await prisma.booking.findMany({
      where: {
        driverId,
        status: { in: ACTIVE_TRACKING_STATUSES },
      },
      select: { id: true },
    });

    const timestamp = position.capturedAt.toISOString();
    activeBookings.forEach((booking) => {
      broadcastDriverLocation(booking.id, {
        latitude: position.latitude,
        longitude: position.longitude,
        accuracyMeters: position.accuracyMeters,
        timestamp,
      });
    });
  }

  return {
    latitude: position.latitude,
    longitude: position.longitude,
    accuracyMeters: position.accuracyMeters,
    capturedAt: position.capturedAt.toISOString(),
    activeBookings: activeBookings.length,
  };
}

module.exports = {
  normalizeDriverPosition,
  updateDriverPosition,
};
