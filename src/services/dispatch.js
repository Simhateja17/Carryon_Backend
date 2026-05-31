// ── Dispatch Module ─────────────────────────────────────────
// Answers: which Drivers should see this Booking, in what
// order, and through which notification path?

const prisma = require('../lib/prisma');
const { haversineKm } = require('../lib/distance');
const { driverEarningFromGross } = require('../lib/money');
const { sendPushToDriverIds } = require('../lib/pushNotifications');
const { DRIVER_SEARCH_RADIUS_KM, OFFER_EXPIRY_MS } = require('./businessConfig');
const { evaluateDriverEligibility } = require('./driverEligibility');

const DRIVER_DISPATCH_SELECT = {
  id: true,
  name: true,
  email: true,
  isOnline: true,
  isVerified: true,
  verificationStatus: true,
  stripeConnectAccountId: true,
  stripeDetailsSubmitted: true,
  stripePayoutsEnabled: true,
  stripeRequirements: true,
  currentLatitude: true,
  currentLongitude: true,
  documents: { select: { type: true, status: true, expiryDate: true } },
  vehicle: { select: { type: true } },
};

// ── Incoming job queries for driver app ─────────────────────

function activeOfferWhereClause(extraWhere = {}) {
  return {
    status: 'SEARCHING_DRIVER',
    driverId: null,
    createdAt: { gte: new Date(Date.now() - OFFER_EXPIRY_MS) },
    ...extraWhere,
  };
}

function bookingPayout(booking) {
  return driverEarningFromGross(booking.finalPrice || booking.estimatedPrice || 0).driverAmount;
}

function sortByPayout(bookings) {
  return [...bookings].sort((a, b) => {
    const payoutDiff = bookingPayout(b) - bookingPayout(a);
    if (payoutDiff !== 0) return payoutDiff;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

function filterNearbyWithVehicleMatch(bookings, driverLat, driverLng, driverVehicleType) {
  return bookings.filter((booking) => {
    const withinRadius =
      haversineKm(
        driverLat,
        driverLng,
        booking.pickupAddress.latitude,
        booking.pickupAddress.longitude
      ) <= DRIVER_SEARCH_RADIUS_KM;
    const vehicleMatches = !driverVehicleType || booking.vehicleType === driverVehicleType;
    return withinRadius && vehicleMatches;
  });
}

function selectEligibleDriversForBooking(booking, drivers) {
  const pickupLat = booking.pickupAddress.latitude;
  const pickupLng = booking.pickupAddress.longitude;
  const bookingVehicleType = booking.vehicleType;

  return drivers.filter((driver) => {
    const withinRadius =
      haversineKm(pickupLat, pickupLng, driver.currentLatitude, driver.currentLongitude) <= DRIVER_SEARCH_RADIUS_KM;
    const vehicleMatches = !bookingVehicleType || !driver.vehicle?.type || driver.vehicle.type === bookingVehicleType;
    return driver.isOnline !== false && evaluateDriverEligibility(driver).canGoOnline && withinRadius && vehicleMatches;
  });
}

async function getIncomingBookingsForDriver(driver, bookingInclude) {
  // Fetch bookings this driver has already rejected
  const rejections = await prisma.bookingRejection.findMany({
    where: { driverId: driver.id },
    select: { bookingId: true },
  });
  const rejectedIds = rejections.map(r => r.bookingId);

  // First priority: explicit admin-targeted requests for this driver
  const targetedNotifications = await prisma.driverNotification.findMany({
    where: { driverId: driver.id, type: 'JOB_REQUEST' },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { actionData: true },
  });

  const targetedBookingIds = targetedNotifications
    .map((n) => {
      try {
        const payload = n.actionData ? JSON.parse(n.actionData) : null;
        if (!payload || payload.targeted !== true || !payload.bookingId) return null;
        return String(payload.bookingId);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const targetedBookings = targetedBookingIds.length > 0
    ? await prisma.booking.findMany({
      where: activeOfferWhereClause({
        id: {
          in: targetedBookingIds,
          ...(rejectedIds.length > 0 && { notIn: rejectedIds }),
        },
      }),
      include: bookingInclude,
      take: 50,
    })
    : [];

  const bookings = await prisma.booking.findMany({
    where: activeOfferWhereClause(
      rejectedIds.length > 0 ? { id: { notIn: rejectedIds } } : {}
    ),
    include: bookingInclude,
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  const nearby = filterNearbyWithVehicleMatch(
    bookings,
    driver.currentLatitude,
    driver.currentLongitude,
    driver.vehicle?.type
  );

  const dedupedById = new Map();
  [...targetedBookings, ...nearby].forEach((booking) => {
    if (!dedupedById.has(booking.id)) {
      dedupedById.set(booking.id, booking);
    }
  });

  return sortByPayout(Array.from(dedupedById.values()));
}

// ── Notify drivers after booking creation ───────────────────

async function notifyNearbyDrivers(booking) {
  const drivers = await prisma.driver.findMany({
    where: { isOnline: true },
    select: DRIVER_DISPATCH_SELECT,
  });

  const bookingVehicleType = booking.vehicleType;

  console.log('[dispatch] driver search — booking:', booking.id, '| vehicleType:', bookingVehicleType, '| online drivers:', drivers.length);

  const nearbyDrivers = selectEligibleDriversForBooking(booking, drivers);

  console.log('[dispatch] nearby drivers (within', DRIVER_SEARCH_RADIUS_KM, 'km):', nearbyDrivers.length,
    '| notifying:', nearbyDrivers.map(d => d.name));

  const nearbyDriverIds = nearbyDrivers.map(d => d.id);
  if (nearbyDriverIds.length === 0) {
    console.log('[dispatch] no nearby drivers found for booking:', booking.id);
    return;
  }

  const result = await sendPushToDriverIds(
    nearbyDriverIds,
    { title: 'New Ride Request!', body: 'A new delivery job is available near you.' },
    { type: 'JOB_REQUEST', bookingId: booking.id }
  );

  console.log(
    '[dispatch] FCM push sent for booking',
    booking.id,
    '— successCount:', result?.successCount,
    'failureCount:', result?.failureCount,
    'noDeviceDrivers:', result?.noDeviceActorIds?.length || 0
  );
}

// ── Admin dispatch: notify targeted or nearby drivers ───────

async function notifyDriversForAdminBooking(booking, driverIds) {
  const isDirectTargeted = driverIds.length > 0;
  const driverWhere = isDirectTargeted
    ? { id: { in: driverIds } }
    : { isOnline: true };

  const candidateDrivers = await prisma.driver.findMany({
    where: driverWhere,
    select: DRIVER_DISPATCH_SELECT,
  });

  const nearbyDrivers = isDirectTargeted
    ? candidateDrivers.filter((driver) => driver.isOnline !== false && evaluateDriverEligibility(driver).canGoOnline)
    : selectEligibleDriversForBooking(booking, candidateDrivers);

  const targetedDrivers = nearbyDrivers.map((d) => ({
    id: d.id,
    name: d.name,
    email: d.email,
  }));

  if (nearbyDrivers.length > 0) {
    await prisma.driverNotification.createMany({
      data: nearbyDrivers.map((driver) => ({
        driverId: driver.id,
        title: 'New Ride Request!',
        message: `${booking.pickupAddress.address} → ${booking.deliveryAddress.address} (${booking.estimatedPrice.toFixed(2)})`,
        type: 'JOB_REQUEST',
        actionData: JSON.stringify({
          bookingId: booking.id,
          source: 'admin',
          targeted: isDirectTargeted,
        }),
      })),
    });
  }

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

  if (nearbyDrivers.length > 0) {
    pushResult = await sendPushToDriverIds(
      nearbyDrivers.map((driver) => driver.id),
      {
        title: 'New Ride Request!',
        body: `${booking.pickupAddress.address} → ${booking.deliveryAddress.address}`,
      },
      {
        type: 'JOB_REQUEST',
        bookingId: booking.id,
        source: 'admin',
        targeted: isDirectTargeted ? 'true' : 'false',
      }
    );
  }

  return { targetedDrivers, nearbyDrivers, pushResult, isDirectTargeted };
}

module.exports = {
  DRIVER_DISPATCH_SELECT,
  getIncomingBookingsForDriver,
  notifyNearbyDrivers,
  notifyDriversForAdminBooking,
  filterNearbyWithVehicleMatch,
  selectEligibleDriversForBooking,
  sortByPayout,
  OFFER_EXPIRY_MS,
};
